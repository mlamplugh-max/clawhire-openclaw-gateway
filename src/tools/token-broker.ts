/**
 * Per-tenant OAuth Token Broker — the heart of TOOL PARITY.
 *
 * Containerized agents must execute the same tenant tools (Gmail/Calendar/
 * Drive/Docs/Sheets/HubSpot/etc.) as the in-process runtime. We achieve this
 * WITHOUT ever sharing or committing tenant secrets:
 *
 *   1. On session start, the worker calls ClawHire's secure store
 *      (TENANT_TOKEN_BROKER_URL) authenticated with the worker's OWN signed key
 *      (TENANT_TOKEN_BROKER_KEY — a Fly secret, NOT a tenant secret).
 *   2. The broker returns SHORT-LIVED, per-tenant OAuth tokens + the tool
 *      manifest for that agent.
 *   3. Tokens are injected into ONLY that agent's sandbox env, used for the
 *      turn, and SCRUBBED afterwards. They are never logged, never written to
 *      disk, and never visible to another tenant's sandbox.
 *
 * If the broker is not configured, the worker reports an EMPTY tool set (honest
 * about reduced capability) rather than silently leaking or faking access.
 */

import { loadConfig } from "../config.js";
import { log } from "../security/logger.js";
import type { ToolDescriptor } from "../types.js";

export interface BrokeredCredentials {
  /** Env var map to inject into the agent sandbox for this turn ONLY. */
  env: Record<string, string>;
  /** Tool manifest the agent may use this turn. */
  tools: ToolDescriptor[];
  /** Seconds until these credentials expire. */
  expiresInSeconds: number;
  /** Best-effort scrubber to wipe injected secrets after the turn. */
  scrub: () => void;
}

const EMPTY: BrokeredCredentials = {
  env: {},
  tools: [],
  expiresInSeconds: 0,
  scrub: () => {},
};

/**
 * Fetch short-lived per-tenant credentials + tool manifest for one agent.
 * Strictly scoped to (tenantId, agentId); the broker enforces ownership too.
 */
export async function brokerCredentials(
  tenantId: string,
  agentId: string,
  scopes?: string[],
): Promise<BrokeredCredentials> {
  const cfg = loadConfig();
  if (!cfg.tokenBrokerUrl || !cfg.tokenBrokerKey) {
    log.warn("token-broker.unconfigured", { tenantId, agentId, note: "no tools brokered" });
    return EMPTY;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(cfg.tokenBrokerUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.tokenBrokerKey}`,
        "x-worker-key": cfg.tokenBrokerKey,
      },
      body: JSON.stringify({
        tenant_id: tenantId,
        tenantId,
        agent_id: agentId,
        agentId,
        scopes: scopes || [],
        ttl_seconds: cfg.tokenTtlSeconds,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) {
      // Never log the body (may echo secrets); only status.
      log.warn("token-broker.non_ok", { tenantId, agentId, status: res.status });
      return EMPTY;
    }
    const data = (await res.json()) as {
      tokens?: Record<string, string>;
      env?: Record<string, string>;
      tools?: ToolDescriptor[];
      expiresInSeconds?: number;
      expires_in_seconds?: number;
    };

    const env: Record<string, string> = { ...(data.tokens || {}), ...(data.env || {}) };
    const tools: ToolDescriptor[] = Array.isArray(data.tools) ? data.tools : [];
    const expiresInSeconds = Number(data.expiresInSeconds ?? data.expires_in_seconds ?? cfg.tokenTtlSeconds);

    const scrub = () => {
      for (const k of Object.keys(env)) {
        // best-effort wipe of the reference; GC reclaims the rest.
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete (env as Record<string, string>)[k];
      }
    };

    log.info("token-broker.ok", {
      tenantId,
      agentId,
      toolCount: tools.length,
      envKeyCount: Object.keys(env).length, // count only — NEVER the values
      expiresInSeconds,
    });

    return { env, tools, expiresInSeconds, scrub };
  } catch (err: unknown) {
    clearTimeout(timeout);
    log.warn("token-broker.error", { tenantId, agentId, error: (err as Error)?.message });
    return EMPTY;
  }
}
