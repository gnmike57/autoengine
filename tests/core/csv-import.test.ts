/**
 * Test 15: CSV Import — Duplicate & Edge Cases
 *
 * Tests the importCsv() database layer for correct credential ingestion.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

describe("CSV import logic (Test 15)", () => {
  let db: Database.Database;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "csv-import-test-"));
    const dbPath = path.join(tmpDir, "test.db");
    db = new Database(dbPath);
    db.pragma("journal_mode = WAL");

    db.exec(`
      CREATE TABLE credentials (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT UNIQUE NOT NULL,
        passwords TEXT NOT NULL,
        password_count INTEGER DEFAULT 0,
        next_batch_index INTEGER DEFAULT 0,
        target_sites TEXT DEFAULT '["joe","ignition"]'
      );
      CREATE TABLE imported_files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        filename TEXT UNIQUE NOT NULL,
        imported_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeCsv(name: string, content: string): string {
    const p = path.join(tmpDir, name);
    fs.writeFileSync(p, content, "utf-8");
    return p;
  }

  function importCsv(filePath: string) {
    const filename = path.basename(filePath);

    // Check if already imported
    const check = db.prepare("SELECT id FROM imported_files WHERE filename = ?").get(filename);
    if (check) return { skipped: true };

    const content = fs.readFileSync(filePath, "utf-8");
    const lines = content.split("\n").filter(l => l.trim());
    if (lines.length < 2) return { imported: 0 };

    const headers = lines[0]!.split(",").map(h => h.trim().toLowerCase());
    const emailIdx = headers.indexOf("email");
    const pwCols = headers.filter(h => h.startsWith("password")).map(h => headers.indexOf(h));

    if (emailIdx === -1 || pwCols.length === 0) return { error: "missing columns" };

    const insertStmt = db.prepare(`
      INSERT INTO credentials (email, passwords, password_count)
      VALUES (?, ?, ?)
      ON CONFLICT(email) DO UPDATE SET passwords=excluded.passwords, password_count=excluded.password_count
    `);

    let imported = 0;
    const txn = db.transaction(() => {
      for (let i = 1; i < lines.length; i++) {
        const fields = lines[i]!.split(",").map(f => f.trim());
        const email = fields[emailIdx];
        if (!email) continue;

        const passwords = pwCols.map(idx => fields[idx]).filter(Boolean);
        if (passwords.length === 0) continue;

        insertStmt.run(email, JSON.stringify(passwords), passwords.length);
        imported++;
      }
      db.prepare("INSERT INTO imported_files (filename) VALUES (?)").run(filename);
    });
    txn();
    return { imported };
  }

  it("imports email + multiple password columns correctly", () => {
    const p = writeCsv("test.csv", "email,password,password2\nfoo@bar.com,pw1,pw2");
    const result = importCsv(p);
    expect(result.imported).toBe(1);

     
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const row = db.prepare("SELECT * FROM credentials WHERE email = ?").get("foo@bar.com") as any;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    expect(JSON.parse(row.passwords)).toEqual(["pw1", "pw2"]);
    expect(row.password_count).toBe(2);
  });

  it("skips rows with missing email", () => {
    const p = writeCsv("test.csv", "email,password\n,pw1\nfoo@bar.com,pw2");
    const result = importCsv(p);
    expect(result.imported).toBe(1);
  });

  it("skips already-imported files", () => {
    const p = writeCsv("test.csv", "email,password\nfoo@bar.com,pw1");
    importCsv(p);
    const result = importCsv(p);
    expect(result.skipped).toBe(true);
  });

  it("upserts on duplicate email", () => {
    const p1 = writeCsv("test1.csv", "email,password\nfoo@bar.com,pw1");
    importCsv(p1);

    const p2 = writeCsv("test2.csv", "email,password\nfoo@bar.com,pw_updated");
    importCsv(p2);

     
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const row = db.prepare("SELECT * FROM credentials WHERE email = ?").get("foo@bar.com") as any;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    expect(JSON.parse(row.passwords)).toEqual(["pw_updated"]);
  });

  it("stores password_count accurately", () => {
    const p = writeCsv("test.csv", "email,password,password2,password3\nfoo@bar.com,a,b,c");
    importCsv(p);
     
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const row = db.prepare("SELECT password_count FROM credentials WHERE email = ?").get("foo@bar.com") as any;
    expect(row.password_count).toBe(3);
  });

  it("handles CSV with only headers and no data rows", () => {
    const p = writeCsv("test.csv", "email,password");
    const result = importCsv(p);
    expect(result.imported).toBe(0);
  });

  it("returns error for missing email column", () => {
    const p = writeCsv("test.csv", "name,password\nJohn,pw1");
    const result = importCsv(p);
    expect(result.error).toBe("missing columns");
  });

  it("imports multiple rows in a single transaction", () => {
    const p = writeCsv("test.csv",
      "email,password\na@b.com,pw1\nc@d.com,pw2\ne@f.com,pw3");
    const result = importCsv(p);
    expect(result.imported).toBe(3);

     
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const count = (db.prepare("SELECT COUNT(*) as cnt FROM credentials").get() as any).cnt;
    expect(count).toBe(3);
  });
});
