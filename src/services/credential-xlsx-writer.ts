/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unused-vars, @typescript-eslint/no-misused-promises*/
/**
 * credential-xlsx-writer.ts
 *
 * Creates and maintains a color-coded XLSX version of credentials.csv
 * that updates in real-time as test results come in.
 *
 * Color scheme:
 *   ✓ Green   (#22C55E) — correct password / success
 *   ✗ Red     (#EF4444) — incorrect password
 *   ⏸ Orange  (#F97316) — temporarily disabled
 *   🚫 Dark Red (#B91C1C) — permanently disabled
 *   🛡 Purple  (#8B5CF6) — blocked
 *   🔐 Yellow  (#EAB308) — 2FA required
 *   👻 Gray    (#6B7280) — no account
 *   ⏳ Blue    (#3B82F6) — testing/in-progress
 *   📋 None    — queued (no fill)
 */

import ExcelJS from "exceljs";
import { createLogger } from "../core/logger.js";

const log = createLogger("XlsxWriter");

// ═══ Types ═══
interface PasswordResult {
  password: string;
  outcome: string;       // "success" | "incorrect" | "tempdisabled" | "permdisabled" | "blocked" | "2FA" | "noaccount" | "testing" | "queued" | "N/A"
  site: string;
  timestamp?: string;
  batchIndex?: number;
  attemptIndex?: number; // which attempt within the batch (0-2)
}

interface CredentialXlsxRow {
  email: string;
  passwords: string[];
  passwordResults: PasswordResult[];
  overallOutcome: string;
  sites: { [name: string]: { outcome: string; attempts: number; timestamp?: string } };
  currentBatch: number;
}

// ═══ Color Definitions ═══
const OUTCOME_COLORS: { [key: string]: { bg: string; font: string } } = {
  success:      { bg: "FF22C55E", font: "FF000000" },  // Green
  incorrect:    { bg: "FFEF4444", font: "FFFFFFFF" },  // Red
  tempdisabled: { bg: "FFF97316", font: "FF000000" },  // Orange
  permdisabled: { bg: "FFB91C1C", font: "FFFFFFFF" },  // Dark Red
  blocked:      { bg: "FF8B5CF6", font: "FFFFFFFF" },  // Purple
  "2FA":        { bg: "FFEAB308", font: "FF000000" },  // Yellow
  noaccount:    { bg: "FF6B7280", font: "FFFFFFFF" },  // Gray
  testing:      { bg: "FF3B82F6", font: "FFFFFFFF" },  // Blue
  failed:       { bg: "FFEF4444", font: "FFFFFFFF" },  // Red
  "N/A":        { bg: "FF4B5563", font: "FFFFFFFF" },  // Dark Gray
};

const _HEADER_FILL: ExcelJS.Fill = {
  type: "pattern",
  pattern: "solid",
  fgColor: { argb: "FF111827" },
};

const _HEADER_FONT: Partial<ExcelJS.Font> = {
  bold: true,
  color: { argb: "FF06B6D4" },
  size: 11,
  name: "Calibri",
};

// ═══ Debounce write ═══
let _writeTimeout: ReturnType<typeof setTimeout> | null = null;
let _pendingData: CredentialXlsxRow[] | null = null;
let _xlsxPath: string = "";
let _csvPath: string = "";

const DEBOUNCE_MS = 2000; // 2 second debounce

function _getCellFill(outcome: string): ExcelJS.Fill | undefined {
  const c = OUTCOME_COLORS[outcome];
  if (!c) return undefined;
  return {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: c.bg },
  };
}

function _getCellFont(outcome: string): Partial<ExcelJS.Font> {
  const c = OUTCOME_COLORS[outcome];
  return {
    color: { argb: c?.font || "FFFFFFFF" },
    size: 10,
    name: "Calibri",
  };
}

/**
 * Determine the outcome for a specific password index based on
 * batch tracking and site results.
 */
function _getPasswordOutcome(
  passwordIdx: number,
  passwords: string[],
  sites: { [name: string]: { outcome: string; attempts: number } },
  currentBatch: number,
  passwordResults: PasswordResult[]
): string {
  // Check if there's a direct result stored for this password
  const directResult = passwordResults.find(r => r.attemptIndex === passwordIdx);
  if (directResult) return directResult.outcome;

  const pw = passwords[passwordIdx];
  if (!pw || pw.length === 0) return "";

  // Determine which batch this password belongs to
  const batchOfPw = Math.floor(passwordIdx / 3);

  // If this batch hasn't been reached yet, it's queued
  if (batchOfPw > currentBatch) return "queued";

  // If this batch is the current one being tested
  if (batchOfPw === currentBatch) {
    // Check site outcomes
    const outcomes = Object.values(sites).map(s => s.outcome);
    if (outcomes.includes("success")) {
      // Success — we don't know which exact pw was the winner in the batch
      // but we mark the batch's passwords accordingly
      return "success";
    }
    if (outcomes.includes("testing")) return "testing";
    if (outcomes.includes("tempdisabled")) return "tempdisabled";
    if (outcomes.includes("permdisabled")) return "permdisabled";
    if (outcomes.includes("blocked")) return "blocked";
    if (outcomes.includes("2FA")) return "2FA";
    if (outcomes.includes("noaccount")) return "noaccount";
    if (outcomes.some(o => o === "N/A" || o === "failed")) return "incorrect";
    if (outcomes.includes("queued")) return "queued";
    return "incorrect";
  }

  // This batch has already been tried (batchOfPw < currentBatch)
  // If we got to a later batch, the earlier ones were incorrect/tempdisabled
  const siteOutcomes = Object.values(sites).map(s => s.outcome);
  if (siteOutcomes.includes("tempdisabled")) return "tempdisabled";
  return "incorrect";
}

