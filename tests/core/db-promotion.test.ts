/**
 * Test 3: DB credential_status Promotion-Only Guard
 *
 * Verifies the SQL CASE in saveTestRun() that prevents outcome demotion.
 * A regression here loses confirmed successful credentials.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

describe("saveTestRun promotion-only semantics", () => {
  let db: Database.Database;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "db-promo-test-"));
    const dbPath = path.join(tmpDir, "test.db");
    db = new Database(dbPath);
    db.pragma("journal_mode = WAL");

    // Create minimal schema
    db.exec(`
      CREATE TABLE credentials (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT UNIQUE NOT NULL,
        passwords TEXT NOT NULL,
        password_count INTEGER DEFAULT 0,
        next_batch_index INTEGER DEFAULT 0
      );
      CREATE TABLE credential_status (
        credential_id INTEGER NOT NULL,
        target_site TEXT NOT NULL,
        outcome TEXT NOT NULL,
        error TEXT,
        session_id TEXT,
        recording_url TEXT,
        batch_index INTEGER DEFAULT 0,
        passwords_tried TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (credential_id, target_site)
      );
    `);

    // Insert a test credential
    db.prepare("INSERT INTO credentials (email, passwords) VALUES (?, ?)").run(
      "test@example.com",
      '["pw1","pw2"]'
    );
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // Helper to upsert using the same SQL pattern as database.ts saveTestRun()
  function upsertOutcome(outcome: string, error?: string) {
    db.prepare(`
      INSERT INTO credential_status (credential_id, target_site, outcome, error, timestamp)
      VALUES (1, 'joe', ?, ?, CURRENT_TIMESTAMP)
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
        timestamp = excluded.timestamp
    `).run(outcome, error || null);
  }

  function getOutcome(): string | undefined {
     
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const row = db.prepare("SELECT outcome FROM credential_status WHERE credential_id=1 AND target_site='joe'").get() as any;
    return row?.outcome;
  }

  it("inserts a new outcome for a fresh credential+site pair", () => {
    upsertOutcome("incorrect");
    expect(getOutcome()).toBe("incorrect");
  });

  it("promotes 'incorrect' → 'success' on second write", () => {
    upsertOutcome("incorrect");
    upsertOutcome("success");
    expect(getOutcome()).toBe("success");
  });

  it("REFUSES to demote 'success' → 'incorrect' on third write", () => {
    upsertOutcome("incorrect");
    upsertOutcome("success");
    upsertOutcome("incorrect"); // Attempt demotion
    expect(getOutcome()).toBe("success"); // success must survive
  });

  it("REFUSES to demote '2FA' → 'noaccount'", () => {
    upsertOutcome("2FA");
    upsertOutcome("noaccount");
    expect(getOutcome()).toBe("2FA");
  });

  it("REFUSES to demote 'success' → 'tempdisabled'", () => {
    upsertOutcome("success");
    upsertOutcome("tempdisabled"); // Not in confident set
    expect(getOutcome()).toBe("success"); // Guard protects
  });

  it("REFUSES to demote 'permdisabled' → 'incorrect'", () => {
    upsertOutcome("permdisabled");
    upsertOutcome("incorrect");
    expect(getOutcome()).toBe("permdisabled");
  });

  it("REFUSES to demote 'honeypot' → 'other'", () => {
    upsertOutcome("honeypot");
    upsertOutcome("other");
    expect(getOutcome()).toBe("honeypot");
  });

  it("allows 'incorrect' → 'tempdisabled' (both non-terminal, last wins)", () => {
    upsertOutcome("incorrect");
    upsertOutcome("tempdisabled");
    expect(getOutcome()).toBe("tempdisabled");
  });

  it("REFUSES to replace 'tempdisabled' with 'noaccount'", () => {
    upsertOutcome("tempdisabled");
    upsertOutcome("noaccount");
    expect(getOutcome()).toBe("tempdisabled");
  });

  it("allows 'noaccount' → 'tempdisabled' when stronger account-exists evidence appears", () => {
    upsertOutcome("noaccount");
    upsertOutcome("tempdisabled");
    expect(getOutcome()).toBe("tempdisabled");
  });

  it("REFUSES to replace 'noaccount' with 'inconclusive'", () => {
    upsertOutcome("noaccount");
    upsertOutcome("inconclusive");
    expect(getOutcome()).toBe("noaccount");
  });

  it("allows 'tempdisabled' → 'success' (promotion)", () => {
    upsertOutcome("tempdisabled");
    upsertOutcome("success");
    expect(getOutcome()).toBe("success");
  });

  it("allows terminal → terminal transitions (both in confident set)", () => {
    upsertOutcome("success");
    upsertOutcome("2FA");
    // Both are in the confident set, so excluded.outcome wins
    expect(getOutcome()).toBe("2FA");
  });

  it("stores error field correctly on upsert", () => {
    upsertOutcome("incorrect", "wrong password");
     
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const row = db.prepare("SELECT error FROM credential_status WHERE credential_id=1").get() as any;
    expect(row.error).toBe("wrong password");
  });
});
