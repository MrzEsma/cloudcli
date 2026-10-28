import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_PROXY_BASE_URL = 'https://claude.flearning.ir/backend-api/codex';
const DEFAULT_OPENAI_MODEL = 'gpt-5.6-sol';
const DEFAULT_PROXY_MODEL = 'gpt-5.6-sol';

const tomlString = (value) => JSON.stringify(String(value ?? ''));

function writePrivateFile(pathname, content) {
  const temporaryPath = `${pathname}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, content, { mode: 0o600 });
  fs.renameSync(temporaryPath, pathname);
  fs.chmodSync(pathname, 0o600);
}

function readMarker(pathname) {
  try {
    const parsed = JSON.parse(fs.readFileSync(pathname, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function initializeCodexProvider(environment = process.env) {
  // This initializer is destructive by design for a fresh SaaS tenant: BYOK
  // mode removes any inherited platform credential. Never let a host-side
  // local launcher apply that policy to a developer's personal Codex home.
  if (environment.CLOUDCLI_TENANT_MODE !== '1') {
    return { initialized: false, tenantMode: false };
  }

  const home = environment.HOME || os.homedir();
  const codexDir = path.join(home, '.codex');
  const markerPath = path.join(codexDir, '.cloudcli-user-managed-auth');
  const authPath = path.join(codexDir, 'auth.json');
  const configPath = path.join(codexDir, 'config.toml');
  const authMode = environment.CODEX_AUTH_MODE || 'byok';
  const token = environment.CODEX_PROXY_TOKEN || '';
  const baseUrl = environment.CODEX_PROXY_BASE_URL || DEFAULT_PROXY_BASE_URL;
  const model = environment.CLOUDCLI_DEFAULT_CODEX_MODEL
    || (authMode === 'proxy' ? DEFAULT_PROXY_MODEL : DEFAULT_OPENAI_MODEL);

  if (authMode !== 'byok' && authMode !== 'proxy') {
    throw new Error('CODEX_AUTH_MODE must be byok or proxy.');
  }
  if (!/^https:\/\/\S+$/.test(baseUrl)) {
    throw new Error('CODEX_PROXY_BASE_URL must be an HTTPS URL without whitespace.');
  }
  if (!/^gpt-[a-zA-Z0-9._-]+$/.test(model)) {
    throw new Error('CLOUDCLI_DEFAULT_CODEX_MODEL is invalid.');
  }

  fs.mkdirSync(codexDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(codexDir, 0o700);

  // A credential explicitly changed inside the tenant always wins across
  // restarts. Platform-managed invite credentials are reconciled from the
  // tenant Secret so a controlled rotation can take effect on restart.
  const marker = readMarker(markerPath);
  if (marker.managedBy === 'tenant') return { initialized: false, managedByTenant: true };

  const common = [
    `model = ${tomlString(model)}`,
    'approval_policy = "never"',
    'sandbox_mode = "workspace-write"',
    'cli_auth_credentials_store = "file"',
  ];

  if (authMode === 'proxy') {
    if (!token) throw new Error('CODEX_PROXY_TOKEN is required in proxy mode.');
    writePrivateFile(configPath, [
      ...common,
      'model_provider = "hooshcode"',
      'suppress_unstable_features_warning = true',
      '',
      '[features]',
      'api_key_model_discovery = true',
      '',
      '[model_providers.hooshcode]',
      'name = "Hoosh Code"',
      `base_url = ${tomlString(baseUrl)}`,
      `model_catalog_url = ${tomlString(`${baseUrl}/models`)}`,
      `experimental_bearer_token = ${tomlString(token)}`,
      'wire_api = "responses"',
      'supports_websockets = true',
      '',
      '[model_providers.hooshcode.http_headers]',
      'x-openai-actor-authorization = "enabled"',
      '',
      '[projects."/workspace"]',
      'trust_level = "trusted"',
      '',
    ].join('\n'));
    writePrivateFile(authPath, `${JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: token }, null, 2)}\n`);
    writePrivateFile(markerPath, `${JSON.stringify({
      managedBy: 'platform',
      provider: 'hooshcode',
      model,
    })}\n`);
    return { initialized: true, managedByTenant: false, provider: 'hooshcode' };
  }

  if (marker.managedBy === 'platform') fs.rmSync(markerPath, { force: true });
  fs.rmSync(authPath, { force: true });
  writePrivateFile(configPath, [
    ...common,
    'model_provider = "openai"',
    '',
    '[projects."/workspace"]',
    'trust_level = "trusted"',
    '',
  ].join('\n'));
  return { initialized: true, managedByTenant: false, provider: 'openai' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  initializeCodexProvider();
}
