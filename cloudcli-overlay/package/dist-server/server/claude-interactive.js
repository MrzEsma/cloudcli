/**
 * Interactive Claude runtime (subscription-billed chat).
 *
 * Drives the real Claude Code TUI inside a PTY — the same binary the Shell
 * tab launches, billed to the signed-in Claude subscription instead of the
 * API — and streams the live session transcript
 * (`~/.claude/projects/<project>/<session-id>.jsonl`) back through the
 * gateway writer as normalized messages.
 *
 * It implements the exact `spawnFn(command, options, writer)` contract of
 * `queryClaudeSDK`, so the chat gateway, replay/subscribe, abort bookkeeping,
 * sidebar sync, and history loading all work unchanged. Transcript entries
 * are converted with the existing `sessionsService.normalizeMessage('claude',
 * ...)`, which natively accepts Claude JSONL records.
 *
 * Turn lifecycle: submit the prompt via bracketed paste, tail the transcript
 * until the turn ends (assistant `stop_reason: end_turn`, the
 * `system/turn_duration` marker, or PTY exit), then emit the terminal
 * `complete`. Aborted runs skip their own complete — the gateway's abort
 * handler emits it (same contract as the SDK runtime).
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { promises as fsp } from 'fs';
import { randomUUID } from 'crypto';

// node-pty and the shared message builders are resolved lazily with fallbacks
// so this file works unchanged from (a) the cloudcli package tree, where both
// resolve relative to this file, and (b) a standalone plugins directory, where
// only the server's own install under /app provides them.
let pty = null;
let createCompleteMessage = null;
let createNormalizedMessage = null;
let depsLoading = null;

const PTY_FALLBACK_PATHS = [
    '/app/node_modules/node-pty/lib/index.js',
    '/app/node_modules/@cloudcli-ai/cloudcli/node_modules/node-pty/lib/index.js',
];
const UTILS_FALLBACK_PATHS = [
    '/app/node_modules/@cloudcli-ai/cloudcli/dist-server/server/shared/utils.js',
];

async function importFirst(paths) {
    let lastError = null;
    for (const candidate of paths) {
        try {
            return await import(candidate.startsWith('/') ? `file://${candidate}` : candidate);
        }
        catch (error) {
            lastError = error;
        }
    }
    throw lastError;
}

/** Resolves every external dependency before the first message is sent. */
async function ensureDependenciesReady() {
    if (pty && createCompleteMessage && createNormalizedMessage) {
        return;
    }
    if (!depsLoading) {
        depsLoading = (async () => {
            if (!pty) {
                try {
                    pty = (await import('node-pty')).default;
                }
                catch {
                    pty = (await importFirst(PTY_FALLBACK_PATHS)).default;
                }
            }
            if (!createCompleteMessage) {
                try {
                    ({ createCompleteMessage, createNormalizedMessage } = await import('./shared/utils.js'));
                }
                catch {
                    ({ createCompleteMessage, createNormalizedMessage } = await importFirst(UTILS_FALLBACK_PATHS));
                }
            }
        })();
    }
    await depsLoading;
}

// The normalizer is loaded lazily (never at import time): when this module is
// hot-loaded into a running server from a non-standard location, the static
// import would pull in a second, duplicate database module instance. The live
// server's own `sessionsService.normalizeMessage` is injected instead via
// `__setRuntimeDependencies`; the lazy dynamic import below only fires for
// standalone use, where a private DB connection is harmless.
let injectedNormalizeMessage = null;
let sessionsServiceModule = null;
let sessionsServiceLoading = null;
/** Sync normalizer access once warmed; null until the first turn starts. */
function getNormalizeMessage() {
    if (typeof injectedNormalizeMessage === 'function') {
        return injectedNormalizeMessage;
    }
    if (sessionsServiceModule) {
        return (provider, entry, sessionId) => sessionsServiceModule.sessionsService.normalizeMessage(provider, entry, sessionId);
    }
    return null;
}
/** Called before the first turn so the lazy import is done up front. */
async function ensureNormalizerReady() {
    if (injectedNormalizeMessage || sessionsServiceModule) {
        return;
    }
    if (!sessionsServiceLoading) {
        sessionsServiceLoading = importFirst([
            './modules/providers/services/sessions.service.js',
            '/app/node_modules/@cloudcli-ai/cloudcli/dist-server/server/modules/providers/services/sessions.service.js',
        ]).then((module) => { sessionsServiceModule = module; });
    }
    await sessionsServiceLoading;
}
/**
 * Dependency injection seam for hot-patch/bridge deployment: lets the live
 * server pass its own singletons instead of this module instantiating copies.
 */
export function __setRuntimeDependencies(deps = {}) {
    if (typeof deps.normalizeMessage === 'function') {
        injectedNormalizeMessage = deps.normalizeMessage;
    }
}

const PROVIDER = 'claude';
/** Idle PTY keepalive, mirroring the shell service convention. */
const PTY_SESSION_TIMEOUT_MS = 30 * 60 * 1000;
const TUI_READY_TIMEOUT_MS = 60 * 1000;
/** No transcript movement for this long during a turn => surface an error. */
const TURN_WATCHDOG_MS = 10 * 60 * 1000;
const TRANSCRIPT_POLL_MS = 250;
/** Delay between the bracketed paste and the submitting carriage return. */
const SUBMIT_SETTLE_MS = 400;
/**
 * Slash commands run locally in the TUI and may write no turn marker at all;
 * finish their run after a quiet period instead of waiting for the watchdog.
 */
const SLASH_TURN_QUIET_MS = 15 * 1000;
/**
 * A submitted prompt shows up in the transcript within a second. If it has
 * not after this long, the TUI never accepted the submit — retry the Enter
 * once (the paste may have landed without it), then give up with a diagnostic
 * instead of waiting out the full watchdog.
 */
const SUBMIT_RETRY_MS = 10 * 1000;
const SUBMIT_GIVEUP_MS = 30 * 1000;
/**
 * The TUI can stamp end_turn on the first deliverable row while more of the
 * turn is still coming (a second response for queued input lands tens of
 * seconds later, before the turn_duration marker). After a deliverable
 * end_turn row, wait this long for further growth before finishing the run;
 * the turn_duration marker finishes it immediately.
 */
const TURN_FINALIZE_QUIET_MS = 12 * 1000;
/**
 * Between user turns the TUI still runs its own turns (background-task
 * notifications are submitted natively). This tail keeps streaming transcript
 * growth to the connected chat client so that work is visible live instead
 * of appearing only after the next user message.
 */
const BACKGROUND_TAIL_MS = 1000;
/** During a run, reassure the client every so often while the transcript is silent (long tools). */
const RUN_SILENCE_HEARTBEAT_AFTER_MS = 45 * 1000;
const RUN_SILENCE_HEARTBEAT_EVERY_MS = 30 * 1000;
/**
 * The TUI's thinking-spinner verbs. Their frames flood the screen buffer
 * during a live generation, which pushes the footer's esc-to-interrupt hint
 * out of the diagnostic tail — so generation must be detected by the verbs
 * themselves. A spinning screen means the model request is alive (one very
 * long thinking block can stream for many minutes without a completed
 * transcript row); interrupting it destroys real work (2026-10-17: two
 * sessions were interrupted mid-thought every 10 minutes and their answers
 * came out broken).
 */
const TUI_GENERATING_SPINNER_PATTERN = /crystallizing|undulating|analyzing|pondering|processing|synthesizing|thinking|calculating|deliberating|contemplating|distilling|mulling|ruminating|scheming|weaving|forging|crafting|deciphering|percolating|simmering|stewing|brewing|cooking|concocting|conjuring|finessing|germinating|hatching|incubating|marinating|noodling|puttering|reticulating|transmuting|unraveling|wrangling|divining|elucidating|envisioning|inferring|ideating|manifesting|coalescing|churning|charting|channelling|composing|creating|crunching|determining|discerning|effectuating|fermenting|forming|generating|herding|mustering|musing|sculpting|smoothing|spinning/i;
/** Live generations extend the watchdog this many times before recovery may interrupt. */
const MAX_WATCHDOG_EXTENSIONS = 3;
function isTuiGenerating(session) {
    const screen = normalizeScreenText(session.output);
    return GENERATING_PATTERN.test(screen) || TUI_GENERATING_SPINNER_PATTERN.test(screen);
}
/**
 * A hung model request has a recognizable signature: the last transcript row
 * is a tool RESULT (so the pending step is a model request, not a tool) and
 * nothing follows. Likely a dropped connection through the subscription
 * gateway (2026-10-14: one turn hung for 90 minutes this way). Interrupt and
 * resubmit after this long instead of burning the full watchdog.
 */
