import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import TOML from '@iarna/toml';
import { buildDefaultProviderCurrentActiveModel, readObjectRecord, readOptionalString, writeProviderSessionActiveModelChange, } from '../../../../shared/utils.js';
import { readModelProxies } from '../../../../shared/model-proxies.js';
// Cap of base models mirrored per registered proxy so the picker stays usable
// when Codex reports a long catalog.
const MAX_PROXIED_CODEX_MODELS = 6;
const appendCodexProxyVariants = (definition) => {
    const proxies = readModelProxies().filter((proxy) => typeof proxy.codexBaseUrl === 'string' && proxy.codexBaseUrl.trim() !== '');
    if (proxies.length === 0 || !Array.isArray(definition?.OPTIONS) || definition.OPTIONS.length === 0) {
        return definition;
    }
    const options = [...definition.OPTIONS];
    for (const proxy of proxies) {
        for (const base of definition.OPTIONS.slice(0, MAX_PROXIED_CODEX_MODELS)) {
            options.push({
                ...base,
                value: `${base.value}@${proxy.id}`,
                label: `${base.label} · ${proxy.name}`,
                description: `${base.description ?? ''} · via proxy ${proxy.name}`.trim(),
            });
        }
    }
    return { ...definition, OPTIONS: options };
};
export const CODEX_FALLBACK_MODELS = {
    OPTIONS: [
        {
            value: 'gpt-6-astra',
            label: 'GPT-6 Astra',
            effort: {
                default: 'low',
                values: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }, { value: 'xhigh' }, { value: 'max' }, { value: 'ultra' }],
            },
        },
        {
            value: 'gpt-5.6-sol',
            label: 'GPT-5.6 Sol',
            effort: {
                default: 'low',
                values: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }, { value: 'xhigh' }, { value: 'max' }, { value: 'ultra' }],
            },
        },
        {
            value: 'gpt-5.6-terra',
            label: 'GPT-5.6 Terra',
            effort: {
                default: 'medium',
                values: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }, { value: 'xhigh' }, { value: 'max' }, { value: 'ultra' }],
            },
        },
        {
            value: 'gpt-5.6-luna',
            label: 'GPT-5.6 Luna',
            effort: {
                default: 'medium',
                values: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }, { value: 'xhigh' }, { value: 'max' }],
            },
        },
        {
            value: 'gpt-5.5',
            label: 'gpt-5.5',
            effort: {
                default: 'medium',
                values: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }, { value: 'xhigh' }],
            },
        },
    ],
    DEFAULT: 'gpt-6-astra',
};
const CODEX_MODELS_CACHE_PATH = path.join(os.homedir(), '.codex', 'models_cache.json');
const CODEX_CONFIG_PATH = path.join(os.homedir(), '.codex', 'config.toml');
const CODEX_MODELS_COMMAND_TIMEOUT_MS = 5000;
const execFileAsync = promisify(execFile);
const isCodexCachedModel = (value) => {
    const record = readObjectRecord(value);
    return Boolean(record && readOptionalString(record.slug));
};
const readCodexPriority = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER);
const mapCodexModel = (model) => {
    const effortValues = Array.isArray(model.supported_reasoning_levels)
        ? model.supported_reasoning_levels
            .map((level) => {
            const value = readOptionalString(level?.effort);
            if (!value) {
                return null;
            }
            return {
                value,
                description: readOptionalString(level?.description),
            };
        })
            .filter((level) => Boolean(level))
        : [];
    return {
        value: model.slug,
        label: readOptionalString(model.display_name) ?? model.slug,
        description: readOptionalString(model.description),
        effort: effortValues.length > 0
            ? {
                default: readOptionalString(model.default_reasoning_level) ?? undefined,
                values: effortValues,
            }
            : undefined,
    };
};
const buildCodexModelsDefinition = (models) => {
    const sortedModels = [...models]
        .filter((model) => model.visibility === 'list' && model.supported_in_api !== false)
        .sort((left, right) => readCodexPriority(left.priority) - readCodexPriority(right.priority));
    const options = [];
    const seenValues = new Set();
    for (const model of sortedModels) {
        const mappedModel = mapCodexModel(model);
        if (seenValues.has(mappedModel.value)) {
            continue;
        }
        seenValues.add(mappedModel.value);
        options.push(mappedModel);
    }
    if (options.length === 0) {
        return CODEX_FALLBACK_MODELS;
    }
    return {
        OPTIONS: options,
        DEFAULT: options[0]?.value ?? CODEX_FALLBACK_MODELS.DEFAULT,
    };
};
const parseCodexModels = (value) => {
    const parsed = readObjectRecord(value);
    const rawModels = Array.isArray(parsed?.models)
        ? parsed.models
        : Array.isArray(value)
            ? value
            : [];
    return rawModels.filter(isCodexCachedModel);
};
const readCodexModelsFromCli = async () => {
    try {
        const codexPath = process.env.CLOUDCLI_CODEX_PATH || process.env.CODEX_CLI_PATH || 'codex';
        const { stdout } = await execFileAsync(codexPath, ['debug', 'models'], {
            timeout: CODEX_MODELS_COMMAND_TIMEOUT_MS,
            maxBuffer: 30 * 1024 * 1024,
            env: {
                ...process.env,
                HOME: os.homedir(),
                NO_COLOR: '1',
            },
        });
        return parseCodexModels(JSON.parse(stdout));
    }
    catch {
        return [];
    }
};
const readCodexModelsCache = async () => {
    try {
        return parseCodexModels(JSON.parse(await readFile(CODEX_MODELS_CACHE_PATH, 'utf8')));
    }
    catch {
        return [];
    }
};
export class CodexProviderModels {
    async getSupportedModels() {
        const refreshedModels = await readCodexModelsFromCli();
        if (refreshedModels.length > 0) {
            return appendCodexProxyVariants(buildCodexModelsDefinition(refreshedModels));
        }
        // Preserve a usable picker during a transient CLI or network failure.
        // The next request retries Codex, so a stale cache never becomes the
        // long-lived source of truth.
        return appendCodexProxyVariants(buildCodexModelsDefinition(await readCodexModelsCache()));
    }
    async getCurrentActiveModel() {
        try {
            const raw = await readFile(CODEX_CONFIG_PATH, 'utf8');
            const parsed = readObjectRecord(TOML.parse(raw));
            const model = readOptionalString(parsed?.model);
            if (!model) {
                return buildDefaultProviderCurrentActiveModel(await this.getSupportedModels());
            }
            return {
                model,
            };
        }
        catch {
            return buildDefaultProviderCurrentActiveModel(await this.getSupportedModels());
        }
    }
    async changeActiveModel(input) {
        return writeProviderSessionActiveModelChange('codex', input);
    }
}
//# sourceMappingURL=codex-models.provider.js.map
