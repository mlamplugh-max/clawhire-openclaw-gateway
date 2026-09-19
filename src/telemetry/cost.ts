/**
 * Cost telemetry + guardrail.
 *
 * Tracks two cost drivers:
 *   1) LLM token spend (tokens * $/1k)
 *   2) Machine wall-time ($/second the worker is running)
 *
 * Computes rolling MONTH-TO-DATE spend and a simple end-of-month PROJECTION.
 * When the projection exceeds MONTHLY_COST_CAP_USD and enforcement is on, new
 * sessions are refused (HTTP 429) so the bridge transparently falls back to the
 * in-process runtime — cost can never silently run away past the $300 cap.
 */

import { loadConfig } from "../config.js";
import { log } from "../security/logger.js";

interface CostState {
  monthKey: string; // YYYY-MM
  llmTokens: number;
  machineSecondsAtMonthStart: number;
  monthStartMs: number;
}

function monthKeyOf(d = new Date()): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export class CostTracker {
  private state: CostState;
  private readonly processStartMs = Date.now();

  constructor() {
    this.state = {
      monthKey: monthKeyOf(),
      llmTokens: 0,
      machineSecondsAtMonthStart: 0,
      monthStartMs: Date.now(),
    };
  }

  private rollMonthIfNeeded(): void {
    const now = monthKeyOf();
    if (now !== this.state.monthKey) {
      this.state = {
        monthKey: now,
        llmTokens: 0,
        machineSecondsAtMonthStart: this.machineSecondsTotal(),
        monthStartMs: Date.now(),
      };
    }
  }

  private machineSecondsTotal(): number {
    return (Date.now() - this.processStartMs) / 1000;
  }

  recordTokens(tokens: number): void {
    this.rollMonthIfNeeded();
    if (Number.isFinite(tokens) && tokens > 0) this.state.llmTokens += tokens;
  }

  /** Month-to-date machine seconds (approx; resets accounting at month roll). */
  private machineSecondsThisMonth(): number {
    return Math.max(0, this.machineSecondsTotal() - this.state.machineSecondsAtMonthStart);
  }

  spendToDateUsd(): number {
    const cfg = loadConfig();
    this.rollMonthIfNeeded();
    const llm = (this.state.llmTokens / 1000) * cfg.llmUsdPer1kTokens;
    const machine = this.machineSecondsThisMonth() * cfg.flyMachineUsdPerSecond;
    return llm + machine;
  }

  /** Linear projection to end of month based on elapsed fraction. */
  projectedMonthlyUsd(): number {
    const now = new Date();
    const daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
    const dayOfMonth = now.getUTCDate();
    const elapsedFraction = Math.max(dayOfMonth / daysInMonth, 1 / daysInMonth);
    return this.spendToDateUsd() / elapsedFraction;
  }

  /** True when a NEW session would be refused due to the cap. */
  isOverCap(): boolean {
    const cfg = loadConfig();
    if (!cfg.costCapEnforce) return false;
    return this.projectedMonthlyUsd() >= cfg.monthlyCostCapUsd;
  }

  snapshot(): Record<string, number | string | boolean> {
    const cfg = loadConfig();
    return {
      monthKey: this.state.monthKey,
      llmTokens: this.state.llmTokens,
      machineSecondsThisMonth: Math.round(this.machineSecondsThisMonth()),
      spendToDateUsd: Number(this.spendToDateUsd().toFixed(4)),
      projectedMonthlyUsd: Number(this.projectedMonthlyUsd().toFixed(4)),
      capUsd: cfg.monthlyCostCapUsd,
      enforced: cfg.costCapEnforce,
      overCap: this.isOverCap(),
    };
  }

  logSnapshot(): void {
    log.info("cost.snapshot", this.snapshot());
  }
}

export const costTracker = new CostTracker();
