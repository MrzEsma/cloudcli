import type { PluginAPI, PluginContext } from './types.js';

type BrowserStatus = {
  enabled: boolean;
  available: boolean;
  playwrightInstalled: boolean;
  chromiumInstalled: boolean;
  installInProgress: boolean;
  sessionCount: number;
  message: string;
};

type BrowserSession = {
  id: string;
  status: 'ready' | 'stopped' | 'unavailable';
  url: string | null;
  title: string | null;
  screenshotDataUrl: string | null;
  createdAt: string;
  updatedAt: string;
  lastAction: string | null;
  message: string | null;
  viewport: { width: number; height: number } | null;
  cursor: { x: number; y: number } | null;
};

type ElementInfo = {
  tagName: string;
  id: string | null;
  className: string | null;
  role: string | null;
  ariaLabel: string | null;
  text: string;
  rect: { x: number; y: number; width: number; height: number };
};

type Selection = {
  x: number;
  y: number;
  width: number;
  height: number;
  element: ElementInfo | null;
};

type SurfacePoint = { localX: number; localY: number; x: number; y: number };

type State = {
  context: PluginContext;
  status: BrowserStatus | null;
  sessions: BrowserSession[];
  selectedId: string | null;
  mode: 'interact' | 'select';
  selection: Selection | null;
  comment: string;
  openUrl: string;
  typeText: string;
  busy: boolean;
  refreshing: boolean;
  installing: boolean;
  fullscreen: boolean;
  error: string | null;
  notice: string | null;
};

