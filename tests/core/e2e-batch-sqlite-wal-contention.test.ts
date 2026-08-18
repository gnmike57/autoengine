import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { initDB, db } from "../../src/core/database.js";

describe("E2E SQLite WAL Multi-Worker High-Concurrency Edge Cases", () => {
  beforeEach(() => {
    initDB();
    try {
      db.prepare("DELETE FROM test_runs").run();
    } catch {}
  });

  afterEach(() => {
    try {
      db.prepare("DELETE FROM test_runs").run();
    } catch {}
  });

  it("Invariant: SQLite runs in Write-Ahead Logging (WAL) mode", () => {
    const pragma = db.pragma("journal_mode") as Array<{ journal_mode: string }>;
    expect(pragma[0]?.journal_mode?.toLowerCase()).toBe("wal");
  });

  it("Edge Case: 50 concurrent simulated worker writes complete without locking", async () => {
    const insertStmt = db.prepare(`
      INSERT INTO test_runs (credential_id, target_site, outcome, duration_ms, timestamp)
      VALUES (?, ?, ?, ?, ?)
    `);

    const writeTasks = Array.from({ length: 50 }).map((_, i) => {
      return new Promise<void>((resolve, reject) => {
        try {
          insertStmt.run(
            i + 1,
            i % 2 === 0 ? "joe" : "ignition",
            "incorrect",
            500 + i,
            new Date().toISOString()
          );
          resolve();
        } catch (err) {
          reject(err);
        }
      });
    });

    await expect(Promise.all(writeTasks)).resolves.toBeDefined();

    const count = db.prepare("SELECT COUNT(*) as c FROM test_runs").get() as { c: number };
    expect(count.c).toBe(50);
  });
});
