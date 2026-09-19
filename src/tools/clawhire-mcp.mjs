#!/usr/bin/env node
/**
 * clawhire-mcp.mjs — D2 Tool-Proxy (MCP stdio server)
 *
 * Runs INSIDE the per-(tenant,agent) OpenClaw sandbox. Exposes the tenant's
 * ClawHire tool registry to the OpenClaw agent and forwards every tool call to
 * ClawHire's signed, per-tenant-scoped `/api/internal/tool-exec` endpoint. The
 * actual tool executors (Google, HubSpot/CRM, deliverables, search_web,
 * scheduler, SMS/voice, etc.) run IN ClawHire with the tenant's credentials —
 * this worker process holds ZERO tenant secrets.
 *
 * Transport: JSON-RPC 2.0 over stdio with LSP-style Content-Length framing
 * (the MCP stdio transport). Implemented dependency-free.
 *
 * Identity is pinned by the parent (OpenClaw) via env and CANNOT be chosen by
 * the model: CLAWHIRE_TENANT_ID / CLAWHIRE_AGENT_ID. ClawHire re-validates the
 * (tenant, agent) pair against the allowlisted instance server-side, so even a
 * compromised turn cannot reach another tenant.
 */

const TENANT_ID = process.env.CLAWHIRE_TENANT_ID || "";
const AGENT_ID = process.env.CLAWHIRE_AGENT_ID || "";
const TOOL_EXEC_URL = process.env.CLAWHIRE_TOOL_EXEC_URL || "";
const TOOL_EXEC_KEY = process.env.CLAWHIRE_TOOL_EXEC_KEY || "";
const PROTOCOL_VERSION = "2024-11-05";

function stderr(msg) {
  // Never log secrets. Diagnostic breadcrumbs only.
  try { process.stderr.write(`[clawhire-mcp] ${msg}\n`); } catch { /* ignore */ }
}

async function callToolExec(payload) {
  if (!TOOL_EXEC_URL || !TOOL_EXEC_KEY) {
    return { error: "tool-exec not configured" };
  }
  try {
    const r = await fetch(TOOL_EXEC_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${TOOL_EXEC_KEY}`,
      },
      body: JSON.stringify({ tenantId: TENANT_ID, agentInstanceId: AGENT_ID, ...payload }),
    });
    const text = await r.text();
    let body;
    try { body = JSON.parse(text); } catch { body = { raw: text }; }
    if (!r.ok) return { error: `tool-exec ${r.status}`, detail: body };
    return body;
  } catch (e) {
    return { error: `tool-exec request failed: ${String(e?.message || e)}` };
  }
}

let cachedTools = null;
async function listTools() {
  if (cachedTools) return cachedTools;
  const res = await callToolExec({ op: "list" });
  const tools = Array.isArray(res?.tools) ? res.tools : [];
  // Map ClawHire OpenAI-style function schemas -> MCP tool defs.
  cachedTools = tools.map((t) => {
    const fn = t?.function || t;
    return {
      name: String(fn?.name || ""),
      description: String(fn?.description || ""),
      inputSchema: fn?.parameters || { type: "object", properties: {} },
    };
  }).filter((t) => t.name);
  return cachedTools;
}

// MCP stdio is newline-delimited JSON. This server originally spoke ONLY the older LSP-style
// Content-Length framing, so OpenClaw's client never completed the handshake: the server started, the
// initialize request was ignored, and after 30s bundle-mcp gave up with "MCP server connection timed
// out" and dropped every ClawHire tool — while `openclaw mcp doctor` still reported it healthy. It also
// cost 30 seconds of dead wait on EVERY container turn. We now reply in whichever framing the client
// used, defaulting to newline-delimited.
let framing = "ndjson"; // flips to "lsp" if a Content-Length frame is ever received

function send(obj) {
  const json = JSON.stringify(obj);
  if (framing === "lsp") {
    const payload = Buffer.from(json, "utf8");
    process.stdout.write(`Content-Length: ${payload.length}\r\n\r\n`);
    process.stdout.write(payload);
    return;
  }
  process.stdout.write(json + "\n");
}

function reply(id, result) { send({ jsonrpc: "2.0", id, result }); }
function replyError(id, code, message) { send({ jsonrpc: "2.0", id, error: { code, message } }); }

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === "initialize") {
    return reply(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "clawhire", version: "1.0.0" },
    });
  }
  if (method === "notifications/initialized" || method === "initialized") return; // notification, no reply
  if (method === "ping") return reply(id, {});
  if (method === "tools/list") {
    try {
      const tools = await listTools();
      return reply(id, { tools });
    } catch (e) {
      return replyError(id, -32000, `tools/list failed: ${String(e?.message || e)}`);
    }
  }
  if (method === "tools/call") {
    const name = params?.name;
    const args = params?.arguments || {};
    if (!name) return replyError(id, -32602, "missing tool name");
    const result = await callToolExec({ op: "exec", toolName: name, args });
    const isError = !!(result && result.error);
    return reply(id, {
      content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result) }],
      isError,
    });
  }
  if (typeof id !== "undefined") return replyError(id, -32601, `method not found: ${method}`);
}

// ---- stdio JSON-RPC reader: accepts newline-delimited JSON (what MCP clients send) AND the older
// LSP-style Content-Length framing, so this server works with either client. ----
let buf = Buffer.alloc(0);

function dispatch(body) {
  const text = body.trim();
  if (!text) return;
  let msg;
  try { msg = JSON.parse(text); } catch { return; }
  Promise.resolve(handle(msg)).catch((e) => stderr(`handle error: ${String(e?.message || e)}`));
}

process.stdin.on("data", (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  for (;;) {
    const asText = buf.toString("utf8");
    // Content-Length framing only when the buffer actually starts with the header.
    if (/^\s*Content-Length:/i.test(asText)) {
      framing = "lsp";
      const headerEnd = buf.indexOf("\r\n\r\n");
      if (headerEnd === -1) return; // wait for the full header
      const header = buf.slice(0, headerEnd).toString("utf8");
      const m = /Content-Length:\s*(\d+)/i.exec(header);
      if (!m) { buf = buf.slice(headerEnd + 4); continue; }
      const len = parseInt(m[1], 10);
      const start = headerEnd + 4;
      if (buf.length < start + len) return; // wait for the full body
      dispatch(buf.slice(start, start + len).toString("utf8"));
      buf = buf.slice(start + len);
      continue;
    }
    // Otherwise: newline-delimited JSON, one message per line.
    const nl = buf.indexOf("\n");
    if (nl === -1) return; // wait for a complete line
    const line = buf.slice(0, nl).toString("utf8");
    buf = buf.slice(nl + 1);
    dispatch(line);
  }
});
process.stdin.on("end", () => process.exit(0));
stderr(`ready tenant=${TENANT_ID ? "set" : "unset"} agent=${AGENT_ID ? "set" : "unset"} url=${TOOL_EXEC_URL ? "set" : "unset"}`);
