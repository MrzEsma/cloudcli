#!/usr/bin/env bash
# Builds portable, double-click CloudCLI bundles (no Docker, no installs) for
#   linux-x64 | win-x64 | darwin-arm64 | darwin-x64 | all
# Run on a Linux box with node 22 + python3 + network. Output: desktop/dist/
#   cloudcli-desktop-<target>-<date>.zip
#
# Every target bundles: prebuilt node_modules (overlay applied, plugins built
# on the build host — their dist is platform-neutral JS), the official Node
# runtime for that OS/arch, retargeted native modules (better-sqlite3 prebuilt
# download; node-pty/bcrypt ship all prebuilds in-package), platform binaries
# for codex/opencode/ripgrep, and double-click launchers.
set -Eeuo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
NODE_VERSION="${NODE_VERSION:-22.23.1}"
DATE="$(date +%Y%m%d)"
DIST="$HERE/dist"
KEEP_STAGE="${KEEP_STAGE:-0}"

case "${1:-}" in
  linux-x64|win-x64|darwin-arm64|darwin-x64) TARGETS=("$1") ;;
  all) TARGETS=(linux-x64 win-x64 darwin-arm64 darwin-x64) ;;
  *) echo "usage: bash desktop/make-bundles.sh linux-x64|win-x64|darwin-arm64|darwin-x64|all" >&2; exit 1 ;;
esac

platform_of() { case "$1" in linux-*) echo linux;; win-*) echo win32;; darwin-*) echo darwin;; esac; }
arch_of()   { case "$1" in *-x64) echo x64;; *-arm64) echo arm64;; esac; }
node_dist_of() {
  case "$1" in
    linux-x64)      echo "node-v$NODE_VERSION-linux-x64.tar.xz";;
    win-x64)        echo "node-v$NODE_VERSION-win-x64.zip";;
    darwin-arm64)   echo "node-v$NODE_VERSION-osx-arm64.tar.gz";;
    darwin-x64)     echo "node-v$NODE_VERSION-osx-x64.tar.gz";;
  esac
}

lock_version() {  # lock_version <npm-name> -> exact version from package-lock
  python3 - "$REPO/package-lock.json" "$1" <<'PY'
import json, sys
lock = json.load(open(sys.argv[1]))
name = sys.argv[2]
entry = lock.get('packages', {}).get(f'node_modules/{name}') or \
        lock.get('dependencies', {}).get(name, {})
print(entry.get('version', ''))
PY
}

