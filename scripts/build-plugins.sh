#!/usr/bin/env bash
# Installs dependencies and builds every bundled plugin in place.
#   bash scripts/build-plugins.sh [root]     # default: repo root
set -Eeuo pipefail
ROOT="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
NPM_REGISTRY="${NPM_REGISTRY:-https://registry.npmjs.org/}"
cd "$ROOT"
for p in cloudcli-plugin-soniox cloudcli-plugin-browser-feedback \
         cloudcli-plugin-openai-setup cloudcli-plugin-cron cloudcli-plugin-terminal; do
  [[ -f "$p/package.json" ]] || { echo "missing $p" >&2; exit 1; }
  npm ci --prefix "$p" --include=dev --no-audit --no-fund --registry="$NPM_REGISTRY"
  if [[ "$p" == cloudcli-plugin-browser-feedback ]]; then
    npm --prefix "$p" run build:dev
  else
    npm --prefix "$p" run build
  fi
  npm --prefix "$p" prune --omit=dev --no-audit --no-fund
done
echo "plugins built."
