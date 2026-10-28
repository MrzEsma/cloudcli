import express, { type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fetch, ProxyAgent, type Dispatcher } from 'undici';

interface SonioxConfig {
  apiKey: string;
  apiBaseUrl: string;
  managed: boolean;
  model: string;
  languageHints: string[];
  httpsProxy: string;
  transcribeTimeoutMs: number;
  pollIntervalMs: number;
}

interface SonioxError extends Error {
  status?: number;
  details?: unknown;
}

interface UsageLogEntry {
  model?: string;
  cost_usd?: string | number;
  input_audio_duration_ms?: number;
  output_audio_duration_ms?: number;
  input_audio_tokens?: number;
  output_audio_tokens?: number;
  input_text_tokens?: number;
  output_text_tokens?: number;
  request_scope?: string;
}

interface TemporaryApiKeyResponse {
  api_key?: string;
  expires_at?: string;
}

const HOST = '127.0.0.1';
const PORT = Number(process.env.SONIOX_PORT || 3002);
const DEFAULT_API_BASE_URL = 'https://api.soniox.com/v1';
const DEFAULT_MODEL = 'stt-async-v5';
const REALTIME_MODEL = 'stt-rt-v5';
const TEMPORARY_KEY_LIFETIME_SECONDS = 60;
const MAX_REALTIME_SESSION_SECONDS = 30 * 60;
const SUPPORTED_MODELS = new Set(['stt-async-v5', 'stt-async-v4', 'stt-async-v3']);
const CONFIG_DIR = path.join(os.homedir(), '.claude-code-ui');
const CONFIG_PATH = path.join(CONFIG_DIR, 'soniox-config.json');
const DEFAULTS: SonioxConfig = {
  apiKey: '',
  apiBaseUrl: DEFAULT_API_BASE_URL,
  managed: false,
  model: DEFAULT_MODEL,
  languageHints: ['fa'],
  httpsProxy: '',
  transcribeTimeoutMs: 120_000,
  pollIntervalMs: 750,
};

function normalizeModel(model?: string): string {
  const cleaned = typeof model === 'string' ? model.trim() : '';
  if (SUPPORTED_MODELS.has(cleaned)) return cleaned;
  if (cleaned === 'stt-async-preview') return DEFAULT_MODEL;
  return DEFAULT_MODEL;
}

