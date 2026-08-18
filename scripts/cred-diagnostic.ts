/**
 * Credential Database Diagnostic
 * Checks if passwords decrypt correctly and counts empty vs populated creds.
 */
import "dotenv/config";
import Database from "better-sqlite3";
import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs";

// Load encryption key (same logic as database.ts)
let keyBuffer: Buffer;
if (process.env.DB_ENCRYPTION_KEY) {
  keyBuffer = Buffer.from(process.env.DB_ENCRYPTION_KEY, "base64");
} else {
  const keyPath = path.join(process.cwd(), ".db_key");
  if (fs.existsSync(keyPath)) {
    keyBuffer = Buffer.from(fs.readFileSync(keyPath, "utf8").trim(), "base64");
  } else {
    console.error("❌ No .db_key file found!");
    process.exit(1);
  }
}

function decrypt(text: string): string {
  if (!text || !text.includes(":")) return text;
  try {
    const parts = text.split(":");
    if (parts.length !== 3) return text;
    const iv = Buffer.from(parts[0]!, "hex");
    const encrypted = Buffer.from(parts[1]!, "hex");
    const authTag = Buffer.from(parts[2]!, "hex");
    const decipher = crypto.createDecipheriv("aes-256-gcm", keyBuffer, iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return decrypted.toString("utf8");
  } catch (e: unknown) {
    return `DECRYPT_ERROR: ${e instanceof Error ? e.message : String(e)}`;
  }
}

// Find and open the DB
const dbDir = path.resolve(process.cwd(), "data");
const dbPath = path.join(dbDir, "credentials.sqlite");
if (!fs.existsSync(dbPath)) {
  console.error(`❌ Database not found at ${dbPath}`);
  process.exit(1);
}

const db = new Database(dbPath, { readonly: true });
db.pragma("journal_mode = WAL");

console.log("══════════════════════════════════════════════════════════════");
console.log("  CREDENTIAL DATABASE DIAGNOSTIC");
console.log("══════════════════════════════════════════════════════════════");
console.log(`DB: ${dbPath}`);
console.log(`Key: ${keyBuffer.toString("base64").slice(0, 8)}...`);

// 1. Total count
const totalRow = db.prepare("SELECT COUNT(*) as cnt FROM credentials").get() as any;
console.log(`\nTotal credentials: ${totalRow.cnt}`);

// 2. Check password_count distribution
const countDist = db.prepare("SELECT password_count, COUNT(*) as cnt FROM credentials GROUP BY password_count ORDER BY password_count").all() as any[];
console.log("\nPassword count distribution:");
for (const r of countDist) {
  console.log(`  ${r.password_count} passwords: ${r.cnt} credentials`);
}

// 3. Sample some rows and try decrypting
const sampleRows = db.prepare("SELECT email, passwords, password_count FROM credentials LIMIT 10").all() as any[];
console.log("\n── SAMPLE DECRYPTION TEST (first 10 rows) ────────────────");
let _decryptOk = 0;
let _decryptFail = 0;
let _emptyPasswords = 0;

for (const r of sampleRows) {
  const rawPw = r.passwords;
  const decrypted = decrypt(rawPw);
  let parsed: string[] = [];
  let parseOk = false;
  
  try {
    parsed = JSON.parse(decrypted);
    parseOk = true;
  } catch {
    parseOk = false;
  }

  if (decrypted.startsWith("DECRYPT_ERROR")) {
    _decryptFail++;
    console.log(`  ❌ ${r.email}: DECRYPT FAILED: ${decrypted}`);
  } else if (!parseOk) {
    _decryptFail++;
    console.log(`  ❌ ${r.email}: JSON PARSE FAILED: ${decrypted.slice(0, 60)}`);
  } else if (parsed.length === 0) {
    _emptyPasswords++;
    console.log(`  ⚠️ ${r.email}: Decrypted OK but EMPTY array []`);
  } else {
    _decryptOk++;
    console.log(`  ✅ ${r.email}: ${parsed.length} passwords (password_count=${r.password_count})`);
  }
}

// 4. Full scan for decrypt failures
console.log("\n── FULL SCAN ─────────────────────────────────────────────");
const allRows = db.prepare("SELECT email, passwords FROM credentials").all() as any[];
let totalOk = 0;
let totalDecryptFail = 0;
let totalParseFail = 0;
let totalEmpty = 0;
const failSamples: string[] = [];

for (const r of allRows) {
  const decrypted = decrypt(r.passwords);
  if (decrypted.startsWith("DECRYPT_ERROR")) {
    totalDecryptFail++;
    if (failSamples.length < 5) failSamples.push(`${r.email}: ${decrypted}`);
    continue;
  }
  try {
    const parsed = JSON.parse(decrypted);
    if (Array.isArray(parsed) && parsed.length > 0) {
      totalOk++;
    } else {
      totalEmpty++;
    }
  } catch {
    totalParseFail++;
    if (failSamples.length < 5) failSamples.push(`${r.email}: JSON parse fail on: ${decrypted.slice(0, 60)}`);
  }
}

console.log(`  ✅ Decrypted OK with passwords: ${totalOk}/${allRows.length}`);
console.log(`  ⚠️ Decrypted OK but empty []:   ${totalEmpty}/${allRows.length}`);
console.log(`  ❌ Decrypt failures:             ${totalDecryptFail}/${allRows.length}`);
console.log(`  ❌ JSON parse failures:          ${totalParseFail}/${allRows.length}`);

if (failSamples.length > 0) {
  console.log("\n  Failure samples:");
  failSamples.forEach(s => console.log(`    ${s}`));
}

// 5. Check if .db_key has changed (could explain decrypt failures)
const keyFile = path.join(process.cwd(), ".db_key");
if (fs.existsSync(keyFile)) {
  const stat = fs.statSync(keyFile);
  console.log(`\n  .db_key last modified: ${stat.mtime.toISOString()}`);
  console.log(`  .db_key size: ${stat.size} bytes`);
}

// 6. Check CSV for comparison
const csvFiles = ["credentials.csv", "creds.csv"];
for (const f of csvFiles) {
  const csvPath = path.join(process.cwd(), f);
  if (fs.existsSync(csvPath)) {
    const lines = fs.readFileSync(csvPath, "utf8").split("\n").filter(l => l.trim());
    console.log(`\n  ${f}: ${lines.length - 1} data rows (${lines[0]?.slice(0, 80) || ""}...)`);
  }
}

console.log("\n══════════════════════════════════════════════════════════════");

db.close();
process.exit(0);
