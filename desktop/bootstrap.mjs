#!/usr/bin/env node
/**
 * CloudCLI desktop bootstrap — one double-click, no Docker, no installs.
 *
 * Cross-platform (win32/darwin/linux) Node replacement of the Docker
 * `scripts/start-production.sh` for desktop bundles: prepares a portable
 * home/workspace inside the app folder, syncs plugins, writes defaults,
 * creates the first login, starts the server and opens the browser.
 * Closing this console window stops the app. All user data stays in
 * `<app>/data` and `<app>/workspace` — deleting the folder uninstalls.
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DESKTOP = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(DESKTOP);
const WIN = process.platform === 'win32';
const HOME = path.join(ROOT, 'data', 'home');
const WORKSPACE = path.join(ROOT, 'workspace');
const DATA = path.join(ROOT, 'data');
const LOGIN_FILE = path.join(DATA, 'LOGIN.txt');

const say = (line) => process.stdout.write(line + '\n');

function fail(message) {
    say('');
    say(`✖ ${message}`);
    say(WIN ? 'این پنجره را ببندید.' : 'Close this window.');
    if (WIN) {
        // Keep the console open long enough to read the error.
        process.stdin.setRawMode?.(false);
        setTimeout(() => process.exit(1), 60_000).unref();
    }
    process.exitCode = 1;
}

function syncDir(src, dst) {
    if (!fs.existsSync(src)) return;
    fs.rmSync(dst, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.cpSync(src, dst, { recursive: true });
}

function findFreePort(preferred) {
    return new Promise((resolve) => {
        const tryPort = (port, fallbackUsed) => {
            const server = net.createServer();
            server.once('error', () => {
                if (fallbackUsed) return resolve(null);
                tryPort(0, true);
            });
            server.listen(port, '127.0.0.1', () => {
                server.close(() => resolve(server.address().port));
            });
        };
        tryPort(preferred, false);
    });
}

function waitForServer(url, timeoutMs) {
    const startedAt = Date.now();
    return new Promise((resolve, reject) => {
        const attempt = () => {
            const request = http.get(url, (response) => {
                response.resume();
                if (response.statusCode && response.statusCode < 500) return resolve(true);
                retry();
            });
            request.on('error', retry);
            function retry() {
                request.destroy?.();
                if (Date.now() - startedAt > timeoutMs) {
                    return reject(new Error(`server did not answer at ${url} within ${Math.round(timeoutMs / 1000)}s`));
                }
                setTimeout(attempt, 400);
            }
        };
        attempt();
    });
}

function openBrowser(url) {
    try {
        if (WIN) {
            spawn('cmd.exe', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
        } else if (process.platform === 'darwin') {
            spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
        } else {
            spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
        }
    } catch {
        /* the URL is printed anyway */
    }
}

const CREDENTIALS_FILE = path.join(DATA, 'credentials.json');

function firstLogin(port) {
    // Generated once and reused; LOGIN.txt survives restarts so the user can
    // find it again. If they change the password inside the UI, both files
    // are stale — noted inside LOGIN.txt itself.
    try {
        const saved = JSON.parse(fs.readFileSync(CREDENTIALS_FILE, 'utf8'));
        if (saved && saved.username && saved.password) {
            return { username: saved.username, password: saved.password };
        }
    } catch { /* first run */ }
    const username = 'admin';
    const password = crypto.randomBytes(12).toString('base64url').replace(/[-_]/g, '').slice(0, 14) ||
        crypto.randomBytes(8).toString('hex');
    fs.mkdirSync(DATA, { recursive: true });
    fs.writeFileSync(CREDENTIALS_FILE, JSON.stringify({ username, password }, null, 2) + '\n', { mode: 0o600 });
    fs.writeFileSync(LOGIN_FILE, [
        'CloudCLI — اطلاعات ورود / Login',
        '=================================',
        '',
        `آدرس / Address:  http://127.0.0.1:${port}`,
        `نام کاربری / Username: ${username}`,
        `رمز عبور / Password: ${password}`,
        '',
        'این رمز فقط روی همین کامپیوتر شماست و در فایل‌های همین پوشه ذخیره شده.',
        'اگر داخل سایت رمز را عوض کردید، رمز جدید معتبر است و این فایل قدیمی می‌شود.',
        '',
        'This password exists only on this computer. If you change it inside',
        'the app, the new one applies and this file becomes outdated.',
        '',
    ].join('\n'), { mode: 0o600 });
    return { username, password };
}

