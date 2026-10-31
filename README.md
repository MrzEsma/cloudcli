# CloudCLI

A self-hosted web UI for agent CLIs: **interactive Claude Code** (your
subscription, driven through a real terminal session — no API-key billing
path) and OpenAI Codex, with voice input (Soniox), browser-UI
feedback, an in-app terminal, scheduled prompts, subagent visibility and
chat annotations on selected text.

Fork it, change it, build it yourself. Everything here rebuilds from public
inputs: the base image from Docker Hub, packages from the public npm
registry. **Bring your own credentials** — nothing of the original
installation's accounts, tokens or data is included, and nothing reports
anywhere: your instance talks only to the AI providers you configure.

## Desktop: one download, one double-click (Windows / macOS / Linux)

No Docker, no Node install, no terminal. Build portable bundles and hand the ZIP
to anyone:

```bash
bash desktop/make-bundles.sh all          # or: linux-x64 | win-x64 | darwin-arm64 | darwin-x64
```

Each `desktop/dist/cloudcli-desktop-<os>-<date>.zip` contains the whole app:
the Node runtime for that OS, prebuilt dependencies, plugins, the overlay
applied, a slim portable git+bash (Windows) and double-click launchers
(`Start-CloudCLI.bat` / `Start CloudCLI.command` / `start-cloudcli.sh`).
The user extracts the ZIP, double-clicks, and the browser opens on the local
app; the first login is written to `data/LOGIN.txt` inside the folder. All
state lives in the folder (`data/`, `workspace/`) — deleting the folder
uninstalls. The server binds to `127.0.0.1` only.

Bundles are ~150–200 MB: Claude Code ships as its runnable-JS build (the
last `2.1.x` that still publishes `cli.js`) and OpenCode is not included.
Non-technical guide (Persian): `README-FA.md`. Windows chat runs Claude Code
under ConPTY through the bundled Node — no bash needed on the machine; the
bundled PortableGit supplies bash for Claude's shell tools.

## Quickstart (Docker)

```bash
bash install.sh                # builds the image and starts it on :3001
# or by hand:
docker build -t cloudcli .
docker run -d --name cloudcli -p 3001:3001 \
  -v cloudcli-home:/home/cloudcli -v cloudcli-workspace:/workspace \
  -e CLOUDCLI_ADMIN_USERNAME=admin -e CLOUDCLI_ADMIN_PASSWORD=change-me \
  cloudcli
```

Open `http://<host>:3001`, log in with the admin credentials, then add your
own provider logins in the UI (Claude subscription login, Codex/OpenAI
account, API keys). They are stored only in your container's volume.

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `SERVER_PORT` | `3001` | HTTP port |
| `CLOUDCLI_ADMIN_USERNAME` / `CLOUDCLI_ADMIN_PASSWORD` | – | first-boot admin login (generate one!) |
| `SONIOX_API_KEY` | – | Soniox voice input |
| `SONIOX_LANGUAGE_HINTS` | `fa` | STT language hints |
| `CLOUDCLI_WORKSPACE` | `/workspace` | where repos/projects live |
| `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY` | – | optional: API-key mode for Claude |

### Volumes

Mount and back up `/home/cloudcli` (auth DB, sessions, plugin config) and
`/workspace` (your projects).

## Using it (first 10 minutes)

1. **Log in** at `http://<host>:3001` with the admin user/password you set.
2. **Claude**: open Settings → Claude and sign in with your own Claude
   subscription (the login opens in the terminal tab), or set
   `ANTHROPIC_API_KEY` when you start the container. Chat runs the real Claude
   Code TUI, so it bills your subscription, never the API by surprise.
3. **Codex / OpenAI**: use the *OpenAI setup* plugin tab for a guided login.
4. **Projects**: put repos under `/workspace` (volume) or clone from the UI.
5. **Voice**: set `SONIOX_API_KEY` (get one at soniox.com), then use the
   mic in the chat composer.
6. **Reply to part of a message**: select text in any answer → comment/reply.
7. **Browser feedback**: the *Browser UI Feedback* tab lets an agent open a
   page, screenshot it and take your marked-up feedback.
8. **Scheduled prompts** (cron tab) and **Terminal** tab are built in.

## Updating

Docker Hub image: `docker pull esmln/cloudcli:latest`, then
`docker rm -f cloudcli` and run it again with the same volumes — your data
lives in the volumes. Source build: `git pull && bash install.sh`.

## Security notes

Put it behind HTTPS (Caddy/nginx/Cloudflare tunnel) if it leaves your LAN, use
a strong admin password, and never share the `cloudcli-home` volume: it holds
your provider logins.

## What's inside

- `cloudcli-overlay/` — the patched cloudcli server/UI package, applied over
  the stock npm package at build time (`apply.sh`, verified by
  `manifest.sha256`). This is where the product lives: the interactive
  Claude runtime (`claude-interactive.js`), session model isolation, the
  frontend patches (annotations, subagents, mermaid, voice composer).
- `cloudcli-plugin-soniox` — voice input via Soniox STT.
- `cloudcli-plugin-browser-feedback` — the agent drives a browser and sends
  UI feedback screenshots into the chat.
- `cloudcli-plugin-openai-setup` — guided OpenAI/Codex provider setup.
- `cloudcli-plugin-terminal` — in-app terminal.
- `cloudcli-plugin-cron` — scheduled prompts.
- `tenant-agent-skills/` — skills synced to every agent CLI at boot
  (currently: browser-feedback usage skill).
- `scripts/start-production.sh` — container entrypoint: env, home setup,
  plugin sync, provider init, server start.

## Customizing

Edit anything and rebuild the image. The overlay files are plain JS shipped
as-is into the package — change `cloudcli-overlay/package/...`, run
`bash cloudcli-overlay/apply.sh` against a local `npm ci` install to test,
then `docker build`. Plugin sources build with esbuild/tsc via
`bash scripts/build-plugins.sh`.

## Notes

- Claude Code and Codex binaries are fetched from the public npm registry at
  build time and remain under their own upstream terms. OpenCode is not
  bundled with the desktop builds.
- `docker.io/esmln/cloudcli` on Docker Hub is a prebuilt snapshot of this
  same tree if you prefer pulling over building.
