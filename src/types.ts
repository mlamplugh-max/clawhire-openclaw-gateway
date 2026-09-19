/** Shared types for the ClawHire OpenClaw Gateway worker. */

/** Inbound POST /agents body (bridge sends snake+camel; we accept both). */
export interface CreateAgentBody {
  tenant_id?: string;
  tenantId?: string;
  employee_id?: string;
  employeeId?: string;
  agent_name?: string;
  agentName?: string;
  role_title?: string;
  roleTitle?: string;
  system_prompt?: string;
  systemPrompt?: string;
  skills?: string[];
  memory_context?: string;
  memoryContext?: string;
  model?: string;
  worker_identity?: string | null;
  workerIdentity?: string | null;
  runtime_instance_id?: string | null;
  runtimeInstanceId?: string | null;
  memory_namespace?: string | null;
  memoryNamespace?: string | null;
  browser_namespace?: string | null;
  browserNamespace?: string | null;
  artifact_namespace?: string | null;
  artifactNamespace?: string | null;
  task_scope?: string | null;
  taskScope?: string | null;
  metadata?: Record<string, unknown>;
}

/** Normalized agent config after parsing the inbound body. */
export interface NormalizedAgentConfig {
  tenantId: string;
  employeeId?: string;
  agentName: string;
  roleTitle: string;
  systemPrompt: string;
  skills: string[];
  memoryContext: string;
  model: string;
  metadata: Record<string, unknown>;
}

export type AgentStatus = "provisioning" | "online" | "offline" | "error";

/** Persistent per-agent record. Keyed by opaque agentId, owned by exactly one tenant. */
export interface AgentRecord {
  agentId: string;
  tenantId: string;
  employeeId?: string;
  agentName: string;
  roleTitle: string;
  model: string;
  /** sha256(tenantId:agentId) — the isolation root for fs/memory/browser/artifacts. */
  sandboxId: string;
  status: AgentStatus;
  systemPrompt: string;
  skills: string[];
  memoryContext: string;
  createdAt: number;
  lastActiveAt: number;
  sessionCount: number;
  totalTokens: number;
  lastError?: string | null;
}

/** Engine turn result. */
export interface TurnResult {
  response: string;
  sessionId: string;
  tokens: { prompt: number; completion: number; total: number };
  toolsUsed: string[];
}

/** A tool descriptor exposed via GET /agents/:id/tools. */
export interface ToolDescriptor {
  name: string;
  description: string;
  category: string;
  enabled: boolean;
}
