import { execFile, spawn as spawnChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import express, { type Express, type NextFunction, type Request, type Response } from 'express';

const HOST = '127.0.0.1';
const PORT = 3012;
const DEFAULT_MODELS: Record<CodexProvider, string> = {
  openai: 'gpt-5.6-sol',
  hooshcode: 'gpt-5.6-sol',
};
const SUPPORTED_PROVIDERS = new Set(['openai', 'hooshcode', 'hooshcode_claude']);
const execFileAsync = promisify(execFile);
const OPENAI_MODELS_URL = 'https://api.openai.com/v1/models';
const HOOSH_CODE_BASE_URL = (process.env.CODEX_PROXY_BASE_URL || 'https://claude.flearning.ir/backend-api/codex').replace(/\/$/, '');
const HOOSH_CODE_MODELS_URL = `${HOOSH_CODE_BASE_URL}/models`;
const CLAUDE_PROXY_BASE_URL = (process.env.CLAUDE_PROXY_BASE_URL || 'https://claude.flearning.ir').replace(/\/$/, '');
const CLAUDE_MODELS_URL = `${CLAUDE_PROXY_BASE_URL}/v1/models`;
const PROVIDER_VALIDATION_TIMEOUT_MS = 10_000;
const CONNECTOR_BLOCK_START = '# >>> beteam-managed-connectors >>>';
const CONNECTOR_BLOCK_END = '# <<< beteam-managed-connectors <<<';
const PROXIES_BLOCK_START = '# >>> cloudcli-model-proxies >>>';
const PROXIES_BLOCK_END = '# <<< cloudcli-model-proxies <<<';
const MAX_MODEL_PROXIES = 8;

type ModelProxy = {
  id: string;
  name: string;
  claudeBaseUrl: string;
  codexBaseUrl: string;
  token: string;
  createdAt: string;
  updatedAt: string;
};

type ModelProxyPublic = Omit<ModelProxy, 'token'> & { hasToken: boolean };

function readModelProxies(registryPath: string): ModelProxy[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    return Array.isArray(parsed?.proxies)
      ? parsed.proxies.filter((entry: unknown): entry is ModelProxy =>
        !!entry && typeof entry === 'object' && typeof (entry as ModelProxy).id === 'string')
      : [];
  } catch {
    return [];
  }
}

function writeModelProxies(registryPath: string, proxies: ModelProxy[]): void {
  writePrivateFile(registryPath, `${JSON.stringify({ version: 1, proxies }, null, 2)}\n`);
}

function publicModelProxy(entry: ModelProxy): ModelProxyPublic {
  const { token, ...rest } = entry;
  return { ...rest, hasToken: typeof token === 'string' && token.trim() !== '' };
}

function slugifyProxyId(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[\s/]+/g, '-')
    .replace(/[^a-z0-9_-]/g, '')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
  if (!slug) throw new SetupError('نام پروکسی معتبر نیست؛ حروف/عدد لازم است.');
  if (/^\d/.test(slug)) return `p-${slug}`;
  return slug;
}

function uniqueProxyId(name: string, existing: ModelProxy[]): string {
  const base = slugifyProxyId(name);
  let candidate = base;
  let counter = 2;
  while (existing.some((entry) => entry.id === candidate)) {
    candidate = `${base}-${counter}`;
    counter += 1;
  }
  return candidate;
}

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : 'خطای غیرمنتظره در ارتباط با پروکسی.';
}

function normalizeProxyUrl(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') return '';
  const normalized = value.trim().replace(/\/+$/, '');
  if (!/^https:\/\/\S+$/.test(normalized)) {
    throw new SetupError(`${label} باید یک HTTPS URL بدون فاصله باشد.`);
  }
  return normalized;
}

function validateProxyTokenForClaude(apiKey: string, baseUrl: string): Promise<void> {
  return validateBearerToken(apiKey, `${baseUrl}/v1/models`, baseUrl, {
    'anthropic-version': '2023-06-01',
  });
}

function validateProxyTokenForCodex(apiKey: string, baseUrl: string): Promise<void> {
  return validateBearerToken(apiKey, `${baseUrl}/models`, baseUrl);
}

export function readProxyBlock(configPath: string): string {
  try {
    const current = fs.readFileSync(configPath, 'utf8');
    const start = current.indexOf(PROXIES_BLOCK_START);
    const end = current.indexOf(PROXIES_BLOCK_END, start);
    if (start < 0 || end < 0) return '';
    return current.slice(start, end + PROXIES_BLOCK_END.length);
  } catch {
    return '';
  }
}

export function buildProxyBlock(proxies: ModelProxy[]): string {
  const codexProxies = proxies.filter((entry) => entry.codexBaseUrl);
  if (codexProxies.length === 0) return '';
  const blocks = codexProxies.map((entry) => [
    `[model_providers.cpx_${entry.id}]`,
    `name = ${tomlString(`${entry.name} (CloudCLI proxy)`)}`,
    `base_url = ${tomlString(entry.codexBaseUrl)}`,
    `experimental_bearer_token = ${tomlString(entry.token)}`,
    'wire_api = "responses"',
    '',
  ].join('\n'));
  return [PROXIES_BLOCK_START, ...blocks, PROXIES_BLOCK_END].join('\n');
}

// Keeps the managed `[model_providers.cpx_*]` blocks in ~/.codex/config.toml in
// sync with the registry while leaving every other line of the config intact.
export function syncProxyBlock(paths: SetupPaths, proxies: ModelProxy[]): void {
  const desired = buildProxyBlock(proxies);
  let current = '';
  try {
    current = fs.readFileSync(paths.configPath, 'utf8');
  } catch {
    current = '';
  }
  const start = current.indexOf(PROXIES_BLOCK_START);
  const end = current.indexOf(PROXIES_BLOCK_END, start);
  let updated: string;
  if (start >= 0 && end >= 0) {
    updated = current.slice(0, start) + desired + current.slice(end + PROXIES_BLOCK_END.length);
  } else if (desired) {
    updated = current.trimEnd() + (current.trim() ? '\n\n' : '') + desired + '\n';
  } else {
    return;
  }
  writePrivateFile(paths.configPath, updated);
}

type CodexProvider = 'openai' | 'hooshcode';
type Provider = CodexProvider | 'hooshcode_claude';

class SetupError extends Error {
  constructor(message: string, readonly statusCode = 400) {
    super(message);
  }
}

export type SetupPaths = {
  codexDir: string;
  authPath: string;
  configPath: string;
  markerPath: string;
};

export type ClaudeSetupPaths = {
  claudeDir: string;
  settingsPath: string;
  markerPath: string;
  managedTeamMarkerPath: string;
};

export type SetupDependencies = {
  homeDir?: string;
  validateOpenAiApiKey?: (apiKey: string) => Promise<void>;
  validateHooshCodeApiKey?: (apiKey: string) => Promise<void>;
  validateClaudeProxyApiKey?: (apiKey: string) => Promise<void>;
  validateProxyClaudeToken?: (apiKey: string, baseUrl: string) => Promise<void>;
  validateProxyCodexToken?: (apiKey: string, baseUrl: string) => Promise<void>;
  /** @deprecated Compatibility hook for the original direct-OpenAI tests. */
  validateApiKey?: (apiKey: string) => Promise<void>;
  persistApiKey?: (apiKey: string, paths: SetupPaths) => Promise<void> | void;
  removeApiKey?: (paths: SetupPaths) => Promise<void> | void;
};

function setupPaths(homeDir: string): SetupPaths {
  const codexDir = path.join(homeDir, '.codex');
  return {
    codexDir,
    authPath: path.join(codexDir, 'auth.json'),
    configPath: path.join(codexDir, 'config.toml'),
    markerPath: path.join(codexDir, '.cloudcli-user-managed-auth'),
  };
}