/**
 * Write the color-coded XLSX file.
 */
import { Worker } from "worker_threads";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function writeXlsx(rows: CredentialXlsxRow[], outputPath: string, csvPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // Resolve the worker file based on whether we are running TS (ts-node) or JS (compiled)
    const ext = __filename.endsWith(".ts") ? ".ts" : ".js";
    const workerPath = path.join(__dirname, `xlsx-worker-thread${ext}`);

    // In ts-node, we might need to pass execArgv to support TS
    const workerOptions: any = {};
    if (ext === ".ts") {
      workerOptions.execArgv = ["--import", "tsx"];
    }

    const worker = new Worker(workerPath, workerOptions);

    worker.on("message", (msg) => {
      if (msg.status === "done") {
        resolve();
        void worker.terminate();
      } else if (msg.status === "error") {
        reject(new Error(msg.message));
        void worker.terminate();
      }
    });

    worker.on("error", (err) => {
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      reject(err);
      void worker.terminate();
    });

    worker.on("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`Worker stopped with exit code ${code}`));
      }
    });

    worker.postMessage({ rows, outputPath, csvPath });
  });
}

// ═══ Public API ═══

/**
 * Initialize the XLSX writer with paths.
 */
export function initXlsxWriter(csvPath: string, xlsxPath?: string): void {
  _csvPath = csvPath;
  _xlsxPath = xlsxPath || csvPath.replace(/\.csv$/i, "-results.xlsx");
  log.info(`Output: ${_xlsxPath}`);
}

/**
 * Queue a write of the current credential state.
 * Debounced to avoid hammering the disk on rapid updates.
 */
export function updateCredentialXlsx(
  credentials: { email: string; passwords: string[] }[],
  rows: any[]
): void {
  if (!_xlsxPath) return;

  const data: CredentialXlsxRow[] = credentials.map((c, i) => {
    const row = rows[i];
    return {
      email: c.email,
      passwords: c.passwords,
      passwordResults: row?._passwordResults || [],
      overallOutcome: getOverallOutcome(row),
      sites: row?.sites || {},
      currentBatch: row?.currentBatch || 0,
    };
  });

  _pendingData = data;

  if (_writeTimeout) clearTimeout(_writeTimeout);
  _writeTimeout = setTimeout(async () => {
    if (!_pendingData) return;
    try {
      await writeXlsx(_pendingData, _xlsxPath, _csvPath);
      _pendingData = null;
    } catch (err: unknown) {
      log.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, DEBOUNCE_MS);
}

/**
 * Force an immediate write (e.g., on engine stop).
 */
export async function flushCredentialXlsx(
  credentials: { email: string; passwords: string[] }[],
  rows: any[]
): Promise<void> {
  if (!_xlsxPath) return;
  if (_writeTimeout) { clearTimeout(_writeTimeout); _writeTimeout = null; }

  const data: CredentialXlsxRow[] = credentials.map((c, i) => {
    const row = rows[i];
    return {
      email: c.email,
      passwords: c.passwords,
      passwordResults: row?._passwordResults || [],
      overallOutcome: getOverallOutcome(row),
      sites: row?.sites || {},
      currentBatch: row?.currentBatch || 0,
    };
  });

  try {
    await writeXlsx(data, _xlsxPath, _csvPath);
    log.info(`Final flush written to ${_xlsxPath}`);
  } catch (err: unknown) {
    log.error(`Flush error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Record a specific password attempt result for granular cell coloring.
 */
export function recordPasswordResult(
  row: any,
  passwordIndex: number,
  outcome: string,
  site: string
): void {
  if (!row) return;
  if (!row._passwordResults) row._passwordResults = [];
  // Update or add
  const existing = row._passwordResults.find(
    (r: PasswordResult) => r.attemptIndex === passwordIndex && r.site === site
  );
  if (existing) {
    existing.outcome = outcome;
    existing.timestamp = new Date().toISOString();
  } else {
    row._passwordResults.push({
      password: "",
      outcome,
      site,
      timestamp: new Date().toISOString(),
      attemptIndex: passwordIndex,
    });
  }
}

function getOverallOutcome(row: any): string {
  if (!row || !row.sites) return "queued";
  const outcomes = Object.values(row.sites).map((s: any) => s.outcome);
  if (outcomes.includes("success")) return "success";
  if (outcomes.includes("2FA")) return "2FA";
  if (outcomes.includes("testing")) return "testing";
  if (outcomes.includes("tempdisabled")) return "tempdisabled";
  if (outcomes.includes("permdisabled")) return "permdisabled";
  if (outcomes.includes("blocked")) return "blocked";
  if (outcomes.includes("noaccount")) return "noaccount";
  if (outcomes.some((o: any) => o === "N/A" || o === "failed")) return "incorrect";
  return "queued";
}