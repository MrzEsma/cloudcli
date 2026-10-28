#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export HOME="${HOME:-/home/cloudcli}"
export HOST="${HOST:-0.0.0.0}"
export SERVER_PORT="${SERVER_PORT:-${PORT:-3001}}"
export PORT="$SERVER_PORT"
export DATABASE_PATH="${DATABASE_PATH:-$HOME/.cloudcli/auth.db}"
export CLOUDCLI_WORKSPACE="${CLOUDCLI_WORKSPACE:-/workspace}"

export SONIOX_ADAPTER_HOST="${SONIOX_ADAPTER_HOST:-127.0.0.1}"
export SONIOX_ADAPTER_PORT="${SONIOX_ADAPTER_PORT:-3002}"
export SONIOX_MODEL="${SONIOX_MODEL:-stt-async-v5}"
export SONIOX_LANGUAGE_HINTS="${SONIOX_LANGUAGE_HINTS:-fa}"
export SONIOX_TRANSCRIPTION_TIMEOUT_MS="${SONIOX_TRANSCRIPTION_TIMEOUT_MS:-120000}"
export VOICE_API_BASE_URL="http://$SONIOX_ADAPTER_HOST:$SONIOX_ADAPTER_PORT/v1"
export VOICE_STT_MODEL="$SONIOX_MODEL"
export VOICE_TIMEOUT_MS="$SONIOX_TRANSCRIPTION_TIMEOUT_MS"

export CLOUDCLI_CODEX_PATH="${CLOUDCLI_CODEX_PATH:-$ROOT_DIR/node_modules/.bin/codex}"
export CODEX_CLI_PATH="${CODEX_CLI_PATH:-$CLOUDCLI_CODEX_PATH}"
export CLAUDE_CLI_PATH="${CLAUDE_CLI_PATH:-$ROOT_DIR/node_modules/.bin/claude}"


# Tenant startup reads a large Node module graph. Keep that cold-start I/O
# behind the control plane and ingress on small single-node installations.
if [[ "${CLOUDCLI_IO_NICE:-}" =~ ^[0-7]$ ]] && command -v ionice >/dev/null 2>&1; then
  ionice -c 2 -n "$CLOUDCLI_IO_NICE" -p "$$" 2>/dev/null || true
fi
if [[ "${CLOUDCLI_CPU_NICE:-}" =~ ^([1-9]|1[0-9])$ ]] && command -v renice >/dev/null 2>&1; then
  renice -n "$CLOUDCLI_CPU_NICE" -p "$$" >/dev/null 2>&1 || true
fi

mkdir -p \
  "$HOME/.claude-code-ui/plugins" \
  "$HOME/.cloudcli" \
  "$HOME/.codex" \
  "$HOME/.claude" \
  "$HOME/.claude/skills" \
  "$HOME/.codex/skills" \
  "$HOME/.config/opencode/skill" \
  "$CLOUDCLI_WORKSPACE"

# Codex materializes argv[0] helper symlinks under ~/.codex/tmp/arg0 for the
# checkout that is currently running. On a persistent tenant home that subtree
# can survive an image or checkout change as dangling links owned by another
# uid, which blocks Codex's own cleanup and the sandboxed child spawns that
# MCP servers depend on. Repair only this temporary subtree while startup may
# still run as root; Codex regenerates the helpers on demand. Sessions, auth,
# and the generated config under ~/.codex are never touched.
if [ -d "$HOME/.codex/tmp/arg0" ]; then
  rm -rf "$HOME/.codex/tmp/arg0" || true
fi

if [[ "$(id -u)" == "0" && "${CLOUDCLI_RUN_AS_ROOT:-0}" != "1" ]]; then
  if command -v gosu >/dev/null 2>&1 && id node >/dev/null 2>&1; then
    # Kubernetes supplies fsGroup ownership. The root fallback is retained for
    # plain Docker volumes, but a recursive chown here can stall a whole node
    # when a persistent workspace grows large.
    chown node:node \
      "$HOME" \
      "$HOME/.claude-code-ui" \
      "$HOME/.claude-code-ui/plugins" \
      "$HOME/.cloudcli" \
      "$HOME/.codex" \
      "$HOME/.claude" \
      "$HOME/.claude/skills" \
      "$HOME/.codex/skills" \
      "$HOME/.config" \
      "$HOME/.config/opencode" \
      "$HOME/.config/opencode/skill" \
      "$CLOUDCLI_WORKSPACE" 2>/dev/null || true
    exec gosu node env HOME="$HOME" USER=node LOGNAME=node bash "$0"
  fi
fi

