#!/usr/bin/env bash
# Structural + boot verification of a desktop bundle ZIP (the build host can
# fully boot-test linux-x64; other targets get structural checks only).
#   bash desktop/verify-bundle.sh <bundle.zip> [--boot]
set -Eeuo pipefail

ZIP="${1:?usage: verify-bundle.sh <bundle.zip> [--boot]}"
BOOT="${2:-}"
WORK="$(mktemp -d /tmp/ccui-verify.XXXXXX)"
trap 'rm -rf "$WORK"' EXIT
TARGET="$(basename "$ZIP" | grep -oE '(linux-x64|win-x64|darwin-arm64|darwin-x64)')"
echo "== extract $TARGET"
python3 -c "import zipfile;zipfile.ZipFile('$ZIP').extractall('$WORK')"
APP="$WORK/cloudcli"
fail() { echo "FAIL: $*" >&2; exit 1; }

echo "== structure"
[[ -d "$APP/node_modules/@cloudcli-ai/cloudcli" ]] || fail "cloudcli package missing"
grep -q "process.platform === 'win32'" "$APP/node_modules/@cloudcli-ai/cloudcli/dist-server/server/claude-interactive.js" \
  || fail "overlay not applied (win32 spawn branch absent)"
[[ -f "$APP/node_modules/.bin/cloudcli" ]] || fail "unix cloudcli shim missing"
[[ -d "$APP/desktop" && -f "$APP/desktop/bootstrap.mjs" ]] || fail "desktop bootstrap missing"
for f in README-FA.md; do [[ -f "$APP/$f" ]] || fail "$f missing"; done
[[ -f "$APP/node_modules/better-sqlite3/build/Release/better_sqlite3.node" ]] || fail "sqlite native missing"
[[ -d "$APP/node_modules/node-pty/prebuilds" ]] || fail "node-pty prebuilds missing"

# target-scoped binary sanity
case "$TARGET" in
  win-x64)
    [[ -f "$APP/runtime/node.exe" ]] || fail "bundled node.exe missing"
    [[ -f "$APP/runtime/git/usr/bin/bash.exe" ]] || fail "PortableGit bash missing"
    [[ -f "$APP/node_modules/.bin/claude.cmd" ]] || fail "claude.cmd shim missing"
    head -c2 "$APP/node_modules/better-sqlite3/build/Release/better_sqlite3.node" | grep -q MZ || fail "sqlite native is not a PE"
    [[ -d "$APP/node_modules/@openai/codex-win32-x64" ]] || fail "win codex missing"
    [[ ! -d "$APP/node_modules/@openai/codex-linux-x64" ]] || fail "linux codex leaked into win bundle"
    ;;
  linux-x64)
    [[ -x "$APP/runtime/bin/node" ]] || fail "bundled node missing"
    "$APP/runtime/bin/node" --version | grep -q v22 || fail "bundled node wrong version"
    "$APP/runtime/bin/node" "$APP/node_modules/@anthropic-ai/claude-code/cli.js" --version || fail "claude cli.js unusable"
    [[ -d "$APP/node_modules/@openai/codex-linux-x64" ]] || fail "linux codex missing"
    ;;
  darwin-*)
    [[ -f "$APP/runtime/bin/node" ]] || fail "bundled node missing"
    ;;
esac
echo "structure OK"

if [[ "$BOOT" == "--boot" && "$TARGET" == linux-x64 ]]; then
  echo "== boot"
  (cd "$APP" && nohup ./start-cloudcli.sh > "$WORK/boot.log" 2>&1 &)
  URL=""
  for i in $(seq 1 120); do
    PORT="$(python3 - "$APP/data/LOGIN.txt" <<'PY'
import re,sys
try: print(re.search(r'127\.0\.0\.1:(\d+)', open(sys.argv[1]).read()).group(1))
except Exception: print('')
PY
)"
    [[ -n "$PORT" ]] && curl -sf -o /dev/null "http://127.0.0.1:$PORT/" && { URL="http://127.0.0.1:$PORT"; break; }
    sleep 1
  done
  [[ -n "$URL" ]] || { tail -30 "$WORK/boot.log"; fail "server did not come up"; }
  echo "server up at $URL"
  curl -s "$URL/" | grep -qi 'html\|cloudcli\|root' || fail "landing page empty"
  [[ -f "$APP/data/credentials.json" ]] || fail "credentials.json missing"
  [[ -f "$APP/data/home/.cloudcli/auth.db" ]] || fail "auth.db missing"
  [[ -d "$APP/data/home/.claude-code-ui/plugins/cloudcli-plugin-terminal" ]] || fail "plugins not synced"
  pkill -f "$APP/runtime/bin/node" 2>/dev/null || true
  echo "boot OK"
fi
echo "VERIFY PASS: $TARGET"
