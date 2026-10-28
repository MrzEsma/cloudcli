import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function startPluginServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['dist/server.js'], {
      cwd: root,
      env: { ...process.env, BROWSER_FEEDBACK_PORT: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => reject(new Error(`Plugin server did not become ready. ${stderr}`)), 10_000);
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      const line = stdout.split('\n').find((value) => value.trim());
      if (!line) return;
      try {
        const ready = JSON.parse(line);
        if (ready.ready && ready.port) {
          clearTimeout(timer);
          resolve({ child, port: ready.port });
        }
      } catch { /* wait for a complete line */ }
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code && code !== 0) reject(new Error(`Plugin server exited with ${code}. ${stderr}`));
    });
  });
}

test('CloudCLI manifest and build artifacts are present', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  assert.equal(manifest.name, 'cloudcli-browser-feedback');
  assert.equal(manifest.slot, 'tab');
  assert.equal(manifest.entry, 'dist/index.js');
  assert.equal(manifest.server, 'dist/server.js');
  assert.ok(fs.existsSync(path.join(root, manifest.entry)));
  assert.ok(fs.existsSync(path.join(root, manifest.server)));
});

test('plugin backend opens, inspects, and closes a page', { timeout: 30_000 }, async (context) => {
  const pageServer = http.createServer((_request, response) => {
    response.setHeader('content-type', 'text/html');
    response.end('<!doctype html><button id="save" aria-label="Save changes">Save</button>');
  });
  await new Promise((resolve) => pageServer.listen(0, '127.0.0.1', resolve));
  context.after(() => new Promise((resolve) => pageServer.close(resolve)));
  const pageAddress = pageServer.address();
  assert.ok(pageAddress && typeof pageAddress === 'object');

  const plugin = await startPluginServer();
  context.after(() => plugin.child.kill('SIGTERM'));
  const base = `http://127.0.0.1:${plugin.port}`;
  const request = async (requestPath, options) => {
    const response = await fetch(`${base}/${requestPath}`, options);
    const body = await response.json();
    assert.equal(response.ok, true, body.error);
    assert.notEqual(body.success, false, body.error);
    return body.data;
  };

  const status = await request('status');
  assert.equal(status.playwrightInstalled, true);
  if (!status.chromiumInstalled) {
    context.skip('Chromium is not installed on this development host.');
    return;
  }

  const session = await request('sessions', { method: 'POST' });
  assert.equal(session.status, 'ready');
  const navigated = await request(`sessions/${session.id}/navigate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: `http://127.0.0.1:${pageAddress.port}` }),
  });
  assert.match(navigated.url, /^http:\/\/127\.0\.0\.1:/);
  const inspected = await request(`sessions/${session.id}/inspect`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ x: 30, y: 15 }),
  });
  assert.equal(inspected.element.tagName, 'button');
  assert.equal(inspected.element.id, 'save');
  assert.equal(inspected.element.ariaLabel, 'Save changes');
  const deleted = await request(`sessions/${session.id}`, { method: 'DELETE' });
  assert.equal(deleted.deleted, true);
});
