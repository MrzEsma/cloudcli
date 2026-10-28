#!/usr/bin/env bash
# Builds and starts CloudCLI (with the interactive-Claude + UI overlays) on any
# machine with Docker. Needs no account anywhere: the base image comes from
# Docker Hub and packages from the public npm registry.
#
#   bash install.sh                 # build + run on port 3001
#   PORT=8080 bash install.sh       # other port
#   NODE_IMAGE=<mirror>/node:22.23.1-bookworm-slim NPM_REGISTRY=<npm mirror> bash install.sh
set -Eeuo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"
PORT="${PORT:-3001}"
NAME="${NAME:-cloudcli}"
IMAGE="${IMAGE:-cloudcli:local}"
ADMIN_USER="${CLOUDCLI_ADMIN_USERNAME:-admin}"
ADMIN_PASS="${CLOUDCLI_ADMIN_PASSWORD:-}"

command -v docker >/dev/null || { echo "Docker is required: https://docs.docker.com/engine/install/" >&2; exit 1; }

build_args=()
[[ -n "${NODE_IMAGE:-}" ]] && build_args+=(--build-arg "NODE_IMAGE=$NODE_IMAGE")
[[ -n "${NPM_REGISTRY:-}" ]] && build_args+=(--build-arg "NPM_REGISTRY=$NPM_REGISTRY")
docker build "${build_args[@]}" -t "$IMAGE" .

if [[ -z "$ADMIN_PASS" ]]; then
  ADMIN_PASS="$(head -c 18 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 16)"
  generated=1
fi

docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --name "$NAME" --restart unless-stopped \
  -p "$PORT:3001" \
  -e CLOUDCLI_ADMIN_USERNAME="$ADMIN_USER" \
  -e CLOUDCLI_ADMIN_PASSWORD="$ADMIN_PASS" \
  ${SONIOX_API_KEY:+-e SONIOX_API_KEY="$SONIOX_API_KEY"} \
  -v "$NAME-home:/home/cloudcli" \
  -v "$NAME-workspace:/workspace" \
  "$IMAGE" >/dev/null

echo
echo "CloudCLI is starting on http://localhost:$PORT"
echo "  user: $ADMIN_USER"
[[ -n "${generated:-}" ]] && echo "  password: $ADMIN_PASS   (generated — save it)"
echo "Then sign in to Claude / Codex once from the UI. Logs: docker logs -f $NAME"
