/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return */
/**
 * SESSION TELEMETRY — Unified Behavioral Telemetry Corpus
 * Apex Enhancement #10
 *
 * Records structured per-session telemetry into SQLite and provides
 * counterfactual analysis to identify which single variable caused
 * a failure relative to the nearest successful session.
 *
 * All writes go through the existing database write-queue to maintain
 * WAL mode compliance (Rule §7: Strict WAL Mode).
 */

import { db, pushToWriteQueue } from "./database.js";
import { createLogger } from "./logger.js";

const log = createLogger("telemetry");

// ─── Types ──────────────────────────────────────────────────────────────────

export interface TimingVector {
  pre_fill_ms: number;
  keystroke_cadence_ms: number;
  post_submit_wait_ms: number;
  cookie_dismiss_ms: number;
  total_flow_ms: number;
}

export interface NetworkMetrics {
  ttfb_ms: number;
  resource_count: number;
  response_size_bytes: number;
  challenge_headers_detected: boolean;
  status_code: number;
}

export interface DomMetrics {
  transition_count: number;
  classification_latency_ms: number;
  mutation_events: number;
  classifier_source: "dom_classifier" | "legacy_poll" | "network" | "mutation_observer" | "timeout";
}

export interface SessionTelemetryRecord {
  session_id: string;
  email: string;
  target_site: string;
  backend: string;
  proxy_key: string;
  proxy_region: string;
  fingerprint_seed: number | null;
  ua_hash: string;
  timing_vector: TimingVector;
  network_metrics: NetworkMetrics;
  dom_metrics: DomMetrics;
  hermes_interventions: number;
  outcome: string;
  block_rate_at_time: number;
  attempt_index: number;
  timestamp?: string;
}

export interface CounterfactualResult {
  nearest_success: {
    session_id: string;
    similarity_score: number;
  };
  diverging_variable: string;
  diverging_values: {
    failed: string | number;
    succeeded: string | number;
  };
  confidence: number;
  recommendation: string;
}

export interface CorrelationResult {
  dimension: string;
  correlation_coefficient: number;
  optimal_range: { min: number; max: number };
  sample_size: number;
}

// ─── Prepared Statements (lazy-init to avoid DB race) ───────────────────────

import type Database from "better-sqlite3";

let _insertStmt: Database.Statement | null = null;
let _queryByOutcomeStmt: Database.Statement | null = null;
let _queryRecentStmt: Database.Statement | null = null;
let _findCounterfactualStmt: Database.Statement | null = null;

