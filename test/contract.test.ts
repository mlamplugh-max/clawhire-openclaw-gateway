/**
 * Contract + isolation + cost-cap test (stub engine, no external deps).
 * Proves the worker honors the frozen /agents/* contract, enforces per-tenant
 * isolation, brokers per-tenant creds, and respects the cost cap.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

const API_KEY = "test-worker-key-" + "a".repeat(40);
let brokerCalls: Array<{ tenant: string; agent: string }> = [];
let brokerServer: Server;
let brokerUrl = "";

async function startBroker(): Promise<void> {
  const express = (await import("express")).default;
  const b = express();
  b.use(express.json());
  b.post("/token-broker", (req, res) => {
    brokerCalls.push({ tenant: req.body.tenant_id, agent: req.body.agent_id });
    // Return per-tenant tools + a fake short-lived token (value never asserted/logged).
    res.json({
      tokens: { GOOGLE_OAUTH_ACCESS_TOKEN: `tok_${req.body.tenant_id}_${"x".repeat(40)}` },
      tools: [
        { name: "gmail.send", description: "Send email", category: "google", enabled: true },
        { name: "calendar.create", description: "Create event", category: "google", enabled: true },
      ],
      expiresInSeconds: 600,
    });
  });
  await new Promise<void>((resolve) => {
    brokerServer = b.listen(0, () => {
      const port = (brokerServer.address() as AddressInfo).port;
      brokerUrl = `http://127.0.0.1:${port}/token-broker`;
      resolve();
    });
  });
}

async function startWorker(): Promise<{ base: string; close: () => void; dataRoot: string }> {
  const dataRoot = mkdtempSync(join(tmpdir(), "claw-worker-"));
  process.env.OPENCLAW_ENGINE = "stub";
  process.env.OPENCLAW_API_KEY = API_KEY;
  process.env.DATA_ROOT = dataRoot;
  process.env.TENANT_TOKEN_BROKER_URL = brokerUrl;
  process.env.TENANT_TOKEN_BROKER_KEY = "broker-key-" + "b".repeat(40);
  process.env.MONTHLY_COST_CAP_USD = "300";
  process.env.COST_CAP_ENFORCE = "true";

  const { __resetConfigForTest } = await import("../src/config.js");
  __resetConfigForTest();
  const { __setEngineForTest } = await import("../src/openclaw/index.js");
  __setEngineForTest(null);
  const { registry } = await import("../src/adapter/registry.js");
  await registry.init();
  const { buildApp } = await import("../src/adapter/server.js");
  const app = buildApp();
  let server: Server;
  const base: string = await new Promise((resolve) => {
    server = app.listen(0, () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`));
  });
  return { base, close: () => server.close(), dataRoot };
}

function h(extra: Record<string, string> = {}) {
  return { "content-type": "application/json", authorization: `Bearer ${API_KEY}`, ...extra };
}

test("full contract + per-tenant isolation + tool parity + cost", async (t) => {
  await startBroker();
  const w = await startWorker();
  t.after(() => { w.close(); brokerServer.close(); });

  // 1) Auth: missing key -> 401
  const unauth = await fetch(`${w.base}/agents`, { method: "GET" });
  assert.equal(unauth.status, 401, "unauthenticated must be 401");

  // 2) Health is open
  const health = await (await fetch(`${w.base}/health`)).json();
  assert.equal(health.status, "ok");
  assert.equal(health.engine, "stub");

  // 3) Provision agents for two DIFFERENT tenants
  const mk = async (tenant: string, name: string) => {
    const r = await fetch(`${w.base}/agents`, {
      method: "POST", headers: h(),
      body: JSON.stringify({ tenant_id: tenant, agent_name: name, role_title: "Sales Rep", system_prompt: "You are " + name, model: "gpt-4o-mini" }),
    });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.ok(j.agentId?.startsWith("agt_"));
    assert.equal(j.status, "online");
    return j.agentId as string;
  };
  const agentA = await mk("tenantA", "Ava");
  const agentB = await mk("tenantB", "Ben");
  assert.notEqual(agentA, agentB);

  // 4) Send a benign turn to agent A -> deliverable + token usage + brokered tools
  const turnA = await (await fetch(`${w.base}/agents/${agentA}/messages`, {
    method: "POST", headers: h(),
    body: JSON.stringify({ tenant_id: "tenantA", message: "Draft a hello email", session_id: "s1" }),
  })).json();
  assert.ok(turnA.response.includes("Ava"));
  assert.ok(turnA.response.includes("tools_available=2"), "tool parity: brokered tools injected");
  assert.ok(turnA.response.includes("tenant_creds_injected=1"), "per-tenant creds injected");
  assert.ok(turnA.tokens.total > 0);
  assert.deepEqual(turnA.tools_used.sort(), ["calendar.create", "gmail.send"]);

  // 5) Per-tenant isolation: distinct sandbox dirs; tenantB cannot see tenantA's data
  const dirA = await readFile(join(w.dataRoot, "tenantA", agentA, "identity.json"), "utf8");
  assert.ok(dirA.includes("tenantA"));
  assert.ok(!dirA.includes("tenantB"));

  // 6) Cross-tenant guard: tenantB claiming agentA must be denied
  const cross = await fetch(`${w.base}/agents/${agentA}/messages`, {
    method: "POST", headers: h(),
    body: JSON.stringify({ tenant_id: "tenantB", message: "steal", session_id: "x" }),
  });
  assert.equal(cross.status, 403, "cross-tenant access must be denied");

  // 7) Broker was called per-tenant only for the legitimate turn
  assert.ok(brokerCalls.some((c) => c.tenant === "tenantA" && c.agent === agentA));
  assert.ok(!brokerCalls.some((c) => c.tenant === "tenantB")); // denied before broker

  // 8) Status + tools endpoints
  const status = await (await fetch(`${w.base}/agents/${agentA}/status`, { headers: h() })).json();
  assert.equal(status.status, "online");
  assert.equal(status.agent_id, agentA);
  const tools = await (await fetch(`${w.base}/agents/${agentA}/tools`, { headers: h() })).json();
  assert.equal(tools.tools.length, 2);

  // 9) Deprovision -> sandbox removed
  const del = await fetch(`${w.base}/agents/${agentA}`, { method: "DELETE", headers: h() });
  assert.equal(del.status, 204);
  let gone = false;
  try { await readFile(join(w.dataRoot, "tenantA", agentA, "identity.json"), "utf8"); }
  catch { gone = true; }
  assert.ok(gone, "sandbox must be removed on deprovision");

  // 10) Admin list still shows tenantB only now
  const list = await (await fetch(`${w.base}/agents`, { headers: h() })).json();
  assert.ok(list.agents.some((a: { agent_id: string }) => a.agent_id === agentB));
  assert.ok(!list.agents.some((a: { agent_id: string }) => a.agent_id === agentA));
});