sync_dir() {
  local src="$1"
  local dst="$2"
  if [[ ! -d "$src" ]]; then
    return 0
  fi
  mkdir -p "$dst"
  if command -v rsync >/dev/null 2>&1; then
    rsync -a --delete "$src"/ "$dst"/
  else
    rm -rf "$dst"
    mkdir -p "$dst"
    cp -a "$src"/. "$dst"/
  fi
}

sync_dir "$ROOT_DIR/cloudcli-plugin-soniox" "$HOME/.claude-code-ui/plugins/cloudcli-plugin-soniox"
sync_dir "$ROOT_DIR/cloudcli-plugin-openai-setup" "$HOME/.claude-code-ui/plugins/cloudcli-plugin-openai-setup"
sync_dir "$ROOT_DIR/cloudcli-plugin-browser-feedback" "$HOME/.claude-code-ui/plugins/cloudcli-browser-feedback"
sync_dir "$ROOT_DIR/cloudcli-plugin-cron" "$HOME/.claude-code-ui/plugins/cloudcli-cron"
sync_dir "$ROOT_DIR/cloudcli-plugin-terminal" "$HOME/.claude-code-ui/plugins/cloudcli-plugin-terminal"

# Ship the browser-feedback capability to every agent CLI that discovers
# skills in the tenant home. Codex does not resolve symlinked SKILL.md files,
# so each destination gets a real copy from the shared source directory.
for agent_skill_root in \
  "$HOME/.claude/skills" \
  "$HOME/.codex/skills" \
  "$HOME/.config/opencode/skill"; do
  sync_dir "$ROOT_DIR/tenant-agent-skills/browser-feedback" "$agent_skill_root/browser-feedback"
done

node "$ROOT_DIR/scripts/init-codex-provider.mjs"
node "$ROOT_DIR/scripts/init-claude-provider.mjs"

SONIOX_CONFIG_MODEL="$SONIOX_MODEL" \
SONIOX_CONFIG_API_KEY="${SONIOX_API_KEY:-}" \
SONIOX_CONFIG_API_BASE_URL="${SONIOX_API_BASE_URL:-https://api.soniox.com/v1}" \
SONIOX_CONFIG_MANAGED="${SONIOX_MANAGED:-0}" \
SONIOX_CONFIG_HTTPS_PROXY="${SONIOX_HTTPS_PROXY:-}" \
SONIOX_CONFIG_LANGUAGE_HINTS="$SONIOX_LANGUAGE_HINTS" \
SONIOX_CONFIG_TIMEOUT_MS="$SONIOX_TRANSCRIPTION_TIMEOUT_MS" \
node --input-type=module - <<'NODE'
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const configDir = path.join(os.homedir(), '.claude-code-ui');
const configPath = path.join(configDir, 'soniox-config.json');
const languageHints = String(process.env.SONIOX_CONFIG_LANGUAGE_HINTS || 'fa')
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean);
const timeout = Number(process.env.SONIOX_CONFIG_TIMEOUT_MS || 120000);
const defaults = {
  apiKey: '',
  apiBaseUrl: 'https://api.soniox.com/v1',
  managed: false,
  model: 'stt-async-v5',
  languageHints: ['fa'],
  httpsProxy: '',
  transcribeTimeoutMs: 120000,
  pollIntervalMs: 750,
};

let config = { ...defaults };
try {
  config = { ...config, ...JSON.parse(fs.readFileSync(configPath, 'utf8')) };
} catch {
  // Missing config is expected on a fresh volume.
}

config.model = process.env.SONIOX_CONFIG_MODEL || defaults.model;
if (process.env.SONIOX_CONFIG_API_KEY) config.apiKey = process.env.SONIOX_CONFIG_API_KEY;
config.apiBaseUrl = process.env.SONIOX_CONFIG_API_BASE_URL || defaults.apiBaseUrl;
config.managed = process.env.SONIOX_CONFIG_MANAGED === '1';
config.httpsProxy = process.env.SONIOX_CONFIG_HTTPS_PROXY || '';
if (languageHints.length > 0) config.languageHints = languageHints;
if (Number.isFinite(timeout) && timeout > 0) config.transcribeTimeoutMs = timeout;
if (!config.pollIntervalMs) config.pollIntervalMs = defaults.pollIntervalMs;

fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
fs.chmodSync(configPath, 0o600);
NODE

node "$ROOT_DIR/scripts/init-cloudcli-admin.mjs"
node "$ROOT_DIR/scripts/init-default-project.mjs"

exec "$ROOT_DIR/node_modules/.bin/cloudcli" start --port "$SERVER_PORT"
