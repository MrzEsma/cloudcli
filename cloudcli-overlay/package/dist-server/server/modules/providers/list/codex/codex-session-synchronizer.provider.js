import os from 'node:os';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { sessionsDb } from '../../../../modules/database/index.js';
import { buildLookupMap, extractFirstValidJsonlData, findFilesRecursivelyCreatedAfter, normalizeSessionName, readFileTimestamps, } from '../../../../shared/utils.js';
/**
 * Session indexer for Codex transcript artifacts.
 */
export class CodexSessionSynchronizer {
    provider = 'codex';
    codexHome = path.join(os.homedir(), '.codex');
    /**
     * Scans ~/.codex/sessions and upserts discovered sessions into DB.
     */
    async synchronize(since) {
        const nameMap = await buildLookupMap(path.join(this.codexHome, 'session_index.jsonl'), 'id', 'thread_name');
        const files = await findFilesRecursivelyCreatedAfter(path.join(this.codexHome, 'sessions'), '.jsonl', since ?? null);
        let processed = 0;
        for (const filePath of files) {
            const parsed = await this.processSessionFile(filePath, nameMap);
            if (!parsed) {
                continue;
            }
            const existingSession = sessionsDb.getSessionByProviderSessionId(parsed.sessionId)
                ?? sessionsDb.getSessionById(parsed.sessionId);
            if (existingSession) {
                // If session name is untitled and we now have a name, update it
                if (existingSession.custom_name === 'Untitled Codex Session' && parsed.sessionName && parsed.sessionName !== 'Untitled Codex Session') {
                    sessionsDb.updateSessionCustomName(existingSession.session_id, parsed.sessionName);
                }
            }
            const timestamps = await readFileTimestamps(filePath);
            sessionsDb.createSession(parsed.sessionId, this.provider, parsed.projectPath, parsed.sessionName, timestamps.createdAt, timestamps.updatedAt, filePath, {
                sessionKind: parsed.sessionKind,
                parentSessionId: parsed.parentSessionId,
                agentPath: parsed.agentPath,
            });
            processed += 1;
        }
        return processed;
    }
    /**
     * Parses and upserts one Codex session JSONL file.
     */
    async synchronizeFile(filePath) {
        if (!filePath.endsWith('.jsonl')) {
            return null;
        }
        const nameMap = await buildLookupMap(path.join(this.codexHome, 'session_index.jsonl'), 'id', 'thread_name');
        const parsed = await this.processSessionFile(filePath, nameMap);
        if (!parsed) {
            return null;
        }
        const timestamps = await readFileTimestamps(filePath);
        return sessionsDb.createSession(parsed.sessionId, this.provider, parsed.projectPath, parsed.sessionName, timestamps.createdAt, timestamps.updatedAt, filePath, {
            sessionKind: parsed.sessionKind,
            parentSessionId: parsed.parentSessionId,
            agentPath: parsed.agentPath,
        });
    }
    /**
     * Extracts session metadata from one Codex JSONL session file.
     */
    async processSessionFile(filePath, nameMap) {
        const parsed = await extractFirstValidJsonlData(filePath, (rawData) => {
            const data = rawData;
            const payload = data.payload;
            const sessionId = typeof payload?.id === 'string' ? payload.id : undefined;
            const projectPath = typeof payload?.cwd === 'string' ? payload.cwd : undefined;
            const threadSource = typeof payload?.thread_source === 'string' ? payload.thread_source : undefined;
            const parentSessionId = typeof payload?.parent_thread_id === 'string' ? payload.parent_thread_id : undefined;
            const agentPath = typeof payload?.agent_path === 'string' ? payload.agent_path : undefined;
            const source = payload?.source;
            const isSubagent = threadSource === 'subagent' ||
                Boolean(source && typeof source === 'object' && 'subagent' in source) ||
                Boolean(parentSessionId && agentPath);
            if (!sessionId || !projectPath) {
                return null;
            }
            return {
                sessionId,
                projectPath,
                sessionKind: isSubagent ? 'agent' : 'main',
                parentSessionId: isSubagent ? parentSessionId : undefined,
                agentPath: isSubagent ? agentPath : undefined,
            };
        });
        if (!parsed) {
            return null;
        }
        // App-created sessions are keyed by an app id, so disk-discovered provider
        // ids must be resolved through the provider-id mapping first.
        const existingSession = sessionsDb.getSessionByProviderSessionId(parsed.sessionId)
            ?? sessionsDb.getSessionById(parsed.sessionId);
        const existingSessionName = existingSession?.custom_name;
        if (existingSessionName && existingSessionName !== 'Untitled Codex Session') {
            return {
                ...parsed,
                sessionName: normalizeSessionName(existingSessionName, 'Untitled Codex Session'),
            };
        }
        // Sessions started by sending a message from cloudcli carry a distinct
        // app-allocated session_id mapped to the provider id. For these we title the
        // conversation from the first user message the user typed, instead of the
        // generic "Untitled Codex Session" placeholder. Sessions discovered purely
        // by indexing (session_id === provider_session_id) keep the existing
        // thread_name/last-agent-message setup below.
        const isAppCreated = existingSession != null &&
            existingSession.provider_session_id != null &&
            existingSession.session_id !== existingSession.provider_session_id;
        let sessionName = isAppCreated
            ? await this.extractFirstUserMessageFromStart(filePath)
            : undefined;
        if (!sessionName) {
            sessionName = nameMap.get(parsed.sessionId);
        }
        if (!sessionName) {
            sessionName = await this.extractLastAgentMessageFromEnd(filePath);
        }
        return {
            ...parsed,
            sessionName: normalizeSessionName(sessionName, 'Untitled Codex Session'),
        };
    }
    /**
     * Returns the first user message text in a Codex transcript, used to title
     * app-created sessions from the prompt the user sent from cloudcli.
     *
     * Older Codex versions emitted an `event_msg`/`user_message` payload. Newer
     * versions persist user turns as `response_item`/`message` records. The first
     * response-item user message can contain CloudCLI's injected AGENTS and
     * environment context, so those bootstrap blocks must be discarded before a
     * title is selected.
     */
    async extractFirstUserMessageFromStart(filePath) {
        try {
            const content = await readFile(filePath, 'utf8');
            const lines = content.split(/\r?\n/);
            for (const rawLine of lines) {
                const line = rawLine.trim();
                if (!line) {
                    continue;
                }
                let parsed;
                try {
                    parsed = JSON.parse(line);
                }
                catch {
                    continue;
                }
                const data = parsed;
                const eventType = typeof data.type === 'string' ? data.type : undefined;
                const payload = data.payload;
                const payloadType = typeof payload?.type === 'string' ? payload.type : undefined;
                const message = typeof payload?.message === 'string' ? payload.message : undefined;
                if (eventType === 'event_msg' && payloadType === 'user_message' && message?.trim()) {
                    return message;
                }
                if (eventType === 'response_item' && payloadType === 'message' && payload?.role === 'user') {
                    const content = Array.isArray(payload.content) ? payload.content : [];
                    const textParts = content
                        .map((part) => {
                        if (!part || typeof part !== 'object') {
                            return '';
                        }
                        return part.type === 'input_text' && typeof part.text === 'string'
                            ? part.text.trim()
                            : '';
                    })
                        .filter((text) => text && !this.isInjectedBootstrapText(text));
                    const userMessage = textParts.join('\n').trim();
                    if (userMessage) {
                        return userMessage;
                    }
                }
            }
        }
        catch {
            // Ignore missing/unreadable files so sync can continue.
        }
        return undefined;
    }
    /**
     * Identifies context envelopes injected by the host before the user's first
     * prompt. They are stored with role=user by current Codex releases, but they
     * are not authored chat messages and must never become sidebar titles.
     */
    isInjectedBootstrapText(text) {
        const normalized = text.trimStart();
        return normalized.startsWith('# AGENTS.md instructions')
            || normalized.startsWith('<environment_context>')
            || normalized.startsWith('<permissions instructions>')
            || normalized.startsWith('<skills_instructions>')
            || normalized.startsWith('<multi_agent_mode>');
    }
    async extractLastAgentMessageFromEnd(filePath) {
        try {
            const content = await readFile(filePath, 'utf8');
            const lines = content.split(/\r?\n/);
            for (let index = lines.length - 1; index >= 0; index -= 1) {
                const line = lines[index]?.trim();
                if (!line) {
                    continue;
                }
                let parsed;
                try {
                    parsed = JSON.parse(line);
                }
                catch {
                    continue;
                }
                const data = parsed;
                const eventType = typeof data.type === 'string' ? data.type : undefined;
                const payload = data.payload;
                const payloadType = typeof payload?.type === 'string' ? payload.type : undefined;
                const lastAgentMessage = typeof payload?.last_agent_message === 'string'
                    ? payload.last_agent_message
                    : undefined;
                if (eventType === 'event_msg' && payloadType === 'task_complete' && lastAgentMessage?.trim()) {
                    return lastAgentMessage;
                }
            }
        }
        catch {
            // Ignore missing/unreadable files so sync can continue.
        }
        return undefined;
    }
}
//# sourceMappingURL=codex-session-synchronizer.provider.js.map
