# ── Common base with runtime deps ──────────────────────────────────────────
FROM node:24-trixie-slim AS base
WORKDIR /app

RUN --mount=type=cache,target=/var/cache/apt,sharing=shared \
  --mount=type=cache,target=/var/lib/apt/lists,sharing=shared \
  apt-get update \
  && apt-get install -y --no-install-recommends libsecret-1-0 ca-certificates gosu \
  && rm -rf /var/lib/apt/lists/*

# ── Builder ────────────────────────────────────────────────────────────────
FROM base AS builder

# Build tools for native module compilation
# apt-get update needed here because base's rm -rf clears the shared cache
RUN --mount=type=cache,target=/var/cache/apt,sharing=shared \
  --mount=type=cache,target=/var/lib/apt/lists,sharing=shared \
  apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
COPY scripts/build/postinstall.mjs ./scripts/build/postinstall.mjs
COPY scripts/build/postinstallSupport.mjs ./scripts/build/postinstallSupport.mjs
COPY scripts/build/native-binary-compat.mjs ./scripts/build/native-binary-compat.mjs
ENV NPM_CONFIG_LEGACY_PEER_DEPS=true
# --ignore-scripts blocks broad dependency install/postinstall hooks, closing
# the supply-chain attack surface where a transitive dep can run arbitrary code
# at install time. better-sqlite3 still needs a native binding for the target
# platform, so rebuild and smoke-test only that known runtime dependency below.
#
# We REQUIRE a committed package-lock.json so resolved dependency versions
# are reproducible.
RUN test -f package-lock.json \
  || (echo "package-lock.json is required for reproducible Docker builds" >&2 && exit 1)
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
  npm ci --no-audit --no-fund --legacy-peer-deps --ignore-scripts \
  && npm rebuild better-sqlite3 \
  && node -e "require('better-sqlite3')(':memory:').close()"

ARG OMNIROUTE_BUILD_MEMORY_MB=4096
ENV OMNIROUTE_BUILD_MEMORY_MB=${OMNIROUTE_BUILD_MEMORY_MB}
ARG OMNIROUTE_NEXT_BUILD_WORKERS=1
ENV OMNIROUTE_NEXT_BUILD_WORKERS=${OMNIROUTE_NEXT_BUILD_WORKERS}
ENV NEXT_TELEMETRY_DISABLED=1
COPY . ./
RUN --mount=type=cache,target=/app/.next/cache \
  mkdir -p /app/data && npm run build -- --webpack

# ── Runner base ────────────────────────────────────────────────────────────
FROM base AS runner-base

LABEL org.opencontainers.image.title="omniroute" \
  org.opencontainers.image.description="Unified AI proxy — route any LLM through one endpoint" \
  org.opencontainers.image.url="https://omniroute.online" \
  org.opencontainers.image.source="https://github.com/diegosouzapw/OmniRoute" \
  org.opencontainers.image.licenses="MIT"

ENV NODE_ENV=production
ENV PORT=20128
ENV HOSTNAME=0.0.0.0
ENV OMNIROUTE_MEMORY_MB=2048
ENV NODE_OPTIONS="--max-old-space-size=${OMNIROUTE_MEMORY_MB}"

# Data directory inside Docker — must match the volume mount in docker-compose.yml
ENV DATA_DIR=/app/data
ENV SQLITE_MAX_SIZE_MB=2048
RUN mkdir -p /app/data

# The standalone build + syncStandaloneExtraModules bundles all runtime files
# (.next, node_modules, migrations, scripts, docs, etc.) into .next/standalone/.
# Explicit overrides below cover modules that NFT tracing may miss.
COPY --from=builder /app/.next/standalone ./
# Explicitly copy @swc/helpers — not always traced by standalone output but needed at runtime
COPY --from=builder /app/node_modules/@swc/helpers ./node_modules/@swc/helpers
# Explicitly copy better-sqlite3 — native bindings are not reliably traced by
# Next.js standalone output, but bootstrap-env requires SQLite before startup.
COPY --from=builder /app/node_modules/better-sqlite3 ./node_modules/better-sqlite3
# Explicitly copy pino transport dependencies — pino spawns a worker that requires
# pino-abstract-transport at runtime; Next.js standalone trace does not capture it (#449)
COPY --from=builder /app/node_modules/pino-abstract-transport ./node_modules/pino-abstract-transport
COPY --from=builder /app/node_modules/pino-pretty ./node_modules/pino-pretty
COPY --from=builder /app/node_modules/split2 ./node_modules/split2
# Migration SQL files are read via fs.readFileSync at runtime and are NOT
# traced by Next.js standalone output — copy them explicitly.
COPY --from=builder /app/src/lib/db/migrations ./migrations
ENV OMNIROUTE_MIGRATIONS_DIR=/app/migrations
# MITM server.cjs is spawned at runtime via child_process — not traced by nft
COPY --from=builder /app/src/mitm/server.cjs ./src/mitm/server.cjs
# Runtime docs are pruned by .dockerignore to English markdown + OpenAPI.
# Next.js standalone tracing does not include docs read via fs.
COPY --from=builder /app/.next/standalone/docs ./docs

COPY --from=builder /app/scripts/dev/run-standalone.mjs ./dev/run-standalone.mjs
COPY --from=builder /app/scripts/dev/docker-entrypoint.sh ./docker-entrypoint.sh
COPY --from=builder /app/scripts/dev/standalone-server-ws.mjs ./server-ws.mjs
COPY --from=builder /app/scripts/dev/responses-ws-proxy.mjs ./responses-ws-proxy.mjs
COPY --from=builder /app/scripts/dev/v1-ws-bridge.mjs ./v1-ws-bridge.mjs
COPY --from=builder /app/scripts/build/runtime-env.mjs ./build/runtime-env.mjs
COPY --from=builder /app/scripts/build/bootstrap-env.mjs ./build/bootstrap-env.mjs
COPY --from=builder /app/scripts/dev/healthcheck.mjs ./healthcheck.mjs

RUN node -e "require('better-sqlite3')(':memory:').close()"

# Hand /app over to the baked-in `node` user (UID/GID 1000). The entrypoint
# starts as root only long enough to repair mounted DATA_DIR ownership, then
# execs the app as `node`.
RUN chown -R node:node /app
RUN chmod +x /app/docker-entrypoint.sh

EXPOSE 20128

USER root

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "healthcheck.mjs"]

ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["node", "dev/run-standalone.mjs"]

# ── Runner Web (web-cookie providers: Gemini Web, Claude Turnstile) ───────────
#
#  Two image flavors:
#    runner-base  →  omniroute:VERSION        Lean base (~500 MB). No browsers.
#    runner-web   →  omniroute:VERSION-web    +Chromium/Playwright (~800 MB).
#
#  Use runner-web when you need web-cookie providers (gemini-web, claude-web,
#  claude-turnstile). For all other providers runner-base is sufficient.
#
#  Build:
#    docker build --target runner-web -t omniroute:web .
#  Compose:
#    build:
#      context: .
#      target: runner-web
FROM runner-base AS runner-web

USER root

# Install Playwright browser binaries + OS dependencies under root, then hand
# ownership of the browsers cache to the node user.
# PLAYWRIGHT_BROWSERS_PATH overrides the default ~/.cache/ms-playwright so the
# browsers land under /home/node which persists across image layers and is
# accessible to the non-root runtime user.
ENV PLAYWRIGHT_BROWSERS_PATH=/home/node/.cache/ms-playwright
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
  --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
  apt-get update \
  && npx playwright install chromium --with-deps \
  && chown -R node:node /home/node/.cache \
  && rm -rf /var/lib/apt/lists/*

USER root

FROM runner-base AS runner-cli

# runner-base launches through docker-entrypoint.sh as root so it can repair
# mounted DATA_DIR ownership before dropping to `node`; keep that pattern here
# after installing the extra CLI packages.
USER root

# Install system dependencies required by openclaw (git+ssh references).
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
  --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
  apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates docker.io docker-compose \
  && rm -rf /var/lib/apt/lists/* \
  && git config --system url."https://github.com/".insteadOf "ssh://git@github.com/"

# Install CLI tools globally. Separate layer from apt for better cache reuse.
RUN --mount=type=cache,target=/root/.npm \
  npm install -g --no-audit --no-fund @openai/codex @anthropic-ai/claude-code droid openclaw@latest