const HUNG_REQUEST_AFTER_MS = 4 * 60 * 1000;
/** After an interrupt, wait this long for the TUI to settle before resubmitting. */
const INTERRUPT_SETTLE_MS = 25 * 1000;
/** Auto-recovery attempts per run before giving up with the timeout error. */
const TURN_RECOVERY_MAX = 2;
/** Rolling size of the ANSI-stripped output tail kept for diagnostics. */
const OUTPUT_TAIL_CHARS = 4000;

/** Verbose lifecycle tracing behind CLOUDCLI_INTERACTIVE_DEBUG=1. */
const DEBUG = process.env.CLOUDCLI_INTERACTIVE_DEBUG === '1';
function debugLog(event, data) {
    if (!DEBUG) {
        return;
    }
    console.error(`[claude-interactive:debug] ${event}${data === undefined ? '' : ` ${JSON.stringify(data)}`}`);
}

/**
 * The TUI positions words with cursor-move escapes instead of spaces, so a
 * plain ANSI strip glues words together ("Quicksafetycheck:Isthisaproject...").
 * Every screen-matching pattern below is therefore written against
 * whitespace-stripped text via `normalizeScreenText`.
 */
// The idle status line's mode hint ("bypass permissions on (shift+tab to
// cycle)", "auto mode on (shift+tab to cycle)") is the most stable
// ready-screen signature across TUI versions — the mode wording changes,
// the "(shift+tab to cycle)" suffix does not.
const TUI_READY_PATTERN = /\/effort|esctointerrupt|automodeon\(shift\+tabtocycle\)|\(shift\+tabtocycle\)|try"(howdoes|refactor|write)/i;
const TUI_RESUME_FAILURE_PATTERN = /noconversationfound|sessionnotfound|doesnotexist|noconversationsfound/i;
/** The "Quick safety check" folder-trust dialog newer TUI versions show. */
const TRUST_DIALOG_PATTERN = /quicksafetycheck|isthisaprojectyoucreatedoroneyoutrust|yes,itrustthisfolder/i;
/**
 * The bypass-permissions acceptance warning the TUI shows at startup when the
 * session is launched with `--permission-mode bypassPermissions` (the GUI's
 * "skip permission prompts" setting). It defaults to "No, exit", so it must
 * be answered explicitly or every skip-permissions chat times out on boot.
 */
const BYPASS_ACCEPT_DIALOG_PATTERN = /bypasspermissionsmode|youacceptallresponsibility|yes,?iaccept\b/i;

/**
 * First-run onboarding screens (theme picker with the demo diff, "Welcome to
 * Claude Code"). They appear only when ~/.claude.json lacks onboarding flags —
 * e.g. a fresh home directory — and are dismissed with Enter.
 */
const ONBOARDING_PATTERN = /syntax\s*theme[^\n]*ctrl\+t|hello,?\s*claude!?|welcome\s*to\s*claude\s*code/i;
const MAX_ONBOARDING_ANSWERS = 4;
/**
 * The resume-cost confirmation the TUI shows for large, inactive conversations
 * when resuming (`Resume this conversation? … 922.8k tokens long … 1. Resume
 * 2. Start a new conversation`). Option 1 ("Resume") is preselected, so a bare
 * Enter continues the conversation — exactly what a chat send asked for.
 */
const RESUME_DIALOG_PATTERN = /resumethisconversation|startanewconversation|resumingitwilluse/i;
/** Selection marker directly on the accept option (numbered or plain). */
const TRUST_YES_SELECTED_PATTERN = /❯\s*(?:[12][.\s]*\n?\s*)?yes,?itrustthisfolder/i;
/** Selection marker directly on the cancel option. */
const TRUST_NO_SELECTED_PATTERN = /❯\s*(?:[12][.\s]*\n?\s*)?no,?exit/i;
/**
 * Selection markers on the bypass-permissions warning options. Numbered and
 * unnumbered variants both exist across TUI versions ("❯1.No,exit
 * 2.Yes,Iaccept" vs "❯No,exit Yes,Iaccept") — same shape as the trust
 * dialog's patterns.
 */
const BYPASS_ACCEPT_SELECTED_PATTERN = /❯\s*(?:[12][.\s]*\n?\s*)?yes,?iaccept/i;
const BYPASS_CANCEL_SELECTED_PATTERN = /❯\s*(?:[12][.\s]*\n?\s*)?no,?exit/i;
/** The TUI's tool-permission dialog ("Claude needs your permission to use …"). */
const PERMISSION_DIALOG_PATTERN = /claudeneedsyourpermission|claudewantstouseyourbrowser/i;
/** Status-line hint shown only while the model is generating a response. */
const GENERATING_PATTERN = /esctointerrupt/i;
const TURN_END_STOP_REASONS = new Set(['end_turn', 'stop_sequence']);
/** Permission modes the TUI accepts via `--permission-mode`. */
const TUI_PERMISSION_MODES = new Set(['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan']);
/**
 * A turn whose transcript stalls this long while the permission dialog is on
 * screen is waiting for an approval this GUI cannot display: fail it with an
 * actionable message instead of burning the full watchdog.
 */
const PERMISSION_DIALOG_STALL_MS = 45 * 1000;

/** providerSessionId -> live PTY session state. */
const interactiveSessions = new Map();

/**
 * Interactive mode is on by default; `CLOUDCLI_CLAUDE_INTERACTIVE=0` is the
 * kill switch that restores the SDK (API-billed) runtime.
 */
export function isClaudeInteractiveEnabled() {
    return process.env.CLOUDCLI_CLAUDE_INTERACTIVE !== '0';
}

/**
 * Chat gateway spawnFn: runs one conversational turn in the interactive TUI.
 * Resolves when the turn ends and the terminal `complete` has been emitted.
 */
export async function queryInteractiveClaude(command, options = {}, ws) {
    await ensureDependenciesReady();
    const projectPath = String(options.projectPath || options.cwd || process.cwd()).trim();
    const existingProviderSessionId = typeof options.sessionId === 'string' && options.sessionId.trim()
        ? options.sessionId.trim()
        : null;
    if (existingProviderSessionId && !/^[a-zA-Z0-9-]+$/.test(existingProviderSessionId)) {
        ws.send(createNormalizedMessage({ kind: 'error', content: 'Invalid Claude session id.', sessionId: existingProviderSessionId, provider: PROVIDER }));
        ws.send(createCompleteMessage({ provider: PROVIDER, sessionId: existingProviderSessionId, exitCode: 1 }));
        return;
    }
    const providerSessionId = existingProviderSessionId || randomUUID();
    await ensureNormalizerReady();
    // Announce the provider-native id immediately so the gateway binds the app
    // session row (DB mapping + sidebar upsert) before the first byte streams.
    ws.setSessionId(providerSessionId);
    const fail = (content) => {
        ws.send(createNormalizedMessage({ kind: 'error', content, sessionId: providerSessionId, provider: PROVIDER }));
        ws.send(createCompleteMessage({ provider: PROVIDER, sessionId: providerSessionId, exitCode: 1 }));
    };
    if (!command || !command.trim()) {
        ws.send(createCompleteMessage({ provider: PROVIDER, sessionId: providerSessionId, exitCode: 0 }));
        return;
    }
    if (!fs.existsSync(projectPath)) {
        fail(`Project path does not exist: ${projectPath}`);
        return;
    }
    try {
        acceptProjectTrust(projectPath, options.claudeConfigDir);
    }
    catch (error) {
        // Non-fatal: worst case the TUI shows its trust dialog and the ready
        // timeout below surfaces it.
        console.warn('[claude-interactive] Could not pre-accept project trust', { projectPath, error: String(error?.message || error) });
    }
    let session = interactiveSessions.get(providerSessionId);
    if (session && session.exited) {
        disposeSession(session);
        session = null;
    }
    if (session && session.busy) {
        // A send during a live turn used to fail. Combined with the chat
        // gateway's run-slot rejection that made messages silently vanish
        // (the UI kept its optimistic bubble while the text never reached
        // the TUI). The gateway now waits for the slot; the runtime queues
        // any racing dispatch and runs it as the very next turn.
        await new Promise((resolve) => {
            session.pendingTurns.push({ command, options, ws, resolve });
        });
        return;
    }
    if (!session) {
        try {
            session = await spawnTuiSession({
                providerSessionId,
                projectPath,
                resume: Boolean(existingProviderSessionId) && options.resume !== false,
                permissionMode: resolvePermissionMode(options),
                claudeConfigDir: typeof options.claudeConfigDir === 'string' && options.claudeConfigDir.trim()
                    ? options.claudeConfigDir.trim()
                    : null,
                forwardModel: typeof options.claudeModel === 'string' && options.claudeModel.trim()
                    ? options.claudeModel.trim()
                    : null,
            });
        }
        catch (error) {
            fail(error instanceof Error ? error.message : String(error));
            return;
        }
        interactiveSessions.set(providerSessionId, session);
    }
    session.busy = true;
    session.abortRequested = false;
    try {
        await runTurn(session, command, options, ws);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const account = options.claudeConfigDir ? 'personal Claude account' : 'Claude team account';
        console.error('[claude-interactive] Turn failed', { providerSessionId, account, error: message });
        fail(`Interactive Claude run failed on the ${account}: ${message}`);
    }
    finally {
        session.busy = false;
        armIdleTimer(session);
        startBackgroundTail(session);
        drainPendingTurns(session);
    }
}