fetch_pkg() {  # fetch_pkg <dir-name> <npm-spec> <dest-modules-root> — download+extract an npm pkg under a chosen dir name
  local dir="$1" spec="$2" root="$3"
  local t="$WORK_DL"
  (cd "$t" && npm pack "$spec" --silent >/dev/null 2>&1)
  local tarball
  tarball="$(ls -t "$t"/*.tgz | head -1)"
  rm -rf "$root/$dir"
  mkdir -p "$root/$dir"
  tar -xzf "$tarball" -C "$root/$dir" --strip-components=1
  rm -f "$t"/*.tgz
}

retarget_natives() {  # retarget_natives <stage> <platform> <arch>
  local stage="$1" pf="$2" arch="$3"
  local nm="$stage/node_modules"

  echo "  [natives] better-sqlite3 -> $pf-$arch"
  (cd "$nm/better-sqlite3" && rm -rf build && npx --yes prebuild-install@latest --platform "$pf" --arch "$arch" --verbose >/dev/null)
  local bin="$nm/better-sqlite3/build/Release/better_sqlite3.node"
  [[ -f "$bin" ]] || { echo "better-sqlite3 prebuild missing for $pf-$arch" >&2; exit 1; }
  if [[ "$pf" == win32 ]]; then head -c2 "$bin" | grep -q MZ || { echo "better-sqlite3 prebuild is not a Windows binary" >&2; exit 1; }; fi

  echo "  [natives] node-pty / bcrypt prebuild pruning"
  find "$nm/node-pty/prebuilds" "$nm/bcrypt/prebuilds" -maxdepth 1 -mindepth 1 -type d \
    ! -name "$pf-$arch" -exec rm -rf {} + 2>/dev/null || true
  [[ -d "$nm/node-pty/prebuilds/$pf-$arch" && -d "$nm/bcrypt/prebuilds/$pf-$arch" ]] || {
    echo "bundled prebuilds missing for $pf-$arch" >&2; exit 1; }

  # --- platform package families (exact versions come from package-lock) ---
  local pf_npm arch_npm
  pf_npm="$pf"; arch_npm="$arch"
  local codex_dir="codex-$pf_npm-$arch_npm"
  local codex_spec
  codex_spec="$(python3 - "$stage/node_modules/@openai/codex/package.json" "$pf_npm" "$arch_npm" <<'PY'
import json, sys
opt = json.load(open(sys.argv[1]))['optionalDependencies']
key = f"@openai/codex-{sys.argv[2]}-{sys.argv[3]}"
print(opt[key])
PY
)"
  echo "  [platform] @openai/$codex_dir ($codex_spec)"
  fetch_pkg "@openai/$codex_dir" "$codex_spec" "$nm"
  # codex-sdk resolves its own nested copy of the platform package
  if [[ -d "$nm/@openai/codex-sdk/node_modules/@openai" ]]; then
    fetch_pkg "@openai/$codex_dir" "$codex_spec" "$nm/@openai/codex-sdk/node_modules"
  fi
  find "$nm/@openai" -maxdepth 1 -name 'codex-*' ! -name "$codex_dir" ! -name 'codex-sdk' -exec rm -rf {} +
  find "$nm/@openai/codex-sdk/node_modules/@openai" -maxdepth 1 -name 'codex-*' ! -name "$codex_dir" -exec rm -rf {} + 2>/dev/null || true

  local oc_ver; oc_ver="$(lock_version "opencode-$pf_npm-$arch_npm")"
  echo "  [platform] opencode-$pf_npm-$arch_npm@$oc_ver"
  fetch_pkg "opencode-$pf_npm-$arch_npm" "opencode-$pf_npm-$arch_npm@$oc_ver" "$nm"
  local oc_bin_src
  oc_bin_src="$(find "$nm/opencode-$pf_npm-$arch_npm" -type f \( -name 'opencode.exe' -o -name 'opencode' \) | head -1)"
  mkdir -p "$nm/opencode-ai/bin"
  cp -f "$oc_bin_src" "$nm/opencode-ai/bin/opencode.exe"
  find "$nm" -maxdepth 1 -name 'opencode-*' ! -name "opencode-$pf_npm-$arch_npm" -exec rm -rf {} +
  rm -rf "$nm/opencode-ai/postinstall.mjs"   # already applied; must not re-run for another platform

  local rg_ver; rg_ver="$(lock_version "@vscode/ripgrep-$pf_npm-$arch_npm")"
  if [[ -n "$rg_ver" ]]; then
    echo "  [platform] @vscode/ripgrep-$pf_npm-$arch_npm@$rg_ver"
    fetch_pkg "@vscode/ripgrep-$pf_npm-$arch_npm" "@vscode/ripgrep-$pf_npm-$arch_npm@$rg_ver" "$nm"
    find "$nm/@vscode" -maxdepth 1 -name 'ripgrep-*' ! -name "ripgrep-$pf_npm-$arch_npm" -exec rm -rf {} +
  else
    echo "  [platform] @vscode/ripgrep-$pf_npm-$arch_npm not in lock — skipping rg"
  fi
}

write_cmd_shims() {  # npm-equivalent .cmd shims for Windows bundles
  local bin="$1/node_modules/.bin"
  shim() { # shim <name> <relative-target>
    local name="$1" target="$2"
    printf '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\nIF EXIST "%%dp0%%\\..\\..\\runtime\\node.exe" (\r\n  SET "_prog=%%dp0%%\\..\\..\\runtime\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n  SET PATHEXT=%%PATHEXT:;.JS;=;%%\r\n)\r\nendLocal & goto #_undefined_# 2>NUL || title %%COMSPEC%% & "%%_prog%%"  "%%dp0%%\\%target%%" %%*\r\n' > "$bin/$name.cmd"
  }
  shim claude    '..\@anthropic-ai\claude-code\cli.js'
  shim codex     '..\@openai\codex\bin\codex.js'
  # opencode is a native exe — run directly:
  printf '@ECHO off\r\n"%%~dp0\\..\\opencode-ai\\bin\\opencode.exe" %%*\r\n' > "$bin/opencode.cmd"
  shim cloudcli  '..\@cloudcli-ai\cloudcli\dist-server\server\cli.js'
}

add_runtime() {  # add_runtime <stage> <target>
  local stage="$1" target="$2"
  local dist; dist="$(node_dist_of "$target")"
  echo "  [runtime] $dist"
  curl -fsSL --retry 3 -o "$WORK_DL/$dist" "https://nodejs.org/dist/v$NODE_VERSION/$dist"
  mkdir -p "$stage/runtime"
  case "$dist" in
    *.zip)
      python3 -c "import zipfile;zipfile.ZipFile('$WORK_DL/$dist').extractall('$stage/runtime')"
      ;;
    *.tar.xz)
      tar -xJf "$WORK_DL/$dist" -C "$stage/runtime" --strip-components=2 --wildcards '*/bin/node'
      mkdir -p "$stage/runtime/bin"
      [[ -f "$stage/runtime/node" ]] && mv "$stage/runtime/node" "$stage/runtime/bin/node" || true
      ;;
    *.tar.gz)
      tar -xzf "$WORK_DL/$dist" -C "$stage/runtime" --strip-components=2 --wildcards '*/bin/node'
      mkdir -p "$stage/runtime/bin"
      [[ -f "$stage/runtime/node" ]] && mv "$stage/runtime/node" "$stage/runtime/bin/node" || true
      ;;
  esac
  # Only the binary ships — no npm/corepack needed at user time.
  rm -rf "$stage/runtime/lib" "$stage/runtime/include" "$stage/runtime/share" 2>/dev/null || true
}

