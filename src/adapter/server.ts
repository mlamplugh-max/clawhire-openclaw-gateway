/**
 * Adapter HTTP server — implements the frozen /agents/* contract spoken by
 * clawhire/server/openclaw-bridge.ts, translating it to the OpenClaw engine.
 *
 * Every route is auth-gated with the worker's OWN dedicated key. Session/turn
 * creation passes through the cost-cap guardrail and the per-tenant OAuth token
 * broker. Cross-tenant access is structurally denied.
 */

import express, { type NextFunction, type Request, type Response } from "express";
import { loadConfig } from "../config.js";
import { log } from "../security/logger.js";
import * as browserBox from "../browser/browser-box.js";
import { registry } from "./registry.js";
import { getEngine } from "../openclaw/index.js";
import { deriveScope, assertTenantOwnsAgent, CrossTenantViolation } from "../tenant/scope.js";
import { brokerCredentials } from "../tools/token-broker.js";
import { costTracker } from "../telemetry/cost.js";
import type { CreateAgentBody, NormalizedAgentConfig } from "../types.js";

function pick<T>(...vals: (T | undefined | null)[]): T | undefined {
  for (const v of vals) if (v !== undefined && v !== null) return v as T;
  return undefined;
}

function normalizeCreate(body: CreateAgentBody): { tenantId: string; config: NormalizedAgentConfig } | null {
  const tenantId = pick(body.tenant_id, body.tenantId);
  const agentName = pick(body.agent_name, body.agentName);
  const roleTitle = pick(body.role_title, body.roleTitle);
  if (!tenantId || !agentName || !roleTitle) return null;
  return {
    tenantId,
    config: {
      tenantId,
      employeeId: pick(body.employee_id, body.employeeId) || undefined,
      agentName,
      roleTitle,
      systemPrompt: pick(body.system_prompt, body.systemPrompt) || "",
      skills: Array.isArray(body.skills) ? body.skills : [],
      memoryContext: pick(body.memory_context, body.memoryContext) || "",
      // Normalize the model id: the ClawHire bridge defaults to "gpt-4o-mini",
      // which does NOT exist in OpenClaw's catalog. Any id without a provider
      // prefix ("<provider>/<model>") is replaced with the worker default so a
      // turn never fails on an unknown model.
      model: (() => { const m = pick(body.model); return m && m.includes("/") ? m : "openai/gpt-5.4-mini"; })(),
      metadata: (body.metadata as Record<string, unknown>) || {},
    },
  };
}