function claudeSetupPaths(homeDir: string): ClaudeSetupPaths {
  const claudeDir = path.join(homeDir, '.claude');
  return {
    claudeDir,
    settingsPath: path.join(claudeDir, 'settings.json'),
    markerPath: path.join(claudeDir, '.cloudcli-claude-user-managed-auth'),
    managedTeamMarkerPath: process.env.ICLAUDE_ATTESTATION_PATH
      || path.join(homeDir, '.cloudcli', 'iclaude-managed.json'),
  };
}

function readJson(pathname: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(fs.readFileSync(pathname, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

const MODEL_SLUG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;

function readModel(configPath: string, provider: CodexProvider = 'openai'): string {
  try {
    const match = fs.readFileSync(configPath, 'utf8').match(/^model\s*=\s*"([^"]+)"/m);
    const model = match?.[1] || '';
    return MODEL_SLUG_PATTERN.test(model) ? model : DEFAULT_MODELS[provider];
  } catch {
    return DEFAULT_MODELS[provider];
  }
}

function readStoredApiKey(authPath: string): string {
  const auth = readJson(authPath);
  return typeof auth.OPENAI_API_KEY === 'string' ? auth.OPENAI_API_KEY.trim() : '';
}

function authMethod(authPath: string): 'api_key' | 'chatgpt' | 'none' {
  const auth = readJson(authPath);
  if (typeof auth.OPENAI_API_KEY === 'string' && auth.OPENAI_API_KEY.trim()) return 'api_key';
  const tokens = auth.tokens;
  if (tokens && typeof tokens === 'object') {
    const record = tokens as Record<string, unknown>;
    if (typeof record.access_token === 'string' || typeof record.id_token === 'string') return 'chatgpt';
  }
  return 'none';
}

function normalizeProvider(value: unknown): Provider {
  if (value === 'proxy') return 'hooshcode';
  return typeof value === 'string' && SUPPORTED_PROVIDERS.has(value)
    ? value as Provider
    : 'openai';
}

function readProvider(paths: SetupPaths): Provider {
  const markerProvider = readJson(paths.markerPath).provider;
  if (typeof markerProvider === 'string') return normalizeProvider(markerProvider);
  try {
    const raw = fs.readFileSync(paths.configPath, 'utf8');
    const match = raw.match(/^model_provider\s*=\s*["']?([^"'\s#]+)["']?/m);
    return normalizeProvider(match?.[1]);
  } catch {
    return 'openai';
  }
}

function tomlString(value: unknown): string {
  return JSON.stringify(String(value ?? ''));
}

function writePrivateFile(pathname: string, content: string): void {
  fs.mkdirSync(path.dirname(pathname), { recursive: true, mode: 0o700 });
  const tempPath = path.join(path.dirname(pathname), `.${path.basename(pathname)}-${process.pid}-${Date.now()}.tmp`);
  fs.writeFileSync(tempPath, content, { mode: 0o600 });
  fs.renameSync(tempPath, pathname);
  fs.chmodSync(pathname, 0o600);
}

function writeApiKey(apiKey: string, paths: SetupPaths): void {
  // This is the file-store schema emitted by `codex login --with-api-key`.
  // Writing it directly avoids a heavyweight CLI subprocess in the request
  // path while preserving Codex's supported on-disk credential format.
  writePrivateFile(paths.authPath, `${JSON.stringify({
    auth_mode: 'apikey',
    OPENAI_API_KEY: apiKey,
  }, null, 2)}\n`);
}

function commonConfig(model: string): string[] {
  return [
    `model = ${tomlString(model)}`,
    'approval_policy = "never"',
    'sandbox_mode = "workspace-write"',
    'cli_auth_credentials_store = "file"',
  ];
}

function readManagedConnectorBlock(configPath: string): string {
  try {
    const current = fs.readFileSync(configPath, 'utf8');
    const start = current.indexOf(CONNECTOR_BLOCK_START);
    const end = current.indexOf(CONNECTOR_BLOCK_END, start);
    if (start < 0 || end < 0) return '';
    return current.slice(start, end + CONNECTOR_BLOCK_END.length);
  } catch {
    return '';
  }
}

function writeProviderConfig(paths: SetupPaths, model: string, provider: CodexProvider, apiKey = ''): void {
  const connectorBlock = readManagedConnectorBlock(paths.configPath);
  const proxyBlock = readProxyBlock(paths.configPath);
  const lines = [
    ...commonConfig(model),
    `model_provider = ${tomlString(provider)}`,
    '',
    '[features]',
    'api_key_model_discovery = true',
    '',
  ];
  if (provider === 'hooshcode') {
    const storedKey = apiKey || readStoredApiKey(paths.authPath);
    if (!storedKey) throw new SetupError('کلید API هوش کد لازم است.');
    lines.push(
      '[model_providers.hooshcode]',
      'name = "Hoosh Code"',
      `base_url = ${tomlString(HOOSH_CODE_BASE_URL)}`,
      `model_catalog_url = ${tomlString(HOOSH_CODE_MODELS_URL)}`,
      `experimental_bearer_token = ${tomlString(storedKey)}`,
      'wire_api = "responses"',
      'supports_websockets = true',
      '',
      '[model_providers.hooshcode.http_headers]',
      'x-openai-actor-authorization = "enabled"',
      '',
    );
  }
  lines.push('[projects."/workspace"]', 'trust_level = "trusted"', '');
  if (connectorBlock) lines.push(connectorBlock, '');
  if (proxyBlock) lines.push(proxyBlock, '');
  writePrivateFile(paths.configPath, lines.join('\n'));
}

function writeMarker(paths: SetupPaths, model: string, provider: CodexProvider): void {
  const marker = { managedBy: 'tenant', provider, model, updatedAt: new Date().toISOString() };
  writePrivateFile(paths.markerPath, `${JSON.stringify(marker)}\n`);
}

function readClaudeSettings(paths: ClaudeSetupPaths): Record<string, unknown> {
  return readJson(paths.settingsPath);
}

// Claude Code applies the `env` block of ~/.claude/settings.json to every
// session. The Hoosh Code claude access is NOT a raw ANTHROPIC_AUTH_TOKEN —
// the proxy rejects that with "This access has to be set up once on this
// computer" (its claude pool is device-bound behind the iclaude launcher).
// We store the panel token as HOOSHCODE_CLAUDE_TOKEN: the interactive
// runtime runs `iclaude run` (which owns auth), and the model catalog is
// fetched with it via x-api-key. ANTHROPIC_BASE_URL stays for the catalog
// fetch; the PTY env strips it before Claude Code sees it.
function writeClaudeProxyToken(token: string, paths: ClaudeSetupPaths): void {
  const settings = readClaudeSettings(paths);
  const env: Record<string, unknown> = {
    ...(settings.env && typeof settings.env === 'object' ? settings.env as Record<string, unknown> : {}),
    HOOSHCODE_CLAUDE: '1',
    HOOSHCODE_CLAUDE_TOKEN: token,
    ANTHROPIC_BASE_URL: CLAUDE_PROXY_BASE_URL,
  };
  // The hoosh access and the user's own Claude login are mutually exclusive
  // ways to authenticate Claude Code; the newest one wins.
  for (const key of ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY']) {
    delete env[key];
  }
  settings.env = env;
  writePrivateFile(paths.settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
}

function removeClaudeProxyToken(paths: ClaudeSetupPaths): void {
  if (!fs.existsSync(paths.settingsPath)) return;
  const settings = readClaudeSettings(paths);
  if (!settings.env || typeof settings.env !== 'object') return;
  let changed = false;
  for (const key of ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'HOOSHCODE_CLAUDE', 'HOOSHCODE_CLAUDE_TOKEN']) {
    if (Object.prototype.hasOwnProperty.call(settings.env, key)) {
      delete (settings.env as Record<string, unknown>)[key];
      changed = true;
    }
  }
  if (!changed) return;
  if (Object.keys(settings.env).length === 0) delete settings.env;
  writePrivateFile(paths.settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
}

function writeClaudeMarker(paths: ClaudeSetupPaths): void {
  const marker = { managedBy: 'tenant', provider: 'hooshcode_claude', updatedAt: new Date().toISOString() };
  writePrivateFile(paths.markerPath, `${JSON.stringify(marker)}\n`);
}

// ---- Hoosh Code claude device setup (iclaude) --------------------------------
// The panel token alone cannot talk to the claude pool: the proxy binds each
// computer via the iclaude launcher (`POST /api/register` exchanges the panel
// token for a device token + pooled Claude OAuth credentials, and the claude
// process runs with iclaude's hook bridging anthropic traffic through the
// proxy). Bundles ship the launcher at <app>/runtime/iclaude/iclaude(.exe).

function resolveIclaudeRunner(): { command: string; args: string[] } {
  const exe = process.platform === 'win32' ? 'iclaude.exe' : 'iclaude';
  // `iclaude setup` MOVES the launcher into <home>/.local/bin — canonical
  // after the first setup. The bundled runtime/iclaude seed (and the env
  // pointer to it) only exists before that.
  const installed = path.join(os.homedir(), '.local', 'bin', exe);
  if (fs.existsSync(installed)) return { command: installed, args: [] };
  const explicit = typeof process.env.CLOUDCLI_ICLAUDE_BIN === 'string' && process.env.CLOUDCLI_ICLAUDE_BIN.trim() !== ''
    ? process.env.CLOUDCLI_ICLAUDE_BIN.trim()
    : null;
  if (explicit && fs.existsSync(explicit)) return { command: explicit, args: [] };
  for (const root of walkUpModuleRoots()) {
    const candidate = path.join(root, 'runtime', 'iclaude', exe);
    if (fs.existsSync(candidate)) return { command: candidate, args: [] };
  }
  return { command: 'iclaude', args: [] };
}

function runIclaudeLogout(): void {
  try {
    // `iclaude logout` does NOT free the seat — a hoosh account only carries
    // 2 devices, so removing the credential must unregister this machine
    // (`iclaude uninstall -y`; conversations are kept, the binary stays).
    const runner = resolveIclaudeRunner();
    const child = spawnChildProcess(runner.command, [...runner.args, 'uninstall', '-y'], {
      detached: true,
      stdio: 'ignore',
    });
    child.on('error', () => { /* iclaude not present or uninstall unsupported: settings keys are gone anyway */ });
    child.unref();
  } catch {
    // Best-effort only — the settings cleanup already removes the access.
  }
}

type HooshClaudeSetupPhase = 'running' | 'done' | 'error';
type HooshClaudeSetup = {
  id: string;
  phase: HooshClaudeSetupPhase;
  log: string[];
  error: string | null;
  done: boolean;
  child: { kill(): void } | null;
  timer: NodeJS.Timeout | null;
};

const HOOSH_CLAUDE_SETUP_TIMEOUT_MS = 20 * 60 * 1000;
const HOOSH_CLAUDE_SETUP_LOG_LINES = 40;

let hooshClaudeSetup: HooshClaudeSetup | null = null;

// iclaude's own stderr lines, mapped to Persian the setup UI can show as-is.
function translateHooshSetupLine(line: string): string {
  if (line.includes("wasn't accepted")) return 'توکن هوش کد پذیرفته نشد. خط تنظیم را دوباره از پنل کپی کنید.';
  if (line.includes("Couldn't connect")) return 'ارتباط با هوش کد برقرار نشد. اینترنت را بررسی و دوباره تلاش کنید.';
  if (line.includes("doesn't include Claude Code")) return 'این دسترسی شامل Claude Code نیست. با پشتیبانی هوش کد تماس بگیرید.';
  if (line.includes('busy right now')) return 'سرور هوش کد فعلاً شلوغ است. یک دقیقه بعد دوباره تلاش کنید.';
  if (line.includes('Downloading')) return 'در حال دانلود Claude Code از هوش کد…';
  if (line.includes('Setting up') || line.includes('Connecting')) return 'در حال ثبت این دستگاه روی حساب هوش کد…';
  if (line.includes('Ready') || line.includes('Installed')) return 'راه‌اندازی کامل شد.';
  return line.trim();
}

function finishHooshClaudeSetup(setup: HooshClaudeSetup, phase: 'done' | 'error', error: string | null): void {
  if (setup.done) return;
  setup.done = true;
  setup.phase = phase;
  setup.error = error;
  if (setup.timer) clearTimeout(setup.timer);
  setup.child = null;
}

function startHooshClaudeSetup(token: string, homeDir: string, paths: ClaudeSetupPaths): HooshClaudeSetup {
  if (hooshClaudeSetup && !hooshClaudeSetup.done) {
    throw new SetupError('راه‌اندازی قبلی هنوز در جریان است.', 409);
  }
  const runner = resolveIclaudeRunner();
  const setup: HooshClaudeSetup = {
    id: crypto.randomUUID(),
    phase: 'running',
    log: ['در حال شروع راه‌اندازی Claude Code هوش کد…'],
    error: null,
    done: false,
    child: null,
    timer: null,
  };
  let settled = false;
  const appendLine = (chunk: Buffer) => {
    const text = stripAnsiCodes(chunk.toString('utf8'));
    for (const raw of text.split(/\r?\n/)) {
      const translated = translateHooshSetupLine(raw);
      if (translated) {
        setup.log.push(translated);
        if (setup.log.length > HOOSH_CLAUDE_SETUP_LOG_LINES) setup.log.shift();
      }
    }
  };
  try {
    const child = spawnChildProcess(runner.command, [...runner.args, 'setup', '--token', token, '--url', CLAUDE_PROXY_BASE_URL], {
      cwd: homeDir,
      env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    setup.child = {
      kill: () => { try { child.kill(); } catch { /* already gone */ } },
    };
    child.stdout?.on('data', appendLine);
    child.stderr?.on('data', appendLine);
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      finishHooshClaudeSetup(setup, 'error', `اجرای ابزار راه‌انداز هوش کد ممکن نشد: ${error.message}`);
    });
    child.once('close', (exitCode) => {
      if (settled) return;
      settled = true;
      if (exitCode === 0) {
        writeClaudeMarker(paths);
        setup.log.push('اتصال Claude Code هوش کد فعال شد.');
        finishHooshClaudeSetup(setup, 'done', null);
      } else {
        const lastError = [...setup.log].reverse().find((line) => /پذیرفته نشد|شامل Claude Code نیست|برقرار نشد|شلوغ/.test(line));
        finishHooshClaudeSetup(setup, 'error', lastError || `راه‌اندازی ناموفق بود (کد ${exitCode ?? 0}). دوباره تلاش کنید.`);
      }
    });
  } catch (error) {
    finishHooshClaudeSetup(setup, 'error', `اجرای ابزار راه‌انداز هوش کد ممکن نشد: ${messageFor(error)}`);
    return setup;
  }
  setup.timer = setTimeout(() => {
    setup.child?.kill();
    finishHooshClaudeSetup(setup, 'error', 'مهلت راه‌اندازی (۲۰ دقیقه) تمام شد؛ دوباره تلاش کنید.');
  }, HOOSH_CLAUDE_SETUP_TIMEOUT_MS);
  hooshClaudeSetup = setup;
  return setup;
}

type ClaudeSetupStatus = {
  configured: boolean;
  managedByTenant: boolean;
  method: 'iclaude' | 'oauth' | 'credentials' | 'api_key' | 'hooshcode_claude' | 'none';
  managedTeam: boolean;
  deviceReady: boolean;
};

function isManagedTeamClaude(): boolean {
  return process.env.CLAUDE_AUTH_MODE === 'iclaude';
}

function claudeStatus(paths: ClaudeSetupPaths): ClaudeSetupStatus {
  if (isManagedTeamClaude()) {
    const managedMarker = readJson(paths.managedTeamMarkerPath);
    const configured = managedMarker.mode === 'managed_team'
      && managedMarker.provider === 'iclaude'
      && managedMarker.serverOrigin === process.env.ICLAUDE_SERVER_URL
      && managedMarker.identitySha256 === process.env.ICLAUDE_IDENTITY_SHA256
      && managedMarker.credentialRevision === process.env.ICLAUDE_CREDENTIAL_REVISION
      && /^\d+\.\d+\.\d+$/.test(String(managedMarker.claudeCodeVersion || ''))
      && typeof managedMarker.verifiedAt === 'string';
    return {
      configured,
      managedByTenant: false,
      method: 'iclaude',
      managedTeam: true,
      deviceReady: configured,
    };
  }
  const settings = readClaudeSettings(paths);
  const env = settings.env && typeof settings.env === 'object'
    ? settings.env as Record<string, unknown>
    : {};
  const oauthToken = typeof env.CLAUDE_CODE_OAUTH_TOKEN === 'string' && env.CLAUDE_CODE_OAUTH_TOKEN.trim() !== '';
  const hooshClaude = env.HOOSHCODE_CLAUDE === '1';
  const proxyToken = typeof env.ANTHROPIC_AUTH_TOKEN === 'string' && env.ANTHROPIC_AUTH_TOKEN.trim() !== '';
  // The iclaude device registration completed on this computer (device token
  // present in its config). Without it the proxy refuses every request.
  const deviceReady = (() => {
    try {
      const iclaudeConfig = readJson(path.join(homeDirOf(paths), '.config', 'iclaude', 'config.json'));
      return typeof iclaudeConfig?.device_token === 'string' && iclaudeConfig.device_token.trim() !== '';
    } catch {
      return false;
    }
  })();
  // ~/.claude/.credentials.json appears when Claude Code itself completed a
  // full login (e.g. someone ran `claude` in the terminal tab).
  const hasCredentials = fs.existsSync(path.join(paths.claudeDir, '.credentials.json'));
  // Both the tenant (this plugin) and the platform bootstrap write the same
  // marker; ownership is decided by its managedBy field, not its existence.
  const marker = readJson(paths.markerPath);
  const method: ClaudeSetupStatus['method'] = hooshClaude
    ? 'hooshcode_claude'
    : oauthToken
      ? 'oauth'
      : hasCredentials
        ? 'credentials'
        : proxyToken
          ? 'api_key'
          : 'none';
  return {
    configured: method !== 'none' && (!hooshClaude || deviceReady),
    managedByTenant: marker.managedBy === 'tenant',
    method,
    managedTeam: false,
    deviceReady,
  };
}

// claudeSetupPaths carries absolute paths under the effective home; recover
// that home for iclaude's own config (~/.config/iclaude).
function homeDirOf(paths: ClaudeSetupPaths): string {
  return path.dirname(paths.claudeDir);
}


// ---- Claude Code account login (subscription, interactive) ------------------
// `claude setup-token` runs Anthropic's own OAuth flow: the user's browser
// opens the authorize page and, on success, the CLI prints a 1-year inference
// token. We run it in a pseudo terminal, capture that token server-side, and
// store it in ~/.claude/settings.json `env` (Claude Code applies that block to
// every session) so the interactive chat tabs bill the user's own claude.ai
// subscription. The token never reaches the browser side.

type PtyProcessLike = {
  write(data: string): void;
  kill(signal?: string): void;
  onData(listener: (data: string) => void): { dispose(): void };
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose(): void };
};
type PtyModuleLike = {
  spawn(file: string, args: string[], options: Record<string, unknown>): PtyProcessLike;
};

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

function walkUpModuleRoots(start: string = MODULE_DIR): string[] {
  const roots: string[] = [];
  let dir = path.resolve(start);
  for (let depth = 0; depth < 16; depth += 1) {
    roots.push(dir);
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return roots;
}

function loadPtyModule(): PtyModuleLike | null {
  const requireModule = createRequire(import.meta.url);
  const candidates: Array<() => unknown> = [() => requireModule('node-pty')];
  for (const root of walkUpModuleRoots()) {
    const absolute = path.join(root, 'node_modules', 'node-pty');
    if (fs.existsSync(absolute)) candidates.push(() => requireModule(absolute));
  }
  for (const load of candidates) {
    try {
      const candidate = load();
      if (candidate && typeof candidate === 'object' && typeof (candidate as PtyModuleLike).spawn === 'function') {
        return candidate as PtyModuleLike;
      }
    } catch { /* try the next root */ }
  }
  return null;
}

// Desktop bundles ship the CLI as <app>/node_modules/@anthropic-ai/claude-code
// /cli.js; resolve it by walking up from the plugin directory (the plugin is
// synced into <app>/data/home/.claude-code-ui/plugins). Falls back to `claude`
// on PATH for non-desktop installs.
function resolveClaudeCliRunner(): { command: string; args: string[] } {
  for (const root of walkUpModuleRoots()) {
    const cliJs = path.join(root, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
    if (fs.existsSync(cliJs)) {
      return { command: process.execPath, args: [cliJs, 'setup-token'] };
    }
  }
  return { command: 'claude', args: ['setup-token'] };
}

const ANSI_PATTERN = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;

function stripAnsiCodes(text: string): string {
  return text.replace(ANSI_PATTERN, '');
}

// The CLI marks onboarding complete only after its walkthrough; pre-marking the
// flags lets setup-token jump straight to the OAuth flow (same trick the chat
// runtime uses for the TUI).
function premarkClaudeOnboarding(homeDir: string): void {
  const configPath = path.join(homeDir, '.claude.json');
  let config: Record<string, unknown> = {};
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch { /* fresh home */ }
  if (!config || typeof config !== 'object') config = {};
  if (config.hasCompletedOnboarding === true && config.lastOnboardingVersion) return;
  config.hasCompletedOnboarding = true;
  config.lastOnboardingVersion = config.lastOnboardingVersion || '2.0.76';
  fs.mkdirSync(path.dirname(configPath), { recursive: true, mode: 0o700 });
  writePrivateFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

function writeClaudeOauthToken(token: string, paths: ClaudeSetupPaths): void {
  const settings = readClaudeSettings(paths);
  const env: Record<string, unknown> = {
    ...(settings.env && typeof settings.env === 'object' ? settings.env as Record<string, unknown> : {}),
    CLAUDE_CODE_OAUTH_TOKEN: token,
  };
  // The account login and the Hoosh Code claude access are mutually exclusive
  // ways to authenticate Claude Code; the newest one wins.
  for (const key of ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'HOOSHCODE_CLAUDE', 'HOOSHCODE_CLAUDE_TOKEN']) {
    delete env[key];
  }
  settings.env = env;
  writePrivateFile(paths.settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  writePrivateFile(paths.markerPath, `${JSON.stringify({
    managedBy: 'tenant',
    provider: 'claude_oauth',
    updatedAt: new Date().toISOString(),
  })}\n`);
}

function removeClaudeOauthToken(paths: ClaudeSetupPaths): void {
  if (!fs.existsSync(paths.settingsPath)) return;
  const settings = readClaudeSettings(paths);
  if (!settings.env || typeof settings.env !== 'object') return;
  const env = settings.env as Record<string, unknown>;
  // Logging out of Claude clears whichever access is active — the user's own
  // OAuth login or the Hoosh Code panel token.
  let changed = false;
  for (const key of ['CLAUDE_CODE_OAUTH_TOKEN', 'HOOSHCODE_CLAUDE', 'HOOSHCODE_CLAUDE_TOKEN', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL']) {
    if (Object.prototype.hasOwnProperty.call(env, key)) {
      delete env[key];
      changed = true;
    }
  }
  if (!changed) return;
  if (Object.keys(env).length === 0) delete settings.env;
  writePrivateFile(paths.settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  fs.rmSync(paths.markerPath, { force: true });
  runIclaudeLogout();
}

type ClaudeLoginPhase = 'starting' | 'waiting' | 'authorized' | 'error' | 'cancelled';
type ClaudeLoginChild = { kill(): void; write(data: string): void } | null;
type ClaudeLogin = {
  id: string;
  phase: ClaudeLoginPhase;
  url: string | null;
  message: string | null;
  startedAt: number;
  buffer: string;
  child: ClaudeLoginChild;
  pty: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  done: boolean;
};

// 2.1.110 prints https://claude.com/cai/oauth/authorize?... (older builds: claude.ai)
const CLAUDE_LOGIN_URL_PATTERN = /https:\/\/claude\.(?:ai|com)\/(?:[a-z]+\/)?oauth\/authorize\?[^\s"'<>]+/;
const CLAUDE_LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
let claudeLogin: ClaudeLogin | null = null;

function finishClaudeLogin(login: ClaudeLogin, phase: ClaudeLoginPhase, message: string | null = null): void {
  if (login.done) return;
  login.done = true;
  login.phase = phase;
  login.message = message;
  if (login.timer) clearTimeout(login.timer);
  login.timer = null;
}

function killClaudeLoginChild(login: ClaudeLogin): void {
  try { login.child?.kill(); } catch { /* already gone */ }
  login.child = null;
}

function openBrowserForLogin(url: string): void {
  try {
    const command = process.platform === 'win32' ? 'cmd.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
    spawnChildProcess(command, args, { detached: true, stdio: 'ignore' })
      .on('error', () => { /* headless host — the URL is rendered in the tab */ })
      .unref();
  } catch { /* the URL is rendered in the tab as a fallback */ }
}

function extractLoginToken(buffer: string): string | null {
  const hintAt = buffer.indexOf('Your OAuth token');
  if (hintAt < 0) return null;
  const match = buffer.slice(hintAt).match(/\(valid for 1 year\):\s*([\x21-\x7e]{64,512})/);
  return match?.[1] ?? null;
}

function resolveLoginWorkspace(homeDir: string): string {
  for (const root of walkUpModuleRoots()) {
    const candidate = path.join(root, 'workspace');
    try {
      if (fs.statSync(candidate).isDirectory()) return candidate;
    } catch { /* keep walking */ }
  }
  return homeDir;
}

function startClaudeLogin(homeDir: string, claudePaths: ClaudeSetupPaths): ClaudeLogin {
  if (claudeLogin && !claudeLogin.done && (claudeLogin.phase === 'starting' || claudeLogin.phase === 'waiting')) {
    throw new SetupError('یک تلاش ورود دیگر در جریان است؛ اول آن را لغو کنید.', 409);
  }
  premarkClaudeOnboarding(homeDir);
  const runner = resolveClaudeCliRunner();
  const login: ClaudeLogin = {
    id: `login-${Date.now().toString(36)}`,
    phase: 'starting',
    url: null,
    message: null,
    startedAt: Date.now(),
    buffer: '',
    child: null,
    pty: false,
    timer: null,
    done: false,
  };
  claudeLogin = login;

  const childEnv: Record<string, string> = {};
  const passthrough = new Set(['path', 'home', 'userprofile', 'appdata', 'localappdata', 'systemroot', 'temp', 'tmp', 'pathext', 'comspec']);
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && passthrough.has(key.toLowerCase())) childEnv[key] = value;
  }
  childEnv.TERM = 'xterm-256color';
  childEnv.NO_COLOR = '1';
  childEnv.DISABLE_AUTOUPDATER = '1';

  const handleOutput = (raw: string) => {
    if (login.done) return;
    login.buffer = (login.buffer + stripAnsiCodes(raw)).slice(-64 * 1024);
    if (!login.url) {
      const match = login.buffer.match(CLAUDE_LOGIN_URL_PATTERN);
      if (match) {
        login.url = match[0];
        login.phase = 'waiting';
        openBrowserForLogin(login.url);
      }
    }
    const token = extractLoginToken(login.buffer);
    if (token) {
      try {
        writeClaudeOauthToken(token, claudePaths);
      } catch (error) {
        finishClaudeLogin(login, 'error', `ذخیره توکن ناموفق بود: ${messageFor(error)}`);
        killClaudeLoginChild(login);
        return;
      }
      finishClaudeLogin(login, 'authorized');
      killClaudeLoginChild(login);
    }
  };

  const ptyModule = loadPtyModule();
  if (ptyModule) {
    const proc = ptyModule.spawn(runner.command, runner.args, {
      name: 'xterm-256color',
      cols: 500,
      rows: 60,
      cwd: resolveLoginWorkspace(homeDir),
      env: childEnv,
      encoding: 'utf8',
    });
    login.child = proc;
    login.pty = true;
    proc.onData(handleOutput);
    proc.onExit(({ exitCode }) => {
      if (login.done || login.phase === 'authorized') return;
      finishClaudeLogin(login, 'error', `فرآیند ورود بسته شد (کد ${exitCode}). دوباره تلاش کنید.`);
    });
  } else {
    const proc = spawnChildProcess(runner.command, runner.args, {
      cwd: resolveLoginWorkspace(homeDir),
      env: childEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    login.child = {
      kill: () => { try { proc.kill(); } catch { /* already gone */ } },
      write: (data: string) => { proc.stdin?.write(data); },
    };
    login.pty = false;
    proc.stdout?.on('data', (chunk: Buffer) => handleOutput(chunk.toString('utf8')));
    proc.stderr?.on('data', (chunk: Buffer) => handleOutput(chunk.toString('utf8')));
    proc.once('close', (exitCode) => {
      if (login.done || login.phase === 'authorized') return;
      finishClaudeLogin(login, 'error', `فرآیند ورود بسته شد (کد ${exitCode ?? 0}). دوباره تلاش کنید.`);
    });
    proc.once('error', (error) => {
      if (login.done) return;
      finishClaudeLogin(login, 'error', `اجرای Claude ممکن نشد: ${error.message}`);
    });
  }

  login.timer = setTimeout(() => {
    killClaudeLoginChild(login);
    finishClaudeLogin(login, 'error', 'مهلت ورود (۵ دقیقه) تمام شد؛ دوباره تلاش کنید.');
  }, CLAUDE_LOGIN_TIMEOUT_MS);
  return login;
}

function submitClaudeLoginCode(id: string, code: string): ClaudeLogin {
  const login = claudeLogin;
  if (!login || login.id !== id) throw new SetupError('این درخواست ورود پیدا نشد.', 404);
  if (login.done) throw new SetupError('این درخواست ورود پایان یافته است.', 409);
  if (login.phase !== 'waiting' || !login.child) throw new SetupError('هنوز نوبت وارد کردن کد نیست.', 409);
  const trimmed = code.trim();
  if (!/^[\x21-\x7e]{4,128}$/.test(trimmed)) throw new SetupError('کد واردشده معتبر به نظر نمی‌رسد.', 400);
  try {
    login.child.write(login.pty ? `${trimmed}\r` : `${trimmed}\n`);
  } catch (error) {
    finishClaudeLogin(login, 'error', `ارسال کد ناموفق بود: ${messageFor(error)}`);
  }
  return login;
}

function snapshotFile(pathname: string): Buffer | null {
  try {
    return fs.readFileSync(pathname);
  } catch {
    return null;
  }
}

function restoreFile(pathname: string, snapshot: Buffer | null): void {
  if (snapshot === null) {
    fs.rmSync(pathname, { force: true });
    return;
  }
  fs.mkdirSync(path.dirname(pathname), { recursive: true, mode: 0o700 });
  fs.writeFileSync(pathname, snapshot, { mode: 0o600 });
}

async function validateBearerToken(
  apiKey: string,
  url: string,
  providerLabel: string,
  extraHeaders: Record<string, string> = {},
  authStyle: 'bearer' | 'x-api-key' = 'bearer',
): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROVIDER_VALIDATION_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: {
        ...(authStyle === 'x-api-key' ? { 'x-api-key': apiKey } : { Authorization: `Bearer ${apiKey}` }),
        ...extraHeaders,
      },
      signal: controller.signal,
    });
    if (response.status === 401 || response.status === 403) {
      throw new SetupError(`${providerLabel} این کلید API را نپذیرفت.`, 400);
    }
    if (!response.ok) throw new SetupError(`اعتبارسنجی ${providerLabel} موقتاً در دسترس نیست (${response.status}).`, 502);
  } catch (error) {
    if (error instanceof SetupError) throw error;
    if ((error as Error).name === 'AbortError') throw new SetupError(`ارتباط با ${providerLabel} برای اعتبارسنجی طول کشید. دوباره تلاش کنید.`, 504);
    throw new SetupError(`برای اعتبارسنجی کلید به ${providerLabel} دسترسی نداریم.`, 502);
  } finally {
    clearTimeout(timer);
  }
}

function validateWithOpenAi(apiKey: string): Promise<void> {
  return validateBearerToken(apiKey, OPENAI_MODELS_URL, 'OpenAI');
}

function validateWithHooshCode(apiKey: string): Promise<void> {
  return validateBearerToken(apiKey, HOOSH_CODE_MODELS_URL, 'هوش کد', {
    'x-openai-actor-authorization': 'enabled',
  });
}

// The Hoosh Code claude pool is NOT a plain ANTHROPIC_BASE_URL proxy: the
// Bearer path is gated behind its iclaude device setup ("This access has to
// be set up once on this computer"). The models listing is the one endpoint
// that accepts the panel token directly — and only via x-api-key (2026-11-03,
// verified against claude.flearning.ir with a live panel token).
function validateWithHooshCodeClaude(apiKey: string): Promise<void> {
  return validateBearerToken(apiKey, CLAUDE_MODELS_URL, 'هوش کد', {
    'anthropic-version': '2023-06-01',
  }, 'x-api-key');
}

function validateKeyShape(apiKey: unknown): string {
  if (typeof apiKey !== 'string') throw new SetupError('API key لازم است.');
  const normalized = apiKey.trim();
  if (!normalized || normalized.length > 4096 || /\s/.test(normalized)) {
    throw new SetupError('API key معتبر و بدون فاصله وارد کنید.');
  }
  return normalized;
}

function validateModel(model: unknown, provider: CodexProvider): string {
  const normalized = typeof model === 'string' ? model.trim() : DEFAULT_MODELS[provider];
  if (!MODEL_SLUG_PATTERN.test(normalized)) throw new SetupError('مدل انتخاب‌شده معتبر نیست.');
  return normalized;
}

function validateProvider(provider: unknown): Provider {
  const normalized = typeof provider === 'string' ? provider.trim() : 'openai';
  if (!SUPPORTED_PROVIDERS.has(normalized)) throw new SetupError('نوع اتصال پشتیبانی نمی‌شود.');
  return normalized as Provider;
}


// ---- Codex model catalog (token-scoped) ------------------------------------
// Fetches the models the saved key actually unlocks and mirrors them into
// ~/.codex/models_cache.json — the exact file the chat model picker reads as
// its fallback when `codex debug models` cannot answer (0.110 has no such
// subcommand). Shapes accepted: the codex catalog ({models:[{slug,...}]}),
// the OpenAI list ({data:[{id}]}) and a bare array of ids.

type CodexCatalogRecord = {
  slug: string;
  display_name?: string;
  description?: string;
  visibility?: string;
  supported_in_api?: boolean;
  priority?: number;
};

async function fetchCodexCatalog(provider: CodexProvider, apiKey: string): Promise<Array<Record<string, unknown>>> {
  const url = provider === 'hooshcode' ? HOOSH_CODE_MODELS_URL : OPENAI_MODELS_URL;
  const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}` };
  if (provider === 'hooshcode') headers['x-openai-actor-authorization'] = 'enabled';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROVIDER_VALIDATION_TIMEOUT_MS);
  try {
    const response = await fetch(url, { headers, signal: controller.signal });
    if (!response.ok) return [];
    const payload = await response.json() as Record<string, unknown>;
    const raw = Array.isArray(payload)
      ? payload
      : Array.isArray(payload?.models)
        ? payload.models as Array<Record<string, unknown>>
        : Array.isArray(payload?.data)
          ? payload.data as Array<Record<string, unknown>>
          : [];
    const records: Array<Record<string, unknown>> = [];
    raw.forEach((entry, index) => {
      if (!entry || typeof entry !== 'object') return;
      const record = entry as Record<string, unknown>;
      const slug = typeof record.slug === 'string'
        ? record.slug
        : typeof record.id === 'string'
          ? record.id
          : '';
      if (!slug || !MODEL_SLUG_PATTERN.test(slug)) return;
      records.push({
        slug,
        display_name: typeof record.display_name === 'string' ? record.display_name : slug,
        description: typeof record.description === 'string' ? record.description : undefined,
        visibility: 'list',
        supported_in_api: true,
        priority: index,
      });
    });
    return records;
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

async function syncCodexModelsCache(paths: SetupPaths, provider: CodexProvider, apiKey: string): Promise<string[]> {
  const records = await fetchCodexCatalog(provider, apiKey);
  if (records.length > 0) {
    writePrivateFile(path.join(paths.codexDir, 'models_cache.json'), `${JSON.stringify({ models: records }, null, 2)}\n`);
  }
  return records.map((record) => String(record.slug)).slice(0, 40);
}

export function createOpenAiSetupApp(dependencies: SetupDependencies = {}): Express {
  const homeDir = dependencies.homeDir || os.homedir();
  const paths = setupPaths(homeDir);
  const claudePaths = claudeSetupPaths(homeDir);
  const modelProxiesPath = path.join(homeDir, '.cloudcli', 'model-proxies.json');
  const validateProxyClaudeToken = dependencies.validateProxyClaudeToken || validateProxyTokenForClaude;
  const validateProxyCodexToken = dependencies.validateProxyCodexToken || validateProxyTokenForCodex;
  const listModelProxies = () => readModelProxies(modelProxiesPath);
  const validateOpenAiApiKey = dependencies.validateOpenAiApiKey || dependencies.validateApiKey || validateWithOpenAi;
  const validateHooshCodeApiKey = dependencies.validateHooshCodeApiKey || validateWithHooshCode;
  const validateClaudeProxyApiKey = dependencies.validateClaudeProxyApiKey || validateWithHooshCodeClaude;
  const persistApiKey = dependencies.persistApiKey || writeApiKey;
  const removeApiKey = dependencies.removeApiKey || ((setup: SetupPaths) => fs.rmSync(setup.authPath, { force: true }));
  const app = express();
  let credentialMutationInProgress = false;

  app.disable('x-powered-by');
  app.use(express.json({ limit: '16kb' }));
  app.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  app.get('/health', (_req, res) => res.json({
    status: 'ok',
    plugin: 'openai-setup',
    providers: ['openai', 'hooshcode', 'hooshcode_claude'],
  }));

  app.get('/status', (_req, res) => {
    const method = authMethod(paths.authPath);
    const managedByTenant = fs.existsSync(paths.markerPath);
    const provider = readProvider(paths);
    const codexProvider: CodexProvider = provider === 'hooshcode' ? 'hooshcode' : 'openai';
    res.json({
      configured: method !== 'none' && managedByTenant,
      method,
      provider,
      managedByTenant,
      model: readModel(paths.configPath, codexProvider),
      claude: claudeStatus(claudePaths),
    });
  });

  app.post('/configure', async (req, res, next) => {
    if (credentialMutationInProgress) return next(new SetupError('Another credential update is still running.', 409));
    credentialMutationInProgress = true;
    try {
      const provider = validateProvider(req.body?.provider);
      if (provider === 'hooshcode_claude') {
        if (isManagedTeamClaude()) {
          throw new SetupError('اتصال Claude از طریق حساب تیم توسط پلتفرم مدیریت می‌شود.', 403);
        }
        const suppliedToken = typeof req.body?.apiKey === 'string' && req.body.apiKey.trim()
          ? validateKeyShape(req.body.apiKey)
          : null;
        if (!suppliedToken && !claudeStatus(claudePaths).configured) {
          throw new SetupError('توکن هوش کد برای Claude Code را وارد کنید.');
        }
        if (suppliedToken) {
          const previousSettings = snapshotFile(claudePaths.settingsPath);
          const previousMarker = snapshotFile(claudePaths.markerPath);
          try {
            await validateClaudeProxyApiKey(suppliedToken);
            writeClaudeProxyToken(suppliedToken, claudePaths);
            // Register THIS computer on the hoosh account (device token +
            // pooled Claude credentials via the iclaude launcher). Runs as a
            // polled task — it downloads Claude Code on first use.
            startHooshClaudeSetup(suppliedToken, homeDir, claudePaths);
          } catch (error) {
            restoreFile(claudePaths.settingsPath, previousSettings);
            restoreFile(claudePaths.markerPath, previousMarker);
            throw error;
          }
        }
        res.json({
          ok: true,
          configured: true,
          provider,
          claude: claudeStatus(claudePaths),
          hooshClaudeSetup: hooshClaudeSetup ? { id: hooshClaudeSetup.id, phase: hooshClaudeSetup.phase, log: hooshClaudeSetup.log, error: hooshClaudeSetup.error } : null,
        });
        return;
      }
      const model = validateModel(req.body?.model, provider);
      const suppliedKey = typeof req.body?.apiKey === 'string' && req.body.apiKey.trim()
        ? validateKeyShape(req.body.apiKey)
        : null;
      const existingMethod = authMethod(paths.authPath);
      const existingProvider = readProvider(paths);
      if (!suppliedKey && (
        existingMethod !== 'api_key' ||
        !fs.existsSync(paths.markerPath) ||
        existingProvider !== provider
      )) {
        throw new SetupError(provider === 'hooshcode' ? 'کلید API هوش کد را وارد کنید.' : 'OpenAI API key را وارد کنید.');
      }

      if (suppliedKey) {
        const previousAuth = snapshotFile(paths.authPath);
        const previousConfig = snapshotFile(paths.configPath);
        const previousMarker = snapshotFile(paths.markerPath);
        try {
          if (provider === 'openai') await validateOpenAiApiKey(suppliedKey);
          else await validateHooshCodeApiKey(suppliedKey);
          await persistApiKey(suppliedKey, paths);
          writeProviderConfig(paths, model, provider, suppliedKey);
          writeMarker(paths, model, provider);
        } catch (error) {
          restoreFile(paths.authPath, previousAuth);
          restoreFile(paths.configPath, previousConfig);
          restoreFile(paths.markerPath, previousMarker);
          throw error;
        }
      } else {
        writeProviderConfig(paths, model, provider);
        writeMarker(paths, model, provider);
      }
      // Load the models this key unlocks so the chat picker (and the setup
      // tab) can show them immediately.
      const effectiveKey = suppliedKey || readStoredApiKey(paths.authPath);
      const models = effectiveKey ? await syncCodexModelsCache(paths, provider, effectiveKey) : [];
      res.json({ ok: true, configured: true, method: 'api_key', provider, model, models });
    } catch (error) {
      next(error);
    } finally {
      credentialMutationInProgress = false;
    }
  });

  app.delete('/credentials', async (_req, res, next) => {
    if (credentialMutationInProgress) return next(new SetupError('Another credential update is still running.', 409));
    credentialMutationInProgress = true;
    try {
      await removeApiKey(paths);
      fs.rmSync(paths.markerPath, { force: true });
      fs.rmSync(paths.authPath, { force: true });
      writeProviderConfig(paths, readModel(paths.configPath, 'openai'), 'openai');
      res.json({ ok: true, configured: false, provider: 'openai' });
    } catch (error) {
      next(error);
    } finally {
      credentialMutationInProgress = false;
    }
  });

  // Removing the Claude Code token never touches the Codex credential or the
  // customer's own Claude login state; it only drops the Hoosh Code proxy env.
  app.delete('/credentials/claude', async (_req, res, next) => {
    if (isManagedTeamClaude()) {
      return next(new SetupError('اتصال Claude از طریق حساب تیم توسط پلتفرم مدیریت می‌شود و قابل حذف نیست.', 403));
    }
    if (credentialMutationInProgress) return next(new SetupError('Another credential update is still running.', 409));
    credentialMutationInProgress = true;
    try {
      removeClaudeProxyToken(claudePaths);
      fs.rmSync(claudePaths.markerPath, { force: true });
      runIclaudeLogout();
      res.json({ ok: true, configured: false, provider: 'hooshcode_claude', claude: claudeStatus(claudePaths) });
    } catch (error) {
      next(error);
    } finally {
      credentialMutationInProgress = false;
    }
  });


  // ---- Claude Code account login (interactive subscription OAuth) -----------

  app.post('/claude/login', (_req, res, next) => {
    try {
      const current = claudeStatus(claudePaths);
      if (current.method === 'oauth' || current.method === 'credentials') {
        throw new SetupError('Claude Code از قبل متصل است؛ اول اتصال فعلی را حذف کنید.', 409);
      }
      const login = startClaudeLogin(homeDir, claudePaths);
      res.json({ ok: true, id: login.id, phase: login.phase });
    } catch (error) {
      next(error);
    }
  });

  app.get('/claude/login/:id', (req, res) => {
    if (!claudeLogin || claudeLogin.id !== req.params.id) {
      res.status(404).json({ error: 'درخواست ورود پیدا نشد؛ دوباره شروع کنید.' });
      return;
    }
    res.json({ phase: claudeLogin.phase, url: claudeLogin.url, message: claudeLogin.message });
  });

  app.post('/claude/login/:id/input', (req, res, next) => {
    try {
      const code = typeof req.body?.code === 'string' ? req.body.code : '';
      const login = submitClaudeLoginCode(req.params.id, code);
      res.json({ ok: true, phase: login.phase, url: login.url });
    } catch (error) {
      next(error);
    }
  });

  app.delete('/claude/login/:id', (req, res) => {
    if (!claudeLogin || claudeLogin.id !== req.params.id) {
      res.status(404).json({ error: 'درخواست ورود پیدا نشد.' });
      return;
    }
    killClaudeLoginChild(claudeLogin);
    finishClaudeLogin(claudeLogin, 'cancelled');
    res.json({ ok: true });
  });

  // ---- Hoosh Code claude device setup (polled task) ------------------------

  app.get('/hoosh-claude/setup/:id', (req, res) => {
    if (!hooshClaudeSetup || hooshClaudeSetup.id !== req.params.id) {
      res.status(404).json({ error: 'درخواست راه‌اندازی پیدا نشد.' });
      return;
    }
    res.json({
      id: hooshClaudeSetup.id,
      phase: hooshClaudeSetup.phase,
      log: hooshClaudeSetup.log,
      error: hooshClaudeSetup.error,
    });
  });

  app.delete('/hoosh-claude/setup/:id', (req, res) => {
    if (!hooshClaudeSetup || hooshClaudeSetup.id !== req.params.id) {
      res.status(404).json({ error: 'درخواست راه‌اندازی پیدا نشد.' });
      return;
    }
    if (!hooshClaudeSetup.done) {
      hooshClaudeSetup.child?.kill();
      finishHooshClaudeSetup(hooshClaudeSetup, 'error', 'راه‌اندازی لغو شد.');
    }
    res.json({ ok: true });
  });

  app.delete('/claude-login', async (_req, res, next) => {
    if (isManagedTeamClaude()) {
      return next(new SetupError('اتصال Claude از طریق حساب تیم توسط پلتفرم مدیریت می‌شود و قابل حذف نیست.', 403));
    }
    if (credentialMutationInProgress) return next(new SetupError('Another credential update is still running.', 409));
    credentialMutationInProgress = true;
    try {
      if (claudeLogin && !claudeLogin.done) {
        killClaudeLoginChild(claudeLogin);
        finishClaudeLogin(claudeLogin, 'cancelled');
      }
      removeClaudeOauthToken(claudePaths);
      res.json({ ok: true, configured: false, claude: claudeStatus(claudePaths) });
    } catch (error) {
      next(error);
    } finally {
      credentialMutationInProgress = false;
    }
  });

  // ---- Tenant-registered model proxies --------------------------------
  // Each proxy is a {baseUrl, token} pair the tenant adds on top of the
  // built-in Hoosh Code connection. Claude sessions route per model pick
  // (`opus@<id>`), Codex sessions through a managed [model_providers.cpx_<id>]
  // block kept in sync with this registry.

  app.get('/proxies', (_req, res) => {
    res.json({ proxies: listModelProxies().map(publicModelProxy) });
  });

  app.post('/proxies', async (req, res, next) => {
    if (credentialMutationInProgress) return next(new SetupError('Another credential update is still running.', 409));
    credentialMutationInProgress = true;
    try {
      const proxies = listModelProxies();
      if (proxies.length >= MAX_MODEL_PROXIES) {
        throw new SetupError(`حداکثر ${MAX_MODEL_PROXIES} پروکسی می‌توانید ثبت کنید.`, 400);
      }
      const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
      if (!name || name.length > 48) throw new SetupError('نام پروکسی (۱ تا ۴۸ نویسه) لازم است.');
      const token = validateKeyShape(req.body?.token);
      const claudeBaseUrl = normalizeProxyUrl(req.body?.claudeBaseUrl, 'Base URL مخصوص Claude');
      const codexBaseUrl = normalizeProxyUrl(req.body?.codexBaseUrl, 'Base URL مخصوص Codex');
      if (isManagedTeamClaude() && claudeBaseUrl) {
        throw new SetupError('در حالت حساب تیم، مسیر Claude قابل تغییر نیست؛ این پروکسی را فقط برای Codex ثبت کنید.', 403);
      }
      if (!claudeBaseUrl && !codexBaseUrl) {
        throw new SetupError('حداقل یکی از Base URLهای Claude یا Codex را وارد کنید.');
      }
      const id = uniqueProxyId(name, proxies);
      const entry: ModelProxy = {
        id,
        name,
        claudeBaseUrl,
        codexBaseUrl,
        token,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      try {
        if (claudeBaseUrl) await validateProxyClaudeToken(token, claudeBaseUrl);
        if (codexBaseUrl) await validateProxyCodexToken(token, codexBaseUrl);
      } catch (error) {
        throw new SetupError(`پروکسی «${name}» این توکن را نپذیرفت: ${messageFor(error)}`, 400);
      }
      proxies.push(entry);
      writeModelProxies(modelProxiesPath, proxies);
      syncProxyBlock(paths, proxies);
      res.json({ ok: true, proxy: publicModelProxy(entry) });
    } catch (error) {
      next(error);
    } finally {
      credentialMutationInProgress = false;
    }
  });

  app.post('/proxies/:id/test', async (req, res, next) => {
    try {
      const entry = listModelProxies().find((item) => item.id === req.params.id);
      if (!entry) throw new SetupError('پروکسی پیدا نشد.', 404);
      const results: Record<string, string> = {};
      if (entry.claudeBaseUrl) {
        try {
          await validateProxyTokenForClaude(entry.token, entry.claudeBaseUrl);
          results.claude = 'ok';
        } catch (error) {
          results.claude = messageFor(error);
        }
      }
      if (entry.codexBaseUrl) {
        try {
          await validateProxyTokenForCodex(entry.token, entry.codexBaseUrl);
          results.codex = 'ok';
        } catch (error) {
          results.codex = messageFor(error);
        }
      }
      res.json({ ok: true, results });
    } catch (error) {
      next(error);
    }
  });

  app.delete('/proxies/:id', async (req, res, next) => {
    if (credentialMutationInProgress) return next(new SetupError('Another credential update is still running.', 409));
    credentialMutationInProgress = true;
    try {
      const proxies = listModelProxies();
      const remaining = proxies.filter((entry) => entry.id !== req.params.id);
      if (remaining.length === proxies.length) throw new SetupError('پروکسی پیدا نشد.', 404);
      writeModelProxies(modelProxiesPath, remaining);
      syncProxyBlock(paths, remaining);
      res.json({ ok: true, proxies: remaining.map(publicModelProxy) });
    } catch (error) {
      next(error);
    } finally {
      credentialMutationInProgress = false;
    }
  });

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const statusCode = error instanceof SetupError ? error.statusCode : 500;
    const message = error instanceof SetupError ? error.message : 'OpenAI credential setup failed.';
    if (!(error instanceof SetupError)) {
      console.error('[openai-setup] unexpected error:', error);
    }
    res.status(statusCode).json({ error: message });
  });

  return app;
}

function start(): void {
  const app = createOpenAiSetupApp();
  // Desktop bundles share the user's machine: the default port can be taken
  // by anything (another app, a second CloudCLI copy). Fall back to an
  // ephemeral port — the host reads the port from the ready line.
  const boot = (port: number): void => {
    const server = app.listen(port, HOST, () => {
      const address = server.address();
      console.log(JSON.stringify({ ready: true, port: typeof address === 'object' && address ? address.port : port }));
    });
    server.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE' && port !== 0) {
        console.error(`[openai-setup] port ${port} busy - picking a free one`);
        boot(0);
        return;
      }
      console.error('[openai-setup] server error:', error.message);
      process.exit(1);
    });
    const shutdown = () => server.close(() => process.exit(0));
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  };
  boot(PORT);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) start();
