import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { providerRegistry } from '../../../modules/providers/provider.registry.js';
import { readProviderSessionActiveModelChange, writeProviderSessionActiveModelChange } from '../../../shared/utils.js';
import { sessionsDb } from '../../database/repositories/sessions.db.js';
export const PROVIDER_MODELS_CACHE_TTL_MS = 3 * 24 * 60 * 60 * 1000;
const PROVIDER_MODELS_CACHE_VERSION = 2;
const UNCACHED_PROVIDERS = new Set(['claude', 'codex']);
const PROVIDER_SESSION_RUNTIME_MODELS_VERSION = 1;
// Every session's own model must survive (a pruned entry lets the browser's
// provider-wide selector move that session again); two keys per session.
const PROVIDER_SESSION_RUNTIME_MODELS_MAX_ENTRIES = 20000;
const getProviderModelsCachePath = () => path.join(os.homedir(), '.cloudcli', 'provider-models-cache.json');
const getProviderSessionRuntimeModelsPath = () => path.join(os.homedir(), '.cloudcli', 'provider-session-runtime-models.json');
const toProviderModelsCacheInfo = (entry, source) => ({
    updatedAt: new Date(entry.updatedAt).toISOString(),
    expiresAt: new Date(entry.expiresAt).toISOString(),
    source,
});
const isProviderModelOption = (value) => (Boolean(value)
    && typeof value === 'object'
    && typeof value.value === 'string'
    && typeof value.label === 'string'
    && (typeof value.description === 'undefined'
        || typeof value.description === 'string'));
const isProviderModelsDefinition = (value) => (Boolean(value)
    && typeof value === 'object'
    && Array.isArray(value.OPTIONS)
    && value.OPTIONS.every(isProviderModelOption)
    && typeof value.DEFAULT === 'string');
const isProviderModelsCacheEntry = (value) => (Boolean(value)
    && typeof value === 'object'
    && typeof value.updatedAt === 'number'
    && typeof value.expiresAt === 'number'
    && isProviderModelsDefinition(value.models));