/**
 * Runs the next queued turn (a dispatch that arrived while another turn was
 * live). One at a time, FIFO, mirroring how the TUI drains its own queue.
 */
function drainPendingTurns(session) {
    if (session.busy || session.exited || session.pendingTurns.length === 0) {
        return;
    }
    const next = session.pendingTurns.shift();
    session.busy = true;
    session.abortRequested = false;
    (async () => {
        try {
            if (typeof next.ws?.setSessionId === 'function') {
                next.ws.setSessionId(session.providerSessionId);
            }
            await runTurn(session, next.command, next.options, next.ws);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.error('[claude-interactive] Queued turn failed', { providerSessionId: session.providerSessionId, error: message });
            try {
                next.ws?.send(createNormalizedMessage({ kind: 'error', content: `Interactive Claude run failed: ${message}`, sessionId: session.providerSessionId, provider: PROVIDER }));
                next.ws?.send(createCompleteMessage({ provider: PROVIDER, sessionId: session.providerSessionId, exitCode: 1 }));
            }
            catch { /* socket gone */ }
        }
        finally {
            session.busy = false;
            armIdleTimer(session);
            startBackgroundTail(session);
            drainPendingTurns(session);
            next.resolve();
        }
    })();
}

/**
 * Aborts the in-flight turn of an interactive session by sending Esc (the
 * TUI's interrupt key). The PTY stays alive for the next message.
 */
export async function abortInteractiveClaudeSession(providerSessionId) {
    const session = interactiveSessions.get(providerSessionId);
    if (!session || session.exited) {
        return false;
    }
    session.abortRequested = true;
    clearTurnFinalizer(session);
    try {
        session.pty.write('\x1b');
    }
    catch (error) {
        console.warn('[claude-interactive] Esc write failed', { providerSessionId, error: String(error?.message || error) });
    }
    // Resolve the in-flight turn without emitting our own complete — the
    // gateway's abort handler emits the aborted one (SDK contract).
    finishTurn(session, { kind: 'aborted', exitCode: 0 });
    return true;
}

// ---------------------------------------------------------------------------
// PTY session lifecycle
// ---------------------------------------------------------------------------

/**
 * Personal (oauth) sessions must run the NEWEST iclaude-managed Claude binary,
 * not the image's older bundled claude that PATH resolves. The old TUI's
 * paste/dialog quirks silently eat automated submits (2026-10-17: a turn sat
 * "thinking" for 10 minutes with zero tokens because 2.1.241 never accepted
 * the pasted prompt). Team sessions keep plain `claude` — the runtime wrapper
 * owns their auth.
 */
