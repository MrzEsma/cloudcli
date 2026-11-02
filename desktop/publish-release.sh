#!/usr/bin/env bash
# Publish desktop bundles as a GitHub Release on MrzEsma/cloudcli and print
# the public download links. Auth: PAT read from ~/.config/github/token (0600)
# — the token is passed via stdin/headers only, never embedded in a URL.
#   bash desktop/publish-release.sh <bundle.zip> [<bundle.zip> ...]
set -Eeuo pipefail

REPO_API="https://api.github.com/repos/MrzEsma/cloudcli"
TOKEN_FILE="${HOME}/.config/github/token"
GIT_HELPER="${HOME}/.config/github/git-credential-github"
[[ -r "$TOKEN_FILE" ]] || { echo "no GitHub token at $TOKEN_FILE" >&2; exit 1; }
TOKEN="$(cat "$TOKEN_FILE")"
TAG="desktop-$(date +%Y%m%d)"
REMOTE_URL="https://github.com/MrzEsma/cloudcli.git"

(( $# >= 1 )) || { echo "usage: publish-release.sh <bundle.zip> [...]" >&2; exit 1; }
for z in "$@"; do [[ -f "$z" ]] || { echo "missing $z" >&2; exit 1; }; done

# 1) push the desktop branch (helper supplies credentials; token stays out of URLs)
# push when the remote branch is missing or behind (ls-remote exits 0 either way)
remote_sha="$(git ls-remote --heads "$REMOTE_URL" desktop | cut -f1)"
local_sha="$(git rev-parse desktop)"
if [[ "$remote_sha" != "$local_sha" ]]; then
  git -c "credential.helper=$GIT_HELPER" push -f "$REMOTE_URL" "desktop:desktop" >/dev/null
fi

# 2) release (create, or reuse if today's already exists)
rel="$(curl -sf -X POST \
  -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json" \
  -d "{\"tag_name\":\"$TAG\",\"target_commitish\":\"desktop\",\"name\":\"CloudCLI Desktop $TAG\",\"body\":\"Portable double-click builds (extract, double-click, follow README-FA.md). Claude Code + Codex, no Docker/Node/terminal needed. All data stays in the folder.\"}" \
  "$REPO_API/releases" 2>/dev/null || curl -sf -H "Authorization: Bearer $TOKEN" "$REPO_API/releases/tags/$TAG")"
rel_id="$(python3 -c "import json,sys;print(json.loads(sys.argv[1])['id'])" "$rel")"

# 3) upload assets (delete same-name first so reruns succeed)
for z in "$@"; do
  name="$(basename "$z")"
  # delete an existing asset of the same name first (id-based; name-based
  # asset DELETE is not an endpoint and same-name upload 422s)
  aid="$(curl -sf -H "Authorization: Bearer $TOKEN" "$REPO_API/releases/$rel_id/assets" \
    | python3 -c "import json,sys;print(next((a['id'] for a in json.load(sys.stdin) if a['name']==sys.argv[1]),''))" "$name")"
  [[ -n "$aid" ]] && curl -sf -X DELETE -H "Authorization: Bearer $TOKEN" \
    "https://api.github.com/repos/MrzEsma/cloudcli/releases/assets/$aid" >/dev/null || true
  curl -sf --retry 3 -X POST \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/zip" \
    --data-binary "@$z" \
    "https://uploads.github.com/repos/MrzEsma/cloudcli/releases/$rel_id/assets?name=$name" >/dev/null
  echo "https://github.com/MrzEsma/cloudcli/releases/download/$TAG/$name"
done
