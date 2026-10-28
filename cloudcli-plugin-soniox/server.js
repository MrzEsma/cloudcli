// CloudCLI plugin backend for Soniox speech-to-text.
//
// Lifecycle contract (see CloudCLI plugin-process-manager):
//   - Spawned by CloudCLI with a minimal env (PATH, HOME, NODE_ENV, PLUGIN_NAME).
//   - Must print one JSON line { ready: true, port: <number> } to stdout ASAP.
//   - RPC calls from the frontend are proxied by CloudCLI to this server:
//       ALL /api/plugins/<name>/rpc/<path>  ->  http://127.0.0.1:<port>/<path>
//     JSON request bodies are forwarded; configured secrets arrive as
//     x-plugin-secret-<key> headers.
//
// This server additionally exposes an OpenAI-compatible endpoint so the
// built-in CloudCLI microphone button (server voice proxy) can transcribe
// through Soniox when VOICE_API_BASE_URL=http://127.0.0.1:<port>/v1.
//
// Secrets are kept on disk (chmod 600) at ~/.claude-code-ui/soniox-config.json
// because the OpenAI-compatible path is called directly by CloudCLI's voice
// proxy and therefore cannot receive the x-plugin-secret-* headers that only
// the /rpc/* proxy injects.

import express from 'express';
import multer from 'multer';
import { ProxyAgent } from 'undici';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const PORT = Number(process.env.SONIOX_PORT || 3002);
const HOST = '127.0.0.1';
const CONFIG_DIR = path.join(os.homedir(), '.claude-code-ui');
const CONFIG_PATH = path.join(CONFIG_DIR, 'soniox-config.json');
const SONIOX_API_BASE_URL = (process.env.SONIOX_API_BASE_URL || 'https://api.soniox.com/v1').replace(/\/$/, '');
const DEFAULT_MODEL = 'stt-async-v5';
const SUPPORTED_MODELS = new Set(['stt-async-v5', 'stt-async-v4', 'stt-async-v3']);

const DEFAULTS = {
  apiKey: '',
  model: DEFAULT_MODEL,
  languageHints: ['fa'],
  httpsProxy: '',
  transcribeTimeoutMs: 120000,
  pollIntervalMs: 750,
};

function normalizeModel(model) {
  const cleaned = typeof model === 'string' ? model.trim() : '';
  if (SUPPORTED_MODELS.has(cleaned)) return cleaned;
  if (cleaned === 'stt-async-preview') return DEFAULT_MODEL;
  return DEFAULT_MODEL;
}

