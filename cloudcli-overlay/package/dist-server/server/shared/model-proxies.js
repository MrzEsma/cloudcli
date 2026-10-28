import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
/**
 * Tenant-registered model proxies.
 *
 * The openai-setup plugin owns the registry file; the provider overlays read
 * it per request so newly added proxies are picked up without a server
 * restart. Shape:
 *
 *   { "version": 1, "proxies": [
 *       { "id": "p1", "name": "my proxy", "claudeBaseUrl": "https://…",
 *         "codexBaseUrl": "https://…/codex", "token": "…", "createdAt": "…" }
 *   ] }
 *
 * A proxy participates in a provider only when its matching base URL is set.
 */
export const MODEL_PROXIES_REGISTRY_PATH = path.join(os.homedir(), '.cloudcli', 'model-proxies.json');
export function readModelProxies() {
    try {
        const parsed = JSON.parse(fs.readFileSync(MODEL_PROXIES_REGISTRY_PATH, 'utf8'));
        const proxies = Array.isArray(parsed?.proxies) ? parsed.proxies : [];
        return proxies.filter((entry) => entry && typeof entry === 'object'
            && typeof entry.id === 'string' && entry.id.trim() !== '');
    }
    catch {
        return [];
    }
}
export function readModelProxyById(proxyId) {
    if (typeof proxyId !== 'string' || proxyId.trim() === '') {
        return null;
    }
    return readModelProxies().find((entry) => entry.id === proxyId) ?? null;
}
/**
 * Splits a `model@proxyId` reference into its parts. Model ids never contain
 * `@`, so the last `@` separates the proxy id. Returns null for plain model
 * ids (no proxy suffix), which keeps every existing call site unchanged.
 */
export function parseModelProxyRef(model) {
    if (typeof model !== 'string' || !model.includes('@')) {
        return null;
    }
    const lastAt = model.lastIndexOf('@');
    const baseModel = model.slice(0, lastAt).trim();
    const proxyId = model.slice(lastAt + 1).trim();
    if (!baseModel || !proxyId || /[\s/]/.test(proxyId)) {
        return null;
    }
    return { model: baseModel, proxyId };
}
/**
 * Resolves a `model@proxyId` reference against the registry for one provider
 * kind. Returns `{ model, proxy }` when the suffix names a proxy that serves
 * the provider, `{ model }` when there is no usable suffix (the plain model
 * id, stripped), and null for unparseable input.
 */
export function resolveModelProxyRef(model, providerKind) {
    const urlField = providerKind === 'codex' ? 'codexBaseUrl' : 'claudeBaseUrl';
    if (typeof model !== 'string' || model.trim() === '') {
        return null;
    }
    const ref = parseModelProxyRef(model);
    if (!ref) {
        return { model: model.trim() };
    }
    const proxy = readModelProxyById(ref.proxyId);
    // An `auth: "oauth"` entry is a second official Claude login (its own
    // credentials directory, no base URL): a valid claude transport that runs
    // Claude Code itself, not a gateway.
    if (proxy && proxy.auth === 'oauth' && providerKind === 'claude') {
        return { model: ref.model, proxy };
    }
    if (!proxy || typeof proxy[urlField] !== 'string' || proxy[urlField].trim() === '') {
        // Unknown proxy or one that does not serve this provider: run the
        // stripped model id on the default connection rather than failing.
        return { model: ref.model };
    }
    return { model: ref.model, proxy };
}
