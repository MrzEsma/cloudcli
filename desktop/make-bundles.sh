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
# Last claude-code release that ships runnable JS (cli.js, ~49MB). 2.1.120+
# are 132KB stubs that install a ~330MB native binary per platform.
CLAUDE_JS_VERSION="${CLAUDE_JS_VERSION:-2.1.110}"
# codex 0.159.x ships a 320-450MB binary; 0.110.0 is the last ~120MB one and
# still speaks the same exec/startThread API the server uses. Override to
# bump (also updates codex-sdk to the matched version).
CODEX_VERSION="${CODEX_VERSION:-0.110.0}"
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
    darwin-arm64)   echo "node-v$NODE_VERSION-darwin-arm64.tar.gz";;
    darwin-x64)     echo "node-v$NODE_VERSION-darwin-x64.tar.gz";;
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

  # --- slim: claude-code as runnable JS (no ~330MB native binary per platform) ---
  echo "  [slim] @anthropic-ai/claude-code@$CLAUDE_JS_VERSION (JS cli.js)"
  fetch_pkg "@anthropic-ai/claude-code" "@anthropic-ai/claude-code@$CLAUDE_JS_VERSION" "$nm"
  [[ -f "$nm/@anthropic-ai/claude-code/cli.js" ]] || { echo "claude-code JS cli.js missing" >&2; exit 1; }
  rm -rf "$nm/@anthropic-ai/claude-code-"*   # native platform stubs/binaries
  # claude-code 2.1.x vendors ripgrep for every platform — keep only the target
  local rgv_keep
  case "$pf-$arch" in
    win32-x64)   rgv_keep=x64-win32;;   win32-arm64) rgv_keep=arm64-win32;;
    linux-x64)   rgv_keep=x64-linux;;   linux-arm64) rgv_keep=arm64-linux;;
    darwin-x64)  rgv_keep=x64-darwin;;  darwin-arm64) rgv_keep=arm64-darwin;;
  esac
  local rgv="$nm/@anthropic-ai/claude-code/vendor/ripgrep"
  [[ -d "$rgv" ]] && find "$rgv" -mindepth 1 -maxdepth 1 -type d ! -name "$rgv_keep" -exec rm -rf {} +
  # claude-agent-sdk platform binaries (~250MB each): resolved lazily at query()
  # time, and SDK-billed claude is disabled by policy — keep only the JS.
  rm -rf "$nm/@anthropic-ai/claude-agent-sdk-"*
  rm -f "$nm/.bin/claude"                    # points at the old bin/claude.exe
  if [[ "$pf" != win32 ]]; then
    ln -sf ../@anthropic-ai/claude-code/cli.js "$nm/.bin/claude"
  fi

  # --- codex (pinned pair: launcher JS + SDK JS + one platform binary) ---
  local pf_npm arch_npm
  pf_npm="$pf"; arch_npm="$arch"
  if [[ "$CODEX_VERSION" != lock ]]; then
    echo "  [slim] @openai/codex + codex-sdk @$CODEX_VERSION"
    fetch_pkg "@openai/codex" "@openai/codex@$CODEX_VERSION" "$nm"
    fetch_pkg "@openai/codex-sdk" "@openai/codex-sdk@$CODEX_VERSION" "$nm"
  fi
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
  # codex-sdk's nested platform copy (~270MB): node resolution walks up to the
  # top-level pkg we just installed, so the nested one is dead weight.
  rm -rf "$nm/@openai/codex-sdk/node_modules"
  find "$nm/@openai" -maxdepth 1 -name 'codex-*' ! -name "$codex_dir" ! -name 'codex-sdk' -exec rm -rf {} +
  # code-mode-host (~70MB) is only spawned by codex's experimental code mode;
  # voice-host only serves `codex voice` (UI voice input goes through Soniox).
  find "$nm/@openai/$codex_dir" -type f \( -name 'codex-code-mode-host*' -o -name 'codex-voice-host*' \) -exec rm -f {} +

  # --- opencode dropped entirely (owner decision 2026-10-31: Claude + Codex only) ---
  rm -rf "$nm/opencode-ai" "$nm"/opencode-* "$nm/.bin/opencode"*

  # --- frontend-only deps: the shipped UI is prebuilt, nothing imports these ---
  rm -rf "$nm/mermaid" "$nm/@mermaid-js" "$nm/lucide-react" "$nm/es-toolkit" \
         "$nm/cytoscape-fcose" "$nm/cytoscape-layout-base" "$nm/react-syntax-highlighter" \
         "$nm/refractor" "$nm/prismjs" "$nm/katex" "$nm/jimp" "$nm/@jimp" "$nm/gifwrap" \
         "$nm/react" "$nm/react-dom" "$nm/cytoscape" "$nm/pixelmatch" "$nm/scheduler" \
         "$nm/@anthropic-ai/sdk"   # API-key SDK route: 0 imports, policy says no API billing
  # native-module source/doc trees: runtime needs only JS + prebuilt binaries
  rm -rf "$nm/node-pty/src" "$nm/node-pty/test" "$nm/node-pty/.github" "$nm/node-pty/binding.gyp" \
         "$nm/better-sqlite3/src" "$nm/better-sqlite3/deps" "$nm/better-sqlite3/docs" \
         "$nm/better-sqlite3/benchmark" "$nm/bcrypt/src" "$nm/bcrypt/test"
  # claude-code vendor extras: seccomp is linux-only, audio-capture is the
  # terminal-mic feature (UI voice goes through Soniox), typings unused.
  rm -rf "$nm/@anthropic-ai/claude-code/vendor/seccomp" \
         "$nm/@anthropic-ai/claude-code/vendor/audio-capture" \
         "$nm/@anthropic-ai/claude-code/sdk-tools.d.ts"
  find "$nm/.bin" -xtype l -delete 2>/dev/null || true   # links to pruned pkgs

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
      # win zip extracts as node-v<ver>-win-x64/node.exe — flatten to runtime/node.exe
      python3 -c "
