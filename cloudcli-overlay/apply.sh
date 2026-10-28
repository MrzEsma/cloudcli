#!/usr/bin/env bash
# Applies the cloudcli package overlay onto a stock install: interactive
# Claude chat runtime, session model isolation, UI patches. Idempotent.
#   bash cloudcli-overlay/apply.sh [app-root]    # default: repo root
set -Eeuo pipefail
OVER="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${1:-$(cd "$OVER/.." && pwd)}"
PKG="$ROOT/node_modules/@cloudcli-ai/cloudcli"
[[ -f "$PKG/package.json" ]] || { echo "node_modules missing; run npm ci first" >&2; exit 1; }
# Keep the stock server entry around for reference/rollback.
if [[ -f "$PKG/dist-server/server/index.js" && ! -f "$PKG/dist-server/server/index.js.pre-claude-interactive" ]]; then
  cp "$PKG/dist-server/server/index.js" "$PKG/dist-server/server/index.js.pre-claude-interactive"
fi
(cd "$OVER" && sha256sum -c manifest.sha256 >/dev/null) || { echo "overlay manifest mismatch" >&2; exit 1; }
cp -a "$OVER/package/." "$PKG/"
echo "cloudcli overlay applied to $PKG"
