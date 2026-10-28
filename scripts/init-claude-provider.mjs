import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const DEFAULT_PROXY_BASE_URL = 'https://claude.flearning.ir';
const DEFAULT_ICLAUDE_SERVER_URL = 'https://iclaude.flearning.ir';
const DEFAULT_ICLAUDE_PATH = '/usr/local/bin/iclaude';
const ICLAUDE_COMMAND_TIMEOUT_MS = 10 * 60 * 1000;
const ICLAUDE_COMMAND_KILL_GRACE_MS = 5 * 1000;
const MAX_COMMAND_OUTPUT_BYTES = 64 * 1024;
const MANAGED_ENV_KEYS = ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL'];
const ICLAUDE_SHARED_SESSION_DIRS = ['projects', 'file-history', 'ide'];
const ICLAUDE_SHARED_PREFERENCES = [
  { name: 'settings.json', type: 'file' },
  { name: 'plugins', type: 'directory' },
  { name: 'skills', type: 'directory' },
  { name: '.claude.json', type: 'file' },
];
const ICLAUDE_CONFIG_MIGRATION_MARKER = '.claude-config-login-required';

function writePrivateFile(pathname, content) {
  fs.mkdirSync(path.dirname(pathname), { recursive: true, mode: 0o700 });
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

function readSettings(pathname) {
  try {
    const parsed = JSON.parse(fs.readFileSync(pathname, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

// Claude Code applies the `env` block of ~/.claude/settings.json to every
// session. Proxy mode intentionally owns only these keys and leaves the rest
// of the customer's settings untouched.
function applyProxySettings(settingsPath, token, baseUrl) {
  const settings = readSettings(settingsPath);
  settings.env = {
    ...(settings.env && typeof settings.env === 'object' ? settings.env : {}),
    ANTHROPIC_AUTH_TOKEN: token,
    ANTHROPIC_BASE_URL: baseUrl,
  };
  delete settings.env.ANTHROPIC_API_KEY;
  writePrivateFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
}

function removeProxySettings(settingsPath) {
  if (!fs.existsSync(settingsPath)) return;
  const settings = readSettings(settingsPath);
  if (!settings.env || typeof settings.env !== 'object') return;
  let changed = false;
  for (const key of MANAGED_ENV_KEYS) {
    if (Object.prototype.hasOwnProperty.call(settings.env, key)) {
      delete settings.env[key];
      changed = true;
    }
  }
  if (!changed) return;
  if (Object.keys(settings.env).length === 0) delete settings.env;
  writePrivateFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
}

function normalizeHttpsUrl(value, name) {
  let url;
  try {
    url = new URL(String(value || ''));
  } catch {
    throw new Error(`${name} must be a valid HTTPS URL.`);
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error(`${name} must be an HTTPS origin without credentials, query, or fragment.`);
  }
  return url.toString().replace(/\/$/, '');
}

function appendBounded(current, chunk) {
  const value = `${current}${String(chunk)}`;
  return value.length > MAX_COMMAND_OUTPUT_BYTES
    ? value.slice(value.length - MAX_COMMAND_OUTPUT_BYTES)
    : value;
}

export function runCommand(command, args, options = {}) {
  return new Promise((resolve) => {
    const usesProcessGroup = process.platform !== 'win32';
    const child = spawn(command, args, {
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      // iClaude may launch a provider-owned child which inherits these pipes.
      // Give the command its own process group so a timeout cannot leave that
      // child alive and keep the initializer waiting forever for pipe closure.
      detached: usesProcessGroup,
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let killTimer;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve(result);
    };
    const terminate = (signal) => {
      try {
        if (usesProcessGroup && Number.isInteger(child.pid)) {
          process.kill(-child.pid, signal);
        } else {
          child.kill(signal);
        }
      } catch (error) {
        if (error?.code !== 'ESRCH') {
          try {
            child.kill(signal);
          } catch {
            // The close/error event remains the single settlement authority.
          }
        }
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminate('SIGTERM');
      killTimer = setTimeout(() => {
        terminate('SIGKILL');
      }, options.killGraceMs ?? ICLAUDE_COMMAND_KILL_GRACE_MS);
    }, options.timeoutMs ?? ICLAUDE_COMMAND_TIMEOUT_MS);
    child.stdout.on('data', (chunk) => { stdout = appendBounded(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = appendBounded(stderr, chunk); });
    child.on('error', (error) => {
      finish({ status: null, stdout, stderr, error, timedOut });
    });
    child.on('close', (status) => {
      finish({ status, stdout, stderr, error: null, timedOut });
    });
    child.stdin.end(options.input || '');
  });
}

function sanitizedIClaudeEnvironment(environment) {
  const childEnvironment = { ...environment };
  for (const key of [
    ...MANAGED_ENV_KEYS,
    'CLAUDE_PROXY_TOKEN',
    'ICLAUDE_PASSWORD',
    'ICLAUDE_PASSWORD_FILE',
  ]) {
    delete childEnvironment[key];
  }
  return childEnvironment;
}

function lstatIfPresent(pathname) {
  try {
    return fs.lstatSync(pathname);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function resolvedLinkTarget(pathname) {
  return path.resolve(path.dirname(pathname), fs.readlinkSync(pathname));
}

function nextPreSharePath(pathname) {
  for (let suffix = 1; suffix < 10_000; suffix += 1) {
    const candidate = `${pathname}.pre-share${suffix === 1 ? '' : `.${suffix}`}`;
    if (!lstatIfPresent(candidate)) return candidate;
  }
  throw new Error(`Could not reserve a migration backup for ${path.basename(pathname)}.`);
}

// Copy only paths which are absent from the active tree. Existing paths win,
// while the complete pre-share tree remains in place for a later manual audit.
// This makes recovery idempotent and never discards a conflicting session file.
function mergeMissingTree(sourcePath, targetPath) {
  const source = lstatIfPresent(sourcePath);
  if (!source) return;
  const target = lstatIfPresent(targetPath);
  if (!target) {
    fs.cpSync(sourcePath, targetPath, {
      recursive: source.isDirectory(),
      dereference: false,
      errorOnExist: true,
      force: false,
      preserveTimestamps: true,
    });
    return;
  }
  if (!source.isDirectory() || !target.isDirectory()) return;
  for (const entry of fs.readdirSync(sourcePath)) {
    mergeMissingTree(path.join(sourcePath, entry), path.join(targetPath, entry));
  }
}

function recoverSharedSessionDirectory(claudeDir, name) {
  const sessionPath = path.join(claudeDir, name);
  const stat = lstatIfPresent(sessionPath);
  let repaired = false;
  if (stat?.isSymbolicLink() && resolvedLinkTarget(sessionPath) === sessionPath) {
    // The old whole-directory link made iClaude turn this into `path -> path`.
    // Removing the link never removes its target because the target is itself.
    fs.unlinkSync(sessionPath);
    repaired = true;
  }

  const current = lstatIfPresent(sessionPath);
  if (!current) {
    fs.mkdirSync(sessionPath, { recursive: true, mode: 0o700 });
  } else if (!current.isDirectory() && !current.isSymbolicLink()) {
    throw new Error(`Claude ${name} path must be a directory.`);
  }

  // iClaude preserves a destination before replacing it with a shared link.
  // The self-link bug placed those backups in ~/.claude. Recover every missing
  // file into the active tree but retain each backup as the lossless authority.
  for (const entry of fs.readdirSync(claudeDir)) {
    if (entry === `${name}.pre-share` || entry.startsWith(`${name}.pre-share.`)) {
      mergeMissingTree(path.join(claudeDir, entry), sessionPath);
    }
  }
  return repaired;
}

function ensureSharedConfigLink(managedConfigPath, claudeDir, name, type) {
  const managedPath = path.join(managedConfigPath, name);
  const sharedPath = path.join(claudeDir, name);
  if (type === 'directory') {
    fs.mkdirSync(sharedPath, { recursive: true, mode: 0o700 });
  } else {
    fs.mkdirSync(path.dirname(sharedPath), { recursive: true, mode: 0o700 });
  }

  const managed = lstatIfPresent(managedPath);
  if (managed?.isSymbolicLink() && resolvedLinkTarget(managedPath) === sharedPath) return false;

  if (managed) {
    const shared = lstatIfPresent(sharedPath);
    if (!shared) {
      fs.renameSync(managedPath, sharedPath);
    } else {
      if (managed.isDirectory() && shared.isDirectory()) {
        mergeMissingTree(managedPath, sharedPath);
      }
      // Preserve a populated or unexpected entry before installing the stable
      // link. Conflicting content remains available under its pre-share name.
      fs.renameSync(managedPath, nextPreSharePath(managedPath));
    }
  }
  fs.symlinkSync(sharedPath, managedPath, type === 'directory' ? 'dir' : 'file');
  return Boolean(managed);
}

function ensureSharedClaudeConfig(home) {
  const claudeDir = path.join(home, '.claude');
  const managedRoot = path.join(home, '.local', 'share', 'iclaude');
  const managedConfigPath = path.join(managedRoot, 'claude-config');
  const migrationMarkerPath = path.join(managedRoot, ICLAUDE_CONFIG_MIGRATION_MARKER);
  fs.mkdirSync(claudeDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(claudeDir, 0o700);
  fs.mkdirSync(managedRoot, { recursive: true, mode: 0o700 });
  let loginRequired = Boolean(lstatIfPresent(migrationMarkerPath));

  const stat = lstatIfPresent(managedConfigPath);
  if (stat) {
    if (stat.isSymbolicLink()) {
      const resolvedTarget = resolvedLinkTarget(managedConfigPath);
      if (resolvedTarget !== claudeDir) {
        throw new Error('iClaude config link points outside the tenant Claude home.');
      }
      // iClaude itself links selected entries from this directory to ~/.claude.
      // Linking the directory wholesale therefore creates `entry -> entry`.
      fs.unlinkSync(managedConfigPath);
      fs.mkdirSync(managedConfigPath, { mode: 0o700 });
      loginRequired = true;
    } else if (!stat.isDirectory()) {
      throw new Error('iClaude config path must be a directory.');
    } else {
      fs.chmodSync(managedConfigPath, 0o700);
    }
  } else {
    fs.mkdirSync(managedConfigPath, { mode: 0o700 });
    loginRequired = true;
  }

  for (const name of ICLAUDE_SHARED_SESSION_DIRS) {
    if (recoverSharedSessionDirectory(claudeDir, name)) loginRequired = true;
    if (ensureSharedConfigLink(managedConfigPath, claudeDir, name, 'directory')) {
      loginRequired = true;
    }
  }
  for (const { name, type } of ICLAUDE_SHARED_PREFERENCES) {
    if (ensureSharedConfigLink(managedConfigPath, claudeDir, name, type)) {
      loginRequired = true;
    }
  }

  // A normal Claude login token may exist in ~/.claude/.credentials.json.
  // Never make it visible through iClaude's isolated CLAUDE_CONFIG_DIR. A
  // previously linked credential is detached without touching its target.
  const managedCredentialPath = path.join(managedConfigPath, '.credentials.json');
  const managedCredential = lstatIfPresent(managedCredentialPath);
  if (managedCredential?.isSymbolicLink()) {
    fs.unlinkSync(managedCredentialPath);
    loginRequired = true;
  }

  if (loginRequired) {
    writePrivateFile(migrationMarkerPath, `${JSON.stringify({
      version: 1,
      reason: 'claude-config-migration',
    })}\n`);
  }
  return { managedConfigPath, migrationMarkerPath, loginRequired };
}

function readPasswordFile(passwordPath) {
  if (!path.isAbsolute(passwordPath)) throw new Error('ICLAUDE_PASSWORD_FILE must be an absolute path.');
  const stat = fs.statSync(passwordPath);
  if (!stat.isFile()) throw new Error('ICLAUDE_PASSWORD_FILE must point to a regular file.');
  if ((stat.mode & 0o007) !== 0) throw new Error('ICLAUDE_PASSWORD_FILE must not be readable by other users.');
  if (stat.size < 1 || stat.size > 4096) throw new Error('ICLAUDE_PASSWORD_FILE has an invalid size.');
  const password = fs.readFileSync(passwordPath, 'utf8').replace(/\r?\n$/, '');
  if (!password || password.includes('\0')) throw new Error('ICLAUDE_PASSWORD_FILE is empty or invalid.');
  return password;
}

function commandFailureText(result) {
  if (result.timedOut) return 'iClaude command timed out.';
  if (result.error) return result.error.message;
  return `${result.stderr || result.stdout || 'iClaude command failed.'}`.trim();
}

export function friendlyIClaudeError(error) {
  const message = String(error?.message || error || '');
  if (/device limit reached|removed from your devices/i.test(message)) {
    return 'ظرفیت دستگاه‌های حساب تیم تکمیل شده است؛ مدیر حساب باید یک دستگاه قدیمی را حذف کند.';
  }
  if (/limit reached|usage limit|resets? in/i.test(message)) {
    return 'سقف استفادهٔ حساب تیم به پایان رسیده است؛ پس از زمان بازنشانی دوباره تلاش کنید.';
  }
  if (/sign-in is no longer valid|not signed in|setup incomplete|reconnect this computer/i.test(message)) {
    return 'ورود حساب تیم منقضی یا ناقص است؛ راه‌اندازی iClaude باید توسط مدیر سرویس تمدید شود.';
  }
  if (/binary updated|please run iclaude again/i.test(message)) {
    return 'iClaude به‌روزرسانی شد؛ راه‌اندازی را یک بار دیگر اجرا کنید.';
  }
  if (/connect|network|timeout|timed out|update check failed/i.test(message)) {
    return 'ارتباط با سرویس iClaude برقرار نشد؛ اتصال شبکه و وضعیت سرویس را بررسی کنید.';
  }
  return 'راه‌اندازی حساب تیم Claude ناموفق بود.';
}

function extractClaudeVersion(result) {
  const text = `${result.stdout}\n${result.stderr}`;
  return text.match(/\b(\d+\.\d+\.\d+)\s*\(Claude Code\)/)?.[1] || null;
}

function desiredIdentitySha256(serverUrl, username) {
  return crypto.createHash('sha256').update(`${new URL(serverUrl).origin}\0${username}`).digest('hex');
}

function readIClaudeConfig(pathname) {
  const config = readSettings(pathname);
  return {
    serverOrigin: normalizeHttpsUrl(config.server_url, 'iClaude saved server'),
    username: typeof config.user_name === 'string' ? config.user_name.trim() : '',
  };
}

function assertIClaudeIdentity(configPath, serverUrl, expectedIdentitySha256, username = '') {
  const config = readIClaudeConfig(configPath);
  const identity = desiredIdentitySha256(config.serverOrigin, config.username);
  if (!config.username
      || config.serverOrigin !== new URL(serverUrl).origin
      || identity !== expectedIdentitySha256
      || (username && config.username !== username)) {
    throw new Error('iClaude saved account does not match the managed-team identity.');
  }
  return identity;
}

function sha256File(pathname) {
  return crypto.createHash('sha256').update(fs.readFileSync(pathname)).digest('hex');
}

async function initializeIClaude(environment, paths, dependencies) {
  const iclaudePath = environment.ICLAUDE_BOOTSTRAP_PATH || DEFAULT_ICLAUDE_PATH;
  const serverUrl = normalizeHttpsUrl(
    environment.ICLAUDE_SERVER_URL || DEFAULT_ICLAUDE_SERVER_URL,
    'ICLAUDE_SERVER_URL',
  );
  const username = String(environment.ICLAUDE_USERNAME || '').trim();
  const passwordPath = String(environment.ICLAUDE_PASSWORD_FILE || '').trim();
  const phase = String(environment.ICLAUDE_SETUP_PHASE || (
    environment.ICLAUDE_BOOTSTRAPPED_BY_INIT === '1' ? 'runtime' : 'combined'
  ));
  const configHome = environment.XDG_CONFIG_HOME || path.join(paths.home, '.config');
  const configPath = path.join(configHome, 'iclaude', 'config.json');
  const attestationPath = String(environment.ICLAUDE_ATTESTATION_PATH || paths.iclaudeMarkerPath);
  const execute = dependencies.runCommand || runCommand;
  const childEnvironment = sanitizedIClaudeEnvironment(environment);

  if (!fs.existsSync(iclaudePath)) throw new Error('The pinned iClaude bootstrap CLI is not installed.');
  if (!['login', 'verify', 'runtime', 'combined'].includes(phase)) {
    throw new Error('ICLAUDE_SETUP_PHASE must be login, verify, runtime, or combined.');
  }

  const expectedIdentity = String(environment.ICLAUDE_IDENTITY_SHA256 || (
    username ? desiredIdentitySha256(serverUrl, username) : ''
  ));
  const credentialRevision = String(environment.ICLAUDE_CREDENTIAL_REVISION || '').trim();
  if (!/^[a-f0-9]{64}$/.test(expectedIdentity)) {
    throw new Error('ICLAUDE_IDENTITY_SHA256 is required and must be a SHA-256 digest.');
  }
  if (!/^[a-f0-9]{32,64}$/.test(credentialRevision)) {
    throw new Error('ICLAUDE_CREDENTIAL_REVISION is required and must be a lowercase hex revision.');
  }

  // The application container reads an EmptyDir attestation mounted read-only.
  // The tenant-writable PVC marker is only an operations record and cannot by
  // itself authorize the managed-team route.
  if (phase === 'runtime') {
    const marker = readMarker(attestationPath);
    if (marker.mode !== 'managed_team'
        || marker.provider !== 'iclaude'
        || marker.serverOrigin !== new URL(serverUrl).origin
        || marker.identitySha256 !== expectedIdentity
        || marker.credentialRevision !== credentialRevision
        || typeof marker.verifiedAt !== 'string'
        || !/^\d+\.\d+\.\d+$/.test(marker.claudeCodeVersion || '')) {
      throw new Error('iClaude init-container attestation is missing or invalid.');
    }
    assertIClaudeIdentity(configPath, serverUrl, expectedIdentity);
    return {
      initialized: true,
      managedByTenant: false,
      provider: 'iclaude',
      ...marker,
    };
  }

  const sharedConfig = ensureSharedClaudeConfig(paths.home);
  if (!username || username.length > 200 || /[\r\n]/.test(username)) {
    throw new Error('ICLAUDE_USERNAME is required and must be a single line.');
  }
  if (phase === 'verify' && sharedConfig.loginRequired) {
    throw new Error('iClaude team login is required after Claude config migration.');
  }

  // Reconcile only a changed credential revision or account identity. A pod
  // replacement with the same Secret still verifies the provider below, but
  // does not consume another device registration. The login receipt is not a
  // runtime authority: it is tenant-writable and is accepted here only beside
  // a matching saved account; verify/runtime rely on the pod attestation.
  if (phase === 'login' || phase === 'combined') {
    const receipts = [
      readMarker(paths.iclaudeLoginReceiptPath),
      readMarker(paths.iclaudeMarkerPath),
    ];
    const revisionAlreadyApplied = receipts.some((receipt) => (
      receipt.provider === 'iclaude'
      && receipt.serverOrigin === new URL(serverUrl).origin
      && receipt.identitySha256 === expectedIdentity
      && receipt.credentialRevision === credentialRevision
    ));
    let savedIdentityMatches = false;
    try {
      assertIClaudeIdentity(configPath, serverUrl, expectedIdentity, username);
      savedIdentityMatches = true;
    } catch {
      // A missing/mismatched provider config is repaired by login below.
    }

    const loginPerformed = sharedConfig.loginRequired || !savedIdentityMatches || !revisionAlreadyApplied;
    if (loginPerformed) {
      if (!passwordPath) throw new Error('ICLAUDE_PASSWORD_FILE is required during iClaude login.');
      const password = readPasswordFile(passwordPath);
      const login = await execute(
        iclaudePath,
        ['login', '--server', serverUrl, '--username', username, '--password-stdin'],
        { env: childEnvironment, input: `${password}\n` },
      );
      if (login.status !== 0) throw new Error(friendlyIClaudeError(commandFailureText(login)));
      assertIClaudeIdentity(configPath, serverUrl, expectedIdentity, username);
      fs.rmSync(sharedConfig.migrationMarkerPath, { force: true });
      writePrivateFile(paths.iclaudeLoginReceiptPath, `${JSON.stringify({
        mode: 'managed_team_login',
        provider: 'iclaude',
        serverOrigin: new URL(serverUrl).origin,
        identitySha256: expectedIdentity,
        credentialRevision,
        loginAppliedAt: new Date().toISOString(),
      }, null, 2)}\n`);
    }
    if (phase === 'login') {
      return {
        initialized: true,
        managedByTenant: false,
        provider: 'iclaude',
        phase: 'login',
        loginPerformed,
      };
    }
  }

  assertIClaudeIdentity(configPath, serverUrl, expectedIdentity, username);
  const verification = await execute(iclaudePath, ['run', '--version'], { env: childEnvironment });
  if (verification.status !== 0) throw new Error(friendlyIClaudeError(commandFailureText(verification)));
  const claudeCodeVersion = extractClaudeVersion(verification);
  if (!claudeCodeVersion) {
    throw new Error('iClaude verification did not report a valid Claude Code version.');
  }

  // A successful managed-team verification is the authority switch. Only now
  // remove legacy Anthropic/proxy values so a failed bootstrap can never break
  // the tenant's previously working Claude connection.
  removeProxySettings(paths.settingsPath);
  fs.rmSync(paths.markerPath, { force: true });
  const status = {
    mode: 'managed_team',
    provider: 'iclaude',
    serverOrigin: new URL(serverUrl).origin,
    identitySha256: expectedIdentity,
    credentialRevision,
    bootstrapSha256: sha256File(iclaudePath),
    claudeCodeVersion,
    verifiedAt: new Date().toISOString(),
  };
  writePrivateFile(paths.iclaudeMarkerPath, `${JSON.stringify(status, null, 2)}\n`);
  if (attestationPath !== paths.iclaudeMarkerPath) {
    writePrivateFile(attestationPath, `${JSON.stringify(status, null, 2)}\n`);
  }
  return { initialized: true, managedByTenant: false, provider: 'iclaude', ...status };
}

export async function initializeClaudeProvider(environment = process.env, dependencies = {}) {
  // This initializer reconciles a SaaS tenant's platform-managed Claude Code
  // credential only. Never let a host-side local launcher apply that policy to
  // a developer's personal Claude home.
  if (environment.CLOUDCLI_TENANT_MODE !== '1') {
    return { initialized: false, tenantMode: false };
  }

  const home = environment.HOME || os.homedir();
  const claudeDir = path.join(home, '.claude');
  const paths = {
    home,
    claudeDir,
    settingsPath: path.join(claudeDir, 'settings.json'),
    markerPath: path.join(claudeDir, '.cloudcli-claude-user-managed-auth'),
    iclaudeMarkerPath: path.join(home, '.cloudcli', 'iclaude-managed.json'),
    iclaudeLoginReceiptPath: path.join(home, '.cloudcli', 'iclaude-login.json'),
  };
  const authMode = environment.CLAUDE_AUTH_MODE || 'byok';
  const token = environment.CLAUDE_PROXY_TOKEN || '';
  // Claude Code appends its own paths to ANTHROPIC_BASE_URL, so a trailing
  // slash from the Secret must never double up the resulting request URLs.
  const baseUrl = (environment.CLAUDE_PROXY_BASE_URL || DEFAULT_PROXY_BASE_URL).replace(/\/+$/, '');

  if (!['byok', 'proxy', 'iclaude'].includes(authMode)) {
    throw new Error('CLAUDE_AUTH_MODE must be byok, proxy, or iclaude.');
  }
  if (!/^https:\/\/\S+$/.test(baseUrl)) {
    throw new Error('CLAUDE_PROXY_BASE_URL must be an HTTPS URL without whitespace.');
  }

  fs.mkdirSync(claudeDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(claudeDir, 0o700);

  if (authMode === 'iclaude') {
    return initializeIClaude(environment, paths, dependencies);
  }

  fs.rmSync(paths.iclaudeMarkerPath, { force: true });

  // A credential explicitly changed inside the tenant always wins across
  // restarts. Platform-managed invite credentials are reconciled from the
  // tenant Secret so a controlled rotation can take effect on restart.
  const marker = readMarker(paths.markerPath);
  if (marker.managedBy === 'tenant') return { initialized: false, managedByTenant: true };

  if (authMode === 'proxy') {
    if (!token) throw new Error('CLAUDE_PROXY_TOKEN is required in proxy mode.');
    applyProxySettings(paths.settingsPath, token, baseUrl);
    writePrivateFile(paths.markerPath, `${JSON.stringify({
      managedBy: 'platform',
      provider: 'hooshcode',
      target: 'claude',
    })}\n`);
    return { initialized: true, managedByTenant: false, provider: 'hooshcode' };
  }

  // BYOK removes an inherited platform credential but never touches the
  // customer's own Claude login state or a tenant-managed settings marker.
  removeProxySettings(paths.settingsPath);
  fs.rmSync(paths.markerPath, { force: true });
  return { initialized: true, managedByTenant: false, provider: 'anthropic' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await initializeClaudeProvider();
  if (result.provider === 'iclaude') {
    console.log(JSON.stringify({
      claudeProvider: 'iclaude',
      status: 'ready',
      claudeCodeVersion: result.claudeCodeVersion,
      bootstrapSha256: result.bootstrapSha256,
    }));
  }
}
