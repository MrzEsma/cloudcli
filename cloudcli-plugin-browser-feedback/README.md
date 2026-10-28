# Browser UI Feedback for CloudCLI

A standalone CloudCLI plugin for reviewing a web UI without modifying CloudCLI itself.

## Vendored for BeTeam

This copy ships inside the immutable tenant image and is synced to
`~/.claude-code-ui/plugins/cloudcli-browser-feedback` at tenant startup, so every
BeTeam tenant gets the tab without a per-user install. It is vendored from
[`MrzEsma/cloudcli-browser-feedback`](https://github.com/MrzEsma/cloudcli-browser-feedback)
at commit `c2215c0`, which already carries the three behaviors this deployment
depends on:

- `src/browser-env.ts` defaults `PLAYWRIGHT_BROWSERS_PATH` to `/opt/ms-playwright`
  when that directory exists, because CloudCLI starts plugin servers with a
  minimal environment and the tenant image preinstalls the Chromium runtime there.
- `src/server.ts` launches Chromium with `--no-sandbox`; the tenant container is
  the isolation boundary and the Kubernetes default seccomp profile breaks the
  Chromium user-namespace sandbox.
- `src/server.ts` publishes its ephemeral loopback port to
  `~/.claude-code-ui/browser-feedback-server.json` so agent CLIs in the same
  tenant can drive the shared browser sessions non-interactively. Agents discover
  the capability through the synced `browser-feedback` skill.

The upstream project description follows.

It lets you:

- Open an HTTP or HTTPS page in a browser running on the CloudCLI host.
- Click, scroll, and type into the page.
- Select a region or click a small component to inspect its DOM element.
- Use a full-screen view for detailed review.
- Write a UI note and copy a structured feedback message into the active chat manually.

The plugin deliberately does not call CloudCLI's internal chat APIs. This keeps it compatible with an unmodified CloudCLI installation.

## Install from Git

Repository: `https://github.com/MrzEsma/cloudcli-browser-feedback`

In CloudCLI, open **Settings → Plugins**, paste the HTTPS clone URL above, and select **Install**. CloudCLI installs the runtime dependencies and adds the prebuilt **Browser UI Feedback** tab.

On first use, select **Install Chromium** inside the plugin. Chromium is downloaded for the operating-system user running CloudCLI; it is not installed into CloudCLI's own `node_modules` directory.

## Manual local installation

```bash
cp -a cloudcli-plugin-browser-feedback ~/.claude-code-ui/plugins/cloudcli-browser-feedback
cd ~/.claude-code-ui/plugins/cloudcli-browser-feedback
npm install --ignore-scripts
```

Restart CloudCLI, or disable and re-enable the plugin from **Settings → Plugins**.

## Usage

1. Open the **Browser UI Feedback** tab.
2. Install Chromium if the runtime is not ready.
3. Enter the page URL and select **Open**.
4. Use **Interact** to click and scroll, or **Select region** to mark a component.
5. Write the requested change and select **Copy feedback**.
6. Paste the copied message into the CloudCLI chat composer and send it.

`localhost` and `127.0.0.1` refer to the machine where CloudCLI is running. If the UI runs on another computer, expose it through a reachable hostname or tunnel first.

## Development

```bash
npm install --include=dev --ignore-scripts
npm run typecheck
npm test
```

After changing the source, run `npm run build:dev` and commit the updated `dist/` files so production CloudCLI installations do not need development build tools.

The repository follows CloudCLI's native plugin contract:

```text
manifest.json
src/index.ts
src/server.ts
dist/index.js
dist/server.js
```

## Security

- Review third-party plugin source before installation; CloudCLI plugins are not runtime-sandboxed.
- The plugin backend listens only on `127.0.0.1` and is reached through CloudCLI's authenticated plugin RPC proxy.
- Browser sessions are held in memory, expire after 30 minutes of inactivity, and are closed when the plugin stops.
- The plugin accepts only HTTP and HTTPS page URLs.

## License

MIT
