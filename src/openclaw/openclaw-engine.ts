/**
 * OpenClawEngine — drives the REAL OpenClaw runtime (openclaw@2026.6.10).
 *
 * VERIFIED against the installed CLI (`openclaw --help` / subcommand help),
 * NOT guessed:
 *   - Provision:   openclaw agents add <id> --non-interactive --model <m>
 *                    --workspace <dir> --agent-dir <dir> --json
 *   - Turn:        openclaw agent --agent <id> --message <m> --session-id <id>
 *                    --json --local --timeout <s>
 *                  (`--local` = embedded run; requires a model-provider API key
 *                   in the process env — we inject the worker's OPENROUTER key.)
 *   - Deprovision: openclaw agents delete <id> --force --json
 *   - Health:      openclaw --version
 *
 * OPTION B — non-Docker per-agent isolation (founder-locked for the Fly
 * microVM): we do NOT use `--container` / OPENCLAW_SANDBOX=docker. Each agent
 * gets its OWN isolated OpenClaw state via per-(tenant,agent) directories:
 *   HOME / OPENCLAW_HOME / OPENCLAW_STATE_DIR / OPENCLAW_CONFIG_PATH +
 *   --workspace + --agent-dir, all rooted under the tenant-scoped fsRoot.
 * The agent env starts from a MINIMAL allowlist so the worker's own secrets are
 * NOT leaked into an agent; only (a) the worker LLM key and (b) the tenant's
 * brokered short-lived OAuth creds are injected, per turn, then scrubbed.
 * Combined with the adapter's CrossTenantViolation 403 guard this enforces
 * "no cross-company data, ever". See docs/ADR-001.
 */

import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { loadConfig } from "../config.js";
import { log } from "../security/logger.js";
import type { OpenClawEngineLike, ProvisionInput, TurnInput } from "./engine.js";
import type { TenantScope } from "../tenant/scope.js";
import type { TurnResult } from "../types.js";

interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function execOpenclaw(
  bin: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
    }, opts.timeoutMs);
    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: String((err as Error)?.message || err) });
    });
  });
}

/**
 * SELF_HEALING_MCP_V1 — register the `clawhire` MCP tool proxy in this agent's isolated config.json.
 *
 * This used to run ONLY at provision. config.json is written once and never revisited, so every agent
 * created before the tool-exec settings were correct had NO ClawHire tools for the rest of its life —
 * verified in production on 2026-09-14: a container answered "NO CREATE_FILE_DELIVERABLE" and its whole
 * tool list was OpenClaw natives. Files it produced stayed in the sandbox and its memory never reached the
 * Company Brain. The ClawHire admin "Re-provision" button does not help: it returns early for an employee
 * that is already bound and never re-runs provisioning.
 *
 * So this now runs on EVERY turn as well. It MERGES into whatever config.json already holds (never
 * clobbers other keys), is idempotent, writes only when the block is actually missing or stale, and is
 * fail-open: a config error must never cost the customer their turn.
 */
export async function ensureClawhireMcpConfig(
  scope: TenantScope,
  agentId: string,
  phase: "provision" | "turn",
): Promise<void> {
  const cfg = loadConfig();
  if (!cfg.toolExecUrl || !cfg.toolExecKey) {
    if (phase === "provision") log.warn("openclaw.mcp_skipped", { agentId, reason: "toolExec not configured" });
    return;
  }
  const path = `${scope.fsRoot}/config.json`;
  const mcpPath = process.env.MCP_SERVER_PATH || "/app/mcp/clawhire-mcp.mjs";
  const desired = {
    command: "node",
    args: [mcpPath],
    env: {
      CLAWHIRE_TENANT_ID: scope.tenantId,
      CLAWHIRE_AGENT_ID: agentId,
      CLAWHIRE_TOOL_EXEC_URL: cfg.toolExecUrl,
      CLAWHIRE_TOOL_EXEC_KEY: cfg.toolExecKey,
    },
  };
  let existing: any = {};
  try {
    existing = JSON.parse(await readFile(path, "utf8"));
    if (!existing || typeof existing !== "object") existing = {};
  } catch {
    existing = {}; // no config yet, or unreadable — write a fresh one
  }
  const current = existing?.mcp?.servers?.clawhire;
  if (current && JSON.stringify(current) === JSON.stringify(desired)) return; // already correct
  const merged = {
    ...existing,
    mcp: { ...(existing.mcp || {}), servers: { ...(existing.mcp?.servers || {}), clawhire: desired } },
  };
  await writeFile(path, JSON.stringify(merged, null, 2), "utf8");
  log.info("openclaw.mcp_configured", { agentId, tenantId: scope.tenantId, mcp: "clawhire", phase, repaired: phase === "turn" });
}

