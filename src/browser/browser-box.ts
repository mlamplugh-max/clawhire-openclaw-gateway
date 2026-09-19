/**
 * BROWSER_BOX_V1 — a company's own browser, inside its own container.
 *
 * Replaces the paid cloud browser: Chromium runs here on the per-company Fly machine with a
 * PERSISTENT profile per workspace on the /data volume (cookies, local storage, "remember this
 * device" all survive restarts — stronger than a provider "context"). ClawHire talks to it over
 * the DevTools protocol through the authenticated CDP proxy in server.ts: the customer's live
 * sign-in view streams from Page.startScreencast, and employees drive the same page for work.
 *
 * Isolation: one Chromium per session, profiles keyed by workspaceId under BROWSER_PROFILES_ROOT,
 * bound to 127.0.0.1 (only the proxy can reach it). Idle sessions are reaped.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import crypto from "node:crypto";
import { log } from "../security/logger.js";

export interface BoxSession {
  id: string;
  profileId: string;
  port: number;
  pid: number;
  pageWsUrl: string;
  createdAt: number;
  lastActivityAt: number;
  proc: ChildProcess;
}

const CHROMIUM_BIN = process.env.CHROMIUM_BIN || "/usr/bin/chromium";
const PROFILES_ROOT = process.env.BROWSER_PROFILES_ROOT || "/data/browser-profiles";
const IDLE_MS = Math.max(60_000, Math.min(2 * 60 * 60_000, Number(process.env.BROWSER_BOX_IDLE_MS || 20 * 60_000)));
const MAX_SESSIONS = Math.max(1, Math.min(6, Number(process.env.BROWSER_BOX_MAX_SESSIONS || 3)));

const sessions = new Map<string, BoxSession>();

function safeId(v: string): string { return String(v || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80) || "default"; }

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => { const addr = srv.address(); srv.close(() => resolve(typeof addr === "object" && addr ? addr.port : 0)); });
    srv.on("error", reject);
  });
}

// First Chromium start on a cold shared-CPU microVM (font cache, profile creation) can take 20-40s;
// warm starts take ~5s. Generous by default, tunable.
const START_TIMEOUT_MS = Math.max(15_000, Math.min(180_000, Number(process.env.BROWSER_BOX_START_TIMEOUT_MS || 60_000)));

async function waitForPage(port: number, timeoutMs = START_TIMEOUT_MS): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) {
        const list = (await r.json()) as any[];
        const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
        if (page) return String(page.webSocketDebuggerUrl);
      }
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error("chromium did not expose a page within " + timeoutMs + "ms");
}

export function chromiumAvailable(): boolean { return existsSync(CHROMIUM_BIN); }

export function listSessions(): Array<Omit<BoxSession, "proc">> {
  return Array.from(sessions.values()).map(({ proc: _p, ...rest }) => rest);
}

export function getSession(id: string): BoxSession | undefined { return sessions.get(id); }

export function touch(id: string): void { const s = sessions.get(id); if (s) s.lastActivityAt = Date.now(); }

export async function createSession(input: { profileId: string; startUrl?: string; width?: number; height?: number }): Promise<Omit<BoxSession, "proc"> & { startUrl?: string }> {
  if (!chromiumAvailable()) throw Object.assign(new Error("chromium_missing"), { code: "chromium_missing" });
  if (sessions.size >= MAX_SESSIONS) {
    // Reap the idlest one rather than refusing: a company only ever needs a couple at once.
    const idlest = Array.from(sessions.values()).sort((a, b) => a.lastActivityAt - b.lastActivityAt)[0];
    if (idlest) await closeSession(idlest.id);
  }
  const profileId = safeId(input.profileId);
  const userDataDir = path.join(PROFILES_ROOT, profileId);
  await mkdir(userDataDir, { recursive: true });
  // A crashed previous run can leave Singleton* locks that block relaunch on the same profile.
  for (const f of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) { await rm(path.join(userDataDir, f), { force: true }).catch(() => {}); }
  const port = await freePort();
  const width = Math.max(800, Math.min(1920, Number(input.width) || 1280));
  const height = Math.max(600, Math.min(1200, Number(input.height) || 800));
  const args = [
    "--headless=new", "--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu",
    "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-features=Translate,TranslateUI",
    "--password-store=basic", "--use-mock-keychain",
    `--window-size=${width},${height}`, `--remote-debugging-address=127.0.0.1`, `--remote-debugging-port=${port}`, `--user-data-dir=${userDataDir}`,
    "--user-agent=Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
    // Always start on about:blank: a command-line URL makes Chrome tear down the startup target during
    // its first cross-process navigation, which drops any DevTools socket attached in that window (1006).
    // Callers navigate over CDP after attaching (that is what ClawHire does for sign-in and for work).
    "about:blank",
  ];
  const proc = spawn(CHROMIUM_BIN, args, { stdio: ["ignore", "ignore", "pipe"] });
  let stderrTail = "";
  proc.stderr?.on("data", (d) => { stderrTail = (stderrTail + String(d)).slice(-2000); });
  const id = "bx_" + crypto.randomBytes(8).toString("hex");
  try {
    const pageWsUrl = await waitForPage(port);
    const sess: BoxSession = { id, profileId, port, pid: proc.pid || 0, pageWsUrl, createdAt: Date.now(), lastActivityAt: Date.now(), proc };
    sessions.set(id, sess);
    proc.on("exit", (code) => { log.info("browser.box.exit", { id, code }); sessions.delete(id); });
    log.info("browser.box.started", { id, profileId, port, pid: proc.pid });
    const { proc: _p, ...rest } = sess;
    return { ...rest, startUrl: input.startUrl || undefined };
  } catch (e) {
    try { proc.kill("SIGKILL"); } catch { /* ignore */ }
    log.error("browser.box.start_failed", { profileId, error: (e as Error)?.message, stderr: stderrTail.slice(-400) });
    throw e;
  }
}

export async function closeSession(id: string): Promise<boolean> {
  const s = sessions.get(id);
  if (!s) return false;
  sessions.delete(id);
  // Ask Chromium to close cleanly so the profile flushes to disk; force after 3s.
  try {
    await fetch(`http://127.0.0.1:${s.port}/json/close`, { signal: AbortSignal.timeout(1500) }).catch(() => {});
    s.proc.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 3000));
    if (s.proc.exitCode === null) s.proc.kill("SIGKILL");
  } catch { /* ignore */ }
  log.info("browser.box.closed", { id });
  return true;
}

// Idle reaper: a sign-in left open or an employee task that died must not hold a Chromium forever.
const reaper = setInterval(() => {
  const now = Date.now();
  for (const s of Array.from(sessions.values())) {
    if (now - s.lastActivityAt > IDLE_MS) { log.info("browser.box.reaped_idle", { id: s.id, idleMs: now - s.lastActivityAt }); void closeSession(s.id); }
  }
}, 30_000);
reaper.unref();
