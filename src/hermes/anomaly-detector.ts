/**
 * #18 — Hermes Anomaly Detection (TypeScript Port)
 *
 * Rolling-statistics anomaly detector using Welford's online algorithm.
 * Tracks mean and standard deviation for named metrics and fires an alert
 * when a new value deviates by more than the configured sigma threshold
 * from the rolling mean.
 *
 * Ported from hermes/anomaly_detector.py
 */

export interface AnomalyAlert {
  readonly metricName: string;
  readonly value: number;
  readonly mean: number;
  readonly stddev: number;
  readonly deviationSigma: number;
  readonly timestamp: string;
}

interface RollingStat {
  count: number;
  mean: number;
  m2: number;
  window: number[];
  maxWindow: number;
}

function createRollingStat(maxWindow = 200): RollingStat {
  return { count: 0, mean: 0, m2: 0, window: [], maxWindow };
}

function updateStat(stat: RollingStat, value: number): void {
  stat.window.push(value);
  if (stat.window.length > stat.maxWindow) {
    stat.window.shift();
  }

  stat.count = stat.window.length;

  // Recalculate mean and m2 over the current rolling window exactly
  // (Prevents precision loss and incorrectly mixing global history with rolling)
  let sum = 0;
  for (let i = 0; i < stat.count; i++) {
    sum += stat.window[i]!;
  }
  stat.mean = sum / stat.count;

  let m2 = 0;
  for (let i = 0; i < stat.count; i++) {
    const diff = stat.window[i]! - stat.mean;
    m2 += diff * diff;
  }
  stat.m2 = m2;
}

function getVariance(stat: RollingStat): number {
  return stat.count >= 2 ? stat.m2 / stat.count : 0;
}

function getStddev(stat: RollingStat): number {
  return Math.sqrt(getVariance(stat));
}

/**
 * Tracks rolling statistics and alerts on >Nσ deviations.
 *
 * Recommended metrics to track:
 *   - `session_duration`
 *   - `credits_per_credential`
 *   - `success_rate_per_hour`
 */
export class AnomalyDetector {
  private readonly _stats = new Map<string, RollingStat>();
  readonly sigmaThreshold: number;

  constructor(sigmaThreshold = 2.0) {
    this.sigmaThreshold = sigmaThreshold;
  }

  private _ensure(metricName: string): RollingStat {
    let stat = this._stats.get(metricName);
    if (!stat) {
      stat = createRollingStat();
      this._stats.set(metricName, stat);
    }
    return stat;
  }

  /** Record a new value for *metricName* (updates rolling stats). */
  record(metricName: string, value: number): void {
    updateStat(this._ensure(metricName), value);
  }

  /**
   * Record *value* and return an `AnomalyAlert` if it is anomalous.
   *
   * A value is anomalous when it deviates by more than `sigmaThreshold`
   * standard deviations from the rolling mean.
   * Returns `null` when the value is within normal range or when there
   * are too few data points (< 5) to judge.
   */
  check(metricName: string, value: number): AnomalyAlert | null {
    const stat = this._ensure(metricName);
    updateStat(stat, value);

    if (stat.count < 5) return null; // not enough data

    const stddev = getStddev(stat);
    if (stddev === 0) return null; // no variance — all values identical

    const deviation = Math.abs(value - stat.mean) / stddev;
    if (deviation > this.sigmaThreshold) {
      return {
        metricName,
        value,
        mean: stat.mean,
        stddev,
        deviationSigma: Math.round(deviation * 100) / 100,
        timestamp: new Date().toISOString(),
      };
    }
    return null;
  }

  /** Return current rolling stats for a metric. */
  getStats(metricName: string): { count: number; mean: number; stddev: number; last5: number[] } | null {
    const stat = this._stats.get(metricName);
    if (!stat) return null;
    return {
      count: stat.count,
      mean: Math.round(stat.mean * 10000) / 10000,
      stddev: Math.round(getStddev(stat) * 10000) / 10000,
      last5: stat.window.slice(-5),
    };
  }

  /** Reset all tracked metrics. */
  reset(): void {
    this._stats.clear();
  }
}