const CSS = `
  .bf-root { min-height:100%; box-sizing:border-box; padding:16px; background:var(--bf-bg); color:var(--bf-text); font:14px/1.45 ui-sans-serif,system-ui,-apple-system,sans-serif; }
  .bf-root *, .bf-root *::before, .bf-root *::after { box-sizing:border-box; }
  .bf-wrap { max-width:1180px; min-height:calc(100vh - 32px); margin:0 auto; display:flex; flex-direction:column; gap:12px; }
  .bf-header { display:flex; align-items:center; justify-content:space-between; gap:12px; }
  .bf-title { display:flex; align-items:center; gap:10px; font-size:18px; font-weight:700; }
  .bf-subtitle { color:var(--bf-muted); font-size:12px; margin-top:2px; }
  .bf-icon { width:34px; height:34px; display:grid; place-items:center; border-radius:9px; background:#2563eb; color:white; font-size:18px; }
  .bf-card { border:1px solid var(--bf-border); border-radius:10px; background:var(--bf-surface); overflow:hidden; }
  .bf-toolbar, .bf-feedback, .bf-empty, .bf-side { padding:12px; }
  .bf-toolbar { display:flex; flex-wrap:wrap; align-items:center; gap:8px; border-bottom:1px solid var(--bf-border); background:var(--bf-surface-2); }
  .bf-button { border:1px solid var(--bf-border); border-radius:7px; padding:7px 10px; background:var(--bf-surface-2); color:var(--bf-text); font:inherit; font-size:12px; font-weight:600; cursor:pointer; }
  .bf-button:hover { border-color:#2563eb; }
  .bf-button:disabled { opacity:.5; cursor:not-allowed; }
  .bf-button.bf-primary { background:#2563eb; border-color:#2563eb; color:white; }
  .bf-button.bf-active { background:#2563eb; border-color:#2563eb; color:white; }
  .bf-button.bf-danger { color:#dc2626; }
  .bf-status { margin-left:auto; color:var(--bf-muted); font-size:12px; }
  .bf-status[data-kind="error"] { color:#dc2626; }
  .bf-status[data-kind="success"] { color:#16a34a; }
  .bf-input, .bf-textarea { width:100%; border:1px solid var(--bf-border); border-radius:7px; padding:8px 10px; background:var(--bf-bg); color:var(--bf-text); font:inherit; font-size:13px; outline:none; }
  .bf-input:focus, .bf-textarea:focus { border-color:#2563eb; box-shadow:0 0 0 2px rgb(37 99 235 / 15%); }
  .bf-textarea { min-height:70px; resize:vertical; }
  .bf-open { display:flex; gap:8px; width:100%; }
  .bf-open .bf-input { min-width:0; flex:1; }
  .bf-runtime { flex:1; min-width:180px; color:var(--bf-muted); font-size:12px; }
  .bf-error { padding:8px 12px; border-bottom:1px solid rgb(220 38 38 / 25%); background:rgb(220 38 38 / 10%); color:#dc2626; font-size:12px; }
  .bf-notice { padding:8px 12px; border-bottom:1px solid rgb(22 163 74 / 25%); background:rgb(22 163 74 / 10%); color:#16a34a; font-size:12px; }
  .bf-layout { display:grid; grid-template-columns:minmax(0,1fr) 250px; min-height:0; flex:1; }
  .bf-main { min-width:0; display:flex; flex-direction:column; }
  .bf-surface-wrap { min-height:390px; display:flex; align-items:center; justify-content:center; background:#09090b; overflow:auto; }
  .bf-surface { position:relative; display:inline-block; max-width:100%; max-height:72vh; user-select:none; touch-action:none; }
  .bf-surface img { display:block; max-width:100%; max-height:72vh; width:auto; height:auto; object-fit:contain; }
  .bf-surface[data-mode="interact"] { cursor:pointer; }
  .bf-surface[data-mode="select"] { cursor:crosshair; }
  .bf-cursor, .bf-region, .bf-draft { pointer-events:none; position:absolute; }
  .bf-cursor { width:18px; height:18px; transform:translate(-50%,-50%); border:2px solid white; border-radius:50%; background:#2563ebcc; box-shadow:0 0 0 5px rgb(37 99 235 / 20%); }
  .bf-region { border:2px solid #fbbf24; background:#fbbf2433; }
  .bf-draft { border:2px solid #2563eb; background:#2563eb33; }
  .bf-empty { flex:1; min-height:390px; display:flex; align-items:center; justify-content:center; text-align:center; color:var(--bf-muted); }
  .bf-empty-inner { max-width:580px; width:100%; }
  .bf-empty h2 { color:var(--bf-text); font-size:15px; margin:0 0 5px; }
  .bf-empty p { margin:0 0 14px; font-size:13px; }
  .bf-pills { display:flex; flex-wrap:wrap; justify-content:center; gap:6px; margin-top:12px; }
  .bf-pill { border:1px solid var(--bf-border); border-radius:999px; padding:5px 8px; color:var(--bf-muted); font-size:11px; }
  .bf-feedback { border-top:1px solid var(--bf-border); }
  .bf-feedback-title { margin-bottom:7px; color:var(--bf-muted); font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:.06em; }
  .bf-selection { margin-bottom:8px; border:1px solid rgb(251 191 36 / 45%); border-radius:6px; padding:6px 8px; background:rgb(251 191 36 / 10%); color:var(--bf-text); font-size:11px; }
  .bf-feedback-row { display:flex; gap:8px; align-items:flex-end; }
  .bf-feedback-row .bf-textarea { flex:1; min-width:0; }
  .bf-side { border-left:1px solid var(--bf-border); background:var(--bf-bg); }
  .bf-side-title { display:flex; justify-content:space-between; align-items:center; margin-bottom:9px; font-weight:700; font-size:13px; }
  .bf-session { width:100%; display:block; margin-bottom:7px; border:1px solid var(--bf-border); border-radius:7px; padding:8px; background:var(--bf-surface); color:var(--bf-text); text-align:left; cursor:pointer; }
  .bf-session[data-selected="true"] { border-color:#2563eb; background:rgb(37 99 235 / 10%); }
  .bf-session-name { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:12px; font-weight:600; }
  .bf-session-url { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; margin-top:3px; color:var(--bf-muted); font-size:10px; }
  .bf-session-meta { margin-top:6px; color:var(--bf-muted); font-size:10px; }
  .bf-side-empty { color:var(--bf-muted); font-size:11px; }
  .bf-controls { display:flex; flex-wrap:wrap; gap:7px; align-items:center; padding:9px 12px; border-bottom:1px solid var(--bf-border); background:var(--bf-bg); }
  .bf-controls-hint { color:var(--bf-muted); font-size:11px; }
  .bf-type { display:flex; gap:6px; margin-left:auto; max-width:310px; flex:1; }
  .bf-type .bf-input { min-width:0; }
  .bf-element { margin-top:7px; color:var(--bf-muted); font-size:11px; word-break:break-word; }
  .bf-fullscreen { position:fixed; z-index:9999; inset:0; display:flex; flex-direction:column; padding:12px; background:#000; }
  .bf-fullscreen-head { display:flex; justify-content:space-between; align-items:center; color:#fff; padding-bottom:9px; }
  .bf-fullscreen .bf-surface-wrap { flex:1; min-height:0; }
  .bf-fullscreen .bf-surface img { max-height:calc(100vh - 70px); }
  @media (max-width:800px) { .bf-layout { grid-template-columns:1fr; } .bf-side { display:none; } .bf-status { width:100%; margin-left:0; } .bf-feedback-row { flex-direction:column; align-items:stretch; } .bf-type { margin-left:0; max-width:none; min-width:100%; } }
`;

