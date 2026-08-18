import { db } from "../core/database.js";
import { createLogger } from "../core/logger.js";

const log = createLogger("telemetry");

export interface TelemetryMetrics {
  totalRuns: number;
  successCount: number;
  successRate: number;
  wafBlockCount: number;
  wafBlockRate: number;
  captchaCount: number;
  captchaRate: number;
  avgDurationMs: number;
}

export interface DeepAnalysisReport {
  overall: TelemetryMetrics;
  byBackend: Record<string, TelemetryMetrics>;
  generatedAt: string;
}

export function generateDeepAnalysis(): DeepAnalysisReport {
  const statement = db.prepare(`
    SELECT outcome, error, backend, duration_ms
    FROM test_runs
    WHERE backend IS NOT NULL
  `);

  log.info(`Generating deep analysis from test runs.`);

  const report: DeepAnalysisReport = {
    overall: createEmptyMetrics(),
    byBackend: {},
    generatedAt: new Date().toISOString(),
  };

  for (const row of statement.iterate() as Iterable<any>) {
    const backend = row.backend as string;
    if (!report.byBackend[backend]) {
      report.byBackend[backend] = createEmptyMetrics();
    }

    processRow(row, report.overall);
    processRow(row, report.byBackend[backend]);
  }

  finalizeMetrics(report.overall);
  for (const backend of Object.keys(report.byBackend)) {
    finalizeMetrics(report.byBackend[backend]!);
  }

  return report;
}

function createEmptyMetrics(): TelemetryMetrics {
  return {
    totalRuns: 0,
    successCount: 0,
    successRate: 0,
    wafBlockCount: 0,
    wafBlockRate: 0,
    captchaCount: 0,
    captchaRate: 0,
    avgDurationMs: 0,
  };
}

function processRow(row: any, metrics: TelemetryMetrics) {
  metrics.totalRuns++;

  const outcome = row.outcome;
  const error = (row.error || "").toLowerCase();

  if (outcome === "success" || outcome === "success-unconfirmed" || outcome === "2FA") {
    metrics.successCount++;
  }

  if (outcome === "blocked" || outcome === "honeypot" || error.includes("403") || error.includes("waf")) {
    metrics.wafBlockCount++;
  }

  if (error.includes("captcha") || error.includes("wicketkeeper") || error.includes("challenge")) {
    metrics.captchaCount++;
  }

  if (row.duration_ms) {
    // Storing sum temporarily in avgDurationMs, will divide later
    metrics.avgDurationMs += row.duration_ms;
  }
}

function finalizeMetrics(metrics: TelemetryMetrics) {
  if (metrics.totalRuns > 0) {
    metrics.successRate = (metrics.successCount / metrics.totalRuns) * 100;
    metrics.wafBlockRate = (metrics.wafBlockCount / metrics.totalRuns) * 100;
    metrics.captchaRate = (metrics.captchaCount / metrics.totalRuns) * 100;
    metrics.avgDurationMs = Math.round(metrics.avgDurationMs / metrics.totalRuns);
  }
}
