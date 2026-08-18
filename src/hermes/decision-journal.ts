/**
 * Hermes Decision Journal — Phase 2
 *
 * Durable audit trail for every strategic decision Hermes makes.
 * Stores decisions in a SQLite table with timestamp, type, rationale,
 * and pre/post metrics so the dashboard can display a timeline view.
 */

import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";

const DB_DIR = path.join(process.cwd(), "hermes");
const DB_PATH = path.join(DB_DIR, "hermes-learning.db");

const CREATE_JOURNAL_TABLE = `
CREATE TABLE IF NOT EXISTS decision_journal (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp   TEXT    NOT NULL,
    type        TEXT    NOT NULL,
    decision    TEXT    NOT NULL,
    rationale   TEXT    NOT NULL DEFAULT '',
    pre_metrics TEXT    NOT NULL DEFAULT '{}',
    post_metrics TEXT   NOT NULL DEFAULT '{}',
    auto        INTEGER NOT NULL DEFAULT 1
);
`;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DecisionType =
  | "backend_swap"
  | "concurrency_change"
  | "timing_adjustment"
  | "proxy_rotation"
  | "batch_restart"
  | "self_heal_patch"
  | "self_heal_revert"
  | "batch_complete"
  | "strategy_plan"
  | "escalation"
  | "manual_override"
  | "other";

export interface DecisionEntry {
  id: number;
  timestamp: string;
  type: DecisionType;
  decision: string;
  rationale: string;
  preMetrics: Record<string, unknown>;
  postMetrics: Record<string, unknown>;
  auto: boolean;
}

export interface LogDecisionOpts {
  type: DecisionType;
  decision: string;
  rationale?: string;
  preMetrics?: Record<string, unknown>;
  postMetrics?: Record<string, unknown>;
  auto?: boolean;
}

// ---------------------------------------------------------------------------
// Database helpers
// ---------------------------------------------------------------------------

let dbInstance: Database.Database | null = null;
function connect(): Database.Database {
  if (!dbInstance) {
    if (!fs.existsSync(DB_DIR)) {
      fs.mkdirSync(DB_DIR, { recursive: true });
    }
    dbInstance = new Database(DB_PATH);
    dbInstance.pragma("journal_mode = WAL");
    dbInstance.exec(CREATE_JOURNAL_TABLE);
  }
  return dbInstance;
}

function rowToEntry(row: Record<string, unknown>): DecisionEntry {
  return {
    id: row.id as number,
    timestamp: row.timestamp as string,
    type: row.type as DecisionType,
    decision: row.decision as string,
    rationale: row.rationale as string,
    preMetrics: safeJsonParse(row.pre_metrics as string),
    postMetrics: safeJsonParse(row.post_metrics as string),
    auto: !!(row.auto as number),
  };
}

function safeJsonParse(str: string): Record<string, unknown> {
  try {
    return JSON.parse(str);
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Log a strategic decision to the journal.
 */
export function logDecision(opts: LogDecisionOpts): number {
  const {
    type,
    decision,
    rationale = "",
    preMetrics = {},
    postMetrics = {},
    auto = true,
  } = opts;

  const db = connect();
  const result = db
    .prepare(
      `INSERT INTO decision_journal (timestamp, type, decision, rationale, pre_metrics, post_metrics, auto)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      new Date().toISOString(),
      type,
      decision,
      rationale,
      JSON.stringify(preMetrics),
      JSON.stringify(postMetrics),
      auto ? 1 : 0
    );
  return Number(result.lastInsertRowid);
}

/**
 * Get the most recent journal entries.
 */
export function getRecentDecisions(limit = 50): DecisionEntry[] {
  const db = connect();
  const rows = db
    .prepare(
      "SELECT * FROM decision_journal ORDER BY timestamp DESC LIMIT ?"
    )
    .all(limit) as Record<string, unknown>[];
  return rows.map(rowToEntry);
}

/**
 * Get journal entries filtered by type.
 */
export function getDecisionsByType(
  type: DecisionType,
  limit = 50
): DecisionEntry[] {
  const db = connect();
  const rows = db
    .prepare(
      "SELECT * FROM decision_journal WHERE type = ? ORDER BY timestamp DESC LIMIT ?"
    )
    .all(type, limit) as Record<string, unknown>[];
  return rows.map(rowToEntry);
}

/**
 * Get journal entries within a time range.
 */
export function getDecisionsInRange(
  startIso: string,
  endIso: string,
  limit = 200
): DecisionEntry[] {
  const db = connect();
  const rows = db
    .prepare(
      "SELECT * FROM decision_journal WHERE timestamp >= ? AND timestamp <= ? ORDER BY timestamp DESC LIMIT ?"
    )
    .all(startIso, endIso, limit) as Record<string, unknown>[];
  return rows.map(rowToEntry);
}

/**
 * Get summary statistics for the decision journal.
 */
export function getJournalStats(): {
  total: number;
  byType: Array<{ type: string; count: number }>;
  last24h: number;
} {
  const db = connect();
  const total = (
    db.prepare("SELECT COUNT(*) as c FROM decision_journal").get() as {
      c: number;
    }
  ).c;

  const byType = db
    .prepare(
      "SELECT type, COUNT(*) as count FROM decision_journal GROUP BY type ORDER BY count DESC"
    )
    .all() as Array<{ type: string; count: number }>;

  const twentyFourHoursAgo = new Date(
    Date.now() - 24 * 60 * 60 * 1000
  ).toISOString();
  const last24h = (
    db
      .prepare(
        "SELECT COUNT(*) as c FROM decision_journal WHERE timestamp >= ?"
      )
      .get(twentyFourHoursAgo) as { c: number }
  ).c;

  return { total, byType, last24h };
}
