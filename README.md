# CloudCLI

A self-hosted web UI for agent CLIs: **interactive Claude Code** (your
subscription, driven through a real terminal session — no API-key billing
path), OpenAI Codex and OpenCode, with voice input (Soniox), browser-UI
feedback, an in-app terminal, scheduled prompts, subagent visibility and
chat annotations on selected text.

Fork it, change it, build it yourself. Everything here rebuilds from public
inputs: the base image from Docker Hub, packages from the public npm
registry. **Bring your own credentials** — nothing of the original
installation's accounts, tokens or data is included, and nothing reports
anywhere: your instance talks only to the AI providers you configure.

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

- Claude Code, Codex and OpenCode binaries are fetched from the public npm
  registry at build time and remain under their own upstream terms.
- `docker.io/esmln/cloudcli` on Docker Hub is a prebuilt snapshot of this
  same tree if you prefer pulling over building.
