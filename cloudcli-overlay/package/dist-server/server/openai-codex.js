/**
 * OpenAI Codex SDK Integration
 * =============================
 *
 * This module provides integration with the OpenAI Codex SDK for non-interactive
 * chat sessions. It mirrors the pattern used in claude-sdk.js for consistency.
 *
 * ## Usage
 *
 * - queryCodex(command, options, ws) - Execute a prompt with streaming via WebSocket
 * - abortCodexSession(sessionId) - Cancel an active session
 * - isCodexSessionActive(sessionId) - Check if a session is running
 * - getActiveCodexSessions() - List all active sessions
 */
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { Codex } from '@openai/codex-sdk';
import { buildCodexInputItems, normalizeImageDescriptors } from './shared/image-attachments.js';
import { notifyRunFailed, notifyRunStopped } from './services/notification-orchestrator.js';
import { sessionsService } from './modules/providers/services/sessions.service.js';
import { providerAuthService } from './modules/providers/services/provider-auth.service.js';
import { providerModelsService } from './modules/providers/services/provider-models.service.js';
import { createCompleteMessage, createNormalizedMessage } from './shared/utils.js';
import { resolveModelProxyRef } from './shared/model-proxies.js';
const activeCodexSessions = new Map();
function resolveCodexPathOverride() {
    const explicitPath = process.env.CLOUDCLI_CODEX_PATH || process.env.CODEX_CLI_PATH;
    if (explicitPath && fs.existsSync(explicitPath)) {
        return explicitPath;
    }
    const resolved = spawnSync('bash', ['-lc', 'command -v codex'], {
        encoding: 'utf8',
        timeout: 5000,
        env: process.env,
    });
    const candidate = resolved.stdout?.trim().split('\n')[0];
    return candidate && fs.existsSync(candidate) ? candidate : undefined;
}
function readCodexConfigModelProvider() {
    try {
        const configPath = path.join(os.homedir(), '.codex', 'config.toml');
        const raw = fs.readFileSync(configPath, 'utf8');
        const match = raw.match(/^\s*model_provider\s*=\s*["']?([^"'\s#]+)["']?/m);
        return match?.[1]?.trim() || null;
    }
    catch {
        return null;
    }
}
function resolveTenantModelProvider() {
    const markerPath = process.env.HOME
        ? `${process.env.HOME}/.codex/.cloudcli-user-managed-auth`
        : null;
    if (!markerPath || !fs.existsSync(markerPath)) {
        return null;
    }
    try {
        const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
        if (marker.provider === 'hooshcode' || marker.provider === 'proxy') {
            return 'hooshcode';
        }
        if (marker.provider === 'openai') {
            return 'openai';
        }
    }
    catch {
        // Older tenant markers represented direct OpenAI authentication.
    }
    return 'openai';
}
function resolveCodexModelProvider() {
    return resolveTenantModelProvider()
        || process.env.CLOUDCLI_CODEX_MODEL_PROVIDER
        || readCodexConfigModelProvider()
        || 'openai';
}
function createCodexClient(modelProviderOverride) {
    const codexPathOverride = resolveCodexPathOverride();
    const options = {
        config: {
            model_provider: modelProviderOverride || resolveCodexModelProvider(),
        },
    };
    if (codexPathOverride) {
        options.codexPathOverride = codexPathOverride;
    }
    return new Codex(options);
}
function readUsageNumber(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
}
function extractCodexTokenBudget(event) {
    const info = event?.info || event?.payload?.info || event?.usage?.info;
    const usage = info?.total_token_usage || event?.usage?.total_token_usage || event?.usage;
    if (!usage || typeof usage !== 'object') {
        return null;
    }
    const inputTokens = readUsageNumber(usage.input_tokens);
    const outputTokens = readUsageNumber(usage.output_tokens);
    const used = readUsageNumber(usage.total_tokens) || inputTokens + outputTokens;
    return {
        used,
        total: readUsageNumber(info?.model_context_window || event?.usage?.model_context_window) || 200000,
        inputTokens,
        outputTokens,
        breakdown: {
            input: inputTokens,
            output: outputTokens,
        },
    };
}
/**
 * Transform Codex SDK event to WebSocket message format
 * @param {object} event - SDK event
 * @returns {object} - Transformed event for WebSocket
 */
