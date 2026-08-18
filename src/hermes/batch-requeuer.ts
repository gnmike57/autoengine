/**
 * Hermes Batch Requeuer — Phase 2
 *
 * Scans the automation database for credentials that need re-testing
 * and builds optimal retry batches with exponential backoff.
 *
 * A credential is eligible for re-queue if:
 *   - Its last outcome was N/A, error, blocked, tempdisabled (cooldown elapsed), or untested
 *   - Its backoff cooldown has elapsed
 *
 * Terminal outcomes that are NEVER re-queued:
 *   success, noaccount, permdisabled, 2FA
 *
 * NOTE: "tempdisabled" is NOT terminal — it is a temporary 1-hour cooldown.
 * The TempDisabledScheduler handles automatic requeue after the cooldown expires.
 * This requeuer also picks up tempdisabled credentials whose cooldown has elapsed.
 */

import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import { createLogger } from "../core/logger.js";

const log = createLogger("BatchRequeuer");

const DB_PATH = path.join(process.cwd(), "data", "credentials.sqlite");

// Outcomes that are considered permanently terminal — never re-queue under any circumstances.
// "tempdisabled" is intentionally NOT in this list — it is a temporary state.
const TERMINAL_OUTCOMES = new Set([
  "success",
  "noaccount",
  "permdisabled",
  "2FA",
]);

/** How long a tempdisabled cooldown lasts (1 hour in ms). */
const TEMPDISABLED_COOLDOWN_MS = 60 * 60 * 1000;

// Outcomes that trigger re-queue (prefix match)
const REQUEUEABLE_PREFIXES = ["N/A", "error", "blocked", "api-error", "tempdisabled"];

interface CredentialRow {
  email: string;
  passwords: string;
  outcome: string | null;
  last_tested_at: string | null;
  retry_count: number;
}

export interface RequeueResult {
  /** Credentials eligible for re-testing */
  credentials: Array<{ email: string; passwords: string[] }>;
  /** Total scanned */
  totalScanned: number;
  /** Skipped (terminal) */
  terminalCount: number;
  /** Skipped (cooldown — includes tempdisabled still in 1hr window) */
  cooldownCount: number;
  /** Recommended batch size */
  recommendedBatchSize: number;
}

export interface RequeuerConfig {
  /** Backoff schedule in seconds: [1st retry delay, 2nd, 3rd, ...] */
  backoffSchedule?: number[];
  /** Maximum batch size (default: 50) */
  maxBatchSize?: number;
  /** Database path override (for testing) */
  dbPath?: string;
}

/**
 * Calculate the backoff delay in milliseconds for a given retry count.
 * Default schedule: 2min, 5min, 15min
 */
function getBackoffMs(retryCount: number, schedule: number[]): number {
  const idx = Math.min(retryCount, schedule.length - 1);
  return (schedule[idx] ?? schedule[schedule.length - 1] ?? 120) * 1000;
}

/**
 * Scan the automation database and return credentials eligible for re-testing.
 */
export function scanForRequeue(config: RequeuerConfig = {}): RequeueResult {
  const {
    backoffSchedule = [120, 300, 900], // 2min, 5min, 15min
    maxBatchSize = 50,
    dbPath = DB_PATH,
  } = config;

  if (!fs.existsSync(dbPath)) {
    log.warn(`Database not found at ${dbPath}`);
    return {
      credentials: [],
      totalScanned: 0,
      terminalCount: 0,
      cooldownCount: 0,
      recommendedBatchSize: 0,
    };
  }

  const db = new Database(dbPath, { readonly: true });
  try {
    db.pragma("journal_mode = WAL");
  } catch {
    // Ignore error if readonly connection cannot set pragma
  }

  try {
    let rows: CredentialRow[] = [];

    try {
      rows = db
        .prepare(
          `SELECT
            email,
            passwords,
            outcome,
            last_tested_at,
            COALESCE(retry_count, 0) as retry_count
          FROM credentials
          ORDER BY last_tested_at ASC NULLS FIRST`
        )
        .all() as CredentialRow[];
    } catch {
      // Fallback: try simpler schema
      try {
        rows = db
          .prepare(
            `SELECT
              email,
              passwords,
              outcome,
              NULL as last_tested_at,
              0 as retry_count
            FROM credentials`
          )
          .all() as CredentialRow[];
      } catch (e) {
        log.warn(`Failed to query credentials: ${e instanceof Error ? e.message : String(e)}`);
        return {
          credentials: [],
          totalScanned: 0,
          terminalCount: 0,
          cooldownCount: 0,
          recommendedBatchSize: 0,
        };
      }
    }

    const now = Date.now();

    const eligible: Array<{ email: string; passwords: string[] }> = [];
    let terminalCount = 0;
    let cooldownCount = 0;

    for (const row of rows) {
      const outcome = row.outcome?.trim() ?? "";

      // Skip permanently terminal outcomes
      if (TERMINAL_OUTCOMES.has(outcome)) {
        terminalCount++;
        continue;
      }

      // Handle tempdisabled specifically: only eligible if the 1hr cooldown has elapsed
      if (outcome === "tempdisabled") {
        if (row.last_tested_at) {
          const lastTested = new Date(row.last_tested_at).getTime();
          if (now - lastTested < TEMPDISABLED_COOLDOWN_MS) {
            cooldownCount++;
            continue;
          }
          // Cooldown elapsed — eligible for requeue
        }
        // No last_tested_at means we don't know when it was disabled — allow requeue
      } else {
        // Check if this is a requeueable outcome (or never tested)
        const isRequeueable =
          !outcome ||
          REQUEUEABLE_PREFIXES.some((prefix) => outcome.startsWith(prefix));

        if (!isRequeueable) {
          terminalCount++;
          continue;
        }

        // Check backoff cooldown for non-tempdisabled outcomes
        if (row.last_tested_at) {
          const lastTested = new Date(row.last_tested_at).getTime();
          const requiredDelay = getBackoffMs(row.retry_count, backoffSchedule);
          if (now - lastTested < requiredDelay) {
            cooldownCount++;
            continue;
          }
        }
      }

      // Parse passwords
      let passwords: string[] = [];
      try {
        passwords = JSON.parse(row.passwords) as string[];
      } catch {
        passwords = row.passwords ? [row.passwords] : [];
      }

      eligible.push({ email: row.email, passwords });
    }

    const recommendedBatchSize = Math.min(eligible.length, maxBatchSize);
    const batch = eligible.slice(0, recommendedBatchSize);

    log.info(
      `[Requeue Scan] Total: ${rows.length} | Terminal: ${terminalCount} | ` +
      `Cooldown: ${cooldownCount} | Eligible: ${eligible.length} | Batch: ${batch.length}`
    );

    return {
      credentials: batch,
      totalScanned: rows.length,
      terminalCount,
      cooldownCount,
      recommendedBatchSize,
    };
  } finally {
    db.close();
  }
}

/**
 * Check if there are any credentials left to process.
 * Returns true if the queue is fully exhausted (all terminal or all in cooldown).
 */
export function isQueueExhausted(config: RequeuerConfig = {}): boolean {
  const result = scanForRequeue(config);
  return result.credentials.length === 0 && result.cooldownCount === 0;
}
