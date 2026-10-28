import fs from 'node:fs/promises';
import path from 'node:path';
import { projectsDb, sessionsDb } from '../../../modules/database/index.js';
import { sessionSynchronizerService } from '../../../modules/providers/index.js';
import { WS_OPEN_STATE, connectedClients } from '../../../modules/websocket/index.js';
import { AppError } from '../../../shared/utils.js';
const DEFAULT_PROJECT_SESSIONS_PAGE_SIZE = 20;
const MAX_PROJECT_SESSIONS_PAGE_SIZE = 200;
/**
 * Generate better display name from path.
 */
export async function generateDisplayName(projectName, actualProjectDir = null) {
    // Use actual project directory if provided, otherwise decode from project name.
    const projectPath = actualProjectDir || projectName.replace(/-/g, '/');
    // Try to read package.json from the project path.
    try {
        const packageJsonPath = path.join(projectPath, 'package.json');
        const packageData = await fs.readFile(packageJsonPath, 'utf8');
        const packageJson = JSON.parse(packageData);
        // Return the name from package.json if it exists.
        if (packageJson.name) {
            return packageJson.name;
        }
    }
    catch {
        // Fall back to path-based naming if package.json doesn't exist or can't be read.
    }
    // If it starts with /, it's an absolute path.
    if (projectPath.startsWith('/')) {
        const parts = projectPath.split('/').filter(Boolean);
        // Return only the last folder name.
        return parts[parts.length - 1] || projectPath;
    }
    return projectPath;
}
function normalizeSessionPagination(options = {}) {
    const rawLimit = Number.isFinite(options.limit) ? Math.floor(Number(options.limit)) : DEFAULT_PROJECT_SESSIONS_PAGE_SIZE;
    const rawOffset = Number.isFinite(options.offset) ? Math.floor(Number(options.offset)) : 0;
    return {
        limit: Math.min(Math.max(1, rawLimit), MAX_PROJECT_SESSIONS_PAGE_SIZE),
        offset: Math.max(0, rawOffset),
    };
}
/**
 * Session model/account badge: the sidebar shows which account+model each
 * session actually runs on. Sources: the runtime-models record (written by
 * the chat dispatcher on every send) and the transcript's directory (a
 * .claude-personal path means the personal Claude account; the default dir
 * means the managed team transport). Cached briefly — this runs per row.
 */
import os from 'node:os';
import fsSync from 'node:fs';
const SESSION_BADGE_CACHE_MS = 30_000;
const sessionBadgeCache = new Map();
function readRuntimeModelsEntry(sessionId) {
    try {
        const raw = fsSync.readFileSync(pathModule.join(os.homedir(), '.cloudcli', 'provider-session-runtime-models.json'), 'utf8');
        const parsed = JSON.parse(raw);
        const entry = parsed?.entries?.[`claude:${sessionId}`] ?? parsed?.entries?.[`claude:${sessionId}`];
        return entry ?? null;
    }
    catch {
        return null;
    }
}
function sessionTransportLabel(row) {
    const jsonl = typeof row.jsonl_path === 'string' ? row.jsonl_path : '';
    if (jsonl.includes('/.claude-personal/')) {
        return 'شخصی';
    }
    const entry = readRuntimeModelsEntry(row.provider_session_id || row.session_id);
    if (entry && typeof entry.model === 'string' && entry.model.includes('@')) {
        return entry.model.split('@').pop() === 'personal' ? 'شخصی' : 'پروکسی';
    }
    return '';
}
function mapSessionRowToSummary(row) {
    const summary = row.custom_name || '';
    const transport = row.provider === 'claude' ? sessionTransportLabel(row) : '';
    const entry = row.provider === 'claude' ? readRuntimeModelsEntry(row.provider_session_id || row.session_id) : null;
    const model = entry && typeof entry.model === 'string' ? entry.model.split('@')[0] : '';
    // Append the badge to the summary the sidebar renders: "نام سشن — Opus · شخصی".
    // Only for claude sessions with a known transport; codex/other providers unchanged.
    const badge = transport && model && model !== 'default'
        ? ` — ${model} · ${transport}`
        : (transport ? ` — ${transport}` : '');
    return {
        id: row.session_id,
        providerSessionId: row.provider_session_id ?? null,
        provider: row.provider,
        summary: badge && !summary.includes('·') ? `${summary}${badge}` : summary,
        messageCount: 0,
        lastActivity: row.updated_at ?? row.created_at ?? new Date().toISOString(),
        sessionKind: row.session_kind ?? 'main',
        parentSessionId: row.parent_session_id ?? null,
        agentPath: row.agent_path ?? null,
    };
}
function resolveParentSessionSummary(row) {
    const parentSessionId = row.parent_session_id?.trim();
    if (!parentSessionId) {
        return null;
    }
    const parentSession = sessionsDb.getSessionByProviderSessionId(parentSessionId) ??
        sessionsDb.getSessionById(parentSessionId);
    return parentSession?.custom_name?.trim() || parentSession?.session_id || parentSessionId;
}
function readProjectSessionsIncludingArchived(projectPath) {
    const rows = sessionsDb.getSessionsByProjectPathIncludingArchived(projectPath);
    return {
        sessions: rows.map(mapSessionRowToSummary),
        total: rows.length,
        hasMore: false,
    };
}
/**
 * Reads one paginated project session slice from the DB and groups rows by provider.
 */
