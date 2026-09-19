/**
 * Engine abstraction over the OpenClaw runtime.
 *
 * Two implementations:
 *   - StubEngine  (OPENCLAW_ENGINE=stub)     deterministic, for local/CI contract
 *                                            + isolation proofs without the heavy
 *                                            OpenClaw monorepo build.
 *   - OpenClawEngine (OPENCLAW_ENGINE=openclaw) drives the REAL bundled OpenClaw
 *                                            runtime: `agents add` to register a
 *                                            sandboxed agent, `agent-via-gateway`
 *                                            to run a turn, `agents delete` to
 *                                            deprovision. Each agent runs in its
 *                                            own OS sandbox (Docker sandbox
 *                                            backend) with per-tenant env injected.
 *
 * The adapter only ever talks to this interface, so the wire contract and the
 * isolation/cost/token-broker logic are identical regardless of engine.
 */

import type { BrokeredCredentials } from "../tools/token-broker.js";
import type { TenantScope } from "../tenant/scope.js";
import type { NormalizedAgentConfig, TurnResult } from "../types.js";

export interface ProvisionInput {
  agentId: string;
  scope: TenantScope;
  config: NormalizedAgentConfig;
}

export interface TurnInput {
  agentId: string;
  scope: TenantScope;
  config: NormalizedAgentConfig;
  message: string;
  sessionId: string;
  /** Per-tenant brokered credentials/env — injected for THIS turn only. */
  credentials: BrokeredCredentials;
}

export interface OpenClawEngineLike {
  readonly name: string;
  /** Health/readiness of the underlying runtime. */
  health(): Promise<{ ok: boolean; version?: string }>;
  /** Register a sandboxed agent. Returns when the agent is ready ("goes live"). */
  provision(input: ProvisionInput): Promise<void>;
  /** Run one turn in the agent's sandbox with injected per-tenant credentials. */
  runTurn(input: TurnInput): Promise<TurnResult>;
  /** Tear down the agent + its sandbox (deprovision on terminate). */
  deprovision(agentId: string, scope: TenantScope): Promise<void>;
}