function safeFilename(name) {
  return String(name || 'recording.webm').replace(/["\r\n]/g, '_');
}

function buildMultipartFileBody(buffer, mimetype, filename) {
  const boundary = `----soniox-${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`;
  const header = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${safeFilename(filename)}"\r\n` +
      `Content-Type: ${mimetype || 'application/octet-stream'}\r\n\r\n`,
    'utf8',
  );
  const footer = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
  return { body: Buffer.concat([header, buffer, footer]), contentType: `multipart/form-data; boundary=${boundary}` };
}

function readConfig() {
  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    return {
      ...DEFAULTS,
      ...parsed,
      model: normalizeModel(parsed.model),
      languageHints: Array.isArray(parsed.languageHints) ? parsed.languageHints : DEFAULTS.languageHints,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

function writeConfig(cfg) {
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

function dispatcherFor(httpsProxy) {
  if (!httpsProxy) return undefined;
  try {
    return new ProxyAgent(httpsProxy);
  } catch {
    return undefined;
  }
}

function effectiveConfig(req) {
  const cfg = readConfig();
  if (req?.headers) {
    const key = req.headers['x-plugin-secret-soniox-api-key'];
    const proxy = req.headers['x-plugin-secret-https-proxy'];
    if (key) cfg.apiKey = key;
    if (proxy) cfg.httpsProxy = proxy;
  }
  return cfg;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function sonioxErrorMessage(data, fallback) {
  const base = data.message || data.error?.message || data.error || fallback;
  if (Array.isArray(data.validation_errors) && data.validation_errors.length > 0) {
    const details = data.validation_errors
      .map((item) => {
        const location = item.location ? `${item.location}: ` : '';
        return `${location}${item.message || item.error_type || 'invalid value'}`;
      })
      .join('; ');
    return `${base} (${details})`;
  }
  return String(base);
}

async function soniox(requestPath, options, cfg) {
  const dispatcher = dispatcherFor(cfg.httpsProxy);
  const response = await fetch(`${SONIOX_API_BASE_URL}${requestPath}`, {
    ...options,
    headers: { Authorization: `Bearer ${cfg.apiKey}`, ...(options.headers || {}) },
    ...(dispatcher ? { dispatcher } : {}),
  });
  const raw = await response.text();
  let data;
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    data = { message: raw };
  }
  if (!response.ok) {
    const message = sonioxErrorMessage(data, `Soniox request failed (${response.status})`);
    const error = new Error(String(message));
    error.status = response.status;
    error.details = data;
    throw error;
  }
  return data;
}

async function deleteResource(requestPath, cfg) {
  try {
    await soniox(requestPath, { method: 'DELETE' }, cfg);
  } catch (error) {
    console.warn(`[soniox] cleanup failed for ${requestPath}: ${error.message}`);
  }
}

async function transcribeBuffer(buffer, mimetype, originalname, cfg) {
  if (!cfg.apiKey) throw new Error('Soniox API key is not configured.');
  let fileId;
  let transcriptionId;
  try {
    const multipart = buildMultipartFileBody(buffer, mimetype, originalname || 'recording.webm');
    const uploaded = await soniox('/files', { method: 'POST', headers: { 'Content-Type': multipart.contentType }, body: multipart.body }, cfg);
    fileId = uploaded.id;
    if (!fileId) throw new Error('Soniox did not return a file id.');

    const created = await soniox('/transcriptions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: normalizeModel(cfg.model || DEFAULTS.model),
        file_id: fileId,
        ...(cfg.languageHints && cfg.languageHints.length > 0 ? { language_hints: cfg.languageHints } : {}),
      }),
    }, cfg);
    transcriptionId = created.id;
    if (!transcriptionId) throw new Error('Soniox did not return a transcription id.');

    const deadline = Date.now() + (cfg.transcribeTimeoutMs || DEFAULTS.transcribeTimeoutMs);
    while (Date.now() < deadline) {
      const status = await soniox(`/transcriptions/${transcriptionId}`, {}, cfg);
      if (status.status === 'completed') {
        const transcript = await soniox(`/transcriptions/${transcriptionId}/transcript`, {}, cfg);
        return typeof transcript.text === 'string' ? transcript.text : '';
      }
      if (status.status === 'error' || status.status === 'failed') {
        throw new Error(status.error_message || status.message || 'Soniox transcription failed.');
      }
      await sleep(cfg.pollIntervalMs || DEFAULTS.pollIntervalMs);
    }
    throw new Error(`Soniox transcription timed out after ${Math.round((cfg.transcribeTimeoutMs || DEFAULTS.transcribeTimeoutMs) / 1000)} seconds.`);
  } finally {
    if (transcriptionId) await deleteResource(`/transcriptions/${transcriptionId}`, cfg);
    if (fileId) await deleteResource(`/files/${fileId}`, cfg);
  }
}

const app = express();

// CloudCLI's RPC proxy re-stringifies JSON bodies and sets content-type itself.
// The OpenAI-compatible path is called directly with multipart, so handle that
// route with multer and JSON-parse everything else.
app.use((req, res, next) => {
  if (req.path === '/v1/audio/transcriptions') return next();
  return express.json({ limit: '50mb' })(req, res, next);
});

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

app.get('/health', (req, res) => {
  res.json({ status: 'ok', provider: 'soniox', port: PORT });
});

app.get('/status', (req, res) => {
  const cfg = effectiveConfig(req);
  res.json({
    configured: Boolean(cfg.apiKey),
    model: normalizeModel(cfg.model),
    languageHints: cfg.languageHints,
    proxyConfigured: Boolean(cfg.httpsProxy),
  });
});

app.get('/config', (req, res) => {
  const cfg = readConfig();
  res.json({
    apiKeySet: Boolean(cfg.apiKey),
    apiKeyPreview: cfg.apiKey ? `${cfg.apiKey.slice(0, 4)}…${cfg.apiKey.slice(-3)}` : '',
    model: normalizeModel(cfg.model),
    languageHints: cfg.languageHints,
    httpsProxy: cfg.httpsProxy,
    transcribeTimeoutMs: cfg.transcribeTimeoutMs,
  });
});

app.post('/config', (req, res) => {
  const body = req.body || {};
  const cfg = readConfig();
  if (typeof body.apiKey === 'string') cfg.apiKey = body.apiKey.trim();
  if (typeof body.model === 'string') cfg.model = normalizeModel(body.model);
  if (Array.isArray(body.languageHints)) cfg.languageHints = body.languageHints.map(String).filter(Boolean);
  if (typeof body.httpsProxy === 'string') cfg.httpsProxy = body.httpsProxy.trim();
  if (body.transcribeTimeoutMs) cfg.transcribeTimeoutMs = Number(body.transcribeTimeoutMs) || DEFAULTS.transcribeTimeoutMs;
  writeConfig(cfg);
  res.json({ ok: true, apiKeySet: Boolean(cfg.apiKey), model: normalizeModel(cfg.model), languageHints: cfg.languageHints });
});

app.post('/transcribe', async (req, res) => {
  try {
    const cfg = effectiveConfig(req);
    const { audio, mime, filename } = req.body || {};
    if (!audio) return res.status(400).json({ error: { message: 'No audio data provided.' } });
    const buffer = Buffer.from(audio, 'base64');
    const text = await transcribeBuffer(buffer, mime || 'audio/webm', filename || 'recording.webm', cfg);
    res.json({ text });
  } catch (error) {
    console.error(`[soniox] /transcribe failed: ${error.message}`);
    res.status(error.status === 401 || error.status === 403 ? 502 : 500).json({ error: { message: error.message } });
  }
});

app.post('/v1/audio/transcriptions', upload.single('file'), async (req, res) => {
  try {
    const cfg = effectiveConfig(req);
    if (!req.file) return res.status(400).json({ error: { message: 'No audio file uploaded.' } });
    const text = await transcribeBuffer(req.file.buffer, req.file.mimetype, req.file.originalname, cfg);
    res.json({ text });
  } catch (error) {
    console.error(`[soniox] /v1/audio/transcriptions failed: ${error.message}`);
    res.status(error.status === 401 || error.status === 403 ? 502 : 500).json({ error: { message: error.message } });
  }
});

const server = app.listen(PORT, HOST, () => {
  // Required ready handshake for CloudCLI's plugin process manager.
  console.log(JSON.stringify({ ready: true, port: PORT }));
});

function shutdown() {
  server.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