function applyTheme(root: HTMLElement, context: PluginContext): void {
  const dark = context.theme === 'dark';
  root.style.setProperty('--bf-bg', dark ? '#09090b' : '#fafafa');
  root.style.setProperty('--bf-surface', dark ? '#18181b' : '#ffffff');
  root.style.setProperty('--bf-surface-2', dark ? '#27272a' : '#f4f4f5');
  root.style.setProperty('--bf-border', dark ? '#3f3f46' : '#e4e4e7');
  root.style.setProperty('--bf-text', dark ? '#fafafa' : '#18181b');
  root.style.setProperty('--bf-muted', dark ? '#a1a1aa' : '#71717a');
}

function domain(url: string | null): string {
  if (!url) return 'No page loaded';
  try { return new URL(url).hostname; } catch { return url; }
}

function actionLabel(action: string | null): string {
  return action ? action.replace(/_/g, ' ') : 'Waiting';
}

function relativeTime(value: string): string {
  const elapsed = Math.max(0, Math.round((Date.now() - Date.parse(value)) / 1000));
  if (elapsed < 10) return 'Just now';
  if (elapsed < 60) return `${elapsed}s ago`;
  if (elapsed < 3600) return `${Math.round(elapsed / 60)}m ago`;
  return `${Math.round(elapsed / 3600)}h ago`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character] || character));
}

async function copyText(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const textarea = document.createElement('textarea');
  textarea.value = value;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand('copy');
  textarea.remove();
}

