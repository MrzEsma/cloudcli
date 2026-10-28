import { readFile, writeFile, } from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sessionsDb } from '../../../../modules/database/index.js';
import { buildDefaultProviderCurrentActiveModel, writeProviderSessionActiveModelChange, } from '../../../../shared/utils.js';
import { readModelProxies } from '../../../../shared/model-proxies.js';
// --- Live provider catalog -------------------------------------------------
// The Anthropic-compatible proxy publishes its model list on `/v1/models`.
// Fetching it keeps the picker in sync with new provider releases without a
// CloudCLI upgrade. A one-hour in-memory cache (plus a disk cache that survives
// restarts) keeps chat turns from paying the request latency.
const CLAUDE_CATALOG_TTL_MS = 60 * 60 * 1000;
const CLAUDE_CATALOG_STALE_FALLBACK_MS = 24 * 60 * 60 * 1000;
const CLAUDE_CATALOG_TIMEOUT_MS = 6000;
const CLAUDE_CATALOG_CACHE_PATH = path.join(os.homedir(), '.cloudcli', 'claude-models-cache.json');
let claudeCatalogCache = null;
const CLAUDE_DYNAMIC_EFFORT = {
    default: 'high',
    values: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }, { value: 'max' }],
};
const isIClaudeMode = () => process.env.CLAUDE_AUTH_MODE === 'iclaude';
export function claudeCatalogLabel(id) {
    const withoutDate = String(id).replace(/-\d{8}$/, '');
    if (/^gpt-/i.test(withoutDate)) {
        return withoutDate.toUpperCase().replace(/-/g, ' ');
    }
    if (!withoutDate.startsWith('claude-')) {
        return withoutDate.replace(/-/g, ' ');
    }
    const match = withoutDate.slice('claude-'.length).match(/^([a-z]+)-?((?:\d+(?:[.-]\d+)*))?$/);
    if (!match) {
        return withoutDate;
    }
    const family = match[1].charAt(0).toUpperCase() + match[1].slice(1);
    const version = match[2] ? ` ${match[2].replace(/-/g, '.')}` : '';
    return `Claude ${family}${version}`;
}
export function buildClaudeCatalogDefinition(ids) {
    const seen = new Set(['default']);
    const options = [];
    const pushOption = (value, label, description) => {
        if (seen.has(value)) {
            return;
        }
        seen.add(value);
        options.push({ value, label, description, effort: CLAUDE_DYNAMIC_EFFORT });
    };
    const defaultOption = CLAUDE_FALLBACK_MODELS.OPTIONS.find((option) => option.value === 'default');
    if (defaultOption) {
        options.push(defaultOption);
    }
    for (const id of ids) {
        if (typeof id !== 'string' || !id.trim() || id === 'default') {
            continue;
        }
        // The shared proxy catalog also lists Codex utility models; they are
        // not selectable Claude Code targets.
        if (id.startsWith('codex-')) {
            continue;
        }
        pushOption(id, claudeCatalogLabel(id), 'Live from the provider model catalog');
    }
    if (options.length <= 1) {
        return null;
    }
    return { OPTIONS: options, DEFAULT: 'default' };
}
function readCachedCatalogEntry() {
    if (claudeCatalogCache) {
        return claudeCatalogCache;
    }
    try {
        const parsed = JSON.parse(fs.readFileSync(CLAUDE_CATALOG_CACHE_PATH, 'utf8'));
        if (parsed && typeof parsed === 'object' && Array.isArray(parsed.models)) {
            claudeCatalogCache = { models: parsed.models, fetchedAt: typeof parsed.fetchedAt === 'number' ? parsed.fetchedAt : 0 };
            return claudeCatalogCache;
        }
    }
    catch {
        // No usable disk cache yet.
    }
    return null;
}
async function fetchClaudeCatalogIds() {
    const baseUrl = (process.env.ANTHROPIC_BASE_URL || '').replace(/\/+$/, '');
    const token = process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY || '';
    if (!/^https?:\/\//.test(baseUrl) || !token) {
        return null;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CLAUDE_CATALOG_TIMEOUT_MS);
    try {
        const response = await fetch(`${baseUrl}/v1/models`, {
            headers: {
                authorization: `Bearer ${token}`,
                'anthropic-version': '2023-06-01',
            },
            signal: controller.signal,
        });
        if (!response.ok) {
            return null;
        }
        const payload = await response.json();
        const ids = Array.isArray(payload?.data)
            ? payload.data.map((entry) => entry?.id).filter((id) => typeof id === 'string')
            : [];
        return ids.length > 0 ? ids : null;
    }
    catch {
        return null;
    }
    finally {
        clearTimeout(timer);
    }
}
async function resolveClaudeBaseModels() {
    const cached = readCachedCatalogEntry();
    const now = Date.now();
    if (cached && now - cached.fetchedAt < CLAUDE_CATALOG_TTL_MS) {
        return buildClaudeCatalogDefinition(cached.models) ?? CLAUDE_FALLBACK_MODELS;
    }
    const ids = await fetchClaudeCatalogIds();
    if (ids) {
        claudeCatalogCache = { models: ids, fetchedAt: now };
        try {
            await writeFile(CLAUDE_CATALOG_CACHE_PATH, `${JSON.stringify({ fetchedAt: now, models: ids }, null, 2)}\n`, { mode: 0o600 });
        }
        catch {
            // The catalog still works without persistence.
        }
        return buildClaudeCatalogDefinition(ids) ?? CLAUDE_FALLBACK_MODELS;
    }
    // Transient failure: serve a stale catalog for up to a day, then fall back.
    if (cached && now - cached.fetchedAt < CLAUDE_CATALOG_STALE_FALLBACK_MS) {
        return buildClaudeCatalogDefinition(cached.models) ?? CLAUDE_FALLBACK_MODELS;
    }
    return CLAUDE_FALLBACK_MODELS;
}
// Base model ids that get a per-proxy variant (`opus@<proxyId>`). 'default' is
// excluded because it delegates model choice to the CLI itself.
const MAX_FALLBACK_PROXIED_CLAUDE_MODELS = 4;
// Order a proxy catalog for the picker: Claude models first, newest version
// first, other vendors after.
function orderProxyCatalog(ids) {
    const versionKey = (id) => (String(id).replace(/-\d{8}$/, '').match(/\d+/g) || ['0'])
        .map(Number);
    const compareVersions = (left, right) => {
        for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
            const delta = (right[index] ?? 0) - (left[index] ?? 0);
            if (delta !== 0) {
                return delta;
            }
        }
        return 0;
    };
    const claude = ids.filter((id) => id.startsWith('claude-'))
        .sort((left, right) => compareVersions(versionKey(left), versionKey(right)) || left.localeCompare(right));
    const others = ids.filter((id) => !id.startsWith('claude-'))
        .sort((left, right) => compareVersions(versionKey(left), versionKey(right)) || left.localeCompare(right));
    return [...claude, ...others];
}
// Each registered proxy advertises its own catalog on `/v1/models`; proxy
// variants must mirror THAT list, not the platform default's — model names
// differ between gateways and a mirrored name 400s at request time.
const proxyCatalogCaches = new Map();
async function fetchProxyCatalogIds(proxy) {
    const cached = proxyCatalogCaches.get(proxy.id);
    const now = Date.now();
    if (cached && now - cached.fetchedAt < CLAUDE_CATALOG_TTL_MS) {
        return cached.models;
    }
    const baseUrl = String(proxy.claudeBaseUrl || '').replace(/\/+$/, '');
    const token = String(proxy.token || '');
    if (!/^https?:\/\//.test(baseUrl) || !token) {
        return null;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CLAUDE_CATALOG_TIMEOUT_MS);
    try {
        const response = await fetch(`${baseUrl}/v1/models`, {
            headers: {
                authorization: `Bearer ${token}`,
                'anthropic-version': '2023-06-01',
            },
            signal: controller.signal,
        });
        if (!response.ok) {
            return null;
        }
        const payload = await response.json();
        const ids = Array.isArray(payload?.data)
            ? payload.data.map((entry) => entry?.id).filter((id) => typeof id === 'string' && id && !id.startsWith('codex-'))
            : [];
        if (ids.length === 0) {
            return null;
        }
        proxyCatalogCaches.set(proxy.id, { models: ids, fetchedAt: now });
        return ids;
    }
    catch {
        return null;
    }
    finally {
        clearTimeout(timer);
    }
}
async function appendClaudeProxyVariants(baseModels) {
    const gatewayProxies = readModelProxies().filter((proxy) => typeof proxy.claudeBaseUrl === 'string' && proxy.claudeBaseUrl.trim() !== '');
    const oauthProxies = readModelProxies().filter((proxy) => proxy.auth === 'oauth');
    if (gatewayProxies.length === 0 && oauthProxies.length === 0) {
        return baseModels;
    }
    const fallbackBases = baseModels.OPTIONS.filter((option) => option.value !== 'default').slice(0, MAX_FALLBACK_PROXIED_CLAUDE_MODELS);
    const catalogs = await Promise.all(gatewayProxies.map((proxy) => fetchProxyCatalogIds(proxy)));
    const options = [...baseModels.OPTIONS];
    gatewayProxies.forEach((proxy, index) => {
        const catalogIds = catalogs[index];
        // The proxy's full catalog, ordered for the picker — no cap, so every
        // model the gateway serves is selectable.
        const bases = catalogIds
            ? orderProxyCatalog(catalogIds).map((id) => ({
                value: id,
                label: claudeCatalogLabel(id),
                description: `Live from the provider model catalog · via proxy ${proxy.name}`,
            }))
            : fallbackBases.map((base) => ({
                value: base.value,
                label: base.label,
                description: `${base.description ?? ''} · via proxy ${proxy.name}`.trim(),
            }));
        for (const base of bases) {
            options.push({
                value: `${base.value}@${proxy.id}`,
                label: `${base.label} · ${proxy.name}`,
                description: base.description,
                effort: CLAUDE_DYNAMIC_EFFORT,
            });
        }
    });
    // A second official Claude login (`auth: "oauth"`): every alias the
    // subscription account can run, as its own picker group. These sessions
    // run the interactive TUI against that account's credentials directory.
    for (const proxy of oauthProxies) {
        for (const base of baseModels.OPTIONS) {
            if (base.value === 'default') {
                continue;
            }
            options.push({
                value: `${base.value}@${proxy.id}`,
                label: `${base.label} · ${proxy.name}`,
                description: `${base.description ?? ''} · حساب رسمی شخصی (لاگین مستقیم)`.trim(),
                effort: CLAUDE_DYNAMIC_EFFORT,
            });
        }
    }
    return { ...baseModels, OPTIONS: options };
}
export const CLAUDE_FALLBACK_MODELS = {
    OPTIONS: [
        {
            value: 'default',
            label: 'Default (recommended)',
            description: 'Use the Claude Code default model (currently Sonnet 4.6)',
            effort: {
                default: 'high',
                values: [
                    { value: 'low' },
                    { value: 'medium' },
                    { value: 'high' },
                    { value: 'max' },
                ],
            },
        },
        {
            value: 'fable',
            label: 'Fable',
            description: 'Fable 5 · Most capable for your hardest and longest-running tasks · Uses your limits ~2× faster than Opus',
            effort: {
                default: 'high',
                values: [
                    { value: 'low' },
                    { value: 'medium' },
                    { value: 'high' },
                    { value: 'xhigh' },
                    { value: 'max' },
                ],
            },
        },
        {
            value: 'fable[1m]',
            label: 'Fable (1M context)',
            description: 'Fable 5 with the 1M-context window',
            effort: {
                default: 'high',
                values: [
                    { value: 'low' },
                    { value: 'medium' },
                    { value: 'high' },
                    { value: 'xhigh' },
                    { value: 'max' },
                ],
            },
        },
        {
            value: "sonnet",
            label: "Sonnet",
            description: "Sonnet 4.6 · Best for everyday tasks · $3/$15 per Mtok",
            effort: {
                default: 'high',
                values: [
                    { value: 'low' },
                    { value: 'medium' },
                    { value: 'high' },
                    { value: 'max' },
                ],
            },
        },
        {
            value: 'sonnet[1m]',
            label: 'Sonnet (1M context)',
            description: 'Sonnet 4.6 for long sessions · $3/$15 per Mtok',
            effort: {
                default: 'high',
                values: [
                    { value: 'low' },
                    { value: 'medium' },
                    { value: 'high' },
                    { value: 'max' },
                ],
            },
        },
        {
            value: 'opus',
            label: 'Opus',
            description: 'Opus 4.8 · Best for everyday, complex tasks · ~2× usage vs Sonnet',
            effort: {
                default: 'high',
                values: [
                    { value: 'low' },
                    { value: 'medium' },
                    { value: 'high' },
                    { value: 'xhigh' },
                    { value: 'max' },
                ],
            },
        },
        {
            value: 'opus[1m]',
            label: 'Opus 4.8 (1M context)',
            description: 'Opus 4.8 with 1M context · Most capable for complex work · $5/$25 per Mtok',
            effort: {
                default: 'high',
                values: [
                    { value: 'low' },
                    { value: 'medium' },
                    { value: 'high' },
                    { value: 'xhigh' },
                    { value: 'max' },
                ],
            },
        },
        {
            value: 'opusplan',
            label: 'Opus Plan',
            description: 'Opus planning variant · tuned for plan-mode reasoning',
            effort: {
                default: 'high',
                values: [
                    { value: 'low' },
                    { value: 'medium' },
                    { value: 'high' },
                    { value: 'xhigh' },
                    { value: 'max' },
                ],
            },
        },
        {
            value: 'opusplan[1m]',
            label: 'Opus Plan (1M context)',
            description: 'Opus planning variant with the 1M-context window',
            effort: {
                default: 'high',
                values: [
                    { value: 'low' },
                    { value: 'medium' },
                    { value: 'high' },
                    { value: 'xhigh' },
                    { value: 'max' },
                ],
            },
        },
        {
            value: 'haiku',
            label: 'Haiku',
            description: 'Haiku 4.5 · Fastest for quick answers · $1/$5 per Mtok',
        },
    ],
    DEFAULT: 'default',
};
export const CLAUDE_MANAGED_TEAM_MODELS = {
    OPTIONS: CLAUDE_FALLBACK_MODELS.OPTIONS.map((option) => ({
        ...option,
        label: option.value === 'default' ? 'Default (پیشنهادی)' : option.label,
        description: option.value === 'default'
            ? 'انتخاب پیشنهادی Claude Code از حساب تیم'
            : 'مدل واقعی Claude از حساب تیم',
    })),
    DEFAULT: 'default',
    MANAGED_TEAM: true,
    PROVIDER_LABEL: 'Claude · حساب تیم',
};
export const findClaudeModelOption = (model) => {
    const normalizedModel = typeof model === 'string' ? model.trim() : '';
    if (!normalizedModel) {
        return null;
    }
    return CLAUDE_FALLBACK_MODELS.OPTIONS.find((option) => option.value === normalizedModel) ?? null;
};
const ANSI_PATTERN = new RegExp('[\\u001B\\u009B][[\\]()#;?]*(?:'
    + '(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]'
    + '|(?:[\\dA-PR-TZcf-ntqry=><~]))', 'g');