function resolveTuiClaudeBinary(claudeConfigDir) {
    if (!claudeConfigDir) {
        return 'claude';
    }
    try {
        const iclaudeDir = path.join(os.homedir(), '.local', 'share', 'iclaude');
        const versions = fs.readdirSync(iclaudeDir)
            .filter((name) => /^\d+\.\d+\.\d+$/.test(name))
            .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
        for (let i = versions.length - 1; i >= 0; i -= 1) {
            const candidate = path.join(iclaudeDir, versions[i], 'claude');
            try {
                if (fs.statSync(candidate).isFile()) {
                    return JSON.stringify(candidate); // quoted for the bash -c command line
                }
            }
            catch { /* try the next version */ }
        }
    }
    catch { /* no iclaude installs: fall through */ }
    return 'claude';
}
// Desktop (Windows) bundles ship no bash: resolve the Claude Code cli.js
// entry and run it through this server's own Node binary under ConPTY.
// Order: explicit override → sibling package next to this one → cwd layout.
function resolveTuiClaudeScript() {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const pkgRoot = path.resolve(here, '../../..');
    const appRoot = path.resolve(pkgRoot, '../..');
    const candidates = [
        process.env.CLOUDCLI_CLAUDE_ENTRY_JS,
        path.join(appRoot, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js'),
        path.join(pkgRoot, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js'),
        path.join(process.cwd(), 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js'),
    ].filter(Boolean);
    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) {
            return candidate;
        }
    }
    throw new Error('Claude Code cli.js entry not found (set CLOUDCLI_CLAUDE_ENTRY_JS).');
}
async function spawnTuiSession({ providerSessionId, projectPath, resume, permissionMode, claudeConfigDir, forwardModel }) {
    // Forward the GUI's permission selection so tool use behaves the same as
    // the stock SDK path; unset/default keeps the TUI's own default mode.
    const modeArg = permissionMode ? ` --permission-mode ${permissionMode}` : '';
    // Forward the picked model so the TUI runs what the user selected instead
    // of its own default (aliases and catalog ids only — never shell input).
    const modelArg = typeof forwardModel === 'string' && /^[a-zA-Z0-9._\[\]-]+$/.test(forwardModel)
        ? ` --model ${forwardModel}`
        : '';
    const claudeBin = resolveTuiClaudeBinary(claudeConfigDir);
    let ptyProcess;
    try {
        if (process.platform === 'win32') {
            // No bash on a stock Windows install (Desktop bundle): run the
            // CLI entry through this server's own Node binary under ConPTY.
            // Argument values are ids and validated catalog names, so an argv
            // array carries them without any shell re-parsing.
            const claudeScript = resolveTuiClaudeScript();
            const claudeArgs = [
                resume ? '--resume' : '--session-id',
                providerSessionId,
                ...(permissionMode ? ['--permission-mode', permissionMode] : []),
                ...(modelArg ? ['--model', forwardModel] : []),
            ];
            ptyProcess = pty.spawn(process.execPath, [claudeScript, ...claudeArgs], {
                name: 'xterm-256color',
                cols: 120,
                rows: 40,
                cwd: projectPath,
                env: buildPtyEnv(claudeConfigDir),
            });
            debugLog('spawn', { claudeScript, claudeArgs, pid: ptyProcess.pid, projectPath });
        }
        else {
            const claudeCommand = resume
                ? `${claudeBin} --resume "${providerSessionId}"${modeArg}${modelArg}`
                : `${claudeBin} --session-id "${providerSessionId}"${modeArg}${modelArg}`;
            ptyProcess = pty.spawn('bash', ['-c', claudeCommand], {
                name: 'xterm-256color',
                cols: 120,
                rows: 40,
                cwd: projectPath,
                env: buildPtyEnv(claudeConfigDir),
            });
            debugLog('spawn', { claudeCommand, pid: ptyProcess.pid, projectPath });
        }
    }
    catch (error) {
        throw new Error(`Failed to spawn Claude Code: ${error instanceof Error ? error.message : String(error)}`);
    }
    const session = {
        providerSessionId,
        projectPath,
        claudeConfigDir: claudeConfigDir || null,
        pty: ptyProcess,
        exited: false,
        exitCode: null,
        output: '',
        transcriptPath: null,
        tailOffset: 0,
        busy: false,
        abortRequested: false,
        activeWriter: null,
        finishTurn: null,
        tailTimer: null,
        watchdogTimer: null,
        idleTimer: null,
        finalizeTimer: null,
        backgroundTailTimer: null,
        pendingTurns: [],
        lastHeartbeatAt: 0,
        turnRecovering: false,
        turnRecoveries: 0,
        sawModelRequestPending: false,
        isSlashTurn: false,
        turnSubmittedAt: 0,
        lastGrowthAt: 0,
        trustAnswered: false,
        turnCount: 0,
        turnSawGrowth: false,
        submitRetried: false,
        lastTurnWasSlash: false,
        lastPasteText: '',
    };
    ptyProcess.onData((chunk) => {
        session.output = (session.output + stripAnsiSequences(chunk)).slice(-OUTPUT_TAIL_CHARS);
    });
    ptyProcess.onExit(({ exitCode }) => {
        session.exited = true;
        session.exitCode = typeof exitCode === 'number' ? exitCode : null;
        // Mid-turn exits end the run; the outcome carries the TUI's exit code.
        finishTurn(session, { kind: 'exited', exitCode: session.exitCode === 0 ? 0 : 1 });
        disposeSession(session);
    });
    try {
        await waitForTuiReady(session);
    }
    catch (error) {
        // Never leave a half-started TUI running: an orphaned PTY parked on a
        // dialog would leak until the container restarts.
        try { session.pty.kill(); } catch { /* already gone */ }
        if (resume && error instanceof Error && TUI_RESUME_FAILURE_PATTERN.test(error.message)) {
            // The transcript for this id does not exist under this config dir
            // (e.g. a scheduled run created the session on another account's
            // directory). The user's message must still go through: start a
            // fresh TUI with the same session id. History stays in the old
            // transcript; the conversation continues from this turn.
            debugLog('resume-missed-fresh-start', { providerSessionId, claudeConfigDir });
            return spawnTuiSession({
                providerSessionId,
                projectPath,
                resume: false,
                permissionMode,
                claudeConfigDir,
                forwardModel,
            });
        }
        throw error;
    }
    // Tail only entries written from now on; resumed sessions keep their
    // history in the transcript and the frontend loads it via fetchHistory.
    session.transcriptPath = findTranscriptPath(providerSessionId, claudeConfigDir);
    if (session.transcriptPath) {
        try {
            session.tailOffset = fs.statSync(session.transcriptPath).size;
        }
        catch {
            session.tailOffset = 0;
        }
    }
    debugLog('transcript-at-spawn', { transcriptPath: session.transcriptPath, tailOffset: session.tailOffset });
    return session;
}

function waitForTuiReady(session) {
    return new Promise((resolve, reject) => {
        const startedAt = Date.now();
        const timer = setInterval(() => {
            const screen = normalizeScreenText(session.output);
            if (TUI_RESUME_FAILURE_PATTERN.test(screen)) {
                clearInterval(timer);
                reject(new Error(`Claude Code could not resume session ${session.providerSessionId}. ${diagnosticTail(session)}`));
            }
            else if (TUI_READY_PATTERN.test(screen)) {
                clearInterval(timer);
                debugLog('tui-ready', { atMs: Date.now() - startedAt, screenTail: screen.slice(-300) });
                resolve();
            }
            else if (!session.trustAnswered && TRUST_DIALOG_PATTERN.test(screen)) {
                answerTrustDialog(session, screen);
            }
            else if (!session.bypassAcceptAnswered && BYPASS_ACCEPT_DIALOG_PATTERN.test(screen)) {
                answerBypassAcceptDialog(session, screen);
            }
            else if (!session.resumeDialogAnswered && RESUME_DIALOG_PATTERN.test(screen)) {
                answerResumeDialog(session, screen);
            }
            else if ((session.onboardingAnswers ?? 0) < MAX_ONBOARDING_ANSWERS && ONBOARDING_PATTERN.test(screen)) {
                session.onboardingAnswers = (session.onboardingAnswers ?? 0) + 1;
                try {
                    session.pty.write('\r');
                    console.log('[claude-interactive] Advanced past a TUI onboarding screen (enter).');
                }
                catch { /* PTY gone; the exited branch handles it */ }
            }
            else if (session.exited) {
                clearInterval(timer);
                reject(new Error(`Claude Code exited before its interface was ready. ${diagnosticTail(session)}`));
            }
            else if (Date.now() - startedAt > TUI_READY_TIMEOUT_MS) {
                clearInterval(timer);
                reject(new Error('Timed out waiting for the Claude Code interface to start. ' + diagnosticTail(session)));
            }
        }, 250);
    });
}

/**
 * Newer TUI versions sometimes still show the folder-trust "Quick safety
 * check" dialog for fresh projects even with `hasTrustDialogAccepted` set
 * (observed with the auto-updating 2.1.296 install behind iclaude). Answer it
 * on the user's behalf: the GUI only ever opens sessions in project paths the
 * user explicitly picked, so accepting matches the old pre-accept behavior.
 * The dialog defaults to "No, exit", so the cancel selection needs an
 * arrow-down before Enter — a bare Enter would exit the TUI.
 */
function answerTrustDialog(session, screen) {
    session.trustAnswered = true;
    try {
        if (TRUST_NO_SELECTED_PATTERN.test(screen)) {
            session.pty.write('\x1b[B'); // arrow down onto "Yes, I trust this folder"
            setTimeout(() => {
                try { session.pty.write('\r'); } catch { /* PTY gone */ }
            }, 250);
            console.log('[claude-interactive] Answered the folder-trust dialog (arrow-down + enter).');
        }
        else {
            session.pty.write('\r'); // "Yes, I trust this folder" is already selected
            console.log('[claude-interactive] Answered the folder-trust dialog (enter).');
        }
    }
    catch (error) {
        console.warn('[claude-interactive] Failed to answer the trust dialog', { error: String(error?.message || error) });
    }
}

/**
 * Answers the resume-cost confirmation with Enter: "1. Resume" is the
 * preselected default and matches the user's intent (they sent a message into
 * this conversation). The dialog can reappear on a later resume after the PTY
 * is recreated, so the latch resets whenever the dialog is not on screen.
 */
function answerResumeDialog(session, screen) {
    session.resumeDialogAnswered = true;
    try {
        session.pty.write('\r'); // "1. Resume" is already selected
        console.log('[claude-interactive] Answered the resume-cost dialog (enter → Resume).');
    }
    catch (error) {
        console.warn('[claude-interactive] Failed to answer the resume dialog', { error: String(error?.message || error) });
    }
}

/**
 * Answers the bypass-permissions acceptance warning. Same shape as the trust
 * dialog: the cursor starts on "No, exit", so it needs an arrow-down before
 * Enter. Accepting implements exactly what the GUI's "skip permission
 * prompts" setting asks for — the SDK runtime honored the same setting
 * silently.
 */
function answerBypassAcceptDialog(session, screen) {
    session.bypassAcceptAnswered = true;
    try {
        if (BYPASS_CANCEL_SELECTED_PATTERN.test(screen) && !BYPASS_ACCEPT_SELECTED_PATTERN.test(screen)) {
            session.pty.write('\x1b[B'); // arrow down onto "Yes, I accept"
            setTimeout(() => {
                try { session.pty.write('\r'); } catch { /* PTY gone */ }
            }, 250);
            console.log('[claude-interactive] Answered the bypass-permissions warning (arrow-down + enter).');
        }
        else {
            session.pty.write('\r'); // "Yes, I accept" is already selected
            console.log('[claude-interactive] Answered the bypass-permissions warning (enter).');
        }
    }
    catch (error) {
        console.warn('[claude-interactive] Failed to answer the bypass-permissions warning', { error: String(error?.message || error) });
    }
}

/**
 * Maps the GUI's permission selection (same options the SDK runtime reads) to
 * the TUI's `--permission-mode` flag. `default` means the TUI's own default;
 * the account-level skipPermissions setting wins unless plan mode is set,
 * mirroring `mapCliOptionsToSDK` in claude-sdk.js.
 */
function resolvePermissionMode(options = {}) {
    const requested = typeof options.permissionMode === 'string' ? options.permissionMode.trim() : '';
    if (options.toolsSettings?.skipPermissions && requested !== 'plan') {
        return 'bypassPermissions';
    }
    if (!requested || requested === 'default') {
        return null;
    }
    return TUI_PERMISSION_MODES.has(requested) ? requested : null;
}

function disposeSession(session) {
    if (session.tailTimer) {
        clearInterval(session.tailTimer);
        session.tailTimer = null;
    }
    if (session.watchdogTimer) {
        clearTimeout(session.watchdogTimer);
        session.watchdogTimer = null;
    }
    if (session.idleTimer) {
        clearTimeout(session.idleTimer);
        session.idleTimer = null;
    }
    clearTurnFinalizer(session);
    stopBackgroundTail(session);
    interactiveSessions.delete(session.providerSessionId);
}

function armIdleTimer(session) {
    if (session.idleTimer) {
        clearTimeout(session.idleTimer);
    }
    if (session.exited) {
        return;
    }
    session.idleTimer = setTimeout(() => {
        if (session.exited || session.busy) {
            return;
        }
        try {
            session.pty.write('\x1b[200~/exit\x1b[201~');
            setTimeout(() => {
                try {
                    session.pty.kill();
                }
                catch { /* already gone */ }
            }, 2000).unref?.();
        }
        catch { /* already gone */ }
    }, PTY_SESSION_TIMEOUT_MS);
}

// ---------------------------------------------------------------------------
// Turn execution
// ---------------------------------------------------------------------------

async function runTurn(session, command, options, ws) {
    if (session.exited) {
        throw new Error(`Claude Code exited unexpectedly. ${diagnosticTail(session)}`);
    }
    session.activeWriter = ws;
    session.isSlashTurn = command.trim().startsWith('/');
    session.turnSubmittedAt = Date.now();
    session.lastGrowthAt = session.turnSubmittedAt;
    session.turnSawGrowth = false;
    session.submitRetried = false;
    session.turnRecovering = false;
    session.turnRecoveries = 0;
    session.watchdogExtensions = 0;
    session.sawModelRequestPending = false;
    debugLog('turn-start', {
        commandPreview: command.slice(0, 80),
        isSlashTurn: session.isSlashTurn,
        turnCount: session.turnCount,
    });
    const pasteText = await buildPasteText(command, options, session.projectPath);
    session.lastPasteText = pasteText;
    // Dismiss a leftover overlay from the previous turn (a slash command like
    // /model leaves its picker open) so the paste lands in the prompt. Only
    // then — an Esc anywhere else risks the TUI's double-Esc "backtrack"
    // menu, which would swallow the paste.
    const needsOverlayDismiss = session.lastTurnWasSlash === true;
    session.lastTurnWasSlash = session.isSlashTurn;
    if (needsOverlayDismiss) {
        session.pty.write('\x1b');
        await delay(600); // stay clear of the double-Esc backtrack window
    }
    session.turnCount += 1;
    session.pty.write(`\x1b[200~${pasteText}\x1b[201~`);
    await delay(SUBMIT_SETTLE_MS);
    session.pty.write('\r');
    debugLog('submitted', { pasteChars: pasteText.length, dismissedOverlay: needsOverlayDismiss });
    stopBackgroundTail(session);
    const outcome = await new Promise((resolve) => {
        session.finishTurn = (value) => {
            session.finishTurn = null;
            resolve(value);
        };
        startTailPolling(session);
        armTurnWatchdog(session);
    });
    stopTurnTimers(session);
    // Aborted runs never emit their own complete: the gateway's abort handler
    // already emitted the aborted one (exactly-one-complete contract).
    if (!session.abortRequested) {
        if (outcome.kind === 'timeout') {
            ws.send(createNormalizedMessage({
                kind: 'error',
                content: 'Interactive Claude timed out waiting for the turn to finish (auto-recovery attempts exhausted). If Claude was waiting for a permission dialog, answer it from the Shell tab or enable auto permission mode. ' + diagnosticTail(session),
                sessionId: session.providerSessionId,
                provider: PROVIDER,
            }));
        }
        else if (outcome.kind === 'exited' && outcome.exitCode !== 0) {
            ws.send(createNormalizedMessage({
                kind: 'error',
                content: `Claude Code exited unexpectedly. ${diagnosticTail(session)}`,
                sessionId: session.providerSessionId,
                provider: PROVIDER,
            }));
        }
        else if (outcome.kind === 'not_submitted') {
            ws.send(createNormalizedMessage({
                kind: 'error',
                content: `Claude Code never accepted the submitted message. ${diagnosticTail(session)}`,
                sessionId: session.providerSessionId,
                provider: PROVIDER,
            }));
            // A TUI that never accepted the prompt is left with the paste in
            // its composer — every later send pastes on top of it. Dispose it
            // so the next message starts from a clean spawn.
            try { session.pty.write('\x1b'); } catch { /* PTY gone */ }
            disposeSession(session);
        }
        else if (outcome.kind === 'permission_stall') {
            ws.send(createNormalizedMessage({
                kind: 'error',
                content: `Claude is waiting for a tool-permission approval that this chat cannot display yet. Approve it from the Shell tab (run \`claude --resume ${session.providerSessionId}\` inside ${session.projectPath}), or pick a more permissive permission mode in the chat header and resend.`,
                sessionId: session.providerSessionId,
                provider: PROVIDER,
            }));
        }
        ws.send(createCompleteMessage({ provider: PROVIDER, sessionId: session.providerSessionId, exitCode: outcome.exitCode }));
    }
    // NOTE: no cleanup Esc here — combined with the next turn's overlay-dismiss
    // Esc it would form the TUI's double-Esc "backtrack" shortcut and swallow
    // the next paste. The next turn dismisses a leftover picker itself.
}

function startTailPolling(session) {
    if (session.tailTimer) {
        return;
    }
    session.tailTimer = setInterval(() => {
        try {
            pollTranscriptOnce(session);
        }
        catch (error) {
            console.error('[claude-interactive] Transcript poll failed', {
                providerSessionId: session.providerSessionId,
                error: String(error?.message || error),
            });
        }
    }, TRANSCRIPT_POLL_MS);
}

function stopTurnTimers(session) {
    if (session.tailTimer) {
        clearInterval(session.tailTimer);
        session.tailTimer = null;
    }
    if (session.watchdogTimer) {
        clearTimeout(session.watchdogTimer);
        session.watchdogTimer = null;
    }
}

function armTurnWatchdog(session) {
    if (session.watchdogTimer) {
        clearTimeout(session.watchdogTimer);
    }
    session.watchdogTimer = setTimeout(() => {
        if (session.isSlashTurn) {
            finishTurn(session, { kind: 'timeout', exitCode: 1 });
            return;
        }
        void recoverStalledTurn(session);
    }, TURN_WATCHDOG_MS);
}

/**
 * A stalled turn (silent transcript while the run is open) used to end as a
 * timeout error with the TUI left hanging — the user could not continue
 * until the hung request died or the pod restarted. Instead: interrupt the
 * TUI (Esc — its own "stop generating" key), let it settle, and resubmit the
 * original prompt so the turn continues from the transcript state. Bounded
 * by TURN_RECOVERY_MAX attempts; the final failure still reports a timeout,
 * now with the last screen state attached.
 */
async function recoverStalledTurn(session) {
    if (!session.finishTurn || session.turnRecovering || session.exited) {
        return;
    }
    const silentMs = Date.now() - session.lastGrowthAt;
    if (isTuiGenerating(session) && (session.watchdogExtensions ?? 0) < MAX_WATCHDOG_EXTENSIONS) {
        // The TUI shows a live thinking spinner: the model request is still
        // streaming (one long thinking block can take many minutes before a
        // completed transcript row lands). Interrupting destroys real work —
        // extend the watchdog instead, up to a bounded cap so a truly dead
        // stream still recovers eventually.
        session.watchdogExtensions = (session.watchdogExtensions ?? 0) + 1;
        console.warn('[claude-interactive] Long live generation — extending the watchdog instead of interrupting', {
            providerSessionId: session.providerSessionId,
            silentMs,
            extension: session.watchdogExtensions,
            ofMax: MAX_WATCHDOG_EXTENSIONS,
        });
        armTurnWatchdog(session);
        return;
    }
    session.turnRecovering = true;
    console.warn('[claude-interactive] Stalled turn — interrupting the TUI and resubmitting', {
        providerSessionId: session.providerSessionId,
        silentMs,
        attempt: session.turnRecoveries + 1,
        screenTail: normalizeScreenText(session.output).slice(-200),
    });
    try {
        session.activeWriter?.send(createNormalizedMessage({
            kind: 'status',
            text: 'turn_recovery',
            content: String(Math.round(silentMs / 1000)),
            sessionId: session.providerSessionId,
            provider: PROVIDER,
        }));
    }
    catch { /* socket gone */ }
    try {
        session.pty.write('\x1b');
    }
    catch { /* PTY gone; the exit handler resolves the run */ }
    await delay(INTERRUPT_SETTLE_MS);
    session.turnRecovering = false;
    if (session.exited || !session.finishTurn) {
        return; // the run resolved on its own during the settle
    }
    if (Date.now() - session.lastGrowthAt < INTERRUPT_SETTLE_MS) {
        // The interrupt revived the request (rows arrived) — keep watching.
        debugLog('turn-recovery-skipped', { reason: 'growth-resumed' });
        armTurnWatchdog(session);
        return;
    }
    if (session.turnRecoveries >= TURN_RECOVERY_MAX) {
        finishTurn(session, { kind: 'timeout', exitCode: 1 });
        return;
    }
    session.turnRecoveries += 1;
    session.turnSubmittedAt = Date.now();
    session.turnSawGrowth = false;
    session.submitRetried = true; // the dedicated resubmit below already covers one retry
    debugLog('turn-recovery-resubmit', { attempt: session.turnRecoveries });
    try {
        session.pty.write(`\x1b[200~${session.lastPasteText}\x1b[201~`);
        await delay(SUBMIT_SETTLE_MS);
        session.pty.write('\r');
        armTurnWatchdog(session);
    }
    catch { /* PTY gone; the exit handler resolves the run */ }
}

function pollTranscriptOnce(session) {
    if (!session.transcriptPath) {
        session.transcriptPath = findTranscriptPath(session.providerSessionId, session.claudeConfigDir);
        if (!session.transcriptPath) {
            checkUnacceptedSubmit(session);
            return;
        }
        debugLog('transcript-appeared', { transcriptPath: session.transcriptPath });
    }
    let stat;
    try {
        stat = fs.statSync(session.transcriptPath);
    }
    catch {
        return;
    }
    if (stat.size <= session.tailOffset) {
        checkUnacceptedSubmit(session);
        maybeFailOnPermissionDialog(session);
        maybeFinishQuietSlashTurn(session);
        return;
    }
    const fd = fs.openSync(session.transcriptPath, 'r');
    let delta;
    try {
        const length = stat.size - session.tailOffset;
        delta = Buffer.alloc(length);
        fs.readSync(fd, delta, 0, length, session.tailOffset);
    }
    finally {
        fs.closeSync(fd);
    }
    // Only consume up to the last newline: the tail of the delta may be a
    // partially written line that completes on the next poll.
    const lastNewline = delta.lastIndexOf(0x0a);
    if (lastNewline === -1) {
        return;
    }
    const consumed = delta.subarray(0, lastNewline + 1);
    session.tailOffset += consumed.length;
    session.lastGrowthAt = Date.now();
    session.turnSawGrowth = true;
    clearTurnFinalizer(session); // fresh growth means the turn (or a queued follow-up) is still going
    // The watchdog restarts on every transcript growth.
    if (session.watchdogTimer) {
        armTurnWatchdog(session);
    }
    // Hung-request signature: silence with the model's request as the pending
    // step — interrupt and resubmit early instead of waiting out the watchdog.
    if (session.finishTurn
        && !session.turnRecovering
        && session.sawModelRequestPending
        && !isTuiGenerating(session)
        && Date.now() - session.lastGrowthAt > HUNG_REQUEST_AFTER_MS) {
        void recoverStalledTurn(session);
        return;
    }
    // Native TUI turns between user turns also count as activity for the
    // idle PTY keepalive — never kill a session that is working on its own.
    if (!session.busy) {
        armIdleTimer(session);
    }
    if (session.finishTurn
        && Date.now() - session.lastGrowthAt > RUN_SILENCE_HEARTBEAT_AFTER_MS
        && Date.now() - session.lastHeartbeatAt > RUN_SILENCE_HEARTBEAT_EVERY_MS) {
        session.lastHeartbeatAt = Date.now();
        try {
            session.activeWriter?.send(createNormalizedMessage({
                kind: 'status',
                text: 'interactive_wait',
                content: String(Math.round((Date.now() - session.lastGrowthAt) / 1000)),
                sessionId: session.providerSessionId,
                provider: PROVIDER,
            }));
        }
        catch { /* socket gone */ }
    }
    for (const line of consumed.toString('utf8').split('\n')) {
        if (!line.trim()) {
            continue;
        }
        let entry;
        try {
            entry = JSON.parse(line);
        }
        catch {
            continue; // torn write, retried next poll
        }
        handleTranscriptEntry(session, entry);
        if (!session.finishTurn) {
            break; // the turn ended mid-batch
        }
    }
    maybeFinishQuietSlashTurn(session);
}

function handleTranscriptEntry(session, entry) {
    const ws = session.activeWriter;
    const providerSessionId = session.providerSessionId;
    // Suppress the TUI's echo of the submitted prompt: the UI already shows
    // the optimistic user bubble. Tool-result rows carry no promptSource and
    // still stream normally.
    if (entry?.type === 'user' && entry.promptSource === 'typed' && entry?.origin?.kind === 'human') {
        return;
    }
    // Hung-request signature: a tool result leaves the model's next request as
    // the pending step. Any assistant row means the request completed.
    if (entry?.type === 'user' && Array.isArray(entry?.message?.content)
        && entry.message.content.some((part) => part?.type === 'tool_result')) {
        session.sawModelRequestPending = true;
    }
    else if (entry?.type === 'assistant') {
        session.sawModelRequestPending = false;
    }
    const normalizeMessage = getNormalizeMessage();
    const normalized = normalizeMessage ? normalizeMessage(PROVIDER, entry, providerSessionId) : [];
    for (const message of normalized) {
        ws?.send(message);
    }
    if (entry?.type === 'assistant') {
        const tokenBudget = extractTokenBudgetFromUsage(entry.message?.usage);
        if (tokenBudget) {
            ws?.send(createNormalizedMessage({
                kind: 'status',
                text: 'token_budget',
                tokenBudget,
                sessionId: providerSessionId,
                provider: PROVIDER,
            }));
        }
        // The TUI writes each content block as its own assistant row and can
        // stamp `end_turn` on a thinking-only row whose text sibling arrives
        // moments later in the same batch. Ending the turn there would drop
        // the actual reply, so only a row with deliverable content (text or
        // tool use) may finish the turn; thought-only turns are closed by the
        // `turn_duration` backstop below.
        const content = entry.message?.content;
        const hasDeliverableContent = typeof content === 'string'
            ? Boolean(content)
            : Array.isArray(content) && content.some((part) => (part?.type === 'text' && part.text) || part?.type === 'tool_use');
        if (hasDeliverableContent && TURN_END_STOP_REASONS.has(entry.message?.stop_reason)) {
            armTurnFinalizer(session);
            return;
        }
    }
    // Backstop turn marker written by the TUI after every model turn.
    if (entry?.type === 'system' && entry.subtype === 'turn_duration') {
        clearTurnFinalizer(session);
        finishTurn(session, { kind: 'done', exitCode: 0 });
    }
}

/**
 * Ends the run a short quiet period after the last deliverable end_turn row,
 * unless the turn_duration marker (or further growth) settles it first. See
 * TURN_FINALIZE_QUIET_MS.
 */
function armTurnFinalizer(session) {
    clearTurnFinalizer(session);
    session.finalizeTimer = setTimeout(() => {
        session.finalizeTimer = null;
        finishTurn(session, { kind: 'done', exitCode: 0 });
    }, TURN_FINALIZE_QUIET_MS);
    if (typeof session.finalizeTimer.unref === 'function') {
        session.finalizeTimer.unref();
    }
}
function clearTurnFinalizer(session) {
    if (session.finalizeTimer) {
        clearTimeout(session.finalizeTimer);
        session.finalizeTimer = null;
    }
}
/**
 * Between user turns the TUI still runs its own turns (background-task
 * notifications are submitted natively) — without this tail that work is
 * invisible in the chat UI until the next user message. Keep streaming
 * transcript growth to the last connected writer.
 */
function startBackgroundTail(session) {
    if (session.backgroundTailTimer || session.exited) {
        return;
    }
    session.backgroundTailTimer = setInterval(() => {
        try {
            pollTranscriptOnce(session);
        }
        catch (error) {
            console.error('[claude-interactive] Background transcript poll failed', {
                providerSessionId: session.providerSessionId,
                error: String(error?.message || error),
            });
        }
    }, BACKGROUND_TAIL_MS);
}
function stopBackgroundTail(session) {
    if (session.backgroundTailTimer) {
        clearInterval(session.backgroundTailTimer);
        session.backgroundTailTimer = null;
    }
}

/**
 * Slash commands run locally in the TUI; some write no turn marker at all
 * (e.g. `/model`). Finish their run once the transcript has been quiet for a
 * short period instead of waiting for the watchdog.
 */
function maybeFinishQuietSlashTurn(session) {
    if (!session.isSlashTurn || !session.finishTurn) {
        return;
    }
    if (Date.now() - session.lastGrowthAt >= SLASH_TURN_QUIET_MS) {
        finishTurn(session, { kind: 'done', exitCode: 0 });
    }
}

function finishTurn(session, outcome) {
    debugLog('turn-finished', { ...outcome, waitedMs: session.turnSubmittedAt ? Date.now() - session.turnSubmittedAt : 0 });
    session.finishTurn?.(outcome);
}

/**
 * Guards against the prompt never reaching the composer: no transcript
 * activity at all within SUBMIT_RETRY_MS of a non-slash submit means the TUI
 * did not accept it (blocked overlay, lost Enter). Retry once, then fail the
 * turn with a screen diagnostic rather than waiting out the watchdog.
 */
function checkUnacceptedSubmit(session) {
    if (session.isSlashTurn || !session.finishTurn || session.turnSawGrowth || session.exited) {
        return;
    }
    const waitedMs = Date.now() - session.turnSubmittedAt;
    if (waitedMs < SUBMIT_RETRY_MS) {
        return;
    }
    if (!session.submitRetried) {
        session.submitRetried = true;
        retrySubmit(session);
        return;
    }
    if (waitedMs >= SUBMIT_GIVEUP_MS) {
        finishTurn(session, { kind: 'not_submitted', exitCode: 1 });
    }
}

/**
 * Recovery for a submit the TUI never accepted, chosen by what the screen
 * actually shows: answer a trust dialog, leave a permission dialog or a
 * running model alone, press Enter when only the Enter was lost, and
 * otherwise dismiss whatever overlay ate the paste and paste again.
 */
function retrySubmit(session) {
    const screen = normalizeScreenText(session.output);
    const pasted = normalizeScreenText(session.lastPasteText || '');
    debugLog('submit-retry', { waitedMs: Date.now() - session.turnSubmittedAt, screenTail: screen.slice(-400) });
    // A re-appeared trust dialog must be answered, not submitted into.
    if (TRUST_DIALOG_PATTERN.test(screen)) {
        session.trustAnswered = false;
        answerTrustDialog(session, screen);
        return;
    }
    // A permission dialog has its own stall handling; never keystroke into it.
    if (PERMISSION_DIALOG_PATTERN.test(screen)) {
        return;
    }
    // The model is still working on the submitted prompt (the interrupt hint
    // only shows during generation): retrying would interrupt it.
    if (GENERATING_PATTERN.test(screen)) {
        return;
    }
    try {
        if (pasted && screen.includes(pasted)) {
            // The paste reached the composer but the Enter was lost.
            session.pty.write('\r');
            return;
        }
        // The paste never reached the composer (an overlay ate it): dismiss
        // the overlay and submit again.
        session.pty.write('\x1b');
        setTimeout(() => {
            try {
                session.pty.write(`\x1b[200~${session.lastPasteText}\x1b[201~`);
                setTimeout(() => {
                    try { session.pty.write('\r'); }
                    catch { /* PTY gone: the exit handler finishes the turn */ }
                }, SUBMIT_SETTLE_MS);
            }
            catch { /* PTY gone */ }
        }, 600).unref?.();
    }
    catch { /* PTY gone: the exit handler finishes the turn */ }
}

/**
 * The TUI's permission dialog is invisible to the chat GUI, so a turn that
 * stalls on one would hang until the watchdog. Detect it from the screen and
 * fail the turn with instructions the user can actually follow.
 */
function maybeFailOnPermissionDialog(session) {
    if (!session.finishTurn || session.exited) {
        return;
    }
    if (Date.now() - session.lastGrowthAt < PERMISSION_DIALOG_STALL_MS) {
        return;
    }
    if (!PERMISSION_DIALOG_PATTERN.test(normalizeScreenText(session.output))) {
        return;
    }
    finishTurn(session, { kind: 'permission_stall', exitCode: 1 });
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

async function buildPasteText(command, options, projectPath) {
    const mentions = await stageImagesForPrompt(options?.images, projectPath);
    if (!mentions.length) {
        return command;
    }
    // The TUI attaches @-mentioned files (including images) at submit time.
    return `${command}\n${mentions.join(' ')}`;
}

async function stageImagesForPrompt(images, projectPath) {
    const list = Array.isArray(images) ? images.filter((p) => typeof p === 'string' && p.trim()) : [];
    if (!list.length) {
        return [];
    }
    const stagedDir = path.join(projectPath, '.cloudcli-uploads');
    await fsp.mkdir(stagedDir, { recursive: true });
    const staged = [];
    for (const imagePath of list) {
        try {
            const extension = path.extname(imagePath) || '.png';
            const target = path.join(stagedDir, `ccui-${randomUUID()}${extension}`);
            await fsp.copyFile(imagePath, target);
            staged.push(target);
        }
        catch (error) {
            console.warn('[claude-interactive] Could not stage image for prompt', {
                imagePath,
                error: String(error?.message || error),
            });
        }
    }
    return staged;
}

// ---------------------------------------------------------------------------
// Environment & filesystem helpers
// ---------------------------------------------------------------------------

/**
 * Env vars that mark a process as nested inside another Claude Code session.
 * Inheriting any of them changes the spawned TUI's behavior — most critically
 * `CLAUDE_CODE_CHILD_SESSION`, which silently turns transcript saving OFF
 * ("Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION marker"),
 * breaking turn detection entirely. The TUI must run as a top-level session no
 * matter which process loaded this runtime.
 */
const NESTING_ENV_VARS = [
    'CLAUDE_CODE_CHILD_SESSION',
    'CLAUDE_CODE_SESSION_ID',
    'CLAUDE_CODE_ENTRYPOINT',
    'CLAUDE_CODE_EXECPATH',
    'CLAUDE_CODE_SSE_PORT',
    'CLAUDE_PID',
    'CLAUDECODE',
    'CLAUDE_EFFORT',
    'AI_AGENT',
    'CLAUDE_AGENT_SDK_VERSION',
    // Marks a subprocess of the SDK (API/proxy-billed) runtime; the /usr/local/bin/claude
    // launcher short-circuits to the proxy transport when it is set. The interactive
    // runtime must always take the launcher's iclaude branch (subscription billing),
    // exactly like the Shell tab.
    'CLOUDCLI_CLAUDE_PROXY_SESSION',
];

function buildPtyEnv(configDir) {
    const env = { ...process.env };
    for (const key of NESTING_ENV_VARS) {
        delete env[key];
    }
    if (typeof configDir === 'string' && configDir.trim()) {
        // A second official Claude login: run real Claude Code against that
        // account's own credentials directory (never the managed iClaude
        // transport — the wrapper's oauth branch keeps this env intact).
        env.CLAUDE_CONFIG_DIR = configDir.trim();
        env.CLOUDCLI_CLAUDE_OAUTH_SESSION = '1';
    }
    // Mirror the SDK runtime's iclaude handling: the iClaude launcher owns
    // transport authentication, so a stale direct/proxy credential from the
    // surrounding environment must never become a hidden API-billed fallback.
    if (String(env.CLAUDE_AUTH_MODE || '').toLowerCase() === 'iclaude') {
        for (const key of ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'CLAUDE_PROXY_TOKEN', 'ICLAUDE_PASSWORD', 'ICLAUDE_PASSWORD_FILE']) {
            delete env[key];
        }
    }
    const { key, value } = prioritizeUserNpmGlobalBin(env);
    if (key && value) {
        env[key] = value;
    }
    env.TERM = 'xterm-256color';
    env.COLORTERM = 'truecolor';
    env.FORCE_COLOR = '3';
    // The runtime is validated against the installed Claude Code version; a
    // surprise self-update between turns (new TUI screens, transcript shape)
    // must never hit a live chat. Updates become a deliberate act — remove
    // this pin, update, run tests/verify-compatibility.mjs, re-enable.
    env.DISABLE_AUTOUPDATER = '1';
    return env;
}

/**
 * Reorders PATH so the user's own npm-global binaries (the iclaude-managed
 * `claude` install) win over system-wide ones. Mirrors the shell service.
 */
function prioritizeUserNpmGlobalBin(env) {
    const pathKey = Object.keys(env).find((k) => k.toLowerCase() === 'path') || 'PATH';
    const currentPath = env[pathKey];
    if (!currentPath) {
        return { key: pathKey, value: currentPath };
    }
    const entries = currentPath.split(path.delimiter).filter(Boolean);
    const npmPrefix = readEnvValue(env, 'npm_config_prefix');
    const candidates = [
        npmPrefix || '',
        npmPrefix ? path.join(npmPrefix, 'bin') : '',
        path.join(os.homedir(), '.npm-global', 'bin'),
        path.join(os.homedir(), '.local', 'bin'),
    ].filter(Boolean);
    const preferred = candidates.filter((candidate, index) => candidates.indexOf(candidate) === index && entries.includes(candidate));
    if (!preferred.length) {
        return { key: pathKey, value: currentPath };
    }
    const rest = entries.filter((entry) => !preferred.includes(entry));
    return { key: pathKey, value: [...preferred, ...rest].join(path.delimiter) };
}

function readEnvValue(env, key) {
    const resolvedKey = Object.keys(env).find((envKey) => envKey.toLowerCase() === key.toLowerCase());
    return resolvedKey ? env[resolvedKey] : undefined;
}

/**
 * Resolves the config file the TUI will actually read, the way Claude Code
 * does: $CLAUDE_CONFIG_DIR when set (the iclaude launcher sets it for its
 * child), then the iclaude claude-config indirection (whose .claude.json is a
 * symlink into ~/.claude), then the two stock locations. Writing through a
 * symlinked candidate lands in the real file.
 */
function resolveClaudeConfigPath(configDir) {
    const home = os.homedir();
    const iclaudeConfigDir = path.join(home, '.local', 'share', 'iclaude', 'claude-config');
    const candidates = [];
    const override = (typeof configDir === 'string' && configDir.trim()) || process.env.CLAUDE_CONFIG_DIR;
    if (typeof override === 'string' && override.trim()) {
        candidates.push(path.join(override, '.claude.json'));
    }
    candidates.push(
        path.join(iclaudeConfigDir, '.claude.json'),
        path.join(home, '.claude', '.claude.json'),
        path.join(home, '.claude.json'),
    );
    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) {
            return candidate;
        }
    }
    return fs.existsSync(iclaudeConfigDir)
        ? path.join(iclaudeConfigDir, '.claude.json')
        : path.join(home, '.claude.json');
}

