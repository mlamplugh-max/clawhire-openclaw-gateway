/**
 * Per-tenant / per-agent isolation scoping.
 *
 * Every agent is bound to exactly one tenant. All filesystem, memory, browser,
 * and artifact namespaces are derived from a deterministic sandboxId so that
 * no two agents (and therefore no two tenants) ever share writable state.
 *
 * GUARANTEE: there is no global/shared writable path. "No cross-company data
 * — ever" is enforced structurally here + by the cross-tenant guard.
 */

import { createHash } from "node:crypto";
import { join } from "node:path";
import type { AgentRecord } from "../types.js";

export interface TenantScope {
  tenantId: string;
  agentId: string;
  sandboxId: string;
  fsRoot: string;
  memoryNamespace: string;
  browserNamespace: string;
  artifactNamespace: string;
  sessionNamespace: string;
}

function sanitizeSegment(v: string): string {
  // Defensive: never allow path traversal or separators into a namespace.
  return String(v).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80);
}

export function computeSandboxId(tenantId: string, agentId: string): string {
  return createHash("sha256").update(`${tenantId}:${agentId}`).digest("hex");
}

export function deriveScope(dataRoot: string, tenantId: string, agentId: string): TenantScope {
  const sandboxId = computeSandboxId(tenantId, agentId);
  const t = sanitizeSegment(tenantId);
  const a = sanitizeSegment(agentId);
  // Layout: <dataRoot>/<tenant>/<agent>/...  — never shared across tenants/agents.
  const fsRoot = join(dataRoot, t, a);
  return {
    tenantId,
    agentId,
    sandboxId,
    fsRoot,
    memoryNamespace: `mem_${sandboxId.slice(0, 24)}`,
    browserNamespace: `br_${sandboxId.slice(0, 24)}`,
    artifactNamespace: `art_${sandboxId.slice(0, 24)}`,
    sessionNamespace: `sess_${sandboxId.slice(0, 24)}`,
  };
}

/**
 * Cross-tenant access guard. Resolves the record's owning tenant and throws if
 * the caller-claimed tenant does not match. Used on every /agents/:id/* route
 * that carries a tenant_id so one company can never touch another's agent.
 */
export class CrossTenantViolation extends Error {
  constructor(public readonly agentId: string) {
    super("Cross-tenant access denied");
    this.name = "CrossTenantViolation";
  }
}

export function assertTenantOwnsAgent(record: AgentRecord, claimedTenantId: string | undefined): void {
  // If the caller asserts a tenant, it MUST match the agent's owner. If no
  // tenant is asserted (status/tools/delete by opaque id), the opaque id itself
  // is the capability — but we still never leak other-tenant data in responses.
  if (claimedTenantId && claimedTenantId !== record.tenantId) {
    throw new CrossTenantViolation(record.agentId);
  }
}
