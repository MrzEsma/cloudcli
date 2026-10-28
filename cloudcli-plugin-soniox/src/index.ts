import { SonioxClient, type RealtimeResult, type Recording, type RecordingState } from '@soniox/client';

import { LiveTranscriptBuffer } from './live-transcript.js';
import type { PluginAPI, PluginContext } from './types.js';

interface ConfigResponse {
  apiKeySet: boolean;
  apiKeyPreview: string;
  managed: boolean;
  model: string;
  languageHints: string[];
  httpsProxy: string;
  transcribeTimeoutMs: number;
}

interface RealtimeKeyResponse {
  apiKey: string;
  expiresAt?: string;
  model: string;
  languageHints: string[];
}

interface UsageResponse {
  window: { startTime: string; endTime: string };
  requests: number;
  totalCostUsd: number;
  totalAudioSeconds: number;
  byModel: Record<string, { requests: number; costUsd: number; audioSeconds: number }>;
  budgetRemainingUsd: number | null;
  budgetNote: string;
}

const DEFAULT_MODEL = 'stt-async-v5';
const REALTIME_MODEL = 'stt-rt-v5';
const MODEL_OPTIONS = ['stt-async-v5', 'stt-async-v4', 'stt-async-v3'];

function normalizeModel(model: string | undefined): string {
  const cleaned = typeof model === 'string' ? model.trim() : '';
  if (MODEL_OPTIONS.includes(cleaned)) return cleaned;
  if (cleaned === 'stt-async-preview') return DEFAULT_MODEL;
  return DEFAULT_MODEL;
}

function applyTheme(root: HTMLElement, context: PluginContext): void {
  const dark = context.theme === 'dark';
  root.style.setProperty('--sx-bg', dark ? '#09090b' : '#fafafa');
  root.style.setProperty('--sx-surface', dark ? '#18181b' : '#ffffff');
  root.style.setProperty('--sx-surface-2', dark ? '#27272a' : '#f4f4f5');
  root.style.setProperty('--sx-border', dark ? '#3f3f46' : '#e4e4e7');
  root.style.setProperty('--sx-text', dark ? '#fafafa' : '#18181b');
  root.style.setProperty('--sx-muted', dark ? '#a1a1aa' : '#71717a');
  root.style.setProperty('--sx-accent', '#06b6d4');
  root.style.setProperty('--sx-danger', '#ef4444');
  root.style.setProperty('--sx-success', '#22c55e');
}

function setStatus(element: HTMLElement, message: string, kind: 'normal' | 'error' | 'success' = 'normal'): void {
  element.textContent = message;
  element.dataset.kind = kind;
}

