import './browser-env.js';
import express, { type Request, type Response } from 'express';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';

type SessionStatus = 'ready' | 'stopped' | 'unavailable';

type BrowserSession = {
  id: string;
  status: SessionStatus;
  url: string | null;
  title: string | null;
  screenshotDataUrl: string | null;
  createdAt: string;
  updatedAt: string;
  lastAction: string | null;
  message: string | null;
  viewport: { width: number; height: number } | null;
  cursor: { x: number; y: number } | null;
  browser?: Browser;
  context?: BrowserContext;
  page?: Page;
};

type Point = { x: number; y: number };

type ElementInfo = {
  tagName: string;
  id: string | null;
  className: string | null;
  role: string | null;
  ariaLabel: string | null;
  text: string;
  rect: Point & { width: number; height: number };
};

const HOST = '127.0.0.1';
const PORT = Number(process.env.BROWSER_FEEDBACK_PORT || 0);
const MAX_SESSIONS = 3;
const SESSION_TTL_MS = 30 * 60 * 1000;
const PORT_FILE = path.join(os.homedir(), '.claude-code-ui', 'browser-feedback-server.json');
const sessions = new Map<string, BrowserSession>();
const pluginDirectory = path.dirname(fileURLToPath(import.meta.url));
const playwrightCli = path.join(pluginDirectory, '..', 'node_modules', '.bin', process.platform === 'win32' ? 'playwright.cmd' : 'playwright');
let installPromise: Promise<{ success: boolean; message: string }> | null = null;

function now(): string {
  return new Date().toISOString();
}

// The CloudCLI host starts this server on an ephemeral loopback port that is
// not otherwise visible to tenant shells. Publish the port at a fixed path so
// agent CLIs running in the same tenant can drive the shared browser sessions
// non-interactively. Readers should confirm the port via GET /status because a
// hard kill can leave a stale file behind.
function writePortFile(port: number): void {
  try {
    fs.mkdirSync(path.dirname(PORT_FILE), { recursive: true });
    fs.writeFileSync(
      PORT_FILE,
      `${JSON.stringify({ plugin: 'cloudcli-browser-feedback', pid: process.pid, port, startedAt: now() })}\n`,
    );
  } catch (error) {
    process.stderr?.write(`browser-feedback: could not publish the server port file: ${readError(error)}\n`);
  }
}

function removePortFile(): void {
  try {
    fs.unlinkSync(PORT_FILE);
  } catch {
    // The file is already absent.
  }
}

function publicSession(session: BrowserSession): Omit<BrowserSession, 'browser' | 'context' | 'page'> {
  const { browser: _browser, context: _context, page: _page, ...value } = session;
  return value;
}

// Immutable tenant images ship the lighter Chromium headless shell (the binary
// headless launches use) instead of the full Chromium build, so a present
// headless shell also counts as an installed runtime.
function chromiumExecutable(): string | undefined {
  try {
    const executable = chromium.executablePath();
    if (fs.existsSync(executable)) return executable;
  } catch {
    // registry path unavailable; fall through to the headless shell scan
  }
  const browsersPath = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!browsersPath) return undefined;
  try {
    for (const entry of fs.readdirSync(browsersPath)) {
      if (!entry.startsWith('chromium_headless_shell-')) continue;
      const shell = path.join(browsersPath, entry, 'chrome-headless-shell-linux64', 'chrome-headless-shell');
      if (fs.existsSync(shell)) return shell;
    }
  } catch {
    // browsers path is not a readable directory
  }
  return undefined;
}

function runtimeStatus(): { playwrightInstalled: boolean; chromiumInstalled: boolean; message: string } {
  const chromiumInstalled = Boolean(chromiumExecutable());
  if (!chromiumInstalled) {
    return {
      playwrightInstalled: true,
      chromiumInstalled: false,
      message: 'Install the Chromium browser runtime to open pages.',
    };
  }

  return {
    playwrightInstalled: true,
    chromiumInstalled: true,
    message: 'Browser runtime is ready.',
  };
}

function readError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function runInstallCommand(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(playwrightCli)) {
      reject(new Error(`Playwright CLI was not found at ${playwrightCli}.`));
      return;
    }

    const child = spawn(playwrightCli, ['install', 'chromium'], {
      cwd: pluginDirectory,
      env: process.env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const output: string[] = [];
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Chromium installation timed out after 10 minutes.'));
    }, 10 * 60 * 1000);
    timer.unref?.();
    child.stdout?.on('data', (chunk) => output.push(String(chunk)));
    child.stderr?.on('data', (chunk) => output.push(String(chunk)));
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(output.join('').trim() || `Chromium installation failed (exit code ${code}).`));
      }
    });
  });
}

