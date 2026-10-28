import fs from 'node:fs';

// CloudCLI starts plugin servers with a minimal environment that does not
// forward PLAYWRIGHT_BROWSERS_PATH, even when the host sets it. Immutable
// tenant images preinstall the Chromium runtime at /opt/ms-playwright; default
// to it when present so no per-tenant runtime download is needed. Import this
// module before playwright so the registry resolves the right browsers path.
const IMAGE_BROWSER_PATH = '/opt/ms-playwright';

if (!process.env.PLAYWRIGHT_BROWSERS_PATH && fs.existsSync(IMAGE_BROWSER_PATH)) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = IMAGE_BROWSER_PATH;
}