/**
 * Pre-accepts the TUI's one-time dialogs for the project so the GUI flow never
 * blocks on an invisible prompt (the trust dialog defaults to "No, exit"), and
 * marks onboarding complete so a fresh home directory goes straight to the
 * input box instead of the theme/demo walkthrough. The file is only rewritten
 * when something actually changed.
 */
function acceptProjectTrust(projectPath, configDir) {
    const configPath = resolveClaudeConfigPath(configDir);
    let config = {};
    try {
        config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    }
    catch { /* missing or unreadable config: start fresh */ }
    if (!config || typeof config !== 'object') {
        config = {};
    }
    let changed = false;
    if (config.hasCompletedOnboarding !== true || !config.lastOnboardingVersion) {
        config.hasCompletedOnboarding = true;
        config.lastOnboardingVersion = config.lastOnboardingVersion || '2.0.76';
        changed = true;
    }
    if (config.bypassPermissionsModeAccepted !== true) {
        // Pre-accept the bypass-permissions warning so a skip-permissions
        // session doesn't block on its acceptance dialog at startup; the
        // runtime's dialog answerer covers the case where the TUI still shows it.
        config.bypassPermissionsModeAccepted = true;
        changed = true;
    }
    config.projects = config.projects && typeof config.projects === 'object' ? config.projects : {};
    const existing = config.projects[projectPath];
    if (!existing || typeof existing !== 'object' || existing.hasTrustDialogAccepted !== true) {
        config.projects[projectPath] = { ...(existing && typeof existing === 'object' ? existing : {}), hasTrustDialogAccepted: true };
        changed = true;
    }
    if (changed) {
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    }
}

