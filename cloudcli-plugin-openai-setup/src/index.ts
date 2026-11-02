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
    method: 'iclaude' | 'oauth' | 'credentials' | 'api_key' | 'none';
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
  { id: 'claude_oauth', label: 'Claude Code — حساب خودم (لاگین در مرورگر)' },
  { id: 'hooshcode_claude', label: 'هوش کد — Claude Code (توکن)' },
  { id: 'openai', label: 'OpenAI — کلید API' },
  { id: 'hooshcode', label: 'هوش کد — OpenAI/Codex (توکن)' },
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

      <section id="oa-login-card" class="oa-card" style="display:none">
        <div class="oa-title" style="font-size:16px">ورود Claude Code با حساب خودتان</div>
        <div class="oa-subtitle" style="margin-bottom:12px">دکمه را بزنید؛ صفحه ورود Claude در مرورگر باز می‌شود، اجازه را تأیید کنید و کد نشان‌داده‌شده را همین‌جا وارد کنید. مدل‌های حساب شما خودکار در چت Claude آماده می‌شوند.</div>
        <div id="oa-login-active" style="display:none">
          <div id="oa-login-phase" class="oa-note" style="margin-bottom:8px"></div>
          <a id="oa-login-url" class="oa-note" dir="ltr" style="display:none;word-break:break-all;margin-bottom:10px" target="_blank" rel="noopener noreferrer"></a>
          <div id="oa-login-code-row" style="display:none;margin-bottom:10px">
            <div class="oa-note" style="margin-bottom:6px">در صفحه‌ای که باز می‌شود Authorize را بزنید؛ بعد یک <b>کد تأیید</b> نشان داده می‌شود — همان کد را این‌جا وارد کنید:</div>
            <div class="oa-row">
              <input id="oa-login-code" dir="ltr" placeholder="code" style="flex:1;min-width:0" autocomplete="off" />
              <button id="oa-login-submit" class="oa-button oa-primary">ثبت کد</button>
            </div>
          </div>
          <div class="oa-row" style="margin-bottom:12px"><button id="oa-login-cancel" class="oa-button">لغو</button></div>
        </div>
        <div class="oa-row">
          <button id="oa-login-start" class="oa-button oa-primary">شروع ورود Claude</button>
          <button id="oa-login-logout" class="oa-button oa-danger" style="display:none">خروج از حساب Claude</button>
        </div>
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
  const loginCard = root.querySelector<HTMLElement>('#oa-login-card')!;
  const loginActive = root.querySelector<HTMLElement>('#oa-login-active')!;
  const loginPhase = root.querySelector<HTMLElement>('#oa-login-phase')!;
  const loginUrl = root.querySelector<HTMLAnchorElement>('#oa-login-url')!;
  const loginStartButton = root.querySelector<HTMLButtonElement>('#oa-login-start')!;
  const loginCancelButton = root.querySelector<HTMLButtonElement>('#oa-login-cancel')!;
  const loginLogoutButton = root.querySelector<HTMLButtonElement>('#oa-login-logout')!;
  const loginCodeRow = root.querySelector<HTMLElement>('#oa-login-code-row')!;
  const loginCodeInput = root.querySelector<HTMLInputElement>('#oa-login-code')!;
  const loginCodeSubmit = root.querySelector<HTMLButtonElement>('#oa-login-submit')!;
  let managedTeamClaude = false;

  function setStatus(message: string, kind: 'normal' | 'error' | 'success' = 'normal'): void {
    statusElement.textContent = message;
    statusElement.dataset.kind = kind;
  }

  function isClaudeProvider(): boolean {
    return providerInput.value === 'hooshcode_claude' || providerInput.value === 'iclaude_team' || providerInput.value === 'claude_oauth';
  }

  function isAccountLogin(): boolean {
    return providerInput.value === 'claude_oauth';
  }

  function updateProviderCopy(): void {
    const isHooshCode = providerInput.value === 'hooshcode';
    const isClaude = isClaudeProvider();
    const isManagedClaude = providerInput.value === 'iclaude_team';
    const isAccount = isAccountLogin();
    keyField.style.display = isManagedClaude || isAccount ? 'none' : 'flex';
    credentialActions.style.display = isManagedClaude || isAccount ? 'none' : 'flex';
    loginCard.style.display = isAccount ? 'block' : 'none';
    if (!isAccount) stopLoginPoll();
    keyLabel.textContent = isClaude ? 'توکن هوش کد برای Claude Code' : isHooshCode ? 'کلید API هوش کد' : 'OpenAI API key';
    keyInput.placeholder = isClaude ? 'توکن هوش کد مخصوص Claude Code' : isHooshCode ? 'کلید پراکسی هوش کد' : 'OpenAI API key';
    saveButton.textContent = isClaude ? 'اتصال Claude Code به هوش کد' : isHooshCode ? 'اتصال به هوش کد' : 'ذخیره و بررسی با OpenAI';
    providerNote.textContent = isManagedClaude
      ? ' اتصال Claude با حساب تیم توسط پلتفرم آماده و نگه‌داری می‌شود؛ نیازی به واردکردن کلید یا ورود جداگانه ندارید. '
      : isAccount
        ? ' ورود با حساب claude.ai خودتان انجام می‌شود؛ اشتراک Pro/Max شما هزینه چت را می‌پردازد و توکن یک‌ساله روی همین کامپیوتر ذخیره می‌شود. '
        : isClaude
          ? ' در حالت «هوش کد — Claude Code»، توکن فقط برای Claude Code همین CloudCLI ذخیره می‌شود و از مسیر Claude با هوش کد بررسی می‌شود. '
          : isHooshCode
            ? ' در حالت «هوش کد — OpenAI/Codex»، کلید به OpenAI فرستاده نمی‌شود و Codex از توکن هوش کد استفاده می‌کند؛ مدل‌های همین توکن خودکار پیدا می‌شوند. '
            : ' در حالت OpenAI، کلید مستقیماً با OpenAI بررسی می‌شود و مدل‌های همین کلید خودکار پیدا می‌شوند. ';
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
    } else if (status.claude.method === 'oauth' || status.claude.method === 'credentials') {
      stateTitle.textContent = 'Claude Code با حساب خودتان متصل است';
      stateDetail.textContent = status.claude.method === 'oauth'
        ? 'توکن یک‌ساله حساب claude.ai شما · چت Claude همین حالا کار می‌کند'
        : 'ورود کامل Claude Code روی همین کامپیوتر · چت Claude همین حالا کار می‌کند';
    } else {
      stateTitle.textContent = status.claude.configured ? 'Claude Code به هوش کد متصل است' : 'اتصال Claude Code تنظیم نشده است';
      stateDetail.textContent = status.claude.configured
        ? `هوش کد · ${status.claude.managedByTenant ? 'مدیریت‌شده توسط tenant' : 'مدیریت‌شده توسط پلتفرم'}`
        : '«Claude Code — حساب خودم» را انتخاب و وارد شوید، یا توکن هوش کد را در گزینه بعدی وارد کنید.';
    }
    loginLogoutButton.style.display = status.claude.method === 'oauth' ? 'inline-block' : 'none';
    loginStartButton.style.display = status.claude.method === 'oauth' ? 'none' : 'inline-block';
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
    if (status.claude.method === 'oauth' || status.claude.method === 'credentials') {
      providerInput.value = 'claude_oauth';
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
      const result = await api.rpc('POST', 'configure', {
        ...(keyInput.value.trim() ? { apiKey: keyInput.value.trim() } : {}),
        provider: providerInput.value,
        ...(!isClaude ? { model: modelInput.value } : {}),
      }) as { models?: string[] };
      keyInput.value = '';
      await refresh();
      const models = result?.models ?? [];
      setStatus(isClaude
        ? 'اتصال ذخیره شد. sessionهای جدید Claude Code از هوش کد استفاده می‌کنند.'
        : models.length > 0
          ? `اتصال ذخیره شد؛ ${models.length} مدل از این توکن پیدا شد (${models.slice(0, 4).join('، ')}${models.length > 4 ? '، …' : ''}) و در انتخاب مدل چت آماده است.`
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


  // ---- Claude account login flow -------------------------------------------

  let loginPollTimer: number | null = null;
  let activeLoginId: string | null = null;

  function stopLoginPoll(): void {
    if (loginPollTimer !== null) {
      window.clearTimeout(loginPollTimer);
      loginPollTimer = null;
    }
  }

  function showLoginIdle(): void {
    loginActive.style.display = 'none';
    loginPhase.textContent = '';
    loginUrl.style.display = 'none';
    loginUrl.removeAttribute('href');
    loginUrl.textContent = '';
    loginCodeRow.style.display = 'none';
    loginCodeInput.value = '';
    loginCodeSubmit.disabled = false;
    loginStartButton.disabled = false;
  }

  async function pollLogin(id: string): Promise<void> {
    if (activeLoginId !== id) return;
    try {
      const result = await api.rpc('GET', `claude/login/${id}`) as { phase: string; url?: string | null; message?: string | null };
      if (activeLoginId !== id) return;
      if (result.url && !loginUrl.getAttribute('href')) {
        loginUrl.href = result.url;
        loginUrl.textContent = 'اگر مرورگر خودش باز نشد، این لینک را باز کنید ↗';
        loginUrl.style.display = 'block';
      }
      loginCodeRow.style.display = result.phase === 'waiting' ? 'block' : 'none';
      loginPhase.textContent = result.phase === 'waiting'
        ? '۱) لینک زیر را در مرورگر باز کنید و Authorize را بزنید. ۲) کدی که صفحه به شما می‌دهد را در کادر زیر وارد کنید.'
        : 'در حال آماده‌سازی صفحه ورود…';
      if (result.phase === 'authorized') {
        stopLoginPoll();
        activeLoginId = null;
        loginPhase.textContent = '✓ ورود موفق بود؛ چت Claude آماده است.';
        loginCodeRow.style.display = 'none';
        loginCodeInput.value = '';
        await refresh();
        setStatus('ورود Claude انجام شد؛ مدل‌های حساب شما خودکار بارگذاری می‌شوند.', 'success');
        setTimeout(() => showLoginIdle(), 4000);
        return;
      }
      if (result.phase === 'error' || result.phase === 'cancelled') {
        stopLoginPoll();
        activeLoginId = null;
        loginPhase.textContent = result.message ?? 'ورود انجام نشد؛ دوباره تلاش کنید.';
        loginStartButton.disabled = false;
        return;
      }
      loginPollTimer = window.setTimeout(() => { void pollLogin(id); }, 1200);
    } catch (error) {
      stopLoginPoll();
      activeLoginId = null;
      loginPhase.textContent = messageFor(error);
      loginStartButton.disabled = false;
    }
  }

  loginStartButton.addEventListener('click', async () => {
    stopLoginPoll();
    loginStartButton.disabled = true;
    loginActive.style.display = 'block';
    loginPhase.textContent = 'در حال آماده‌سازی صفحه ورود…';
    loginUrl.style.display = 'none';
    try {
      const result = await api.rpc('POST', 'claude/login') as { id: string };
      activeLoginId = result.id;
      loginCancelButton.dataset.loginId = result.id;
      void pollLogin(result.id);
    } catch (error) {
      loginPhase.textContent = messageFor(error);
      loginStartButton.disabled = false;
    }
  });

  async function submitLoginCode(): Promise<void> {
    const id = activeLoginId;
    const code = loginCodeInput.value.trim();
    if (!id || !code) return;
    loginCodeSubmit.disabled = true;
    try {
      await api.rpc('POST', `claude/login/${id}/input`, { code });
      loginCodeInput.value = '';
      loginPhase.textContent = 'کد ثبت شد؛ در حال تأیید…';
    } catch (error) {
      loginPhase.textContent = messageFor(error);
    } finally {
      loginCodeSubmit.disabled = false;
      loginCodeInput.focus();
    }
  }

  loginCodeSubmit.addEventListener('click', () => { void submitLoginCode(); });
  loginCodeInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void submitLoginCode();
    }
  });

  loginCancelButton.addEventListener('click', async () => {
    const id = loginCancelButton.dataset.loginId;
    stopLoginPoll();
    activeLoginId = null;
    if (id) {
      try { await api.rpc('DELETE', `claude/login/${id}`); } catch { /* already gone */ }
    }
    showLoginIdle();
  });

  loginLogoutButton.addEventListener('click', async () => {
    if (!window.confirm('خروج از حساب Claude و حذف توکن ذخیره‌شده از همین کامپیوتر؟')) return;
    loginLogoutButton.disabled = true;
    setStatus('در حال خروج…');
    try {
      await api.rpc('DELETE', 'claude-login');
      await refresh();
      setStatus('از حساب Claude خارج شدید.', 'success');
    } catch (error) {
      setStatus(messageFor(error), 'error');
    } finally {
      loginLogoutButton.disabled = false;
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