function transformCodexEvent(event) {
    // Map SDK event types to a consistent format
    switch (event.type) {
        case 'item.started':
        case 'item.updated':
        case 'item.completed':
            const item = event.item;
            if (!item) {
                return { type: event.type, item: null };
            }
            // Transform based on item type
            switch (item.type) {
                case 'agent_message':
                    return {
                        type: 'item',
                        itemType: 'agent_message',
                        message: {
                            role: 'assistant',
                            content: item.text
                        }
                    };
                case 'reasoning':
                    return {
                        type: 'item',
                        itemType: 'reasoning',
                        message: {
                            role: 'assistant',
                            content: item.text,
                            isReasoning: true
                        }
                    };
                case 'command_execution':
                    return {
                        type: 'item',
                        itemType: 'command_execution',
                        command: item.command,
                        output: item.aggregated_output,
                        exitCode: item.exit_code,
                        status: item.status
                    };
                case 'file_change':
                    return {
                        type: 'item',
                        itemType: 'file_change',
                        changes: item.changes,
                        status: item.status
                    };
                case 'mcp_tool_call':
                    return {
                        type: 'item',
                        itemType: 'mcp_tool_call',
                        server: item.server,
                        tool: item.tool,
                        arguments: item.arguments,
                        result: item.result,
                        error: item.error,
                        status: item.status
                    };
                case 'web_search':
                    return {
                        type: 'item',
                        itemType: 'web_search',
                        query: item.query
                    };
                case 'todo_list':
                    return {
                        type: 'item',
                        itemType: 'todo_list',
                        items: item.items
                    };
                case 'error':
                    return {
                        type: 'item',
                        itemType: 'error',
                        message: {
                            role: 'error',
                            content: item.message
                        }
                    };
                default:
                    return {
                        type: 'item',
                        itemType: item.type,
                        item: item
                    };
            }
        case 'turn.started':
            return {
                type: 'turn_started'
            };
        case 'turn.completed':
            return {
                type: 'turn_complete',
                usage: event.usage
            };
        case 'turn.failed':
            return {
                type: 'turn_failed',
                error: event.error
            };
        case 'thread.started':
            return {
                type: 'thread_started',
                threadId: event.thread_id || event.id
            };
        case 'error':
            return {
                type: 'error',
                message: event.message
            };
        default:
            return {
                type: event.type,
                data: event
            };
    }
}
/**
 * Map permission mode to Codex SDK options
 * @param {string} permissionMode - 'default', 'acceptEdits', or 'bypassPermissions'
 * @returns {object} - { sandboxMode, approvalPolicy }
 */
function mapPermissionModeToCodexOptions(permissionMode) {
    switch (permissionMode) {
        case 'acceptEdits':
            return {
                sandboxMode: 'workspace-write',
                approvalPolicy: 'never'
            };
        case 'bypassPermissions':
            return {
                sandboxMode: 'danger-full-access',
                approvalPolicy: 'never'
            };
        case 'default':
        default:
            return {
                sandboxMode: 'workspace-write',
                approvalPolicy: 'untrusted'
            };
    }
}
/**
 * Execute a Codex query with streaming
 * @param {string} command - The prompt to send
 * @param {object} options - Options including cwd, sessionId, model, permissionMode
 * @param {WebSocket|object} ws - WebSocket connection or response writer
 */