import zipfile
z = zipfile.ZipFile('$WORK_DL/$dist')
(member,) = [n for n in z.namelist() if n.endswith('/node.exe')]
info = z.getinfo(member)
info.filename = 'node.exe'
z.extract(info, '$stage/runtime')"
      ;;
    *.tar.xz|*.tar.gz)
      python3 - "$WORK_DL/$dist" "$stage/runtime" <<'PYT'
import sys, tarfile
with tarfile.open(sys.argv[1]) as t:
    member = next(m for m in t.getmembers() if m.name.endswith('/bin/node'))
    member.name = 'bin/node'
    t.extract(member, sys.argv[2], filter='data')
PYT
      ;;
  esac
  # Only the binary ships — no npm/corepack needed at user time.
  rm -rf "$stage/runtime/lib" "$stage/runtime/include" "$stage/runtime/share" 2>/dev/null || true
}

add_mingit() {  # Windows bundles ship PortableGit: git + bash for the agent shell tools
  local stage="$1"
  echo "  [git] PortableGit (git + bash for Claude's shell tools)"
  local seven="$WORK_DL/7zz"
  if [[ ! -x "$seven" ]]; then
    local seven_v
    for seven_v in 7z2501 7z2408 7z2407 7z2406; do
      if curl -fsf --retry 2 -o "$WORK_DL/7zz.tar.xz" "https://www.7-zip.org/a/$seven_v-linux-x64.tar.xz"; then break; fi
    done
    python3 -c "import tarfile,os;tarfile.open('$WORK_DL/7zz.tar.xz').extractall('$WORK_DL/7zz-unpacked',filter='data');os.replace('$WORK_DL/7zz-unpacked/7zz','$seven')"
    chmod +x "$seven"
  fi
  local url
  url="$(curl -fsSL --retry 3 "https://api.github.com/repos/git-for-windows/git/releases?per_page=15" | python3 -c '
import json,sys
for rel in json.load(sys.stdin):
    if rel.get("draft") or rel.get("prerelease"): continue
    for a in rel["assets"]:
        if a["name"].startswith("PortableGit-") and a["name"].endswith("-64-bit.7z.exe"):
            print(a["browser_download_url"]); raise SystemExit
')"
  [[ -n "$url" ]] || { echo "PortableGit asset not found" >&2; exit 1; }
  curl -fsSL --retry 3 -o "$WORK_DL/portablegit.7z.exe" "$url"
  "$seven" x -y -o"$stage/runtime/git" "$WORK_DL/portablegit.7z.exe" >/dev/null
  # Prune to git + bash + coreutils (~175MB raw, ~76MB zipped). 2026
  # PortableGit layout: ucrt64 (git suite), usr (msys bash + coreutils).
  # Keep: bash + coreutils + ssh + https remotes + SSL certs + terminfo.
  # Drop: GUI/difftool stack (Avalonia/Skia/Tcl), GCM .NET auth stack,
  # perl, tcl/tk, vim, git-lfs (LFS repos degrade to pointer checkouts),
  # docs/locales, orphaned msys DLLs.
  local g="$stage/runtime/git"
  rm -rf "$g/usr/share/vim" "$g/usr/share/doc" "$g/usr/share/man" "$g/usr/share/html" \
         "$g/usr/share/info" "$g/usr/share/locale" "$g/usr/share/misc" "$g/usr/share/mintty" \
         "$g/usr/share/git" "$g/usr/lib/perl5" "$g/usr/share/perl5" \
         "$g/usr/lib/tcl8"* "$g/usr/share/tcl8"* \
         "$g/ucrt64/share/doc" "$g/ucrt64/lib/tcl8"* "$g/ucrt64/share/zoneinfo" \
         "$g/ucrt64/share/git-gui" "$g/usr/share/git-gui" \
         "$g/cmd/git-gui.exe" "$g/cmd/gitk.exe" 2>/dev/null || true
  rm -f "$g/usr/bin/"{vi,vim,view,ex,rvim,rview,vimdiff,vimtutor} \
        "$g/usr/bin/"{getconf.exe,mintty.exe,nano.exe,openssl.exe,perl.exe,perl5.*.exe,pldd.exe,ssp.exe} \
        "$g/usr/bin/gawk-"*.exe 2>/dev/null || true
  # GUI/difftool + GCM stacks (scalar, git-gui, credential manager, .NET dlls)
  find "$g/ucrt64/bin" -maxdepth 1 -type f \( -name 'Avalonia*' -o -name 'SkiaSharp*' \
       -o -name 'HarfBuzzSharp*' -o -name 'MicroCom*' -o -name 'Microsoft.*' -o -name 'System.*' \
       -o -name 'GitHub.dll' -o -name 'GitLab.dll' -o -name 'Atlassian*' \
       -o -name 'git-credential-manager*' -o -name 'scalar.exe' -o -name 'pdftotext.exe' \
       -o -name 'gitk*' -o -name 'msalruntime.dll' \) -delete 2>/dev/null || true
  rm -rf "$g/ucrt64/libexec/git-core"/git-gui* "$g/ucrt64/libexec/git-core"/gitk* 2>/dev/null || true
  # niche network/serving subcommands (github/gitlab remotes use remote-https)
  for exe in git-remote-ftp git-remote-ftps git-imap-send git-daemon \
             git-http-backend git-http-push git-http-fetch; do
    rm -f "$g/ucrt64/libexec/git-core/$exe.exe" "$g/ucrt64/bin/$exe.exe" 2>/dev/null || true
  done
  rm -f "$g/ucrt64/bin/git-lfs.exe" 2>/dev/null || true
  # orphaned msys DLLs (perl/krb5/gnutls/gpg chains; their exes are gone)
  rm -f "$g/usr/bin/"msys-perl5_42.dll "$g/usr/bin/"msys-apr{,util}* \
        "$g/usr/bin/"msys-{heimbase,heimntlm,hx509,hcrypto,krb5,gssapi,assuan,ksba,gcrypt, \
                             gpg-error,npth,fido2,cbor,gdbm,gdbm_compat,mpfr,com_err,asn1,ffi, \
                             edit,lz4}*.dll 2>/dev/null || true
  # git-lfs filter removed -> LFS repos warn and check out pointers, not error
  python3 - "$g/etc/gitconfig" <<'PYG'
import re, sys
p = sys.argv[1]
s = open(p).read()
s = re.sub(r'\[filter "lfs"\]\n(?:\t[^\n]*\n)+', '', s)
s = s.replace('[credential]\n\thelper = helper-selector\n', '')
open(p, 'w').write(s)
PYG
  [[ -f "$g/usr/bin/bash.exe" && -f "$g/cmd/git.exe" \
     && -f "$g/ucrt64/libexec/git-core/git-remote-https.exe" \
     && -f "$g/usr/bin/ssh.exe" ]] || {
    echo "PortableGit missing bash/git — Claude shell tools would be broken" >&2; exit 1; }
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
  # build-plugins npm-installs dev deps into each plugin dir; the dists are
  # fully bundled, so the plugin-local node_modules are pure build artifacts.
  rm -rf "$stage"/cloudcli-plugin-*/node_modules

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
