/**
 * Test 18: getUntestedCredentials() — Query Correctness
 *
 * Tests the credential filtering logic that drives which credentials get processed.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

describe("getUntestedCredentials query logic (Test 18)", () => {
  let db: Database.Database;
  let tmpDir: string;

  const CONFIDENT_OUTCOMES = ["success", "2FA", "noaccount", "permdisabled", "honeypot"];

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "untested-test-"));
    db = new Database(path.join(tmpDir, "test.db"));
    db.pragma("journal_mode = WAL");

    db.exec(`
      CREATE TABLE credentials (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT UNIQUE NOT NULL,
        passwords TEXT NOT NULL,
        password_count INTEGER DEFAULT 0,
        target_sites TEXT DEFAULT '["joe","ignition"]'
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
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function insertCred(email: string, passwords: string[] = ["pw1"], targets: string[] = ["joe", "ignition"]) {
    return db.prepare(
      "INSERT INTO credentials (email, passwords, password_count, target_sites) VALUES (?, ?, ?, ?)"
    ).run(email, JSON.stringify(passwords), passwords.length, JSON.stringify(targets)).lastInsertRowid;
  }

  function insertStatus(credId: number | bigint, site: string, outcome: string) {
    db.prepare(
      "INSERT INTO credential_status (credential_id, target_site, outcome) VALUES (?, ?, ?)"
    ).run(credId, site, outcome);
  }

  // Reimplementation of getUntestedCredentials query
  function getUntested(targetSites: string[]) {
    if (targetSites.length === 0) return [];
    const placeholders = CONFIDENT_OUTCOMES.map(() => "?").join(",");
    const sitePlaceholders = targetSites.map(() => "?").join(",");

    const stmt = db.prepare(`
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

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return stmt.all(...targetSites, ...CONFIDENT_OUTCOMES).map((r: any) => ({
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      email: r.email,
       
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      passwords: JSON.parse(r.passwords),
    }));
  }

  it("returns credentials with no test_runs at all", () => {
    insertCred("fresh@test.com");
    const results = getUntested(["joe", "ignition"]);
    expect(results.length).toBe(1);
    expect(results[0]!.email).toBe("fresh@test.com");
  });

  it("returns credentials with 'incorrect' on one site but untested on another", () => {
    const id = insertCred("partial@test.com");
    insertStatus(id, "joe", "incorrect");
    // No status for ignition
    const results = getUntested(["joe", "ignition"]);
    expect(results.length).toBe(1);
  });

  it("excludes credentials with 'success' on all requested sites", () => {
    const id = insertCred("done@test.com");
    insertStatus(id, "joe", "success");
    insertStatus(id, "ignition", "success");
    const results = getUntested(["joe", "ignition"]);
    expect(results.length).toBe(0);
  });

  it("excludes credentials with '2FA' outcome (confident terminal)", () => {
    const id = insertCred("twofa@test.com");
    insertStatus(id, "joe", "2FA");
    insertStatus(id, "ignition", "2FA");
    const results = getUntested(["joe", "ignition"]);
    expect(results.length).toBe(0);
  });

  it("excludes credentials with 'permdisabled' outcome", () => {
    const id = insertCred("perm@test.com");
    insertStatus(id, "joe", "permdisabled");
    insertStatus(id, "ignition", "permdisabled");
    const results = getUntested(["joe", "ignition"]);
    expect(results.length).toBe(0);
  });

  it("includes credentials with 'tempdisabled' (not in CONFIDENT_OUTCOMES)", () => {
    const id = insertCred("temp@test.com");
    insertStatus(id, "joe", "tempdisabled");
    insertStatus(id, "ignition", "tempdisabled");
    const results = getUntested(["joe", "ignition"]);
    expect(results.length).toBe(1);
  });

  it("includes credentials with 'incorrect' (not in CONFIDENT_OUTCOMES)", () => {
    const id = insertCred("wrong@test.com");
    insertStatus(id, "joe", "incorrect");
    insertStatus(id, "ignition", "incorrect");
    const results = getUntested(["joe", "ignition"]);
    expect(results.length).toBe(1);
  });

  it("returns empty array for empty targetSites input", () => {
    insertCred("any@test.com");
    const results = getUntested([]);
    expect(results).toEqual([]);
  });

  it("handles credentials with null target_sites (defaults to joe+ignition)", () => {
    db.prepare(
      "INSERT INTO credentials (email, passwords, password_count, target_sites) VALUES (?, ?, ?, NULL)"
    ).run("null-targets@test.com", '["pw1"]', 1);
    const results = getUntested(["joe"]);
    expect(results.length).toBe(1);
  });

  it("only returns credentials whose target_sites intersect with requested sites", () => {
    insertCred("joe-only@test.com", ["pw1"], ["joe"]);
    insertCred("ignition-only@test.com", ["pw1"], ["ignition"]);
    insertCred("both@test.com", ["pw1"], ["joe", "ignition"]);

    const joeResults = getUntested(["joe"]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const emails = joeResults.map((r: any) => r.email);
    expect(emails).toContain("joe-only@test.com");
    expect(emails).toContain("both@test.com");
    expect(emails).not.toContain("ignition-only@test.com");
  });

  it("returns credentials where one site is confident but another is not", () => {
    const id = insertCred("mixed@test.com");
    insertStatus(id, "joe", "success"); // Confident on joe
    // No status for ignition
    const results = getUntested(["joe", "ignition"]);
    expect(results.length).toBe(1); // Still untested on ignition
  });
});
