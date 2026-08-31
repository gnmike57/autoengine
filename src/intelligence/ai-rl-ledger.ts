/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return */
import fs from "fs";
import path from "path";
import { gaussianClamped } from "../core/gaussian-rng.js";

const LEDGER_PATH = path.join(process.cwd(), "rl-timings.json");

interface LedgerEntry {
  mean: number;
  stdDev: number;
  min: number;
  max: number;
  successes: number;
  failures: number;
}

interface LedgerData {
  [key: string]: LedgerEntry;
}

export class RLLedger {
  private data: LedgerData = {};
  private currentRunKeys: Map<string, Set<string>> = new Map();

  constructor() {
    this.load();
  }

  private load() {
    try {
      if (fs.existsSync(LEDGER_PATH)) {
        this.data = JSON.parse(fs.readFileSync(LEDGER_PATH, "utf-8"));
      }
    } catch {
      this.data = {};
    }
  }

  private saveTimer: NodeJS.Timeout | null = null;

  public save() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(async () => {
      try {
        const tmpPath = LEDGER_PATH + '.tmp';
        await fs.promises.writeFile(tmpPath, JSON.stringify(this.data, null, 2), "utf-8");
        await fs.promises.rename(tmpPath, LEDGER_PATH);
      } catch { /* intentional */ }
    }, 500); // 500ms debounce
  }

  /**
   * Get a timing value, automatically using the learned mean/stdDev if it exists,
   * otherwise falling back to the defaults and registering it.
   */
  public getTiming(scope: string, key: string, defaultMean: number, defaultStdDev: number, defaultMin: number, defaultMax: number): number {
    if (this.currentRunKeys.size > 1000) {
      // Prevent memory leak if reportOutcome is skipped due to crash
      this.currentRunKeys.clear();
    }
    if (!this.currentRunKeys.has(scope)) {
      this.currentRunKeys.set(scope, new Set());
    }
    this.currentRunKeys.get(scope)!.add(key);

    if (!this.data[key]) {
      this.data[key] = {
        mean: defaultMean,
        stdDev: defaultStdDev,
        min: defaultMin,
        max: defaultMax,
        successes: 0,
        failures: 0
      };
      this.save();
    }

    const entry = this.data[key];
    // Clamp the learned mean to reasonable bounds (never less than 50% of default min)
    const activeMean = Math.max(defaultMin * 0.5, Math.min(entry.mean, defaultMax * 1.5));
    const activeStdDev = Math.max(defaultStdDev * 0.5, Math.min(entry.stdDev, defaultStdDev * 2));

    return gaussianClamped(activeMean, activeStdDev, defaultMin, defaultMax);
  }

  /**
   * Call this at the end of a session to score the timings.
   * If success = true, the timings slightly tighten (speed up).
   * If success = false, the timings slightly widen (slow down, more human).
   */
  public reportOutcome(scope: string, success: boolean) {
    const keys = this.currentRunKeys.get(scope);
    if (!keys) return;

    for (const key of keys) {
      const entry = this.data[key];
      if (!entry) continue;

      const alpha = 0.1; // learning rate
      if (success) {
        entry.successes++;
        // Speed up target (10% faster)
        const targetMean = entry.mean * 0.9;
        const targetStdDev = entry.stdDev * 0.95;
        // Exponential Moving Average update
        entry.mean = (1 - alpha) * entry.mean + alpha * targetMean;
        entry.stdDev = (1 - alpha) * entry.stdDev + alpha * targetStdDev;
      } else {
        entry.failures++;
        // Slow down target (20% slower, more human caution)
        const targetMean = entry.mean * 1.2;
        const targetStdDev = entry.stdDev * 1.2;
        // Exponential Moving Average update
        entry.mean = (1 - alpha) * entry.mean + alpha * targetMean;
        entry.stdDev = (1 - alpha) * entry.stdDev + alpha * targetStdDev;
      }
    }
    this.save();
    this.currentRunKeys.delete(scope);
  }

  /**
   * Return a snapshot of the current learned timings for telemetry capture.
   */
  public getTimingSnapshot(): Record<string, LedgerEntry> {
    return JSON.parse(JSON.stringify(this.data));
  }
}

export const globalRLLedger = new RLLedger();
