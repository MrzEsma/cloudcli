import type { PluginAPI, PluginContext } from './types.js';

type SetupStatus = {
  configured: boolean;
  method: 'api_key' | 'chatgpt' | 'none';
  provider: 'openai' | 'hooshcode';
  managedByTenant: boolean;
  model: string;
  claude: {
    configured: boolean;
    managedByTenant: boolean;
    method: 'iclaude' | 'api_key' | 'none';
    managedTeam: boolean;
  };
};

type ModelProxyEntry = {
  id: string;
  name: string;
  claudeBaseUrl: string;
  codexBaseUrl: string;
  hasToken: boolean;
};

const MODELS = {
  openai: [
    { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol · strongest' },
    { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra · balanced' },
    { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna · economical' },
    { id: 'gpt-5.5', label: 'GPT-5.5' },
    { id: 'gpt-5.4', label: 'GPT-5.4' },
    { id: 'gpt-5.4-mini', label: 'GPT-5.4 mini' },
  ],
  hooshcode: [
    { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol · strongest' },
    { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra · balanced' },
    { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna · economical' },
  ],
} as const;

const PROVIDERS = [
  { id: 'openai', label: 'OpenAI مستقیم' },
  { id: 'hooshcode', label: 'هوش کد · پراکسی' },
  { id: 'hooshcode_claude', label: 'هوش کد · Claude Code' },
  { id: 'iclaude_team', label: 'Claude · حساب تیم' },
] as const;

function applyTheme(root: HTMLElement, context: PluginContext): void {
  const dark = context.theme === 'dark';
  root.style.setProperty('--oa-bg', dark ? '#09090b' : '#fafafa');
  root.style.setProperty('--oa-card', dark ? '#18181b' : '#ffffff');
  root.style.setProperty('--oa-input', dark ? '#0f0f12' : '#ffffff');
  root.style.setProperty('--oa-border', dark ? '#3f3f46' : '#e4e4e7');
  root.style.setProperty('--oa-text', dark ? '#fafafa' : '#18181b');
  root.style.setProperty('--oa-muted', dark ? '#a1a1aa' : '#71717a');
  root.style.setProperty('--oa-accent', dark ? '#34d399' : '#059669');
  root.style.setProperty('--oa-danger', dark ? '#f87171' : '#dc2626');
}

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : 'خطای غیرمنتظره در تنظیم اتصال.';
}

export function mount(container: HTMLElement, api: PluginAPI): void {
  const root = document.createElement('div');
  root.className = 'oa-root';
  root.innerHTML = `
    <style>
      .oa-root{min-height:100%;box-sizing:border-box;padding:28px;background:var(--oa-bg);color:var(--oa-text);font:14px/1.55 ui-sans-serif,system-ui,-apple-system,sans-serif}
      .oa-wrap{max-width:720px;margin:0 auto}.oa-header{display:flex;align-items:center;gap:14px;margin-bottom:22px}
      .oa-mark{width:46px;height:46px;border-radius:14px;display:grid;place-items:center;background:color-mix(in srgb,var(--oa-accent) 15%,transparent);color:var(--oa-accent);font-size:23px}
      .oa-title{font-size:21px;font-weight:750}.oa-subtitle{color:var(--oa-muted);font-size:13px}.oa-card{border:1px solid var(--oa-border);border-radius:14px;padding:20px;background:var(--oa-card);margin-bottom:14px}
      .oa-state{display:flex;align-items:flex-start;gap:12px}.oa-dot{width:10px;height:10px;margin-top:5px;border-radius:999px;background:var(--oa-muted)}.oa-state[data-ready=true] .oa-dot{background:var(--oa-accent);box-shadow:0 0 0 5px color-mix(in srgb,var(--oa-accent) 14%,transparent)}
      .oa-state-title{font-weight:700}.oa-state-detail{color:var(--oa-muted);font-size:12px;margin-top:2px}.oa-grid{display:grid;gap:14px}.oa-field{display:flex;flex-direction:column;gap:6px}.oa-field label{font-size:12px;font-weight:650;color:var(--oa-muted)}
      .oa-input,.oa-select{box-sizing:border-box;width:100%;border:1px solid var(--oa-border);border-radius:9px;padding:10px 11px;background:var(--oa-input);color:var(--oa-text);outline:none}.oa-input:focus,.oa-select:focus{border-color:var(--oa-accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--oa-accent) 14%,transparent)}
      .oa-row{display:flex;gap:9px;flex-wrap:wrap}.oa-button{appearance:none;border:1px solid var(--oa-border);border-radius:9px;padding:9px 13px;background:transparent;color:var(--oa-text);font-weight:650;cursor:pointer}.oa-button:hover{border-color:var(--oa-accent)}.oa-button:disabled{opacity:.55;cursor:not-allowed}.oa-primary{background:var(--oa-accent);border-color:var(--oa-accent);color:white}.oa-danger{color:var(--oa-danger)}
      .oa-status{min-height:21px;margin-top:10px;color:var(--oa-muted);font-size:12px}.oa-status[data-kind=error]{color:var(--oa-danger)}.oa-status[data-kind=success]{color:var(--oa-accent)}
      .oa-note{color:var(--oa-muted);font-size:12px}.oa-note strong{color:var(--oa-text)}.oa-note a{color:var(--oa-accent);text-decoration:none}.oa-note a:hover{text-decoration:underline}
      @media(max-width:640px){.oa-root{padding:15px}.oa-card{padding:16px}}
      .oa-proxy-head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;margin-bottom:12px}
      .oa-proxy-list{display:grid;gap:8px}
      .oa-proxy-item{display:flex;align-items:center;gap:10px;justify-content:space-between;border:1px solid var(--oa-border);border-radius:10px;padding:10px 12px}
      .oa-proxy-item-name{font-weight:650}
      .oa-proxy-item-url{color:var(--oa-muted);font-size:11px;direction:ltr;text-align:left;word-break:break-all}
      .oa-badges{display:flex;gap:5px;margin-top:3px}
      .oa-badge{font-size:10px;font-weight:650;border:1px solid var(--oa-border);border-radius:6px;padding:1px 7px;color:var(--oa-muted)}
      .oa-mini{appearance:none;border:1px solid var(--oa-border);border-radius:8px;padding:6px 10px;background:transparent;color:var(--oa-text);font-weight:600;cursor:pointer;font-size:12px}
      .oa-mini:hover{border-color:var(--oa-accent)}
    </style>
    <div class="oa-wrap" dir="rtl">
      <header class="oa-header">
        <div class="oa-mark">⌁</div>
        <div><div class="oa-title">اتصال Codex و Claude Code</div><div class="oa-subtitle">ارائه‌دهنده و کلید اختصاصی همین فضای CloudCLI را انتخاب کنید</div></div>
      </header>

      <section class="oa-card">
        <div id="oa-state" class="oa-state" data-ready="false">
          <span class="oa-dot"></span>
          <div><div id="oa-state-title" class="oa-state-title">در حال بررسی اتصال…</div><div id="oa-state-detail" class="oa-state-detail"></div></div>
        </div>
      </section>

      <section class="oa-card">
        <div class="oa-grid">
          <div class="oa-field">
            <label for="oa-provider">نوع اتصال</label>
            <select id="oa-provider" class="oa-select">${PROVIDERS.map((provider) => `<option value="${provider.id}"${provider.id === 'iclaude_team' ? ' hidden disabled' : ''}>${provider.label}</option>`).join('')}</select>
          </div>
          <div id="oa-key-field" class="oa-field">
            <label id="oa-key-label" for="oa-key">OpenAI API key</label>
            <input id="oa-key" class="oa-input" type="password" autocomplete="new-password" autocapitalize="off" spellcheck="false" placeholder="کلید را وارد کنید؛ دوباره نمایش داده نمی‌شود">
          </div>
          <div class="oa-field" id="oa-model-field">
            <label for="oa-model">مدل پیش‌فرض Codex</label>
            <select id="oa-model" class="oa-select"></select>
          </div>
          <div id="oa-credential-actions" class="oa-row">
            <button id="oa-save" class="oa-button oa-primary">ذخیره اتصال</button>
            <button id="oa-remove" class="oa-button oa-danger">حذف کلید</button>
          </div>
        </div>
        <div id="oa-status" class="oa-status" aria-live="polite"></div>
      </section>

      <section id="oa-proxy-card" class="oa-card">
        <div class="oa-proxy-head">
          <div>
            <div class="oa-title" style="font-size:16px">پروکسی‌های مدل اضافه</div>
            <div class="oa-subtitle">با یک Base URL و توکن، پروکسی جدید ثبت کنید؛ بعد در انتخاب مدل هر سشن، مدل‌ها با پسوند «· نام پروکسی» ظاهر می‌شوند (opus@پروکسی).</div>
          </div>
        </div>
        <div id="oa-proxy-list" class="oa-proxy-list"></div>
        <div class="oa-grid" style="margin-top:14px">
          <div class="oa-field">
            <label for="oa-proxy-name">نام پروکسی</label>
            <input id="oa-proxy-name" class="oa-input" type="text" autocomplete="off" placeholder="مثلاً proxy2">
          </div>
          <div class="oa-field">
            <label for="oa-proxy-token">توکن</label>
            <input id="oa-proxy-token" class="oa-input" type="password" autocomplete="new-password" spellcheck="false" placeholder="توکن پروکسی">
          </div>
          <div class="oa-field">
            <label for="oa-proxy-claude">Base URL مخصوص Claude (اختیاری)</label>
            <input id="oa-proxy-claude" class="oa-input" type="url" dir="ltr" spellcheck="false" placeholder="https://example.com">
          </div>
          <div class="oa-field">
            <label for="oa-proxy-codex">Base URL مخصوص Codex (اختیاری)</label>
            <input id="oa-proxy-codex" class="oa-input" type="url" dir="ltr" spellcheck="false" placeholder="https://example.com/codex">
          </div>
          <div class="oa-row">
            <button id="oa-proxy-add" class="oa-button oa-primary">افزودن پروکسی</button>
          </div>
        </div>
        <div id="oa-proxy-status" class="oa-status" aria-live="polite"></div>
      </section>

      <section class="oa-card oa-note">
        <strong>مجزا برای هر tenant.</strong>
        <span id="oa-provider-note"></span>
        کلید بعد از ذخیره به مرورگر برگردانده نمی‌شود و فقط روی PVC همین tenant نگه‌داری می‌شود.
        <div id="oa-openai-link" style="margin-top:8px"><a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener noreferrer">ساخت یا لغو OpenAI API key ↗</a></div>
      </section>
    </div>`;
  container.appendChild(root);
  applyTheme(root, api.context);
  const unsubscribe = api.onContextChange((context) => applyTheme(root, context));

  const state = root.querySelector<HTMLElement>('#oa-state')!;
  const stateTitle = root.querySelector<HTMLElement>('#oa-state-title')!;
  const stateDetail = root.querySelector<HTMLElement>('#oa-state-detail')!;
  const providerInput = root.querySelector<HTMLSelectElement>('#oa-provider')!;
  const keyField = root.querySelector<HTMLElement>('#oa-key-field')!;
  const keyLabel = root.querySelector<HTMLElement>('#oa-key-label')!;
  const keyInput = root.querySelector<HTMLInputElement>('#oa-key')!;
  const modelField = root.querySelector<HTMLElement>('#oa-model-field')!;
  const modelInput = root.querySelector<HTMLSelectElement>('#oa-model')!;
  const saveButton = root.querySelector<HTMLButtonElement>('#oa-save')!;
  const removeButton = root.querySelector<HTMLButtonElement>('#oa-remove')!;
  const credentialActions = root.querySelector<HTMLElement>('#oa-credential-actions')!;
  const statusElement = root.querySelector<HTMLElement>('#oa-status')!;
  const providerNote = root.querySelector<HTMLElement>('#oa-provider-note')!;
  const openAiLink = root.querySelector<HTMLElement>('#oa-openai-link')!;
  const proxyCard = root.querySelector<HTMLElement>('#oa-proxy-card')!;
  let managedTeamClaude = false;

  function setStatus(message: string, kind: 'normal' | 'error' | 'success' = 'normal'): void {
    statusElement.textContent = message;
    statusElement.dataset.kind = kind;
  }

  function isClaudeProvider(): boolean {
    return providerInput.value === 'hooshcode_claude' || providerInput.value === 'iclaude_team';
  }

  function updateProviderCopy(): void {
    const isHooshCode = providerInput.value === 'hooshcode';
    const isClaude = isClaudeProvider();
    const isManagedClaude = providerInput.value === 'iclaude_team';
    keyField.style.display = isManagedClaude ? 'none' : 'flex';
    credentialActions.style.display = isManagedClaude ? 'none' : 'flex';
    keyLabel.textContent = isClaude ? 'توکن هوش کد برای Claude Code' : isHooshCode ? 'کلید API هوش کد' : 'OpenAI API key';
    keyInput.placeholder = isClaude ? 'توکن هوش کد مخصوص Claude Code' : isHooshCode ? 'کلید پراکسی هوش کد' : 'OpenAI API key';
    saveButton.textContent = isClaude ? 'اتصال Claude Code به هوش کد' : isHooshCode ? 'اتصال به هوش کد' : 'ذخیره و بررسی با OpenAI';
    providerNote.textContent = isManagedClaude
      ? ' اتصال Claude با حساب تیم توسط پلتفرم آماده و نگه‌داری می‌شود؛ نیازی به واردکردن کلید یا ورود جداگانه ندارید. '
      : isClaude
      ? ' در حالت «هوش کد · Claude Code»، توکن فقط برای Claude Code همین tenant ذخیره می‌شود و از مسیر Claude با هوش کد بررسی می‌شود. '
      : isHooshCode
        ? ' در حالت «هوش کد»، کلید به OpenAI فرستاده نمی‌شود و Codex از پراکسی هوش کد استفاده می‌کند. '
        : ' در حالت OpenAI، کلید مستقیماً با OpenAI بررسی می‌شود. ';
    openAiLink.style.display = isHooshCode || isClaude ? 'none' : 'block';
    modelField.style.display = isClaude ? 'none' : 'block';
  }

  function updateModelOptions(preferredModel?: string): void {
    const provider = providerInput.value === 'hooshcode' ? 'hooshcode' : 'openai';
    const models = MODELS[provider];
    const selected = models.some((model) => model.id === preferredModel) ? preferredModel : models[0].id;
    modelInput.replaceChildren(...models.map((model) => {
      const option = document.createElement('option');
      option.value = model.id;
      option.textContent = model.label;
      option.selected = model.id === selected;
      return option;
    }));
  }

  function renderClaudeStatus(status: SetupStatus): void {
    const isManaged = status.claude.method === 'iclaude';
    managedTeamClaude = isManaged;
    const legacyClaudeOption = providerInput.querySelector<HTMLOptionElement>('option[value="hooshcode_claude"]');
    const managedClaudeOption = providerInput.querySelector<HTMLOptionElement>('option[value="iclaude_team"]');
    if (legacyClaudeOption) {
      legacyClaudeOption.disabled = isManaged;
      legacyClaudeOption.hidden = isManaged;
    }
    if (managedClaudeOption) {
      managedClaudeOption.disabled = !isManaged;
      managedClaudeOption.hidden = !isManaged;
    }
    proxyCard.style.display = isManaged ? 'none' : 'block';
    updateProviderCopy();
    state.dataset.ready = String(status.claude.configured);
    if (isManaged) {
      stateTitle.textContent = status.claude.configured
        ? 'متصل از طریق حساب تیم'
        : 'اتصال حساب تیم هنوز آماده نیست';
      stateDetail.textContent = status.claude.configured
        ? 'مدیریت‌شده توسط پلتفرم · مدل‌های واقعی Claude آماده‌اند'
        : 'مدیر سرویس باید راه‌اندازی iClaude را تکمیل کند.';
    } else {
      stateTitle.textContent = status.claude.configured ? 'Claude Code به هوش کد متصل است' : 'توکن Claude Code تنظیم نشده است';
      stateDetail.textContent = status.claude.configured
        ? `هوش کد · ${status.claude.managedByTenant ? 'مدیریت‌شده توسط tenant' : 'مدیریت‌شده توسط پلتفرم'}`
        : 'توکن هوش کد مخصوص Claude Code را وارد کنید.';
    }
    removeButton.disabled = isManaged || !status.claude.configured;
  }

  let lastStatus: SetupStatus | null = null;

  async function refresh(): Promise<void> {
    const status = await api.rpc('GET', 'status') as SetupStatus;
    lastStatus = status;
    if (status.claude.method === 'iclaude') {
      providerInput.value = 'iclaude_team';
      renderClaudeStatus(status);
      return;
    }
    if (isClaudeProvider()) {
      renderClaudeStatus(status);
      return;
    }
    state.dataset.ready = String(status.configured);
    providerInput.value = status.provider === 'hooshcode' ? 'hooshcode' : 'openai';
    updateProviderCopy();
    updateModelOptions(status.model);
    const providerLabel = status.provider === 'hooshcode' ? 'هوش کد' : 'OpenAI';
    stateTitle.textContent = status.configured ? `Codex به ${providerLabel} متصل است` : 'کلید Codex تنظیم نشده است';
    stateDetail.textContent = status.configured
      ? `${providerLabel} · ${status.model} · مدیریت‌شده توسط tenant`
      : 'نوع اتصال را انتخاب و کلید همان ارائه‌دهنده را وارد کنید.';
    removeButton.disabled = !status.configured;
  }

  providerInput.addEventListener('change', () => {
    keyInput.value = '';
    updateProviderCopy();
    if (isClaudeProvider()) {
      if (lastStatus) renderClaudeStatus(lastStatus);
    } else {
      updateModelOptions(lastStatus?.model);
    }
    setStatus('برای تغییر نوع اتصال، کلید ارائه‌دهنده‌ی انتخاب‌شده را وارد کنید.');
  });

  saveButton.addEventListener('click', async () => {
    if (managedTeamClaude && providerInput.value === 'iclaude_team') {
      setStatus('اتصال حساب تیم توسط پلتفرم مدیریت می‌شود.');
      return;
    }
    saveButton.disabled = true;
    const isClaude = isClaudeProvider();
    setStatus(isClaude
      ? 'در حال بررسی توکن هوش کد برای Claude Code…'
      : providerInput.value === 'hooshcode' ? 'در حال ذخیره اتصال هوش کد…' : 'در حال بررسی امن با OpenAI…');
    try {
      await api.rpc('POST', 'configure', {
        ...(keyInput.value.trim() ? { apiKey: keyInput.value.trim() } : {}),
        provider: providerInput.value,
        ...(!isClaude ? { model: modelInput.value } : {}),
      });
      keyInput.value = '';
      await refresh();
      setStatus(isClaude
        ? 'اتصال ذخیره شد. sessionهای جدید Claude Code از هوش کد استفاده می‌کنند.'
        : 'اتصال ذخیره شد. sessionهای جدید Codex از همین provider استفاده می‌کنند.', 'success');
    } catch (error) {
      setStatus(messageFor(error), 'error');
    } finally {
      saveButton.disabled = false;
    }
  });

  removeButton.addEventListener('click', async () => {
    if (managedTeamClaude && providerInput.value === 'iclaude_team') {
      setStatus('اتصال حساب تیم توسط پلتفرم مدیریت می‌شود و قابل حذف نیست.');
      return;
    }
    const isClaude = isClaudeProvider();
    if (!window.confirm(isClaude ? 'توکن هوش کد Claude Code از این CloudCLI حذف شود؟' : 'کلید ذخیره‌شده از این CloudCLI حذف شود؟')) return;
    removeButton.disabled = true;
    setStatus('در حال حذف اتصال…');
    try {
      await api.rpc('DELETE', isClaude ? 'credentials/claude' : 'credentials');
      keyInput.value = '';
      await refresh();
      setStatus('credential حذف شد.', 'success');
    } catch (error) {
      setStatus(messageFor(error), 'error');
    } finally {
      removeButton.disabled = false;
    }
  });

  // ---- Model proxies card ------------------------------------------------
  const proxyList = root.querySelector<HTMLElement>('#oa-proxy-list')!;
  const proxyName = root.querySelector<HTMLInputElement>('#oa-proxy-name')!;
  const proxyToken = root.querySelector<HTMLInputElement>('#oa-proxy-token')!;
  const proxyClaude = root.querySelector<HTMLInputElement>('#oa-proxy-claude')!;
  const proxyCodex = root.querySelector<HTMLInputElement>('#oa-proxy-codex')!;
  const proxyAddButton = root.querySelector<HTMLButtonElement>('#oa-proxy-add')!;
  const proxyStatus = root.querySelector<HTMLElement>('#oa-proxy-status')!;

  function setProxyStatus(message: string, kind: 'normal' | 'error' | 'success' = 'normal'): void {
    proxyStatus.textContent = message;
    proxyStatus.dataset.kind = kind;
  }

  function renderProxies(proxies: ModelProxyEntry[]): void {
    if (proxies.length === 0) {
      proxyList.replaceChildren();
      return;
    }
    proxyList.replaceChildren(...proxies.map((entry) => {
      const item = document.createElement('div');
      item.className = 'oa-proxy-item';
      const info = document.createElement('div');
      const name = document.createElement('div');
      name.className = 'oa-proxy-item-name';
      name.textContent = entry.name;
      info.appendChild(name);
      const urls = document.createElement('div');
      urls.className = 'oa-proxy-item-url';
      urls.textContent = entry.claudeBaseUrl || entry.codexBaseUrl;
      info.appendChild(urls);
      const badges = document.createElement('div');
      badges.className = 'oa-badges';
      for (const [kind, enabled] of [['Claude', entry.claudeBaseUrl], ['Codex', entry.codexBaseUrl]] as const) {
        if (!enabled) continue;
        const badge = document.createElement('span');
        badge.className = 'oa-badge';
        badge.textContent = kind;
        badges.appendChild(badge);
      }
      info.appendChild(badges);
      const actions = document.createElement('div');
      actions.className = 'oa-row';
      const testButton = document.createElement('button');
      testButton.className = 'oa-mini';
      testButton.textContent = 'تست';
      testButton.addEventListener('click', async () => {
        testButton.disabled = true;
        setProxyStatus(`در حال تست «${entry.name}»…`);
        try {
          const result = await api.rpc('POST', `proxies/${entry.id}/test`) as { results: Record<string, string> };
          const failed = Object.entries(result.results).filter(([, value]) => value !== 'ok');
          if (failed.length === 0) setProxyStatus(`پروکسی «${entry.name}» سالم است.`, 'success');
          else setProxyStatus(`تست «${entry.name}»: ${failed.map(([kind, value]) => `${kind}: ${value}`).join(' · ')}`, 'error');
        } catch (error) {
          setProxyStatus(messageFor(error), 'error');
        } finally {
          testButton.disabled = false;
        }
      });
      const deleteButton = document.createElement('button');
      deleteButton.className = 'oa-mini';
      deleteButton.style.color = 'var(--oa-danger)';
      deleteButton.textContent = 'حذف';
      deleteButton.addEventListener('click', async () => {
        if (!window.confirm(`پروکسی «${entry.name}» حذف شود؟`)) return;
        deleteButton.disabled = true;
        setProxyStatus('در حال حذف…');
        try {
          await api.rpc('DELETE', `proxies/${entry.id}`);
          await refreshProxies();
          setProxyStatus('پروکسی حذف شد.', 'success');
        } catch (error) {
          setProxyStatus(messageFor(error), 'error');
          deleteButton.disabled = false;
        }
      });
      actions.appendChild(testButton);
      actions.appendChild(deleteButton);
      item.appendChild(info);
      item.appendChild(actions);
      return item;
    }));
  }

  async function refreshProxies(): Promise<void> {
    const result = await api.rpc('GET', 'proxies') as { proxies: ModelProxyEntry[] };
    renderProxies(result.proxies ?? []);
  }

  proxyAddButton.addEventListener('click', async () => {
    proxyAddButton.disabled = true;
    setProxyStatus('در حال اعتبارسنجی پروکسی…');
    try {
      await api.rpc('POST', 'proxies', {
        name: proxyName.value.trim(),
        token: proxyToken.value.trim(),
        claudeBaseUrl: proxyClaude.value.trim(),
        codexBaseUrl: proxyCodex.value.trim(),
      });
      proxyName.value = '';
      proxyToken.value = '';
      proxyClaude.value = '';
      proxyCodex.value = '';
      await refreshProxies();
      setProxyStatus('پروکسی ثبت شد. مدل‌های آن با پسوند نامش در انتخاب مدل سشن‌ها ظاهر می‌شوند.', 'success');
    } catch (error) {
      setProxyStatus(messageFor(error), 'error');
    } finally {
      proxyAddButton.disabled = false;
    }
  });

  refreshProxies().catch((error) => setProxyStatus(messageFor(error), 'error'));

  refresh().catch((error) => setStatus(messageFor(error), 'error'));
  (root as HTMLElement & { __openAiSetupUnmount?: () => void }).__openAiSetupUnmount = unsubscribe;
}

export function unmount(container: HTMLElement): void {
  const root = container.querySelector<HTMLElement>('.oa-root') as (HTMLElement & { __openAiSetupUnmount?: () => void }) | null;
  root?.__openAiSetupUnmount?.();
  container.replaceChildren();
}
