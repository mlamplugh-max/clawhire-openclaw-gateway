/**
 * Centralized, validated configuration for the ClawHire OpenClaw Gateway worker.
 * All values come from environment (Fly secrets in prod). No secrets are ever
 * hard-coded or logged.
 */

function bool(v: string | undefined, def: boolean): boolean {
  if (v === undefined) return def;
  return String(v).toLowerCase() === "true";
}

function num(v: string | undefined, def: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

export type Engine = "openclaw" | "stub";
export type TenancyMode = "pooled" | "dedicated";

export interface WorkerConfig {
  port: number;
  logLevel: string;
  apiKey: string | undefined;
  engine: Engine;
  openclawBin: string;
  openclawHome: string;
  tenancyMode: TenancyMode;
  dataRoot: string;
  tokenBrokerUrl: string | undefined;
  tokenBrokerKey: string | undefined;
  tokenTtlSeconds: number;
  monthlyCostCapUsd: number;
  flyMachineUsdPerSecond: number;
  llmUsdPer1kTokens: number;
  costCapEnforce: boolean;
  // OPTION B (founder-locked): non-Docker per-agent isolation on the Fly microVM.
  // "local" => per-agent OPENCLAW_STATE_DIR/HOME/workspace isolation, NO docker.
  sandboxMode: string;
  // Worker-owned LLM provider key(s) injected so `agent --local` can run a turn.
  // These are the WORKER's keys (Fly secrets), never tenant data.
  openrouterApiKey: string | undefined;
  openaiApiKey: string | undefined;
  // Default model id when the caller does not specify one (OpenRouter format).
  defaultModel: string;
  // D2 TOOL-PROXY: the signed ClawHire endpoint the in-sandbox `clawhire` MCP
  // server forwards every tool call to. Reuses TENANT_TOKEN_BROKER_KEY for auth.
  // The worker holds NO tenant secrets; tools execute IN ClawHire, tenant-scoped.
  toolExecUrl: string | undefined;
  toolExecKey: string | undefined;
  // LONG_TURNS_V1: per-turn budget in seconds for `openclaw agent --local`. A ClawHire work run is
  // ONE turn on this worker and a real task (several searches, a document) takes minutes; the old
  // hard-coded 110s killed every long job. Default 10 min; the bridge's own timeout
  // (OPENCLAW_MESSAGE_TIMEOUT_MS in ClawHire) must be >= this. Clamped 30s..60min.
  turnTimeoutSec: number;
}

let cached: WorkerConfig | null = null;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  if (cached) return cached;
  const engine = (env.OPENCLAW_ENGINE === "openclaw" ? "openclaw" : "stub") as Engine;
  const tenancyMode = (env.WORKER_TENANCY_MODE === "dedicated" ? "dedicated" : "pooled") as TenancyMode;
  cached = {
    port: num(env.PORT, 8000),
    logLevel: env.LOG_LEVEL || "info",
    apiKey: env.OPENCLAW_API_KEY || undefined,
    engine,
    openclawBin: env.OPENCLAW_BIN || "openclaw",
    turnTimeoutSec: Math.max(30, Math.min(3600, num(env.OPENCLAW_TURN_TIMEOUT_SEC, 600))),
    openclawHome: env.OPENCLAW_HOME || "/data/openclaw",
    tenancyMode,
    dataRoot: env.DATA_ROOT || "/data/agents",
    tokenBrokerUrl: env.TENANT_TOKEN_BROKER_URL || undefined,
    tokenBrokerKey: env.TENANT_TOKEN_BROKER_KEY || undefined,
    tokenTtlSeconds: num(env.TENANT_TOKEN_TTL_SECONDS, 600),
    monthlyCostCapUsd: num(env.MONTHLY_COST_CAP_USD, 300),
    flyMachineUsdPerSecond: num(env.FLY_MACHINE_USD_PER_SECOND, 0.0000022),
    llmUsdPer1kTokens: num(env.LLM_USD_PER_1K_TOKENS, 0.0025),
    costCapEnforce: bool(env.COST_CAP_ENFORCE, true),
    // Option B default: non-Docker per-agent isolation.
    sandboxMode: env.OPENCLAW_SANDBOX || "local",
    openrouterApiKey: env.OPENROUTER_API_KEY || undefined,
    openaiApiKey: env.OPENAI_API_KEY || undefined,
    defaultModel: env.OPENCLAW_DEFAULT_MODEL || "openai/gpt-5.4-mini",
    // D2: explicit TENANT_TOOL_EXEC_URL, else derive from the token-broker base.
    toolExecUrl:
      env.TENANT_TOOL_EXEC_URL ||
      (env.TENANT_TOKEN_BROKER_URL
        ? env.TENANT_TOKEN_BROKER_URL.replace(/\/token-broker\/?$/, "/tool-exec")
        : undefined),
    toolExecKey: env.TENANT_TOKEN_BROKER_KEY || undefined,
  };
  return cached;
}

/** Test helper to reset the cached config. */
export function __resetConfigForTest(): void {
  cached = null;
}
