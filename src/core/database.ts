import { enforceVisualLock } from "../intelligence/vision-lock.js";
/* eslint-disable @typescript-eslint/no-misused-promises*/
import Database from 'better-sqlite3';
import path from 'node:path';
/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return */
import fs from 'node:fs';

// ── PLAIN TEXT STORAGE (encryption disabled by project rule) ─────────────────
// Passwords are stored as plain JSON strings. No encryption layer.

export function encrypt(text: string): string {
  return text;
}

export function decrypt(text: string): string {
  return text;
}
import chokidar from 'chokidar';
import { createLogger } from './logger.js';
import { parse } from 'csv-parse/sync';

const log = createLogger("DB");

// ── Outcome Classification Vocabulary (Rule 29: strict-single-truth-triggers) ──
// All vocabulary for outcome classifications MUST live here — the single source of truth.
// "Confident" = credential has reached a terminal state and should NOT be retested.
// "Tested" = broader set including non-terminal but informative outcomes.
export const CONFIDENT_OUTCOMES = ['success', '2FA', 'noaccount', 'permdisabled', 'honeypot'] as const;
export const TESTED_OUTCOMES = ['success', 'success-unconfirmed', '2FA', 'noaccount', 'permdisabled', 'honeypot', 'blocked'] as const;

const dbDir = path.resolve(process.cwd(), 'data');
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

export const db = new Database(path.join(dbDir, 'credentials.sqlite'), { timeout: 30000 });
let dbBackupInterval: NodeJS.Timeout | null = null;
let credsWatcher: ReturnType<typeof chokidar.watch> | null = null;

// ── Synchronous Write Execution (Strict WAL Mode, Rule 7) ────────────────────
// Asynchronous write buffering is strictly prohibited.
// Node.js synchronous blocking is expected and required for strict durability.
export function pushToWriteQueue(fn: () => void) {
  try {
    db.transaction(() => {
      try { fn(); } catch (e: unknown) { log.error(`Sync write inner error: ${e instanceof Error ? e.message : String(e)}`); }
    })();
  } catch (e: unknown) {
    log.error(`Sync write transaction error: ${e instanceof Error ? e.message : String(e)}`);
  }
}
const STMT_CACHE_MAX = 200;
const stmtCache = new Map<string, Database.Statement>();
export function getStmt(sql: string): Database.Statement {
  let stmt = stmtCache.get(sql);
  if (stmt) {
    // Move to end (most recently used) by re-inserting
    stmtCache.delete(sql);
    stmtCache.set(sql, stmt);
    return stmt;
  }
  stmt = db.prepare(sql);
  stmtCache.set(sql, stmt);
  // Evict oldest entry if over capacity
  if (stmtCache.size > STMT_CACHE_MAX) {
    const oldest = stmtCache.keys().next().value;
    if (oldest) stmtCache.delete(oldest);
  }
  return stmt;
}

// ── WAL mode ────────────────────────────────────────────────────────────────
// Write-Ahead Logging: writes are immediately durable (crash-safe) and don't
// block readers. This is the recommended mode for applications that need
// instant persistence without explicit fsync calls.
db.pragma('journal_mode = WAL');
// NORMAL synchronous is sufficient with WAL — commits are durable against
// application crashes (only a power failure in the middle of a WAL checkpoint
// could theoretically lose the last transaction, which is acceptable here).
db.pragma('synchronous = NORMAL');
// Foreign-key constraints are declared in the schema but SQLite ignores them
// unless this pragma is set per-connection. Without it, deleting a credential
// would leave orphan test_runs rows accumulating indefinitely.
db.pragma('foreign_keys = ON');
// Performance pragmas: the defaults (2MB cache, no mmap) cause excessive disk
// reads for credential databases with thousands of rows + JSON columns.
db.pragma('cache_size = -64000');     // 64MB page cache (negative = KB)
db.pragma('mmap_size = 268435456');   // 256MB memory-mapped I/O
db.pragma('temp_store = MEMORY');     // Temp tables/indexes in RAM