const readProviderModelsCacheFile = async (cachePath) => {
    try {
        const raw = await readFile(cachePath, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed.version !== PROVIDER_MODELS_CACHE_VERSION || !parsed.entries || typeof parsed.entries !== 'object') {
            return null;
        }
        const entries = Object.fromEntries(Object.entries(parsed.entries).filter((entry) => isProviderModelsCacheEntry(entry[1])));
        return {
            version: PROVIDER_MODELS_CACHE_VERSION,
            entries,
        };
    }
    catch {
        return null;
    }
};
const writeProviderModelsCacheFile = async (cachePath, entries, now) => {
    const serializableEntries = Object.fromEntries([...entries.entries()].filter(([, entry]) => entry.expiresAt > now));
    const payload = {
        version: PROVIDER_MODELS_CACHE_VERSION,
        entries: serializableEntries,
    };
    await mkdir(path.dirname(cachePath), { recursive: true });
    await writeFile(cachePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
};
/**
 * Provider model lookup service.
 *
 * Routes and other service callers use this layer instead of resolving provider
 * classes directly so the provider-registry dependency stays centralized in one
 * place.
 */
export const createProviderModelsService = (dependencies = {}) => {
    const resolveProvider = dependencies.resolveProvider ?? providerRegistry.resolveProvider;
    const cachePath = dependencies.cachePath ?? getProviderModelsCachePath();
    const activeModelChangesPath = dependencies.activeModelChangesPath;
    const runtimeModelsPath = dependencies.runtimeModelsPath ?? getProviderSessionRuntimeModelsPath();
    const now = dependencies.now ?? (() => Date.now());
    const memoryCache = new Map();
    const pendingRequests = new Map();
    let persistedCacheLoaded = false;
    let persistedCacheLoadPromise = null;
    const pruneExpiredMemoryEntry = (provider, currentTime, source) => {
        const cachedEntry = memoryCache.get(provider);
        if (!cachedEntry) {
            return null;
        }
        if (cachedEntry.expiresAt > currentTime) {
            return {
                models: cachedEntry.models,
                cache: toProviderModelsCacheInfo(cachedEntry, source),
            };
        }
        memoryCache.delete(provider);
        return null;
    };
    const loadPersistedCache = async () => {
        if (persistedCacheLoaded) {
            return;
        }
        if (!persistedCacheLoadPromise) {
            persistedCacheLoadPromise = (async () => {
                const cacheFile = await readProviderModelsCacheFile(cachePath);
                const currentTime = now();
                for (const [provider, entry] of Object.entries(cacheFile?.entries ?? {})) {
                    if (entry.expiresAt > currentTime) {
                        memoryCache.set(provider, entry);
                    }
                }
                persistedCacheLoaded = true;
            })().finally(() => {
                persistedCacheLoadPromise = null;
            });
        }
        await persistedCacheLoadPromise;
    };
    const persistCache = async () => {
        try {
            await writeProviderModelsCacheFile(cachePath, memoryCache, now());
        }
        catch (error) {
            console.warn('Unable to persist provider models cache:', error);
        }
    };
    const setCacheEntry = async (provider, models) => {
        const currentTime = now();
        const entry = {
            updatedAt: currentTime,
            expiresAt: currentTime + PROVIDER_MODELS_CACHE_TTL_MS,
            models,
        };
        memoryCache.set(provider, entry);
        await persistCache();
        return entry;
    };
    const loadAndCacheModels = (provider) => {
        const request = resolveProvider(provider).models.getSupportedModels()
            .then(async (models) => {
            const entry = await setCacheEntry(provider, models);
            return {
                models,
                cache: toProviderModelsCacheInfo(entry, 'fresh'),
            };
        })
            .finally(() => {
            pendingRequests.delete(provider);
        });
        pendingRequests.set(provider, request);
        return request;
    };
    const loadDirectModels = (provider) => {
        const request = resolveProvider(provider).models.getSupportedModels()
            .then((models) => {
            const currentTime = now();
            return {
                models,
                cache: {
                    updatedAt: new Date(currentTime).toISOString(),
                    expiresAt: new Date(currentTime).toISOString(),
                    source: 'fresh',
                },
            };
        })
            .finally(() => {
            pendingRequests.delete(provider);
        });
        pendingRequests.set(provider, request);
        return request;
    };
    const getProviderModels = async (provider, options = {}) => {
        if (UNCACHED_PROVIDERS.has(provider)) {
            const pendingRequest = pendingRequests.get(provider);
            if (pendingRequest) {
                return pendingRequest;
            }
            return loadDirectModels(provider);
        }
        if (options.bypassCache) {
            const pendingRequest = pendingRequests.get(provider);
            if (pendingRequest) {
                return pendingRequest;
            }
            return loadAndCacheModels(provider);
        }
        const cachedModels = pruneExpiredMemoryEntry(provider, now(), 'memory');
        if (cachedModels) {
            return cachedModels;
        }
        const pendingRequest = pendingRequests.get(provider);
        if (pendingRequest) {
            return pendingRequest;
        }
        await loadPersistedCache();
        const persistedModels = pruneExpiredMemoryEntry(provider, now(), 'disk');
        if (persistedModels) {
            return persistedModels;
        }
        const postLoadPendingRequest = pendingRequests.get(provider);
        if (postLoadPendingRequest) {
            return postLoadPendingRequest;
        }
        return loadAndCacheModels(provider);
    };
    const getCurrentActiveModel = async (provider, sessionId) => resolveProvider(provider).models.getCurrentActiveModel(sessionId);
    const changeActiveModel = async (provider, input) => {
        const result = await resolveProvider(provider).models.changeActiveModel(input);
        // The route stores the entry under the app session id the browser sent.
        // Mirror it under every alias for that session so the runtime resume
        // path (which knows the provider-native id) actually finds it.
        if (result.changed && result.model && input.sessionId?.trim()) {
            for (const candidate of resolveSessionIdCandidates(input.sessionId)) {
                if (candidate === input.sessionId.trim()) {
                    continue;
                }
                try {
                    await writeProviderSessionActiveModelChange(provider, {
                        sessionId: candidate,
                        model: result.model,
                    }, activeModelChangesPath ? { filePath: activeModelChangesPath } : {});
                }
                catch { /* best-effort mirror; the primary entry is already written */ }
            }
        }
        return result;
    };
    const getChangedActiveModel = async (provider, sessionId) => {
        for (const candidate of resolveSessionIdCandidates(sessionId)) {
            const changedModel = await readProviderSessionActiveModelChange(provider, candidate, {
                filePath: activeModelChangesPath,
            });
            if (changedModel.supported && changedModel.changed && changedModel.model?.trim()) {
                return changedModel;
            }
        }
        return readProviderSessionActiveModelChange(provider, sessionId, {
            filePath: activeModelChangesPath,
        });
    };
    const resolveResumeModel = async (provider, sessionId, requestedModel) => {
        const normalizedRequestedModel = typeof requestedModel === 'string' ? requestedModel.trim() : '';
        if (!sessionId?.trim()) {
            return normalizedRequestedModel || undefined;
        }
        const changedModel = await getChangedActiveModel(provider, sessionId);
        if (changedModel.supported && changedModel.changed && changedModel.model?.trim()) {
            return changedModel.model.trim();
        }
        return normalizedRequestedModel || undefined;
    };
    // The app session id (sessions.session_id) and the provider-native session
    // id (sessions.provider_session_id — the Claude JSONL id / Codex rollout id)
    // differ. The active-model REST route receives the app id from the browser
    // while runtime resume paths know only the provider id, so any session-keyed
    // lookup must consider both. Without this, an explicit mid-session model
    // re-pick is written under one id and read under the other — and silently
    // ignored.
    const defaultResolveSessionIdCandidates = (sessionId) => {
        const normalized = typeof sessionId === 'string' ? sessionId.trim() : '';
        if (!normalized) {
            return [];
        }
        const ids = [normalized];
        try {
            const byAppId = sessionsDb.getSessionById(normalized);
            if (byAppId?.provider_session_id?.trim()) {
                ids.push(byAppId.provider_session_id.trim());
            }
        }
        catch { /* sessions db unavailable — degrade to the direct id only */ }
        try {
            const byProviderId = sessionsDb.getSessionByProviderSessionId(normalized);
            if (byProviderId?.session_id?.trim()) {
                ids.push(byProviderId.session_id.trim());
            }
        }
        catch { /* sessions db unavailable — degrade to the direct id only */ }
        return [...new Set(ids)];
    };
    const resolveSessionIdCandidates = dependencies.resolveSessionIdCandidates ?? defaultResolveSessionIdCandidates;
    // Last model a session actually ran with, persisted per provider session so
    // a page reload (which resets the browser's provider-wide model selector)
    // cannot silently reroute a running session onto another account.
    const readRuntimeModelsFile = async () => {
        try {
            const raw = await readFile(runtimeModelsPath, 'utf8');
            const parsed = JSON.parse(raw);
            if (parsed.version !== PROVIDER_SESSION_RUNTIME_MODELS_VERSION || typeof parsed.entries !== 'object' || !parsed.entries) {
                return {};
            }
            const entries = {};
            for (const [key, entry] of Object.entries(parsed.entries)) {
                if (entry && typeof entry.model === 'string' && entry.model.trim()) {
                    entries[key] = entry;
                }
            }
            return entries;
        }
        catch {
            return {};
        }
    };
    const writeRuntimeModelsFile = async (entries) => {
        await mkdir(path.dirname(runtimeModelsPath), { recursive: true });
        await writeFile(runtimeModelsPath, `${JSON.stringify({ version: PROVIDER_SESSION_RUNTIME_MODELS_VERSION, entries }, null, 2)}\n`, 'utf8');
    };
    const getRuntimeSessionModel = async (provider, sessionId) => {
        if (!sessionId?.trim()) {
            return null;
        }
        const entries = await readRuntimeModelsFile();
        for (const candidate of resolveSessionIdCandidates(sessionId)) {
            const entry = entries[`${provider}:${candidate}`];
            if (entry?.model?.trim()) {
                return {
                    model: entry.model.trim(),
                    updatedAt: entry.updatedAt,
                    transport: typeof entry.transport === 'string' ? entry.transport : undefined,
                };
            }
        }
        return null;
    };
    const recordRuntimeSessionModel = async (provider, sessionId, model, transport) => {
        if (!sessionId?.trim() || typeof model !== 'string' || !model.trim()) {
            return;
        }
        try {
            const entries = await readRuntimeModelsFile();
            const updatedAt = new Date(now()).toISOString();
            for (const candidate of resolveSessionIdCandidates(sessionId)) {
                entries[`${provider}:${candidate}`] = {
                    model: model.trim(),
                    updatedAt,
                    ...(typeof transport === 'string' && transport ? { transport } : {}),
                };
            }
            const keys = Object.keys(entries);
            if (keys.length > PROVIDER_SESSION_RUNTIME_MODELS_MAX_ENTRIES) {
                keys.sort((a, b) => String(entries[a].updatedAt ?? '').localeCompare(String(entries[b].updatedAt ?? '')));
                for (const key of keys.slice(0, keys.length - PROVIDER_SESSION_RUNTIME_MODELS_MAX_ENTRIES)) {
                    delete entries[key];
                }
            }
            await writeRuntimeModelsFile(entries);
        }
        catch (error) {
            console.warn('Unable to persist provider session runtime model:', error?.message || error);
        }
    };
    // Resume-model precedence:
    //   1. explicit user re-pick for this session (active-model endpoint —
    //      the in-session `/model` picker)
    //   2. the model this session last ran with
    //   3. whatever the caller asked for — only for a session with no
    //      recorded model yet (a brand-new session or a pre-pin legacy one)
    // The browser sends its provider-wide selector value with every message,
    // and that selector is only editable on the new-session screen. Letting a
    // non-default value win over (2) meant picking a model for a NEW session
    // in one tab silently moved every OLD session opened afterwards onto that
    // model/account (2026-10-12: an Opus team session ran on a GLM proxy).
    // A session's model therefore changes only through (1).
    const resolveSessionRuntimeModel = async (provider, { sessionId, requestedModel }) => {
        const normalizedRequestedModel = typeof requestedModel === 'string' ? requestedModel.trim() : '';
        if (!sessionId?.trim()) {
            return normalizedRequestedModel || undefined;
        }
        const changedModel = await getChangedActiveModel(provider, sessionId);
        if (changedModel.supported && changedModel.changed && changedModel.model?.trim()) {
            return changedModel.model.trim();
        }
        const runtimeEntry = await getRuntimeSessionModel(provider, sessionId);
        if (runtimeEntry) {
            return runtimeEntry.model;
        }
        return normalizedRequestedModel || undefined;
    };
    const clearCache = () => {
        memoryCache.clear();
        pendingRequests.clear();
        persistedCacheLoaded = false;
        persistedCacheLoadPromise = null;
    };
    return {
        getProviderModels,
        getCurrentActiveModel,
        getChangedActiveModel,
        changeActiveModel,
        resolveResumeModel,
        getRuntimeSessionModel,
        recordRuntimeSessionModel,
        resolveSessionRuntimeModel,
        clearCache,
    };
};
export const providerModelsService = createProviderModelsService();
//# sourceMappingURL=provider-models.service.js.map
