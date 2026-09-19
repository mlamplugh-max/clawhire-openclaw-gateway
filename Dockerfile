# syntax=docker/dockerfile:1.7
# ClawHire OpenClaw Gateway Worker — deployable image (Fly Machines).
#
# Layering:
#   - Stage `adapter-build` compiles THIS TypeScript adapter to dist/.
#   - Final stage installs the REAL OpenClaw runtime (openclaw@<ver>) and runs
#     the adapter. With OPENCLAW_ENGINE=openclaw the adapter drives the real
#     `openclaw` CLI; with stub it runs standalone for contract/smoke checks.
#
# Node: openclaw@2026.6.10 requires node >=22.19.0 — both stages use node:22.
#
# OPTION B isolation (founder-locked): per-agent OS isolation WITHOUT
# Docker-in-Docker — each agent gets its own OPENCLAW_STATE_DIR/HOME/workspace
# under a tenant-scoped fsRoot (OPENCLAW_SANDBOX=local). No nested container
# runtime is required inside the Fly microVM.

FROM node:22-bookworm-slim AS adapter-build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build
RUN npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Minimal tools the runtime may need.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git jq \
     chromium fonts-liberation fonts-noto-core fonts-noto-color-emoji \
  && rm -rf /var/lib/apt/lists/*

# Install the REAL OpenClaw runtime. Pin the version validated against the
# adapter's CLI flag matrix (openclaw agents add / agent --local / agents delete).
ARG OPENCLAW_VERSION="2026.6.10"
ARG OPENCLAW_INSTALL="npm install -g openclaw@${OPENCLAW_VERSION} --no-audit --no-fund"
RUN if [ -n "$OPENCLAW_INSTALL" ]; then echo "Installing OpenClaw: $OPENCLAW_INSTALL" && eval "$OPENCLAW_INSTALL" && openclaw --version; fi

COPY --from=adapter-build /app/node_modules ./node_modules
COPY --from=adapter-build /app/dist ./dist
# D2: the clawhire MCP stdio tool-proxy (runtime asset, not bundled by tsc build)
COPY src/tools/clawhire-mcp.mjs ./mcp/clawhire-mcp.mjs
COPY package.json ./
COPY deploy/start.sh ./deploy/start.sh
RUN chmod +x ./deploy/start.sh

# Persistent per-agent state volume mount point (Fly volume).
VOLUME ["/data"]
ENV DATA_ROOT=/data/agents \
    OPENCLAW_HOME=/data/openclaw \
    OPENCLAW_ENGINE=openclaw \
    OPENCLAW_SANDBOX=local \
    OPENCLAW_BIN=openclaw \
    PORT=8000

EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD curl -fsS http://127.0.0.1:${PORT}/health || exit 1

# BROWSER_BOX_V1: the per-company browser runs in THIS container (persistent profile on /data).
ENV CHROMIUM_BIN=/usr/bin/chromium BROWSER_PROFILES_ROOT=/data/browser-profiles

CMD ["./deploy/start.sh"]