function safeFilename(name: string): string {
  return name.replace(/["\r\n]/g, '_');
}

function buildMultipartFileBody(buffer: Buffer, mimetype: string, filename: string): { body: Buffer; contentType: string } {
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

const proxyAgents = new Map<string, ProxyAgent>();

function readConfig(): SonioxConfig {
  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) as Partial<SonioxConfig>;
    return {
      ...DEFAULTS,
      ...parsed,
      model: normalizeModel(parsed.model),
      languageHints: Array.isArray(parsed.languageHints) ? parsed.languageHints.map(String) : DEFAULTS.languageHints,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

function writeConfig(config: SonioxConfig): void {
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(CONFIG_PATH, 0o600);
}

function effectiveConfig(req?: Request): SonioxConfig {
  const config = readConfig();
  const apiKey = req?.headers['x-plugin-secret-soniox-api-key'];
  const httpsProxy = req?.headers['x-plugin-secret-https-proxy'];
  if (!config.managed && typeof apiKey === 'string' && apiKey) config.apiKey = apiKey;
  if (!config.managed && typeof httpsProxy === 'string' && httpsProxy) config.httpsProxy = httpsProxy;
  return config;
}

function getDispatcher(proxyUrl: string): Dispatcher | undefined {
  if (!proxyUrl) return undefined;
  let agent = proxyAgents.get(proxyUrl);
  if (!agent) {
    agent = new ProxyAgent(proxyUrl);
    proxyAgents.set(proxyUrl, agent);
  }
  return agent;
}

function sonioxErrorMessage(data: any, fallback: string): string {
  const base = data.error_message || data.message || data.error?.message || data.error || fallback;
  if (Array.isArray(data.validation_errors) && data.validation_errors.length > 0) {
    const details = data.validation_errors
      .map((item: any) => {
        const location = item.location ? `${item.location}: ` : '';
        return `${location}${item.message || item.error_type || 'invalid value'}`;
      })
      .join('; ');
    return `${base} (${details})`;
  }
  return String(base);
}

async function soniox<T>(requestPath: string, options: Record<string, any>, config: SonioxConfig): Promise<T> {
  const apiBaseUrl = (config.apiBaseUrl || DEFAULT_API_BASE_URL).replace(/\/$/, '');
  const response = await fetch(`${apiBaseUrl}${requestPath}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      ...(options?.headers || {}),
    },
    dispatcher: getDispatcher(config.httpsProxy),
  });
  const raw = await response.text();
  let data: any;
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    data = { message: raw };
  }
  if (!response.ok) {
    const error = new Error(sonioxErrorMessage(data, `Soniox request failed (${response.status})`)) as SonioxError;
    error.status = response.status;
    error.details = data;
    throw error;
  }
  return data as T;
}

async function deleteResource(requestPath: string, config: SonioxConfig): Promise<void> {
  try {
    await soniox(requestPath, { method: 'DELETE' }, config);
  } catch (error) {
    console.warn(`[soniox] cleanup failed for ${requestPath}: ${(error as Error).message}`);
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function monthStartUtc(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

async function fetchUsageLogs(config: SonioxConfig): Promise<UsageLogEntry[]> {
  const logs: UsageLogEntry[] = [];
  let cursor: string | undefined;
  const startTime = monthStartUtc();
  const endTime = new Date().toISOString();
  do {
    const params = new URLSearchParams({
      start_time: startTime,
      end_time: endTime,
      limit: '1000',
      sort: 'end_time_asc',
    });
    if (cursor) params.set('cursor', cursor);
    const response = await soniox<{ usage_logs?: UsageLogEntry[]; next_page_cursor?: string }>(`/usage-logs?${params.toString()}`, {}, config);
    logs.push(...(response.usage_logs || []));
    cursor = response.next_page_cursor || undefined;
  } while (cursor);
  return logs;
}

async function transcribeBuffer(
  buffer: Buffer,
  mimetype: string,
  originalname: string,
  config: SonioxConfig,
): Promise<string> {
  if (!config.apiKey) throw new Error('Soniox API key is not configured. Open the Soniox Voice plugin tab.');

  let fileId: string | undefined;
  let transcriptionId: string | undefined;
  try {
    const multipart = buildMultipartFileBody(buffer, mimetype, originalname || 'recording.webm');
    const uploaded = await soniox<{ id?: string }>(
      '/files',
      { method: 'POST', headers: { 'Content-Type': multipart.contentType }, body: multipart.body as unknown as BodyInit },
      config,
    );
    fileId = uploaded.id;
    if (!fileId) throw new Error('Soniox did not return a file id.');

    const created = await soniox<{ id?: string }>('/transcriptions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: normalizeModel(config.model),
        file_id: fileId,
        ...(config.languageHints.length > 0 ? { language_hints: config.languageHints } : {}),
      }),
    }, config);
    transcriptionId = created.id;
    if (!transcriptionId) throw new Error('Soniox did not return a transcription id.');

    const deadline = Date.now() + config.transcribeTimeoutMs;
    while (Date.now() < deadline) {
      const status = await soniox<{ status?: string; error_message?: string; message?: string }>(
        `/transcriptions/${transcriptionId}`,
        {},
        config,
      );
      if (status.status === 'completed') {
        const transcript = await soniox<{ text?: string }>(
          `/transcriptions/${transcriptionId}/transcript`,
          {},
          config,
        );
        return transcript.text || '';
      }
      if (status.status === 'error' || status.status === 'failed') {
        throw new Error(status.error_message || status.message || 'Soniox transcription failed.');
      }
      await sleep(config.pollIntervalMs);
    }
    throw new Error(`Soniox transcription timed out after ${Math.round(config.transcribeTimeoutMs / 1000)} seconds.`);
  } finally {
    if (transcriptionId) await deleteResource(`/transcriptions/${transcriptionId}`, config);
    if (fileId) await deleteResource(`/files/${fileId}`, config);
  }
}

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

app.use((req, res, next) => {
  if (req.path === '/v1/audio/transcriptions') return next();
  return express.json({ limit: '50mb' })(req, res, next);
});

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', provider: 'soniox', port: PORT });
});

app.get('/status', (req, res) => {
  const config = effectiveConfig(req);
  res.json({
    configured: Boolean(config.apiKey),
    model: normalizeModel(config.model),
    languageHints: config.languageHints,
    proxyConfigured: Boolean(config.httpsProxy),
  });
});

app.get('/config', (_req, res) => {
  const config = readConfig();
  res.json({
    apiKeySet: Boolean(config.apiKey),
    apiKeyPreview: !config.managed && config.apiKey ? `${config.apiKey.slice(0, 4)}…${config.apiKey.slice(-3)}` : '',
    managed: config.managed,
    model: normalizeModel(config.model),
    languageHints: config.languageHints,
    httpsProxy: config.httpsProxy,
    transcribeTimeoutMs: config.transcribeTimeoutMs,
  });
});

app.post('/config', (req, res) => {
  const body = (req.body || {}) as Record<string, unknown>;
  const config = readConfig();
  if (!config.managed && typeof body.apiKey === 'string' && body.apiKey.trim()) config.apiKey = body.apiKey.trim();
  if (!config.managed && body.clearApiKey === true) config.apiKey = '';
  if (typeof body.model === 'string') config.model = normalizeModel(body.model);
  if (Array.isArray(body.languageHints)) config.languageHints = body.languageHints.map(String).filter(Boolean);
  if (!config.managed && typeof body.httpsProxy === 'string') config.httpsProxy = body.httpsProxy.trim();
  if (typeof body.transcribeTimeoutMs === 'number' && body.transcribeTimeoutMs > 0) {
    config.transcribeTimeoutMs = body.transcribeTimeoutMs;
  }
  writeConfig(config);
  res.json({ ok: true, apiKeySet: Boolean(config.apiKey), model: normalizeModel(config.model), languageHints: config.languageHints });
});

app.post('/validate', async (req, res) => {
  try {
    const config = effectiveConfig(req);
    if (!config.apiKey) return res.status(400).json({ error: 'Soniox API key is not configured.' });
    const result = await soniox<{ models?: Array<{ id?: string; languages?: Array<{ code?: string }> }> }>(
      '/models',
      {},
      config,
    );
    const models = (result.models || []).map((model) => model.id).filter(Boolean);
    const supportsPersian = (result.models || []).some((model) => model.languages?.some((language) => language.code === 'fa'));
    res.json({ ok: true, models, supportsPersian });
  } catch (error) {
    const sonioxError = error as SonioxError;
    res.status(sonioxError.status === 401 || sonioxError.status === 403 ? 401 : 502).json({ error: sonioxError.message });
  }
});

app.post('/realtime-key', async (req, res) => {
  try {
    const config = effectiveConfig(req);
    if (!config.apiKey) return res.status(400).json({ error: 'Soniox API key is not configured.' });

    const temporaryKey = await soniox<TemporaryApiKeyResponse>('/auth/temporary-api-key', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        usage_type: 'transcribe_websocket',
        expires_in_seconds: TEMPORARY_KEY_LIFETIME_SECONDS,
        single_use: true,
        max_session_duration_seconds: MAX_REALTIME_SESSION_SECONDS,
      }),
    }, config);

    if (!temporaryKey.api_key) throw new Error('Soniox did not return a temporary API key.');
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      apiKey: temporaryKey.api_key,
      expiresAt: temporaryKey.expires_at,
      model: REALTIME_MODEL,
      languageHints: config.languageHints,
    });
  } catch (error) {
    const sonioxError = error as SonioxError;
    console.error(`[soniox] /realtime-key failed: ${sonioxError.message}`);
    res.status(sonioxError.status === 401 || sonioxError.status === 403 ? 401 : 502).json({ error: sonioxError.message });
  }
});

app.get('/usage', async (req, res) => {
  try {
    const config = effectiveConfig(req);
    if (config.managed) {
      return res.status(403).json({ error: 'Usage is managed by the CloudCLI service.' });
    }
    if (!config.apiKey) return res.status(400).json({ error: 'Soniox API key is not configured.' });
    const logs = await fetchUsageLogs(config);
    const byModel: Record<string, { requests: number; costUsd: number; audioSeconds: number }> = {};
    let totalCostUsd = 0;
    let totalAudioSeconds = 0;
    for (const entry of logs) {
      const model = entry.model || 'unknown';
      const costUsd = Number(entry.cost_usd || 0) || 0;
      const audioMs = Number(entry.input_audio_duration_ms || 0) + Number(entry.output_audio_duration_ms || 0);
      totalCostUsd += costUsd;
      totalAudioSeconds += audioMs / 1000;
      byModel[model] ??= { requests: 0, costUsd: 0, audioSeconds: 0 };
      byModel[model].requests += 1;
      byModel[model].costUsd += costUsd;
      byModel[model].audioSeconds += audioMs / 1000;
    }
    res.json({
      window: { startTime: monthStartUtc(), endTime: new Date().toISOString() },
      requests: logs.length,
      totalCostUsd,
      totalAudioSeconds,
      byModel,
      budgetRemainingUsd: null,
      budgetNote: 'Soniox API exposes usage logs, but not remaining budget for an API key. Check Soniox Console billing/budgets for your cap.',
    });
  } catch (error) {
    const sonioxError = error as SonioxError;
    res.status(sonioxError.status === 401 || sonioxError.status === 403 ? 401 : 502).json({ error: sonioxError.message });
  }
});

app.post('/transcribe', async (req, res) => {
  try {
    const { audio, mime, filename } = (req.body || {}) as { audio?: string; mime?: string; filename?: string };
    if (!audio) return res.status(400).json({ error: 'No audio data provided.' });
    const text = await transcribeBuffer(
      Buffer.from(audio, 'base64'),
      mime || 'audio/webm',
      filename || 'recording.webm',
      effectiveConfig(req),
    );
    res.json({ text });
  } catch (error) {
    console.error(`[soniox] /transcribe failed: ${(error as Error).message}`);
    res.status(500).json({ error: (error as Error).message });
  }
});

app.post('/v1/audio/transcriptions', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: { message: 'No audio file uploaded.' } });
    const text = await transcribeBuffer(
      req.file.buffer,
      req.file.mimetype,
      req.file.originalname,
      effectiveConfig(req),
    );
    res.json({ text });
  } catch (error) {
    console.error(`[soniox] /v1/audio/transcriptions failed: ${(error as Error).message}`);
    res.status(500).json({ error: { message: (error as Error).message } });
  }
});

app.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
  if (error instanceof multer.MulterError) return res.status(400).json({ error: { message: error.message } });
  return next(error);
});

const server = app.listen(PORT, HOST, () => {
  console.log(JSON.stringify({ ready: true, port: PORT }));
});

async function shutdown(): Promise<void> {
  server.close(async () => {
    await Promise.all([...proxyAgents.values()].map((agent) => agent.close()));
    process.exit(0);
  });
}

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