async function installRuntime(): Promise<{ success: boolean; message: string }> {
  if (installPromise) return installPromise;
  installPromise = (async () => {
    try {
      await runInstallCommand();
      const status = runtimeStatus();
      if (!status.chromiumInstalled) throw new Error(status.message);
      return { success: true, message: 'Chromium browser runtime installed.' };
    } catch (error) {
      return { success: false, message: readError(error) };
    }
  })();
  try {
    return await installPromise;
  } finally {
    installPromise = null;
  }
}

function normalizeUrl(value: unknown): string {
  const input = String(value || '').trim();
  if (!input) throw new Error('URL is required.');
  const withProtocol = /^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(input) ? input : `https://${input}`;
  const url = new URL(withProtocol);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only http and https URLs are supported.');
  return url.toString();
}

function point(value: unknown, name: string): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error(`${name} must be a non-negative number.`);
  return number;
}

async function capture(session: BrowserSession): Promise<void> {
  if (!session.page) return;
  const screenshot = await session.page.screenshot({ type: 'jpeg', quality: 72, fullPage: false });
  session.screenshotDataUrl = `data:image/jpeg;base64,${Buffer.from(screenshot).toString('base64')}`;
  session.url = session.page.url() || session.url;
  session.title = await session.page.title().catch(() => null);
  session.viewport = session.page.viewportSize?.() || session.viewport;
  session.updatedAt = now();
}

async function closeSession(session: BrowserSession): Promise<void> {
  await session.context?.close().catch(() => undefined);
  await session.browser?.close().catch(() => undefined);
  session.context = undefined;
  session.browser = undefined;
  session.page = undefined;
}

async function expireSessions(): Promise<void> {
  const threshold = Date.now() - SESSION_TTL_MS;
  await Promise.all([...sessions.values()].map(async (session) => {
    if (session.status !== 'ready' || Date.parse(session.updatedAt) >= threshold) return;
    await closeSession(session);
    session.status = 'stopped';
    session.lastAction = 'expire';
    session.message = 'Browser session expired after inactivity.';
    session.updatedAt = now();
  }));
}

function getSession(id: string): BrowserSession {
  const session = sessions.get(id);
  if (!session) throw new Error('Browser session not found.');
  return session;
}

function getPage(session: BrowserSession): Page {
  if (session.status !== 'ready' || !session.page) throw new Error(session.message || 'Browser session is not ready.');
  return session.page;
}

async function inspect(page: Page, x: number, y: number): Promise<ElementInfo | null> {
  return page.evaluate(({ x: pointX, y: pointY }) => {
    const target = document.elementFromPoint(pointX, pointY);
    if (!target) return null;
    const rect = target.getBoundingClientRect();
    const className = typeof target.className === 'string'
      ? target.className
      : String((target.className as { baseVal?: string } | undefined)?.baseVal || '');
    const text = 'innerText' in target && typeof target.innerText === 'string'
      ? target.innerText
      : target.textContent || '';
    return {
      tagName: target.tagName.toLowerCase(),
      id: target.id || null,
      className: className.trim() || null,
      role: target.getAttribute('role'),
      ariaLabel: target.getAttribute('aria-label'),
      text: text.replace(/\s+/g, ' ').trim().slice(0, 1000),
      rect: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
    };
  }, { x, y }) as Promise<ElementInfo | null>;
}

function jsonError(res: Response, error: unknown, status = 400): void {
  res.status(status).json({ success: false, error: readError(error) });
}

const app = express();
app.use(express.json({ limit: '1mb' }));

app.get('/status', (_req, res) => {
  const runtime = runtimeStatus();
  res.json({
    success: true,
    data: {
      enabled: true,
      available: runtime.chromiumInstalled,
      ...runtime,
      installInProgress: Boolean(installPromise),
      sessionCount: sessions.size,
      message: runtime.message,
    },
  });
});

app.post('/runtime/install', async (_req, res) => {
  const result = await installRuntime();
  res.status(result.success ? 200 : 500).json({ success: result.success, data: result, error: result.success ? undefined : result.message });
});

app.get('/sessions', async (_req, res) => {
  await expireSessions();
  res.json({ success: true, data: { sessions: [...sessions.values()].map(publicSession) } });
});

