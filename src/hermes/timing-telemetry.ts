/**
 * timing-telemetry.ts
 *
 * Passive timing collector that records actual phase durations during live
 * automation runs. Data is persisted as append-only JSONL to
 * `data/timing-telemetry.jsonl` for post-batch analysis by the Hermes
 * speed-optimizer agent.
 *
 * Usage:
 *   const recorder = new TimingRecorder(sessionId, email, site, backend);
 *   recorder.markPhaseStart("cookieDismiss");
 *   // ... do work ...
 *   recorder.markPhaseEnd("cookieDismiss");
 *   // ... after all phases ...
 *   recorder.finalize(verdict, success);
 */

import fs from "node:fs";
import path from "node:path";
import { createLogger } from "../core/logger.js";

const log = createLogger("TimingTelemetry");

// ── Types ──────────────────────────────────────────────────────────────────

export type FlowPhase =
  | "cookieDismiss"
  | "credentialFill"
  | "autofill"
  | "eyeClick"
  | "rememberMe"
  | "submit"
  | "submitRace"
  | "mutationSettle"
  | "responseWait"
  | "responseClassify"
  | "cashierVerify"
  | "totalE2E";

export interface PhaseTimings {
  cookieDismissMs?: number;
  credentialFillMs?: number;
  autofillMs?: number;
  eyeClickMs?: number;
  rememberMeMs?: number;
  submitMs?: number;
  submitRaceMs?: number;
  mutationSettleMs?: number;
  responseWaitMs?: number;
  responseClassifyMs?: number;
  cashierVerifyMs?: number;
  totalE2EMs?: number;
}

export interface TimingRecord {
  sessionId: string;
  email: string;
  site: string;
  backend: string;
  attemptIdx: number;
  timestamp: string;
  phases: PhaseTimings;
  verdict: string;
  success: boolean;
}

// ── Constants ──────────────────────────────────────────────────────────────

const TELEMETRY_DIR = path.join(process.cwd(), "data");
const TELEMETRY_FILE = path.join(TELEMETRY_DIR, "timing-telemetry.jsonl");

// ── TimingRecorder ─────────────────────────────────────────────────────────

export class TimingRecorder {
  private sessionId: string;
  private email: string;
  private site: string;
  private backend: string;
  private attemptIdx: number;

  private phaseStarts: Map<FlowPhase, number> = new Map();
  private phaseDurations: PhaseTimings = {};
  private sessionStart: number;

  constructor(
    sessionId: string,
    email: string,
    site: string,
    backend: string,
    attemptIdx: number = 0
  ) {
    this.sessionId = sessionId;
    this.email = email;
    this.site = site;
    this.backend = backend;
    this.attemptIdx = attemptIdx;
    this.sessionStart = performance.now();
  }

  /**
   * Mark the start of a named phase.
   */
  markPhaseStart(phase: FlowPhase): void {
    this.phaseStarts.set(phase, performance.now());
  }

  /**
   * Mark the end of a named phase. Calculates duration from the matching start.
   */
  markPhaseEnd(phase: FlowPhase): number {
    const start = this.phaseStarts.get(phase);
    if (start === undefined) {
      log.warn(`[TimingTelemetry] markPhaseEnd called for '${phase}' without a start`);
      return 0;
    }
    const duration = Math.round(performance.now() - start);
    const key = `${phase}Ms` as keyof PhaseTimings;
    (this.phaseDurations as Record<string, number>)[key] = duration;
    this.phaseStarts.delete(phase);
    return duration;
  }

  /**
   * Set the attempt index (for multi-attempt flows where the recorder
   * is reused across attempts).
   */
  setAttemptIdx(idx: number): void {
    this.attemptIdx = idx;
  }

  /**
   * Finalize the recording and persist to JSONL.
   */
  finalize(verdict: string, success: boolean): TimingRecord {
    this.phaseDurations.totalE2EMs = Math.round(performance.now() - this.sessionStart);

    const record: TimingRecord = {
      sessionId: this.sessionId,
      email: this.email,
      site: this.site,
      backend: this.backend,
      attemptIdx: this.attemptIdx,
      timestamp: new Date().toISOString(),
      phases: { ...this.phaseDurations },
      verdict,
      success,
    };

    this.persist(record);
    return record;
  }

  /**
   * Reset phase timers for a new attempt (keeps session-level data).
   */
  resetForNextAttempt(): void {
    this.phaseStarts.clear();
    this.phaseDurations = {};
    this.sessionStart = performance.now();
  }

  /**
   * Persist a single record to the JSONL file.
   */
  private persist(record: TimingRecord): void {
    try {
      if (!fs.existsSync(TELEMETRY_DIR)) {
        fs.mkdirSync(TELEMETRY_DIR, { recursive: true });
      }
      const line = JSON.stringify(record) + "\n";
      fs.appendFileSync(TELEMETRY_FILE, line, "utf-8");
    } catch (err) {
      log.warn(`[TimingTelemetry] Failed to persist record: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

// ── Analysis Utilities (used by Hermes-Analyst) ────────────────────────────

/**
 * Read all timing records from the telemetry file.
 */
export function readAllRecords(): TimingRecord[] {
  if (!fs.existsSync(TELEMETRY_FILE)) return [];
  try {
    const content = fs.readFileSync(TELEMETRY_FILE, "utf-8");
    return content
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as TimingRecord);
  } catch {
    return [];
  }
}

/**
 * Compute percentile statistics for a specific phase across all records.
 */
export function computePhaseStats(
  records: TimingRecord[],
  phase: keyof PhaseTimings
): { count: number; p50: number; p95: number; max: number; min: number; mean: number } | null {
  const values = records
    .map((r) => r.phases[phase])
    .filter((v): v is number => v !== undefined && v > 0)
    .sort((a, b) => a - b);

  if (values.length === 0) return null;

  const count = values.length;
  const p50 = values[Math.floor(count * 0.5)] ?? 0;
  const p95 = values[Math.floor(count * 0.95)] ?? 0;
  const max = values[count - 1] ?? 0;
  const min = values[0] ?? 0;
  const mean = Math.round(values.reduce((a, b) => a + b, 0) / count);

  return { count, p50, p95, max, min, mean };
}

/**
 * Read records from the last N hours.
 */
export function readRecentRecords(hoursBack: number = 24): TimingRecord[] {
  const cutoff = new Date(Date.now() - hoursBack * 60 * 60 * 1000).toISOString();
  return readAllRecords().filter((r) => r.timestamp >= cutoff);
}