const extractClaudeEventModel = (event, sessionId) => {
    const eventSessionId = event.sessionId ?? event.session_id;
    if (eventSessionId && eventSessionId !== sessionId) {
        return null;
    }
    const contentModel = extractClaudeModelFromMessageContent(event.message?.content);
    if (contentModel) {
        return contentModel;
    }
    const directModel = event.model?.trim();
    if (directModel) {
        return directModel;
    }
    const messageModel = event.message?.model?.trim();
    return messageModel || null;
};
const stripAnsi = (value) => value.replace(ANSI_PATTERN, '');
const extractTaggedContent = (content, tagName) => {
    const escapedTagName = tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = new RegExp(`<${escapedTagName}>([\\s\\S]*?)<\\/${escapedTagName}>`).exec(content);
    return match ? match[1] : null;
};
const extractClaudeModelFromTextContent = (content) => {
    const localCommandStdout = extractTaggedContent(content, 'local-command-stdout');
    if (localCommandStdout !== null) {
        const cleanedStdout = stripAnsi(localCommandStdout).replace(/\s+/g, ' ').trim();
        const changedModel = /(?:set|changed|switched)\s+model\s+to\s+(.+?)\.?$/i.exec(cleanedStdout);
        if (changedModel?.[1]?.trim()) {
            return changedModel[1].trim();
        }
    }
    const modelTag = extractTaggedContent(content, 'model')?.trim();
    return modelTag || null;
};
const extractClaudeModelFromMessageContent = (content) => {
    if (typeof content === 'string') {
        return extractClaudeModelFromTextContent(content);
    }
    if (!Array.isArray(content)) {
        return null;
    }
    for (const part of content) {
        if (!part || typeof part !== 'object' || !('text' in part) || typeof part.text !== 'string') {
            continue;
        }
        const model = extractClaudeModelFromTextContent(part.text);
        if (model) {
            return model;
        }
    }
    return null;
};
const readClaudeSessionModelFromJsonl = async (sessionId, jsonlPath) => {
    const content = await readFile(jsonlPath, 'utf8');
    const lines = content
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
        try {
            const event = JSON.parse(lines[index]);
            const model = extractClaudeEventModel(event, sessionId);
            if (model) {
                return { model };
            }
        }
        catch {
            // Skip malformed JSONL lines that can happen during concurrent writes.
        }
    }
    return null;
};
export class ClaudeProviderModels {
    async getSupportedModels() {
        // iClaude is a first-class Claude transport, not another generic model
        // proxy. Its base picker contains only Claude Code's real aliases —
        // but tenant-registered proxies stay selectable as suffixed variants
        // (`model@proxyId`), each listing that gateway's own catalog.
        if (isIClaudeMode()) {
            return appendClaudeProxyVariants(CLAUDE_MANAGED_TEAM_MODELS);
        }
        // claude creates a new jsonl file as a separate session for this request.
        // As a result, it lists the workspace where this is invoked when it shouldn't.
        //
        // Disabled for now:
        // const queryInstance = query({
        //   prompt: 'Get supported models',
        //   options: buildClaudeQueryOptions(),
        // });
        // const supportedModels = await queryInstance.supportedModels();
        // queryInstance.close();
        // return buildClaudeModelsDefinition(supportedModels);
        return appendClaudeProxyVariants(await resolveClaudeBaseModels());
    }
    async getCurrentActiveModel(sessionId) {
        if (!sessionId?.trim()) {
            return buildDefaultProviderCurrentActiveModel(await this.getSupportedModels());
        }
        try {
            const jsonlPath = sessionsDb.getSessionById(sessionId)?.jsonl_path;
            const activeModel = jsonlPath
                ? await readClaudeSessionModelFromJsonl(sessionId, jsonlPath)
                : null;
            if (activeModel?.model) {
                return activeModel;
            }
        }
        catch {
            // Fall through to the provider default when the session-backed lookup fails.
        }
        return buildDefaultProviderCurrentActiveModel(await this.getSupportedModels());
    }
    async changeActiveModel(input) {
        return writeProviderSessionActiveModelChange('claude', input);
    }
}
//# sourceMappingURL=claude-models.provider.js.map