/**
 * Resolves the transcript path for a provider session id. Session files are
 * named `<session-id>.jsonl`, so a shallow scan of the project dirs is
 * deterministic and avoids re-implementing the cwd-to-dirname encoding.
 */
function findTranscriptPath(providerSessionId, configDir) {
    const home = os.homedir();
    const projectsRoots = [];
    if (typeof configDir === 'string' && configDir.trim()) {
        projectsRoots.push(path.join(configDir, 'projects'));
    }
    projectsRoots.push(path.join(home, '.claude', 'projects'));
    for (const projectsRoot of projectsRoots) {
        const found = findTranscriptInRoot(projectsRoot, providerSessionId);
        if (found) {
            return found;
    }
    }
    return null;
}
function findTranscriptInRoot(projectsRoot, providerSessionId) {
    let dirs;
    try {
        dirs = fs.readdirSync(projectsRoot);
    }
    catch {
        return null;
    }
    for (const dir of dirs) {
        const candidate = path.join(projectsRoot, dir, `${providerSessionId}.jsonl`);
        try {
            if (fs.statSync(candidate).isFile()) {
                return candidate;
            }
        }
        catch { /* not present in this project dir */ }
    }
    return null;
}

/**
 * Token budget for the UI, derived from an assistant entry's usage block.
 * Same output shape as the SDK runtime's `extractTokenBudget`.
 */