export function mount(container: HTMLElement, api: PluginAPI): void {
  const state: State = {
    context: api.context,
    status: null,
    sessions: [],
    selectedId: null,
    mode: 'interact',
    selection: null,
    comment: '',
    openUrl: '',
    typeText: '',
    busy: false,
    refreshing: false,
    installing: false,
    fullscreen: false,
    error: null,
    notice: null,
  };
  const root = document.createElement('div');
  root.className = 'bf-root';
  const style = document.createElement('style');
  style.textContent = CSS;
  root.append(style);
  container.append(root);
  applyTheme(root, state.context);

  const selected = (): BrowserSession | null => state.sessions.find((session) => session.id === state.selectedId) || state.sessions[0] || null;

  async function rpc<T>(method: string, path: string, body?: unknown): Promise<T> {
    const result = await api.rpc(method, path, body) as { success?: boolean; error?: string; data?: T };
    if (result?.success === false) throw new Error(result.error || 'Browser request failed.');
    return result.data as T;
  }

  async function refresh(): Promise<void> {
    state.refreshing = true;
    try {
      const [status, data] = await Promise.all([
        rpc<BrowserStatus>('GET', 'status'),
        rpc<{ sessions: BrowserSession[] }>('GET', 'sessions'),
      ]);
      state.status = status;
      state.sessions = data.sessions;
      if (!state.selectedId || !state.sessions.some((session) => session.id === state.selectedId)) {
        state.selectedId = state.sessions[0]?.id || null;
      }
      state.error = null;
    } catch (error) {
      state.error = error instanceof Error ? error.message : String(error);
    } finally {
      state.refreshing = false;
      render();
    }
  }

  async function runAction(action: () => Promise<void>): Promise<void> {
    state.busy = true;
    state.error = null;
    render();
    try {
      await action();
      await refresh();
    } catch (error) {
      state.error = error instanceof Error ? error.message : String(error);
      render();
    } finally {
      state.busy = false;
      render();
    }
  }

  function feedbackText(): string {
    const session = selected();
    const selection = state.selection;
    const element = selection?.element;
    const elementName = element
      ? `<${element.tagName}>${element.id ? `#${element.id}` : ''}${element.className ? `.${element.className.split(/\s+/).slice(0, 3).join('.')}` : ''}`
      : 'No DOM element was resolved at the selection center';
    const region = selection
      ? `Selected viewport region: x=${Math.round(selection.x)}, y=${Math.round(selection.y)}, width=${Math.round(selection.width)}, height=${Math.round(selection.height)}.`
      : 'No region was selected; review the current page as needed.';
    return [
      'I am reviewing a UI through the CloudCLI Browser Feedback plugin.',
      `Browser session ID: ${session?.id || 'unknown'}. URL: ${session?.url || 'unknown'}.`,
      region,
      `Element at selection center: ${elementName}, role=${element?.role || 'none'}, aria-label=${element?.ariaLabel || 'none'}, text="${element?.text || ''}".`,
      'Please use the URL, region, and element details above to make the requested UI change.',
      `UI feedback: ${state.comment.trim()}`,
    ].join('\n');
  }

  function getSurfacePoint(event: { clientX: number; clientY: number }, surface: HTMLElement, session: BrowserSession): SurfacePoint | null {
    if (!session.viewport) return null;
    const rect = surface.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const localX = Math.max(0, Math.min(rect.width, event.clientX - rect.left));
    const localY = Math.max(0, Math.min(rect.height, event.clientY - rect.top));
    return { localX, localY, x: (localX / rect.width) * session.viewport.width, y: (localY / rect.height) * session.viewport.height };
  }

  async function inspectRegion(region: Omit<Selection, 'element'>): Promise<void> {
    const session = selected();
    if (!session) return;
    await runAction(async () => {
      const data = await rpc<{ element: ElementInfo | null }>('POST', `sessions/${session.id}/inspect`, {
        x: region.x + region.width / 2,
        y: region.y + region.height / 2,
      });
      state.selection = { ...region, element: data.element };
      state.notice = data.element ? 'Region selected. Add a note, then copy it into your chat.' : 'Region selected, but no DOM element was found at its center.';
    });
  }

  function attachSurface(surface: HTMLElement, session: BrowserSession): void {
    surface.dataset.mode = state.mode;
    surface.addEventListener('click', (event) => {
      if (state.mode !== 'interact' || state.busy) return;
      const point = getSurfacePoint(event, surface, session);
      if (!point) return;
      void runAction(async () => {
        await rpc('POST', `sessions/${session.id}/click`, { x: point.x, y: point.y });
      });
    });

    let wheelLocked = false;
    surface.addEventListener('wheel', (event) => {
      if (state.mode !== 'interact' || state.busy) return;
      event.preventDefault();
      if (wheelLocked) return;
      wheelLocked = true;
      void runAction(async () => {
        await rpc('POST', `sessions/${session.id}/scroll`, { deltaX: event.deltaX, deltaY: event.deltaY });
      }).finally(() => window.setTimeout(() => { wheelLocked = false; }, 120));
    }, { passive: false });

    surface.addEventListener('pointerdown', (event) => {
      if (state.mode !== 'select' || state.busy || !session.viewport) return;
      const start = getSurfacePoint(event, surface, session);
      if (!start) return;
      event.preventDefault();
      surface.setPointerCapture(event.pointerId);
      const draft = document.createElement('div');
      draft.className = 'bf-draft';
      surface.append(draft);
      const updateDraft = (point: SurfacePoint) => {
        draft.style.left = `${Math.min(start.localX, point.localX)}px`;
        draft.style.top = `${Math.min(start.localY, point.localY)}px`;
        draft.style.width = `${Math.abs(point.localX - start.localX)}px`;
        draft.style.height = `${Math.abs(point.localY - start.localY)}px`;
      };
      const move = (moveEvent: PointerEvent) => {
        const point = getSurfacePoint(moveEvent, surface, session);
        if (point) updateDraft(point);
      };
      const finish = (finishEvent: PointerEvent) => {
        surface.removeEventListener('pointermove', move);
        surface.removeEventListener('pointerup', finish);
        surface.removeEventListener('pointercancel', cancel);
        draft.remove();
        const end = getSurfacePoint(finishEvent, surface, session) || start;
        const left = Math.min(start.localX, end.localX);
        const top = Math.min(start.localY, end.localY);
        // A click or a very small drag is still a valid selection. This makes
        // Select region useful for small buttons and icons instead of failing silently.
        const localWidth = Math.max(1, Math.abs(end.localX - start.localX));
        const localHeight = Math.max(1, Math.abs(end.localY - start.localY));
        const x = (left / surface.clientWidth) * session.viewport!.width;
        const y = (top / surface.clientHeight) * session.viewport!.height;
        void inspectRegion({
          x,
          y,
          width: (localWidth / surface.clientWidth) * session.viewport!.width,
          height: (localHeight / surface.clientHeight) * session.viewport!.height,
        });
      };
      const cancel = () => {
        surface.removeEventListener('pointermove', move);
        surface.removeEventListener('pointerup', finish);
        surface.removeEventListener('pointercancel', cancel);
        draft.remove();
      };
      surface.addEventListener('pointermove', move);
      surface.addEventListener('pointerup', finish, { once: true });
      surface.addEventListener('pointercancel', cancel, { once: true });
    });
  }

  function render(): void {
    const session = selected();
    const runtime = state.status?.available ? 'Ready' : state.status?.message || 'Runtime setup required';
    const sessionsHtml = state.sessions.map((item) => `
      <button class="bf-session" data-session-id="${escapeHtml(item.id)}" data-selected="${String(item.id === session?.id)}">
        <div class="bf-session-name">${escapeHtml(item.title || domain(item.url))}</div>
        <div class="bf-session-url">${escapeHtml(domain(item.url))}</div>
        <div class="bf-session-meta">${escapeHtml(item.status)} · ${escapeHtml(actionLabel(item.lastAction))} · ${escapeHtml(relativeTime(item.updatedAt))}</div>
      </button>`).join('');
    const selectedRegion = state.selection
      ? `<div class="bf-selection">Selected region: ${Math.round(state.selection.width)}×${Math.round(state.selection.height)} at (${Math.round(state.selection.x)}, ${Math.round(state.selection.y)})${state.selection.element ? ` · &lt;${escapeHtml(state.selection.element.tagName)}&gt;` : ''}${state.selection.element ? `<div class="bf-element">${escapeHtml(state.selection.element.text || state.selection.element.className || 'Element selected')}</div>` : ''}</div>`
      : '';
    const surfaceHtml = session?.screenshotDataUrl
      ? `<div class="bf-surface" id="bf-surface" data-mode="${state.mode}"><img src="${session.screenshotDataUrl}" alt="Browser page screenshot" draggable="false">${session.cursor && session.viewport ? `<div class="bf-cursor" style="left:${(session.cursor.x / session.viewport.width) * 100}%;top:${(session.cursor.y / session.viewport.height) * 100}%"></div>` : ''}${state.selection && session.viewport ? `<div class="bf-region" style="left:${(state.selection.x / session.viewport.width) * 100}%;top:${(state.selection.y / session.viewport.height) * 100}%;width:${(state.selection.width / session.viewport.width) * 100}%;height:${(state.selection.height / session.viewport.height) * 100}%"></div>` : ''}</div>`
      : `<div class="bf-empty"><div><h2>${session?.message || 'No screenshot yet'}</h2><p>Open a page to start reviewing it.</p></div></div>`;
    root.innerHTML = `<style>${CSS}</style><div class="bf-wrap">
      <div class="bf-header"><div><div class="bf-title"><span class="bf-icon">✓</span> Browser UI Feedback</div><div class="bf-subtitle">Interact with a page, select a component, and copy a clear note into your chat.</div></div><button class="bf-button" id="bf-refresh" ${state.busy || state.refreshing ? 'disabled' : ''}>${state.refreshing ? 'Refreshing…' : 'Refresh'}</button></div>
      ${state.error ? `<div class="bf-error">${escapeHtml(state.error)}</div>` : ''}${state.notice ? `<div class="bf-notice">${escapeHtml(state.notice)}</div>` : ''}
      <div class="bf-card">
        <div class="bf-toolbar"><div class="bf-runtime">Runtime: <strong>${escapeHtml(runtime)}</strong></div>${state.status?.chromiumInstalled ? '' : `<button class="bf-button bf-primary" id="bf-install" ${state.busy || state.installing ? 'disabled' : ''}>${state.installing ? 'Installing…' : 'Install Chromium'}</button>`}</div>
        ${!session ? `<div class="bf-empty"><div class="bf-empty-inner"><h2>Open a page for UI review</h2><p>The browser runs on the CloudCLI server. Enter the page address below, then click or scroll directly on the screenshot.</p><div class="bf-open"><input class="bf-input" id="bf-open-url" value="${escapeHtml(state.openUrl)}" placeholder="https://your-ui.example"><button class="bf-button bf-primary" id="bf-open" ${state.busy || !state.status?.available ? 'disabled' : ''}>Open</button></div><div class="bf-pills"><span class="bf-pill">Click</span><span class="bf-pill">Scroll</span><span class="bf-pill">Select region</span><span class="bf-pill">Copy feedback</span></div></div></div>` : `<div class="bf-layout"><main class="bf-main"><div class="bf-toolbar"><button class="bf-button ${state.mode === 'interact' ? 'bf-active' : ''}" id="bf-interact">Interact</button><button class="bf-button ${state.mode === 'select' ? 'bf-active' : ''}" id="bf-select">Select region</button><span class="bf-controls-hint">${state.mode === 'select' ? 'Drag or click a component to select it.' : 'Click or scroll directly on the page.'}</span><div class="bf-type"><input class="bf-input" id="bf-type" value="${escapeHtml(state.typeText)}" placeholder="Type into focused field"><button class="bf-button" id="bf-type-button" ${state.busy || !state.typeText ? 'disabled' : ''}>Type</button></div></div><div class="bf-surface-wrap">${surfaceHtml}</div><div class="bf-feedback"><div class="bf-feedback-title">Copy UI feedback into chat</div>${selectedRegion}<div class="bf-feedback-row"><textarea class="bf-textarea" id="bf-comment" placeholder="For example: make this button more prominent and keep the spacing consistent.">${escapeHtml(state.comment)}</textarea><button class="bf-button bf-primary" id="bf-copy" ${state.busy || !state.comment.trim() ? 'disabled' : ''}>Copy feedback</button></div></div></main><aside class="bf-side"><div class="bf-side-title"><span>Sessions</span><span>${state.sessions.length}</span></div>${sessionsHtml || '<div class="bf-side-empty">No browser sessions.</div>'}<div style="margin-top:12px;display:grid;gap:7px"><button class="bf-button" id="bf-fullscreen" ${!session.screenshotDataUrl ? 'disabled' : ''}>Full screen</button><button class="bf-button" id="bf-stop" ${state.busy || session.status !== 'ready' ? 'disabled' : ''}>Stop session</button><button class="bf-button bf-danger" id="bf-delete" ${state.busy ? 'disabled' : ''}>Delete session</button></div></aside></div>`}
      </div>
    </div>`;
    applyTheme(root, state.context);
    wire();
  }

  function wire(): void {
    const session = selected();
    root.querySelector<HTMLButtonElement>('#bf-refresh')?.addEventListener('click', () => void refresh());
    root.querySelector<HTMLButtonElement>('#bf-install')?.addEventListener('click', () => void runAction(async () => {
      state.installing = true;
      render();
      try { await rpc('POST', 'runtime/install'); } finally { state.installing = false; }
    }));
    const openInput = root.querySelector<HTMLInputElement>('#bf-open-url');
    openInput?.addEventListener('input', () => { state.openUrl = openInput.value; });
    root.querySelector<HTMLButtonElement>('#bf-open')?.addEventListener('click', () => void runAction(async () => {
      const created = await rpc<BrowserSession>('POST', 'sessions');
      state.selectedId = created.id;
      const url = state.openUrl.trim();
      if (url) await rpc('POST', `sessions/${created.id}/navigate`, { url });
    }));
    root.querySelector<HTMLButtonElement>('#bf-interact')?.addEventListener('click', () => { state.mode = 'interact'; render(); });
    root.querySelector<HTMLButtonElement>('#bf-select')?.addEventListener('click', () => { state.mode = 'select'; state.notice = 'Drag over a component or click a small button/icon to select it.'; render(); });
    root.querySelectorAll<HTMLButtonElement>('[data-session-id]').forEach((button) => button.addEventListener('click', () => { state.selectedId = button.dataset.sessionId || null; state.selection = null; render(); }));
    const typeInput = root.querySelector<HTMLInputElement>('#bf-type');
    typeInput?.addEventListener('input', () => { state.typeText = typeInput.value; });
    root.querySelector<HTMLButtonElement>('#bf-type-button')?.addEventListener('click', () => void runAction(async () => {
      if (!session) return;
      await rpc('POST', `sessions/${session.id}/type`, { text: state.typeText });
      state.typeText = '';
    }));
    const commentInput = root.querySelector<HTMLTextAreaElement>('#bf-comment');
    commentInput?.addEventListener('input', () => { state.comment = commentInput.value; });
    root.querySelector<HTMLButtonElement>('#bf-copy')?.addEventListener('click', async () => {
      try {
        await copyText(feedbackText());
        state.notice = 'Feedback copied. Paste it into the chat composer.';
        state.error = null;
        render();
      } catch (error) { state.error = error instanceof Error ? error.message : String(error); render(); }
    });
    root.querySelector<HTMLButtonElement>('#bf-stop')?.addEventListener('click', () => void runAction(async () => {
      if (session) await rpc('POST', `sessions/${session.id}/stop`);
    }));
    root.querySelector<HTMLButtonElement>('#bf-delete')?.addEventListener('click', () => void runAction(async () => {
      if (session) await rpc('DELETE', `sessions/${session.id}`);
      state.selectedId = null;
      state.selection = null;
    }));
    root.querySelector<HTMLButtonElement>('#bf-fullscreen')?.addEventListener('click', () => { state.fullscreen = true; renderFullscreen(); });
    const surface = root.querySelector<HTMLElement>('#bf-surface');
    if (surface && session) attachSurface(surface, session);
  }

  function renderFullscreen(): void {
    root.querySelector('.bf-fullscreen')?.remove();
    if (!state.fullscreen) return;
    const session = selected();
    if (!session?.screenshotDataUrl) return;
    const overlay = document.createElement('div');
    overlay.className = 'bf-fullscreen';
    overlay.innerHTML = `<div class="bf-fullscreen-head"><span>${escapeHtml(session.title || session.url || 'Browser session')}</span><button class="bf-button" id="bf-close-fullscreen">Close</button></div><div class="bf-surface-wrap"><div class="bf-surface" id="bf-fullscreen-surface" data-mode="${state.mode}"><img src="${session.screenshotDataUrl}" alt="Browser page screenshot" draggable="false"></div></div>`;
    root.append(overlay);
    overlay.querySelector<HTMLButtonElement>('#bf-close-fullscreen')?.addEventListener('click', () => { state.fullscreen = false; overlay.remove(); });
    const fullscreenSurface = overlay.querySelector<HTMLElement>('#bf-fullscreen-surface');
    if (fullscreenSurface) attachSurface(fullscreenSurface, session);
  }

  const unsubscribe = api.onContextChange((context) => { state.context = context; applyTheme(root, context); });
  const refreshTimer = window.setInterval(() => { if (!state.busy) void refresh(); }, 2500);
  render();
  void refresh();

  (container as HTMLElement & { __browserFeedbackCleanup?: () => void }).__browserFeedbackCleanup = () => {
    unsubscribe();
    window.clearInterval(refreshTimer);
  };
}

export function unmount(container: HTMLElement): void {
  const cleanup = (container as HTMLElement & { __browserFeedbackCleanup?: () => void }).__browserFeedbackCleanup;
  cleanup?.();
  container.replaceChildren();
}
