/**
 * AgentRegistry — durable per-agent record store.
 *
 * - Generates opaque agentIds (the capability handle the bridge persists).
 * - Each record is owned by exactly ONE tenant; lookups never leak across tenants.
 * - Persisted to <DATA_ROOT>/_registry.json so agents survive worker restarts
 *   (Fly auto start/stop). No tenant SECRETS are ever stored here — only config
 *   metadata + counters.
 */

import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { loadConfig } from "../config.js";
import { log } from "../security/logger.js";
import { computeSandboxId } from "../tenant/scope.js";
import type { AgentRecord, AgentStatus, NormalizedAgentConfig } from "../types.js";

export class AgentRegistry {
  private records = new Map<string, AgentRecord>();
  private readonly file: string;
  private loaded = false;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor() {
    this.file = join(loadConfig().dataRoot, "_registry.json");
  }

  async init(): Promise<void> {
    if (this.loaded) return;
    try {
      const raw = await readFile(this.file, "utf8");
      const arr = JSON.parse(raw) as AgentRecord[];
      for (const r of arr) this.records.set(r.agentId, r);
      log.info("registry.loaded", { count: this.records.size });
    } catch {
      log.info("registry.fresh", {});
    }
    this.loaded = true;
  }

  private persist(): void {
    const snapshot = Array.from(this.records.values());
    this.writeQueue = this.writeQueue.then(async () => {
      await mkdir(dirname(this.file), { recursive: true });
      await writeFile(this.file, JSON.stringify(snapshot, null, 2));
    }).catch((e) => log.error("registry.persist.failed", { error: (e as Error)?.message }));
  }

  create(tenantId: string, config: NormalizedAgentConfig): AgentRecord {
    const agentId = `agt_${randomBytes(12).toString("hex")}`;
    const now = Date.now();
    const record: AgentRecord = {
      agentId,
      tenantId,
      employeeId: config.employeeId,
      agentName: config.agentName,
      roleTitle: config.roleTitle,
      model: config.model,
      sandboxId: computeSandboxId(tenantId, agentId),
      status: "provisioning",
      systemPrompt: config.systemPrompt,
      skills: config.skills,
      memoryContext: config.memoryContext,
      createdAt: now,
      lastActiveAt: now,
      sessionCount: 0,
      totalTokens: 0,
      lastError: null,
    };
    this.records.set(agentId, record);
    this.persist();
    return record;
  }

  get(agentId: string): AgentRecord | undefined {
    return this.records.get(agentId);
  }

  setStatus(agentId: string, status: AgentStatus, error?: string | null): void {
    const r = this.records.get(agentId);
    if (!r) return;
    r.status = status;
    if (error !== undefined) r.lastError = error;
    r.lastActiveAt = Date.now();
    this.persist();
  }

  recordTurn(agentId: string, tokens: number): void {
    const r = this.records.get(agentId);
    if (!r) return;
    r.sessionCount += 1;
    r.totalTokens += Math.max(0, tokens || 0);
    r.lastActiveAt = Date.now();
    this.persist();
  }

  update(agentId: string, patch: Partial<Pick<AgentRecord, "systemPrompt" | "skills" | "memoryContext" | "model">>): void {
    const r = this.records.get(agentId);
    if (!r) return;
    if (patch.systemPrompt !== undefined) r.systemPrompt = patch.systemPrompt;
    if (patch.skills !== undefined) r.skills = patch.skills;
    if (patch.memoryContext !== undefined) r.memoryContext = patch.memoryContext;
    if (patch.model !== undefined) r.model = patch.model;
    this.persist();
  }

  delete(agentId: string): void {
    this.records.delete(agentId);
    this.persist();
  }

  count(): number {
    return this.records.size;
  }

  /** Admin list — returns minimal triplets only. */
  list(): Array<{ agent_id: string; tenant_id: string; status: AgentStatus }> {
    return Array.from(this.records.values()).map((r) => ({
      agent_id: r.agentId,
      tenant_id: r.tenantId,
      status: r.status,
    }));
  }
}

export const registry = new AgentRegistry();