function extractTokenBudgetFromUsage(usage) {
    if (!usage || typeof usage !== 'object') {
        return null;
    }
    const read = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
    const cacheCreationTokens = read(usage.cache_creation_input_tokens);
    const cacheReadTokens = read(usage.cache_read_input_tokens);
    const inputTokens = read(usage.input_tokens) + cacheCreationTokens + cacheReadTokens;
    const outputTokens = read(usage.output_tokens);
    const contextWindow = parseInt(process.env.CONTEXT_WINDOW, 10) || 160000;
    return {
        used: inputTokens + outputTokens,
        total: contextWindow,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheCreationTokens,
        cacheTokens: cacheCreationTokens + cacheReadTokens,
        breakdown: { input: inputTokens, output: outputTokens },
    };
}

function stripAnsiSequences(text) {
    return text
        .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
        .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '');
}

/**
 * Collapses all whitespace so screen patterns survive the TUI's word-by-word
 * cursor positioning (see the patterns above).
 */
function normalizeScreenText(text) {
    return String(text || '').replace(/\s+/g, '');
}

function diagnosticTail(session) {
    const tail = (session.output || '').replace(/\s+/g, ' ').trim().slice(-300);
    return tail ? `Last output: ${tail}` : '';
}

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export { queryInteractiveClaude as queryClaudeInteractive };