export function buildApp() {
  const cfg = loadConfig();
  const engine = getEngine();
  const app = express();
  app.use(express.json({ limit: "2mb" }));

  // ---- Auth middleware (skips /health) ----
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.path === "/health") return next();
    if (!cfg.apiKey) {
      // No key configured -> refuse everything except health (fail-closed in prod).
      return res.status(503).json({ error: "worker_unconfigured" });
    }
    const auth = req.header("authorization") || "";
    const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
    const xkey = req.header("x-api-key") || "";
    if (bearer !== cfg.apiKey && xkey !== cfg.apiKey) {
      return res.status(401).json({ error: "unauthorized" });
    }
    next();
  });

  // ---- GET /health ----
  app.get("/health", async (_req, res) => {
    const h = await engine.health().catch(() => ({ ok: false }));
    res.json({
      status: h.ok ? "ok" : "degraded",
      version: "clawhire-openclaw-gateway/2.0.0",
      engine: engine.name,
      agents: registry.count(),
      cost: costTracker.snapshot(),
    });
  });

  // ---- POST /agents (provision) ----
  app.post("/agents", async (req, res) => {
    const norm = normalizeCreate(req.body as CreateAgentBody);
    if (!norm) return res.status(400).json({ error: "missing tenant_id/agent_name/role_title" });

    // Cost guardrail: refuse NEW agents if projected spend exceeds the cap.
    if (costTracker.isOverCap()) {
      log.warn("cost.cap.block_provision", costTracker.snapshot());
      return res.status(429).json({ error: "cost_cap_reached", cost: costTracker.snapshot() });
    }

    const record = registry.create(norm.tenantId, norm.config);
    const scope = deriveScope(cfg.dataRoot, norm.tenantId, record.agentId);
    try {
      await engine.provision({ agentId: record.agentId, scope, config: norm.config });
      registry.setStatus(record.agentId, "online", null); // "goes live when ready"
      log.info("agent.provisioned", { agentId: record.agentId, tenantId: norm.tenantId, status: "online" });
      return res.json({ agentId: record.agentId, status: "online" });
    } catch (err) {
      registry.setStatus(record.agentId, "error", (err as Error)?.message || "provision_failed");
      log.error("agent.provision_failed", { agentId: record.agentId, error: (err as Error)?.message });
      // Still return the id so the bridge can deprovision; status reflects error.
      return res.status(502).json({ agentId: record.agentId, status: "error", error: "provision_failed" });
    }
  });

  // ---- POST /agents/:id/messages (turn) ----
  app.post("/agents/:id/messages", async (req, res) => {
    const agentId = req.params.id;
    const record = registry.get(agentId);
    if (!record) return res.status(404).json({ error: "agent_not_found" });

    // Cross-tenant guard: if the caller embeds a tenant id, it must match.
    const claimedTenant = pick<string>((req.body?.tenant_id as string), (req.body?.tenantId as string));
    try {
      assertTenantOwnsAgent(record, claimedTenant);
    } catch (e) {
      if (e instanceof CrossTenantViolation) return res.status(403).json({ error: "cross_tenant_denied" });
      throw e;
    }

    if (costTracker.isOverCap()) {
      log.warn("cost.cap.block_turn", costTracker.snapshot());
      return res.status(429).json({ error: "cost_cap_reached", cost: costTracker.snapshot() });
    }

    const message = String(req.body?.message || "");
    const sessionId = String(pick(req.body?.session_id, req.body?.sessionId) || `sess_${Date.now()}`);
    const scope = deriveScope(cfg.dataRoot, record.tenantId, agentId);
    const config: NormalizedAgentConfig = {
      tenantId: record.tenantId,
      employeeId: record.employeeId,
      agentName: record.agentName,
      roleTitle: record.roleTitle,
      systemPrompt: record.systemPrompt,
      skills: record.skills,
      memoryContext: record.memoryContext,
      model: record.model,
      metadata: {},
    };

    // TOOL PARITY: broker per-tenant OAuth creds for THIS turn only.
    const credentials = await brokerCredentials(record.tenantId, agentId, record.skills);
    try {
      const result = await engine.runTurn({ agentId, scope, config, message, sessionId, credentials });
      costTracker.recordTokens(result.tokens.total);
      registry.recordTurn(agentId, result.tokens.total);
      return res.json({
        response: result.response,
        session_id: result.sessionId,
        sessionId: result.sessionId,
        tokens: result.tokens,
        tools_used: result.toolsUsed,
        toolsUsed: result.toolsUsed,
      });
    } catch (err) {
      registry.setStatus(agentId, "error", (err as Error)?.message || "turn_failed");
      log.error("agent.turn_failed", { agentId, error: (err as Error)?.message });
      // 502 -> bridge treats as gateway error and falls back to in-process.
      return res.status(502).json({ error: "turn_failed" });
    } finally {
      credentials.scrub();
    }
  });

  // ---- GET /agents/:id/status ----
  app.get("/agents/:id/status", (req, res) => {
    const record = registry.get(req.params.id);
    if (!record) return res.status(404).json({ error: "agent_not_found" });
    const statusMap = { provisioning: "provisioning", online: "online", offline: "offline", error: "error" } as const;
    res.json({
      agent_id: record.agentId,
      agentId: record.agentId,
      status: statusMap[record.status],
      uptime: Math.round((Date.now() - record.createdAt) / 1000),
      last_active: new Date(record.lastActiveAt).toISOString(),
      memory_usage_mb: 0,
      active_session_count: record.sessionCount,
    });
  });

  // ---- PATCH /agents/:id (update) ----
  app.patch("/agents/:id", (req, res) => {
    const record = registry.get(req.params.id);
    if (!record) return res.status(404).json({ error: "agent_not_found" });
    registry.update(req.params.id, {
      systemPrompt: pick(req.body?.system_prompt, req.body?.systemPrompt),
      skills: Array.isArray(req.body?.skills) ? req.body.skills : undefined,
      memoryContext: pick(req.body?.memory_context, req.body?.memoryContext),
      model: pick(req.body?.model),
    });
    res.status(204).end();
  });

  // ---- DELETE /agents/:id (deprovision) ----
  app.delete("/agents/:id", async (req, res) => {
    const record = registry.get(req.params.id);
    if (!record) return res.status(204).end(); // idempotent
    const scope = deriveScope(cfg.dataRoot, record.tenantId, record.agentId);
    try {
      await engine.deprovision(record.agentId, scope);
    } catch (err) {
      log.warn("agent.deprovision_warn", { agentId: record.agentId, error: (err as Error)?.message });
    }
    registry.delete(record.agentId);
    res.status(204).end();
  });

  // ---- POST /agents/:id/skills ----
  app.post("/agents/:id/skills", (req, res) => {
    const record = registry.get(req.params.id);
    if (!record) return res.status(404).json({ error: "agent_not_found" });
    const slug = String(pick(req.body?.skill_slug, req.body?.skillSlug) || "");
    if (slug && !record.skills.includes(slug)) {
      registry.update(record.agentId, { skills: [...record.skills, slug] });
    }
    res.status(204).end();
  });

  // ---- POST /agents/:id/integrations ----
  app.post("/agents/:id/integrations", (req, res) => {
    const record = registry.get(req.params.id);
    if (!record) return res.status(404).json({ error: "agent_not_found" });
    const slug = String(pick(req.body?.integration_slug, req.body?.integrationSlug) || "integration");
    // The actual connection is brokered at turn time; we return a deterministic handle.
    res.json({ connectionId: `conn_${record.agentId}_${slug}` });
  });

  // ---- GET /agents/:id/tools (parity manifest) ----
  app.get("/agents/:id/tools", async (req, res) => {
    const record = registry.get(req.params.id);
    if (!record) return res.status(404).json({ error: "agent_not_found" });
    const creds = await brokerCredentials(record.tenantId, record.agentId, record.skills);
    try {
      res.json({ tools: creds.tools });
    } finally {
      creds.scrub();
    }
  });

  // ---- BROWSER_BOX_V1: the company's own browser in this container ----
  app.get("/browser/sessions", (_req, res) => {
    res.json({ available: browserBox.chromiumAvailable(), sessions: browserBox.listSessions() });
  });
  app.post("/browser/sessions", async (req, res) => {
    const profileId = String(req.body?.profileId || req.body?.workspaceId || "");
    if (!profileId) return res.status(400).json({ error: "profileId_required" });
    try {
      const sess = await browserBox.createSession({ profileId, startUrl: pick<string>(req.body?.startUrl as string, req.body?.url as string), width: Number(req.body?.width) || undefined, height: Number(req.body?.height) || undefined });
      res.status(201).json({ session: sess, cdpPath: `/browser/sessions/${sess.id}/cdp` });
    } catch (e) {
      const code = (e as any)?.code || "browser_start_failed";
      log.error("browser.box.create_failed", { profileId, error: (e as Error)?.message });
      res.status(code === "chromium_missing" ? 503 : 500).json({ error: code, message: (e as Error)?.message });
    }
  });
  app.get("/browser/sessions/:id", (req, res) => {
    const s = browserBox.getSession(req.params.id);
    if (!s) return res.status(404).json({ error: "session_not_found" });
    const { proc: _p, ...rest } = s;
    res.json({ session: rest });
  });
  app.delete("/browser/sessions/:id", async (req, res) => {
    const ok = await browserBox.closeSession(req.params.id);
    res.json({ closed: ok });
  });

  // ---- GET /agents (admin list) ----
  app.get("/agents", (_req, res) => {
    res.json({ agents: registry.list() });
  });

  // ---- error fallback ----
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    log.error("unhandled", { error: err?.message });
    res.status(500).json({ error: "internal_error" });
  });

  return app;
}