function writeSonioxConfig() {
    const configDir = path.join(HOME, '.claude-code-ui');
    const configPath = path.join(configDir, 'soniox-config.json');
    const defaults = {
        apiKey: '',
        apiBaseUrl: 'https://api.soniox.com/v1',
        managed: false,
        model: process.env.SONIOX_MODEL || 'stt-async-v5',
        languageHints: ['fa'],
        httpsProxy: '',
        transcribeTimeoutMs: 120000,
        pollIntervalMs: 750,
    };
    let config = { ...defaults };
    try {
        config = { ...defaults, ...JSON.parse(fs.readFileSync(configPath, 'utf8')) };
    } catch {
        /* fresh install */
    }
    config.model = process.env.SONIOX_MODEL || defaults.model;
    if (process.env.SONIOX_API_KEY) config.apiKey = process.env.SONIOX_API_KEY;
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
}

async function runInit(script, env) {
    const file = path.join(ROOT, 'scripts', script);
    if (!fs.existsSync(file)) return;
    const result = spawn(process.execPath, [file], {
        env,
        stdio: ['ignore', 'inherit', 'inherit'],
        cwd: ROOT,
    });
    return new Promise((resolve) => result.once('exit', (code) => resolve(code ?? 0)));
}

async function main() {
    say('─'.repeat(52));
    say('  CloudCLI');
    say('  چت هوشمند خصوصی روی کامپیوتر خودتان / Private AI chat on your PC');
    say('─'.repeat(52));

    const nodeModules = path.join(ROOT, 'node_modules');
    const cliEntry = path.join(nodeModules, '@cloudcli-ai', 'cloudcli', 'dist-server', 'server', 'cli.js');
    if (!fs.existsSync(cliEntry)) {
        return fail('برنامه ناقص است؛ کل پوشه را دوباره استخراج کنید / Broken install — re-extract the whole folder.');
    }

    const port = (await findFreePort(Number(process.env.SERVER_PORT) || 3001)) || 0;
    if (!port) return fail('پورت آزاد پیدا نشد / No free port');
    const sonioxPort = await findFreePort(3002);

    // --- environment for the server and every child it spawns ---
    const env = { ...process.env };
    env.HOME = HOME;
    if (WIN) {
        env.USERPROFILE = HOME;
        // Bundled portable git (agent shell tools) — prepend, never replace.
        const gitBin = [path.join(ROOT, 'runtime', 'git', 'cmd'), path.join(ROOT, 'runtime', 'git', 'bin')];
        const bash = [path.join(ROOT, 'runtime', 'git', 'bin', 'bash.exe'),
            path.join(ROOT, 'runtime', 'git', 'usr', 'bin', 'bash.exe')]
            .find((candidate) => fs.existsSync(candidate));
        if (bash) env.CLAUDE_CODE_GIT_BASH_PATH = bash;
        env.PATH = [...gitBin, path.join(ROOT, 'runtime'),
            path.join(nodeModules, '.bin'), env.PATH].join(path.delimiter);
    } else {
        env.PATH = [path.join(ROOT, 'runtime', 'bin'),
            path.join(nodeModules, '.bin'), env.PATH].join(path.delimiter);
    }
    env.HOST = '127.0.0.1';                 // desktop listens locally only
    env.SERVER_PORT = String(port);
    env.PORT = String(port);
    env.DATABASE_PATH = path.join(HOME, '.cloudcli', 'auth.db');
    env.CLOUDCLI_WORKSPACE = WORKSPACE;
    env.SONIOX_ADAPTER_HOST = '127.0.0.1';
    env.SONIOX_ADAPTER_PORT = String(sonioxPort);
    env.VOICE_API_BASE_URL = `http://127.0.0.1:${sonioxPort}/v1`;
    env.VOICE_STT_MODEL = env.VOICE_STT_MODEL || 'stt-async-v5';
    env.VOICE_TIMEOUT_MS = env.VOICE_TIMEOUT_MS || '120000';
    env.CLAUDE_CLI_PATH = env.CLAUDE_CLI_PATH || path.join(nodeModules, '.bin', WIN ? 'claude.cmd' : 'claude');
    // codex-sdk spawns the binary directly (no shell), so on Windows it must
    // resolve the real codex.exe itself — a .cmd shim would fail to spawn.
    if (!WIN) {
        env.CLOUDCLI_CODEX_PATH = env.CLOUDCLI_CODEX_PATH || path.join(nodeModules, '.bin', 'codex');
        env.CODEX_CLI_PATH = env.CLOUDCLI_CODEX_PATH;
    }
    env.DISABLE_AUTOUPDATER = '1';   // keep the bundled claude-code version pinned

    // --- home skeleton (mirrors scripts/start-production.sh) ---
    const pluginsHome = path.join(HOME, '.claude-code-ui', 'plugins');
    for (const dir of [
        pluginsHome,
        path.join(HOME, '.cloudcli'),
        path.join(HOME, '.codex'),
        path.join(HOME, '.claude'),
        path.join(HOME, '.claude', 'skills'),
        path.join(HOME, '.codex', 'skills'),
        WORKSPACE,
    ]) {
        fs.mkdirSync(dir, { recursive: true });
    }

    say('• آماده‌سازی پلاگین‌ها / preparing plugins …');
    const pluginMap = [
        ['cloudcli-plugin-soniox', 'cloudcli-plugin-soniox'],
        ['cloudcli-plugin-openai-setup', 'cloudcli-plugin-openai-setup'],
        ['cloudcli-plugin-browser-feedback', 'cloudcli-browser-feedback'],
        ['cloudcli-plugin-cron', 'cloudcli-cron'],
        ['cloudcli-plugin-terminal', 'cloudcli-plugin-terminal'],
    ];
    for (const [src, name] of pluginMap) {
        syncDir(path.join(ROOT, src), path.join(pluginsHome, name));
    }
    const skillSrc = path.join(ROOT, 'tenant-agent-skills', 'browser-feedback');
    for (const skillRoot of [
        path.join(HOME, '.claude', 'skills'),
        path.join(HOME, '.codex', 'skills'),
    ]) {
        syncDir(skillSrc, path.join(skillRoot, 'browser-feedback'));
    }

    writeSonioxConfig();
    // BYOK defaults: both initializers no-op outside tenant mode.
    await runInit('init-codex-provider.mjs', env);
    await runInit('init-claude-provider.mjs', env);

    say('• ساخت کاربر اول / creating your first login …');
    const { username, password } = firstLogin(port);
    env.CLOUDCLI_ADMIN_USERNAME = username;
    env.CLOUDCLI_ADMIN_PASSWORD = password;
    await runInit('init-cloudcli-admin.mjs', env);
    await runInit('init-default-project.mjs', env);

    say(`• روشن کردن سرور / starting server on port ${port} …`);
    const server = spawn(process.execPath, [cliEntry, 'start', '--port', String(port)], {
        env,
        stdio: ['ignore', 'inherit', 'inherit'],
        cwd: ROOT,
    });

    const shutdown = () => {
        try { server.kill(WIN ? undefined : 'SIGTERM'); } catch { /* already gone */ }
        setTimeout(() => process.exit(server.exitCode ?? 0), 300).unref();
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    server.once('exit', (code) => {
        say('');
        say(`▪ سرور خاموش شد / server stopped (code ${code ?? 0}).`);
        process.exit(code ?? 0);
    });

    const url = `http://127.0.0.1:${port}`;
    try {
        await waitForServer(url, 180_000);
    } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
    }

    openBrowser(url);
    say('');
    say('✔ آماده است / Ready!');
    say(`  آدرس / Address:  ${url}`);
    say(`  نام کاربری / Username: ${username}`);
    say(`  رمز / Password:  ${password}   (همین رمز در فایل LOGIN.txt هم هست)`);
    say('');
    say('  برای استفاده از کلاد: در سایت، Settings → Claude → Sign in');
    say('  To chat with Claude: in the app, Settings → Claude → Sign in.');
    say('');
    say('  ⚠ برای خاموش کردن برنامه، همین پنجره را ببندید.');
    say('  ⚠ To stop the app, close this window.');
    say('─'.repeat(52));
}

main().catch((error) => fail(error instanceof Error ? error.stack || error.message : String(error)));
