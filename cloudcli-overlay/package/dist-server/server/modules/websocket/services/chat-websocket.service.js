import path from 'node:path';
import { sessionsDb } from '../../../modules/database/index.js';
import { chatRunRegistry } from '../../../modules/websocket/services/chat-run-registry.service.js';
import { connectedClients, WS_OPEN_STATE } from '../../../modules/websocket/services/websocket-state.service.js';
import { getGlobalImageAssetsDir, normalizeImageDescriptors } from '../../../shared/image-attachments.js';
import { parseIncomingJsonObject } from '../../../shared/utils.js';
/**
 * Trust boundary for client-supplied image attachments: chat.send options come
 * straight from the browser, and the provider runtimes read the referenced
 * files off disk (Claude base64-encodes them into the prompt). Only images
 * that live directly inside the global upload store (`~/.cloudcli/assets`,
 * where POST /api/assets/images puts them) are allowed through — anything
 * else (absolute paths elsewhere, traversal, subdirectories) is dropped.
 *
 * Exported for tests; `assetsRootOverride` exists only for them.
 */
export function filterImagesToUploadStore(images, assetsRootOverride) {
    const assetsRoot = path.resolve(assetsRootOverride ?? getGlobalImageAssetsDir());
    return normalizeImageDescriptors(images).filter((descriptor) => {
        // Relative paths are anchored in the store; absolute ones must already be in it.
        const resolved = path.resolve(assetsRoot, descriptor.path);
        const relative = path.relative(assetsRoot, resolved);
        const isDirectChild = relative.length > 0 &&
            !relative.startsWith('..') &&
            !path.isAbsolute(relative) &&
            !relative.includes(path.sep) &&
            !relative.includes('/');
        if (!isDirectChild) {
            console.warn(`[Chat] Dropping image outside the upload store: ${descriptor.path}`);
        }
        return isDirectChild;
    });
}
/**
 * Extracts the authenticated request user id in the formats currently produced
 * by platform and OSS auth code paths.
 */
function readRequestUserId(request) {
    const user = request?.user;
    if (!user) {
        return null;
    }
    if (typeof user.id === 'string' || typeof user.id === 'number') {
        return user.id;
    }
    if (typeof user.userId === 'string' || typeof user.userId === 'number') {
        return user.userId;
    }
    return null;
}
function sendJson(ws, payload) {
    if (ws.readyState === WS_OPEN_STATE) {
        ws.send(JSON.stringify(payload));
    }
}
/**
 * Reports a protocol-level failure to the requesting client.
 *
 * Protocol errors deliberately use their own `kind` (instead of the provider
 * `error` message kind) so the frontend can distinguish "your request was
 * invalid" from "the model run produced an error" without inspecting text.
 */
/**
 * Polls until the session's run slot frees up, then takes it. Bails when the
 * requesting socket closes (nothing to deliver to) or after a generous cap.
 */
async function waitForRunSlot(runParams, ws, maxWaitMs = 45 * 60 * 1000, pollMs = 500) {
    const startedAt = Date.now();
    let socketClosed = false;
    const onClose = () => { socketClosed = true; };
    ws.once?.('close', onClose);
    try {
        while (!socketClosed && Date.now() - startedAt < maxWaitMs) {
            await new Promise((resolve) => { setTimeout(resolve, pollMs); });
            if (socketClosed) {
                break;
            }
            if (chatRunRegistry.isProcessing(runParams.appSessionId)) {
                continue;
            }
            const run = chatRunRegistry.startRun(runParams);
            if (run) {
                return run;
            }
        }
    }
    finally {
        ws.off?.('close', onClose);
    }
    return null;
}
function sendProtocolError(ws, code, error, sessionId) {
    sendJson(ws, {
        kind: 'protocol_error',
        code,
        error,
        sessionId: sessionId ?? null,
        timestamp: new Date().toISOString(),
    });
}
function readRequiredSessionId(data) {
    const sessionId = typeof data.sessionId === 'string' ? data.sessionId.trim() : '';
    return sessionId.length > 0 ? sessionId : null;
}
function readBranchFromMessageOptions(options) {
    const raw = options.branchFromMessage;
    if (!raw || typeof raw !== 'object') {
        return null;
    }
    const record = raw;
    const forceNewSession = record.forceNewSession === true;
    const context = typeof record.context === 'string' ? record.context.trim() : '';
    if (!forceNewSession && !context) {
        return null;
    }
    return { forceNewSession, context };
}
function buildBranchedCommand(command, branch) {
    if (!branch?.context) {
        return command;
    }
    return [
        '<ccui_branch_context>',
        'You are continuing a branched conversation from an edited earlier user message.',
        'Use only the prior context below and the new user message after this block.',
        'Do not rely on any later turns from the original pre-edit session.',
        '',
        branch.context,
        '</ccui_branch_context>',
        '',
        command,
    ].join('\n');
}
/**
 * Handles `chat.send`: resolves the session row (provider, project path, and
 * provider-native id all come from the database — never from the client),
 * registers the run, and dispatches to the provider runtime.
 */
