/**
 * Test 17: Database Backup Rotation
 *
 * Tests the backup retention policy that keeps only the 5 most recent
 * timestamped backups while preserving special files.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

describe("database backup rotation (Test 17)", () => {
  let backupsDir: string;

  beforeEach(() => {
    backupsDir = fs.mkdtempSync(path.join(os.tmpdir(), "backup-test-"));
  });

  afterEach(() => {
    fs.rmSync(backupsDir, { recursive: true, force: true });
  });

  // Replicate the rotation logic from database.ts
  function rotateBackups() {
    const files = fs.readdirSync(backupsDir)
      .filter(f => /^credentials-\d{4}-\d{2}/.test(f) && f.endsWith(".db"))
      .sort()
      .reverse();
    const toDelete = files.slice(5);
    for (const old of toDelete) {
      fs.unlinkSync(path.join(backupsDir, old));
    }
    return { kept: files.slice(0, 5), deleted: toDelete };
  }

  function createBackup(name: string) {
    fs.writeFileSync(path.join(backupsDir, name), "test");
  }

  it("keeps the 5 most recent timestamped backups", () => {
    for (let i = 1; i <= 5; i++) {
      createBackup(`credentials-2026-06-${String(i).padStart(2, "0")}-12-00-00.db`);
    }
    const result = rotateBackups();
    expect(result.kept.length).toBe(5);
    expect(result.deleted.length).toBe(0);
  });

  it("deletes backups older than the 5th most recent", () => {
    for (let i = 1; i <= 8; i++) {
      createBackup(`credentials-2026-06-${String(i).padStart(2, "0")}-12-00-00.db`);
    }
    const result = rotateBackups();
    expect(result.kept.length).toBe(5);
    expect(result.deleted.length).toBe(3);

    // Verify the oldest 3 are deleted from disk
    for (const deleted of result.deleted) {
      expect(fs.existsSync(path.join(backupsDir, deleted))).toBe(false);
    }
    // Verify the newest 5 still exist
    for (const kept of result.kept) {
      expect(fs.existsSync(path.join(backupsDir, kept))).toBe(true);
    }
  });

  it("does not delete non-timestamped special files", () => {
    createBackup("credentials-pre-update.db");
    createBackup("credentials-last-shutdown.db");
    for (let i = 1; i <= 7; i++) {
      createBackup(`credentials-2026-06-${String(i).padStart(2, "0")}-12-00-00.db`);
    }
    rotateBackups();

    // Special files should still exist
    expect(fs.existsSync(path.join(backupsDir, "credentials-pre-update.db"))).toBe(true);
    expect(fs.existsSync(path.join(backupsDir, "credentials-last-shutdown.db"))).toBe(true);
  });

  it("sort order is correct (newest first, oldest deleted)", () => {
    createBackup("credentials-2026-06-01-12-00-00.db"); // Oldest
    createBackup("credentials-2026-06-10-12-00-00.db");
    createBackup("credentials-2026-06-05-12-00-00.db");
    createBackup("credentials-2026-06-15-12-00-00.db");
    createBackup("credentials-2026-06-20-12-00-00.db"); // Newest
    createBackup("credentials-2026-06-03-12-00-00.db");
    createBackup("credentials-2026-06-08-12-00-00.db");

    const result = rotateBackups();

    // Newest 5 should be kept: 20, 15, 10, 08, 05
    expect(result.kept[0]).toContain("06-20");
    expect(result.kept[1]).toContain("06-15");
    expect(result.kept[2]).toContain("06-10");

    // Oldest should be deleted: 03, 01
    expect(result.deleted.length).toBe(2);
    expect(result.deleted.some(f => f.includes("06-01"))).toBe(true);
    expect(result.deleted.some(f => f.includes("06-03"))).toBe(true);
  });

  it("handles empty backup directory without error", () => {
    const result = rotateBackups();
    expect(result.kept.length).toBe(0);
    expect(result.deleted.length).toBe(0);
  });

  it("handles exactly 5 backups (no deletion needed)", () => {
    for (let i = 1; i <= 5; i++) {
      createBackup(`credentials-2026-06-${String(i).padStart(2, "0")}-12-00-00.db`);
    }
    const result = rotateBackups();
    expect(result.deleted.length).toBe(0);
    expect(result.kept.length).toBe(5);
  });

  it("ignores non-.db files", () => {
    createBackup("credentials-2026-06-01-12-00-00.db");
    fs.writeFileSync(path.join(backupsDir, "credentials-2026-06-01.txt"), "not a db");
    fs.writeFileSync(path.join(backupsDir, "credentials-2026-06-01.json"), "{}");
    const result = rotateBackups();
    expect(result.kept.length).toBe(1);
    expect(fs.existsSync(path.join(backupsDir, "credentials-2026-06-01.txt"))).toBe(true);
  });
});
