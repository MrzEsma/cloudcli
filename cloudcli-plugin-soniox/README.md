# Soniox Voice for CloudCLI

Speech-to-text for [CloudCLI](https://github.com/siteboon/claudecodeui) using the native Soniox API.

The plugin provides:

- A **Soniox Voice** tab with secure configuration, connection testing, live microphone transcription, and copy-to-clipboard.
- Low-latency provisional and final text updates while the user is still speaking, powered by Soniox's real-time WebSocket API and `stt-rt-v5`.
- A local OpenAI-compatible endpoint at `http://127.0.0.1:3002/v1/audio/transcriptions` that can be used by CloudCLI's built-in microphone button.
- Native Soniox async transcription: upload audio → create job → poll → fetch transcript → delete temporary Soniox resources.
- Persian (`fa`) language hint by default, with configurable multilingual hints.
- Optional HTTPS proxy support.

## Why an adapter is required

CloudCLI's built-in voice proxy expects the OpenAI audio contract:

```text
POST {baseUrl}/audio/transcriptions  multipart(file, model) -> { text }
```

Soniox uses a different native API (`/files`, `/transcriptions`, polling, `/transcript`). This plugin translates between the two contracts.

The plugin tab's live recorder uses a separate real-time path. The backend mints a short-lived, single-use key, then the browser streams microphone audio directly to Soniox over WebSocket. The saved long-lived API key never leaves the CloudCLI host.

## Installation

### From Git (recommended)

Publish or fork this directory as a Git repository, then open **Settings → Plugins** in CloudCLI and paste the repository URL. CloudCLI clones the repository, runs `npm install --ignore-scripts`, builds TypeScript, and enables the tab.

### Manual local installation

```bash
cp -a cloudcli-plugin-soniox ~/.claude-code-ui/plugins/cloudcli-plugin-soniox
cd ~/.claude-code-ui/plugins/cloudcli-plugin-soniox
npm install --ignore-scripts
npm run build
```

Restart CloudCLI or disable/re-enable the plugin from **Settings → Plugins**.

## Configuration

Open the **Soniox Voice** tab:

1. Paste your Soniox API key.
2. Set the model (recommended: `stt-async-v5`).
3. Set language hints (`fa` for Persian, or e.g. `fa,en`).
4. If needed, set an HTTPS proxy such as `http://127.0.0.1:2081`.
5. Save and click **Test connection**.

The API key is sent only to the local plugin backend and stored with mode `0600` at:

```text
~/.claude-code-ui/soniox-config.json
```

It is not stored in browser `localStorage`, the plugin source, or Git.

## Built-in CloudCLI microphone bridge

CloudCLI plugins currently only support the `tab` slot and cannot modify the chat composer. To have CloudCLI's built-in microphone button insert transcripts directly into the composer, start CloudCLI with:

```bash
VOICE_API_BASE_URL=http://127.0.0.1:3002/v1
VOICE_STT_MODEL=stt-async-v5
VOICE_TIMEOUT_MS=120000
```

The plugin backend intentionally listens on port `3002` for this bridge. In CloudCLI Voice settings:

- Enable Voice.
- Leave Base URL and API Key empty.
- Leave STT Model empty or set `stt-async-v5`.

CloudCLI's built-in composer microphone currently exposes only a batch HTTP contract, so it still inserts text after recording stops. Use the **Soniox Voice** tab when you need to see provisional and final words appear live while speaking.

## Development

```bash
npm install --ignore-scripts
npm run typecheck
npm test
npm run build
npm run dev
```

The structure follows the official [CloudCLI Plugin Starter](https://github.com/cloudcli-ai/cloudcli-plugin-starter):

```text
manifest.json
src/index.ts
src/server.ts
src/types.ts
dist/index.js
dist/server.js
```

## Security notes

- Review plugin source before installation; CloudCLI plugins are not runtime-sandboxed.
- Rotate any API key that has been shared in plaintext.
- The server binds to `127.0.0.1` only.
- Uploaded Soniox files and transcription jobs are deleted after success or failure.
- Browser WebSocket sessions use 60-second, single-use temporary keys capped at 30 minutes per session.
- The local configuration directory and file use permissions `0700` and `0600`.

## License

MIT
