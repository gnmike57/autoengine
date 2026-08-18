/**
 * #12 — Hermes Learning Database (TypeScript Port)
 *
 * SQLite-backed database that records every healing action, tracks
 * effectiveness, and lets the agent query which fixes historically
 * worked (or failed) for a given symptom.
 *
 * Uses `better-sqlite3` (already a project dependency).
 *
 * Ported from hermes/learning_db.py
 */

import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";

const DB_DIR = path.join(process.cwd(), "hermes");
const DB_PATH = path.join(DB_DIR, "hermes-learning.db");

const CREATE_TABLE = `
CREATE TABLE IF NOT EXISTS healing_actions (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp           TEXT    NOT NULL,
    symptom             TEXT    NOT NULL,
    fix_applied         TEXT    NOT NULL,
    file_modified       TEXT    NOT NULL DEFAULT '',
    success_rate_before REAL    NOT NULL DEFAULT 0.0,
    success_rate_after  REAL    NOT NULL DEFAULT 0.0,
    effective           INTEGER NOT NULL DEFAULT 0
);
`;

const INSERT = `
INSERT INTO healing_actions (timestamp, symptom, fix_applied, file_modified,
                             success_rate_before, success_rate_after, effective)
VALUES (?, ?, ?, ?, ?, ?, ?);
`;

export interface HealingRecord {
  id: number;
  timestamp: string;
  symptom: string;
  fix_applied: string;
  file_modified: string;
  success_rate_before: number;
  success_rate_after: number;
  effective: boolean;
}

let sharedDb: Database.Database | null = null;

/**
 * Wipe the DB and its WAL sidecars so a fresh database can be created.
 * Called when SQLite throws "disk image is malformed" (e.g. WAL sidecars
 * were committed to git without the parent .db file).
 */
function nukeCorruptedDb(): void {
  sharedDb = null;
  for (const ext of ["", "-shm", "-wal"]) {
    const p = DB_PATH + ext;
    if (fs.existsSync(p)) {
      try { fs.unlinkSync(p); } catch { /* best-effort */ }
    }
  }
}

function connect(): Database.Database {
  if (sharedDb) return sharedDb;
  if (!fs.existsSync(DB_DIR)) {
    fs.mkdirSync(DB_DIR, { recursive: true });
  }
  try {
    sharedDb = new Database(DB_PATH);
    sharedDb.pragma("journal_mode = WAL");
    sharedDb.exec(CREATE_TABLE);
  } catch (err: unknown) {
    const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
    if (msg.includes("malformed") || msg.includes("corrupt") || msg.includes("disk i/o")) {
      // WAL sidecars or stale handle — nuke and recreate
      nukeCorruptedDb();
      sharedDb = new Database(DB_PATH);
      sharedDb.pragma("journal_mode = WAL");
      sharedDb.exec(CREATE_TABLE);
    } else {
      throw err;
    }
  }
  return sharedDb;
}

function rowToRecord(row: Record<string, unknown>): HealingRecord {
  return {
    id: row.id as number,
    timestamp: row.timestamp as string,
    symptom: row.symptom as string,
    fix_applied: row.fix_applied as string,
    file_modified: row.file_modified as string,
    success_rate_before: row.success_rate_before as number,
    success_rate_after: row.success_rate_after as number,
    effective: !!(row.effective as number),
  };
}

/**
 * Persist a healing action. Returns the row id.
 */
export function recordHealing(opts: {
  symptom: string;
  fix: string;
  file: string;
  successRateBefore?: number;
  successRateAfter?: number;
  effective?: boolean;
}): number {
  const {
    symptom,
    fix,
    file,
    successRateBefore = 0,
    successRateAfter = 0,
  } = opts;
  const effective = opts.effective ?? successRateAfter > successRateBefore;
  const now = new Date().toISOString();
  const db = connect();
  const result = db
    .prepare(INSERT)
    .run(now, symptom, fix, file, successRateBefore, successRateAfter, effective ? 1 : 0);
  return Number(result.lastInsertRowid);
}

/**
 * Return fixes that historically improved the success rate for `symptom`.
 */
export function getEffectiveFixes(symptom: string): HealingRecord[] {
  const db = connect();
  const rows = db
    .prepare(
      "SELECT * FROM healing_actions WHERE symptom = ? AND effective = 1 ORDER BY timestamp DESC"
    )
    .all(symptom) as Record<string, unknown>[];
  return rows.map(rowToRecord);
}

/**
 * Return fixes that did NOT help for `symptom`.
 */
export function getIneffectiveFixes(symptom: string): HealingRecord[] {
  const db = connect();
  const rows = db
    .prepare(
      "SELECT * FROM healing_actions WHERE symptom = ? AND effective = 0 ORDER BY timestamp DESC"
    )
    .all(symptom) as Record<string, unknown>[];
  return rows.map(rowToRecord);
}

/**
 * Return the most recent healing records.
 */
export function getAllRecords(limit = 100): HealingRecord[] {
  const db = connect();
  const rows = db
    .prepare("SELECT * FROM healing_actions ORDER BY timestamp DESC LIMIT ?")
    .all(limit) as Record<string, unknown>[];
  return rows.map(rowToRecord);
}

/**
 * Get summary statistics for the learning database.
 */
export function getStats(): {
  total: number;
  effective: number;
  ineffective: number;
  topSymptoms: Array<{ symptom: string; count: number }>;
} {
  const db = connect();
  const total = (
    db.prepare("SELECT COUNT(*) as c FROM healing_actions").get() as { c: number }
  ).c;
  const effective = (
    db
      .prepare("SELECT COUNT(*) as c FROM healing_actions WHERE effective = 1")
      .get() as { c: number }
  ).c;
  const topSymptoms = db
    .prepare(
      "SELECT symptom, COUNT(*) as count FROM healing_actions GROUP BY symptom ORDER BY count DESC LIMIT 10"
    )
    .all() as Array<{ symptom: string; count: number }>;

  return { total, effective, ineffective: total - effective, topSymptoms };
}