export async function queryCodex(command, options = {}, ws) {
    const { sessionId, sessionSummary, cwd, projectPath, model, effort, images, permissionMode = 'default' } = options;
    const codexCatalog = (await providerModelsService.getProviderModels('codex')).models;
    const resolvedModel = await providerModelsService.resolveSessionRuntimeModel('codex', {
        sessionId,
        requestedModel: model,
        defaultModel: codexCatalog.DEFAULT,
    });
    // A `model@proxyId` reference routes this session through the matching
    // tenant-registered [model_providers.cpx_<id>] block; the thread itself
    // always receives the plain model slug.
    const modelProxyRef = resolveModelProxyRef(resolvedModel, 'codex');
    // A pinned proxy that no longer resolves must fail loudly — silently
    // rerouting the thread to the default provider would burn a quota the
    // user did not choose.
    if (typeof resolvedModel === 'string' && resolvedModel.includes('@') && !modelProxyRef?.proxy) {
        const missingProxyId = resolvedModel.split('@').pop();
        const guardError = new Error(`Model proxy "${missingProxyId}" is no longer registered (it was removed or renamed), so this session cannot stay on it. Re-pick a model for this session or re-add the proxy — CloudCLI will not silently switch this session to another provider.`);
        guardError.cloudcliModelGuard = true;
        throw guardError;
    }
    const threadModel = modelProxyRef?.model || resolvedModel;
    const workingDirectory = cwd || projectPath || process.cwd();
    const { sandboxMode, approvalPolicy } = mapPermissionModeToCodexOptions(permissionMode);
    const catalog = codexCatalog;
    const selectedModel = catalog.OPTIONS.find((option) => option.value === resolvedModel) || null;
    const allowedEfforts = selectedModel?.effort?.values?.map((value) => value.value) || [];
    const resolvedEffort = typeof effort === 'string' && effort !== 'default' && allowedEfforts.includes(effort)
        ? effort
        : undefined;
    let codex;
    let thread;
    let capturedSessionId = sessionId;
    let sessionCreatedSent = false;
    let terminalFailure = null;
    const abortController = new AbortController();
    try {
        codex = createCodexClient(modelProxyRef?.proxy ? `cpx_${modelProxyRef.proxy.id}` : null);
        const threadOptions = {
            workingDirectory,
            skipGitRepoCheck: true,
            sandboxMode,
            approvalPolicy,
            model: threadModel,
            modelReasoningEffort: resolvedEffort,
            webSearchMode: process.env.CLOUDCLI_CODEX_WEB_SEARCH_MODE || 'live',
        };
        if (sessionId) {
            thread = codex.resumeThread(sessionId, threadOptions);
        }
        else {
            thread = codex.startThread(threadOptions);
        }
        const registerSession = (id) => {
            if (!id) {
                return;
            }
            activeCodexSessions.set(id, {
                thread,
                codex,
                status: 'running',
                abortController,
                startedAt: new Date().toISOString()
            });
        };
        if (capturedSessionId) {
            registerSession(capturedSessionId);
            void providerModelsService.recordRuntimeSessionModel('codex', capturedSessionId, resolvedModel);
        }
        // Execute with streaming. Turns with image attachments send structured
        // input items so Codex reads the images from their local asset paths.
        const turnInput = normalizeImageDescriptors(images).length > 0
            ? buildCodexInputItems(command, images, workingDirectory)
            : command;
        const streamedTurn = await thread.runStreamed(turnInput, {
            signal: abortController.signal
        });
        for await (const event of streamedTurn.events) {
            // Capture thread/session id lazily from the stream (Codex emits this asynchronously).
            if (event.type === 'thread.started') {
                const discoveredSessionId = event.thread_id || event.id || null;
                if (discoveredSessionId && !capturedSessionId) {
                    capturedSessionId = discoveredSessionId;
                    registerSession(capturedSessionId);
                    if (!sessionId) {
                        // First turn of a brand-new thread: pin its creation model.
                        void providerModelsService.recordRuntimeSessionModel('codex', capturedSessionId, resolvedModel);
                    }
                    if (ws.setSessionId && typeof ws.setSessionId === 'function') {
                        ws.setSessionId(capturedSessionId);
                    }
                    if (!sessionId && !sessionCreatedSent) {
                        sessionCreatedSent = true;
                        sendMessage(ws, createNormalizedMessage({ kind: 'session_created', newSessionId: capturedSessionId, sessionId: capturedSessionId, provider: 'codex' }));
                    }
                }
            }
            // Check if session was aborted
            if (abortController.signal.aborted) {
                break;
            }
            if (capturedSessionId) {
                const session = activeCodexSessions.get(capturedSessionId);
                if (session?.status === 'aborted') {
                    break;
                }
            }
            if (event.type === 'item.started' || event.type === 'item.updated') {
                continue;
            }
            const transformed = transformCodexEvent(event);
            // Normalize the transformed event into NormalizedMessage(s) via adapter
            const normalizedMsgs = sessionsService.normalizeMessage('codex', transformed, capturedSessionId || sessionId || null);
            for (const msg of normalizedMsgs) {
                sendMessage(ws, msg);
            }
            if (event.type === 'turn.failed' && !terminalFailure) {
                terminalFailure = event.error || new Error('Turn failed');
                notifyRunFailed({
                    userId: ws?.userId || null,
                    provider: 'codex',
                    sessionId: capturedSessionId || sessionId || null,
                    sessionName: sessionSummary,
                    error: terminalFailure
                });
            }
            // Extract and send token usage if available (normalized to match Claude format)
            if (event.type === 'turn.completed') {
                const tokenBudget = extractCodexTokenBudget(event);
                if (tokenBudget) {
                    sendMessage(ws, createNormalizedMessage({ kind: 'status', text: 'token_budget', tokenBudget, sessionId: capturedSessionId || sessionId || null, provider: 'codex' }));
                }
            }
        }
        // Send the terminal completion event — skipped for aborted runs, whose
        // terminal `complete` (aborted: true) was already sent by abort-session.
        const runSession = capturedSessionId ? activeCodexSessions.get(capturedSessionId) : null;
        const runAborted = runSession?.status === 'aborted' || abortController.signal.aborted;
        if (!runAborted) {
            sendMessage(ws, createCompleteMessage({
                provider: 'codex',
                sessionId: capturedSessionId || sessionId || null,
                actualSessionId: capturedSessionId || thread.id || sessionId || null,
                exitCode: terminalFailure ? 1 : 0,
            }));
            if (!terminalFailure) {
                notifyRunStopped({
                    userId: ws?.userId || null,
                    provider: 'codex',
                    sessionId: capturedSessionId || sessionId || null,
                    sessionName: sessionSummary,
                    stopReason: 'completed'
                });
            }
        }
    }
    catch (error) {
        const session = capturedSessionId ? activeCodexSessions.get(capturedSessionId) : null;
        const wasAborted = session?.status === 'aborted' ||
            error?.name === 'AbortError' ||
            String(error?.message || '').toLowerCase().includes('aborted');
        if (!wasAborted) {
            console.error('[Codex] Error:', error);
            // Check if Codex SDK is available for a clearer error message
            const installed = await providerAuthService.isProviderInstalled('codex');
            const errorContent = !installed
                ? 'Codex CLI is not configured. Please set up authentication first.'
                : error.message;
            sendMessage(ws, createNormalizedMessage({ kind: 'error', content: errorContent, sessionId: capturedSessionId || sessionId || null, provider: 'codex' }));
            sendMessage(ws, createCompleteMessage({
                provider: 'codex',
                sessionId: capturedSessionId || sessionId || null,
                exitCode: 1,
            }));
            if (!terminalFailure) {
                notifyRunFailed({
                    userId: ws?.userId || null,
                    provider: 'codex',
                    sessionId: capturedSessionId || sessionId || null,
                    sessionName: sessionSummary,
                    error
                });
            }
        }
    }
    finally {
        // Update session status
        if (capturedSessionId) {
            const session = activeCodexSessions.get(capturedSessionId);
            if (session) {
                session.status = session.status === 'aborted' ? 'aborted' : 'completed';
            }
        }
    }
}
/**
 * Abort an active Codex session
 * @param {string} sessionId - Session ID to abort
 * @returns {boolean} - Whether abort was successful
 */