function readProjectSessionsPageByPath(projectPath, options = {}) {
    const pagination = normalizeSessionPagination(options);
    const rows = sessionsDb.getSessionsByProjectPathPage(projectPath, pagination.limit, pagination.offset);
    const total = sessionsDb.countSessionsByProjectPath(projectPath);
    return {
        sessions: rows.map(mapSessionRowToSummary),
        total,
        hasMore: pagination.offset + rows.length < total,
    };
}
function readProjectAgentSessionsPageByPath(projectPath, options = {}) {
    const pagination = normalizeSessionPagination(options);
    const rows = sessionsDb.getAgentSessionsByProjectPathPage(projectPath, pagination.limit, pagination.offset);
    const total = sessionsDb.countAgentSessionsByProjectPath(projectPath);
    return {
        sessions: rows.map((row) => ({
            ...mapSessionRowToSummary(row),
            parentSessionSummary: resolveParentSessionSummary(row),
        })),
        total,
        hasMore: pagination.offset + rows.length < total,
    };
}
// Broadcast progress to all connected WebSocket clients.
// Uses the unified `kind` envelope like every other websocket frame.
function broadcastProgress(progress) {
    const message = JSON.stringify({
        kind: 'loading_progress',
        ...progress,
    });
    connectedClients.forEach((client) => {
        if (client.readyState === WS_OPEN_STATE) {
            client.send(message);
        }
    });
}
/**
 * Reads all projects from DB and returns normalized session summaries.
 */
export async function getProjectsWithSessions(options = {}) {
    if (!options.skipSynchronization) {
        await sessionSynchronizerService.synchronizeSessions();
    }
    const projectRows = projectsDb.getProjectPaths();
    const totalProjects = projectRows.length;
    const projects = [];
    let processedProjects = 0;
    for (const row of projectRows) {
        processedProjects += 1;
        const projectId = row.project_id;
        const projectPath = row.project_path;
        broadcastProgress({
            phase: 'loading',
            current: processedProjects,
            total: totalProjects,
            currentProject: projectPath,
        });
        const displayName = row.custom_project_name && row.custom_project_name.trim().length > 0
            ? row.custom_project_name
            : await generateDisplayName(path.basename(projectPath) || projectPath, projectPath);
        const sessionsPage = readProjectSessionsPageByPath(projectPath, {
            limit: options.sessionsLimit,
            offset: options.sessionsOffset,
        });
        const agentSessionsPage = readProjectAgentSessionsPageByPath(projectPath, {
            limit: MAX_PROJECT_SESSIONS_PAGE_SIZE,
            offset: 0,
        });
        projects.push({
            projectId,
            path: projectPath,
            displayName,
            fullPath: projectPath,
            isStarred: Boolean(row.isStarred),
            sessions: sessionsPage.sessions,
            sessionMeta: {
                hasMore: sessionsPage.hasMore,
                total: sessionsPage.total,
            },
            agentSessions: agentSessionsPage.sessions,
            agentSessionMeta: {
                hasMore: agentSessionsPage.hasMore,
                total: agentSessionsPage.total,
            },
        });
    }
    broadcastProgress({
        phase: 'complete',
        current: totalProjects,
        total: totalProjects,
    });
    return projects;
}
/**
 * Reads archived projects from DB and includes every session row for each
 * project path, because an archived workspace should surface all preserved
 * conversation history in the archive view regardless of each session's flag.
 */
export async function getArchivedProjectsWithSessions(options = {}) {
    if (!options.skipSynchronization) {
        await sessionSynchronizerService.synchronizeSessions();
    }
    const projectRows = projectsDb.getArchivedProjectPaths();
    const archivedProjects = [];
    for (const row of projectRows) {
        const displayName = row.custom_project_name && row.custom_project_name.trim().length > 0
            ? row.custom_project_name
            : await generateDisplayName(path.basename(row.project_path) || row.project_path, row.project_path);
        const sessionsPage = readProjectSessionsIncludingArchived(row.project_path);
        archivedProjects.push({
            projectId: row.project_id,
            path: row.project_path,
            displayName,
            fullPath: row.project_path,
            isStarred: Boolean(row.isStarred),
            isArchived: true,
            sessions: sessionsPage.sessions,
            sessionMeta: {
                hasMore: sessionsPage.hasMore,
                total: sessionsPage.total,
            },
        });
    }
    return archivedProjects;
}
/**
 * Loads one paginated session slice for a specific project id.
 */
export async function getProjectSessionsPage(projectId, options = {}) {
    const projectRow = projectsDb.getProjectById(projectId);
    if (!projectRow) {
        throw new AppError(`Project "${projectId}" was not found.`, {
            code: 'PROJECT_NOT_FOUND',
            statusCode: 404,
        });
    }
    const sessionsPage = readProjectSessionsPageByPath(projectRow.project_path, options);
    return {
        projectId: projectRow.project_id,
        sessions: sessionsPage.sessions,
        sessionMeta: {
            hasMore: sessionsPage.hasMore,
            total: sessionsPage.total,
        },
    };
}
//# sourceMappingURL=projects-with-sessions-fetch.service.js.map