app.post('/sessions', async (_req, res) => {
  await expireSessions();
  const active = [...sessions.values()].filter((session) => session.status === 'ready');
  if (active.length >= MAX_SESSIONS) {
    jsonError(res, new Error(`Browser is limited to ${MAX_SESSIONS} active sessions.`));
    return;
  }

  const id = crypto.randomUUID();
  const createdAt = now();
  const session: BrowserSession = {
    id,
    status: 'unavailable',
    url: null,
    title: null,
    screenshotDataUrl: null,
    createdAt,
    updatedAt: createdAt,
    lastAction: 'create',
    message: null,
    viewport: { width: 1440, height: 900 },
    cursor: null,
  };
  const runtime = runtimeStatus();
  if (!runtime.chromiumInstalled) {
    session.message = runtime.message;
    sessions.set(id, session);
    res.json({ success: true, data: publicSession(session) });
    return;
  }

  try {
    // The tenant container is the isolation boundary; the Kubernetes default
    // seccomp profile blocks the Chromium user-namespace sandbox, so the
    // browser itself runs unsandboxed inside that container.
    session.browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage', '--no-sandbox'] });
    session.context = await session.browser.newContext({
      viewport: { width: 1440, height: 900 },
      serviceWorkers: 'block',
    });
    session.page = await session.context.newPage();
    session.status = 'ready';
    session.message = 'Browser session is ready.';
    sessions.set(id, session);
    await capture(session);
    res.json({ success: true, data: publicSession(session) });
  } catch (error) {
    await closeSession(session);
    session.message = readError(error);
    sessions.set(id, session);
    jsonError(res, error, 500);
  }
});

app.post('/sessions/:id/navigate', async (req, res) => {
  try {
    const session = getSession(req.params.id);
    const page = getPage(session);
    const url = normalizeUrl(req.body?.url);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    session.lastAction = `navigate:${url}`;
    session.cursor = null;
    await capture(session);
    res.json({ success: true, data: publicSession(session) });
  } catch (error) { jsonError(res, error); }
});

app.post('/sessions/:id/click', async (req, res) => {
  try {
    const session = getSession(req.params.id);
    const page = getPage(session);
    const x = point(req.body?.x, 'x');
    const y = point(req.body?.y, 'y');
    await page.mouse.click(x, y);
    session.lastAction = 'click';
    session.cursor = { x, y };
    await capture(session);
    res.json({ success: true, data: publicSession(session) });
  } catch (error) { jsonError(res, error); }
});

app.post('/sessions/:id/scroll', async (req, res) => {
  try {
    const session = getSession(req.params.id);
    const page = getPage(session);
    const deltaX = Number(req.body?.deltaX || 0);
    const deltaY = Number(req.body?.deltaY || 0);
    if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY) || (deltaX === 0 && deltaY === 0)) {
      throw new Error('Provide a non-zero scroll amount.');
    }
    if (Math.abs(deltaX) > 3000 || Math.abs(deltaY) > 3000) throw new Error('Scroll amount is too large.');
    await page.mouse.wheel(deltaX, deltaY);
    session.lastAction = `scroll:${Math.round(deltaY)}`;
    session.cursor = null;
    await capture(session);
    res.json({ success: true, data: publicSession(session) });
  } catch (error) { jsonError(res, error); }
});

app.post('/sessions/:id/inspect', async (req, res) => {
  try {
    const session = getSession(req.params.id);
    const page = getPage(session);
    const x = point(req.body?.x, 'x');
    const y = point(req.body?.y, 'y');
    const element = await inspect(page, x, y);
    session.lastAction = `inspect:${Math.round(x)},${Math.round(y)}`;
    session.cursor = { x, y };
    await capture(session);
    res.json({ success: true, data: { session: publicSession(session), point: { x, y }, element } });
  } catch (error) { jsonError(res, error); }
});

app.post('/sessions/:id/type', async (req, res) => {
  try {
    const session = getSession(req.params.id);
    const page = getPage(session);
    const text = String(req.body?.text || '');
    if (!text) throw new Error('Text is required.');
    await page.keyboard.type(text);
    session.lastAction = 'type';
    await capture(session);
    res.json({ success: true, data: publicSession(session) });
  } catch (error) { jsonError(res, error); }
});

app.post('/sessions/:id/stop', async (req, res) => {
  try {
    const session = getSession(req.params.id);
    await closeSession(session);
    session.status = 'stopped';
    session.lastAction = 'stop';
    session.message = 'Browser session stopped. Create a new session to continue.';
    session.updatedAt = now();
    res.json({ success: true, data: { stopped: true, session: publicSession(session) } });
  } catch (error) { jsonError(res, error); }
});

app.delete('/sessions/:id', async (req, res) => {
  try {
    const session = getSession(req.params.id);
    await closeSession(session);
    sessions.delete(session.id);
    res.json({ success: true, data: { deleted: true, sessionId: session.id } });
  } catch (error) { jsonError(res, error); }
});

const server = app.listen(PORT, HOST, () => {
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : PORT;
  writePortFile(port);
  process.stdout.write(`${JSON.stringify({ ready: true, port })}\n`);
});

async function shutdown(): Promise<void> {
  removePortFile();
  await Promise.all([...sessions.values()].map(closeSession));
  server.close();
}

process.once('SIGTERM', () => { void shutdown(); });
process.once('SIGINT', () => { void shutdown(); });
