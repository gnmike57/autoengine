/**
 * Hermes Outcome Tracker — Phase 4
 *
 * Real-time success/failure rate tracker with sliding windows
 * (5-min, 15-min, 1-hour, 24-hour). Emits events when success
 * rate drops below configurable thresholds.
 *
 * Feeds into the anomaly detector for automated alerts.
 */

import { AnomalyDetector, type AnomalyAlert } from "./anomaly-detector.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OutcomeSnapshot {
  /** Window duration label */
  window: string;
  /** Total outcomes in this window */
  total: number;
  /** Success count */
  successes: number;
  /** Failure count */
  failures: number;
  /** Success rate (0-100) */
  successRate: number;
  /** Block rate (0-100) */
  blockRate: number;
}

export interface OutcomeEvent {
  outcome: string;
  timestamp: number;
  backend?: string;
  proxyPool?: string;
}

export type AlertCallback = (alert: {
  type: "low_success_rate" | "high_block_rate" | "anomaly";
  window: string;
  rate: number;
  threshold: number;
  anomalyAlert?: AnomalyAlert;
}) => void;

export interface TrackerConfig {
  /** Success rate threshold to trigger alert (0-100, default 40) */
  successRateThreshold?: number;
  /** Block rate threshold to trigger alert (0-100, default 50) */
  blockRateThreshold?: number;
  /** Callback when an alert fires */
  onAlert?: AlertCallback;
}

// ---------------------------------------------------------------------------
// Window definitions
// ---------------------------------------------------------------------------

const WINDOWS = [
  { label: "5min", durationMs: 5 * 60 * 1000 },
  { label: "15min", durationMs: 15 * 60 * 1000 },
  { label: "1hour", durationMs: 60 * 60 * 1000 },
  { label: "24hour", durationMs: 24 * 60 * 60 * 1000 },
] as const;

// Success outcomes
const SUCCESS_PREFIXES = ["success", "noaccount", "permdisabled", "tempdisabled", "2FA"];
// Block/error outcomes
const BLOCK_PREFIXES = ["blocked", "N/A", "api-error", "error"];

function isSuccess(outcome: string): boolean {
  return SUCCESS_PREFIXES.some((p) => outcome.startsWith(p));
}

function isBlock(outcome: string): boolean {
  return BLOCK_PREFIXES.some((p) => outcome.startsWith(p));
}

// ---------------------------------------------------------------------------
// Outcome Tracker
// ---------------------------------------------------------------------------

export class OutcomeTracker {
  private readonly events: OutcomeEvent[] = [];
  private readonly anomalyDetector: AnomalyDetector;
  private readonly config: Required<TrackerConfig>;
  private readonly maxEvents = 10000; // Bounded memory

  constructor(config: TrackerConfig = {}) {
    this.config = {
      successRateThreshold: config.successRateThreshold ?? 40,
      blockRateThreshold: config.blockRateThreshold ?? 50,
      onAlert: config.onAlert ?? (() => {}),
    };
    this.anomalyDetector = new AnomalyDetector(2.5); // Slightly higher threshold for outcomes
  }

  /**
   * Record a new outcome event.
   */
  record(outcome: string, backend?: string, proxyPool?: string): void {
    const event: OutcomeEvent = {
      outcome,
      timestamp: Date.now(),
      backend,
      proxyPool,
    };
    this.events.push(event);

    // Evict old events beyond max (amortized to avoid O(N) on every push)
    if (this.events.length > this.maxEvents + 1000) {
      this.events.splice(0, this.events.length - this.maxEvents);
    }

    // Check thresholds on the 5-min window (most reactive)
    this.checkThresholds();
  }

  /**
   * Get snapshots for all time windows.
   */
  getSnapshots(): OutcomeSnapshot[] {
    const now = Date.now();
    return WINDOWS.map(({ label, durationMs }) => {
      const cutoff = now - durationMs;
      const windowEvents = this.events.filter((e) => e.timestamp >= cutoff);
      const total = windowEvents.length;
      const successes = windowEvents.filter((e) => isSuccess(e.outcome)).length;
      const blocks = windowEvents.filter((e) => isBlock(e.outcome)).length;
      const failures = total - successes;

      return {
        window: label,
        total,
        successes,
        failures,
        successRate: total > 0 ? Math.round((successes / total) * 1000) / 10 : 0,
        blockRate: total > 0 ? Math.round((blocks / total) * 1000) / 10 : 0,
      };
    });
  }

  /**
   * Get a snapshot for a specific window.
   */
  getSnapshot(windowLabel: string): OutcomeSnapshot | null {
    return this.getSnapshots().find((s) => s.window === windowLabel) ?? null;
  }

  /**
   * Get per-backend breakdown for a specific window.
   */
  getBackendBreakdown(
    windowLabel: string
  ): Map<string, { total: number; successes: number; successRate: number }> {
    const windowDef = WINDOWS.find((w) => w.label === windowLabel);
    if (!windowDef) return new Map();

    const cutoff = Date.now() - windowDef.durationMs;
    const windowEvents = this.events.filter((e) => e.timestamp >= cutoff);
    const breakdown = new Map<
      string,
      { total: number; successes: number; successRate: number }
    >();

    for (const event of windowEvents) {
      const backend = event.backend ?? "unknown";
      let stats = breakdown.get(backend);
      if (!stats) {
        stats = { total: 0, successes: 0, successRate: 0 };
        breakdown.set(backend, stats);
      }
      stats.total++;
      if (isSuccess(event.outcome)) stats.successes++;
      stats.successRate =
        stats.total > 0 ? Math.round((stats.successes / stats.total) * 1000) / 10 : 0;
    }

    return breakdown;
  }

  /**
   * Get the current consecutive failure count from the tail.
   */
  getConsecutiveFailures(): number {
    let count = 0;
    for (let i = this.events.length - 1; i >= 0; i--) {
      if (this.events[i] && isBlock(this.events[i]!.outcome)) {
        count++;
      } else {
        break;
      }
    }
    return count;
  }

  /** Reset all tracking data. */
  reset(): void {
    this.events.length = 0;
    this.anomalyDetector.reset();
  }

  // -----------------------------------------------------------------------
  // Private
  // -----------------------------------------------------------------------

  private checkThresholds(): void {
    const snapshot5min = this.getSnapshot("5min");
    if (!snapshot5min || snapshot5min.total < 5) return; // Need minimum sample

    // Check success rate
    if (snapshot5min.successRate < this.config.successRateThreshold) {
      this.config.onAlert({
        type: "low_success_rate",
        window: "5min",
        rate: snapshot5min.successRate,
        threshold: this.config.successRateThreshold,
      });
    }

    // Check block rate
    if (snapshot5min.blockRate > this.config.blockRateThreshold) {
      this.config.onAlert({
        type: "high_block_rate",
        window: "5min",
        rate: snapshot5min.blockRate,
        threshold: this.config.blockRateThreshold,
      });
    }

    // Feed anomaly detector
    const anomalyAlert = this.anomalyDetector.check(
      "realtime_success_rate",
      snapshot5min.successRate
    );
    if (anomalyAlert) {
      this.config.onAlert({
        type: "anomaly",
        window: "5min",
        rate: snapshot5min.successRate,
        threshold: this.config.successRateThreshold,
        anomalyAlert,
      });
    }
  }
}