export function initDB() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS credentials (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      passwords TEXT NOT NULL, -- JSON string array
      password_count INTEGER DEFAULT 0,
      next_batch_index INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS test_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      credential_id INTEGER NOT NULL,
      target_site TEXT NOT NULL,
      outcome TEXT NOT NULL,
      error TEXT,
      session_id TEXT,
      recording_url TEXT,
      final_screenshot_url TEXT,
      batch_index INTEGER DEFAULT 0,
      passwords_tried TEXT, -- JSON string array of passwords attempted
      backend TEXT,
      proxy_region TEXT,
      credits_spent REAL DEFAULT 0,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      duration_ms INTEGER,
      ai_verification_status TEXT DEFAULT 'not verified',
      FOREIGN KEY(credential_id) REFERENCES credentials(id)
    );

    CREATE TABLE IF NOT EXISTS imported_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filename TEXT UNIQUE NOT NULL,
      imported_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- #37 Credit consumption tracking
    CREATE TABLE IF NOT EXISTS credit_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      session_id TEXT,
      credits_spent REAL,
      credential_email TEXT,
      backend TEXT,
      outcome TEXT
    );

    -- #38 Scheduled retest queue
    CREATE TABLE IF NOT EXISTS scheduled_retests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL,
      scheduled_at DATETIME NOT NULL,
      reason TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      completed BOOLEAN DEFAULT 0
    );

    -- #39 Database-backed denylist
    CREATE TABLE IF NOT EXISTS email_denylist_db (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      reason TEXT,
      added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      added_by TEXT DEFAULT 'engine',
      expires_at DATETIME
    );

    -- #40 Incremental progress snapshots
    CREATE TABLE IF NOT EXISTS progress_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      row_index INTEGER,
      email TEXT,
      site TEXT,
      outcome TEXT,
      session_id TEXT,
      data TEXT
    );

    -- #34 Evidence Checksums
    CREATE TABLE IF NOT EXISTS evidence_checksums (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT,
      file_path TEXT,
      file_type TEXT,
      sha256_hash TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Improvement 9: Target Winners
    CREATE TABLE IF NOT EXISTS target_winners (
      target_url TEXT PRIMARY KEY,
      best_backend TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Upgrade 9: Fingerprint Harvesting
    CREATE TABLE IF NOT EXISTS session_fingerprints (
      session_id TEXT PRIMARY KEY,
      email TEXT,
      fingerprint_data TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Single Source of Truth for Current Status
    CREATE TABLE IF NOT EXISTS credential_status (
      credential_id INTEGER NOT NULL,
      target_site TEXT NOT NULL,
      outcome TEXT NOT NULL,
      error TEXT,
      session_id TEXT,
      recording_url TEXT,
      batch_index INTEGER DEFAULT 0,
      passwords_tried TEXT,
      backend TEXT,
      proxy_region TEXT,
      ai_verification_status TEXT DEFAULT 'not verified',
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (credential_id, target_site),
      FOREIGN KEY(credential_id) REFERENCES credentials(id)
    );

    -- Indexes for fast lookups (IF NOT EXISTS is idempotent)
    CREATE INDEX IF NOT EXISTS idx_test_runs_credential_id ON test_runs(credential_id);
    CREATE INDEX IF NOT EXISTS idx_test_runs_outcome ON test_runs(outcome);
    CREATE INDEX IF NOT EXISTS idx_test_runs_cred_site ON test_runs(credential_id, target_site);
    CREATE INDEX IF NOT EXISTS idx_test_runs_timestamp ON test_runs(timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_credit_usage_email ON credit_usage(credential_email);
    CREATE INDEX IF NOT EXISTS idx_credit_usage_backend ON credit_usage(backend);
    CREATE INDEX IF NOT EXISTS idx_scheduled_retests_due ON scheduled_retests(scheduled_at, completed);
    CREATE INDEX IF NOT EXISTS idx_denylist_email ON email_denylist_db(email);
    CREATE INDEX IF NOT EXISTS idx_progress_snapshots_session ON progress_snapshots(session_id);

    -- Apex Enhancement #10: Unified Telemetry Corpus
    CREATE TABLE IF NOT EXISTS session_telemetry (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      email TEXT NOT NULL,
      target_site TEXT NOT NULL,
      backend TEXT,
      proxy_key TEXT,
      proxy_region TEXT,
      fingerprint_seed INTEGER,
      ua_hash TEXT,
      timing_vector TEXT,       -- JSON
      network_metrics TEXT,     -- JSON
      dom_metrics TEXT,         -- JSON
      hermes_interventions INTEGER DEFAULT 0,
      outcome TEXT,
      block_rate_at_time REAL,
      attempt_index INTEGER DEFAULT 0,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_telemetry_session ON session_telemetry(session_id);
    CREATE INDEX IF NOT EXISTS idx_telemetry_outcome ON session_telemetry(outcome);
    CREATE INDEX IF NOT EXISTS idx_telemetry_backend ON session_telemetry(backend);

    -- Ops Revisions (Rollback Tracker)
    CREATE TABLE IF NOT EXISTS ops_revisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      revision_type TEXT NOT NULL, -- 'timing' or 'skill'
      target_id TEXT NOT NULL,
      previous_state TEXT NOT NULL,
      new_state TEXT NOT NULL,
      applied_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      status TEXT DEFAULT 'active' -- 'active' or 'rolled_back'
    );
  `);

    // Schema Migration for new columns
    try {
      db.exec("ALTER TABLE test_runs ADD COLUMN final_screenshot_url TEXT");
    } catch (e: any) {
      if (!e.message.includes('duplicate column name')) throw e;
    }

  // ── Schema migrations for existing databases ─────────────────────────────
  // Add columns that didn't exist in older schema versions. Each ALTER is
  // wrapped in try/catch so it's a no-op if the column already exists.
  const migrations: string[] = [
    `ALTER TABLE credentials ADD COLUMN password_count INTEGER DEFAULT 0`,
    `ALTER TABLE credentials ADD COLUMN next_batch_index INTEGER DEFAULT 0`,
    `ALTER TABLE credentials ADD COLUMN target_sites TEXT DEFAULT '["joe","ignition"]'`,
    `ALTER TABLE test_runs ADD COLUMN batch_index INTEGER DEFAULT 0`,
    `ALTER TABLE test_runs ADD COLUMN passwords_tried TEXT`,
    // #36 — Outcome History Per Credential: new columns on test_runs
    `ALTER TABLE test_runs ADD COLUMN backend TEXT`,
    `ALTER TABLE test_runs ADD COLUMN proxy_region TEXT`,
    `ALTER TABLE test_runs ADD COLUMN credits_spent REAL DEFAULT 0`,
    `ALTER TABLE test_runs ADD COLUMN ai_verification_status TEXT DEFAULT 'not verified'`,
    // #38b — Per-site cooldown tracking on scheduled_retests
    `ALTER TABLE scheduled_retests ADD COLUMN target_site TEXT`,
  ];
  for (const sql of migrations) {
    try { db.exec(sql); } catch { /* column already exists — ok */ }
  }

  // Back-fill password_count for existing rows that have 0
  db.exec(`
    UPDATE credentials
    SET password_count = json_array_length(passwords)
    WHERE password_count = 0 OR password_count IS NULL
  `);

  // Back-fill credential_status if it's empty (migration from legacy test_runs log)
  const statusCount = (getStmt('SELECT COUNT(*) as cnt FROM credential_status').get() as {cnt: number}).cnt;
  if (statusCount === 0) {
    db.exec(`
      INSERT INTO credential_status (credential_id, target_site, outcome, error, session_id, recording_url, batch_index, passwords_tried, backend, proxy_region, ai_verification_status, timestamp)
      SELECT credential_id, target_site, outcome, error, session_id, recording_url, batch_index, passwords_tried, backend, proxy_region, ai_verification_status, timestamp
      FROM (
        SELECT tr.*, ROW_NUMBER() OVER (PARTITION BY tr.credential_id, tr.target_site ORDER BY tr.timestamp DESC) AS rn
        FROM test_runs tr
      ) sub
      WHERE sub.rn = 1;
    `);
  }

  // Fix Gap 1: Orphaned State Deadlocks
  // If the server crashed while credentials were in 'testing' state, reset them to 'queued' so they aren't lost forever
  try {
    const resetStmt = db.prepare(`UPDATE credential_status SET outcome = 'queued' WHERE outcome = 'testing'`);
    const result = resetStmt.run();
    if (result.changes > 0) {
      log.info(`Reset ${result.changes} orphaned 'testing' credentials back to 'queued'`);
    }
  } catch (e: any) {
    log.error(`Failed to reset orphaned testing states: ${e.message}`);
  }

  log.info(`Database initialized (WAL mode, ${countCredentials()} credentials, ${countTestRuns()} test runs)`);

  pruneOldData();
  startDbBackupCron();
  startPruneCron();
}

export function pruneOldData() {
  try {
    const deletedRuns = getStmt(`DELETE FROM test_runs WHERE timestamp < datetime('now', '-30 days')`).run();
    const deletedSnapshots = getStmt(`DELETE FROM progress_snapshots WHERE timestamp < datetime('now', '-30 days')`).run();
    const deletedTelemetry = getStmt(`DELETE FROM session_telemetry WHERE timestamp < datetime('now', '-30 days')`).run();
    const deletedCreditUsage = getStmt(`DELETE FROM credit_usage WHERE timestamp < datetime('now', '-30 days')`).run();
    const deletedChecksums = getStmt(`DELETE FROM evidence_checksums WHERE created_at < datetime('now', '-30 days')`).run();
    const deletedFingerprints = getStmt(`DELETE FROM session_fingerprints WHERE created_at < datetime('now', '-7 days')`).run();
    const completedRetests = getStmt(`DELETE FROM scheduled_retests WHERE completed = 1 AND created_at < datetime('now', '-7 days')`).run();
    log.info(`Pruned old data: ${deletedRuns.changes} test_runs, ${deletedSnapshots.changes} snapshots, ${deletedTelemetry.changes} telemetry, ${deletedCreditUsage.changes} credits, ${deletedChecksums.changes} checksums, ${deletedFingerprints.changes} fingerprints, ${completedRetests.changes} completed retests`);
  } catch (err: unknown) {
    log.error(`Failed to prune old data: ${err instanceof Error ? err.message : String(err)}`);
  }
}

let pruneTimer: ReturnType<typeof setInterval> | null = null;

function startPruneCron(): void {
  if (pruneTimer) return;
  pruneTimer = setInterval(() => pruneOldData(), 3600000);
  pruneTimer.unref?.();
}

export function stopPruneCron(): void {
  if (pruneTimer) {
    clearInterval(pruneTimer);
    pruneTimer = null;
  }
}

export function startDbBackupCron() {
  if (dbBackupInterval) return;
  dbBackupInterval = setInterval(() => {
    try {
      const backupsDir = path.resolve(process.cwd(), 'backups');
      if (!fs.existsSync(backupsDir)) {
        fs.mkdirSync(backupsDir, { recursive: true });
      }
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backupPath = path.join(backupsDir, `credentials-${timestamp}.db`);
      // Rule 41: VACUUM INTO is synchronous and atomic — db.backup() is async
      // and races with concurrent writes, risking incomplete snapshots.
      if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath);
      db.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}' `);
      log.info(`Automated backup created at ${backupPath}`);

      // Rotate: keep only the 5 most recent timestamped backups
      // (skip special files like credentials-pre-update.db and credentials-last-shutdown.db)
      try {
        const files = fs.readdirSync(backupsDir)
          .filter(f => /^credentials-\d{4}-\d{2}/.test(f) && f.endsWith('.db'))
          .sort()
          .reverse();
        const toDelete = files.slice(5); // keep newest 5
        for (const old of toDelete) {
          fs.unlinkSync(path.join(backupsDir, old));
          log.info(`Rotated old backup: ${old}`);
        }
      } catch (pruneErr: unknown) {
        log.warn(`Backup rotation error: ${pruneErr instanceof Error ? pruneErr.message : String(pruneErr)}`);
      }
    } catch (err: unknown) {
      log.error(`Database backup cron error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, 3600000);
  dbBackupInterval.unref?.();
}
export function stopDbBackupCron(): void {
  if (dbBackupInterval) {
    clearInterval(dbBackupInterval);
    dbBackupInterval = null;
    log.info('Stopped automated DB backup cron');
  }
}

export function closeDB() {
  try {
    if (dbBackupInterval) {
      clearInterval(dbBackupInterval);
      dbBackupInterval = null;
    }
    void stopCredentialsWatcher();
    db.close();
    log.info("Database connection closed cleanly.");
  } catch (e: unknown) {
    log.error(`Error closing database: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ── Stats helpers ───────────────────────────────────────────────────────────

export function countCredentials(): number {
  return (getStmt('SELECT COUNT(*) as cnt FROM credentials').get() as { cnt: number }).cnt;
}

export function countTestRuns(): number {
  return (getStmt('SELECT COUNT(*) as cnt FROM test_runs').get() as { cnt: number }).cnt;
}

// ── Ops Revisions (Rollback Mechanism) ──────────────────────────────────────

export function insertRevision(type: string, targetId: string, previousState: string, newState: string): number {
  let id = -1;
  pushToWriteQueue(() => {
    const info = getStmt(
      `INSERT INTO ops_revisions (revision_type, target_id, previous_state, new_state, status) 
       VALUES (?, ?, ?, ?, 'active')`
    ).run(type, targetId, previousState, newState);
    id = info.lastInsertRowid as number;
  });
  return id;
}

export function getLastActiveRevision(): any {
  return getStmt(
    `SELECT * FROM ops_revisions 
     WHERE status = 'active' 
     ORDER BY id DESC LIMIT 1`
  ).get();
}

export function markRevisionRolledBack(id: number, reason: string): void {
  pushToWriteQueue(() => {
    getStmt(
      `UPDATE ops_revisions 
       SET status = 'rolled_back'
       WHERE id = ?`
    ).run(id);
  });
}

// ── CSV Import ──────────────────────────────────────────────────────────────

export async function importCsv(filePath: string, targets: string[] = ["joe", "ignition"]): Promise<void> {
  const filename = path.basename(filePath);

  // Check if already imported
  const stmtCheck = getStmt('SELECT id FROM imported_files WHERE filename = ?');
  if (stmtCheck.get(filename)) {
    log.info(`File ${filename} already imported. Skipping.`);
    return;
  }

  const content = await fs.promises.readFile(filePath, 'utf-8');
  let records: any[];
  try {
    records = parse(content, { columns: true, skip_empty_lines: true, trim: true, relax_column_count: true });
  } catch (e) {
    log.error(`Failed to parse CSV ${filename}: ${String(e)}`);
    return;
  }

  if (records.length === 0) return;

  const headers = Object.keys(records[0]).map(h => h.toLowerCase());
  const hasEmail = headers.includes('email');
  if (!hasEmail) {
    log.error(`CSV ${filename} is missing 'email' column.`);
    return;
  }

  const passwordCols = headers.filter(h => h.startsWith('password'));
  passwordCols.sort((a, b) => {
    const numA = parseInt(a.replace('password', '') || '1');
    const numB = parseInt(b.replace('password', '') || '1');
    return numA - numB;
  });

  if (passwordCols.length === 0) {
    log.error(`CSV ${filename} is missing password columns.`);
    return;
  }

  const insertStmt = getStmt(`
    INSERT INTO credentials (email, passwords, password_count, target_sites)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(email) DO UPDATE SET passwords=excluded.passwords, password_count=excluded.password_count, target_sites=excluded.target_sites
  `);

  const insertMany = db.transaction((rows: any[], targets: string[] = ["joe", "ignition"]) => {
    const targetsJson = JSON.stringify(targets);
    for (const row of rows) {
      const email = row['email'] || row['Email'] || row['EMAIL'];
      if (!email) continue;

      const passwords = passwordCols.map(c => row[c] || row[c.toUpperCase()]).filter(Boolean);
      if (passwords.length === 0) continue;

      insertStmt.run(email, encrypt(JSON.stringify(passwords)), passwords.length, targetsJson);
    }
    getStmt('INSERT INTO imported_files (filename) VALUES (?)').run(filename);
  });

  try {
    // Pass the user-specified target scopes to the database transaction
    insertMany(records, targets);
    log.info(`Imported credentials from ${filename}`);
  } catch (e) {
    // The transaction rolls back on throw inside `db.transaction(...)`, but
    // the caller (HTTP upload route / WS upload handler / boot-time CSV scan)
    // needs to know the import failed so it can return a 500 / show an error
    // to the operator. Previously this was logged and swallowed — partial
    // failures looked successful from the dashboard.
    log.error(`Database error while importing ${filename}: ${String(e)}`);
    throw e;
  }
}

// ── Credentials watcher ─────────────────────────────────────────────────────

export function startCredentialsWatcher() {
  if (credsWatcher) return;
  const credsDir = path.resolve(process.cwd(), 'credentials');
  if (!fs.existsSync(credsDir)) {
    fs.mkdirSync(credsDir, { recursive: true });
  }

  // chokidar's `add` event covers both:
  //   • the initial scan at start-up (one `add` per existing file), and
  //   • new files that appear while the server is running.
  // This replaces the prior native `fs.watch` implementation, which suffered
  // from macOS-specific event suppression: files created in-place or moved
  // into the directory mid-run often failed to trigger any callback at all.
  // chokidar normalises across platforms by combining fs-events with an
  // optional polling fallback, and its `awaitWriteFinish` debounce avoids
  // importing a half-written CSV.
  //
  // chokidar v5 dropped glob pattern support, so we watch the directory
  // itself with depth=0 (no subdirs) and filter CSVs in the `add` handler.
  // Native fsevents are unreliable on mounted / non-APFS-root paths such as
  // /Volumes/* — chokidar will register but never fire `add` for files that
  // arrive mid-run. usePolling forces a 1s stat-based scan, which catches
  // every new file regardless of the underlying FS event semantics. The CPU
  // cost on a single directory of ~10s of files is negligible.
  credsWatcher = chokidar.watch(credsDir, {
    ignoreInitial: false,
    persistent: true,
    depth: 0,
    usePolling: true,
    interval: 1000,
    ignored: (filePath: string) => {
      // Only ignore non-CSV and tmp files. The directory itself must pass through
      // (filePath === credsDir on the initial pass).
      if (filePath === credsDir) return false;
      const lower = filePath.toLowerCase();
      return !lower.endsWith('.csv') || lower.endsWith('.tmp');
    },
    awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
  });
  credsWatcher.on('add', async (fullPath: string) => {
    if (!fullPath.toLowerCase().endsWith('.csv')) return;
    try {
      await importCsv(fullPath);
    } catch (e: unknown) {
      log.error(`Watcher import error for ${path.basename(fullPath)}: ${(e instanceof Error ? e.message : String(e)) ?? String(e)}`);
    }
  });
  credsWatcher.on('error', (err: unknown) => {
    log.error(`Credentials watcher error: ${err instanceof Error ? err.message : String(err)}`);
  });
  log.info(`Watching ${credsDir} for new CSV files (chokidar v5).`);
}

export async function stopCredentialsWatcher(): Promise<void> {
  if (!credsWatcher) return;
  const watcher = credsWatcher;
  credsWatcher = null;
  await watcher.close().catch(() => { });
}

// ── Test run persistence (Synchronous WAL) ──────────────────────────

export async function saveTestRun(
  email: string,
  targetSite: string,
  outcome: string,
  error?: string,
  sessionId?: string,
  recordingUrl?: string,
  batchIndex?: number,
  passwordsTried?: string[],
  backend?: string,
  proxyRegion?: string,
  creditsSpent?: number,
  durationMs?: number,
  finalScreenshotUrl?: string,
) {

  // [VISUAL LOCK INTERCEPT]
  const TERMINAL_STATES = ["success", "permanently", "temporarily", "noaccount"];
  if (TERMINAL_STATES.includes(outcome) && finalScreenshotUrl) {
       const absoluteImagePath = require('path').resolve(process.cwd(), finalScreenshotUrl);
       // Enforce lock! (Awaiting since we made this async)
       const lockResult = await enforceVisualLock(absoluteImagePath, outcome);
       if (lockResult === "RATE_LIMIT") {
           console.warn(`[Visual Lock] API Rate Limited for ${email}. Downgrading to 'queued' to retry later.`);
           outcome = "queued";
       } else if (lockResult === "REJECT") {
           console.error(`[Visual Lock] ABORTING database commit for ${email}. Vision model rejected '${outcome}'. Downgrading to 'incorrect'.`);
           outcome = "incorrect";
       }
  }

  pushToWriteQueue(() => {
    try {
      const cred = getStmt('SELECT id FROM credentials WHERE email = ?').get(email) as { id: number } | undefined;
      if (!cred) return;

      const encryptedPasswords = passwordsTried ? encrypt(JSON.stringify(passwordsTried)) : null;

      getStmt(`
        INSERT INTO test_runs (credential_id, target_site, outcome, error, session_id, recording_url, batch_index, passwords_tried, backend, proxy_region, credits_spent, duration_ms, final_screenshot_url)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        cred.id, targetSite, outcome, error || null,
        sessionId || null, recordingUrl || null,
        batchIndex ?? 0,
        encryptedPasswords,
        backend || null,
        proxyRegion || null,
        creditsSpent || 0,
        durationMs || null,
        finalScreenshotUrl || null
      );

      getStmt(`
        INSERT INTO credential_status (credential_id, target_site, outcome, error, session_id, recording_url, batch_index, passwords_tried, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(credential_id, target_site) DO UPDATE SET
          outcome = CASE
            WHEN credential_status.outcome IN ('success', '2FA', 'permdisabled', 'tempdisabled', 'honeypot')
              AND excluded.outcome IN ('noaccount', 'tempdisabled', 'inconclusive', 'incorrect', 'other', 'queued', 'testing', 'skipped', 'N/A')
            THEN credential_status.outcome
            WHEN credential_status.outcome = 'noaccount'
              AND excluded.outcome IN ('inconclusive', 'incorrect', 'other', 'queued', 'testing', 'skipped', 'N/A')
            THEN credential_status.outcome
            ELSE excluded.outcome
          END,
          error = excluded.error,
          session_id = excluded.session_id,
          recording_url = excluded.recording_url,
          batch_index = excluded.batch_index,
          passwords_tried = excluded.passwords_tried,
          timestamp = excluded.timestamp
      `).run(
        cred.id, targetSite, outcome, error || null,
        sessionId || null, recordingUrl || null,
        batchIndex ?? 0,
        encryptedPasswords,
      );
    } catch (e: unknown) {
      log.error(`Failed to save test run asynchronously: ${e instanceof Error ? e.message : String(e)}`);
    }
  });
}

export function updateAiVerificationStatus(sessionId: string, status: 'verifying' | 'verified' | 'not verified') {
  pushToWriteQueue(() => {
    getStmt('UPDATE test_runs SET ai_verification_status = ? WHERE session_id = ?').run(status, sessionId);
    getStmt('UPDATE credential_status SET ai_verification_status = ? WHERE session_id = ?').run(status, sessionId);
  });
}

export function updateRecordingUrl(email: string, url: string) {
  pushToWriteQueue(() => {
    const cred = getStmt('SELECT id FROM credentials WHERE email = ?').get(email) as { id: number } | undefined;
    if (!cred) return;
    getStmt(`
      UPDATE test_runs
      SET recording_url = ?
      WHERE credential_id = ?
      ORDER BY id DESC LIMIT 1
    `).run(url, cred.id);
  });
}

export function updateScreenshotUrl(email: string, outcome: string, url: string) {
  pushToWriteQueue(() => {
    const cred = getStmt('SELECT id FROM credentials WHERE email = ?').get(email) as { id: number } | undefined;
    if (!cred) return;
    getStmt(`
      UPDATE test_runs
      SET final_screenshot_url = ?
      WHERE credential_id = ? AND outcome = ?
      ORDER BY id DESC LIMIT 1
    `).run(url, cred.id, outcome);
  });
}

export function saveSessionFingerprint(sessionId: string, email: string, fingerprintData: any) {
  pushToWriteQueue(() => {
    try {
      getStmt(`
        INSERT INTO session_fingerprints (session_id, email, fingerprint_data)
        VALUES (?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET fingerprint_data = excluded.fingerprint_data
      `).run(sessionId, email, JSON.stringify(fingerprintData));
    } catch (e: unknown) {
      log.error(`Failed to save session fingerprint asynchronously: ${e instanceof Error ? e.message : String(e)}`);
    }
  });
}
// ── Batch index persistence ─────────────────────────────────────────────────

/** Get the next batch index for a credential on a specific site. Returns 0 if unset. */
export function getNextBatchIndex(email: string, site: string): number {
  const cred = getStmt('SELECT id FROM credentials WHERE email = ?').get(email) as { id: number } | undefined;
  if (!cred) return 0;
  const row = getStmt('SELECT batch_index FROM credential_status WHERE credential_id = ? AND target_site = ?').get(cred.id, site) as { batch_index: number } | undefined;
  if (row === undefined) {
    const legacy = getStmt('SELECT next_batch_index FROM credentials WHERE id = ?').get(cred.id) as { next_batch_index: number } | undefined;
    return legacy?.next_batch_index ?? 0;
  }
  return row.batch_index ?? 0;
}

/** Advance the batch index for a credential on a specific site. Called when tempDisabled fires. */
export function advanceBatchIndex(email: string, site: string, newIndex: number): void {
  const cred = getStmt('SELECT id FROM credentials WHERE email = ?').get(email) as { id: number } | undefined;
  if (!cred) return;
  getStmt('UPDATE credential_status SET batch_index = ? WHERE credential_id = ? AND target_site = ?').run(newIndex, cred.id, site);
}

/** Reset the batch index for a credential back to 0 on a specific site. */
export function resetBatchIndex(email: string, site: string): void {
  const cred = getStmt('SELECT id FROM credentials WHERE email = ?').get(email) as { id: number } | undefined;
  if (!cred) return;
  getStmt('UPDATE credential_status SET batch_index = 0 WHERE credential_id = ? AND target_site = ?').run(cred.id, site);
}

/** Get the total password count for a credential. */
export function getPasswordCount(email: string): number {
  const row = getStmt('SELECT password_count FROM credentials WHERE email = ?').get(email) as { password_count: number } | undefined;
  return row?.password_count ?? 0;
}

// ── Credential queries ──────────────────────────────────────────────────────

export function getUntestedCredentials(targetSites: string[]): { email: string, passwords: string[] }[] {
  // A credential is "untested" if it has at least one target in its target_sites array
  // that intersects with the requested targetSites, AND that target does NOT have a confident outcome.
  if (!targetSites || targetSites.length === 0) return [];

  const placeholders = CONFIDENT_OUTCOMES.map(() => '?').join(',');
  const sitePlaceholders = targetSites.map(() => '?').join(',');

  // Use json_each to unpack the target_sites array. COALESCE ensures we fallback to the default array
  // if the field is null or missing.
  const stmt = getStmt(`
    SELECT c.id, c.email, c.passwords, c.target_sites
    FROM credentials c
    WHERE EXISTS (
      SELECT 1 FROM json_each(COALESCE(c.target_sites, '["joe","ignition"]')) js
      WHERE js.value IN (${sitePlaceholders})
      AND NOT EXISTS (
        SELECT 1 FROM credential_status cs
        WHERE cs.credential_id = c.id
        AND cs.target_site = js.value
        AND cs.outcome IN (${placeholders})
      )
    )
  `);

  const rows = stmt.all(...targetSites, ...CONFIDENT_OUTCOMES) as any[];
  return rows.map(r => ({
    email: r.email,
    passwords: (() => { try { return JSON.parse(decrypt(r.passwords)); } catch { return []; } })(),
    target_sites: (() => { try { return JSON.parse(r.target_sites || '["joe","ignition"]'); } catch { return ["joe","ignition"]; } })()
  }));
}

/** Return credentials with decrypted passwords for a specific set of emails.
 *  Unlike getUntestedCredentials, this does NOT filter by test status — it
 *  returns any credential whose email is in the provided list, allowing the
 *  operator to re-run already-tested credentials from the dashboard. */
export function getCredentialsByEmails(emails: string[]): { email: string, passwords: string[], target_sites?: string[] }[] {
  if (!emails || emails.length === 0) return [];
  const CHUNK_SIZE = 900; // SQLite IN clause limit
  const results: { email: string, passwords: string[], target_sites?: string[] }[] = [];
  for (let i = 0; i < emails.length; i += CHUNK_SIZE) {
    const chunk = emails.slice(i, i + CHUNK_SIZE);
    const placeholders = chunk.map(() => '?').join(',');
    const stmt = getStmt(`SELECT email, passwords, target_sites FROM credentials WHERE email IN (${placeholders})`);
    const rows = stmt.all(...chunk) as any[];
    for (const r of rows) {
      results.push({
        email: r.email,
        passwords: (() => { try { return JSON.parse(decrypt(r.passwords)); } catch { return []; } })(),
        target_sites: (() => { try { return JSON.parse(r.target_sites || '["joe","ignition"]'); } catch { return ["joe","ignition"]; } })()
      });
    }
  }
  return results;
}

export function getAllCredentialsHistory() {
  const stmt = getStmt(`
    SELECT c.email, tr.target_site, tr.outcome, tr.error, tr.session_id, tr.recording_url, tr.timestamp
    FROM credentials c
    LEFT JOIN test_runs tr ON c.id = tr.credential_id
    ORDER BY tr.timestamp DESC
  `);
  return stmt.all();
}

export interface TempDisabledCategory {
  error: string;
  count: number;
  results: {
    email: string;
    target_site: string;
    session_id: string;
    timestamp: string;
  }[];
}

export function getCategorizedTempDisabled(): TempDisabledCategory[] {
  const stmt = getStmt(`
    SELECT error, COUNT(*) as count, json_group_array(json_object('email', email, 'target_site', target_site, 'session_id', session_id, 'timestamp', timestamp)) as results
    FROM (
      SELECT c.email, tr.target_site, tr.error, tr.session_id, tr.timestamp,
             ROW_NUMBER() OVER (PARTITION BY tr.credential_id, tr.target_site ORDER BY tr.timestamp DESC) AS rn
      FROM test_runs tr
      JOIN credentials c ON tr.credential_id = c.id
      WHERE tr.outcome = 'tempdisabled'
    ) sub
    WHERE sub.rn = 1
    GROUP BY error
    ORDER BY count DESC
  `);
  const rows = stmt.all() as { error: string, count: number, results: string }[];
  return rows.map(r => ({
    error: r.error || "Unknown Error",
    count: r.count,
    results: JSON.parse(r.results)
  }));
}

// ── State restoration (hydrate dashboard on server reload) ──────────────────

/** Return the LATEST test result per credential per site. Used to rebuild
 *  the dashboard row table after a server restart so the operator sees the
 *  current state of every credential, not a blank slate.
 *
 *  Returns an array shaped like the engine's RowStatus[] so the dashboard
 *  can render it identically to a live run. */
export interface RestoredSiteStatus {
  outcome: string;
  attempts: number;
  error?: string;
  sessionId?: string;
  recordingUrl?: string;
  timestamp?: string;
  aiVerificationStatus?: string;
}

export interface RestoredRow {
  email: string;
  status: "done" | "queued";
  sites: { [siteName: string]: RestoredSiteStatus };
  sessionId?: string;
  recordingUrl?: string;
  currentBatch: number;
  totalPasswords: number;
  passwordsTried: number;
  totalBatches: number;
  target_sites: string[];
}

export function getLatestResultsPerCredential(targetSites: string[]): RestoredRow[] {
  if (targetSites.length === 0) return [];

  const siteFilter = targetSites.map(() => '?').join(',');
  const stmt = getStmt(`
    SELECT c.id as cred_id, c.email, c.password_count, c.next_batch_index, c.target_sites,
           cs.target_site, cs.outcome, cs.error, cs.session_id, cs.recording_url, cs.timestamp,
           cs.batch_index, cs.passwords_tried, cs.ai_verification_status
    FROM credentials c
    INNER JOIN credential_status cs ON cs.credential_id = c.id
    WHERE cs.target_site IN (${siteFilter})
    ORDER BY c.email, cs.target_site
  `);

  const rows = stmt.all(...targetSites) as any[];

  const credIds = Array.from(new Set(rows.map(r => r.cred_id)));
  const pwCounts = new Map<number, number>();

  if (credIds.length > 0) {
    const CHUNK_SIZE = 900; // SQLite limit for IN clause
    for (let i = 0; i < credIds.length; i += CHUNK_SIZE) {
      const chunk = credIds.slice(i, i + CHUNK_SIZE);
      const pwStmt = getStmt(`
        SELECT credential_id, passwords_tried FROM credential_status
        WHERE passwords_tried IS NOT NULL AND credential_id IN (${chunk.map(()=>'?').join(',')})
      `);
      const pwRows = pwStmt.all(...chunk) as any[];
      const pwTriedSet = new Map<number, Set<string>>();
      for (const pwRow of pwRows) {
        if (!pwTriedSet.has(pwRow.credential_id)) pwTriedSet.set(pwRow.credential_id, new Set());
        try {
          let parsed: string[] = [];
          try { parsed = JSON.parse(decrypt(pwRow.passwords_tried)); } catch { /* intentional */ }
          if (Array.isArray(parsed)) {
            for (const p of parsed) pwTriedSet.get(pwRow.credential_id)!.add(String(p));
          }
        } catch { /* intentional */ }
      }
      for (const [cid, set] of pwTriedSet) {
        pwCounts.set(cid, set.size);
      }
    }
  }

  for (const r of rows) {
    r.total_passwords_tried = pwCounts.get(r.cred_id) || 0;
  }

  // Group by email into RowStatus-shaped objects
  const byEmail = new Map<string, RestoredRow>();

  for (const r of rows) {
    let row = byEmail.get(r.email);
    if (!row) {
      const totalPw = r.password_count || 0;
      const totalBatches = Math.ceil(totalPw / 3) || 1;
      let ts = ["joe", "ignition"];
      try { ts = JSON.parse(r.target_sites || '["joe","ignition"]'); } catch { /* intentional */ }
      row = {
        email: r.email,
        status: "done",
        sites: {},
        sessionId: r.session_id || undefined,
        recordingUrl: r.recording_url || undefined,
        currentBatch: r.next_batch_index ?? 0,
        totalPasswords: totalPw,
        passwordsTried: r.total_passwords_tried || 0,
        totalBatches,
        target_sites: ts,
      };
      byEmail.set(r.email, row);
    }
    row.sites[r.target_site] = {
      outcome: r.outcome,
      attempts: 1,
      error: r.error || undefined,
      sessionId: r.session_id || undefined,
      recordingUrl: r.recording_url || undefined,
      timestamp: r.timestamp || undefined,
      aiVerificationStatus: r.ai_verification_status || 'not verified',
    };
    // Use the most recent session/recording across all sites
    if (r.session_id) row.sessionId = r.session_id;
    if (r.recording_url) row.recordingUrl = r.recording_url;
  }

  return Array.from(byEmail.values());
}

/** Return the set of distinct passwords already attempted for a given
 *  (email, site) across ALL prior test_runs. Used by the engine to skip
 *  already-tried passwords on a requeued credential — particularly after a
 *  row-timeout requeue where the prior attempt's `passwords_tried` was
 *  recorded but the batch index was not advanced. */
export function getPasswordsTriedForEmailSite(email: string, site: string): string[] {
  const cred = getStmt('SELECT id FROM credentials WHERE email = ?').get(email) as { id: number } | undefined;
  if (!cred) return [];
  const runs = getStmt(
    `SELECT passwords_tried FROM credential_status WHERE credential_id = ? AND target_site = ? AND passwords_tried IS NOT NULL`
  ).all(cred.id, site) as { passwords_tried: string }[];

  const tried = new Set<string>();
  for (const r of runs) {
    try {
      let parsed: string[] = [];
      try { parsed = JSON.parse(decrypt(r.passwords_tried)); } catch { /* intentional */ }
      if (Array.isArray(parsed)) {
        for (const p of parsed) tried.add(String(p));
      }
    } catch { /* intentional */ }
  }
  return Array.from(tried);
}

/** Count the total number of unique passwords that have been tried for a
 *  credential across all test runs. */

/** Get ALL credentials with their latest status for each target site.
 *  Credentials with no test runs yet get status "queued" with empty sites.
 *  This is the primary boot-time function to hydrate the full dashboard. */
export function getAllCredentialsWithLatestStatus(targetSites: string[]): RestoredRow[] {
  if (!targetSites || targetSites.length === 0) return [];

  // Get all credentials with their password info
  const allCreds = getStmt(
    'SELECT email, password_count, next_batch_index, target_sites FROM credentials ORDER BY email'
  ).all() as { email: string; password_count: number; next_batch_index: number; target_sites: string }[];

  // Get latest results for those that have been tested
  const testedResults = getLatestResultsPerCredential(targetSites);
  const testedMap = new Map(testedResults.map(r => [r.email, r]));

  const result: RestoredRow[] = [];
  for (const cred of allCreds) {
    const totalPw = cred.password_count || 0;
    const totalBatches = Math.ceil(totalPw / 3) || 1;
    const existing = testedMap.get(cred.email);
    if (existing) {
      // Evaluate if the credential is fully "done" across all target sites
      const confidentSet = new Set<string>(CONFIDENT_OUTCOMES);
      let ts = ["joe", "ignition"];
      try { ts = JSON.parse(cred.target_sites || '["joe","ignition"]'); } catch { /* intentional */ }
      const relevantSites = targetSites.filter(t => ts.includes(t));
      for (const site of relevantSites) {
        const siteData = existing.sites[site];
        if (!siteData) {
          existing.sites[site] = { outcome: "queued", attempts: 0 };
          existing.status = "queued"; // Missing site = not done
        } else if (!confidentSet.has(siteData.outcome)) {
          existing.status = "queued"; // Non-confident outcome = not done
        }
      }
      for (const site of Object.keys(existing.sites)) {
        if (!ts.includes(site)) {
          delete existing.sites[site];
        }
      }
      result.push(existing);
    } else {
      // Never tested — all sites queued
      let ts = ["joe", "ignition"];
      try { ts = JSON.parse(cred.target_sites || '["joe","ignition"]'); } catch { /* intentional */ }
      const sites: { [k: string]: RestoredSiteStatus } = {};
      const relevantSites = targetSites.filter(t => ts.includes(t));
      for (const site of relevantSites) {
        sites[site] = { outcome: "queued", attempts: 0 };
      }
      result.push({
        email: cred.email,
        status: "queued",
        sites,
        currentBatch: cred.next_batch_index ?? 0,
        totalPasswords: totalPw,
        passwordsTried: 0,
        totalBatches,
        target_sites: ts,
      });
    }
  }

  return result;
}

/** Summary stats for the boot log. */
export function getResultSummary(targetSites: string[]): { [outcome: string]: number } {
  if (targetSites.length === 0) return {};
  const siteFilter = targetSites.map(() => '?').join(',');
  const stmt = getStmt(`
    SELECT outcome, COUNT(*) as cnt
    FROM credential_status
    WHERE target_site IN (${siteFilter})
    GROUP BY outcome
  `);
  const rows = stmt.all(...targetSites) as { outcome: string; cnt: number }[];
  const summary: { [k: string]: number } = {};
  for (const r of rows) summary[r.outcome] = r.cnt;
  return summary;
}

export interface SiteSpecificStats {
  untested: number;
  tested: number;
  permDisabled: number;
  total: number;
}

export function getSiteSpecificStats(targetSites: string[]): Record<string, SiteSpecificStats> {
  const result: Record<string, SiteSpecificStats> = {};
  for (const t of targetSites) {
    result[t] = { untested: 0, tested: 0, permDisabled: 0, total: 0 };
  }

  // Count total credentials scoped to each site
  const allCreds = getStmt('SELECT target_sites FROM credentials').all() as { target_sites: string | null }[];
  for (const c of allCreds) {
    let ts = ["joe", "ignition"];
    try { ts = JSON.parse(c.target_sites || '["joe","ignition"]'); } catch { /* intentional */ }
    for (const t of ts) {
      if (result[t]) result[t].total++;
    }
  }

  // Count outcomes per site
  if (targetSites.length > 0) {
    const siteFilter = targetSites.map(() => '?').join(',');
    const stmt = getStmt(`
      SELECT target_site, outcome, COUNT(*) as cnt
      FROM credential_status
      WHERE target_site IN (${siteFilter})
      GROUP BY target_site, outcome
    `);
    const rows = stmt.all(...targetSites) as { target_site: string; outcome: string; cnt: number }[];

    // Tested outcomes = anything that isn't just queued, N/A, preemptive-block, or tempdisabled
    // Note: tempdisabled will be retested, so it's not "done".
    const testedOutcomes = new Set<string>(TESTED_OUTCOMES);

    for (const r of rows) {
      const stats = result[r.target_site];
      if (!stats) continue;

      if (r.outcome === "permdisabled") {
        stats.permDisabled += r.cnt;
      }

      if (testedOutcomes.has(r.outcome)) {
        stats.tested += r.cnt;
      }
    }
  }

  // Untested is derived: total - tested
  for (const t of targetSites) {
    const stats = result[t];
    if (stats) {
      stats.untested = Math.max(0, stats.total - stats.tested);
    }
  }

  return result;
}

// ═══════════════════════════════════════════════════════════════════════════
// #36 — Outcome History Per Credential
// ═══════════════════════════════════════════════════════════════════════════

export interface OutcomeHistoryEntry {
  id: number;
  target_site: string;
  outcome: string;
  error: string | null;
  session_id: string | null;
  recording_url: string | null;
  batch_index: number;
  backend: string | null;
  proxy_region: string | null;
  credits_spent: number;
  timestamp: string;
}

/** Return the full outcome history for a credential across all test runs. */
export function getOutcomeHistory(email: string): OutcomeHistoryEntry[] {
  const cred = getStmt('SELECT id FROM credentials WHERE email = ?').get(email) as { id: number } | undefined;
  if (!cred) return [];
  return getStmt(`
    SELECT tr.id, tr.target_site, tr.outcome, tr.error, tr.session_id,
           tr.recording_url, tr.batch_index, tr.backend, tr.proxy_region,
           tr.credits_spent, tr.timestamp
    FROM test_runs tr
    WHERE tr.credential_id = ?
    ORDER BY tr.timestamp DESC
  `).all(cred.id) as OutcomeHistoryEntry[];
}

// ═══════════════════════════════════════════════════════════════════════════
// CSV Results Exporter
// ═══════════════════════════════════════════════════════════════════════════

export function exportResultsAsCSV(): string {
  const stmt = getStmt(`
    SELECT c.email, cs.target_site, cs.outcome, cs.error, cs.session_id, cs.timestamp, cs.backend, cs.proxy_region
    FROM credential_status cs
    JOIN credentials c ON c.id = cs.credential_id
    ORDER BY c.email, cs.target_site
  `);
  const rows = stmt.all() as any[];

  if (rows.length === 0) return "email,target_site,outcome,error,session_id,timestamp,backend,proxy_region\n";

  const headers = ["email", "target_site", "outcome", "error", "session_id", "timestamp", "backend", "proxy_region"];

  // Escape CSV fields
  const escapeCsv = (val: any) => {
    if (val === null || val === undefined) return "";
    const str = String(val);
    if (str.includes(",") || str.includes("\n") || str.includes("\r") || str.includes("\"")) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };

  const lines = rows.map(r => headers.map(h => escapeCsv(r[h])).join(","));
  return [headers.join(","), ...lines].join("\n");
}

// ═══════════════════════════════════════════════════════════════════════════
// #37 — Credit Consumption Tracking
// ═══════════════════════════════════════════════════════════════════════════

/** Record a credit usage event. */
export function recordCreditUsage(
  sessionId: string,
  creditsSpent: number,
  credentialEmail: string,
  backend: string,
  outcome: string,
): void {
  getStmt(`
    INSERT INTO credit_usage (session_id, credits_spent, credential_email, backend, outcome)
    VALUES (?, ?, ?, ?, ?)
  `).run(sessionId, creditsSpent, credentialEmail, backend, outcome);
}

export interface CreditSummary {
  totalCreditsSpent: number;
  averagePerCredential: number;
  byBackend: { backend: string; credits: number }[];
}

/** Return aggregate credit usage stats. */
export function getCreditSummary(): CreditSummary {
  const total = getStmt(
    'SELECT COALESCE(SUM(credits_spent), 0) as total FROM credit_usage'
  ).get() as { total: number };

  const distinctEmails = getStmt(
    'SELECT COUNT(DISTINCT credential_email) as cnt FROM credit_usage'
  ).get() as { cnt: number };

  const byBackend = getStmt(`
    SELECT backend, COALESCE(SUM(credits_spent), 0) as credits
    FROM credit_usage
    GROUP BY backend
    ORDER BY credits DESC
  `).all() as { backend: string; credits: number }[];

  return {
    totalCreditsSpent: total.total,
    averagePerCredential: distinctEmails.cnt > 0 ? total.total / distinctEmails.cnt : 0,
    byBackend,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// #38 — Scheduled Retest Queue
// ═══════════════════════════════════════════════════════════════════════════

export interface ScheduledRetest {
  id: number;
  email: string;
  scheduled_at: string;
  reason: string | null;
  /** Which site triggered the temp-disable (per-site cooldown tracking). */
  target_site?: string | null;
  created_at: string;
  completed: number;
}

/** Schedule a credential for retesting at a future time.
 *  `targetSite` is stored in the dedicated column for fast per-site queries
 *  and also encoded in `reason` for backward-compat with older rows. */
export function scheduleRetest(email: string, scheduledAt: string, reason?: string, targetSite?: string): void {
  getStmt(`
    INSERT INTO scheduled_retests (email, scheduled_at, reason, target_site)
    VALUES (?, ?, ?, ?)
  `).run(email, scheduledAt, reason ?? null, targetSite ?? null);
}

/** Return retests that are due (scheduled_at <= now AND not yet completed). */
export function getDueRetests(): ScheduledRetest[] {
  return getStmt(`
    SELECT id, email, scheduled_at, reason, target_site, created_at, completed
    FROM scheduled_retests
    WHERE scheduled_at <= datetime('now') AND completed = 0
    ORDER BY scheduled_at ASC
  `).all() as ScheduledRetest[];
}

/** Return all pending (not yet due) retests — useful for dashboard display. */
export function getPendingRetests(): ScheduledRetest[] {
  return getStmt(`
    SELECT id, email, scheduled_at, reason, target_site, created_at, completed
    FROM scheduled_retests
    WHERE scheduled_at > datetime('now') AND completed = 0
    ORDER BY scheduled_at ASC
  `).all() as ScheduledRetest[];
}

/** Mark a scheduled retest as completed. */
export function markRetestComplete(id: number): void {
  getStmt('UPDATE scheduled_retests SET completed = 1 WHERE id = ?').run(id);
}

// ═══════════════════════════════════════════════════════════════════════════
// #39 — Database-Backed Denylist
// ═══════════════════════════════════════════════════════════════════════════

export interface DenylistEntry {
  id: number;
  email: string;
  reason: string | null;
  added_at: string;
  added_by: string;
  expires_at: string | null;
}

/** Add an email to the database denylist. */
export function addToDenylistDb(
  email: string,
  reason: string,
  addedBy?: string,
  expiresAt?: string,
): void {
  getStmt(`
    INSERT INTO email_denylist_db (email, reason, added_by, expires_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(email) DO UPDATE SET reason=excluded.reason, added_by=excluded.added_by, expires_at=excluded.expires_at, added_at=CURRENT_TIMESTAMP
  `).run(email, reason, addedBy ?? 'engine', expiresAt ?? null);
}

/** Check whether an email is currently on the denylist (active, not expired). */
export function isInDenylistDb(email: string): boolean {
  const row = getStmt(`
    SELECT id FROM email_denylist_db
    WHERE email = ? AND (expires_at IS NULL OR expires_at > datetime('now'))
  `).get(email);
  return !!row;
}

/** Return all currently-active denylist entries. */
export function getActiveDenylist(): DenylistEntry[] {
  return getStmt(`
    SELECT id, email, reason, added_at, added_by, expires_at
    FROM email_denylist_db
    WHERE expires_at IS NULL OR expires_at > datetime('now')
    ORDER BY added_at DESC
  `).all() as DenylistEntry[];
}

/** Remove an email from the denylist. */
export function removeFromDenylistDb(email: string): void {
  getStmt('DELETE FROM email_denylist_db WHERE email = ?').run(email);
}

// ═══════════════════════════════════════════════════════════════════════════
// #40 — Incremental Progress Snapshots
// ═══════════════════════════════════════════════════════════════════════════

/** Append a progress snapshot row (replaces atomic full-rewrite of
 *  progress.json with append-only inserts). */
export function appendProgressSnapshot(
  rowIndex: number,
  email: string,
  site: string,
  outcome: string,
  sessionId: string,
  extraData?: Record<string, unknown>,
): void {
  try {
    getStmt(`
      INSERT INTO progress_snapshots (row_index, email, site, outcome, session_id, data)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      rowIndex,
      email,
      site,
      outcome,
      sessionId,
      extraData ? JSON.stringify(extraData) : null,
    );
  } catch (e: unknown) {
    log.error(`Failed to append progress snapshot for ${email} @ ${site}: ${String(e)}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// #34 — Evidence Integrity Checksums
// ═══════════════════════════════════════════════════════════════════════════

export function saveEvidenceChecksum(
  sessionId: string | undefined,
  filePath: string,
  fileType: "screenshot" | "recording",
  sha256Hash: string
): void {
  try {
    getStmt(`
      INSERT INTO evidence_checksums (session_id, file_path, file_type, sha256_hash)
      VALUES (?, ?, ?, ?)
    `).run(sessionId || null, filePath, fileType, sha256Hash);
  } catch (e) {
    log.error(`Failed to save evidence checksum: ${String(e)}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Target Winners (Improvement 9)
// ═══════════════════════════════════════════════════════════════════════════

export function saveTargetWinner(targetUrl: string, backend: string): void {
  getStmt(`
    INSERT INTO target_winners (target_url, best_backend, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(target_url) DO UPDATE SET best_backend = excluded.best_backend, updated_at = CURRENT_TIMESTAMP
  `).run(targetUrl, backend);
}

export function getTargetWinners(): { target_url: string, best_backend: string }[] {
  return getStmt('SELECT target_url, best_backend FROM target_winners').all() as any[];
}

export function saveFingerprintData(sessionId: string, email: string, fingerprintData: any): void {
  const stmt = getStmt(`
    INSERT INTO session_fingerprints (session_id, email, fingerprint_data)
    VALUES (?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      fingerprint_data = excluded.fingerprint_data
  `);
  try {
    stmt.run(sessionId, email, JSON.stringify(fingerprintData));
  } catch (e) {
    log.error(`Failed to save fingerprint data: ${String(e)}`);
  }
}