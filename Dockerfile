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
RUN --mount=type=cache,target=/app/.build/next/cache \
  mkdir -p /app/data && npm run build

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

# `npm run build` (build-next-isolated → assembleStandalone) bundles ALL runtime
# files into .build/next/standalone/ — .next, node_modules, migrations, scripts,
# docs, and the previously hand-COPY'd modules below (@swc/helpers, pino-*, split2,
# migrations). assembleStandalone copies them straight from the builder's
# node_modules, so they are present regardless of NFT/Turbopack trace behaviour.
# The old per-module overrides were therefore pure duplication and were removed
# (build-output-isolation cleanup). See scripts/build/assembleStandalone.mjs
# (EXTRA_MODULE_ENTRIES) for the single source of truth.
COPY --from=builder /app/.build/next/standalone ./
# better-sqlite3 is the one exception still copied explicitly: assembleStandalone
# only syncs its native build/ dir; the JS wrapper (lib/, package.json) is left to
# Next.js tracing. bootstrap-env requires SQLite BEFORE the standalone server
# starts, so guarantee the complete package independent of trace behaviour.
COPY --from=builder /app/node_modules/better-sqlite3 ./node_modules/better-sqlite3
# migrations land at <standalone>/migrations via assembleStandalone; point the runtime at them.
ENV OMNIROUTE_MIGRATIONS_DIR=/app/migrations
# MITM server.cjs is spawned at runtime via child_process — not traced by nft
COPY --from=builder /app/src/mitm/server.cjs ./src/mitm/server.cjs

COPY --from=builder /app/scripts/dev/run-standalone.mjs ./dev/run-standalone.mjs
COPY --from=builder /app/scripts/dev/docker-entrypoint.sh ./docker-entrypoint.sh
COPY --from=builder /app/scripts/dev/standalone-server-ws.mjs ./server-ws.mjs
COPY --from=builder /app/scripts/dev/peer-stamp.mjs ./peer-stamp.mjs
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

# Copy playwright and playwright-core from the builder stage.
# The slim runtime image does not have playwright in node_modules, so npx falls
# back to a registry download — unreliable on CI runners (exits 127 on failure).
# Copying from the builder avoids any network access at image-build time and also
# ensures the same playwright version is available at runtime for web-session providers.
COPY --from=builder /app/node_modules/playwright-core ./node_modules/playwright-core
COPY --from=builder /app/node_modules/playwright ./node_modules/playwright

# Install Playwright browser binaries + OS dependencies under root, then hand
# ownership of the browsers cache to the node user.
# PLAYWRIGHT_BROWSERS_PATH overrides the default ~/.cache/ms-playwright so the
# browsers land under /home/node which persists across image layers and is
# accessible to the non-root runtime user.
ENV PLAYWRIGHT_BROWSERS_PATH=/home/node/.cache/ms-playwright
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
  --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
  apt-get update \
  && node node_modules/playwright/cli.js install chromium --with-deps \
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
