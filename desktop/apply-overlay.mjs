#!/usr/bin/env node
/**
 * Node port of cloudcli-overlay/apply.sh — bash-free (Windows) application of
 * the cloudcli package overlay: verify the manifest, back up the stock server
 * entry, copy the overlay over the installed package. Idempotent.
 *   node desktop/apply-overlay.mjs [app-root]     # default: repo root
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OVERLAY = path.dirname(fileURLToPath(import.meta.url)) + path.sep + '..' + path.sep + 'cloudcli-overlay';
const ROOT = path.resolve(process.argv[2] || path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const PKG = path.join(ROOT, 'node_modules', '@cloudcli-ai', 'cloudcli');

if (!fs.existsSync(path.join(PKG, 'package.json'))) {
    console.error('node_modules missing; run npm ci first');
    process.exit(1);
}

const manifestPath = path.join(OVERLAY, 'manifest.sha256');
const entries = fs.readFileSync(manifestPath, 'utf8').split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
        const match = line.match(/^([0-9a-f]{64})\s+\*?(.+)$/);
        if (!match) throw new Error(`bad manifest line: ${line}`);
        return { sha: match[1], file: match[2] };
    });

let checked = 0;
for (const { sha, file } of entries) {
    const abs = path.join(OVERLAY, file);
    const digest = crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
    if (digest !== sha) {
        console.error(`overlay manifest mismatch: ${file}`);
        process.exit(1);
    }
    checked += 1;
}

const stockEntry = path.join(PKG, 'dist-server', 'server', 'index.js');
const stockBackup = stockEntry + '.pre-claude-interactive';
if (fs.existsSync(stockEntry) && !fs.existsSync(stockBackup)) {
    fs.copyFileSync(stockEntry, stockBackup);
}

for (const { file } of entries) {
    const dst = path.join(PKG, file.replace(/^package[\\/]/, ''));
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(path.join(OVERLAY, file), dst);
}
console.log(`cloudcli overlay applied to ${PKG} (${checked} files, manifest verified)`);