async function handleChatSend(ws, userId, data, dependencies) {
    const sessionId = readRequiredSessionId(data);
    if (!sessionId) {
        sendProtocolError(ws, 'SESSION_ID_REQUIRED', 'chat.send requires a sessionId.');
        return;
    }
    const session = sessionsDb.getSessionById(sessionId);
    if (!session) {
        sendProtocolError(ws, 'SESSION_NOT_FOUND', `Session "${sessionId}" was not found. Create it via POST /api/providers/sessions first.`, sessionId);
        return;
    }
    const provider = session.provider;
    const spawnFn = dependencies.spawnFns[provider];
    if (!spawnFn) {
        sendProtocolError(ws, 'UNSUPPORTED_PROVIDER', `Provider "${provider}" is not available.`, sessionId);
        return;
    }
    const clientOptions = (data.options ?? {});
    console.log('[Chat] chat.send received', {
        sessionId,
        provider,
        model: typeof clientOptions.model === 'string' ? clientOptions.model : undefined,
        contentPreview: typeof data.content === 'string' ? data.content.slice(0, 60) : undefined,
    });
    const branchFromMessage = readBranchFromMessageOptions(clientOptions);
    const forceNewProviderSession = branchFromMessage?.forceNewSession === true;
    const runParams = {
        appSessionId: sessionId,
        provider,
        providerSessionId: forceNewProviderSession ? null : session.provider_session_id,
        connection: ws,
        userId,
    };
    let run = chatRunRegistry.startRun(runParams);
    if (!run && provider === 'claude') {
        console.warn('[Chat] Run slot busy — waiting for the in-flight run before dispatching.', { sessionId });
        // Interactive Claude turns can stay live for an hour (background
        // workers, long test suites). Rejecting the send made the chat UI
        // keep its optimistic bubble while the message never reached the
        // TUI — messages sent mid-turn silently vanished (2026-10-14, twice).
        // Wait for the in-flight run to finish and take the slot instead:
        // the browser keeps the bubble and the turn runs right after, like
        // the TUI's own local queue.
        run = await waitForRunSlot(runParams, ws);
    }
    if (!run) {
        console.warn('[Chat] waitForRunSlot returned no slot.', { sessionId, provider });
        sendProtocolError(ws, 'RUN_IN_PROGRESS', `Session "${sessionId}" already has a run in progress.`, sessionId);
        return;
    }
    const command = buildBranchedCommand(typeof data.content === 'string' ? data.content : '', branchFromMessage);
    // The provider runtimes receive the provider-native session id (that is the
    // id their CLI/SDK understands for resume). Brand-new sessions have no
    // provider id yet, so the runtime starts fresh and announces one, which the
    // gateway writer captures and maps back to the app session id.
    const runtimeOptions = {
        ...clientOptions,
        // Image attachments are re-validated server-side: only files inside the
        // global upload store may reach the provider runtimes' file reads.
        images: filterImagesToUploadStore(clientOptions.images),
        sessionId: forceNewProviderSession ? undefined : session.provider_session_id ?? undefined,
        resume: forceNewProviderSession ? false : Boolean(session.provider_session_id),
        cwd: clientOptions.cwd ?? session.project_path ?? undefined,
        projectPath: session.project_path ?? clientOptions.projectPath,
    };
    try {
        await spawnFn(command, runtimeOptions, run.writer);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[Chat] Provider runtime "${provider}" failed`, { sessionId, error: message });
    }
    finally {
        // Safety net: a runtime that crashed (or resolved) without emitting its
        // terminal `complete` would otherwise leave the session stuck in
        // "processing" forever on every connected client. Scoped to THIS run —
        // a queued message can start the session's next run before this promise
        // settles, and the session-keyed completeRun would kill that new run.
        chatRunRegistry.completeRunIfCurrent(run, { exitCode: 1 });
    }
}
/**
 * Handles `chat.abort`: cancels the run for one app session and emits the
 * terminal `complete` on its behalf (runtimes skip their own complete for
 * aborted runs, and the registry drops any duplicate).
 */
async function handleChatAbort(ws, data, dependencies) {
    const sessionId = readRequiredSessionId(data);
    if (!sessionId) {
        sendProtocolError(ws, 'SESSION_ID_REQUIRED', 'chat.abort requires a sessionId.');
        return;
    }
    const run = chatRunRegistry.getRun(sessionId);
    if (!run || run.status !== 'running') {
        sendProtocolError(ws, 'NO_ACTIVE_RUN', `Session "${sessionId}" has no active run.`, sessionId);
        return;
    }
    const abortFn = dependencies.abortFns[run.provider];
    let success = false;
    if (abortFn && run.providerSessionId) {
        success = Boolean(await abortFn(run.providerSessionId));
    }
    chatRunRegistry.completeRun(sessionId, {
        exitCode: success ? 0 : 1,
        aborted: true,
    });
}
/**
 * Handles `chat.subscribe`: for each requested session, reports whether a run
 * is processing, re-attaches the live stream to this socket, replays missed
 * events (seq > lastSeq), and includes pending permission requests.
 *
 * This single message replaces the old `check-session-status`,
 * `get-pending-permissions`, and Claude-only writer reconnect flows.
 */
function handleChatSubscribe(ws, data, dependencies) {
    const targets = Array.isArray(data.sessions) ? data.sessions : [];
    for (const target of targets) {
        if (!target || typeof target !== 'object') {
            continue;
        }
        const sessionId = typeof target.sessionId === 'string'
            ? target.sessionId.trim()
            : '';
        if (!sessionId) {
            continue;
        }
        const lastSeqRaw = target.lastSeq;
        const lastSeq = typeof lastSeqRaw === 'number' && Number.isFinite(lastSeqRaw)
            ? Math.max(0, Math.floor(lastSeqRaw))
            : 0;
        const run = chatRunRegistry.getRun(sessionId);
        const isProcessing = chatRunRegistry.isProcessing(sessionId);
        // Future live events for this run should land on the socket that asked —
        // this is what makes mid-stream page refreshes work for all providers.
        if (isProcessing) {
            chatRunRegistry.attachConnection(sessionId, ws);
        }
        // Pending approvals are tracked under the provider-native id inside the
        // Claude runtime; remap their sessionId so the client only sees app ids.
        const pendingPermissions = (run?.providerSessionId
            ? dependencies.getPendingApprovalsForSession(run.providerSessionId)
            : []).map((approval) => approval && typeof approval === 'object'
            ? { ...approval, sessionId }
            : approval);
        sendJson(ws, {
            kind: 'chat_subscribed',
            sessionId,
            isProcessing,
            lastSeq: run?.lastSeq ?? 0,
            pendingPermissions,
            timestamp: new Date().toISOString(),
        });
        // Replay only for RUNNING runs, strictly after the ack. Completed runs
        // are fully persisted to the provider transcript and served over REST —
        // replaying them (e.g. after a page reload where the client's lastSeq is
        // 0) would duplicate messages the history fetch already returned.
        if (isProcessing) {
            for (const event of chatRunRegistry.replayEvents(sessionId, lastSeq)) {
                sendJson(ws, event);
            }
        }
    }
}
/**
 * Handles `chat.permission-response`: forwards a tool-approval decision to the
 * pending approval resolver (Claude is the only provider with interactive
 * approvals today, but the message is intentionally provider-neutral).
 */
function handlePermissionResponse(data, dependencies) {
    if (typeof data.requestId !== 'string' || data.requestId.length === 0) {
        return;
    }
    dependencies.resolveToolApproval(data.requestId, {
        allow: Boolean(data.allow),
        updatedInput: data.updatedInput,
        message: typeof data.message === 'string' ? data.message : undefined,
        rememberEntry: data.rememberEntry,
    });
}
/**
 * Handles authenticated chat websocket messages used by the main chat panel.
 *
 * Inbound protocol (client to server):
 * - `chat.send`                { sessionId, content, options? }
 * - `chat.abort`               { sessionId }
 * - `chat.subscribe`           { sessions: [{ sessionId, lastSeq? }] }
 * - `chat.permission-response` { requestId, allow, updatedInput?, message?, rememberEntry? }
 *
 * Outbound protocol (server to client): every frame is `kind`-based — either
 * a provider `NormalizedMessage` (with `seq`) or a gateway event
 * (`chat_subscribed`, `session_upserted`, `loading_progress`,
 * `protocol_error`).
 */
export function handleChatConnection(ws, request, dependencies) {
    console.log('[INFO] Chat WebSocket connected');
    connectedClients.add(ws);
    const userId = readRequestUserId(request);
    ws.on('message', async (rawMessage) => {
        try {
            const parsed = parseIncomingJsonObject(rawMessage);
            if (!parsed) {
                throw new Error('Invalid websocket payload');
            }
            const data = parsed;
            const messageType = typeof data.type === 'string' ? data.type : '';
            switch (messageType) {
                case 'chat.send':
                    await handleChatSend(ws, userId, data, dependencies);
                    return;
                case 'chat.abort':
                    await handleChatAbort(ws, data, dependencies);
                    return;
                case 'chat.subscribe':
                    handleChatSubscribe(ws, data, dependencies);
                    return;
                case 'chat.permission-response':
                    handlePermissionResponse(data, dependencies);
                    return;
                default:
                    sendProtocolError(ws, 'UNKNOWN_MESSAGE_TYPE', `Unknown message type "${messageType}".`);
                    return;
            }
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.error('[ERROR] Chat WebSocket error:', message);
            sendProtocolError(ws, 'INTERNAL_ERROR', message);
        }
    });
    ws.on('close', () => {
        console.log('[INFO] Chat client disconnected');
        connectedClients.delete(ws);
    });
}
//# sourceMappingURL=chat-websocket.service.js.map
