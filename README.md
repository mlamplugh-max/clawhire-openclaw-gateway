# clawhire-openclaw-gateway

[![CI](https://github.com/mlamplugh-max/clawhire-openclaw-gateway/actions/workflows/ci.yml/badge.svg)](https://github.com/mlamplugh-max/clawhire-openclaw-gateway/actions/workflows/ci.yml) ![Licence: Elastic 2.0](https://img.shields.io/badge/licence-Elastic_2.0-blue) ![Node 20+](https://img.shields.io/badge/node-%3E%3D20-brightgreen)

**Run [OpenClaw](https://github.com/openclaw/openclaw) agents for many companies on one worker, safely.**

A small Node worker that wraps the real `openclaw` CLI and adds what a multi-tenant deployment needs: a private OS sandbox per agent, hard per-tenant scoping of data and memory, per-tenant OAuth token brokering so the worker never holds long-lived customer credentials, and cost telemetry with a monthly cap. It speaks a frozen REST contract (`/agents/*`), ships with a stub engine so the contract is testable without an LLM, and deploys as one Docker image to Fly Machines.

This is the runtime behind [ClawHire](https://clawhire.ai)'s hosted AI employees. It is published so teams running OpenClaw for more than one client can start from a worker that already solves isolation, credentials and cost, instead of rediscovering each of them in production.

- **Licence:** [Elastic License 2.0](./LICENSE). Use it, modify it, self-host it for your own company or clients for free. What you may not do is offer it to third parties as a hosted or managed service. Plain-English summary in [Licence](#licence).
- **OpenClaw itself** is a separate MIT-licensed project by the OpenClaw Foundation. It is installed at build time as a dependency and is not redistributed here.
- **Status:** v2.0.0. The `/agents/*` contract is frozen; changes to it are versioned.

---

## Contents

- [What it adds on top of OpenClaw](#what-it-adds-on-top-of-openclaw)
- [Architecture](#architecture)
- [Quick start](#quick-start)
- [The `/agents/*` contract](#the-agents-contract)
- [Configuration](#configuration)
- [Tenant isolation and the token broker](#tenant-isolation-and-the-token-broker)
- [Cost guardrails](#cost-guardrails)
- [Deploying](#deploying)
- [What this is not](#what-this-is-not)
- [Licence](#licence)
- [Maintained by ClawHire](#maintained-by-clawhire)

---

## What it adds on top of OpenClaw

OpenClaw gives you a capable single-agent runtime. Running it *for other people* raises four problems this worker exists to answer.

| Problem | What this worker does |
|---|---|
| **One agent must never see another's files, memory or secrets** | Each agent runs in its own OpenClaw per-agent OS sandbox (`OPENCLAW_SANDBOX=local`) with its own state dir, home and workspace under a tenant-scoped root. No Docker-in-Docker is required inside the VM. |
| **Tenant credentials must not live on a shared worker** | The worker holds no customer OAuth tokens at rest. For each session it asks your control plane's token broker for a short-lived token (`TENANT_TOKEN_TTL_SECONDS`), uses it, and lets it expire. |
| **A runaway agent must not run up an unbounded bill** | Every turn is metered (LLM tokens plus machine-seconds). A monthly cap (`MONTHLY_COST_CAP_USD`) can be enforced, not just reported. |
| **The control plane needs a stable API, not a CLI** | A frozen `/agents/*` REST contract, authenticated with a single worker key, with a stub engine so the contract can be exercised in CI without any model. |

Also included: a browser-session facility (`/browser/sessions`) and an MCP stdio tool proxy (`src/tools/clawhire-mcp.mjs`) so a sandboxed agent can call tools that live on your control plane.

## Architecture

```
  your control plane                          this worker (one Fly Machine, or any Docker host)
  ┌──────────────────────────┐   HTTP        ┌──────────────────────────────────────────────┐
  │ your app / orchestrator  │──────────────▶│ Adapter (Express)   /agents/*  /browser/*     │
  │                          │               │   ├─ AgentRegistry   one record per agent     │
  │ token broker endpoint    │◀──────────────│   ├─ TenantScope     data / memory / secrets  │
  │ (short-lived OAuth       │  per session  │   ├─ Engine          openclaw | stub           │
  │  tokens on request)      │               │   │    └─ `openclaw agent --local` per turn    │
  └──────────────────────────┘               │   ├─ TokenBroker     fetch, use, expire        │
                                             │   └─ CostTelemetry   meter + monthly cap       │
                                             │  /data/agents/<tenant>/<agent>/  (volume)      │
                                             └──────────────────────────────────────────────┘
```

Each agent turn is executed by shelling `openclaw agent --local` as an embedded run. There is deliberately **no** long-lived background `openclaw gateway` process: in production it only added cold-start cost, memory contention and health-check flapping on a shared VM. The adapter is the only long-lived process, so boot is fast and the health check is honest.

## Quick start

Requirements: Node 22+. For the real engine, the `openclaw` CLI (the Dockerfile installs `openclaw@2026.6.10`, the version this adapter's flag matrix was validated against).

```bash
git clone https://github.com/mlamplugh-max/clawhire-openclaw-gateway.git
cd clawhire-openclaw-gateway
npm install
cp .env.example .env          # set OPENCLAW_API_KEY at minimum

npm run dev                   # stub engine: no LLM, no openclaw binary needed
curl -s localhost:8000/health
```

Run the contract tests (stub engine, no network):

```bash
npm run contract-test
```

Switch to the real engine by setting `OPENCLAW_ENGINE=openclaw` with the CLI on your `PATH` (or `OPENCLAW_BIN`), plus a model key (`OPENROUTER_API_KEY` or `OPENAI_API_KEY`).

## The `/agents/*` contract

Every request carries the worker key as **both** `Authorization: Bearer <OPENCLAW_API_KEY>` and `x-api-key: <OPENCLAW_API_KEY>`.

| Method | Path | Body | Response |
|---|---|---|---|
| `GET` | `/health` | — | `{ status, version?, agents? }` |
| `GET` | `/agents` | — | `{ agents: [{ agent_id, tenant_id, status }] }` |
| `POST` | `/agents` | `tenant_id, employee_id, agent_name, role_title, system_prompt, skills[], memory_context, model, ...` (snake or camel case) | the created agent record |
| `POST` | `/agents/:id/messages` | `{ message, session_id }` | `{ response, session_id, tokens: { prompt, completion, total }, tools_used[] }` |
| `GET` | `/agents/:id/status` | — | `{ agent_id, status: online \| offline \| error \| provisioning, uptime, last_active, memory_usage_mb, active_session_count }` |
| `PATCH` | `/agents/:id` | `{ system_prompt, skills, memory_context, model }` | `204` |
| `DELETE` | `/agents/:id` | — | `204` |
| `POST` | `/agents/:id/skills` | `{ skill_slug }` | `204` |
| `POST` | `/agents/:id/integrations` | `{ integration_slug }` | `{ connectionId }` |
| `GET` | `/agents/:id/tools` | — | `{ tools: [{ name, description, category, enabled }] }` |
| `GET` / `POST` | `/browser/sessions` | — / session request | list / created session |
| `GET` / `DELETE` | `/browser/sessions/:id` | — | session / `204` |

The full request and response shapes are in `src/types.ts`, and `test/contract.test.ts` is the executable specification.

## Configuration

All configuration is by environment variable (`src/config.ts`). `.env.example` lists the common ones.

| Variable | Purpose |
|---|---|
| `PORT` | HTTP port (default `8000`). |
| `LOG_LEVEL` | Adapter log verbosity. |
| `OPENCLAW_API_KEY` | The worker key your control plane must present. **Required.** |
| `OPENCLAW_ENGINE` | `openclaw` (real) or `stub` (contract tests, no model). |
| `OPENCLAW_BIN` | Path to the `openclaw` CLI (default `openclaw`). |
| `OPENCLAW_HOME` | OpenClaw home on the volume (default `/data/openclaw`). |
| `OPENCLAW_SANDBOX` | Sandbox mode; `local` gives each agent its own OS-level state. |
| `OPENCLAW_DEFAULT_MODEL` | Model used when an agent record does not specify one. |
| `OPENCLAW_TURN_TIMEOUT_SEC` | Hard timeout per agent turn. |
| `OPENROUTER_API_KEY`, `OPENAI_API_KEY` | Model provider keys for the real engine. |
| `DATA_ROOT` | Root of per-tenant, per-agent state (default `/data/agents`). |
| `WORKER_TENANCY_MODE` | Tenancy policy for the pool. |
| `TENANT_TOKEN_BROKER_URL`, `TENANT_TOKEN_BROKER_KEY`, `TENANT_TOKEN_TTL_SECONDS` | Where and how the worker fetches short-lived tenant OAuth tokens. |
| `TENANT_TOOL_EXEC_URL` | Control-plane endpoint that executes tenant tools on the agent's behalf. |
| `MONTHLY_COST_CAP_USD`, `COST_CAP_ENFORCE` | Monthly spend ceiling and whether to enforce it (vs. report only). |
| `FLY_MACHINE_USD_PER_SECOND`, `LLM_USD_PER_*` | Unit prices used by the cost meter. |

## Tenant isolation and the token broker

Two rules the worker is built around, because they are the two things that go wrong first in a shared deployment:

1. **State is scoped, then sandboxed.** Every agent's files, memory and OpenClaw state live under `DATA_ROOT/<tenant>/<agent>/`, and the agent process runs inside an OpenClaw per-agent sandbox pointed at exactly that directory. A prompt injection that escapes an agent's instructions still cannot read a neighbour's directory.
2. **Credentials are borrowed, never kept.** When an agent needs to act in a customer's Gmail, CRM or calendar, the worker requests a short-lived token from your control plane's broker (`TENANT_TOKEN_BROKER_URL`, authenticated with `TENANT_TOKEN_BROKER_KEY`), uses it for that session, and discards it. Long-lived refresh tokens stay on your control plane, behind your own encryption and audit log. The worker's own compromise therefore exposes no durable customer credentials.

The broker endpoint is yours to implement; the worker only defines the request it makes. See `src/tools/token-broker.ts`.

## Cost guardrails

`src/telemetry/cost.ts` meters every turn: model tokens at your configured unit prices plus machine time at `FLY_MACHINE_USD_PER_SECOND`. Totals roll up per month. With `COST_CAP_ENFORCE=true`, new sessions and turns are refused with HTTP `429 cost_cap_reached` once `MONTHLY_COST_CAP_USD` is reached (so a control plane can fall back gracefully); with it off, the cap is reported in `/health` and logs so you can alert on it without cutting anyone off.

## Deploying

The image is a two-stage Docker build on `node:22-bookworm-slim`: the adapter is compiled, then the real OpenClaw CLI is installed globally at a pinned version. A `fly.toml` is included at the repository root; set `app` to a name of your own, since Fly app names are global.

```bash
fly launch --copy-config --no-deploy   # first time, in your own Fly org
fly volumes create clawdata --size 10  # all agent state lives on this volume at /data
fly secrets set OPENCLAW_API_KEY=... TENANT_TOKEN_BROKER_KEY=... OPENROUTER_API_KEY=...
fly deploy
```

Two lessons from running this in production are baked into `fly.toml` and worth reading before you change it: the `[mounts]` section is not cosmetic (without it a deploy can detach the volume and start the worker with zero agents), and health checks stay green because the adapter is the only long-lived process.

Any Docker host works the same way: run the image with `/data` mounted and the variables above set.

## What this is not

This repository is the **runtime**, not the product. It contains no role prompts, no skills library, no memory or learning layer, no approval workflow, no user interface, no billing, and no employee catalogue. It runs whatever agents your control plane registers with it.

## Licence

**Elastic License 2.0.** In plain terms:

- **You can** use, copy, modify and self-host this software, for your own company or for your clients, at no cost.
- **You can** read every line of it, and open issues and pull requests.
- **You cannot** provide it to third parties as a hosted or managed service that offers a substantial part of its functionality, and you cannot remove the licence notices.

The full text is in [LICENSE](./LICENSE). This is a source-available licence, not an OSI-approved open-source licence; if that matters for your use, please read it. OpenClaw, the dependency, is MIT.

## Maintained by ClawHire

This worker is maintained by [ClawHire AI Inc.](https://clawhire.ai) and runs in production behind its hosted AI-employee service, where every customer's employees are OpenClaw agents on exactly this runtime. The role training, learning layer, approval workflow and interface belong to that service, not to this repository, which is why they are absent here.

Agencies running OpenClaw for their own clients can read about ClawHire's [partner programme](https://clawhire.ai/partners). Questions, issues and pull requests about the worker itself are welcome here; see [CONTRIBUTING.md](./CONTRIBUTING.md) and [SECURITY.md](./SECURITY.md).

---

Copyright (c) 2026 ClawHire AI Inc. See [NOTICE](./NOTICE).
