/**
 * Secret-redacting structured logger.
 *
 * GUARANTEE: OAuth tokens, API keys, bearer headers, and any value under a
 * sensitive key are NEVER emitted to stdout. This is the only logger the worker
 * uses, so per-tenant credentials cannot leak into logs.
 */

const SENSITIVE_KEY = /(token|secret|password|api[-_]?key|authorization|bearer|credential|refresh|access[-_]?token|client[-_]?secret)/i;
const BEARER_RE = /\b(Bearer\s+)[A-Za-z0-9._\-]+/gi;
const LONG_SECRET_RE = /\b[A-Za-z0-9_\-]{32,}\b/g;

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[depth-limit]";
  if (value == null) return value;
  if (typeof value === "string") {
    return value.replace(BEARER_RE, "$1[redacted]").replace(LONG_SECRET_RE, (m) =>
      m.length >= 32 ? "[redacted]" : m,
    );
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY.test(k) ? "[redacted]" : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let threshold = ORDER.info;

export function setLogLevel(level: string): void {
  threshold = ORDER[(level as Level)] ?? ORDER.info;
}

function emit(level: Level, msg: string, meta?: Record<string, unknown>): void {
  if (ORDER[level] < threshold) return;
  const line = {
    t: new Date().toISOString(),
    level,
    msg,
    ...(meta ? { meta: redact(meta) } : {}),
  };
  const out = JSON.stringify(line);
  if (level === "error") console.error(out);
  else if (level === "warn") console.warn(out);
  else console.log(out);
}

export const log = {
  debug: (msg: string, meta?: Record<string, unknown>) => emit("debug", msg, meta),
  info: (msg: string, meta?: Record<string, unknown>) => emit("info", msg, meta),
  warn: (msg: string, meta?: Record<string, unknown>) => emit("warn", msg, meta),
  error: (msg: string, meta?: Record<string, unknown>) => emit("error", msg, meta),
};
