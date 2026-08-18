/**
 * #20 — Hermes Summary Reports (TypeScript Port)
 *
 * Generates a Markdown summary report from a list of event dicts.
 * Reports include credential counts, outcome breakdowns, credit
 * consumption, top failure reasons, and recommended next actions.
 * Saved to `hermes/reports/` with timestamped filenames.
 *
 * Ported from hermes/reports.py
 */

import fs from "node:fs";
import path from "node:path";

const REPORTS_DIR = path.join(process.cwd(), "hermes", "reports");

function ensureReportsDir(): void {
  if (!fs.existsSync(REPORTS_DIR)) {
    fs.mkdirSync(REPORTS_DIR, { recursive: true });
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ReportEvent {
  data?: {
    outcome?: string;
    creditsSpent?: number;
    credential?: string;
    email?: string;
    username?: string;
    error?: string;
    message?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface RunSummary {
  total: number;
  uniqueCredentials: number;
  successCount: number;
  failCount: number;
  requeueCount: number;
  successRate: number;
  totalCredits: number;
  outcomeBreakdown: Map<string, number>;
  topFailures: Array<[string, number]>;
  recommendedActions: string[];
  reportPath: string;
  markdown: string;
}

// ---------------------------------------------------------------------------
// Counter utility
// ---------------------------------------------------------------------------

class Counter<T extends string | number> {
  private readonly _counts = new Map<T, number>();

  increment(key: T): void {
    this._counts.set(key, (this._counts.get(key) ?? 0) + 1);
  }

  get(key: T): number {
    return this._counts.get(key) ?? 0;
  }

  entries(): Array<[T, number]> {
    return [...this._counts.entries()];
  }

  mostCommon(n?: number): Array<[T, number]> {
    const sorted = this.entries().sort((a, b) => b[1] - a[1]);
    return n ? sorted.slice(0, n) : sorted;
  }

  total(): number {
    let sum = 0;
    for (const v of this._counts.values()) sum += v;
    return sum;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Produce a Markdown report summarising the given events.
 *
 * The report is also written to `hermes/reports/report-{timestamp}.md`.
 */
export function generateRunSummary(events: ReportEvent[]): RunSummary {
  const total = events.length;
  const outcomes = new Counter<string>();
  const failureReasons = new Counter<string>();
  const credentialsSeen = new Set<string>();
  let totalCredits = 0;

  for (const ev of events) {
    const data = ev.data ?? {};
    const outcome = String(data.outcome ?? "unknown");
    outcomes.increment(outcome);

    const cred = data.credential ?? data.email ?? data.username;
    if (cred) credentialsSeen.add(String(cred));

    totalCredits += Number(data.creditsSpent ?? 0);

    if (outcome !== "success" && outcome !== "requeue") {
      const reason = String(data.error ?? data.message ?? outcome);
      failureReasons.increment(reason);
    }
  }

  const successCount = outcomes.get("success");
  const requeueCount = outcomes.get("requeue");
  const failCount = outcomes.entries()
    .filter(([o]) => o !== "success" && o !== "requeue")
    .reduce((sum, [, c]) => sum + c, 0);
  const successRate = total > 0 ? (successCount / total) * 100 : 0;

  const topFailures = failureReasons.mostCommon(5);

  // Build recommended actions
  const actions: string[] = [];
  if (successRate < 50) {
    actions.push("⚠️  Success rate below 50% — investigate top failure reasons urgently.");
  }
  if (topFailures.some(([r]) => /selector|dom/i.test(r))) {
    actions.push(
      "🔧  DOM/selector failures detected — review engine.ts locators against latest page screenshots."
    );
  }
  if (topFailures.some(([r]) => /proxy|tunnel/i.test(r))) {
    actions.push(
      "🌐  Infrastructure failures detected — rotate proxy endpoints or check tunnel health."
    );
  }
  if (topFailures.some(([r]) => /rate|429/i.test(r))) {
    actions.push("🐢  Rate-limiting detected — reduce concurrency and add back-off delays.");
  }
  if (requeueCount > total * 0.3) {
    actions.push("🔁  High requeue rate — check if credential classification is correct.");
  }
  if (actions.length === 0) {
    actions.push("✅  Run looks healthy. Continue monitoring.");
  }

  // Assemble Markdown
  const now = new Date().toISOString().replace("T", " ").split(".")[0] + " UTC";
  const lines = [
    `# Hermes Run Summary — ${now}`,
    "",
    "## Overview",
    "| Metric | Value |",
    "|--------|-------|",
    `| Total events | ${total} |`,
    `| Unique credentials | ${credentialsSeen.size} |`,
    `| Success | ${successCount} |`,
    `| Failed | ${failCount} |`,
    `| Requeued | ${requeueCount} |`,
    `| Success rate | ${successRate.toFixed(1)}% |`,
    `| Credits consumed | ${totalCredits.toFixed(2)} |`,
    "",
    "## Outcome Breakdown",
  ];

  for (const [outcome, count] of outcomes.mostCommon()) {
    lines.push(`- **${outcome}**: ${count}`);
  }

  lines.push("", "## Top 5 Failure Reasons");
  if (topFailures.length > 0) {
    for (let i = 0; i < topFailures.length; i++) {
      const [reason, count] = topFailures[i]!;
      lines.push(`${i + 1}. \`${reason}\` — ${count} occurrence(s)`);
    }
  } else {
    lines.push("_No failures recorded._");
  }

  lines.push("", "## Recommended Actions");
  for (const a of actions) {
    lines.push(`- ${a}`);
  }

  const markdown = lines.join("\n") + "\n";

  // Persist to disk
  ensureReportsDir();
  const ts = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace("T", "T")
    .split(".")[0];
  const reportPath = path.join(REPORTS_DIR, `report-${ts}.md`);
  try {
    fs.writeFileSync(reportPath, markdown, "utf-8");
  } catch {
    // Non-fatal if reports dir is not writable
  }

  return {
    total,
    uniqueCredentials: credentialsSeen.size,
    successCount,
    failCount,
    requeueCount,
    successRate: Math.round(successRate * 10) / 10,
    totalCredits: Math.round(totalCredits * 100) / 100,
    outcomeBreakdown: new Map(outcomes.entries()),
    topFailures,
    recommendedActions: actions,
    reportPath,
    markdown,
  };
}
