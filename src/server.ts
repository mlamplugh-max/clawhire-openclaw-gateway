/** Entrypoint: boot the ClawHire OpenClaw Gateway worker. */
import { loadConfig } from "./config.js";
import { setLogLevel, log } from "./security/logger.js";
import { registry } from "./adapter/registry.js";
import { buildApp } from "./adapter/server.js";
import { costTracker } from "./telemetry/cost.js";
import { WebSocketServer, WebSocket } from "ws";
import * as browserBox from "./browser/browser-box.js";

async function main(): Promise<void> {
  const cfg = loadConfig();
  setLogLevel(cfg.logLevel);
  await registry.init();
  const app = buildApp();
  const server = app.listen(cfg.port, () => {
    log.info("worker.listening", {
      port: cfg.port,
      engine: cfg.engine,
      tenancyMode: cfg.tenancyMode,
      apiKeyConfigured: Boolean(cfg.apiKey),
      tokenBrokerConfigured: Boolean(cfg.tokenBrokerUrl && cfg.tokenBrokerKey),
      costCapUsd: cfg.monthlyCostCapUsd,
    });
  });

  // BROWSER_BOX_V1 — authenticated CDP proxy: wss://<container>/browser/sessions/:id/cdp
  // ClawHire (server-side, holding the API key) connects here; we pipe to the page-level DevTools
  // socket bound to 127.0.0.1. Chromium itself is never reachable from outside the container.
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    let url: URL;
    try { url = new URL(req.url || "", "http://localhost"); } catch { socket.destroy(); return; }
    const m = url.pathname.match(/^\/browser\/sessions\/([a-zA-Z0-9_-]+)\/cdp$/);
    if (!m) { socket.destroy(); return; }
    const auth = String(req.headers["authorization"] || "");
    const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
    const key = bearer || String(req.headers["x-api-key"] || "") || url.searchParams.get("key") || "";
    if (!cfg.apiKey || key !== cfg.apiKey) { socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n"); socket.destroy(); return; }
    const sess = browserBox.getSession(m[1]);
    if (!sess) { socket.write("HTTP/1.1 404 Not Found\r\n\r\n"); socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (client) => {
      const upstream = new WebSocket(sess.pageWsUrl, { perMessageDeflate: false });
      const pending: string[] = [];
      upstream.on("open", () => { log.info("browser.box.upstream_open", { id: sess.id, pending: pending.length }); for (const msg of pending.splice(0)) upstream.send(msg); });
      // CDP is text-only JSON: `ws` hands us Buffers, and re-sending a Buffer produces a BINARY frame,
      // which Chrome's DevTools server answers by dropping the socket (1006). Forward as text.
      upstream.on("message", (data) => { browserBox.touch(sess.id); if (client.readyState === client.OPEN) client.send(data.toString()); });
      upstream.on("close", (code, reason) => { log.info("browser.box.upstream_close", { id: sess.id, code, reason: String(reason || "") }); try { client.close(); } catch { /* ignore */ } });
      upstream.on("error", (err) => { log.warn("browser.box.upstream_error", { id: sess.id, error: (err as Error)?.message }); try { client.close(); } catch { /* ignore */ } });
      client.on("message", (data) => { browserBox.touch(sess.id); const text = data.toString(); if (upstream.readyState === upstream.OPEN) upstream.send(text); else pending.push(text); });
      client.on("close", (code) => { log.info("browser.box.client_close", { id: sess.id, code }); try { upstream.close(); } catch { /* ignore */ } });
      client.on("error", () => { try { upstream.close(); } catch { /* ignore */ } });
    });
  });

  const snapshotTimer = setInterval(() => costTracker.logSnapshot(), 5 * 60 * 1000);
  snapshotTimer.unref();

  const shutdown = (sig: string) => {
    log.info("worker.shutdown", { sig });
    clearInterval(snapshotTimer);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err) => {
  log.error("worker.fatal", { error: (err as Error)?.message });
  process.exit(1);
});