export function mount(container: HTMLElement, api: PluginAPI): void {
  const root = document.createElement('div');
  root.className = 'sx-root';
  root.innerHTML = `
    <style>
      .sx-root { min-height:100%; box-sizing:border-box; padding:24px; background:var(--sx-bg); color:var(--sx-text); font:14px/1.5 ui-sans-serif,system-ui,-apple-system,sans-serif; }
      .sx-wrap { max-width:820px; margin:0 auto; }
      .sx-header { display:flex; align-items:center; gap:14px; margin-bottom:20px; }
      .sx-logo { width:44px; height:44px; display:grid; place-items:center; border-radius:12px; background:color-mix(in srgb,var(--sx-accent) 16%,transparent); color:var(--sx-accent); font-size:23px; }
      .sx-title { font-size:20px; font-weight:700; }
      .sx-subtitle { color:var(--sx-muted); font-size:13px; }
      .sx-card { border:1px solid var(--sx-border); border-radius:12px; padding:18px; background:var(--sx-surface); margin-bottom:14px; }
      .sx-card h2 { font-size:14px; margin:0 0 14px; }
      .sx-grid { display:grid; grid-template-columns:1fr 1fr; gap:12px; }
      .sx-field { display:flex; flex-direction:column; gap:5px; }
      .sx-field.sx-full { grid-column:1/-1; }
      .sx-field label { color:var(--sx-muted); font-size:12px; font-weight:600; }
      .sx-input,.sx-select,.sx-output { box-sizing:border-box; width:100%; border:1px solid var(--sx-border); border-radius:8px; padding:9px 10px; background:var(--sx-bg); color:var(--sx-text); outline:none; }
      .sx-input:focus,.sx-select:focus,.sx-output:focus { border-color:var(--sx-accent); box-shadow:0 0 0 2px color-mix(in srgb,var(--sx-accent) 20%,transparent); }
      .sx-output { min-height:110px; resize:vertical; font:14px/1.65 ui-sans-serif,system-ui,sans-serif; }
      .sx-actions { display:flex; flex-wrap:wrap; gap:8px; margin-top:14px; }
      .sx-button { appearance:none; border:1px solid var(--sx-border); border-radius:8px; padding:8px 12px; background:var(--sx-surface-2); color:var(--sx-text); font-weight:600; cursor:pointer; }
      .sx-button:hover { border-color:var(--sx-accent); }
      .sx-button:disabled { opacity:.5; cursor:not-allowed; }
      .sx-primary { background:var(--sx-accent); border-color:var(--sx-accent); color:#06252b; }
      .sx-record { min-width:150px; }
      .sx-record[data-recording="true"] { background:var(--sx-danger); border-color:var(--sx-danger); color:white; }
      .sx-live { display:inline-flex; align-items:center; gap:6px; color:var(--sx-muted); font-size:12px; }
      .sx-live::before { content:""; width:8px; height:8px; border-radius:999px; background:var(--sx-muted); }
      .sx-live[data-active="true"] { color:var(--sx-success); }
      .sx-live[data-active="true"]::before { background:var(--sx-success); box-shadow:0 0 0 4px color-mix(in srgb,var(--sx-success) 18%,transparent); animation:sx-pulse 1.4s ease-in-out infinite; }
      @keyframes sx-pulse { 50% { opacity:.45; } }
      .sx-status { margin-top:10px; min-height:20px; color:var(--sx-muted); font-size:12px; }
      .sx-status[data-kind="error"] { color:var(--sx-danger); }
      .sx-status[data-kind="success"] { color:var(--sx-success); }
      .sx-note { padding:11px 12px; border-radius:8px; background:color-mix(in srgb,var(--sx-accent) 9%,transparent); color:var(--sx-muted); font-size:12px; }
      .sx-secret { color:var(--sx-success); font-size:12px; margin-top:4px; }
      @media (max-width:640px) { .sx-root{padding:14px}.sx-grid{grid-template-columns:1fr}.sx-field.sx-full{grid-column:auto} }
    </style>
    <div class="sx-wrap">
      <div class="sx-header">
        <div class="sx-logo">◉</div>
        <div><div class="sx-title">Soniox Voice</div><div class="sx-subtitle">Fast multilingual speech-to-text for CloudCLI</div></div>
      </div>

      <section class="sx-card">
        <h2>Configuration</h2>
        <div class="sx-grid">
          <div id="sx-key-field" class="sx-field sx-full">
            <label for="sx-api-key">Soniox API key</label>
            <input id="sx-api-key" class="sx-input" type="password" autocomplete="off" placeholder="Paste a new key to set or replace it">
            <div id="sx-key-state" class="sx-secret">Not configured</div>
          </div>
          <div class="sx-field">
            <label for="sx-model">Async fallback model</label>
            <select id="sx-model" class="sx-select">
              <option value="stt-async-v5">stt-async-v5</option>
              <option value="stt-async-v4">stt-async-v4</option>
              <option value="stt-async-v3">stt-async-v3</option>
            </select>
          </div>
          <div class="sx-field">
            <label for="sx-language">Language hints (comma-separated)</label>
            <input id="sx-language" class="sx-input" value="fa" placeholder="fa,en">
          </div>
          <div id="sx-proxy-field" class="sx-field sx-full">
            <label for="sx-proxy">HTTPS proxy (optional)</label>
            <input id="sx-proxy" class="sx-input" placeholder="http://127.0.0.1:2081">
          </div>
        </div>
        <div class="sx-actions">
          <button id="sx-save" class="sx-button sx-primary">Save settings</button>
          <button id="sx-test" class="sx-button">Test connection</button>
          <button id="sx-clear-key" class="sx-button">Clear API key</button>
        </div>
        <div id="sx-config-status" class="sx-status"></div>
      </section>

      <section class="sx-card">
        <h2>Live transcription</h2>
        <div class="sx-note">Words appear below while you speak using Soniox ${REALTIME_MODEL}. Stop only finalizes the last provisional words. CloudCLI's built-in composer microphone still uses its batch bridge and returns text after stopping.</div>
        <div class="sx-actions">
          <button id="sx-record" class="sx-button sx-primary sx-record" data-recording="false">● Start live transcription</button>
          <button id="sx-copy" class="sx-button" disabled>Copy transcript</button>
          <span id="sx-live" class="sx-live" data-active="false">Offline</span>
        </div>
        <div id="sx-record-status" class="sx-status" aria-live="polite">Ready.</div>
        <textarea id="sx-output" class="sx-output" dir="auto" placeholder="Your live transcript will appear here…"></textarea>
      </section>

      <section id="sx-usage-card" class="sx-card">
        <h2>Usage</h2>
        <div class="sx-note">Shows spend for the current UTC month from Soniox usage logs. Remaining budget is not exposed by the API; that comes from Soniox Console billing/budgets.</div>
        <div class="sx-actions">
          <button id="sx-usage" class="sx-button sx-primary">Refresh usage</button>
        </div>
        <div id="sx-usage-status" class="sx-status">Not loaded yet.</div>
      </section>
    </div>`;
  container.appendChild(root);
  applyTheme(root, api.context);

  const apiKeyInput = root.querySelector<HTMLInputElement>('#sx-api-key')!;
  const keyField = root.querySelector<HTMLElement>('#sx-key-field')!;
  const keyState = root.querySelector<HTMLElement>('#sx-key-state')!;
  const modelInput = root.querySelector<HTMLSelectElement>('#sx-model')!;
  const languageInput = root.querySelector<HTMLInputElement>('#sx-language')!;
  const proxyInput = root.querySelector<HTMLInputElement>('#sx-proxy')!;
  const proxyField = root.querySelector<HTMLElement>('#sx-proxy-field')!;
  const saveButton = root.querySelector<HTMLButtonElement>('#sx-save')!;
  const testButton = root.querySelector<HTMLButtonElement>('#sx-test')!;
  const clearKeyButton = root.querySelector<HTMLButtonElement>('#sx-clear-key')!;
  const configStatus = root.querySelector<HTMLElement>('#sx-config-status')!;
  const recordButton = root.querySelector<HTMLButtonElement>('#sx-record')!;
  const copyButton = root.querySelector<HTMLButtonElement>('#sx-copy')!;
  const liveIndicator = root.querySelector<HTMLElement>('#sx-live')!;
  const recordStatus = root.querySelector<HTMLElement>('#sx-record-status')!;
  const output = root.querySelector<HTMLTextAreaElement>('#sx-output')!;
  const usageButton = root.querySelector<HTMLButtonElement>('#sx-usage')!;
  const usageStatus = root.querySelector<HTMLElement>('#sx-usage-status')!;
  const usageCard = root.querySelector<HTMLElement>('#sx-usage-card')!;

  let recording: Recording | null = null;
  let languageHints = ['fa'];
  const transcript = new LiveTranscriptBuffer();
  const client = new SonioxClient({
    config: async () => {
      const result = await api.rpc('POST', 'realtime-key', {}) as RealtimeKeyResponse;
      if (!result.apiKey) throw new Error('Soniox did not return a temporary real-time key.');
      return { api_key: result.apiKey };
    },
  });

  function renderTranscript(): void {
    output.value = transcript.text;
    output.scrollTop = output.scrollHeight;
    copyButton.disabled = !output.value;
  }

  function setRecordingUi(active: boolean): void {
    recordButton.dataset.recording = String(active);
    recordButton.textContent = active ? '■ Stop and finalize' : '● Start live transcription';
    liveIndicator.dataset.active = String(active);
    liveIndicator.textContent = active ? 'Live' : 'Offline';
  }

  function isTerminalState(state: RecordingState): boolean {
    return state === 'stopped' || state === 'error' || state === 'canceled';
  }

  async function loadConfig(): Promise<void> {
    try {
      const config = await api.rpc('GET', 'config') as ConfigResponse;
      keyState.textContent = config.managed
        ? 'Included and managed by your CloudCLI service'
        : (config.apiKeySet ? `Configured (${config.apiKeyPreview})` : 'Not configured');
      apiKeyInput.hidden = config.managed;
      const keyLabel = keyField.querySelector('label');
      if (keyLabel) keyLabel.hidden = config.managed;
      proxyField.hidden = config.managed;
      clearKeyButton.hidden = config.managed;
      usageCard.hidden = config.managed;
      modelInput.value = normalizeModel(config.model);
      languageHints = config.languageHints?.length ? config.languageHints : ['fa'];
      languageInput.value = languageHints.join(',');
      proxyInput.value = config.httpsProxy || '';
    } catch (error) {
      setStatus(configStatus, (error as Error).message, 'error');
    }
  }

  saveButton.addEventListener('click', async () => {
    saveButton.disabled = true;
    setStatus(configStatus, 'Saving…');
    try {
      await api.rpc('POST', 'config', {
        ...(apiKeyInput.value.trim() ? { apiKey: apiKeyInput.value.trim() } : {}),
        model: modelInput.value,
        languageHints: languageInput.value.split(',').map((value) => value.trim()).filter(Boolean),
        httpsProxy: proxyInput.value.trim(),
      });
      apiKeyInput.value = '';
      await loadConfig();
      setStatus(configStatus, 'Settings saved securely on the CloudCLI host.', 'success');
    } catch (error) {
      setStatus(configStatus, (error as Error).message, 'error');
    } finally {
      saveButton.disabled = false;
    }
  });

  testButton.addEventListener('click', async () => {
    testButton.disabled = true;
    setStatus(configStatus, 'Connecting to Soniox…');
    try {
      const result = await api.rpc('POST', 'validate', {}) as { models?: string[]; supportsPersian?: boolean };
      const modelCount = result.models?.length || 0;
      setStatus(configStatus, `Connected. ${modelCount} model(s) available${result.supportsPersian ? '; Persian supported.' : '.'}`, 'success');
    } catch (error) {
      setStatus(configStatus, (error as Error).message, 'error');
    } finally {
      testButton.disabled = false;
    }
  });

  clearKeyButton.addEventListener('click', async () => {
    if (!window.confirm('Remove the saved Soniox API key from this machine?')) return;
    try {
      await api.rpc('POST', 'config', { clearApiKey: true });
      await loadConfig();
      setStatus(configStatus, 'API key removed.', 'success');
    } catch (error) {
      setStatus(configStatus, (error as Error).message, 'error');
    }
  });

  usageButton.addEventListener('click', async () => {
    usageButton.disabled = true;
    setStatus(usageStatus, 'Loading usage…');
    try {
      const result = await api.rpc('GET', 'usage', {}) as UsageResponse;
      const cost = result.totalCostUsd.toFixed(4);
      const hours = (result.totalAudioSeconds / 3600).toFixed(2);
      const models = Object.entries(result.byModel)
        .map(([model, stats]) => `${model}: $${stats.costUsd.toFixed(4)} (${stats.requests} req)`)
        .join(' · ');
      setStatus(
        usageStatus,
        `This month: $${cost} across ${result.requests} request(s), ~${hours}h audio. ${models || ''} ${result.budgetNote}`,
        'success',
      );
    } catch (error) {
      setStatus(usageStatus, (error as Error).message, 'error');
    } finally {
      usageButton.disabled = false;
    }
  });

  async function stopRecording(): Promise<void> {
    const active = recording;
    if (!active) return;

    recordButton.disabled = true;
    setStatus(recordStatus, 'Finalizing the last words…');
    try {
      await active.stop();
      transcript.clearInterim();
      renderTranscript();
      setStatus(
        recordStatus,
        output.value ? 'Live transcription complete.' : 'Soniox returned an empty transcript.',
        output.value ? 'success' : 'normal',
      );
    } catch (error) {
      setStatus(recordStatus, (error as Error).message, 'error');
    } finally {
      if (recording === active) recording = null;
      setRecordingUi(false);
      recordButton.disabled = false;
    }
  }

  function startRecording(): void {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setStatus(recordStatus, 'Microphone recording is not supported by this browser.', 'error');
      return;
    }

    transcript.reset();
    renderTranscript();
    let sessionStarted = false;

    try {
      const session = client.realtime.record({
        model: REALTIME_MODEL,
        language_hints: languageHints,
        enable_endpoint_detection: true,
        auto_reconnect: true,
        max_reconnect_attempts: 3,
      });
      recording = session;
      setRecordingUi(true);
      setStatus(recordStatus, 'Opening microphone and connecting to Soniox…');

      session.on('result', (result: RealtimeResult) => {
        if (recording !== session) return;
        transcript.add(result.tokens);
        renderTranscript();
        const processedSeconds = result.total_audio_proc_ms / 1000;
        setStatus(recordStatus, `Listening… ${processedSeconds.toFixed(1)}s processed live.`);
      });
      session.on('connected', () => {
        if (recording === session) setStatus(recordStatus, 'Listening… Speak normally; words will appear live.', 'success');
      });
      session.on('reconnecting', ({ attempt, max_attempts }) => {
        if (recording === session) setStatus(recordStatus, `Connection interrupted; reconnecting (${attempt}/${max_attempts})…`);
      });
      session.on('session_restart', ({ reset_transcript }) => {
        if (recording !== session) return;
        if (sessionStarted) {
          if (reset_transcript) transcript.reset();
          else transcript.clearInterim();
          renderTranscript();
        }
        sessionStarted = true;
      });
      session.on('source_muted', () => {
        if (recording === session) setStatus(recordStatus, 'Microphone is muted.');
      });
      session.on('source_unmuted', () => {
        if (recording === session) setStatus(recordStatus, 'Listening… Speak normally; words will appear live.', 'success');
      });
      session.on('error', (error: Error) => {
        if (recording !== session) return;
        recording = null;
        setRecordingUi(false);
        recordButton.disabled = false;
        setStatus(recordStatus, error.message, 'error');
      });
      session.on('state_change', ({ new_state }) => {
        if (recording === session && isTerminalState(new_state)) {
          recording = null;
          setRecordingUi(false);
          recordButton.disabled = false;
        }
      });
    } catch (error) {
      recording = null;
      setRecordingUi(false);
      setStatus(recordStatus, `Microphone error: ${(error as Error).message}`, 'error');
    }
  }

  recordButton.addEventListener('click', () => {
    if (recording) void stopRecording();
    else startRecording();
  });

  copyButton.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(output.value);
      setStatus(recordStatus, 'Transcript copied.', 'success');
    } catch {
      output.select();
      document.execCommand('copy');
      setStatus(recordStatus, 'Transcript copied.', 'success');
    }
  });

  const unsubscribe = api.onContextChange((context) => applyTheme(root, context));
  (container as HTMLElement & { _sonioxCleanup?: () => void })._sonioxCleanup = () => {
    unsubscribe();
    const active = recording;
    recording = null;
    active?.cancel();
  };
  void loadConfig();
}

export function unmount(container: HTMLElement): void {
  const extended = container as HTMLElement & { _sonioxCleanup?: () => void };
  extended._sonioxCleanup?.();
  delete extended._sonioxCleanup;
  container.innerHTML = '';
}