export function abortCodexSession(sessionId) {
    const session = activeCodexSessions.get(sessionId);
    if (!session) {
        return false;
    }
    session.status = 'aborted';
    try {
        session.abortController?.abort();
    }
    catch (error) {
        console.warn(`[Codex] Failed to abort session ${sessionId}:`, error);
    }
    return true;
}
/**
 * Check if a session is active
 * @param {string} sessionId - Session ID to check
 * @returns {boolean} - Whether session is active
 */
export function isCodexSessionActive(sessionId) {
    const session = activeCodexSessions.get(sessionId);
    return session?.status === 'running';
}
/**
 * Get all active sessions
 * @returns {Array} - Array of active session info
 */
export function getActiveCodexSessions() {
    const sessions = [];
    for (const [id, session] of activeCodexSessions.entries()) {
        if (session.status === 'running') {
            sessions.push({
                id,
                status: session.status,
                startedAt: session.startedAt
            });
        }
    }
    return sessions;
}
/**
 * Helper to send message via WebSocket or writer
 * @param {WebSocket|object} ws - WebSocket or response writer
 * @param {object} data - Data to send
 */
function sendMessage(ws, data) {
    try {
        if (ws.isSSEStreamWriter || ws.isWebSocketWriter) {
            // Writer handles stringification (SSEStreamWriter or WebSocketWriter)
            ws.send(data);
        }
        else if (typeof ws.send === 'function') {
            // Raw WebSocket - stringify here
            ws.send(JSON.stringify(data));
        }
    }
    catch (error) {
        console.error('[Codex] Error sending message:', error);
    }
}
// Clean up old completed sessions periodically
setInterval(() => {
    const now = Date.now();
    const maxAge = 30 * 60 * 1000; // 30 minutes
    for (const [id, session] of activeCodexSessions.entries()) {
        if (session.status !== 'running') {
            const startedAt = new Date(session.startedAt).getTime();
            if (now - startedAt > maxAge) {
                activeCodexSessions.delete(id);
            }
        }
    }
}, 5 * 60 * 1000); // Every 5 minutes
//# sourceMappingURL=openai-codex.js.map
