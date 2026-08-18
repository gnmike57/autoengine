/**
 * Hermes Strategy Engine — Phase 2
 *
 * Pre-batch strategy planning and post-batch analysis.
 * Before each batch, analyzes the learning DB and recent outcomes to select:
 *   - Optimal backend (weighted by recent success rates per backend)
 *   - Optimal concurrency (bounded by proxy pool health)
 *   - Optimal proxy pool (exclude pools with >50% block rate)
 *   - Timing profile (from RL stealth profiler weights if available)
 *
 * After each batch, computes delta metrics and generates a strategy mutation report.
 */

import fs from "node:fs";
import path from "node:path";
import { AnomalyDetector } from "./anomaly-detector.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BackendStats {
  backend: string;
  total: number;
  successes: number;
  blocks: number;
  errors: number;
  successRate: number;
}

export interface StrategyPlan {
  /** Recommended backend for the next batch */
  backend: string;
  /** Recommended concurrency level */
  concurrency: number;
  /** Recommended proxy pool (or "off") */
  proxyPool: string;
  /** Recommended timing overrides */
  timings: Record<string, number>;
  /** Rationale for each decision */
  rationale: string[];
  /** Timestamp */
  timestamp: string;
}

export interface BatchMetrics {
  backend: string;
  proxyPool: string;
  concurrency: number;
  total: number;
  successes: number;
  blocks: number;
  errors: number;
  noaccount: number;
  durationMs: number;
  successRate: number;
}

export interface StrategyConfig {
  /** All available backends */
  availableBackends?: string[];
  /** Available proxy pools */
  availableProxyPools?: string[];
  /** Minimum concurrency */
  minConcurrency?: number;
  /** Maximum concurrency */
  maxConcurrency?: number;
  /** Block rate threshold to disqualify a backend (0-1) */
  blockRateThreshold?: number;
  /** Path to stealth weights file */
  stealthWeightsPath?: string;
  /** Path to timing overrides file */
  timingOverridesPath?: string;
}

// ---------------------------------------------------------------------------
// Strategy Engine
// ---------------------------------------------------------------------------

export class StrategyEngine {
  private readonly config: Required<StrategyConfig>;
  private readonly anomalyDetector: AnomalyDetector;
  private readonly batchHistory: BatchMetrics[] = [];
  private readonly backendStats = new Map<string, BackendStats>();

  constructor(config: StrategyConfig = {}) {
    this.config = {
      availableBackends: config.availableBackends ?? [
        "stealth",
        "cloak-headless",
        "zendriver",
        "cloak-headed",
      ],
      availableProxyPools: config.availableProxyPools ?? ["off"],
      minConcurrency: config.minConcurrency ?? 1,
      maxConcurrency: config.maxConcurrency ?? 10,
      blockRateThreshold: config.blockRateThreshold ?? 0.5,
      stealthWeightsPath:
        config.stealthWeightsPath ??
        path.join(process.cwd(), "hermes", "stealth-weights.json"),
      timingOverridesPath:
        config.timingOverridesPath ??
        path.join(process.cwd(), "hermes", "timing-overrides.json"),
    };

    this.anomalyDetector = new AnomalyDetector(2.0);

    // Initialize backend stats
    for (const b of this.config.availableBackends) {
      this.backendStats.set(b, {
        backend: b,
        total: 0,
        successes: 0,
        blocks: 0,
        errors: 0,
        successRate: 0,
      });
    }
  }

  /**
   * Record the results of a completed batch for learning.
   */
  recordBatch(metrics: BatchMetrics): void {
    this.batchHistory.push(metrics);
    // Keep only last 50 batches
    if (this.batchHistory.length > 50) this.batchHistory.shift();

    // Update per-backend stats
    let stats = this.backendStats.get(metrics.backend);
    if (!stats) {
      stats = {
        backend: metrics.backend,
        total: 0,
        successes: 0,
        blocks: 0,
        errors: 0,
        successRate: 0,
      };
      this.backendStats.set(metrics.backend, stats);
    }
    stats.total += metrics.total;
    stats.successes += metrics.successes;
    stats.blocks += metrics.blocks;
    stats.errors += metrics.errors;
    stats.successRate =
      stats.total > 0 ? (stats.successes / stats.total) * 100 : 0;

    // Feed anomaly detector
    this.anomalyDetector.check("batch_success_rate", metrics.successRate);
    this.anomalyDetector.check("batch_duration_ms", metrics.durationMs);
  }