add_mingit() {  # Windows bundles ship portable git+bash for the agent shell tools
  local stage="$1"
  echo "  [git] MinGit (bash for Claude's shell tools)"
  local url
  url="$(curl -fsSL --retry 3 "https://api.github.com/repos/git-for-windows/git/releases/latest" \
    | python3 -c "import json,sys
assets=json.load(sys.stdin)['assets']
print(next(a['browser_download_url'] for a in assets if a['name'].endswith('MinGit-64-bit.zip')))")"
  curl -fsSL --retry 3 -o "$WORK_DL/mingit.zip" "$url"
  mkdir -p "$stage/runtime/git"
  python3 -c "import zipfile;zipfile.ZipFile('$WORK_DL/mingit.zip').extractall('$stage/runtime/git')"
  [[ -f "$stage/runtime/git/usr/bin/bash.exe" ]] || [[ -f "$stage/runtime/git/bin/bash.exe" ]] || {
    echo "MinGit has no bash — Claude shell tools would be broken" >&2; exit 1; }
}

zip_stage() {  # zip_stage <stage-dir-parent> <stage-name> <out-zip>
  python3 - "$1" "$2" "$3" <<'PY'
import os, sys, zipfile
parent, name, out = sys.argv[1], sys.argv[2], sys.argv[3]
count = 0
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as z:
    for root, dirs, files in os.walk(os.path.join(parent, name)):
        dirs[:] = [d for d in dirs if d != '__pycache__']
        for f in files:
            full = os.path.join(root, f)
            z.write(full, os.path.relpath(full, parent))
            count += 1
print(f"  [zip] {count} files -> {out} ({os.path.getsize(out)/1e6:.0f} MB)")
PY
}

build_target() {
  local target="$1"
  local pf arch; pf="$(platform_of "$target")"; arch="$(arch_of "$target")"
  echo "=== $target (platform=$pf arch=$arch) ==="
  local stage_root="$WORK/stage-$target"
  rm -rf "$stage_root"
  local stage="$stage_root/cloudcli"
  mkdir -p "$stage"

  echo "  [repo] staging"
  rsync -a --exclude .git --exclude node_modules --exclude desktop/dist "$REPO/" "$stage/"
  rm -rf "$stage/desktop/dist" 2>/dev/null || true

  echo "  [deps] npm ci (host natives; retargeted next)"
  (cd "$stage" && npm ci --omit=dev --no-audit --no-fund --loglevel=error)

  echo "  [overlay] applying"
  (cd "$stage" && node desktop/apply-overlay.mjs "$stage")

  echo "  [plugins] building (dist is platform-neutral)"
  (cd "$stage" && bash scripts/build-plugins.sh "$stage")

  retarget_natives "$stage" "$pf" "$arch"
  add_runtime "$stage" "$target"
  [[ "$pf" == win32 ]] && { write_cmd_shims "$stage"; add_mingit "$stage"; }

  echo "  [launchers] permissions + notices"
  chmod +x "$stage/start-cloudcli.sh" "$stage/Start CloudCLI.command" 2>/dev/null || true

  mkdir -p "$DIST"
  local out="$DIST/cloudcli-desktop-$target-$DATE.zip"
  rm -f "$out"
  zip_stage "$stage_root" cloudcli "$out"
  [[ "$KEEP_STAGE" == 1 ]] || rm -rf "$stage_root"
}

WORK="$(mktemp -d /tmp/cloudcli-desktop-build.XXXXXX)"
WORK_DL="$WORK/downloads"; mkdir -p "$WORK_DL"
trap '[[ "$KEEP_STAGE" == 1 ]] || rm -rf "$WORK"' EXIT

for t in "${TARGETS[@]}"; do build_target "$t"; done
echo "done: $DIST"
