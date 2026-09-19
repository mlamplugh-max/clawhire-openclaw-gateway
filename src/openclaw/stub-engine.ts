/**
 * StubEngine — deterministic, dependency-free engine for local/CI proofs.
 *
 * It does NOT call any LLM. It exercises the FULL worker pipeline so we can
 * prove, without a live Fly deploy or the heavy OpenClaw monorepo build:
 *   - per-agent OS-isolated state (writes ONLY under scope.fsRoot),
 *   - per-tenant credential injection (reports injected env KEY COUNT, never values),
 *   - turn execution + token accounting,
 *   - lifecycle provision/deprovision.
 *
 * In production OPENCLAW_ENGINE=openclaw replaces this with the real runtime.
 */

import { mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { log } from "../security/logger.js";
import type { OpenClawEngineLike, ProvisionInput, TurnInput } from "./engine.js";
import type { TenantScope } from "../tenant/scope.js";
import type { TurnResult } from "../types.js";

function estTokens(text: string): number {
  return Math.max(1, Math.ceil((text || "").length / 4));
}

export class StubEngine implements OpenClawEngineLike {
  readonly name = "stub";

  async health(): Promise<{ ok: boolean; version?: string }> {
    return { ok: true, version: "stub-1" };
  }

  async provision(input: ProvisionInput): Promise<void> {
    // Create the agent's ISOLATED sandbox root and identity file. Nothing is
    // ever written outside scope.fsRoot, so no two agents/tenants share state.
    await mkdir(input.scope.fsRoot, { recursive: true });
    const identity = {
      agentId: input.agentId,
      tenantId: input.scope.tenantId,
      sandboxId: input.scope.sandboxId,
      agentName: input.config.agentName,
      roleTitle: input.config.roleTitle,
      model: input.config.model,
      createdAt: Date.now(),
    };
    await writeFile(join(input.scope.fsRoot, "identity.json"), JSON.stringify(identity, null, 2));
    await writeFile(join(input.scope.fsRoot, "system_prompt.txt"), input.config.systemPrompt || "");
    log.info("stub.provision", { agentId: input.agentId, tenantId: input.scope.tenantId, fsRoot: input.scope.fsRoot });
  }

  async runTurn(input: TurnInput): Promise<TurnResult> {
    // Append the turn to a per-agent transcript inside the isolated sandbox root.
    const transcriptPath = join(input.scope.fsRoot, "transcript.jsonl");
    let prior = "";
    try { prior = await readFile(transcriptPath, "utf8"); } catch { /* first turn */ }
    const injectedToolNames = input.credentials.tools.map((t) => t.name);
    const injectedEnvKeys = Object.keys(input.credentials.env); // KEYS only — values never touched/logged
    const reply =
      `[${input.config.agentName} | ${input.config.roleTitle}] (sandbox=${input.scope.sandboxId.slice(0, 12)}) ` +
      `processed: "${(input.message || "").slice(0, 280)}". ` +
      `tools_available=${injectedToolNames.length} tenant_creds_injected=${injectedEnvKeys.length}.`;
    const turnRecord = {
      ts: Date.now(),
      sessionId: input.sessionId,
      userMessage: input.message,
      reply,
      toolsUsed: injectedToolNames.slice(0, 8),
    };
    await writeFile(transcriptPath, prior + JSON.stringify(turnRecord) + "\n");
    const prompt = estTokens(input.message) + estTokens(input.config.systemPrompt);
    const completion = estTokens(reply);
    return {
      response: reply,
      sessionId: input.sessionId,
      tokens: { prompt, completion, total: prompt + completion },
      toolsUsed: injectedToolNames.slice(0, 8),
    };
  }

  async deprovision(agentId: string, scope: TenantScope): Promise<void> {
    // Remove ONLY this agent's isolated state.
    await rm(scope.fsRoot, { recursive: true, force: true });
    log.info("stub.deprovision", { agentId, tenantId: scope.tenantId, fsRoot: scope.fsRoot });
  }
}