  /**
   * Generate a strategy plan for the next batch.
   */
  plan(): StrategyPlan {
    const rationale: string[] = [];

    // 1. Select best backend using UCB1 (Multi-Armed Bandit)
    let bestBackend = this.config.availableBackends[0];
    let bestScore = -Infinity;

    let totalBatches = 0;
    for (const [backend, stats] of this.backendStats) {
      if (this.config.availableBackends.includes(backend)) {
        totalBatches += stats.total;
      }
    }

    for (const backend of this.config.availableBackends) {
      const stats = this.backendStats.get(backend) || { total: 0, successes: 0, blocks: 0, errors: 0, successRate: 0, backend };

      // Disqualify if block rate > threshold
      const blockRate = stats.total > 0 ? stats.blocks / stats.total : 0;
      if (blockRate > this.config.blockRateThreshold && stats.total >= 5) {
        rationale.push(
          `Backend '${backend}' disqualified: ${(blockRate * 100).toFixed(1)}% block rate > ${(this.config.blockRateThreshold * 100).toFixed(0)}% threshold`
        );
        continue;
      }

      // UCB1 calculation
      let score: number;
      if (stats.total === 0) {
        score = Infinity;
        rationale.push(`Backend '${backend}' UCB1 Score: Infinity (Untested - Exploration favored)`);
      } else {
        const successRateNorm = stats.successRate / 100;
        const exploration = Math.sqrt((2 * Math.log(totalBatches || 1)) / stats.total);
        score = successRateNorm + exploration;
        rationale.push(`Backend '${backend}' UCB1 Score: ${score.toFixed(3)} (SR: ${successRateNorm.toFixed(2)}, Expl: ${exploration.toFixed(3)})`);
      }

      if (score > bestScore) {
        bestScore = score;
        bestBackend = backend;
      }
    }

    rationale.push(`Selected backend '${bestBackend}' with optimal UCB1 score.`);

    // 2. Determine concurrency based on recent performance
    let concurrency: number;
    const recentBatches = this.batchHistory.slice(-5);
    if (recentBatches.length >= 3) {
      const avgSuccessRate =
        recentBatches.reduce((s, b) => s + b.successRate, 0) /
        recentBatches.length;

      if (avgSuccessRate > 80) {
        concurrency = Math.min(
          this.config.maxConcurrency,
          Math.max(this.config.minConcurrency, Math.ceil(avgSuccessRate / 15))
        );
        rationale.push(
          `High avg success rate (${avgSuccessRate.toFixed(1)}%) → concurrency ${concurrency}`
        );
      } else if (avgSuccessRate < 40) {
        concurrency = this.config.minConcurrency;
        rationale.push(
          `Low avg success rate (${avgSuccessRate.toFixed(1)}%) → minimum concurrency ${concurrency}`
        );
      } else {
        concurrency = Math.max(
          this.config.minConcurrency,
          Math.ceil(avgSuccessRate / 25)
        );
        rationale.push(
          `Moderate avg success rate (${avgSuccessRate.toFixed(1)}%) → concurrency ${concurrency}`
        );
      }
    } else {
      concurrency = this.config.minConcurrency;
      rationale.push(
        `Insufficient batch history (${recentBatches.length}/3) → default concurrency ${concurrency}`
      );
    }

    // 3. Select proxy pool — exclude pools with high block rates
    let proxyPool = "off";
    if (this.config.availableProxyPools.length > 1) {
      // For now, use the first non-off pool if available
      const nonOff = this.config.availableProxyPools.filter((p) => p !== "off");
      proxyPool = nonOff.length > 0 ? (nonOff[0] ?? "off") : "off";
      rationale.push(`Proxy pool: ${proxyPool}`);
    }

    // 4. Load timing overrides if available
    let timings: Record<string, number> = {};
    try {
      if (fs.existsSync(this.config.timingOverridesPath)) {
        timings = JSON.parse(
          fs.readFileSync(this.config.timingOverridesPath, "utf-8")
        ) as Record<string, number>;
        rationale.push(
          `Loaded ${Object.keys(timings).length} timing override(s) from disk`
        );
      }
    } catch {
      // Non-fatal
    }

    return {
      backend: bestBackend ?? "stealth",
      concurrency,
      proxyPool,
      timings,
      rationale,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Generate a post-batch analysis comparing current batch to historical averages.
   */
  analyzePostBatch(current: BatchMetrics): string[] {
    const insights: string[] = [];
    const history = this.batchHistory.slice(-10);

    if (history.length < 2) {
      insights.push("Insufficient history for post-batch analysis.");
      return insights;
    }

    const avgSuccessRate =
      history.reduce((s, b) => s + b.successRate, 0) / history.length;
    const delta = current.successRate - avgSuccessRate;

    if (delta > 10) {
      insights.push(
        `📈 Success rate improved by ${delta.toFixed(1)}pp vs rolling average (${avgSuccessRate.toFixed(1)}%)`
      );
    } else if (delta < -10) {
      insights.push(
        `📉 Success rate declined by ${Math.abs(delta).toFixed(1)}pp vs rolling average (${avgSuccessRate.toFixed(1)}%)`
      );
    } else {
      insights.push(
        `➡️ Success rate stable at ${current.successRate.toFixed(1)}% (avg: ${avgSuccessRate.toFixed(1)}%)`
      );
    }

    // Check for anomalies
    const rateAlert = this.anomalyDetector.check(
      "batch_success_rate",
      current.successRate
    );
    if (rateAlert) {
      insights.push(
        `🚨 Anomaly detected: success rate ${current.successRate.toFixed(1)}% deviates by ${rateAlert.deviationSigma}σ from mean ${rateAlert.mean.toFixed(1)}%`
      );
    }

    return insights;
  }

  /** Get backend statistics. */
  getBackendStats(): BackendStats[] {
    return [...this.backendStats.values()];
  }

  /** Get batch history. */
  getBatchHistory(): BatchMetrics[] {
    return [...this.batchHistory];
  }
}
