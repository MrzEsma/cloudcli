/**
 * Verifies the Windows branch of the interactive-runtime spawn without a
 * Windows machine: structure of the patched overlay + cli.js resolution on a
 * synthetic tree. Run: node desktop/test/claude-spawn.test.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const overlay = fs.readFileSync(
    path.join(ROOT, 'cloudcli-overlay', 'package', 'dist-server', 'server', 'claude-interactive.js'),
    'utf8');

// 1. structure: posix path untouched, win32 branch exists and uses argv
assert(overlay.includes(`pty.spawn('bash', ['-c', claudeCommand]`), 'posix bash spawn must stay');
assert(overlay.includes("process.platform === 'win32'"), 'win32 branch missing');
assert(overlay.includes('resolveTuiClaudeScript()'), 'cli.js resolver missing');
assert(overlay.includes('[claudeScript, ...claudeArgs]'), 'argv-array spawn missing');
assert(!/--model \$\{forwardModel\}`;\s*pTy/i.test(overlay), 'shell-string leaked into win path');

// 2. resolver behaviour on a synthetic tree (same candidate order)
function resolveTuiClaudeScript(env, cwd, here) {
    const pkgRoot = path.resolve(here, '../../..');
    const appRoot = path.resolve(pkgRoot, '../..');
    const candidates = [
        env.CLOUDCLI_CLAUDE_ENTRY_JS,
        path.join(appRoot, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js'),
        path.join(pkgRoot, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js'),
        path.join(cwd, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js'),
    ].filter(Boolean);
    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) return candidate;
    }
    throw new Error('Claude Code cli.js entry not found (set CLOUDCLI_CLAUDE_ENTRY_JS).');
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccui-spawn-'));
const mk = (p) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, '#!/usr/bin/env node\n'); };
const here = path.join(tmp, 'app', 'node_modules', '@cloudcli-ai', 'cloudcli', 'dist-server', 'server');
mk(path.join(here, 'claude-interactive.js'));                        // simulated module location
const cliJs = path.join(tmp, 'app', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
mk(cliJs);                                                           // sibling app-root layout

assert.equal(resolveTuiClaudeScript({}, '/elsewhere', here), cliJs, 'app-root sibling must resolve');
const override = path.join(tmp, 'override-cli.js');
mk(override);
assert.equal(resolveTuiClaudeScript({ CLOUDCLI_CLAUDE_ENTRY_JS: override }, '/elsewhere', here),
    override, 'explicit override wins');
assert.throws(() => resolveTuiClaudeScript({}, '/elsewhere', path.join(tmp, 'nowhere')),
    /cli\.js entry not found/, 'must fail loudly when nothing exists');

fs.rmSync(tmp, { recursive: true, force: true });
console.log('claude-spawn.test: all assertions passed');