function getInsertStmt() {
  if (!_insertStmt) {
    _insertStmt = db.prepare(`
      INSERT INTO session_telemetry (
        session_id, email, target_site, backend, proxy_key, proxy_region,
        fingerprint_seed, ua_hash, timing_vector, network_metrics, dom_metrics,
        hermes_interventions, outcome, block_rate_at_time, attempt_index
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
  }
  return _insertStmt;
}

function getQueryByOutcomeStmt() {
  if (!_queryByOutcomeStmt) {
    _queryByOutcomeStmt = db.prepare(`
      SELECT * FROM session_telemetry
      WHERE target_site = ? AND outcome = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `);
  }
  return _queryByOutcomeStmt;
}

function getQueryRecentStmt() {
  if (!_queryRecentStmt) {
    _queryRecentStmt = db.prepare(`
      SELECT * FROM session_telemetry
      WHERE target_site = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `);
  }
  return _queryRecentStmt;
}

function getFindCounterfactualStmt() {
  if (!_findCounterfactualStmt) {
    const SUCCESS_OUTCOMES = ["success", "2FA", "verify-phone"];
    _findCounterfactualStmt = db.prepare(`
      SELECT * FROM session_telemetry
      WHERE target_site = ?
        AND outcome IN (${SUCCESS_OUTCOMES.map(() => "?").join(",")})
      ORDER BY timestamp DESC
      LIMIT 200
    `);
  }
  return _findCounterfactualStmt;
}

// ─── Recording ──────────────────────────────────────────────────────────────

/**
 * Record a completed session's telemetry. Synchronous WAL write via the
 * existing database write path. Safe to call from any async context.
 */
export function recordSession(record: SessionTelemetryRecord): void {
  try {
    pushToWriteQueue(() => {
      getInsertStmt().run(
      record.session_id,
      record.email,
      record.target_site,
      record.backend || "unknown",
      record.proxy_key || "",
      record.proxy_region || "",
      record.fingerprint_seed ?? null,
      record.ua_hash || "",
      JSON.stringify(record.timing_vector),
      JSON.stringify(record.network_metrics),
      JSON.stringify(record.dom_metrics),
      record.hermes_interventions || 0,
      record.outcome,
      record.block_rate_at_time || 0,
      record.attempt_index || 0,
      );
    });
  } catch (e: unknown) {
    log.warn(`Telemetry record failed: ${(e instanceof Error ? e.message : String(e)) ?? String(e)}`);
  }
}

// ─── Counterfactual Analysis ────────────────────────────────────────────────

/**
 * Given a failed session, find the nearest successful session with the most
 * similar parameters and surface the single variable that differed most.
 *
 * Similarity is computed across: backend, proxy_region, fingerprint_seed,
 * timing_vector dimensions, and time proximity.
 */
export function findCounterfactual(
  failed: SessionTelemetryRecord,
): CounterfactualResult | null {
  try {
    const SUCCESS_OUTCOMES = ["success", "2FA", "verify-phone"];
    const successes = getFindCounterfactualStmt().all(failed.target_site, ...SUCCESS_OUTCOMES) as any[];

    if (successes.length === 0) return null;

    let bestMatch: any = null;
    let bestScore = -Infinity;

    for (const s of successes) {
      let score = 0;

      // Same backend = +3
      if (s.backend === failed.backend) score += 3;
      // Same proxy region = +2
      if (s.proxy_region === failed.proxy_region) score += 2;
      // Same fingerprint seed = +2
      if (s.fingerprint_seed === failed.fingerprint_seed) score += 2;

      // Timing vector similarity (inverse of euclidean distance, normalized)
      try {
        const sTiming: TimingVector = JSON.parse(s.timing_vector);
        const fTiming = failed.timing_vector;
        const dims: (keyof TimingVector)[] = [
          "pre_fill_ms", "keystroke_cadence_ms", "post_submit_wait_ms",
          "cookie_dismiss_ms", "total_flow_ms",
        ];
        let distSq = 0;
        for (const d of dims) {
          const diff = (sTiming[d] || 0) - (fTiming[d] || 0);
          // Normalize by expected scale (1000ms)
          distSq += (diff / 1000) ** 2;
        }
        score += Math.max(0, 5 - Math.sqrt(distSq));
      } catch { /* JSON parse failure — skip timing comparison */ }

      // Time proximity: sessions within 1 hour score higher
      try {
        const sTime = new Date(s.timestamp).getTime();
        const fTime = failed.timestamp
          ? new Date(failed.timestamp).getTime()
          : Date.now();
        const hoursDiff = Math.abs(sTime - fTime) / (3600 * 1000);
        score += Math.max(0, 3 - hoursDiff);
      } catch { /* timestamp parse failure */ }

      if (score > bestScore) {
        bestScore = score;
        bestMatch = s;
      }
    }

    if (!bestMatch) return null;

    // Identify the single most divergent variable
    const divergences: Array<{
      variable: string;
      failedVal: string | number;
      successVal: string | number;
      magnitude: number;
    }> = [];

    // Check categorical variables
    if (bestMatch.backend !== failed.backend) {
      divergences.push({
        variable: "backend",
        failedVal: failed.backend,
        successVal: bestMatch.backend,
        magnitude: 3,
      });
    }
    if (bestMatch.proxy_region !== failed.proxy_region) {
      divergences.push({
        variable: "proxy_region",
        failedVal: failed.proxy_region,
        successVal: bestMatch.proxy_region,
        magnitude: 2,
      });
    }

    // Check timing vector dimensions
    try {
      const sTiming: TimingVector = JSON.parse(bestMatch.timing_vector);
      const fTiming = failed.timing_vector;
      const dims: (keyof TimingVector)[] = [
        "pre_fill_ms", "keystroke_cadence_ms", "post_submit_wait_ms",
        "cookie_dismiss_ms", "total_flow_ms",
      ];
      for (const d of dims) {
        const sVal = sTiming[d] || 0;
        const fVal = fTiming[d] || 0;
        if (sVal === 0 && fVal === 0) continue;
        const ratio = sVal > 0 ? Math.abs(fVal - sVal) / sVal : Math.abs(fVal);
        if (ratio > 0.3) { // >30% deviation
          divergences.push({
            variable: `timing.${d}`,
            failedVal: fVal,
            successVal: sVal,
            magnitude: ratio,
          });
        }
      }
    } catch { /* JSON parse failure */ }

    // Check network metrics
    try {
      const sNet: NetworkMetrics = JSON.parse(bestMatch.network_metrics);
      const fNet = failed.network_metrics;
      if (fNet.challenge_headers_detected && !sNet.challenge_headers_detected) {
        divergences.push({
          variable: "network.challenge_headers",
          failedVal: "detected",
          successVal: "none",
          magnitude: 5,
        });
      }
      if (fNet.ttfb_ms > 0 && sNet.ttfb_ms > 0) {
        const ttfbRatio = Math.abs(fNet.ttfb_ms - sNet.ttfb_ms) / sNet.ttfb_ms;
        if (ttfbRatio > 0.5) {
          divergences.push({
            variable: "network.ttfb_ms",
            failedVal: fNet.ttfb_ms,
            successVal: sNet.ttfb_ms,
            magnitude: ttfbRatio,
          });
        }
      }
    } catch { /* JSON parse failure */ }

    // Sort by magnitude and pick the top divergence
    divergences.sort((a, b) => b.magnitude - a.magnitude);
    const topDivergence = divergences[0];

    if (!topDivergence) {
      return {
        nearest_success: {
          session_id: bestMatch.session_id,
          similarity_score: bestScore,
        },
        diverging_variable: "unknown",
        diverging_values: { failed: "N/A", succeeded: "N/A" },
        confidence: 0.3,
        recommendation: "No clear single-variable divergence found. Consider multi-factor analysis.",
      };
    }

    const recommendations: Record<string, string> = {
      "backend": `Switch to backend "${topDivergence.successVal}" which has higher success rates for this target.`,
      "proxy_region": `Prefer proxies from region "${topDivergence.successVal}" — current region "${topDivergence.failedVal}" shows higher block rates.`,
      "timing.pre_fill_ms": `Adjust pre-fill delay to ~${topDivergence.successVal}ms (currently ${topDivergence.failedVal}ms).`,
      "timing.keystroke_cadence_ms": `Adjust keystroke cadence to ~${topDivergence.successVal}ms (currently ${topDivergence.failedVal}ms).`,
      "timing.post_submit_wait_ms": `Adjust post-submit wait to ~${topDivergence.successVal}ms (currently ${topDivergence.failedVal}ms).`,
      "timing.total_flow_ms": `Total flow time diverged: ${topDivergence.failedVal}ms vs ${topDivergence.successVal}ms — check for bottlenecks.`,
      "network.challenge_headers": "WAF challenge detected before DOM interaction. Enable predictive block evasion.",
      "network.ttfb_ms": `TTFB anomaly: ${topDivergence.failedVal}ms vs ${topDivergence.successVal}ms — potential WAF interception.`,
    };

    return {
      nearest_success: {
        session_id: bestMatch.session_id,
        similarity_score: bestScore,
      },
      diverging_variable: topDivergence.variable,
      diverging_values: {
        failed: topDivergence.failedVal,
        succeeded: topDivergence.successVal,
      },
      confidence: Math.min(0.95, bestScore / 15),
      recommendation:
        recommendations[topDivergence.variable] ||
        `Variable "${topDivergence.variable}" diverged: ${topDivergence.failedVal} → ${topDivergence.successVal}`,
    };
  } catch (e: unknown) {
    log.warn(`Counterfactual analysis failed: ${(e instanceof Error ? e.message : String(e)) ?? String(e)}`);
    return null;
  }
}

// ─── Timing Correlation Analysis ────────────────────────────────────────────

/**
 * Compute the Pearson correlation coefficient between a timing dimension
 * and the binary success/failure outcome for a given target site.
 *
 * Returns the optimal range (mean ± 1σ of successful sessions) and
 * correlation strength.
 */
export function getTimingCorrelation(
  targetSite: string,
  dimension: keyof TimingVector,
  limit: number = 500,
): CorrelationResult | null {
  try {
    const rows = getQueryRecentStmt().all(targetSite, limit) as any[];
    if (rows.length < 10) return null;

    const SUCCESS_OUTCOMES = new Set(["success", "2FA", "verify-phone"]);
    const values: Array<{ timing: number; success: number }> = [];

    for (const row of rows) {
      try {
        const tv: TimingVector = JSON.parse(row.timing_vector);
        const val = tv[dimension];
        if (val == null || val <= 0) continue;
        values.push({
          timing: val,
          success: SUCCESS_OUTCOMES.has(row.outcome) ? 1 : 0,
        });
      } catch { continue; }
    }

    if (values.length < 10) return null;

    // Pearson correlation
    const n = values.length;
    const sumX = values.reduce((s, v) => s + v.timing, 0);
    const sumY = values.reduce((s, v) => s + v.success, 0);
    const sumXY = values.reduce((s, v) => s + v.timing * v.success, 0);
    const sumX2 = values.reduce((s, v) => s + v.timing * v.timing, 0);
    const sumY2 = values.reduce((s, v) => s + v.success * v.success, 0);

    const numerator = n * sumXY - sumX * sumY;
    const denominator = Math.sqrt(
      (n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY),
    );
    const r = denominator === 0 ? 0 : numerator / denominator;

    // Optimal range: mean ± 1σ of successful sessions only
    const successValues = values
      .filter((v) => v.success === 1)
      .map((v) => v.timing);
    const mean =
      successValues.length > 0
        ? successValues.reduce((s, v) => s + v, 0) / successValues.length
        : 0;
    const variance =
      successValues.length > 1
        ? successValues.reduce((s, v) => s + (v - mean) ** 2, 0) /
          (successValues.length - 1)
        : 0;
    const std = Math.sqrt(variance);

    return {
      dimension,
      correlation_coefficient: r,
      optimal_range: {
        min: Math.max(0, Math.round(mean - std)),
        max: Math.round(mean + std),
      },
      sample_size: values.length,
    };
  } catch (e: unknown) {
    log.warn(`Timing correlation failed: ${(e instanceof Error ? e.message : String(e)) ?? String(e)}`);
    return null;
  }
}

// ─── Query Helpers ──────────────────────────────────────────────────────────

/** Get recent telemetry records for a target site. */
export function getRecentTelemetry(
  targetSite: string,
  limit: number = 50,
): SessionTelemetryRecord[] {
  try {
    const rows = getQueryRecentStmt().all(targetSite, limit) as any[];
    return rows.map(deserializeRecord);
  } catch (e: unknown) {
    log.warn(`getRecentTelemetry failed: ${(e instanceof Error ? e.message : String(e)) ?? String(e)}`);
    return [];
  }
}

/** Get telemetry records filtered by outcome. */
export function getTelemetryByOutcome(
  targetSite: string,
  outcome: string,
  limit: number = 50,
): SessionTelemetryRecord[] {
  try {
    const rows = getQueryByOutcomeStmt().all(
      targetSite,
      outcome,
      limit,
    ) as any[];
    return rows.map(deserializeRecord);
  } catch (e: unknown) {
    log.warn(`getTelemetryByOutcome failed: ${(e instanceof Error ? e.message : String(e)) ?? String(e)}`);
    return [];
  }
}

/** Compute the current block rate for a target site (last N sessions). */
export function getCurrentBlockRate(
  targetSite: string,
  window: number = 50,
): number {
  try {
    const rows = getQueryRecentStmt().all(targetSite, window) as any[];
    if (rows.length === 0) return 0;
    const BLOCK_OUTCOMES = new Set([
      "blocked",
      "honeypot",
      "N/A",
      "predicted_block",
    ]);
    const blocked = rows.filter((r: any) => BLOCK_OUTCOMES.has(r.outcome)).length;
    return blocked / rows.length;
  } catch {
    return 0;
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function deserializeRecord(row: any): SessionTelemetryRecord {
  return {
    session_id: row.session_id,
    email: row.email,
    target_site: row.target_site,
    backend: row.backend,
    proxy_key: row.proxy_key,
    proxy_region: row.proxy_region,
    fingerprint_seed: row.fingerprint_seed,
    ua_hash: row.ua_hash,
    timing_vector: safeJsonParse(row.timing_vector, {
      pre_fill_ms: 0,
      keystroke_cadence_ms: 0,
      post_submit_wait_ms: 0,
      cookie_dismiss_ms: 0,
      total_flow_ms: 0,
    }),
    network_metrics: safeJsonParse(row.network_metrics, {
      ttfb_ms: 0,
      resource_count: 0,
      response_size_bytes: 0,
      challenge_headers_detected: false,
      status_code: 0,
    }),
    dom_metrics: safeJsonParse(row.dom_metrics, {
      transition_count: 0,
      classification_latency_ms: 0,
      mutation_events: 0,
      classifier_source: "timeout" as const,
    }),
    hermes_interventions: row.hermes_interventions || 0,
    outcome: row.outcome,
    block_rate_at_time: row.block_rate_at_time || 0,
    attempt_index: row.attempt_index || 0,
    timestamp: row.timestamp,
  };
}

function safeJsonParse<T>(str: string | null | undefined, fallback: T): T {
  if (!str) return fallback;
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}