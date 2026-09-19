#!/usr/bin/env bash
# Launch script for the ClawHire OpenClaw Gateway worker.
# The adapter (the /agents/* contract the bridge speaks) is the ONLY long-lived
# process. Each agent turn is executed by shelling `openclaw agent --local`
# (an embedded, self-contained run) per request -> we do NOT need a background
# `openclaw gateway` server (that only added cold-start cost, an auth warning,
# and memory contention on the shared VM, which made the :8000 health check
# flap and Fly return 503). Keeping boot minimal => health check passes fast.
set -euo pipefail

PORT="${PORT:-8000}"
ENGINE="${OPENCLAW_ENGINE:-stub}"

mkdir -p "${DATA_ROOT:-/data/agents}" "${OPENCLAW_HOME:-/data/openclaw}"

if [ "$ENGINE" = "openclaw" ] && command -v "${OPENCLAW_BIN:-openclaw}" >/dev/null 2>&1; then
  echo "[start] Engine=openclaw (real). Turns run via 'openclaw agent --local' per request; no bg gateway."
  "${OPENCLAW_BIN:-openclaw}" --version || true
else
  echo "[start] Engine=$ENGINE."
fi

echo "[start] Starting adapter on :$PORT"
exec node dist/server.js
