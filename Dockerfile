ARG NODE_IMAGE=node:22.23.1-bookworm-slim
FROM ${NODE_IMAGE}

# Pass NPM_REGISTRY / NODE_IMAGE through for mirrors.
ARG NPM_REGISTRY=https://registry.npmjs.org/

ENV NODE_ENV=production \
    HOME=/home/cloudcli \
    HOST=0.0.0.0 \
    SERVER_PORT=3001 \
    PORT=3001 \
    DATABASE_PATH=/home/cloudcli/.cloudcli/auth.db \
    SONIOX_ADAPTER_HOST=127.0.0.1 \
    SONIOX_ADAPTER_PORT=3002 \
    SONIOX_MODEL=stt-async-v5 \
    SONIOX_LANGUAGE_HINTS=fa \
    SONIOX_TRANSCRIPTION_TIMEOUT_MS=120000 \
    CLOUDCLI_WORKSPACE=/workspace

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash ca-certificates curl git gosu make openssh-client procps python3 \
    ripgrep rsync tini g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund --registry="$NPM_REGISTRY"

# The overlay turns the stock cloudcli package into this build's runtime
# (interactive Claude chat, no SDK fallback, UI patches).
COPY cloudcli-overlay ./cloudcli-overlay
RUN bash cloudcli-overlay/apply.sh /app \
  && chown -R node:node /app/node_modules/@cloudcli-ai/cloudcli

COPY scripts ./scripts
COPY cloudcli-plugin-soniox cloudcli-plugin-browser-feedback cloudcli-plugin-openai-setup \
     cloudcli-plugin-cron cloudcli-plugin-terminal tenant-agent-skills ./
RUN bash scripts/build-plugins.sh /app \
  && mkdir -p "$HOME" "$CLOUDCLI_WORKSPACE" \
  && chown -R node:node "$HOME" "$CLOUDCLI_WORKSPACE" /app/cloudcli-plugin-* /app/tenant-agent-skills \
  && chmod +x /app/scripts/*.sh

EXPOSE 3001
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["bash", "/app/scripts/start-production.sh"]
