import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import express, { type Express, type NextFunction, type Request, type Response } from 'express';

const HOST = '127.0.0.1';
const PORT = 3012;
const DEFAULT_MODELS: Record<CodexProvider, string> = {
  openai: 'gpt-5.6-sol',
  hooshcode: 'gpt-5.6-sol',
};
const SUPPORTED_MODELS: Record<CodexProvider, Set<string>> = {
  openai: new Set([
    'gpt-5.6-sol',
    'gpt-5.6-terra',
    'gpt-5.6-luna',
    'gpt-5.5',
    'gpt-5.4',
    'gpt-5.4-mini',
  ]),
  hooshcode: new Set(['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']),
};
const SUPPORTED_PROVIDERS = new Set(['openai', 'hooshcode', 'hooshcode_claude']);
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

function readModel(configPath: string, provider: CodexProvider = 'openai'): string {
  try {
    const match = fs.readFileSync(configPath, 'utf8').match(/^model\s*=\s*"([^"]+)"/m);
    const model = match?.[1] || '';
    return SUPPORTED_MODELS[provider].has(model) ? model : DEFAULT_MODELS[provider];
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
  const lines = [...commonConfig(model), `model_provider = ${tomlString(provider)}`, ''];
  if (provider === 'hooshcode') {
    const storedKey = apiKey || readStoredApiKey(paths.authPath);
    if (!storedKey) throw new SetupError('کلید API هوش کد لازم است.');
    lines.push(
      '[model_providers.hooshcode]',
      'name = "Hoosh Code"',
      `base_url = ${tomlString(HOOSH_CODE_BASE_URL)}`,
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
// session, so the tenant-entered Hoosh Code token is stored there and nowhere
// else. Unrelated settings keys always survive.
function writeClaudeProxyToken(token: string, paths: ClaudeSetupPaths): void {
  const settings = readClaudeSettings(paths);
  settings.env = {
    ...(settings.env && typeof settings.env === 'object' ? settings.env : {}),
    ANTHROPIC_AUTH_TOKEN: token,
    ANTHROPIC_BASE_URL: CLAUDE_PROXY_BASE_URL,
  };
  writePrivateFile(paths.settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
}

function removeClaudeProxyToken(paths: ClaudeSetupPaths): void {
  if (!fs.existsSync(paths.settingsPath)) return;
  const settings = readClaudeSettings(paths);
  if (!settings.env || typeof settings.env !== 'object') return;
  let changed = false;
  for (const key of ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL']) {
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

type ClaudeSetupStatus = {
  configured: boolean;
  managedByTenant: boolean;
  method: 'iclaude' | 'api_key' | 'none';
  managedTeam: boolean;
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
    };
  }
  const settings = readClaudeSettings(paths);
  const env = settings.env && typeof settings.env === 'object'
    ? settings.env as Record<string, unknown>
    : {};
  // Both the tenant (this plugin) and the platform bootstrap write the same
  // marker; ownership is decided by its managedBy field, not its existence.
  const marker = readJson(paths.markerPath);
  return {
    configured: typeof env.ANTHROPIC_AUTH_TOKEN === 'string' && env.ANTHROPIC_AUTH_TOKEN.trim() !== '',
    managedByTenant: marker.managedBy === 'tenant',
    method: typeof env.ANTHROPIC_AUTH_TOKEN === 'string' && env.ANTHROPIC_AUTH_TOKEN.trim() !== ''
      ? 'api_key'
      : 'none',
    managedTeam: false,
  };
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
): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROVIDER_VALIDATION_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
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

// Validate the Claude-targeted token exactly the way Claude Code will use it:
// ANTHROPIC_AUTH_TOKEN as a bearer header on the Anthropic-compatible origin.
function validateWithHooshCodeClaude(apiKey: string): Promise<void> {
  return validateBearerToken(apiKey, CLAUDE_MODELS_URL, 'هوش کد', {
    'anthropic-version': '2023-06-01',
  });
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
  if (!SUPPORTED_MODELS[provider].has(normalized)) throw new SetupError('مدل انتخاب‌شده برای این ارائه‌دهنده پشتیبانی نمی‌شود.');
  return normalized;
}

function validateProvider(provider: unknown): Provider {
  const normalized = typeof provider === 'string' ? provider.trim() : 'openai';
  if (!SUPPORTED_PROVIDERS.has(normalized)) throw new SetupError('نوع اتصال پشتیبانی نمی‌شود.');
  return normalized as Provider;
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
            writeClaudeMarker(claudePaths);
          } catch (error) {
            restoreFile(claudePaths.settingsPath, previousSettings);
            restoreFile(claudePaths.markerPath, previousMarker);
            throw error;
          }
        }
        res.json({ ok: true, configured: true, provider, claude: claudeStatus(claudePaths) });
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
      res.json({ ok: true, configured: true, method: 'api_key', provider, model });
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
      res.json({ ok: true, configured: false, provider: 'hooshcode_claude', claude: claudeStatus(claudePaths) });
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
    res.status(statusCode).json({ error: message });
  });

  return app;
}

function start(): void {
  const app = createOpenAiSetupApp();
  const server = app.listen(PORT, HOST, () => {
    console.log(JSON.stringify({ ready: true, port: PORT }));
  });
  const shutdown = () => server.close(() => process.exit(0));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) start();
