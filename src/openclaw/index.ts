/** Engine selection: OPENCLAW_ENGINE=openclaw -> real runtime; else deterministic stub. */
import { loadConfig } from "../config.js";
import { log } from "../security/logger.js";
import type { OpenClawEngineLike } from "./engine.js";
import { StubEngine } from "./stub-engine.js";
import { OpenClawEngine } from "./openclaw-engine.js";

let engine: OpenClawEngineLike | null = null;

export function getEngine(): OpenClawEngineLike {
  if (engine) return engine;
  const cfg = loadConfig();
  engine = cfg.engine === "openclaw" ? new OpenClawEngine() : new StubEngine();
  log.info("engine.selected", { engine: engine.name, tenancyMode: cfg.tenancyMode });
  return engine;
}

/** Test helper. */
export function __setEngineForTest(e: OpenClawEngineLike | null): void {
  engine = e;
}

export type { OpenClawEngineLike } from "./engine.js";