export class OpenClawEngine implements OpenClawEngineLike {
  readonly name = "openclaw";

  /**
   * Build a per-agent, tenant-scoped, secret-injected environment.
   * MINIMAL base: only PATH + per-agent isolation dirs. We additionally inject:
   *   - the worker LLM provider key (OPENROUTER_API_KEY / OPENAI_API_KEY) so
   *     `agent --local` can run a model turn (this is the WORKER's own key, not
   *     tenant data); and
   *   - the tenant's brokered OAuth env (`injected`) for tool parity.
   */
  private agentEnv(scope: TenantScope, injected: Record<string, string>): NodeJS.ProcessEnv {
    const cfg = loadConfig();
    const base: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: scope.fsRoot,
      OPENCLAW_HOME: scope.fsRoot,
      OPENCLAW_STATE_DIR: scope.fsRoot,
      OPENCLAW_CONFIG_PATH: `${scope.fsRoot}/config.json`,
      // OPTION B: non-Docker per-agent isolation (NOT the docker/podman backend).
      OPENCLAW_SANDBOX: cfg.sandboxMode,
      OPENCLAW_MEMORY_NAMESPACE: scope.memoryNamespace,
      OPENCLAW_BROWSER_NAMESPACE: scope.browserNamespace,
      OPENCLAW_ARTIFACT_NAMESPACE: scope.artifactNamespace,
      // D2 AUTO-APPROVE (parity with in-process autonomy): headless, non-interactive
      // run so tool/MCP calls execute without an interactive approval prompt.
      // Isolation guards (cross-tenant 403, per-agent sandbox, server-side scope)
      // are UNCHANGED — only the interactive UX friction is removed.
      CI: "1",
      OPENCLAW_NON_INTERACTIVE: "1",
    };
    // Worker LLM provider key (authorized reuse) — enables `agent --local`.
    if (cfg.openrouterApiKey) base.OPENROUTER_API_KEY = cfg.openrouterApiKey;
    if (cfg.openaiApiKey) base.OPENAI_API_KEY = cfg.openaiApiKey;
    if (cfg.tenancyMode === "dedicated") base.OPENCLAW_TENANCY = "dedicated";
    // Tenant brokered creds last so they cannot be overridden by base.
    return { ...base, ...injected };
  }

  async health(): Promise<{ ok: boolean; version?: string }> {
    const cfg = loadConfig();
    const res = await execOpenclaw(cfg.openclawBin, ["--version"], {
      cwd: cfg.openclawHome,
      env: { PATH: process.env.PATH, HOME: cfg.openclawHome },
      timeoutMs: 8000,
    });
    return { ok: res.code === 0, version: res.stdout.trim() || undefined };
  }

  async provision(input: ProvisionInput): Promise<void> {
    const cfg = loadConfig();
    await mkdir(input.scope.fsRoot, { recursive: true });
    const env = this.agentEnv(input.scope, {});
    // D1 BRAIN PARITY: persist the ClawHire-composed brain (SECURITY block +
    // composePrompt: persona/role/skills/autonomy/tools/anti-refusal) as the
    // agent's AGENTS.md so `agent --local` adopts the SAME persona as in-process.
    // The worker never composes its own brain; ClawHire owns it.
    try {
      const brain = (input.config.systemPrompt || "").trim();
      if (brain) await writeFile(`${input.scope.fsRoot}/AGENTS.md`, brain, "utf8");
    } catch (e) {
      log.warn("openclaw.provision.agentsmd_nonfatal", { agentId: input.agentId, error: String((e as Error)?.message || e).slice(0, 160) });
    }
    // D2 TOOL-PROXY: register the `clawhire` MCP stdio server in THIS agent's
    // isolated config.json (OPENCLAW_CONFIG_PATH). It forwards every tool call
    // to ClawHire's signed, tenant-scoped /api/internal/tool-exec. Identity
    // (tenant+agent) is pinned here by the worker and re-validated server-side,
    // so the model cannot reach another tenant. Only written when configured.
    try {
      await ensureClawhireMcpConfig(input.scope, input.agentId, "provision");
    } catch (e) {
      log.warn("openclaw.provision.mcp_nonfatal", { agentId: input.agentId, error: String((e as Error)?.message || e).slice(0, 160) });
    }
    const rawModel = input.config.model || cfg.defaultModel;
    const model = rawModel.includes("/") ? rawModel : cfg.defaultModel;
    const args = [
      // FIX: register the agent AS "main" so AGENTS.md (the ClawHire persona, written to fsRoot)
      // binds to the EXACT agent runTurn serves (`agent --agent main --local`). Previously added as
      // <input.agentId> while every turn used the generic default "main" -> persona never adopted
      // ("who am I?"). Isolation preserved: each employee has its OWN HOME (fsRoot)+OWN container, so
      // "main" is unique per home (no cross-employee/tenant bleed).
      "agents", "add", "main",
      "--non-interactive",
      "--model", model,
      "--workspace", input.scope.fsRoot,
      "--agent-dir", input.scope.fsRoot,
      "--json",
    ];
    // BIND-BEFORE-SERVE bootstrap: `agents add` initializes the isolated HOME with a
    // default "main" agent AND binds AGENTS.md (the ClawHire-composed persona). On a
    // FRESH per-account microVM HOME this first-init is slow; with too short a timeout
    // it DEFERS and the turn path then self-bootstraps a GENERIC "main" agent that has
    // NOT adopted AGENTS.md (boots asking "who am I?"). Give it enough time (110s) to
    // normally COMPLETE so the agent boots AS the trained employee. The non-zero/null
    // (timeout) result below stays NON-FATAL as a safety net (turn still self-bootstraps).
    const res = await execOpenclaw(cfg.openclawBin, args, { cwd: input.scope.fsRoot, env, timeoutMs: 110000 });
    if (res.code !== 0) {
      log.warn("openclaw.provision.bootstrap_nonfatal", { agentId: input.agentId, code: res.code, stderr: res.stderr.slice(0, 200) });
    }
    // HOME prepared (mkdir above) -> agent is provisioned; turn self-bootstraps.
    log.info("openclaw.provision.ok", { agentId: input.agentId, tenantId: input.scope.tenantId, bootstrap: res.code === 0 ? "add" : "deferred" });
  }

  async runTurn(input: TurnInput): Promise<TurnResult> {
    const cfg = loadConfig();
    const env = this.agentEnv(input.scope, input.credentials.env);
    // SELF_HEALING_MCP_V1: agents provisioned before the tool-exec settings were correct have no ClawHire
    // tools and nothing ever rewrites their config. Repair it here, on every turn — idempotent, merges,
    // and fail-open so a config problem can never cost the customer their turn.
    try {
      await ensureClawhireMcpConfig(input.scope, input.agentId, "turn");
    } catch (e) {
      log.warn("openclaw.turn.mcp_repair_nonfatal", { agentId: input.agentId, error: String((e as Error)?.message || e).slice(0, 160) });
    }
    try {
      // In openclaw@2026.6.10, each isolated OPENCLAW_HOME hosts a default
      // "main" agent. We achieve per-agent isolation by giving every
      // (tenant,agent) its OWN home (scope.fsRoot) and running the turn against
      // that home's main session — NOT by sharing one home across agents.
      // D1 MEMORY PARITY: prepend the per-turn recalled memory (THREAD->EMPLOYEE
      // ->COMPANY->ROLE->INDUSTRY) composed by ClawHire (tenant+agent scoped) as
      // a framed block, exactly like the in-process runtime injects recall.
      // PERSONA-EVERY-TURN (CLAWHIRE_PERSONA_TURN_V1) — ROOT-CAUSE FIX for the
      // "who am I?" generic-boot problem. openclaw `agent --agent main --local`
      // does NOT reliably adopt the persisted AGENTS.md as its SYSTEM identity on a
      // FRESH per-account home (it runs its own interactive identity bootstrap),
      // so relying on `agents add` + AGENTS.md alone left the container booting as a
      // blank assistant. FIX: deterministically inject the ClawHire-composed brain
      // (input.config.systemPrompt = SECURITY block + persona/identity/role/company
      // knowledge/skills/autonomy/tools/anti-refusal) as a framed SYSTEM PREAMBLE on
      // EVERY turn — exactly how the proven in-process runtime works. The agent now
      // boots AS the trained employee regardless of openclaw's bootstrap timing.
      const brain = (input.config.systemPrompt || "").trim();
      const recall = (input.config.memoryContext || "").trim();
      const sections: string[] = [];
      if (brain) {
        sections.push(`# SYSTEM — YOU ARE THIS EMPLOYEE (embody fully; this is your identity and operating contract)
${brain}`);
      }
      if (recall) {
        sections.push(`# RECALLED CONTEXT (use silently; do not quote verbatim)
${recall}`);
      }
      sections.push(`# CURRENT MESSAGE
${input.message}`);
      const turnMessage = sections.join("\n\n");
      const args = [
        "agent",
        "--agent", "main",
        "--message", turnMessage,
        "--session-id", input.sessionId,
        "--local",
        "--json",
        // LONG_TURNS_V1: env-driven turn budget (was a hard 110s). The process kill sits 15s
        // past the CLI's own --timeout so openclaw gets to emit its JSON before we SIGKILL.
        "--timeout", String(cfg.turnTimeoutSec),
      ];
      const res = await execOpenclaw(cfg.openclawBin, args, { cwd: input.scope.fsRoot, env, timeoutMs: (cfg.turnTimeoutSec + 15) * 1000 });
      if (res.code !== 0) {
        log.error("openclaw.turn.failed", { agentId: input.agentId, code: res.code, stderr: res.stderr.slice(0, 400) });
        throw new Error(`openclaw turn failed (code ${res.code})`);
      }
      const parsed = this.parseTurn(res.stdout, input.sessionId);
      return { ...parsed, toolsUsed: parsed.toolsUsed.length ? parsed.toolsUsed : input.credentials.tools.map((t) => t.name).slice(0, 8) };
    } finally {
      // Scrub injected tenant credentials from memory after the turn.
      input.credentials.scrub();
    }
  }

  private parseTurn(stdout: string, sessionId: string): TurnResult {
    // openclaw@2026.6.10 emits a SINGLE multi-line pretty-printed JSON object
    // (often followed/preceded by plain log lines like "[agent] run ... ended").
    // Primary: extract the outermost {...} span and parse it. Fallback: JSONL
    // (one object per line) for forward-compat with streaming output.
    let obj: Record<string, unknown> | null = null;
    const first = stdout.indexOf("{");
    const last = stdout.lastIndexOf("}");
    if (first >= 0 && last > first) {
      try { obj = JSON.parse(stdout.slice(first, last + 1)) as Record<string, unknown>; } catch { /* fall through */ }
    }
    if (!obj) {
      const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      for (let i = lines.length - 1; i >= 0; i--) {
        try { obj = JSON.parse(lines[i]) as Record<string, unknown>; break; } catch { /* keep scanning */ }
      }
    }
    // openclaw@2026.6.10 envelope: clean assistant text lives in
    // meta.finalAssistantVisibleText (or payloads[].text); token usage in
    // meta.agentMeta.usage. Fall back to flatter shapes for forward-compat.
    const meta = (obj?.meta as Record<string, unknown>) || {};
    const agentMeta = (meta.agentMeta as Record<string, unknown>) || {};
    const payloads = (obj?.payloads as Array<{ text?: string }>) || [];
    const payloadText = payloads.map((pl) => (pl?.text || "")).filter(Boolean).join("\n").trim();
    const response = String(
      (meta.finalAssistantVisibleText as string) ||
        (meta.finalAssistantRawText as string) ||
        payloadText ||
        (obj?.response as string) || (obj?.message as string) || (obj?.text as string) || (obj?.content as string) ||
        "",
    ).trim();
    const usage = (agentMeta.usage as { input?: number; output?: number; total?: number }) || {};
    const t = (obj?.tokens as { prompt?: number; completion?: number; total?: number }) || {};
    const prompt = Number(usage.input ?? t.prompt ?? (obj?.prompt_tokens as number) ?? 0);
    const completion = Number(usage.output ?? t.completion ?? (obj?.completion_tokens as number) ?? (obj?.tokens_used as number) ?? 0);
    const total = Number(usage.total ?? t.total ?? (obj?.total_tokens as number) ?? prompt + completion);
    const toolsUsed = Array.isArray(obj?.tools_used)
      ? (obj!.tools_used as string[])
      : Array.isArray((obj as { toolsUsed?: string[] })?.toolsUsed)
        ? ((obj as { toolsUsed?: string[] }).toolsUsed as string[])
        : [];
    return {
      response,
      sessionId: String((obj?.session_id as string) || (obj?.sessionId as string) || (agentMeta.sessionId as string) || sessionId),
      tokens: { prompt, completion, total },
      toolsUsed,
    };
  }

  async deprovision(agentId: string, scope: TenantScope): Promise<void> {
    const cfg = loadConfig();
    const env = this.agentEnv(scope, {});
    const res = await execOpenclaw(cfg.openclawBin, ["agents", "delete", agentId, "--force", "--json"], {
      cwd: scope.fsRoot,
      env,
      timeoutMs: 30000,
    });
    if (res.code !== 0) {
      log.warn("openclaw.deprovision.cli_nonzero", { agentId, code: res.code });
    }
    // Remove the agent's isolated state regardless.
    await rm(scope.fsRoot, { recursive: true, force: true });
    log.info("openclaw.deprovision.ok", { agentId, tenantId: scope.tenantId });
  }
}
