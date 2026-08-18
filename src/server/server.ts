/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unused-expressions , @typescript-eslint/no-misused-promises, @typescript-eslint/ban-ts-comment, @typescript-eslint/no-require-imports*/
/*** GUI SERVER
 * Express + WebSocket server that serves the dashboard frontend
 * and relays real-time automation events.
 *
 * All helpers, SSE/broadcast, outcome tracking, and Chrome dashboard
 * logic is defined inline in this file (canonical source of truth).
 */
import "dotenv/config";
import express from "express";
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { exec, spawn, execSync, ChildProcess } from 'node:child_process';
import { randomBytes, timingSafeEqual } from "crypto";
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';

try {
  os.setPriority(os.constants.priority.PRIORITY_HIGH);
} catch (e: unknown) {
  console.warn("Failed to set HIGH priority:", (e instanceof Error ? e.message : String(e)));
}

import {
  AutomationEngine,
  DEFAULT_TARGETS,
  BACKEND_OPTIMAL_SETTINGS,
  type Credential,
  type EngineConfig,
} from "../core/engine.js";
import { browserWarmer } from "../services/browser-warmer.js";
import { initXlsxWriter, updateCredentialXlsx, flushCredentialXlsx } from "../services/credential-xlsx-writer.js";
import { cleanPreviousZombies, killOurOrphans, startPeriodicZombieReaper, protectPid, unprotectPid } from "../services/process-cleaner.js";
import { Watchdog } from "../hermes/watchdog.js";
import { emailDenylist } from "../core/email-denylist.js";
import { timelineEvents } from "../hermes/timeline-analyzer.js";
import { parseRowUpdate, trackRequest } from "../hermes/telemetry.js";
import { WsMessageSchema, SetConcurrencySchema, SetBackendSchema } from "./schemas.js";

import { proxyScoreTracker } from "../../backends/index.js";
import { isVerificationAvailable, validateAiConfig } from "../services/video-verifier.js";
import { type FpStrategy } from "../profiles/profile-useragent.js";
import { createLogger } from "../core/logger.js";
import { Timings } from "../core/timings.js";
import { createGcsUploaderFromEnv } from "../services/gcs-uploader.js";
import { globalTiler } from "../services/browser-tiler.js";
import { getHermesObserver } from "../hermes/hermes-observer.js";
import { getPendingProposals } from "../hermes/hermes-proposals.js";
import { OpsOrchestrator } from "../hermes/ops-orchestrator.js";

import { db, initDB, startCredentialsWatcher, importCsv, getUntestedCredentials, getCredentialsByEmails, getAllCredentialsHistory, getCategorizedTempDisabled, countCredentials, getAllCredentialsWithLatestStatus, getResultSummary, saveTargetWinner, getTargetWinners, type RestoredRow, closeDB, getStmt } from "../core/database.js";

/** Create a pre-update backup so the DB is snapshot'd before any new code
 *  (migrations, schema changes) touches it. Safe to call on every boot.
 *
 *  Uses VACUUM INTO (SQLite 3.27+) instead of the async db.backup() API
 *  to guarantee the backup completes BEFORE initDB() runs migrations.
 *  VACUUM INTO creates a clean, compacted, self-contained snapshot in a
 *  single synchronous transaction — no race condition with subsequent writes. */
function createBootBackup(): void {
  try {
    const backupsDir = path.resolve(process.cwd(), 'backups');
    if (!fs.existsSync(backupsDir)) fs.mkdirSync(backupsDir, { recursive: true });
    const bootBackupPath = path.join(backupsDir, 'credentials-pre-update.db');
    // Only create if the DB has data (avoid backing up empty DB on first run)
    const count = (db.prepare("SELECT COUNT(*) as cnt FROM sqlite_master WHERE type='table'").get() as any)?.cnt || 0;
    if (count > 0) {
      // Remove old backup if it exists (VACUUM INTO won't overwrite)
      if (fs.existsSync(bootBackupPath)) {
        fs.unlinkSync(bootBackupPath);
      }
      db.exec(`VACUUM INTO '${bootBackupPath.replace(/'/g, "''")}'`);
      log.info(`Boot backup created: ${bootBackupPath}`);
    }
  } catch (e: unknown) {
    log.warn(`Boot backup skipped: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Checkpoint WAL into the main DB file so it's self-contained for copying.
 *  Safe to call at any time; no-op if WAL is already empty. */
export function checkpointWAL(): void {
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
    log.info('WAL checkpoint complete — DB file is self-contained');
  } catch (e: unknown) {
    log.warn(`WAL checkpoint failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

const log = createLogger("Server");

createBootBackup();  // Backup BEFORE migrations touch the DB
initDB();
startCredentialsWatcher();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── HARDENING 4: Dead Hand Watchdog ──────────────────────────────────────────
const deadHandPath = path.resolve(__dirname, '../services/dead-hand.js');
if (fs.existsSync(deadHandPath)) {
  const child = spawn('node', [deadHandPath, process.pid.toString()], {
    detached: true,
    stdio: 'ignore'
  });
  if (child.pid) {
    try { os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* intentional */ }
  }
  child.unref();
  log.info(`[DeadHand] Spawned Watchdog (PID: ${child.pid}) monitoring parent PID ${process.pid}`);
} else {
  log.warn(`[DeadHand] script not found at ${deadHandPath}`);
}

// ─── Configuration ────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT || "9223", 10);
const CSV_PATH = path.resolve("credentials.csv");
const PERMDISABLED_DIR = path.resolve("permdisabled");
const PERMDISABLED_CSV = path.join(PERMDISABLED_DIR, "permdisabled.csv");

// Track which emails have already been archived this session to avoid duplicates
const permDisabledArchived = new Set<string>();

/** Ensure permdisabled/ directory and CSV header exist */
function initPermDisabledCsv(): void {
  try {
    if (!fs.existsSync(PERMDISABLED_DIR)) fs.mkdirSync(PERMDISABLED_DIR, { recursive: true });
    if (!fs.existsSync(PERMDISABLED_CSV)) {
      fs.writeFileSync(PERMDISABLED_CSV, "email,password1,password2,password3,detected_at,site\n");
    }
    // Pre-populate the dedup set from any existing entries
    const existing = fs.readFileSync(PERMDISABLED_CSV, "utf-8");
    for (const line of existing.split(/\r?\n/).slice(1)) {
      const email = (line.split(",")[0] || "").trim().toLowerCase();
      if (email) permDisabledArchived.add(email);
    }
  } catch (e: unknown) {
    console.error(`[PermDisabled] Init error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Append a permdisabled credential to the archive CSV.
 *  Looks up passwords from the main credentials.csv so the archive has full data. */
function appendPermDisabledCsv(email: string, site?: string): void {
  try {
    // Look up passwords from in-memory credentials or CSV
    let passwords: string[] = [];
    const cred = currentRunCredentials.find(
      (c: any) => c.email.toLowerCase() === email.toLowerCase()
    );
    if (cred) {
      passwords = (cred as any).passwords || [];
    }
    const p1 = passwords[0] || "";
    const p2 = passwords[1] || "";
    const p3 = passwords[2] || "";
    const detectedAt = new Date().toISOString();
    const escapeCsv = (s: string) => s.includes(",") ? `"${s}"` : s;
    const line = `${escapeCsv(email)},${escapeCsv(p1)},${escapeCsv(p2)},${escapeCsv(p3)},${detectedAt},${site || "joe"}\n`;
    fs.promises.appendFile(PERMDISABLED_CSV, line).catch((err: any) => {
      log.warn(`[PermDisabled] Failed to write archive for ${email}: ${err?.message ?? String(err)}`);
    });
    log.info(`[PermDisabled] Archived ${email} → ${PERMDISABLED_CSV}`);
  } catch (e: unknown) {
    log.warn(`[PermDisabled] Failed to archive ${email}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// Initialize on module load
initPermDisabledCsv();

type DashboardBackend = "cloak-headed" | "cloak-headless" | "cloak-headless-nocloak" | "cloak-headed-nocloak" | "split-local-stealth" | "experimental" | "experimental-elimination" | "curl-api" | "golden-benchmark" | "stealth" | "stealth-headed" | "zendriver" | "zendriver-headed" | "rotate-backends" | "rotate-backends-headless" | "stealth-fortress" | "speed-blitz" | "headed-recon" | "darwin";
const CSRF_TOKEN = randomBytes(32).toString("hex");
const MOBILE_API_KEY_PATH = path.join(process.cwd(), 'data', '.mobile_api_key');
let MOBILE_API_KEY: string;
if (process.env.MOBILE_API_KEY) {
  MOBILE_API_KEY = process.env.MOBILE_API_KEY;
} else if (fs.existsSync(MOBILE_API_KEY_PATH)) {
  MOBILE_API_KEY = fs.readFileSync(MOBILE_API_KEY_PATH, 'utf8').trim();
} else {
  MOBILE_API_KEY = randomBytes(16).toString("hex");
  fs.writeFileSync(MOBILE_API_KEY_PATH, MOBILE_API_KEY, 'utf8');
}
log.info(`MOBILE_API_KEY initialized. Use this key in your iOS App to connect: ${MOBILE_API_KEY}`);
const WS_WINDOW_MS = 60_000;
const WS_MAX_CONNECTIONS_PER_WINDOW = 60;
const wsConnectionAttempts = new Map<string, { count: number; resetAt: number }>();
process.env.VITEST ? null : setInterval(() => {
  const now = Date.now();
  for (const [ip, data] of wsConnectionAttempts.entries()) {
    if (now > data.resetAt) wsConnectionAttempts.delete(ip);
  }
}, 60000).unref();
function readHeader(req: express.Request, name: string): string {
  const v = req.headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] || "" : v || "";
}

function isSafeToken(token: string, expected: string): boolean {
  if (!token || token.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(token), Buffer.from(expected));
}

function wsRemoteAddress(req: import("http").IncomingMessage): string {
  const forwarded = req.headers["x-forwarded-for"];
  const first = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  return (first?.split(",")[0] || req.socket.remoteAddress || "unknown").trim();
}

function allowWsConnection(ip: string): boolean {
  const now = Date.now();
  const current = wsConnectionAttempts.get(ip);
  if (!current || now >= current.resetAt) {
    wsConnectionAttempts.set(ip, { count: 1, resetAt: now + WS_WINDOW_MS });
    return true;
  }
  current.count++;
  return current.count <= WS_MAX_CONNECTIONS_PER_WINDOW;
}
// ─── App Setup ────────────────────────────────────────────────────────────────

export const app = express();
// eslint-disable-next-line @typescript-eslint/no-unused-vars
let _totalRequests = 0;
app.use((_req, _res, next) => {
  _totalRequests++;
  next();
});
const useTls = process.env.TLS === 'true' || process.env.HTTPS === 'true';
let httpServer: http.Server | https.Server;

function ensureCertificatesExist() {
  const keyPath = path.resolve("key.pem");
  const certPath = path.resolve("cert.pem");
  if (!fs.existsSync(keyPath) || !fs.existsSync(certPath)) {
    log.info("Generating self-signed TLS/SSL certificate...");
    try {
      execSync(
        `openssl req -x509 -newkey rsa:2048 -nodes -keyout "${keyPath}" -out "${certPath}" -days 365 -subj "/CN=localhost"`,
        { stdio: "pipe" }
      );
      log.info("Self-signed certificates generated at key.pem and cert.pem");
    } catch (e: unknown) {
      log.error(`Failed to generate self-signed certificate: ${e instanceof Error ? e.message : String(e)}`);
      throw e;
    }
  }
  return {
    key: fs.readFileSync(keyPath),
    cert: fs.readFileSync(certPath),
  };
}

if (useTls) {
  const certs = ensureCertificatesExist();
  httpServer = https.createServer(certs, app);
  log.info("TLS is enabled. Starting HTTPS server...");
} else {
  httpServer = http.createServer(app);
}

const wss = new WebSocketServer({ server: httpServer, perMessageDeflate: true });

// ── Rotation Mode → Backend List Mapping (single source of truth) ────────────
// Eliminates 3× duplication of the same if/else chain across start, set-backend,
// and rotationTracking initialization.
const ROTATION_MODE_BACKENDS: Record<string, { backends: string[]; threshold: number; label: string }> = {
  "rotate-backends": { backends: ["stealth", "stealth-headed", "cloak-headless", "cloak-headed", "cloak-headless-nocloak", "cloak-headed-nocloak", "zendriver", "zendriver-headed"], threshold: 5, label: "🔄 Rotate All" },
  "rotate-backends-headless": { backends: ["stealth", "cloak-headless", "cloak-headless-nocloak", "zendriver"], threshold: 4, label: "🔄 Rotate Headless" },
  "stealth-fortress": { backends: ["stealth", "stealth-headed"], threshold: 5, label: "🛡️ Stealth Fortress" },
  "speed-blitz": { backends: ["stealth", "cloak-headless", "cloak-headless-nocloak", "zendriver"], threshold: 3, label: "⚡ Speed Blitz" },
  "headed-recon": { backends: ["stealth-headed", "cloak-headed", "cloak-headed-nocloak", "zendriver-headed"], threshold: 6, label: "🎭 Headed Recon" },
};

/** Return the filtered backend list for a rotation mode, excluding disabled backends. */
function getRotateList(mode: string, disabledBackends: string[]): string[] {
  const entry = ROTATION_MODE_BACKENDS[mode];
  if (!entry) return [];
  return entry.backends.filter(b => !disabledBackends.includes(b));
}

// ── Logic Toggle Allowlist ──────────────────────────────────────────────────
// Only these keys may be mutated via the "set-logic-toggle" WS command.
// Prevents arbitrary engine config mutation from a dashboard client.
const LOGIC_TOGGLE_ALLOWLIST = new Set([
  "rotateOnFingerprint",
  "burnOnlyOnPermDisabled",
  "mutateOnRetry",
  "recycleSessionOnIncorrect",
  "ignitionVerifBypass",
  "enableVerification",
  "enableCacheInjection",
  "injectStealthJS",
  "useHttpCloak",
  "stealthBypassHttpCloak",
  "recordVideo",
  "enablePlaywrightTracing",
  "parallelSiteTesting",
  "manualCaptchaMode",
  "autoOptimizePerBackend",
  "flowDebug",
  "captureFlowSteps",
]);

const engine = new AutomationEngine();
let cachedCredentials: Credential[] = [];
let currentRunCredentials: Credential[] = []; // Full credentials with passwords for XLSX writer
let isShuttingDown = false; // Prevents Hermes auto-restart during shutdown
const targetNames = DEFAULT_TARGETS.filter(t => t.selectors?.username && t.selectors?.password && t.selectors?.submit).map(t => t.name);

// Hydrate credentials + historical results from SQLite so the dashboard
// always restores to the current state across server restarts.
let restoredRows: RestoredRow[] = [];
try {
  // Auto-import credentials.csv from project root if DB has no credentials
  const dbCount = countCredentials();
  if (dbCount === 0 && fs.existsSync(CSV_PATH)) {
    log.info(`DB empty — auto-importing ${CSV_PATH} into database...`);
    try {
      await importCsv(CSV_PATH);
      log.info(`Auto-imported credentials.csv into DB`);
    } catch (e: unknown) {
      log.warn(`Auto-import failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  cachedCredentials = getUntestedCredentials(targetNames);
  restoredRows = getAllCredentialsWithLatestStatus(targetNames);

  // If DB still empty but CSV exists, load directly from CSV as fallback
  if (restoredRows.length === 0 && fs.existsSync(CSV_PATH)) {
    cachedCredentials = engine.loadCredentials(CSV_PATH);
    restoredRows = cachedCredentials.map((c): RestoredRow => {
      const totalPw = Array.isArray(c.passwords) ? c.passwords.length : 0;
      const totalBatches = Math.max(1, Math.ceil(totalPw / 3));
      return {
        email: c.email,
        status: "queued" as const,
        currentBatch: 0,
        totalPasswords: totalPw,
        passwordsTried: 0,
        totalBatches,
        target_sites: targetNames,
        sites: Object.fromEntries(targetNames.map(t => [t, { outcome: "queued", attempts: 0 }])),
      };
    });
    log.info(`Loaded ${cachedCredentials.length} credential(s) directly from CSV (DB bypass)`);
  }

  const summary = getResultSummary(targetNames);
  const summaryStr = Object.entries(summary).map(([k, v]) => `${k}=${v}`).join(', ');
  log.info(`Restored ${restoredRows.length} credential(s) from DB${summaryStr ? ` (${summaryStr})` : ''}`);
} catch (e) {
  log.warn(`Failed to load credentials from DB: ${String(e)}`);
}

import { ConfigStore } from '../core/config-store.js';
const loadedConfig = ConfigStore.load();

// Live-tunable concurrency. Defaults to 1 (headed-debug mode); persisted across
// runs so the dashboard's last value is reused when the user clicks Start again.
let currentConcurrency = loadedConfig.concurrency || 5;
let currentProxyPool: string = loadedConfig.proxyPool || "none";
let currentFpStrategy: FpStrategy = loadedConfig.fpStrategy as FpStrategy;
let currentEmulateMobile: boolean = loadedConfig.advEmulateMobile || false;
const currentSpiderApiKey: string = loadedConfig.spiderApiKey || "";

// Live-tunable input mode (see engine.ts setInputMode). Persisted across runs.
// Two options only: "instant" (page.fill, no Keystrokes) or "fast-human" (real
// keystrokes at KEYSTROKE_DELAY_FAST).
let currentInputMode: "instant" | "fast-human" | "chrome-autofill" = (loadedConfig.inputMode as any) || "fast-human";
let currentBackend: DashboardBackend = loadedConfig.backend as DashboardBackend;
let currentEnableCacheInjection = loadedConfig.enableCacheInjection;
let currentInjectStealthJS = loadedConfig.injectStealthJS;
let currentRecordVideo: boolean = loadedConfig.recordVideo;
let currentEnablePlaywrightTracing: boolean = loadedConfig.enablePlaywrightTracing;
let currentTilingLayout: string = loadedConfig.tilingLayout || "auto";
let currentEngineConfig: EngineConfig | null = null;
// postLoadDelay has been removed for absolute zero-delay instant execution
let currentEnableVerification: boolean = loadedConfig.enableVerification;
let currentUseHttpCloak: boolean = loadedConfig.useHttpCloak;
let currentStealthBypass: boolean = loadedConfig.stealthBypassHttpCloak;
let currentMaxRetries: number = loadedConfig.maxRetries;
let currentSpiderSettings: any = null;
let currentParallelSiteTesting: boolean = loadedConfig.parallelSiteTesting;
let currentIgnitionVerifBypass: boolean = loadedConfig.ignitionVerifBypass;
let currentRotateOnFingerprint: boolean = loadedConfig.rotateOnFingerprint;
let currentBurnOnlyOnPermDisabled: boolean = loadedConfig.burnOnlyOnPermDisabled;
let currentMutateOnRetry: boolean = loadedConfig.mutateOnRetry;
let currentProxyRotateUrl: string = loadedConfig.proxyRotateUrl;
const currentRecycleSessionOnIncorrect: boolean = loadedConfig.recycleSessionOnIncorrect;
let currentManualCaptchaMode: boolean = loadedConfig.manualCaptchaMode;
let currentAutoOptimizePerBackend: boolean = loadedConfig.autoOptimizePerBackend;
const currentGoldenCredentials: { joe?: string, ignition?: string } = loadedConfig.goldenCredentials || {
  joe: process.env.GOLDEN_CRED_JOE ?? "",
  ignition: process.env.GOLDEN_CRED_IGNITION ?? ""
};

// Persist disabled backends across restarts
const DISABLED_BACKENDS_FILE = path.join(process.cwd(), "disabled-backends.json");
function loadDisabledBackends(): string[] {
  try {
    const raw = fs.readFileSync(DISABLED_BACKENDS_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
  } catch { /* intentional */ }
  // Default: disable the most troublesome backends
  return ["cloak-headed", "curl-api", "curl-cffi", "playwright-firefox", "playwright-webkit"];
}
function saveDisabledBackends(list: string[]) {
  try { fs.writeFileSync(DISABLED_BACKENDS_FILE, JSON.stringify(list, null, 2)); } catch { /* intentional */ }
}
let currentDisabledBackends: string[] = loadDisabledBackends();

// Serve static files
app.use(express.static(path.resolve(__dirname, "../../public")));
app.use("/screenshots", express.static(path.join(process.cwd(), Timings.SCREENSHOT_DIR), {
  fallthrough: false,
  index: false,
  dotfiles: "deny",
  maxAge: "1d",
}));

// Recordings directory mirrors cloak-backend's localRecordingDir() — same
// env-overridable default so a custom CLOAK_RECORDING_DIR is honored on
// both the write side (engine) and the read side (dashboard).
const RECORDINGS_DIR = path.resolve(process.env.CLOAK_RECORDING_DIR || process.env.LOCAL_RECORDING_DIR || "recordings");
app.use("/recordings", express.static(RECORDINGS_DIR, {
  fallthrough: false,
  index: false,
  dotfiles: "deny",
  maxAge: "7d",
}));

// ─── CSV Upload Endpoint ──────────────────────────────────────────────────────

app.get('/metrics', async (_req, res) => {
  try {
    const { getMetricsString, activeSessions } = await import('../core/metrics.js');
    if (engine && engine.isRunning) {
      const active = engine.rowStatuses.filter(s => s.status === 'testing').length;
      activeSessions.set({ backend: 'all' }, active);
    } else {
      activeSessions.set({ backend: 'all' }, 0);
    }
    const metricsStr = await getMetricsString();
    res.setHeader('Content-Type', 'text/plain; version=0.0.4');
    res.send(metricsStr);
  } catch (err) {
    res.status(500).send(String(err));
  }
});

// Simple multipart parser – extracts the first file from a multipart/form-data
// request without requiring an external library like multer.
function parseMultipartFile(req: express.Request): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let rejected = false;
    req.on("data", (chunk: Buffer) => {
      if (rejected) return;
      totalBytes += chunk.length;
      if (totalBytes > Timings.MAX_CSV_BYTES) {
        rejected = true;
        reject(new Error(`CSV upload exceeds ${Timings.MAX_CSV_BYTES} byte cap`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (rejected) return;
      const raw = Buffer.concat(chunks);
      const contentType = req.headers["content-type"] || "";
      if (!/^multipart\/form-data\s*;/i.test(String(contentType))) {
        return reject(new Error("CSV upload must use multipart/form-data"));
      }
      const boundaryMatch = contentType.match(/boundary=(.+)/);
      if (!boundaryMatch) return reject(new Error("Missing multipart boundary"));
      const boundary = boundaryMatch[1];
      const rawStr = raw.toString("binary");
      const parts = rawStr.split(`--${boundary}`);
      for (const part of parts) {
        if (part.includes("Content-Disposition") && part.includes('name="csv"')) {
          const headerEnd = part.indexOf("\r\n\r\n");
          if (headerEnd === -1) continue;
          let body = part.slice(headerEnd + 4);
          // Trim trailing \r\n before next boundary
          if (body.endsWith("\r\n")) body = body.slice(0, -2);
          return resolve(Buffer.from(body, "binary"));
        }
      }
      reject(new Error("No csv field found in upload"));
    });
    req.on("error", reject);
  });
}

// ── Express Middleware for API Security ────────────────────────────────────
app.use((req, res, next) => {
  // Allow local connections or requests with the valid mobile API key
  const forwarded = req.headers["x-forwarded-for"]; const ip = (typeof forwarded === "string" ? forwarded.split(",")[0] : req.socket.remoteAddress) || "";
  const isLocalhost = ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";

  if (req.path.startsWith("/api/")) {
    const authHeader = req.headers.authorization;
    const hasValidApiKey = authHeader === `Bearer ${MOBILE_API_KEY}`;

    // For /api/upload-csv, we let the route handle CSRF if it's local
    if (!isLocalhost && !hasValidApiKey && req.path !== "/api/upload-csv") {
      res.status(403).json({ error: "Unauthorized: Invalid or missing API Key" });
      return;
    }
  }
  next();
});

// ── Mobile Optimized Text Paste Endpoint ──────────────────────────────────
app.post("/api/credentials/text-paste", express.text({ type: '*/*', limit: '1mb' }), async (req, res) => {
  try {
    const rawText = req.body;
    if (!rawText || typeof rawText !== 'string') {
      res.status(400).json({ error: "Empty or invalid body" });
      return;
    }

    // Validate that the input has at least one line with a comma (email,password format)
    const lines = rawText.trim().split(/\r?\n/).filter(l => l.trim().length > 0);
    const hasValidLine = lines.some(line => line.includes(',') && line.split(',').length >= 2);
    if (!hasValidLine) {
      res.status(400).json({ error: "No valid email,password lines found in input" });
      return;
    }

    const credsDir = path.join(process.cwd(), "credentials");
    if (!fs.existsSync(credsDir)) fs.mkdirSync(credsDir, { recursive: true });
    const newCsvPath = path.join(credsDir, `mobile_paste_${Date.now()}.csv`);

    // Format the raw text to CSV (assuming comma separated)
    let csvContent = rawText;
    if (!csvContent.toLowerCase().startsWith("email")) {
      csvContent = "email,password\n" + csvContent;
    }

    await fs.promises.writeFile(newCsvPath, csvContent);
    await importCsv(newCsvPath);

    const targetNames = DEFAULT_TARGETS.filter(t => t.selectors?.username).map(t => t.name);
    cachedCredentials = getUntestedCredentials(targetNames);

    log.info(`Mobile text-paste uploaded — ${cachedCredentials.length} credentials loaded`);
    res.json({ success: true, queued: cachedCredentials.length });
  } catch (err: unknown) {
    log.error("Mobile paste error:", (err instanceof Error ? err.message : String(err)));
    res.status(400).json({ error: "Failed to parse credentials: " + (err instanceof Error ? err.message : String(err)) });
  }
});

app.post("/api/upload-csv", async (req, res) => {
  try {
    if (!isSafeToken(readHeader(req, "x-csrf-token"), CSRF_TOKEN)) {
      res.status(403).json({ error: "Invalid CSRF token" });
      return;
    }
    const fileBuffer = await parseMultipartFile(req);
    const credsDir = path.join(process.cwd(), "credentials");
    if (!fs.existsSync(credsDir)) fs.mkdirSync(credsDir, { recursive: true });
    const newCsvPath = path.join(credsDir, `upload_${Date.now()}.csv`);
    await fs.promises.writeFile(newCsvPath, fileBuffer);

    await importCsv(newCsvPath);

    const targetNames = DEFAULT_TARGETS.filter(t => t.selectors?.username).map(t => t.name);
    cachedCredentials = getUntestedCredentials(targetNames);
    const creds = cachedCredentials;
    log.info(`CSV uploaded — ${creds.length} credentials loaded`);
    res.json({ credentials: creds.map((c) => ({ email: c.email })) });
  } catch (err: unknown) {
    log.error("CSV upload error:", (err instanceof Error ? err.message : String(err)));
    res.status(400).json({ error: (err instanceof Error ? err.message : String(err)) });
  }
});

// ── Flow Screenshot API ──────────────────────────────────────────────────
import { FlowScreenshotter } from "../services/flow-screenshotter.js";

// Prune old flow-step sessions on startup (keeps last 100)
FlowScreenshotter.pruneOldSessions();

app.get("/api/flow-steps/sessions", (_req, res) => {
  try {
    const sessions = FlowScreenshotter.listSessions();
    res.json({ sessions });
  } catch (e: unknown) {
    res.status(500).json({ error: (e instanceof Error ? e.message : String(e)) });
  }
});

app.get("/api/flow-steps/:sessionId/:filename", (req, res) => {
  try {
    const filePath = path.join(process.cwd(), "screenshots", "flow-steps", req.params.sessionId, req.params.filename);
    if (!fs.existsSync(filePath)) {
      res.status(404).json({ error: "File not found" });
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const mimeMap: Record<string, string> = { ".webp": "image/webp", ".png": "image/png", ".json": "application/json" };
    res.setHeader("Content-Type", mimeMap[ext] || "application/octet-stream");
    res.sendFile(filePath);
  } catch (e: unknown) {
    res.status(500).json({ error: (e instanceof Error ? e.message : String(e)) });
  }
});
app.get("/api/credentials/history", (_req, res) => {
  try {
    const history = getAllCredentialsHistory();
    res.json({ history });
  } catch (e: unknown) {
    res.status(500).json({ error: (e instanceof Error ? e.message : String(e)) });
  }
});

app.get("/api/tempdisabled/categorized", (_req, res) => {
  try {
    const categories = getCategorizedTempDisabled();
    res.json({ categories });
  } catch (e: unknown) {
    res.status(500).json({ error: (e instanceof Error ? e.message : String(e)) });
  }
});

// ─── Internal Fingerprint Audit System ──────────────────────────────────────────
const auditResults: any[] = [];

app.post("/audit-fp", express.json(), (req, res) => {
  try {
    // Localhost-only guard — only our own Playwright page.evaluate calls should reach this
    const remoteAddr = req.socket.remoteAddress || "";
    if (!remoteAddr.includes("127.0.0.1") && remoteAddr !== "::1") {
      return res.status(403).json({ error: "forbidden" });
    }

    const { expectedUA, expectedOS, jsEvidence } = req.body;

    // Null-safety: malformed POST body would otherwise crash the handler
    if (!jsEvidence?.userAgent || !jsEvidence?.platform) {
      return res.status(400).json({ error: "missing jsEvidence fields" });
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const _ja3 = readHeader(req, "x-_ja3") || req.socket.remoteAddress;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const _http2Info = readHeader(req, "x-http2-fingerprint");

    // Check for mismatch
    const isMismatch = !jsEvidence.userAgent.includes(expectedUA) ||
      !jsEvidence.platform.toLowerCase().includes(expectedOS.toLowerCase());

    if (isMismatch) {
      log.warn(`[LiveAuditor] Mismatch Detected! Expected UA: ${expectedUA}, OS: ${expectedOS}. Got: ${jsEvidence.userAgent}`);
    } else {
      log.info(`[LiveAuditor] Coherent fingerprint verified for ${expectedOS}`);
    }

    res.json({ success: true, isMismatch });
  } catch (err: unknown) {
    log.error("[LiveAuditor] Submission error:", (err instanceof Error ? err.message : String(err)));
    res.status(500).json({ error: (err instanceof Error ? err.message : String(err)) });
  }
});

app.post("/api/audit/submit", express.json(), (req, res) => {
  try {
    auditResults.push(req.body);
    log.info(`[Audit] Received fingerprint data for seed: ${req.body.seed}`);
    res.json({ success: true });
  } catch (err: unknown) {
    log.error("[Audit] Submission error:", (err instanceof Error ? err.message : String(err)));
    res.status(500).json({ error: (err instanceof Error ? err.message : String(err)) });
  }
});

app.get("/api/audit/results", (_req, res) => {
  res.json({ results: auditResults });
});

app.post("/api/audit/reset", (_req, res) => {
  auditResults.length = 0;
  res.json({ success: true });
});

// Read-only view of the persistent email denylist for the dashboard's
// "View denylist" affordance. Returns the in-memory state (kept in sync
// with email-denylist.json by the engine on every burn and at end-of-run).
// No mutation endpoints are exposed here — operators edit the sidecar JSON
// directly when they need to add/remove entries by hand.
app.get("/api/email-denylist", (_req, res) => {
  try {
    const targetNames = DEFAULT_TARGETS.filter((t: any) => t.selectors?.username).map((t: any) => t.name);
    const emails = Array.from(new Set(targetNames.flatMap((t: string) => emailDenylist.getAll(t)))).sort();
    res.json({ count: emails.length, emails });
  } catch (err: unknown) {
    log.error("email-denylist read error:", (err instanceof Error ? err.message : String(err)));
    res.status(500).json({ error: (err instanceof Error ? err.message : String(err)) });
  }
});

// ─── Deletion helpers (credentials.csv + progress.json) ───────────────────────

/** Rewrite credentials.csv keeping the header line untouched and dropping any
 *  data row whose email matches `dropSet` (case-insensitive, trim-sensitive).
 *  Atomic: writes to a tmp file then renames. Returns the count removed.
 *  No-ops cleanly when the file is missing or has only a header. */
async function filterCredentialsCsv(csvPath: string, dropSet: Set<string>): Promise<number> {
  if (!fs.existsSync(csvPath)) return 0;
  const content = await fs.promises.readFile(csvPath, "utf-8");
  // Preserve the original newline style for downstream tooling that may
  // be sensitive to CRLF vs LF (Excel imports, in particular).
  const newline = content.includes("\r\n") ? "\r\n" : "\n";
  const lines = content.split(/\r\n|\n|\r/);
  if (lines.length < 2) return 0;
  // Trailing empty line is common — track and re-emit so the file shape
  // doesn't drift across edits.
  const hadTrailingNewline = lines[lines.length - 1] === "";
  const header = lines[0];
  const emailIdx = header!.split(",").map((h) => h.trim().toLowerCase()).indexOf("email");
  if (emailIdx < 0) return 0;
  const kept: string[] = [header!];
  let removed = 0;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line!.trim()) continue; // skip blank lines inside the file
    const parts = line!.split(",");
    const email = (parts[emailIdx] || "").trim().toLowerCase();
    if (email && dropSet.has(email)) {
      removed++;
      continue;
    }
    kept.push(line!);
  }
  if (removed === 0) return 0;
  const tmp = `${csvPath}.tmp`;
  await fs.promises.writeFile(tmp, kept.join(newline) + (hadTrailingNewline ? newline : ""), "utf-8");
  await fs.promises.rename(tmp, csvPath);
  return removed;
}
/** Prune screenshots older than the configured retention window.
 *  Used by the manual /api/cleanup-screenshots endpoint. */
// ─── Server-Sent Events (SSE) & WebSockets ───────────────────────────────────

export const sseClients: express.Response[] = [];

// --- Worker Architecture Status (real data from engine) ---
app.get("/api/workers/status", (_req, res) => {
  const rows = engine.isRunning ? (engine as any).rows as Array<{ status: string }> : [];
  const activeWorkers = rows.filter(r => r.status === "testing").length;
  const queueDepth = rows.filter(r => r.status === "queued").length;
  const tempDisabled = rows.filter(r => r.status === "tempdisabled").length;
  const done = rows.filter(r => r.status === "done" || r.status === "skipped").length;
  res.json({
    activeWorkers,
    queueDepth,
    tempDisabled,
    done,
    total: rows.length,
    engineRunning: engine.isRunning,
    enginePaused: engine.isPaused,
    nodes: ["local"],
    throughput: activeWorkers > 0 ? `${activeWorkers} active` : "idle"
  });
});

app.post("/api/workers/scale", express.json(), (req, res) => {
  const { workers } = req.body;
  log.info(`[WorkerPool] Scaling to ${workers} workers...`);
  res.json({ success: true, newWorkerCount: workers });
});

// ─── Hermes Health & Decision Journal API (Phase 3 — OpenClaw Integration) ───

const serverStartTime = Date.now();

app.get("/api/golden/stats", (_req, res) => {
  try {
    const statsPath = path.join(process.cwd(), 'data', 'latest-golden-benchmark.json');
    if (fs.existsSync(statsPath)) {
      const stats = JSON.parse(fs.readFileSync(statsPath, 'utf8'));
      res.json(stats);
    } else {
      res.json({ error: "No benchmark run found." });
    }
  } catch {
    res.status(500).json({ error: "Failed to load golden stats." });
  }
});

app.get("/api/health", (_req, res) => {
  try {
    const memUsage = process.memoryUsage();
    const summary = getResultSummary(targetNames);
    res.json({
      status: "ok",
      uptime: Math.round((Date.now() - serverStartTime) / 1000),
      engine: {
        isRunning: engine.isRunning,
        isPaused: engine.isPaused,
        activeSessions: engine.isRunning
          ? engine.rowStatuses.filter((s: any) => s.status === "testing").length
          : 0,
      },
      hermes: {
        alive: hermesProcess !== null && hermesProcess.connected,
        pid: hermesProcess?.pid ?? null,
      },
      memoryMB: Math.round(memUsage.heapUsed / 1024 / 1024),
      credentialProgress: {
        total: restoredRows.length,
        summary,
      },
      config: {
        backend: currentBackend,
        concurrency: currentConcurrency,
        proxyPool: currentProxyPool,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (err: unknown) {
    res.status(500).json({ error: (err instanceof Error ? err.message : String(err)) });
  }
});

app.get("/api/hermes/journal", (_req, res) => {
  try {
    // Lazy-load to avoid circular dependency at module level
    const { getRecentDecisions } = require("../hermes/decision-journal.js");
    const limit = parseInt(String((_req as any).query?.limit ?? "50"), 10);
    const entries = getRecentDecisions(Math.min(limit, 200));
    res.json({ entries, count: entries.length });
  } catch (err: unknown) {
    res.status(500).json({ error: (err instanceof Error ? err.message : String(err)) });
  }
});

app.get("/api/hermes/stats", async (_req, res) => {
  try {
    const { getJournalStats } = await import("../hermes/decision-journal.js");
    const { getStats } = await import("../hermes/learning-db.js");
    res.json({
      journal: getJournalStats(),
      learning: getStats(),
    });
  } catch (err: unknown) {
    res.status(500).json({ error: (err instanceof Error ? err.message : String(err)) });
  }
});

// WAF Fuzzer Endpoint
app.post("/api/waf/fuzzer", express.json(), async (req, res) => {
    try {
        const { active } = req.body;
        if (active) {
            const { spawn } = await import("child_process");
            const p = spawn("npx", ["tsx", ".agents/sidecars/fuzzer.ts"], { detached: true, stdio: "ignore" });
            p.unref();
            res.json({ status: "started" });
        } else {
            const cp = await import("child_process");
            cp.exec("pkill -f fuzzer.ts", () => {});
            res.json({ status: "stopped" });
        }
    } catch(e) {
        res.status(500).json({ error: String(e) });
    }
});
// Master Orchestrator Endpoint
app.post("/api/orchestrator/start", async (_req, res) => {
    try {
        const { globalOrchestrator } = await import("../orchestrator.js");
        globalOrchestrator.start();
        res.json({ status: "Orchestrator online" });
    } catch(e) {
        res.status(500).json({ error: String(e) });
    }
});

app.get("/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.flushHeaders();
  sseClients.push(res);
  req.on("close", () => {
    const idx = sseClients.indexOf(res);
    if (idx !== -1) sseClients.splice(idx, 1);
  });
});

export { WsMessageSchema, SetConcurrencySchema, SetBackendSchema };

let sseBuffer = "";
let sseFlushTimer: NodeJS.Timeout | null = null;

function broadcast(data: any): void {
  let msg = "";
  try {
    msg = JSON.stringify(data);
  } catch (e) {
    log.error(`[Server] Failed to serialize broadcast data (type: ${data?.type}): ${String(e)}`);
    return;
  }
  const isHighFrequency = ["log", "vitals", "screenshot", "row-update"].includes(data.type);

  if (isHighFrequency) {
    // Route telemetry and data streams to SSE for better performance.
    // Batch writes every 50ms to prevent UI/Node lockups under extreme concurrency.
    sseBuffer += `data: ${msg}\n\n`;
    if (!sseFlushTimer) {
      sseFlushTimer = setTimeout(() => {
        const payload = sseBuffer;
        sseBuffer = "";
        sseFlushTimer = null;
        sseClients.forEach((client) => {
          client.write(payload);
        });
      }, 50);
    }
  } else {
    // Keep control and config updates on WebSocket
    wss.clients.forEach((client: any) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(msg);
      }
    });
  }
}

// ─── Screenshot Buffer ─────────────────────────────────────────────────────
// Stores recent screenshot events per email so reconnecting dashboards can
// replay them. Strips base64 data to avoid memory bloat.
const screenshotBuffer: Map<string, Array<{
  label: string; relativePath: string; sizeBytes: number;
  timestamp: string; target?: string; email?: string;
}>> = new Map();
const SCREENSHOT_BUFFER_MAX_PER_EMAIL = 20;

function bufferScreenshot(data: any): void {
  if (!data || !data.email) return;
  const key = data.email.toLowerCase();

  if (!screenshotBuffer.has(key)) {
    screenshotBuffer.set(key, []);
    // Prevent memory leak over long 24/7 runs: cap the map size to 500 emails
    // Maps preserve insertion order, so keys().next().value is the oldest entry
    if (screenshotBuffer.size > 500) {
      const oldestKey = screenshotBuffer.keys().next().value;
      if (oldestKey) screenshotBuffer.delete(oldestKey);
    }
  }

  const list = screenshotBuffer.get(key)!;
  // Store without base64 to avoid memory bloat
  list.push({
    label: data.label,
    relativePath: data.relativePath,
    sizeBytes: data.sizeBytes,
    timestamp: data.timestamp,
    target: data.target,
    email: data.email,
  });
  if (list.length > SCREENSHOT_BUFFER_MAX_PER_EMAIL) list.shift();
}

function replayScreenshotsToClient(client: any): void {
  let total = 0;
  for (const [, events] of screenshotBuffer) {
    for (const evt of events) {
      try {
        client.send(JSON.stringify({ type: "screenshot", data: evt }));
        total++;
      } catch { /* ignore send failures */ }
    }
  }
  if (total > 0) {
    log.info(`Replayed ${total} buffered screenshots to reconnecting client`);
  }
}

/** Scan the screenshots directory on startup and pre-populate the buffer
 *  so existing screenshots appear immediately on dashboard connect. */
function seedScreenshotBufferFromDisk(): void {
  const dir = path.join(process.cwd(), Timings.SCREENSHOT_DIR);
  if (!fs.existsSync(dir)) return;
  try {
    const files = fs.readdirSync(dir).filter(f => /\.(jpg|jpeg|png)$/i.test(f));
    let seeded = 0;
    for (const file of files) {
      // Parse email and target from filename: email__backend__target__label__timestamp__uuid.ext
      const parts = file.split("__");
      if (parts.length < 3) continue;
      const emailSlug = parts[0] || "unknown";
      // Reconstruct email: filename encodes @ as _ so brendanstone88_gmail.com → brendanstone88@gmail.com
      // Find the last underscore before a known domain suffix and convert it to @
      const email = emailSlug.replace(
        /_(gmail\.com|yahoo\.com|hotmail\.com|outlook\.com|live\.com|live\.com\.au|yandex\.com|protonmail\.com|icloud\.com|aol\.com|mail\.com|zoho\.com|gmx\.com|fastmail\.com|yahoo\.co\.uk|hotmail\.co\.uk|inbox\.com)$/i,
        '@$1'
      );
      // Target is typically parts[2] (after backend)
      const target = (parts.length >= 4 ? parts[2] : "") || "";
      const label = (parts.length >= 5 ? parts[3] : parts[parts.length - 1]) || "";
      const fullPath = path.join(dir, file);
      const stats = fs.statSync(fullPath);
      bufferScreenshot({
        email,
        target: target.replace(/_/g, ""),
        label: label.replace(/_/g, " "),
        relativePath: file,
        sizeBytes: stats.size,
        timestamp: stats.mtime.toISOString(),
      });
      seeded++;
    }
    if (seeded > 0) {
      log.info(`[Screenshot] Seeded buffer with ${seeded} existing screenshots from disk`);
    }
  } catch (e: unknown) {
    log.warn(`[Screenshot] Failed to seed buffer from disk: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// Seed on startup
seedScreenshotBufferFromDisk();

// ─── Gemini API Key Validation ─────────────────────────────────────────────
if (isVerificationAvailable()) {
  validateAiConfig();
}

// ─── GCS Cloud Upload ──────────────────────────────────────────────────────
const gcsUploader = createGcsUploaderFromEnv((level, msg) => log[level.toLowerCase() as 'info' | 'warn' | 'error']?.(`[GCS] ${msg}`) ?? log.info(`[GCS] ${msg}`));
if (gcsUploader) {
  // Attach to screenshot service so all new screenshots get uploaded
  engine.screenshotSvc.setGcsUploader(gcsUploader);

  // Relay GCS upload events to dashboard and persist confident screenshots
  engine.screenshotSvc.on("gcs-uploaded", (data) => {
    broadcast({ type: "gcs-uploaded", data });
    log.info(`[GCS] Uploaded: ${data?.email} → ${data?.gcsUrl}`);

    // If the upload was for a confident outcome, persist it into the database permanently
    if (data.email && data.label && data.gcsUrl) {
      const isTerminal = ["success", "blocked", "honeypot", "permdisabled", "noaccount", "2fa"].some(t => data.label.toLowerCase().includes(t));
      if (isTerminal) {
        import("../core/database.js").then((db) => {
          // Extract the base outcome string from the label for the database lookup
          const outcomeMatch = data.label.match(/(success|blocked|honeypot|permdisabled|noaccount|2fa)/i);
          const outcome = outcomeMatch ? outcomeMatch[1].toLowerCase() : data.label;
          db.updateScreenshotUrl(data.email, outcome, data.gcsUrl);
        }).catch(() => { /* silent */ });
      }
    }
  });

  // Ensure bucket exists and backfill existing screenshots on startup
  void (async () => {
    try {
      await gcsUploader.ensureBucket();
      const dir = path.join(process.cwd(), Timings.SCREENSHOT_DIR);
      const uploaded = await gcsUploader.backfillFromDisk(dir);
      if (uploaded > 0) log.info(`[GCS] Backfilled ${uploaded} screenshots to cloud`);
    } catch (e: unknown) {
      log.warn(`[GCS] Startup backfill failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  })();
}

function broadcastProxyHealth() {
  broadcast({ type: "proxy-health-update", data: proxyScoreTracker.getDetailedScores() });
}
process.env.VITEST ? null : setInterval(() => {
  if (engine.isRunning && !engine.isPaused) {
    broadcastProxyHealth();
  }
}, 5000).unref();
engine.on("row-update", (data) => {
  broadcast({ type: "row-update", data });
  if (hermesProcess && !hermesProcess.killed && hermesProcess.connected) {
    hermesProcess.send({ type: "row-update", data });
  }

  // ── Structured failure telemetry ──
  if (data.type === "row-update" && data.data?.outcome && !String(data.data.outcome).startsWith("success")) {
    try {
      const telemetry = parseRowUpdate(data);
      if (telemetry.failureType !== "unknown") {
        const rateLimit = trackRequest(data.data.site || "unknown");
        if (rateLimit) {
          log.warn(`[Telemetry] Rate limit warning for domain ${data.data.site}`);
        }
      }
    } catch (e) {
      log.warn(`[Telemetry] Failed to parse row update: ${String(e)}`);
    }
  }

  // Live Cloud Upload for Session Recordings
  if (gcsUploader && data.recordingUrl && !data.recordingUrl.startsWith("http")) {
    const fullPath = path.resolve(process.cwd(), data.recordingUrl.replace(/^\.?\//, ""));
    if (fs.existsSync(fullPath)) {
      gcsUploader.upload(fullPath, { target: "recording" }).then(res => {
        if (res && res.publicUrl) {
          data.recordingUrl = res.publicUrl;
          broadcast({ type: "row-update", data }); // Rebroadcast with updated cloud URL
          // Persist the cloud video URL to the database
          import("../core/database.js").then((db) => {
            db.updateRecordingUrl(data.email, res.publicUrl);
          }).catch(() => { /* silent */ });
        }
      }).catch(err => log.warn(`[GCS] Live video upload failed for ${data.email}: ${err instanceof Error ? err.message : String(err)}`));
    }
  }

  // Update color-coded XLSX on every row change
  if (currentRunCredentials.length > 0) {
    updateCredentialXlsx(currentRunCredentials, (engine as any).rows);
  }

  // ── Permdisabled auto-archive: save to permdisabled/permdisabled.csv,
  //    add to denylist, and remove from credentials.csv ──
  if (data && data.email && data.sites) {
    const permSites = Object.entries(data.sites as Record<string, any>)
      .filter(([, s]: [string, any]) => s.outcome === "permdisabled")
      .map(([name]: [string, any]) => name);
    const hasPermDisabled = permSites.length > 0;
    if (hasPermDisabled && !permDisabledArchived.has(data.email.toLowerCase())) {
      permDisabledArchived.add(data.email.toLowerCase());
      appendPermDisabledCsv(data.email, permSites.join("+"));
      // Belt-and-suspenders: ensure denylist has this email
      let addedAny = false;
      for (const t of permSites) {
        if (emailDenylist.add(data.email, t, "permdisabled-autoarchive")) addedAny = true;
      }
      if (addedAny) {
        emailDenylist.saveAll().catch(() => { });
      }
      // Remove from main credentials.csv (deferred — don't block the event)
      setImmediate(async () => {
        try {
          const dropSet = new Set([data.email.toLowerCase()]);
          const csvRemoved = await filterCredentialsCsv(CSV_PATH, dropSet);
          if (csvRemoved > 0) {
            log.info(`[PermDisabled] Archived & removed ${data.email} from credentials.csv`);
            broadcast({
              type: "rows-deleted",
              data: {
                emails: [data.email],
                message: `🚫 ${data.email} permanently disabled — archived to permdisabled.csv & removed`,
              },
            });
          }
        } catch (e: unknown) {
          log.warn(`[PermDisabled] CSV removal failed for ${data.email}: ${e instanceof Error ? e.message : String(e)}`);
        }
      });
    }
  }
});

// ── Rolling Outcome Tracker & N/A Auto-Heal ──────────────────────────────────
const ROLLING_WINDOW = 30;
const rollingOutcomes: string[] = [];
let consecutiveNAs = 0;
let lastHealthBroadcast = 0;

engine.on("row-update", (data) => {
  if (!data?.sites || data.status !== "done") return;

  // Collect outcomes from all sites for this row
  for (const [, s] of Object.entries(data.sites as Record<string, any>)) {
    if (!s.outcome || s.outcome === "queued" || s.outcome === "testing" || s.outcome === "skipped") continue;

    rollingOutcomes.push(s.outcome);
    if (rollingOutcomes.length > ROLLING_WINDOW) rollingOutcomes.shift();

    // Track consecutive N/A
    if (s.outcome === "N/A") {
      consecutiveNAs++;
    } else {
      consecutiveNAs = 0;
    }
  }

  // Only analyze when we have enough data
  if (rollingOutcomes.length < 10) return;

  const naCount = rollingOutcomes.filter(o => o === "N/A").length;
  const naRate = Math.round((naCount / rollingOutcomes.length) * 100);
  const successCount = rollingOutcomes.filter(o => o === "success" || o === "tempdisabled" || o === "2FA").length;
  const successRate = Math.round((successCount / rollingOutcomes.length) * 100);

  // Periodic health summary (every 25 outcomes)
  const now = Date.now();
  if (now - lastHealthBroadcast > 60_000 && rollingOutcomes.length >= 20) {
    lastHealthBroadcast = now;
    const outcomeMap: Record<string, number> = {};
    for (const o of rollingOutcomes) outcomeMap[o] = (outcomeMap[o] || 0) + 1;
    const summary = Object.entries(outcomeMap)
      .sort(([, a], [, b]) => b - a)
      .map(([k, v]) => `${k}:${v}`)
      .join(" ");
    broadcast({ type: "log", data: { level: "INFO", message: `[📊 Health] Rolling ${rollingOutcomes.length}: ${summary} | N/A:${naRate}% | Positive:${successRate}%` } });
  }

  // ── Auto-Heal Triggers ──

  // CRITICAL: 5+ consecutive N/A → immediate alert + Hermes review
  if (consecutiveNAs >= 5) {
    log.warn(`[🚨 Auto-Heal] ${consecutiveNAs} consecutive N/A outcomes — triggering emergency review`);
    broadcast({ type: "log", data: { level: "ERR", message: `[🚨 Auto-Heal] ${consecutiveNAs} CONSECUTIVE N/A — something is broken! Triggering Hermes review.` } });
    broadcast({ type: "hermes-alert", data: { level: "CRITICAL", message: `${consecutiveNAs} consecutive N/A outcomes detected`, timestamp: new Date().toISOString() } });
    runHermesReview();
    consecutiveNAs = 0; // Reset to avoid spam
  }

  // HIGH: N/A rate > 30% in rolling window → alert
  if (naRate > 30 && rollingOutcomes.length >= 15) {
    log.warn(`[⚠️ Auto-Heal] N/A rate at ${naRate}% (${naCount}/${rollingOutcomes.length}) — elevated failure rate`);
  }
});
let lastExperimentalStats: any[] = [];
engine.on("experimental-stats", (data: any) => {
  lastExperimentalStats = data;
  broadcast({ type: "experimental-stats", data });
});
engine.on("rotation-stats", (data: any) => broadcast({ type: "rotation-stats", data }));
engine.on("rotation-backend-eliminated", (data: any) => broadcast({ type: "rotation-backend-eliminated", data }));
engine.on("rotation-report", (data: any) => broadcast({ type: "rotation-report", data }));
engine.on("rotation-auto-fixes", (data: any) => broadcast({ type: "rotation-auto-fixes", data }));
engine.on("benchmark-update", (data: any) => broadcast({ type: "benchmark-update", data }));
engine.on("benchmark-complete", (data: any) => broadcast({ type: "benchmark-update", data }));
engine.on("complete", (data: any) => {
  // Prune any pool entries that idled across the run so the next run starts
  // with a fresh pool instead of inheriting stale connections.

  // Refresh the SQLite-backed state so any dashboard that connects after the
  // run completes sees the latest results without requiring another run.
  try {
    cachedCredentials = getUntestedCredentials(targetNames);
    restoredRows = getAllCredentialsWithLatestStatus(targetNames);
    log.info(`Post-run DB refresh: ${restoredRows.length} credentials, ${cachedCredentials.length} untested remaining`);
  } catch (e) {
    log.warn(`Post-run DB refresh failed: ${String(e)}`);
  }

  // Target Memory Logic
  if (currentBackend === "experimental-elimination" && lastExperimentalStats.length > 0) {
    try {
      const winner = lastExperimentalStats.reduce((prev, curr) => {
        const ratePrev = prev.totalAttempts > 0 ? prev.decisive / prev.totalAttempts : 0;
        const rateCurr = curr.totalAttempts > 0 ? curr.decisive / curr.totalAttempts : 0;
        return rateCurr > ratePrev ? curr : prev;
      });
      const activeTarget = targetNames[0]; // Primary target
      if (activeTarget && winner) {
        saveTargetWinner(activeTarget, winner.backend);
        broadcast({ type: "target-winners", data: getTargetWinners() });
      }
    } catch (e) {
      log.warn(`Failed to process target winner: ${String(e)}`);
    }
  }

  try {
    broadcast({ type: "tempdisabled-categories", data: getCategorizedTempDisabled() });
  } catch (e) {
    log.warn(`Failed to broadcast temp disabled: ${String(e)}`);
  }

  // Flush color-coded XLSX with final state
  if (currentRunCredentials.length > 0) {
    flushCredentialXlsx(currentRunCredentials, (engine as any).rows).catch(e => log.warn(`XLSX flush error: ${e}`));
  }

  broadcast({ type: "complete", data });

  // Auto-trigger Hermes review + proxy validation after every batch
  runHermesReview();

  // ── Hermes Observer: Post-batch analysis ──
  (async () => {
    try {
      const ops = new OpsOrchestrator();
      const proposalCount = await ops.postBatchAnalysis(4);
      const deepAnalysis = await ops.deepBatchAnalysis(4);
      if (proposalCount > 0 || deepAnalysis) {
        broadcast({
          type: "observer-batch-analysis",
          data: { proposalCount, deepAnalysis, proposals: getPendingProposals() }
        });
      }
    } catch (e) {
      log.warn(`[Observer] Post-batch analysis failed: ${String(e)}`);
    }
  })();

  // ── Generate run summary report ──
  (async () => {
    try {
      const { generateRunSummary } = await import("../hermes/reports.js");
      const events = (currentRunCredentials ?? []).map((cred: any) => ({ data: { email: String(cred.email ?? cred), outcome: "unknown", creditsSpent: 0 } }));
      const report = generateRunSummary(events);
      log.info(`Run summary report saved: ${report.reportPath}`);
    } catch (e) {
      log.warn(`[Reports] Failed to generate run summary: ${String(e)}`);
    }
  })();
});
engine.on("stopping", () => broadcast({ type: "stopping" }));
// End-of-pass handler: lightweight DB refresh for the dashboard without
// triggering Hermes review or XLSX flush (those only fire on final "complete").
engine.on("pass-complete", (data: any) => {
  try {
    cachedCredentials = getUntestedCredentials(targetNames);
    restoredRows = getAllCredentialsWithLatestStatus(targetNames);
    log.info(`End-of-pass DB refresh: ${restoredRows.length} credentials, ${cachedCredentials.length} untested remaining`);
  } catch (e) {
    log.warn(`End-of-pass DB refresh failed: ${String(e)}`);
  }
  broadcast({ type: "pass-complete", data });
});

// 🦎 Darwin Mode: Hard review when all backends are eliminated
engine.on("darwin-all-eliminated", (diagnostic: any) => {
  log.info(`[Darwin] ALL backends eliminated — triggering hard review`);

  // 1. Broadcast full diagnostic to dashboard
  broadcast({ type: "darwin-report", data: diagnostic });
  broadcast({ type: "log", data: { level: "ERR", message: `🦎🔴 DARWIN MODE: All ${diagnostic.totalBackendsTested} backends eliminated after ${diagnostic.totalAttempts} attempts!` } });

  // 2. Broadcast each recommendation
  for (const rec of diagnostic.recommendations || []) {
    broadcast({ type: "log", data: { level: "WARN", message: `🦎 Recommendation: ${rec}` } });
  }

  // 3. Auto-apply recommended fixes based on error patterns
  const errorAgg: Record<string, number> = {};
  for (const b of diagnostic.backends || []) {
    for (const [sig, count] of Object.entries(b.errors || {})) {
      errorAgg[sig] = (errorAgg[sig] || 0) + (count as number);
    }
  }

  let fixesApplied = 0;

  // Fix: Cloudflare blocks → reduce concurrency + rotate proxy pool
  if ((errorAgg["cloudflare block"] || 0) > diagnostic.totalBackendsTested * 2) {
    const newConcurrency = Math.max(1, Math.floor(currentConcurrency / 2));
    if (newConcurrency !== currentConcurrency) {
      currentConcurrency = newConcurrency;
      engine.setConcurrency(newConcurrency);
      broadcast({ type: "concurrency", data: { value: newConcurrency } });
      broadcast({ type: "log", data: { level: "INFO", message: `🦎🔧 Auto-fix: Concurrency reduced to ${newConcurrency} (Cloudflare mitigation)` } });
      fixesApplied++;
    }
    // Rotate proxy pool if URL is set
    if (currentProxyRotateUrl) {
      broadcast({ type: "log", data: { level: "INFO", message: `🦎🔧 Auto-fix: Triggering proxy pool rotation via ${currentProxyRotateUrl}` } });
      try {
        fetch(currentProxyRotateUrl).catch(() => { });
      } catch { /* swallow */ }
      fixesApplied++;
    }
  }

  // Fix: Timeout dominance → reduce concurrency to 2
  if ((errorAgg["timeout"] || 0) > diagnostic.totalBackendsTested) {
    const newConcurrency = Math.min(currentConcurrency, 2);
    if (newConcurrency !== currentConcurrency) {
      currentConcurrency = newConcurrency;
      engine.setConcurrency(newConcurrency);
      broadcast({ type: "concurrency", data: { value: newConcurrency } });
      broadcast({ type: "log", data: { level: "INFO", message: `🦎🔧 Auto-fix: Concurrency reduced to ${newConcurrency} (Timeout mitigation)` } });
      fixesApplied++;
    }
  }

  // Fix: Proxy connect errors → switch to next proxy pool
  if ((errorAgg["proxy connect error"] || 0) > diagnostic.totalBackendsTested) {
    const pools = ["1", "2", "3", "4"];
    const currentIdx = pools.indexOf(currentProxyPool);
    const nextPool = pools[(currentIdx + 1) % pools.length] || "1";
    if (nextPool !== currentProxyPool) {
      currentProxyPool = nextPool;
      if (currentEngineConfig) currentEngineConfig.proxyPool = nextPool;
      broadcast({ type: "config-sync", data: { config: { proxyPool: nextPool } } });
      broadcast({ type: "log", data: { level: "INFO", message: `🦎🔧 Auto-fix: Proxy pool rotated to ${nextPool} (Proxy failure mitigation)` } });
      fixesApplied++;
    }
  }

  broadcast({ type: "log", data: { level: "INFO", message: `🦎 Darwin hard review complete. ${fixesApplied} auto-fixes applied. ${diagnostic.recommendations.length} recommendations generated.` } });

  // 4. Trigger Hermes AI review for deeper analysis
  runHermesReview();

  broadcast({ type: "log", data: { level: "INFO", message: `🦎 Hermes AI review triggered for post-mortem analysis. Check darwin-reports/ for full diagnostic.` } });
});
engine.on("screenshot", (data) => {
  // Enrich screenshot with current engine settings for the dashboard feed
  const enriched = {
    ...data,
    backend: data.backend || currentBackend,
    proxyPool: currentProxyPool,
    inputMode: currentInputMode,
    bypass: currentEngineConfig?.stealthBypassHttpCloak ? "on" : "off",
    cloak: currentEngineConfig?.useHttpCloak ? "on" : "off",
    concurrency: currentConcurrency,
  };
  bufferScreenshot(enriched);
  broadcast({ type: "screenshot", data: enriched });
  if (hermesProcess && !hermesProcess.killed && hermesProcess.connected) {
    hermesProcess.send({ type: "screenshot", data: enriched });
  }
  log.info(`[Screenshot] ${data?.email} → ${data?.label} [${enriched.backend}|proxy:${enriched.proxyPool}] (${data?.relativePath || 'no-path'})`);
});
engine.on("screenshot-error", (data) => broadcast({ type: "screenshot-error", data }));
engine.on("ai-verification", (data) => broadcast({ type: "ai-verification", data }));
engine.on("telemetry_matrix", (data) => broadcast({ type: "telemetry_matrix", data }));
engine.on("dom-mutation", (data) => broadcast({ type: "hermes-mutation", data }));
timelineEvents.on("human-query-required", (data) => broadcast({ type: "human-query", data }));
engine.on("concurrency-live", (data) => {
  // Sync the actual concurrency back to the UI so it always reflects reality
  currentConcurrency = data.value;
  broadcast({ type: "concurrency-live", data: { value: data.value, reason: data.reason } });
});
engine.screenshotSvc.on("queue-pressure", (data) => broadcast({ type: "screenshot-queue-pressure", data }));

// ── Periodic Batch Stats Broadcaster ─────────────────────────────────────────
// Pushes real-time batch run facts to the Command Centre every 5 seconds.
let batchStatsInterval: ReturnType<typeof setInterval> | null = null;
let batchStartTime: number = 0;
let batchTotalCredentials: number = 0;
engine.on("started", (data) => {
  broadcast({ type: "started", data });
  batchStartTime = Date.now();
  batchTotalCredentials = data?.total ?? 0;
  if (batchStatsInterval) clearInterval(batchStatsInterval);
  batchStatsInterval = process.env.VITEST ? null : setInterval(() => {
    if (!engine.isRunning) return;
    const rows = (engine as any).rows as any[] | undefined;
    let completed = 0, active = 0, success = 0, fail = 0, twofa = 0, noaccount = 0, blocked = 0, _queued = 0;
    if (rows && Array.isArray(rows)) {
      for (const row of rows) {
        const status = row.status || row.state;
        if (status === "done" || status === "complete" || status === "skipped") completed++;
        else if (status === "testing" || status === "in-progress") active++;
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        else _queued++;
        // Count per-site outcomes
        if (row.sites) {
          for (const [, site] of Object.entries(row.sites as Record<string, any>)) {
            const o = (site).outcome;
            if (o === "success") success++;
            else if (o === "tempdisabled" || o === "permdisabled") blocked++;
            else if (o === "2FA") twofa++;
            else if (o === "noaccount") noaccount++;
            else if (o === "N/A" || o === "error") fail++;
          }
        }
      }
    }
    const elapsed = Math.round((Date.now() - batchStartTime) / 1000);
    broadcast({
      type: "batch-stats",
      data: {
        total: batchTotalCredentials,
        completed,
        active,
        queued: Math.max(0, batchTotalCredentials - completed - active),
        success,
        blocked,
        twofa,
        noaccount,
        fail,
        elapsed,
        liveConcurrency: engine.currentConcurrency,
        targetConcurrency: currentConcurrency,
        backend: currentBackend,
        proxyPool: currentProxyPool,
      }
    });
  }, 5000).unref();
});
engine.on("complete", () => {
  if (batchStatsInterval) { clearInterval(batchStatsInterval); batchStatsInterval = null; }
});

wss.on("connection", (ws: any, req: import("http").IncomingMessage) => {
  const ip = wsRemoteAddress(req);
  if (!allowWsConnection(ip)) {
    log.warn(`WebSocket rate limit exceeded for ${ip}`);
    ws.close(1013, "rate limit exceeded");
    return;
  }

  const isLocalhost = ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
  if (!isLocalhost) {
    const url = new URL(req.url || "", `http://${req.headers.host}`);
    const token = url.searchParams.get("token");
    if (token !== MOBILE_API_KEY) {
      log.warn(`Unauthorized WebSocket connection attempt from ${ip}`);
      ws.close(1008, "Unauthorized");
      return;
    }
  }

  log.info(`Client connected from ${ip}`);

  // Send initial state — when a run is active, use the live engine rows;
  // otherwise hydrate from SQLite so the dashboard restores across restarts.
  // IMPORTANT: credentials and rows must be index-aligned (credentials[i]
  // corresponds to rows[i]). When restoring from DB, derive both from the
  // same source (restoredRows) to guarantee alignment.
  let liveRows: any[] = restoredRows;
  if (engine.isRunning) {
    liveRows = restoredRows.map((r) => {
      const active = engine.rowStatuses.find((s) => s.email === r.email);
      return active ? { ...r, ...active } : r;
    });
  }
  const credList = restoredRows.map((r) => ({ email: r.email }));
  try {
    ws.send(
      JSON.stringify({
        type: "init",
        data: {
          credentials: credList,
          config: {
            concurrency: currentConcurrency,
            proxyPool: currentProxyPool,
            fpStrategy: currentFpStrategy,
            emulateMobile: currentEmulateMobile,
            spiderApiKey: currentSpiderApiKey,
            inputMode: currentInputMode,
            backend: currentBackend,
            enableCacheInjection: currentEnableCacheInjection,
            recordVideo: currentRecordVideo,
            enablePlaywrightTracing: currentEnablePlaywrightTracing,
            // postLoadDelay has been deprecated
            hasSpiderKey: false,
            hasSpiderLocalKey: false,
            maxRetries: currentMaxRetries,
            targets: DEFAULT_TARGETS.map((t) => t.name),
            screenshotCarouselMax: Timings.SCREENSHOT_CAROUSEL_MAX,
            csrfToken: CSRF_TOKEN,
            enableVerification: currentEnableVerification,
            hasVerificationKey: isVerificationAvailable(),
            parallelSiteTesting: currentParallelSiteTesting,
            disabledBackends: currentDisabledBackends,
            ignitionVerifBypass: currentIgnitionVerifBypass,
            useHttpCloak: currentUseHttpCloak,
            stealthBypassHttpCloak: currentStealthBypass,
            injectStealthJS: currentInjectStealthJS,
            rotateOnFingerprint: currentRotateOnFingerprint,
            burnOnlyOnPermDisabled: currentBurnOnlyOnPermDisabled,
            mutateOnRetry: currentMutateOnRetry,
            proxyRotateUrl: currentProxyRotateUrl,
            manualCaptchaMode: currentManualCaptchaMode,
            autoOptimizePerBackend: currentAutoOptimizePerBackend,
            proxyPools: (() => { try { return JSON.parse(fs.readFileSync(path.join(process.cwd(), "proxy-config.json"), "utf8")).pools; } catch { return []; } })(),
          },
          isRunning: engine.isRunning,
          enginePaused: engine.isPaused,
          rows: liveRows,
          proxyHealth: proxyScoreTracker.getDetailedScores(),
          hermes: { ...hermesStatus, alive: !!(hermesProcess && !hermesProcess.killed && hermesProcess.connected) },
        },
      })
    );
  } catch (e) { log.error(`Failed to send initial WS init payload: ${String(e)}`); }

  // Replay buffered screenshots so refreshing the dashboard doesn't lose feeds
  replayScreenshotsToClient(ws);

  try { ws.send(JSON.stringify({ type: "target-winners", data: getTargetWinners() })); } catch (e) { log.warn(`Failed to send initial target-winners: ${String(e)}`); }
  try {
    ws.send(JSON.stringify({ type: "tempdisabled-categories", data: getCategorizedTempDisabled() }));
  } catch (e) {
    log.warn(`Failed to send initial tempdisabled categories: ${String(e)}`);
  }

  // Handle messages from client (wrapped in IIFE to catch async rejections)
  ws.on("message", (raw: any) => {
    void (async () => {
      try {
        // Validate raw input before parsing
        if (!raw || typeof raw.toString !== 'function') {
          throw new Error('Invalid message format: raw data is null or not a buffer');
        }
        const rawStr = raw.toString();
        if (!rawStr || rawStr.length === 0) {
          throw new Error('Invalid message format: empty message');
        }
        // Limit message size to prevent DoS
        if (rawStr.length > 1024 * 1024) { // 1MB limit
          throw new Error('Invalid message format: message too large');
        }
        const rawJson = JSON.parse(rawStr);
        // Validate message structure with Zod
        const parsed = WsMessageSchema.safeParse(rawJson);
        if (!parsed.success) {
          throw new Error('Invalid message format: ' + parsed.error.message);
        }
        const msg = parsed.data as any;

        switch (msg.type) {
          case "set-mode": {
            if (msg.mode === "parallel" || msg.mode === "sequential") {
              currentParallelSiteTesting = msg.mode === "parallel";
              if (currentEngineConfig) {
                currentEngineConfig.parallelSiteTesting = currentParallelSiteTesting;
              }
              broadcast({ type: "config-sync", data: { config: { parallelSiteTesting: currentParallelSiteTesting } } });
            }
            break;
          }
          case "refresh-proxies": {
            let pools: any[] = [];
            try { pools = JSON.parse(fs.readFileSync(path.join(process.cwd(), "proxy-config.json"), "utf8")).pools; } catch { /* fallback to empty */ }
            broadcast({ type: "config-sync", data: { config: { proxyPools: pools } } });
            break;
          }
          case "save-app-config": {
            if (msg.config) {
              void ConfigStore.saveAsync(msg.config);
              broadcast({ type: "log", data: { level: "INFO", message: `💾 Saved settings as default to app-config.json` } });
            }
            break;
          }
          case "set-logic-toggle": {
            if (msg.data && msg.data.key) {
              const key = msg.data.key;
              const val = msg.data.value;
              if (!LOGIC_TOGGLE_ALLOWLIST.has(key)) {
                broadcast({ type: "log", data: { level: "WARN", message: `🚫 Rejected logic toggle for unknown key: ${key}` } });
                break;
              }
              if (currentEngineConfig) {
                (currentEngineConfig as any)[key] = val;
              }
              // Also auto-save logic toggles to default config
              void ConfigStore.saveAsync({ [key]: val });
              broadcast({ type: "config-sync", data: { config: { [key]: val } } });
              broadcast({ type: "log", data: { level: "INFO", message: `🔧 Logic toggle updated and saved: ${key} = ${val}` } });
            }
            break;
          }
          case "restart-server": {
            log.warn("♻️ Restart command received from Hermes. Shutting down gracefully before restart...");
            broadcast({ type: "log", data: { level: "WARNING", message: "Server is restarting for code patches..." } });
            void Promise.resolve(gracefulShutdown("RESTART")).finally(() => process.exit(0));
            break;
          }
          case "start": {
            log.info(`[DEBUG-START] Received 'start' command. engine.isRunning=${engine.isRunning}, currentBackend=${currentBackend}, emails=${msg.data?.emails?.length ?? 'none'}, backend=${msg.data?.backend}`);
            if (engine.isRunning) {
              log.info(`[DEBUG-START] Rejected: engine already running`);
              ws.send(JSON.stringify({ type: "error", data: { message: "Already running" } }));
              return;
            }

            // --- API KEY PREVALIDATION REMOVED ---

            // Detect golden-benchmark from the start payload's backend field
            const requestedBackend = msg.data?.backend;
            if (requestedBackend === "golden-benchmark") {
              currentBackend = "golden-benchmark";
            }

            let credentials = cachedCredentials;
            const selectedEmails = msg.data?.emails;
            if (currentBackend !== "golden-benchmark") {
              if (selectedEmails && Array.isArray(selectedEmails) && selectedEmails.length > 0) {
                // When the user explicitly selects emails from the dashboard,
                // fetch them directly from DB (with passwords) instead of
                // filtering from cachedCredentials — which only contains
                // *untested* credentials. This allows re-running credentials
                // that already have outcomes (tempdisabled, N/A, etc.).
                credentials = getCredentialsByEmails(selectedEmails);
              }

              if (credentials.length === 0) {
                ws.send(
                  JSON.stringify({ type: "error", data: { message: "No credentials to test" } })
                );
                return;
              }
            }

            // Resolve which targets to run: from dashboard (if provided) or default to all.
            const requestedTargetNames: string[] | undefined = msg.data?.targets;
            const allValidTargets = DEFAULT_TARGETS.filter((t) => t.selectors?.username && t.selectors?.password && t.selectors?.submit);
            const resolvedTargets = requestedTargetNames && Array.isArray(requestedTargetNames) && requestedTargetNames.length > 0
              ? allValidTargets.filter((t) => requestedTargetNames.includes(t.name))
              : allValidTargets;

            if (resolvedTargets.length === 0) {
              ws.send(
                JSON.stringify({ type: "error", data: { message: "No valid targets selected — ensure at least one target checkbox is checked" } })
              );
              return;
            }

            // Use live-tunable concurrency from dashboard (default 1 = headed-debug).
            const config: EngineConfig = {
              concurrency: currentConcurrency,
              maxRetries: currentMaxRetries,
              spiderSettings: currentSpiderSettings || undefined,
              targets: resolvedTargets,
              backend: currentBackend === "split-local-stealth" || currentBackend === "darwin" ? undefined : (currentBackend === "rotate-backends-headless" || currentBackend === "stealth-fortress" || currentBackend === "speed-blitz" || currentBackend === "headed-recon" ? "rotate-backends" : currentBackend),
              splitBackends: currentBackend === "split-local-stealth" ? ["stealth", "cloak-headless"] : undefined,
              enableCacheInjection: currentEnableCacheInjection,
              recordVideo: currentRecordVideo,
              enablePlaywrightTracing: currentEnablePlaywrightTracing,
              cleanSession: true,
              // postLoadDelay has been deprecated
              enableVerification: currentEnableVerification,
              fpStrategy: currentFpStrategy,
              proxyPool: currentProxyPool,
              parallelSiteTesting: msg.data?.parallelSites,
              useHttpCloak: currentUseHttpCloak,
              stealthBypassHttpCloak: currentStealthBypass,
              ignitionVerifBypass: currentIgnitionVerifBypass,
              rotateOnFingerprint: currentRotateOnFingerprint,
              burnOnlyOnPermDisabled: currentBurnOnlyOnPermDisabled,
              mutateOnRetry: currentMutateOnRetry,
              recycleSessionOnIncorrect: currentRecycleSessionOnIncorrect,
              proxyRotateUrl: currentProxyRotateUrl,
              manualCaptchaMode: currentManualCaptchaMode,
              autoOptimizePerBackend: currentAutoOptimizePerBackend,
              rotateBackendsList: ROTATION_MODE_BACKENDS[currentBackend]
                ? getRotateList(currentBackend, currentDisabledBackends)
                : undefined,
              injectStealthJS: currentInjectStealthJS,
              isExperimental: currentBackend === "darwin" || currentBackend === "experimental" || currentBackend === "experimental-elimination",
              experimentalModeType: currentBackend === "darwin" ? "darwin" : (currentBackend === "experimental-elimination" ? "experimental-elimination" : (currentBackend === "experimental" ? "experimental" : undefined)),
              experimentalConfigs: currentBackend === "darwin" ? getRotateList("rotate-backends", currentDisabledBackends).map(b => ({
                backend: b as any,
                proxyPool: currentProxyPool,
                fails: 0, blocks: 0, decisive: 0, eliminated: false,
                totalAttempts: 0, totalDurationMs: 0, errors: {}
              })) : undefined,

              // ── Universal Rotation Tracking & Elimination ──
              // Initialized for ALL rotation modes with per-mode aggressiveness
              ...(() => {
                const modeInfo = ROTATION_MODE_BACKENDS[currentBackend];
                const localRotateList = getRotateList(currentBackend, currentDisabledBackends);

                if (modeInfo && localRotateList.length > 0) {
                  return {
                    rotationTracking: localRotateList.map((b: string) => ({
                      backend: b,
                      proxyPool: currentProxyPool,
                      fails: 0, blocks: 0, decisive: 0, eliminated: false,
                      totalAttempts: 0, totalDurationMs: 0, errors: {},
                    })),
                    rotationEliminationThreshold: modeInfo.threshold,
                    rotationModeName: modeInfo.label,
                  };
                }
                return {};
              })(),
            };

            currentEngineConfig = config;

            if (currentBackend === "golden-benchmark") {
              if (!currentGoldenCredentials.joe && !currentGoldenCredentials.ignition) {
                broadcast({ type: "error", data: { message: "Golden Benchmark requires at least one golden credential (Joe or Ignition) to be set." } });
                return;
              }
              // Golden benchmark uses ONLY headed variants — the tiled visual
              // verification is the entire point. Headless backends launch off-screen.
              const testBackends = [
                "stealth-headed",
                "cloak-headed",
                "cloak-headed-nocloak",
                "zendriver-headed"
              ].filter(b => !currentDisabledBackends.includes(b));

              engine.runGoldenBenchmarkSuite(currentGoldenCredentials, { ...config, captureFlowSteps: true }, testBackends).catch((err: any) => {
                broadcast({
                  type: "error",
                  data: { message: `Benchmark suite crashed: ${err instanceof Error ? err.message : String(err)}` },
                });
              });
              return;
            }

            // Pin the manual override so the engine respects the dashboard value
            // immediately (before warmup/throttle logic kicks in).
            engine.setConcurrency(currentConcurrency);

            if (currentBackend === "rotate-backends" || currentBackend === "rotate-backends-headless" || currentBackend === "stealth-fortress" || currentBackend === "speed-blitz" || currentBackend === "headed-recon" || currentBackend === "darwin") {
              // Rotation/experimental modes don't lock to a single strategy, they cycle per credential
            }
            // Note: msg.data.tilingLayout is deprecated for the "start" message since we use currentTilingLayout directly
            let customGrid: { cols: number, rows: number } | undefined = undefined;
            if (currentTilingLayout !== "auto") {
              const parts = currentTilingLayout.split('x');
              if (parts.length === 2) {
                const r = parseInt(parts[0] || "", 10);
                const c = parseInt(parts[1] || "", 10);
                if (!isNaN(r) && !isNaN(c)) {
                  customGrid = { cols: c, rows: r };
                  // We do NOT override currentConcurrency here.
                  // The engine should be able to run e.g. 6 jobs simultaneously,
                  // while the headed tiler is bottlenecked to the grid size (e.g. 3).
                }
              }
            }
            globalTiler.reconfigure(currentConcurrency, customGrid);
            engine.setInputMode(currentInputMode);

            if (currentBackend === "split-local-stealth") {
              broadcast({ type: "log", data: { level: "INFO", message: `🔀 Split-local: Interleaving credentials between Spider Local and Cloak Headless` } });
            }

            if (currentBackend === "darwin") {
              const backendCount = config.experimentalConfigs?.length || 0;
              broadcast({ type: "log", data: { level: "INFO", message: `🦎 DARWIN MODE: Natural selection starting with ${backendCount} backends. Weak backends will be auto-eliminated.` } });
              broadcast({ type: "log", data: { level: "INFO", message: `🦎 Backends: ${(config.experimentalConfigs || []).map(c => c.backend).join(', ')}` } });
              broadcast({ type: "log", data: { level: "INFO", message: `🦎 Elimination threshold: 3 failures or 3 blocks per backend. If all eliminated → Hermes hard review + auto-fix.` } });
            }

            currentRunCredentials = credentials;
            initXlsxWriter(CSV_PATH);

            // Run in background (don't await)
            engine.start(credentials, config).catch((err) => {
              broadcast({
                type: "error",
                data: { message: `Engine crashed: ${err instanceof Error ? err.message : String(err)}` },
              });
            });
            break;
          }

          case "stop": {
            engine.stop();
            break;
          }

          case "hermes-review": {
            runHermesReview();
            break;
          }

          case "hermes-restart": {
            log.info("[Hermes] Dashboard requested restart");
            if (hermesProcess && !hermesProcess.killed) {
              hermesProcess.kill("SIGTERM");
              // Auto-restart will happen via the exit handler
            } else {
              startExtraServers();
            }
            broadcast({ type: "log", data: { level: "INFO", message: "[hermes] Restarting daemon..." } });
            break;
          }

          case "hermes-set-auto-review": {
            if (msg.data && msg.data.enabled !== undefined) {
              hermesStatus.autoReviewEnabled = !!msg.data.enabled;
              broadcast({ type: "log", data: { level: "INFO", message: `[hermes] Auto-review ${hermesStatus.autoReviewEnabled ? 'ENABLED' : 'DISABLED'}` } });
              broadcastHermesStatus();
            }
            break;
          }

          case "hermes-set-interval": {
            if (msg.data && msg.data.minutes) {
              const mins = Math.max(5, Math.min(120, parseInt(msg.data.minutes, 10) || 30));
              hermesStatus.autoReviewIntervalMin = mins;
              broadcast({ type: "log", data: { level: "INFO", message: `[hermes] Review interval → ${mins}min` } });
              broadcastHermesStatus();
            }
            break;
          }

          case "hermes-get-status": {
            broadcastHermesStatus();
            break;
          }

          case "launch-dashboard": {
            const proto = useTls ? "https" : "http";
            launchChromeDashboard(`${proto}://127.0.0.1:${PORT}`);
            break;
          }

          case "start-observer": {
            const proto = useTls ? "https" : "http";
            void startCdpObserver(`${proto}://127.0.0.1:${PORT}`);
            broadcast({ type: "log", data: { level: "INFO", message: "[CDP Observer] Manually started from dashboard" } });
            break;
          }
          case "live-test": {
            if (engine.isRunning) {
              ws.send(JSON.stringify({ type: "error", data: { message: "Already running — stop first before launching a live test" } }));
              return;
            }
            ws.send(JSON.stringify({ type: "error", data: { message: "Live-test mode is deprecated. Use Golden Benchmark instead." } }));
            break;
          }

          case "set-proxy-pool":
            if (msg.data && msg.data.value) {
              currentProxyPool = msg.data.value;
              if (currentEngineConfig) currentEngineConfig.proxyPool = currentProxyPool;
              broadcast({ type: 'config', data: { config: { concurrency: currentConcurrency, mode: currentInputMode, maxRetries: currentMaxRetries, backend: currentBackend, fpStrategy: currentFpStrategy, proxyPool: currentProxyPool, enableTracing: currentEnablePlaywrightTracing } } });
            }
            break;

          case "set-disabled-backends":
            if (msg.data && Array.isArray(msg.data.value)) {
              currentDisabledBackends = msg.data.value;
              saveDisabledBackends(currentDisabledBackends);
              log.info(`Disabled backends updated: [${currentDisabledBackends.join(", ")}]`);
              // If engine is running in golden benchmark mode, rebuild the configs
              if (currentEngineConfig && currentBackend === "golden-benchmark") {
                const testBackends = [
                  // Golden benchmark uses ONLY headed variants for tiled visual verification
                  "stealth-headed",
                  "cloak-headed",
                  "cloak-headed-nocloak",
                  "zendriver-headed",
                ].filter(b => !currentDisabledBackends.includes(b));
                // Preserve existing stats for backends that are still active
                const oldConfigs = currentEngineConfig.experimentalConfigs || [];
                currentEngineConfig.experimentalConfigs = testBackends.map(b => {
                  const existing = oldConfigs.find((c: any) => c.backend === b);
                  return existing || {
                    backend: b as any,
                    proxyPool: currentProxyPool,
                    fails: 0, blocks: 0, decisive: 0, eliminated: false, totalAttempts: 0, totalDurationMs: 0, errors: {}
                  };
                });
                broadcast({ type: "log", data: { level: "INFO", message: `🔧 Backend toggles updated: ${testBackends.length} active backends (${currentDisabledBackends.length} disabled)` } });
              }
              broadcast({ type: "config-sync", data: { config: { disabledBackends: currentDisabledBackends } } });
            }
            break;
          case "get-recommended-settings": {
            let recommendedBackend = "cloak-headless";
            let recommendedConcurrency = 12;

            if (lastExperimentalStats.length > 0) {
              const winner = lastExperimentalStats.reduce((prev, curr) => {
                const ratePrev = prev.totalAttempts > 0 ? prev.decisive / prev.totalAttempts : 0;
                const rateCurr = curr.totalAttempts > 0 ? curr.decisive / curr.totalAttempts : 0;
                return rateCurr > ratePrev ? curr : prev;
              });
              recommendedBackend = winner.backend;
            }

            if (recommendedBackend.includes("cloud") || recommendedBackend.includes("rest")) {
              recommendedConcurrency = 20;
            } else if (recommendedBackend.includes("headed")) {
              recommendedConcurrency = 3;
            } else {
              recommendedConcurrency = 12;
            }

            ws.send(JSON.stringify({
              type: "recommended-settings",
              data: {
                backend: recommendedBackend,
                concurrency: recommendedConcurrency
              }
            }));
            break;
          }

          case "set-concurrency": {
            const parsedData = SetConcurrencySchema.safeParse(msg.data);
            if (!parsedData.success) {
              ws.send(JSON.stringify({ type: "error", data: { message: "set-concurrency: value must be an integer between 1 and 500" } }));
              return;
            }
            const requested = parsedData.data.value;
            const applied = engine.setConcurrency(requested);
            currentConcurrency = applied;
            globalTiler.reconfigure(applied);
            broadcast({ type: "concurrency", data: { value: applied } });
            break;
          }

          case "set-timing": {
            const key = msg.data?.key;
            const value = Number(msg.data?.value);
            if (key && typeof key === 'string' && Number.isFinite(value)) {
              import('../core/timings.js').then(({ DynamicTimings, Timings }) => {
                if (Object.prototype.hasOwnProperty.call(Timings, key)) {
                  // @ts-expect-error
                  const baseline = Timings[key];
                  const boundedValue = Math.max(baseline * 0.1, Math.min(baseline * 10, value));
                  // @ts-expect-error
                  DynamicTimings[key] = boundedValue;
                  broadcast({ type: "log", data: { level: "INFO", message: `⏱ MTO Adjusted: ${key} = ${boundedValue}ms (requested ${value}ms)` } });
                }
              }).catch(() => { });
            }
            break;
          }

          case "reset-concurrency": {
            engine.resetConcurrencyToAuto();
            currentConcurrency = engine.currentConcurrency;
            broadcast({ type: "concurrency-reset", data: { message: "Auto-throttler resumed" } });
            broadcast({ type: "concurrency", data: { value: currentConcurrency } });
            break;
          }

          case "set-input-mode": {
            // Single combined toggle. Accepts the two canonical values; legacy
            // "autofill"/"keyboard" payloads from older dashboards are translated
            // so existing browser sessions don't break mid-run after a server
            // upgrade.
            const raw = String(msg.data?.value || "").toLowerCase();
            const translated = raw === "autofill" ? "instant" // legacy mapping
              : raw === "keyboard" ? "fast-human"
                : raw;
            if (translated !== "instant" && translated !== "fast-human" && translated !== "chrome-autofill") {
              ws.send(JSON.stringify({ type: "error", data: { message: "set-input-mode: value must be instant|fast-human|chrome-autofill" } }));
              return;
            }
            const applied = engine.setInputMode(translated);
            currentInputMode = applied;
            broadcast({ type: "input-mode", data: { value: applied } });
            break;
          }

          case "set-backend": {
            const parsedData = SetBackendSchema.safeParse(msg.data);
            if (!parsedData.success) {
              ws.send(JSON.stringify({ type: "error", data: { message: "set-backend: value must be a string" } }));
              return;
            }
            const v = parsedData.data.value.toLowerCase();
            const normalized = v;
            if (normalized !== "cloak-headed" && normalized !== "cloak-headless" && normalized !== "cloak-headless-nocloak" && normalized !== "cloak-headed-nocloak" && normalized !== "split-local-stealth" && normalized !== "experimental" && normalized !== "experimental-elimination" && normalized !== "curl-api" && normalized !== "golden-benchmark" && normalized !== "stealth" && normalized !== "stealth-headed" && normalized !== "zendriver" && normalized !== "zendriver-headed" && normalized !== "rotate-backends" && normalized !== "rotate-backends-headless" && normalized !== "stealth-fortress" && normalized !== "speed-blitz" && normalized !== "headed-recon" && normalized !== "darwin") {
              ws.send(JSON.stringify({ type: "error", data: { message: "set-backend: invalid backend value" } }));
              return;
            }
            currentBackend = normalized;
            if (currentEngineConfig) {
              if (currentBackend === "experimental" || currentBackend === "experimental-elimination") {
                currentEngineConfig.isExperimental = true;
                currentEngineConfig.experimentalModeType = currentBackend;
                const testBackends = [
                  "zendriver",
                  "zendriver-headed",
                  "cloak-headless",
                  "cloak-headed",
                  "cloak-headless-nocloak",
                  "cloak-headed-nocloak",
                  "stealth",
                  "stealth-headed",

                ].filter(b => !currentDisabledBackends.includes(b));
                currentEngineConfig.experimentalConfigs = testBackends.map(b => ({
                  backend: b as any,
                  proxyPool: currentProxyPool,
                  fails: 0, blocks: 0, decisive: 0, eliminated: false, totalAttempts: 0, totalDurationMs: 0, errors: {}
                }));
              } else if (currentBackend === "split-local-stealth") {
                currentEngineConfig.isExperimental = false;
                currentEngineConfig.splitBackends = ["stealth", "cloak-headless"];
                currentEngineConfig.backend = undefined;
              } else if (currentBackend === "rotate-backends" || currentBackend === "rotate-backends-headless" || currentBackend === "stealth-fortress" || currentBackend === "speed-blitz" || currentBackend === "headed-recon") {
                const modeInfo = ROTATION_MODE_BACKENDS[currentBackend];
                currentEngineConfig.isExperimental = false;
                currentEngineConfig.splitBackends = undefined;
                currentEngineConfig.backend = "rotate-backends";
                const rotateBackends = getRotateList(currentBackend, currentDisabledBackends);
                currentEngineConfig.rotateBackendsList = rotateBackends;
                log.info(`[${modeInfo?.label || currentBackend}] Backend rotation configured with: ${rotateBackends.join(", ")}`);
              } else if (currentBackend === "darwin") {
                // 🦎 Darwin Mode: All backends → auto-elimination → hard review
                currentEngineConfig.isExperimental = true;
                currentEngineConfig.experimentalModeType = "darwin";
                currentEngineConfig.splitBackends = undefined;
                currentEngineConfig.backend = undefined;
                const darwinBackends = [
                  "stealth",
                  "stealth-headed",
                  "cloak-headless",
                  "cloak-headed",
                  "cloak-headless-nocloak",
                  "cloak-headed-nocloak",
                  "zendriver",
                  "zendriver-headed"
                ].filter(b => !currentDisabledBackends.includes(b));

                currentEngineConfig.experimentalConfigs = darwinBackends.map(b => ({
                  backend: b as any,
                  proxyPool: currentProxyPool,
                  fails: 0, blocks: 0, decisive: 0, eliminated: false,
                  totalAttempts: 0, totalDurationMs: 0, errors: {}
                }));

                // Integrate Darwin with global rotation UI & auto-fixes
                currentEngineConfig.rotationModeName = "darwin";
                currentEngineConfig.rotationEliminationThreshold = 3; // Darwin uses 3
                currentEngineConfig.rotationTracking = darwinBackends.map(b => ({
                  backend: b as any,
                  proxyPool: currentProxyPool,
                  fails: 0,
                  blocks: 0,
                  decisive: 0,
                  eliminated: false,
                  totalAttempts: 0,
                  totalDurationMs: 0,
                  errors: {}
                }));
                log.info(`[Darwin] Natural selection initialized with ${darwinBackends.length} backends: ${darwinBackends.join(", ")}`);
              } else {
                currentEngineConfig.isExperimental = false;
                currentEngineConfig.splitBackends = undefined;
                currentEngineConfig.backend = currentBackend;
              }

              // ── Universal Rotation Tracking & Elimination (Mid-Run Initialization) ──
              const ROTATION_MODES: Record<string, { threshold: number; label: string }> = {
                "rotate-backends": { threshold: 5, label: "🔄 Rotate All" },
                "rotate-backends-headless": { threshold: 4, label: "🔄 Rotate Headless" },
                "stealth-fortress": { threshold: 5, label: "🛡️ Stealth Fortress" },
                "speed-blitz": { threshold: 3, label: "⚡ Speed Blitz" },
                "headed-recon": { threshold: 6, label: "🎭 Headed Recon" },
              };
              const modeInfo = ROTATION_MODES[currentBackend];
              if (modeInfo && currentEngineConfig.rotateBackendsList && currentEngineConfig.rotateBackendsList.length > 0) {
                currentEngineConfig.rotationTracking = currentEngineConfig.rotateBackendsList.map(b => ({
                  backend: b as any,
                  proxyPool: currentProxyPool,
                  fails: 0, blocks: 0, decisive: 0, eliminated: false,
                  totalAttempts: 0, totalDurationMs: 0, errors: {}
                }));
                currentEngineConfig.rotationEliminationThreshold = modeInfo.threshold;
                currentEngineConfig.rotationModeName = modeInfo.label;
              } else {
                currentEngineConfig.rotationTracking = undefined;
                currentEngineConfig.rotationEliminationThreshold = undefined;
                currentEngineConfig.rotationModeName = undefined;
              }
            }

            if (engine && engine.isRunning) {
              engine.hotSwapBackend(currentBackend);
            }

            // ── Auto-sync optimal settings to dashboard UI when backend changes ──
            // For single-backend modes: resolve and broadcast the optimal settings
            // For multi-backend modes (darwin/rotate): send the first backend's settings as preview
            const optimalPreviewBackend = (() => {
              const isMulti = ROTATION_MODE_BACKENDS[currentBackend] || currentBackend === "darwin" || currentBackend === "experimental" || currentBackend === "experimental-elimination";
              if (isMulti) {
                // For multi-backend modes, show settings of the first active backend as a reference
                const list = currentBackend === "darwin"
                  ? ["stealth", "cloak-headless", "zendriver"].filter(b => !currentDisabledBackends.includes(b))
                  : (currentEngineConfig?.rotateBackendsList || []);
                return list[0] || "cloak-headless";
              }
              return currentBackend;
            })();
            const optSettings = BACKEND_OPTIMAL_SETTINGS[optimalPreviewBackend] || {};

            // Update server-side state to match optimal (auto-apply)
            if (optSettings.fpStrategy) currentFpStrategy = optSettings.fpStrategy;
            if (optSettings.useHttpCloak !== undefined) currentUseHttpCloak = optSettings.useHttpCloak;
            if (optSettings.stealthBypassHttpCloak !== undefined) currentStealthBypass = optSettings.stealthBypassHttpCloak;
            if (optSettings.injectStealthJS !== undefined) currentInjectStealthJS = optSettings.injectStealthJS;
            if (optSettings.enableCacheInjection !== undefined) currentEnableCacheInjection = optSettings.enableCacheInjection;

            broadcast({
              type: "config-sync", data: {
                config: {
                  backend: currentBackend,
                  fpStrategy: currentFpStrategy,
                  useHttpCloak: currentUseHttpCloak,
                  stealthBypassHttpCloak: currentStealthBypass,
                  injectStealthJS: currentInjectStealthJS,
                  enableCacheInjection: currentEnableCacheInjection,
                  // Send the optimal config metadata so UI can show which backend this applies to
                  _optimalPreviewBackend: optimalPreviewBackend,
                  _isMultiBackend: optimalPreviewBackend !== currentBackend,
                }
              }
            });
            log.info(`[set-backend] ${currentBackend} → auto-applied optimal: fp=${currentFpStrategy} httpCloak=${currentUseHttpCloak} stealthJS=${currentInjectStealthJS} bypass=${currentStealthBypass}`);
          } break;
          case "set-rotate-on-fingerprint": {
            const v = msg.data?.value === true || msg.data?.value === "true";
            currentRotateOnFingerprint = v;
            if (currentEngineConfig) currentEngineConfig.rotateOnFingerprint = v;
            log.info(`[RotateOnFP] ${v ? "Enabled" : "Disabled"}`);
            broadcast({ type: "config-sync", data: { config: { rotateOnFingerprint: v } } });
          } break;

          case "set-burn-only-perm-disabled": {
            const v = msg.data?.value === true || msg.data?.value === "true";
            currentBurnOnlyOnPermDisabled = v;
            if (currentEngineConfig) currentEngineConfig.burnOnlyOnPermDisabled = v;
            log.info(`[BurnOnlyOnPermDisabled] ${v ? "Enabled" : "Disabled"}`);
            broadcast({ type: "config-sync", data: { config: { burnOnlyOnPermDisabled: v } } });
          } break;

          case "set-mutate-on-retry": {
            const v = msg.data?.value === true || msg.data?.value === "true";
            currentMutateOnRetry = v;
            if (currentEngineConfig) currentEngineConfig.mutateOnRetry = v;
            log.info(`[MutateOnRetry] ${v ? "Enabled" : "Disabled"}`);
            broadcast({ type: "config-sync", data: { config: { mutateOnRetry: v } } });
          } break;

          case "set-proxy-rotate-url": {
            const v = msg.data?.value || "";
            currentProxyRotateUrl = v;
            if (currentEngineConfig) currentEngineConfig.proxyRotateUrl = v;
            log.info(`[ProxyRotateUrl] Updated`);
            broadcast({ type: "config-sync", data: { config: { proxyRotateUrl: v } } });
          } break;

          case "set-manual-captcha-mode": {
            const v = msg.data?.value === true || msg.data?.value === "true";
            currentManualCaptchaMode = v;
            if (currentEngineConfig) currentEngineConfig.manualCaptchaMode = v;
            log.info(`[ManualCaptchaMode] ${v ? "Enabled" : "Disabled"}`);
            broadcast({ type: "config-sync", data: { config: { manualCaptchaMode: v } } });
          } break;

          case "set-auto-optimize-per-backend": {
            const v = msg.data?.value === true || msg.data?.value === "true";
            currentAutoOptimizePerBackend = v;
            if (currentEngineConfig) currentEngineConfig.autoOptimizePerBackend = v;
            log.info(`[AutoOptimizePerBackend] ${v ? "Enabled" : "Disabled"}`);
            broadcast({ type: "config-sync", data: { config: { autoOptimizePerBackend: v } } });
          } break;

          case "set-fp-strategy": {
            const v = String(msg.data?.value || "").toLowerCase();
            const VALID_FP_STRATEGIES = new Set(["fp-auto", "fp-camoufox", "fp-cloak", "fp-zendriver", "fp-fb-optimized", "none", "apify", "optimal", "native-only", "full-stealth"]);
            if (!VALID_FP_STRATEGIES.has(v)) {
              ws.send(JSON.stringify({ type: "error", data: { message: "set-fp-strategy: invalid strategy value" } }));
              return;
            }
            currentFpStrategy = v as typeof currentFpStrategy;
            broadcast({ type: "config", data: { config: { concurrency: currentConcurrency, mode: currentInputMode, maxRetries: 2, backend: currentBackend, fpStrategy: currentFpStrategy, proxyPool: currentProxyPool, enableTracing: currentEnablePlaywrightTracing } } });
          } break;

          case "set-emulate-mobile": {
            const v = msg.data?.value === true || msg.data?.value === "true";
            currentEmulateMobile = v;
            if (currentEngineConfig) currentEngineConfig.emulateMobile = v;
            log.info(`[Mobile Emulation] ${v ? "Enabled" : "Disabled"}`);
            broadcast({ type: "config-sync", data: { config: { advEmulateMobile: v } } });
          } break;

          case "set-cache-injection": {
            const v = msg.data?.value;
            if (typeof v !== "boolean") {
              ws.send(JSON.stringify({ type: "error", data: { message: "set-cache-injection: value must be a boolean" } }));
              return;
            }
            currentEnableCacheInjection = v;
            broadcast({ type: "cache-injection", data: { value: currentEnableCacheInjection } });
            break;
          }

          case "set-record-video": {
            const v = msg.data?.value;
            if (typeof v !== "boolean") {
              ws.send(JSON.stringify({ type: "error", data: { message: "set-record-video: value must be a boolean" } }));
              return;
            }
            currentRecordVideo = v;
            if (currentEngineConfig) currentEngineConfig.recordVideo = v;
            broadcast({ type: "record-video", data: { value: currentRecordVideo } });
            break;
          }

          case "set-enable-tracing": {
            const v = msg.data?.value;
            if (typeof v !== "boolean") {
              ws.send(JSON.stringify({ type: "error", data: { message: "set-enable-tracing: value must be a boolean" } }));
              return;
            }
            currentEnablePlaywrightTracing = v;
            if (currentEngineConfig) currentEngineConfig.enablePlaywrightTracing = v;
            broadcast({ type: "enable-tracing", data: { value: currentEnablePlaywrightTracing } });
            break;
          }

          case "set-tiling-layout": {
            const v = msg.data?.value;
            if (typeof v !== "string") {
              ws.send(JSON.stringify({ type: "error", data: { message: "set-tiling-layout: value must be a string" } }));
              return;
            }
            currentTilingLayout = v;
            ConfigStore.save({ tilingLayout: currentTilingLayout });
            broadcast({ type: "tiling-layout", data: { value: currentTilingLayout } });
            break;
          }

          case "set-post-load-delay": {
            const requested = Number(msg.data?.value);
            if (!Number.isFinite(requested) || requested < 0 || requested > 30000) {
              ws.send(JSON.stringify({ type: "error", data: { message: "set-post-load-delay: value must be a number between 0 and 30000 ms" } }));
              return;
            }
            // postLoadDelay sync removed
            break;
          }

          case "set-enable-verification": {
            const v = msg.data?.value;
            if (typeof v !== "boolean") {
              ws.send(JSON.stringify({ type: "error", data: { message: "set-enable-verification: value must be a boolean" } }));
              return;
            }
            currentEnableVerification = v;
            broadcast({ type: "enable-verification", data: { value: currentEnableVerification } });
            break;
          }

          case "set-ignition-verif-bypass": {
            const v = msg.data?.value;
            if (typeof v !== "boolean") {
              ws.send(JSON.stringify({ type: "error", data: { message: "set-ignition-verif-bypass: value must be a boolean" } }));
              return;
            }
            currentIgnitionVerifBypass = v;
            if (currentEngineConfig) currentEngineConfig.ignitionVerifBypass = v;
            broadcast({ type: "ignition-verif-bypass", data: { value: currentIgnitionVerifBypass } });
            break;
          }

          case "set-max-retries": {
            if (msg.data && typeof msg.data.value === "number") {
              currentMaxRetries = Math.max(0, msg.data.value);
              broadcast({ type: "max-retries", data: { value: currentMaxRetries } });
            }
            break;
          }

          case "set-golden-joe": {
            if (msg.data && typeof msg.data.value === "string") {
              currentGoldenCredentials.joe = msg.data.value;
            }
            break;
          }

          case "set-golden-ignition": {
            if (msg.data && typeof msg.data.value === "string") {
              currentGoldenCredentials.ignition = msg.data.value;
            }
            break;
          }

          case "set-spider-settings": {
            if (msg.data && typeof msg.data.value === "object") {
              currentSpiderSettings = msg.data.value;
              broadcast({ type: "spider-settings", data: { value: currentSpiderSettings } });
            }
            break;
          }

          case "update_ui_settings": {
            if (msg.setting && msg.value !== undefined) {
              if (msg.setting === "useHttpCloak") {
                currentUseHttpCloak = msg.value === "true";
                if (currentEngineConfig) currentEngineConfig.useHttpCloak = currentUseHttpCloak;
              } else if (msg.setting === "stealthBypassHttpCloak") {
                currentStealthBypass = msg.value === "true";
                if (currentEngineConfig) currentEngineConfig.stealthBypassHttpCloak = currentStealthBypass;
              } else if (msg.setting === "injectStealthJS") {
                currentInjectStealthJS = msg.value === "true";
                if (currentEngineConfig) currentEngineConfig.injectStealthJS = currentInjectStealthJS;
                broadcast({ type: "config-sync", data: { config: { injectStealthJS: currentInjectStealthJS } } });
              }
            }
            break;
          }

          case "refresh-csv": {
            cachedCredentials = engine.loadCredentials(CSV_PATH);
            const creds = cachedCredentials;
            ws.send(
              JSON.stringify({
                type: "credentials",
                data: { credentials: creds.map((c) => ({ email: c.email })) },
              })
            );
            break;
          }

          case "export-csv": {
            try {
              const { exportResultsAsCSV } = await import("../core/database.js");
              const csvData = exportResultsAsCSV();
              ws.send(JSON.stringify({ type: "export-csv-result", data: { csv: csvData } }));
            } catch (err: unknown) {
              ws.send(JSON.stringify({ type: "error", data: { message: `Export failed: ${err instanceof Error ? err.message : String(err)}` } }));
            }
            break;
          }

          case "define-result": {
            const VALID_OUTCOMES = new Set(["success", "2FA", "noaccount", "permdisabled", "tempdisabled", "honeypot", "N/A", "skipped", "queued", "testing"]);
            const { email, screenshotUrl, label, classification } = msg.data || {};
            if (!email || !classification) {
              ws.send(JSON.stringify({ type: "error", data: { message: "define-result requires email and classification" } }));
              break;
            }
            if (!VALID_OUTCOMES.has(classification)) {
              ws.send(JSON.stringify({ type: "error", data: { message: `Invalid classification: ${classification}` } }));
              break;
            }
            // eslint-disable-next-line no-control-regex
            const safeEmail = String(email).replace(/[\n\r\x1b]/g, "");
            log.info(`[UI] Human verdict: ${safeEmail} → ${classification} (${label || ""})`);
            broadcast({ type: "log", data: { level: "INFO", message: `🧑 Human verdict: ${safeEmail} → ${classification}` } });

            // Forward to Hermes for learning
            if (hermesProcess && hermesProcess.connected) {
              hermesProcess.send({
                type: "human-verdict",
                email,
                screenshotUrl: screenshotUrl || "",
                label: label || "",
                classification,
                timestamp: new Date().toISOString()
              });
            }

            // Persist to human-verdicts.jsonl
            try {
              const verdict = JSON.stringify({ email, label: label || "", classification, timestamp: new Date().toISOString() });
              fs.promises.appendFile(path.join(process.cwd(), "human-verdicts.jsonl"), verdict + "\n").catch(() => { });
            } catch (err: unknown) {
              log.warn(`[Server] Failed to persist verdict: ${err instanceof Error ? err.message : String(err)}`);
            }

            // Override the live engine state so the dashboard re-renders instantly and it's saved to progress.json
            if (engine) {
              engine.overrideResult(email, classification, label || "");
            }

            // Acknowledge back to client
            ws.send(JSON.stringify({ type: "define-result-ack", data: { email, classification } }));
            break;
          }

          case "hermes-command": {
            log.info(`[UI] Forwarding hermes-command to broadcast: ${JSON.stringify(msg.data)}`);
            broadcast(msg);
            break;
          }

          case "set-parking": {
            const enabled = msg.data?.enabled === true;
            // sessionParkingEnabled removed (unused)
            log.info(`[UI] Session parking ${enabled ? "ENABLED" : "DISABLED"}`);
            broadcast({ type: "log", data: { level: "INFO", message: `🅿 Session parking ${enabled ? "enabled" : "disabled"}` } });
            break;
          }

          case "set-engine-paused": {
            const paused = msg.data?.paused === true;
            if (engine) {
              engine.setPaused(paused);
              broadcast({ type: "engine-paused-state", data: { paused } });
              broadcast({ type: "log", data: { level: "INFO", message: `Engine ${paused ? "PAUSED ⏸" : "RESUMED ▶"}` } });
            }
            break;
          }

          case "resolve-parked": {
            const { email: parkEmail, site: parkSite, originalOutcome, newOutcome, screenshotUrl: parkScreenshot } = msg.data || {};
            if (!parkEmail || !parkSite || !newOutcome) {
              ws.send(JSON.stringify({ type: "error", data: { message: "resolve-parked requires email, site, and newOutcome" } }));
              break;
            }
            log.info(`[UI] Parked resolved: ${parkEmail} [${parkSite}] ${originalOutcome} → ${newOutcome}`);
            broadcast({ type: "log", data: { level: "INFO", message: `🅿→ ${parkEmail} [${parkSite}]: ${originalOutcome} → ${newOutcome}` } });

            // Record the override in the database
            try {
              const { saveTestRun } = await import("../core/database.js");
              void saveTestRun(parkEmail, parkSite, newOutcome, `manual-override:${originalOutcome}`);
            } catch (err: unknown) {
              log.warn(`[Server] Failed to record parked override: ${err instanceof Error ? err.message : String(err)}`);
            }

            // Forward to Hermes as a human verdict
            if (hermesProcess && hermesProcess.connected) {
              hermesProcess.send({
                type: "human-verdict",
                email: parkEmail,
                screenshotUrl: parkScreenshot || "",
                label: `parked-override:${parkSite}`,
                classification: newOutcome,
                timestamp: new Date().toISOString()
              });
            }

            // Persist to human-verdicts.jsonl
            try {
              const verdict = JSON.stringify({
                email: parkEmail,
                site: parkSite,
                label: `parked:${originalOutcome}→${newOutcome}`,
                classification: newOutcome,
                timestamp: new Date().toISOString()
              });
              fs.promises.appendFile(path.join(process.cwd(), "human-verdicts.jsonl"), verdict + "\n").catch(() => { });
            } catch (err: unknown) {
              log.warn(`[Server] Failed to persist parked verdict: ${err instanceof Error ? err.message : String(err)}`);
            }

            // Update the row in memory and broadcast to all clients
            const parkRowIdx = restoredRows.findIndex((r: any) => r.email === parkEmail);
            const parkRow = parkRowIdx !== -1 ? restoredRows[parkRowIdx] : null;
            if (parkRow && parkRow.sites && parkRow.sites[parkSite]) {
              parkRow.sites[parkSite].outcome = newOutcome;
              parkRow.sites[parkSite].error = `manual-override:${originalOutcome}`;
              broadcast({ type: "row-update", data: parkRow });
            }

            break;
          }
          case "clear-progress": {
            const progressPath = path.resolve("progress.json");
            if (fs.existsSync(progressPath)) {
              fs.unlinkSync(progressPath);
            }
            try {
              const { db } = await import("../core/database.js");
              db.exec("DELETE FROM test_runs");
              db.exec("UPDATE credentials SET next_batch_index = 0");
              db.exec("UPDATE credential_status SET batch_index = 0");
              broadcast({ type: "log", data: { level: "INFO", message: "🧹 Progress file and database history cleared — next run will start fresh." } });
              // Force UI reload
              restoredRows = [];
              broadcast({ type: "init", data: { credentials: [], config: currentEngineConfig } });
            } catch (err: unknown) {
              ws.send(JSON.stringify({ type: "error", data: { message: `Failed to clear db: ${err instanceof Error ? err.message : String(err)}` } }));
            }
            break;
          }

          case "purge-failed": {
            if (engine.isRunning) {
              ws.send(JSON.stringify({ type: "error", data: { message: "Stop the run before purging credentials" } }));
              return;
            }
            try {
              const { db } = await import("../core/database.js");
              const stmt = db.prepare(`
                SELECT c.email
                FROM credentials c
                WHERE EXISTS (SELECT 1 FROM test_runs tr WHERE tr.credential_id = c.id)
                AND NOT EXISTS (
                  SELECT 1 FROM test_runs tr
                  WHERE tr.credential_id = c.id
                  AND tr.outcome IN ('success', '2FA', 'tempdisabled', 'queued', 'testing')
                )
              `);
              const failedEmails = (stmt.all() as any[]).map(r => r.email);

              if (failedEmails.length === 0) {
                ws.send(JSON.stringify({ type: "log", data: { level: "INFO", message: "No failed credentials found to purge." } }));
                return;
              }

              const dropSet = new Set<string>(failedEmails);

              // 1. Delete from CSV
              await filterCredentialsCsv(CSV_PATH, dropSet);

              // 2. Delete from engine in-memory
              try { engine.removeRows(Array.from(dropSet)); } catch (e: unknown) {
                log.warn(`Failed to remove rows from engine memory during purge: ${(e instanceof Error ? e.message : String(e)) ?? String(e)}`);
              }

              // 3. Delete from DB
              const deleteTr = db.prepare("DELETE FROM test_runs WHERE credential_id IN (SELECT id FROM credentials WHERE email = ?)");
              const deleteC = db.prepare("DELETE FROM credentials WHERE email = ?");
              const tx = db.transaction((emails: string[]) => {
                for (const e of emails) {
                  deleteTr.run(e);
                  deleteC.run(e);
                }
              });
              tx(failedEmails);

              cachedCredentials = engine.loadCredentials(CSV_PATH);
              const targetNames = currentEngineConfig?.targets.map((t) => t.name) || [];
              restoredRows = (await import("../core/database.js")).getAllCredentialsWithLatestStatus(targetNames);

              broadcast({ type: "log", data: { level: "INFO", message: `🗑 Purged ${failedEmails.length} failed credentials.` } });

              const liveRows = restoredRows;
              const credList = restoredRows.map((r) => ({ email: r.email }));
              broadcast({
                type: "init",
                data: {
                  credentials: credList,
                  rows: liveRows,
                  config: currentEngineConfig
                }
              });
            } catch (err: unknown) {
              ws.send(JSON.stringify({ type: "error", data: { message: `Failed to purge: ${err instanceof Error ? err.message : String(err)}` } }));
            }
            break;
          }

          case "delete-rows": {
            if (engine.isRunning) {
              ws.send(JSON.stringify({ type: "error", data: { message: "Stop the run before deleting rows" } }));
              return;
            }
            const raw = Array.isArray(msg.data?.emails) ? msg.data.emails : [];
            const dropSet = new Set<string>(
              raw.map((e: any) => String(e || "").toLowerCase().trim()).filter((e: string) => e.length > 0)
            );
            if (dropSet.size === 0) {
              ws.send(JSON.stringify({ type: "error", data: { message: "delete-rows: no emails supplied" } }));
              return;
            }
            const siteScope = msg.data?.siteScope || 'both'; // 'joe', 'ignition', or 'both'
            let csvRemoved = 0;
            let engineRemoved = 0;

            try {
              if (siteScope === 'both') {
                csvRemoved = await filterCredentialsCsv(CSV_PATH, dropSet);
                const stmt = getStmt(`DELETE FROM credentials WHERE email IN (${Array.from(dropSet).map(() => '?').join(',')})`);
                if (dropSet.size > 0) stmt.run(...Array.from(dropSet));
                engineRemoved = engine.isRunning ? engine.removeRows(Array.from(dropSet)) : dropSet.size;
              } else {
                // Scope delete to a specific target
                const dropArray = Array.from(dropSet);
                const fetchStmt = getStmt(`SELECT email, target_sites FROM credentials WHERE email IN (${dropArray.map(() => '?').join(',')})`);
                const updateStmt = getStmt(`UPDATE credentials SET target_sites = ? WHERE email = ?`);
                const deleteStmt = getStmt(`DELETE FROM credentials WHERE email = ?`);

                const rows = fetchStmt.all(...dropArray) as any[];
                let fullyDeletedCount = 0;
                let partiallyDeletedCount = 0;
                const fullyDeletedEmails = new Set<string>();

                db.transaction(() => {
                  for (const r of rows) {
                    let ts = ["joe", "ignition"];
                    try { ts = JSON.parse(r.target_sites || '["joe","ignition"]'); } catch { /* intentional */ }
                    ts = ts.filter(t => t !== siteScope);
                    if (ts.length === 0) {
                      deleteStmt.run(r.email);
                      fullyDeletedCount++;
                      fullyDeletedEmails.add(r.email);
                    } else {
                      updateStmt.run(JSON.stringify(ts), r.email);
                      partiallyDeletedCount++;
                    }
                  }
                })();

                if (fullyDeletedEmails.size > 0) {
                  csvRemoved = await filterCredentialsCsv(CSV_PATH, fullyDeletedEmails);
                  engineRemoved = engine.isRunning ? engine.removeRows(Array.from(fullyDeletedEmails)) : fullyDeletedEmails.size;
                }
                csvRemoved = fullyDeletedCount + partiallyDeletedCount;
                engineRemoved = csvRemoved;
              }
            } catch (e: unknown) {
              log.warn(`delete-rows: database operation failed: ${(e instanceof Error ? e.message : String(e)) ?? String(e)}`);
            }

            const targetNames = currentEngineConfig?.targets.map((t) => t.name) || ["joe", "ignition"];
            cachedCredentials = getUntestedCredentials(targetNames);

            // Refetch full payload to update all stats immediately
            restoredRows = getAllCredentialsWithLatestStatus(targetNames);

            broadcast({
              type: "rows-deleted",
              data: {
                emails: Array.from(dropSet),
                credentials: cachedCredentials.map((c) => ({ email: c.email })),
                counts: { csv: csvRemoved, engine: engineRemoved },
              },
            });
            broadcast({
              type: "notification",
              data: {
                message: `Deleted ${dropSet.size} emails (CSV: ${csvRemoved}, Engine: ${engineRemoved})`
              },
            });
            break;
          }

          case "cleanup-screenshots": {
            broadcast({ type: "log", data: { level: "INFO", message: "🧹 Manual screenshot cleanup started..." } });
            const { deleted } = await engine.screenshotSvc.prune();
            broadcast({ type: "log", data: { level: "INFO", message: `🧹 Cleanup complete: deleted ${deleted} old screenshots.` } });
            break;
          }

          case "sync": {
            // Re-send the full init payload so the dashboard can re-hydrate
            const syncRows = engine.isRunning ? engine.rowStatuses : restoredRows;
            const syncCreds = engine.isRunning
              ? cachedCredentials.map((c) => ({ email: c.email }))
              : restoredRows.map((r) => ({ email: r.email }));
            const proxyPools = (() => { try { return JSON.parse(fs.readFileSync(path.join(process.cwd(), "proxy-config.json"), "utf8")).pools; } catch { return []; } })();
            ws.send(JSON.stringify({
              type: "init",
              data: {
                credentials: syncCreds,
                config: {
                  concurrency: currentConcurrency,
                  proxyPool: currentProxyPool,
                  fpStrategy: currentFpStrategy,
                  emulateMobile: currentEmulateMobile,
                  inputMode: currentInputMode,
                  backend: currentBackend,
                  enableCacheInjection: currentEnableCacheInjection,
                  recordVideo: currentRecordVideo,
                  enablePlaywrightTracing: currentEnablePlaywrightTracing,
                  hasSpiderKey: false,
                  hasSpiderLocalKey: false,
                  maxRetries: currentMaxRetries,
                  targets: DEFAULT_TARGETS.map((t) => t.name),
                  screenshotCarouselMax: Timings.SCREENSHOT_CAROUSEL_MAX,
                  csrfToken: CSRF_TOKEN,
                  enableVerification: currentEnableVerification,
                  hasVerificationKey: isVerificationAvailable(),
                  parallelSiteTesting: currentParallelSiteTesting,
                  disabledBackends: currentDisabledBackends,
                  ignitionVerifBypass: currentIgnitionVerifBypass,
                  useHttpCloak: currentUseHttpCloak,
                  stealthBypassHttpCloak: currentStealthBypass,
                  injectStealthJS: currentInjectStealthJS,
                  rotateOnFingerprint: currentRotateOnFingerprint,
                  burnOnlyOnPermDisabled: currentBurnOnlyOnPermDisabled,
                  mutateOnRetry: currentMutateOnRetry,
                  proxyRotateUrl: currentProxyRotateUrl,
                  manualCaptchaMode: currentManualCaptchaMode,
                  autoOptimizePerBackend: currentAutoOptimizePerBackend,
                  proxyPools,
                },
                isRunning: engine.isRunning,
                enginePaused: engine.isPaused,
                rows: syncRows,
                proxyHealth: proxyScoreTracker.getDetailedScores(),
                hermes: { ...hermesStatus, alive: !!(hermesProcess && !hermesProcess.killed && hermesProcess.connected) },
              },
            }));
            break;
          }

          case "upload-csv": {
            // Accept CSV content sent over WS (alternative to REST multipart upload)
            const csvName: string = msg.data?.name || `ws_upload_${Date.now()}.csv`;
            const csvContent: string = msg.data?.content || "";
            const targets: string[] = Array.isArray(msg.data?.targets) ? msg.data.targets : ["joe", "ignition"];
            if (!csvContent) {
              ws.send(JSON.stringify({ type: "error", data: { message: "upload-csv: no content provided" } }));
              break;
            }
            // Cap WS upload size to the same Timings.MAX_CSV_BYTES the REST path
            // already enforces. Without this, a single WS frame can write an
            // unbounded file to disk (per-message limit at line ~441 only
            // bounds individual JSON frames, but `content` is the parsed
            // string from within a frame).
            const csvBytes = Buffer.byteLength(csvContent, "utf-8");
            if (csvBytes > Timings.MAX_CSV_BYTES) {
              ws.send(JSON.stringify({
                type: "error",
                data: { message: `upload-csv: content ${csvBytes} bytes exceeds ${Timings.MAX_CSV_BYTES} byte cap` },
              }));
              break;
            }
            const credsDir = path.join(process.cwd(), "credentials");
            if (!fs.existsSync(credsDir)) fs.mkdirSync(credsDir, { recursive: true });
            const safeName = path.basename(csvName).replace(/[^a-zA-Z0-9._-]/g, "_");
            const newCsvPath = path.join(credsDir, `ws_${Date.now()}_${safeName}`);
            await fs.promises.writeFile(newCsvPath, csvContent, "utf-8");
            try {
              await importCsv(newCsvPath, targets);
            } catch (e: unknown) {
              ws.send(JSON.stringify({
                type: "error",
                data: { message: `upload-csv: import failed — ${(e instanceof Error ? e.message : String(e)) ?? String(e)}` },
              }));
              break;
            }
            const targetNames = DEFAULT_TARGETS.filter(t => t.selectors?.username).map(t => t.name);
            cachedCredentials = getUntestedCredentials(targetNames);
            broadcast({ type: "log", data: { level: "INFO", message: `📂 CSV uploaded via WS: ${safeName} — ${cachedCredentials.length} credentials loaded` } });
            // Re-send init so dashboard table refreshes
            ws.send(JSON.stringify({
              type: "init",
              data: {
                credentials: cachedCredentials.map((c) => ({ email: c.email })),
                config: {
                  concurrency: currentConcurrency,
                  inputMode: currentInputMode,
                  backend: currentBackend,
                  enableCacheInjection: currentEnableCacheInjection,
                  recordVideo: currentRecordVideo,
                  enablePlaywrightTracing: currentEnablePlaywrightTracing,
                  // postLoadDelay deprecated
                  maxRetries: 2,
                  targets: DEFAULT_TARGETS.map((t) => t.name),
                  csrfToken: CSRF_TOKEN,
                  enableVerification: currentEnableVerification,
                  fpStrategy: currentFpStrategy,
                },
                isRunning: engine.isRunning,
                rows: restoredRows,
                hermes: { ...hermesStatus, alive: !!(hermesProcess && !hermesProcess.killed && hermesProcess.connected) },
              },
            }));
            break;
          }

          case "clean-old": {
            broadcast({ type: "log", data: { level: "INFO", message: "🧹 Purging old logs and temporary records..." } });
            // Clean up screenshots
            const { deleted } = await engine.screenshotSvc.prune();
            broadcast({ type: "log", data: { level: "INFO", message: `🧹 Screenshot cleanup complete: deleted ${deleted} old screenshots.` } });

            // Clear app.log
            try {
              if (fs.existsSync("app.log")) {
                fs.truncateSync("app.log", 0);
                broadcast({ type: "log", data: { level: "INFO", message: "🧹 Cleared app.log." } });
              }
            } catch (e: unknown) {
              broadcast({ type: "log", data: { level: "WARN", message: `⚠️ Failed to clear app.log: ${e instanceof Error ? e.message : String(e)}` } });
            }

            broadcast({ type: "log", data: { level: "INFO", message: "🧹 Purge complete." } });
            break;
          }

          case "retest": {
            const email = msg.data?.email || msg.email;
            if (!email) break;
            const rowIdx = (engine as any).rows.findIndex((r: any) => r.email.toLowerCase() === email.toLowerCase());
            if (rowIdx !== -1) {
              const row = (engine as any).rows[rowIdx];
              if (!row) break;
              // Reset site outcomes to "queued" — currentBatch is preserved
              // so the next batch of 3 passwords will be tried automatically
              for (const [, s] of Object.entries(row.sites) as any) {
                if (s.outcome !== "success") {
                  s.outcome = "queued";
                  s.error = undefined;
                }
              }
              row.status = "queued";
              // Clear any tempDisabledUntil so engine doesn't skip
              delete row.tempDisabledUntil;
              // Move to front of queue by removing and re-inserting at index 0
              (engine as any).rows.splice(rowIdx, 1);
              (engine as any).rows.unshift(row);
              broadcast({ type: "row-update", data: row });
              broadcast({ type: "log", data: { level: "INFO", message: `🔄 ${email} requeued — batch ${row.currentBatch} (passwords ${row.currentBatch * 3 + 1}–${row.currentBatch * 3 + 3}) next` } });
            }
            break;
          }


          case "force-wake": {
            const email = msg.data?.email || msg.email;
            if (!email) break;

            const rowIdx = (engine as any).rows.findIndex((r: any) => r.email.toLowerCase() === email.toLowerCase());
            if (rowIdx !== -1) {
              const row = (engine as any).rows[rowIdx];
              if (!row) break;
              // Guard: don't move a row that's currently being tested
              if (row.status === "testing" || row.status === "in-progress") {
                broadcast({ type: "log", data: { level: "WARN", message: `⏰ ${email} is currently being tested — cannot force-wake` } });
                break;
              }
              // Reset to queued state
              row.status = "queued";
              for (const [, s] of Object.entries(row.sites) as any) {
                if (s.outcome && s.outcome !== "success") {
                  s.outcome = "queued";
                  s.error = undefined;
                }
              }
              // Move to front of queue
              (engine as any).rows.splice(rowIdx, 1);
              (engine as any).rows.unshift(row);
              broadcast({ type: "row-update", data: row });
              broadcast({ type: "log", data: { level: "INFO", message: `⏰ ${email} force-woken — cooldown cleared, batch ${row.currentBatch} (passwords ${row.currentBatch * 3 + 1}–${row.currentBatch * 3 + 3}) queued at top` } });
            }
            break;
          }

          case "fp-audit-update": {
            // Passthrough: re-broadcast FP audit data from the audit loop to all UI clients
            broadcast({ type: "fp-audit-update", data: msg.data });
            break;
          }

          case "proxy-test": {
            const proxyUrl = msg.data?.url || msg.url;
            if (!proxyUrl) {
              ws.send(JSON.stringify({ type: "proxy-test-result", data: { success: false, error: "No proxy URL provided" } }));
              break;
            }
            try {
              const { SocksProxyAgent } = await import("socks-proxy-agent");
              const { HttpsProxyAgent } = await import("https-proxy-agent");
              const isSocks = String(proxyUrl).startsWith("socks");
              const agent = isSocks ? new SocksProxyAgent(proxyUrl) : new HttpsProxyAgent(proxyUrl);
              const fetchMod = await import("node-fetch");
              const res = await (fetchMod.default as any)("https://www.google.com", {
                agent,
                timeout: 5000,
              });
              const ok = res.status === 200;
              ws.send(JSON.stringify({ type: "proxy-test-result", data: { success: ok, status: res.status } }));
              broadcast({ type: "log", data: { level: ok ? "INFO" : "WARN", message: `🌐 Proxy test for ${proxyUrl.replace(/:\/\/.*@/, "://***@")}: ${ok ? "PASS (HTTP 200)" : `FAIL (HTTP ${res.status})`}` } });
            } catch (err: any) {
              ws.send(JSON.stringify({ type: "proxy-test-result", data: { success: false, error: err.message } }));
              broadcast({ type: "log", data: { level: "WARN", message: `🌐 Proxy test failed: ${err.message}` } });
            }
            break;
          }

          case "hermes-reset-memory": {
            try {
              const hermesDbPath = path.join(process.cwd(), "hermes", "hermes-learning.db");
              if (fs.existsSync(hermesDbPath)) {
                const Database = (await import("better-sqlite3")).default;
                const hdb = new Database(hermesDbPath);
                try {
                  hdb.exec("DELETE FROM decision_journal; DELETE FROM healing_actions;");
                } catch {
                  // Tables might not exist yet
                }
                hdb.close();
              }
              broadcast({ type: "log", data: { level: "INFO", message: "🤖 Hermes memory & journals reset successfully" } });
              broadcast({ type: "hermes-status", data: { toolCalls: 0, patchesApplied: 0, errors: 0, recentLogs: [] } });
            } catch (err: any) {
              log.warn("hermes-reset-memory error:", err?.message || err);
            }
            break;
          }

          default:
            ws.send(JSON.stringify({ type: "error", data: { message: `Unknown message type: ${msg.type}` } }));
        }
      } catch (e: unknown) {
        ws.send(JSON.stringify({ type: "error", data: { message: (e instanceof Error ? e.message : String(e)) } }));
      }
    })().catch((err: any) => {
      log.error("Unhandled WebSocket message error:", err?.message || err);
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "error", data: { message: err?.message || "WebSocket message failed" } }));
      }
    });
  });

  ws.on("close", () => {
    log.info("Client disconnected");
  });
});

// ─── Start Server ─────────────────────────────────────────────────────────────

httpServer.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    log.error(`Port ${PORT} is already in use`);
  } else if (err.code === 'EACCES') {
    log.error(`Permission denied to bind to port ${PORT}`);
  } else {
    log.error('Server error:', err);
  }
  process.exit(1);
});

process.env.VITEST ? null : httpServer.listen(PORT, "0.0.0.0", () => {
  const watchdog = new Watchdog({
    heartbeatIntervalMs: 30000,
    memoryWarnMB: 1500,
    memoryRestartMB: 2000,
    stallTimeoutMs: 300000,
    onRestart: (reason) => {
      log.warn(`[Watchdog] Restart triggered: ${reason}`);
      process.exit(1);
    },
    onWarn: (msg) => log.warn(`[Watchdog] ${msg}`),
    isEngineRunning: () => engine.isRunning,
    getLastOutcomeTimestamp: () => engine.lastOutcomeTime,
    getActiveSessions: () => engine.isRunning ? (engine as any).rows?.filter((s: any) => s.status === 'testing').length || 0 : 0,
    isHermesAlive: () => true
  });
  watchdog.start();

  if (process.env.SKIP_NPM_CHECK === "1") {
    log.info("Skipping npm-check (SKIP_NPM_CHECK=1)");
  } else {
    log.info("Running npm-check to verify dependencies...");
    exec("npx npm-check", (error, stdout, _stderr) => {
      if (stdout) {
        console.log("\n--- NPM CHECK RESULTS ---");
        console.log(stdout);
        console.log("-------------------------\n");
      }
      if (error) {
        log.warn(`npm-check finished with some outdated/missing packages or warnings. Run 'npx npm-check -u' to update interactively.`);
      }
    });
  }
  const protocol = useTls ? "https" : "http";
  const dashUrl = `${protocol}://127.0.0.1:${PORT}`;
  launchChromeDashboard(dashUrl);
  const w = 52;
  const pad = (s: string) => s + " ".repeat(Math.max(0, w - s.length));
  console.log("");
  console.log("╔" + "═".repeat(w) + "╗");
  console.log("║" + pad("  DUAL-TARGET VALIDATOR — GUI SERVER") + "║");
  console.log("╠" + "═".repeat(w) + "╣");
  console.log("║" + pad(`  Dashboard:  ${protocol}://127.0.0.1:${PORT}`) + "║");
  console.log("║" + pad(`  Spider Cloud:✗ Disabled`) + "║");
  console.log("║" + pad(`  Spider Local:✗ Disabled`) + "║");
  console.log("╚" + "═".repeat(w) + "╝");
  console.log("");

  // Start background screenshot pruning
  engine.screenshotSvc.startAutoPrune();
});

// ─── Graceful Shutdown ────────────────────────────────────────────────────────

async function finalZombieSweep(): Promise<void> {
  try {
    const r = await killOurOrphans({ timeoutMs: 4000, minEtimeSec: 0 });
    if (r.killed || r.survived) log.info(`zombie sweep: killed=${r.killed} survived=${r.survived}`);
  } catch (e: unknown) { log.error("zombie sweep error:", (e instanceof Error ? e.message : String(e)) || e); }
}

async function executeFullShutdown() {
  // Flush XLSX with final state so results survive the shutdown
  try {
    if (currentRunCredentials.length > 0) {
      await flushCredentialXlsx(currentRunCredentials, (engine as any).rows);
      log.info('XLSX flushed on shutdown');
    }
  } catch (e: unknown) { log.warn(`XLSX shutdown flush: ${e instanceof Error ? e.message : String(e)}`); }

  // Checkpoint WAL so the DB file is self-contained (safe to copy/backup)
  try {
    checkpointWAL();
  } catch (e: unknown) { log.warn(`Shutdown WAL checkpoint: ${e instanceof Error ? e.message : String(e)}`); }

  // Create a shutdown backup (VACUUM INTO for consistency — see Phase ① boot backup)
  try {
    const backupsDir = path.resolve(process.cwd(), 'backups');
    if (!fs.existsSync(backupsDir)) fs.mkdirSync(backupsDir, { recursive: true });
    const shutdownBackupPath = path.join(backupsDir, 'credentials-last-shutdown.db');
    if (fs.existsSync(shutdownBackupPath)) fs.unlinkSync(shutdownBackupPath);
    db.exec(`VACUUM INTO '${shutdownBackupPath.replace(/'/g, "''")}'`);
    log.info(`Shutdown backup: ${shutdownBackupPath}`);
  } catch (e: unknown) { log.warn(`Shutdown backup: ${e instanceof Error ? e.message : String(e)}`); }

  await finalZombieSweep();
  try {
    const { globalRLLedger } = await import('../intelligence/ai-rl-ledger.js');
    globalRLLedger.save();
    log.info('RLLedger saved on shutdown');
  } catch (e: unknown) { log.warn(`Shutdown RLLedger save: ${e instanceof Error ? e.message : String(e)}`); }

  // Disconnect Redis singleton before DB close (Redis may have pending
  // writes that reference the DB; drain it first). Without this, PM2
  // autorestart accumulates leaked TCP connections indefinitely.
  try {
    const { _resetRedisCoordinator } = await import('../services/redis-coordinator.js');
    _resetRedisCoordinator();
    log.info('Redis disconnected on shutdown');
  } catch (e: unknown) { log.warn(`Shutdown Redis disconnect: ${(e instanceof Error ? e.message : String(e)) ?? String(e)}`); }

  try {
    closeDB();
  } catch (e: unknown) {
    log.warn(`DB shutdown close: ${(e instanceof Error ? e.message : String(e)) ?? String(e)}`);
  }
}

function gracefulShutdown(signal: string): void {
  isShuttingDown = true;
  log.info(`\n${signal} received — shutting down gracefully...`);

  // Close all WebSocket connections cleanly
  wss.clients.forEach((client: any) => {
    if (client.readyState === WebSocket.OPEN) {
      client.close(1000, "Server shutting down");
    }
  });

  // Kill extra background servers
  if (hermesProcess && !hermesProcess.killed) {
    log.info("Killing Hermes daemon...");
    hermesProcess.kill("SIGTERM");
  }

  // Stop CDP observer
  stopCdpObserver();

  if (engine.isRunning) {
    engine.stop();
    // Give active sessions up to 10s to finish
    const timeout = setTimeout(async () => {
      log.info("Forced exit after 10s timeout");
      try {
        await executeFullShutdown();
      } catch (e: unknown) {
        log.error(`Forced shutdown error: ${(e instanceof Error ? e.message : String(e)) ?? String(e)}`);
      } finally {
        process.exit(1);
      }
    }, 10000);
    engine.once("complete", async () => {
      clearTimeout(timeout);
      engine.screenshotSvc.stopAutoPrune();
      engine.cleanup();
      log.info("Engine drained — exiting cleanly");
      try {
        await executeFullShutdown();
        process.exit(0);
      } catch (e: unknown) {
        log.error(`Shutdown error: ${(e instanceof Error ? e.message : String(e)) ?? String(e)}`);
        process.exit(1);
      }
    });
  } else {
    engine.cleanup();
    void executeFullShutdown()
      .then(() => process.exit(0))
      .catch((e: any) => {
        log.error(`Shutdown error: ${e?.message ?? String(e)}`);
        process.exit(1);
      });
  }
}

// Pre-flight: clear any orphans left over from a previous crashed run before
// we accept the first dashboard connection.
void cleanPreviousZombies({ label: "server" });
startPeriodicZombieReaper(120000, 300);

// Start extra background servers
let hermesProcess: ChildProcess | null = null;
/** Hermes status tracking for dashboard */
const hermesStatus = {
  alive: false,
  upSince: null as string | null,
  reviewCount: 0,
  lastReviewAt: null as string | null,
  lastReviewDurationMs: 0,
  patchesApplied: 0,
  toolCalls: 0,
  alerts: 0,
  errors: 0,
  autoReviewEnabled: true,
  autoReviewIntervalMin: 30,
  recentLogs: [] as Array<{ ts: string; level: string; msg: string }>,
};
const HERMES_LOG_BUFFER_MAX = 200;
function pushHermesLog(level: string, msg: string) {
  hermesStatus.recentLogs.push({ ts: new Date().toISOString(), level, msg });
  if (hermesStatus.recentLogs.length > HERMES_LOG_BUFFER_MAX) hermesStatus.recentLogs.shift();
}
function broadcastHermesStatus() {
  const activeSessions = engine.isRunning ? engine.rowStatuses.filter((s: any) => s.status === "testing").length : 0;
  broadcast({ type: "hermes-status", data: { ...hermesStatus, activeSessions, alive: !!(hermesProcess && !hermesProcess.killed && hermesProcess.connected) } });
}
function startExtraServers() {
  const hermesScript = path.join(process.cwd(), "src", "hermes", "hermes-review.ts");
  if (fs.existsSync(hermesScript)) {
    log.info(`[Server] Starting Hermes AI System: node --import tsx src/hermes/hermes-review.ts`);
    try {
      hermesProcess = spawn(process.execPath, ["--import", "tsx", "src/hermes/hermes-review.ts"], {
        cwd: process.cwd(),
        stdio: ["inherit", "pipe", "pipe", "ipc"],
        detached: false,
        shell: false,
        env: Object.assign({}, process.env, {
          GEMINI_API_KEY: process.env.GEMINI_API_KEY,
          GOOGLE_API_KEY: process.env.GOOGLE_API_KEY,
          // npx/tsx need npm and node resolver paths
          NVM_DIR: process.env.NVM_DIR,
          NVM_BIN: process.env.NVM_BIN,
          VOLTA_HOME: process.env.VOLTA_HOME,
          npm_config_prefix: process.env.npm_config_prefix,
          npm_config_cache: process.env.npm_config_cache,
          NODE_PATH: process.env.NODE_PATH,
          XDG_DATA_HOME: process.env.XDG_DATA_HOME,
        }),
      });

      if (hermesProcess.stdout) {
        hermesProcess.stdout.on("data", (d: any) => {
          const lines = d.toString().split("\n");
          for (const line of lines) {
            if (!line.trim() || line.includes("─")) continue;
            if (line.includes("Appended to TESTING-LOG.md")) continue;
            broadcast({ type: "log", data: { level: "INFO", message: `[hermes] ${line}` } });
            pushHermesLog("INFO", line.trim());
            // Track review completions
            if (line.includes("Analysis complete")) {
              hermesStatus.reviewCount++;
              hermesStatus.lastReviewAt = new Date().toISOString();
              broadcastHermesStatus();
            }
            if (line.includes("successfully patched")) {
              hermesStatus.patchesApplied++;
              broadcastHermesStatus();
            }
          }
        });
      }

      if (hermesProcess.stderr) {
        hermesProcess.stderr.on("data", (d: any) => {
          broadcast({ type: "log", data: { level: "WARN", message: `[hermes:err] ${d.toString().trim()}` } });
          pushHermesLog("ERR", d.toString().trim());
          hermesStatus.errors++;
          broadcastHermesStatus();
        });
      }

      hermesProcess.on("message", (msg: any) => {
        if (msg && msg.type === "action") {
          log.info(`[Hermes-Resolver] Received action: ${msg.action} for ${msg.backend || 'all'}`);
          broadcast({ type: "log", data: { level: "WARN", message: `[hermes:resolver] Executing auto-heal: ${msg.action} ${msg.backend ? 'on ' + msg.backend : ''}` } });
          pushHermesLog("WARN", `Action: ${msg.action} ${msg.backend ? 'on ' + msg.backend : ''}`);
          hermesStatus.toolCalls++;

          if (msg.action === "disable_backend" && msg.backend && currentEngineConfig) {
            currentEngineConfig.experimentalConfigs = (currentEngineConfig.experimentalConfigs || []).filter((c: any) => c.backend !== msg.backend);
            broadcast({ type: "config-updated", config: currentEngineConfig });
          }

          if (msg.action === "proxy_pruned") {
            try {
              const fs = require('fs');
              const pools = JSON.parse(fs.readFileSync(path.join(process.cwd(), "proxy-config.json"), "utf8")).pools;
              broadcast({ type: "config-sync", data: { config: { proxyPools: pools } } });
            } catch { /* intentional */ }
            broadcast({ type: "log", data: { level: "WARN", message: `[hermes:resolver] Proxy config pruned. Engine will pick up changes on next session.` } });
          }

          if (msg.action === "update_ui_settings" && msg.setting && msg.value && currentEngineConfig) {
            broadcast({ type: "log", data: { level: "WARN", message: `[hermes:resolver] God Mode updating UI setting: ${msg.setting} = ${msg.value}` } });
            if (msg.setting === "maxConcurrency") {
              const val = parseInt(msg.value, 10);
              if (Number.isFinite(val) && val >= 1 && val <= 100) {
                currentEngineConfig.concurrency = val;
                currentConcurrency = val;
              }
            } else if (msg.setting === "useHttpCloak") {
              currentEngineConfig.useHttpCloak = msg.value === "true";
            } else if (msg.setting === "stealthBypassHttpCloak") {
              currentEngineConfig.stealthBypassHttpCloak = msg.value === "true";
            } else if (msg.setting === "backend") {
              currentBackend = msg.value;
              currentEngineConfig.backend = msg.value;
            } else if (msg.setting === "proxyPool") {
              currentProxyPool = msg.value;
              currentEngineConfig.proxyPool = msg.value;
            }
            broadcast({ type: "config-updated", config: currentEngineConfig });
          }

          if (msg.action === "restart_server") {
            broadcast({ type: "log", data: { level: "WARN", message: `[hermes:god] Restarting server gracefully. Reason: ${msg.reason || "Self-healing"}` } });
            log.warn(`[Hermes] Triggered graceful restart. Draining engine...`);
            gracefulShutdown("HERMES_RESTART");
          }

          if (msg.action === "log") {
            broadcast({ type: "log", data: { level: "INFO", message: `[hermes:resolver] ${msg instanceof Error ? msg.message : String(msg)}` } });
          }

          if (msg.action === "launch-dashboard") {
            const protocol = useTls ? "https" : "http";
            launchChromeDashboard(`${protocol}://127.0.0.1:${PORT}`);
          }

          if (msg.action === "launch-observer") {
            const protocol = useTls ? "https" : "http";
            void startCdpObserver(`${protocol}://127.0.0.1:${PORT}`);
          }

          // ══════ HERMES ENGINE ORCHESTRATION IPC ══════

          if (msg.action === "start_engine") {
            if (engine.isRunning) {
              hermesProcess?.send?.({ type: "action-result", action: "start_engine", success: false, reason: "Engine already running" });
            } else {
              broadcast({ type: "log", data: { level: "WARN", message: `[hermes:orchestrator] Auto-starting engine...` } });
              // Build config from current settings (same as dashboard start)
              const resolvedTargets = DEFAULT_TARGETS;
              const config: EngineConfig = {
                concurrency: currentConcurrency,
                maxRetries: currentMaxRetries,
                targets: resolvedTargets,
                backend: currentBackend as any,
                spiderApiKey: "",
                spiderLocalApiKey: "",
                enableCacheInjection: currentEnableCacheInjection,
                recordVideo: currentRecordVideo,
                enablePlaywrightTracing: currentEnablePlaywrightTracing,
                cleanSession: true,
                // postLoadDelay deprecated
                enableVerification: currentEnableVerification,
                fpStrategy: currentFpStrategy,
                proxyPool: currentProxyPool,
                parallelSiteTesting: currentParallelSiteTesting,
                useHttpCloak: currentUseHttpCloak,
                stealthBypassHttpCloak: currentStealthBypass,
                ignitionVerifBypass: currentIgnitionVerifBypass,
                recycleSessionOnIncorrect: currentRecycleSessionOnIncorrect,
              };
              currentEngineConfig = config;
              engine.setConcurrency(currentConcurrency);
              engine.setInputMode(currentInputMode);
              const credentials = restoredRows.map((r: any) => ({ email: r.email, passwords: r.passwords || [] }));
              engine.start(credentials, config).catch((err: any) => {
                broadcast({ type: "error", data: { message: `Engine crashed: ${err instanceof Error ? err.message : String(err)}` } });
              });
              browserWarmer.start();
              hermesProcess?.send?.({ type: "action-result", action: "start_engine", success: true });
            }
          }

          if (msg.action === "stop_engine") {
            if (engine.isRunning) {
              engine.stop();
              browserWarmer.stop();
              broadcast({ type: "log", data: { level: "WARN", message: `[hermes:orchestrator] Engine stopped by Hermes` } });
              hermesProcess?.send?.({ type: "action-result", action: "stop_engine", success: true });
            } else {
              hermesProcess?.send?.({ type: "action-result", action: "stop_engine", success: false, reason: "Engine not running" });
            }
          }

          if (msg.action === "pause_engine") {
            if (engine.isRunning && !engine.isPaused) {
              engine.setPaused(true);
              broadcast({ type: "engine-paused-state", data: { paused: true } });
              broadcast({ type: "log", data: { level: "WARN", message: `[hermes:orchestrator] Engine PAUSED` } });
            }
          }

          if (msg.action === "resume_engine") {
            if (engine.isRunning && engine.isPaused) {
              engine.setPaused(false);
              broadcast({ type: "engine-paused-state", data: { paused: false } });
              broadcast({ type: "log", data: { level: "WARN", message: `[hermes:orchestrator] Engine RESUMED` } });
            }
          }

          if (msg.action === "get_engine_status") {
            const status = {
              isRunning: engine.isRunning,
              isPaused: engine.isPaused,
              concurrency: currentConcurrency,
              backend: currentBackend,
              proxyPool: currentProxyPool,
              credentialCount: restoredRows.length,
              activeSessions: engine.isRunning ? engine.rowStatuses.filter((s: any) => s.status === "testing").length : 0,
              completedSessions: engine.isRunning ? engine.rowStatuses.filter((s: any) => s.status === "done" || s.status === "failed").length : 0,
              memoryMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
            };
            hermesProcess?.send?.({ type: "engine-status", data: status });
          }

          if (msg.action === "cdp_execute") {
            const { email, command } = msg;
            if (!email || !command) {
              hermesProcess?.send?.({ type: "cdp_result", success: false, error: "Missing email or command" });
            } else {
              void engine.executeOnLiveSession(email, command).then((result: any) => {
                hermesProcess?.send?.({ type: "cdp_result", email, command: command.type, ...result });
              });
            }
          }

          if (msg.action === "get_active_sessions") {
            hermesProcess?.send?.({ type: "active_sessions_result", emails: engine.liveSessionEmails });
          }

          // Telemetry pass-through from engine to Hermes
          if (msg.action === "telemetry_transition") {
            hermesProcess?.send?.({ type: "telemetry_transition", data: msg.data });
          }
          if (msg.action === "telemetry_outcome") {
            hermesProcess?.send?.({ type: "telemetry_outcome", data: msg.data });
          }
          if (msg.action === "review_idle_anomaly") {
            hermesProcess?.send?.({ type: "review_idle_anomaly", data: msg.data });
          }

          if (msg.action === "set_proxy_pool" && msg.value) {
            currentProxyPool = msg.value;
            if (currentEngineConfig) currentEngineConfig.proxyPool = currentProxyPool;
            broadcast({ type: "log", data: { level: "WARN", message: `[hermes:orchestrator] Proxy pool → ${msg.value}` } });
            broadcast({ type: "config", data: { config: { proxyPool: currentProxyPool } } });
          }

          if (msg.action === "set_concurrency" && msg.value) {
            const val = parseInt(msg.value, 10);
            if (Number.isFinite(val) && val >= 1 && val <= 20) {
              currentConcurrency = val;
              engine.setConcurrency(val);
              broadcast({ type: "log", data: { level: "WARN", message: `[hermes:orchestrator] Concurrency → ${val}` } });
            }
          }

          if (msg.action === "set_backend" && msg.value) {
            currentBackend = msg.value;
            broadcast({ type: "log", data: { level: "WARN", message: `[hermes:orchestrator] Backend → ${msg.value}` } });
          }

          if (msg.action === "sweep_zombies") {
            try {
              const { execSync } = require("child_process");
              execSync("npx tsx src/services/clean-zombies.ts", { stdio: "ignore" });
              broadcast({ type: "log", data: { level: "WARN", message: `[hermes:janitor] Swept zombie browser processes` } });
            } catch { /* intentional */ }
          }

          if (msg.action === "hermes_alert") {
            // High-priority alert broadcast to dashboard
            broadcast({ type: "hermes-alert", data: { level: msg.level || "WARN", message: msg.message, timestamp: new Date().toISOString() } });
          }
        }
      });

      hermesProcess.on("error", (err: any) => log.error(`[Server] Failed to start Hermes: ${err instanceof Error ? err.message : String(err)}`));
      hermesProcess.on("exit", (code: number | null) => {
        log.warn(`[Server] Hermes exited with code ${code}`);
        hermesProcess = null;
        // ── Auto-restart Hermes after 5 seconds ──
        if (!isShuttingDown) {
          log.info("[Server] Hermes will auto-restart in 5 seconds...");
          setTimeout(() => {
            if (!isShuttingDown && !hermesProcess) {
              log.info("[Server] Auto-restarting Hermes daemon...");
              startExtraServers();
            }
          }, 5000);
        }
      });
    } catch (e: unknown) {
      log.error(`[Server] Hermes failed to start: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // ── Golden Watcher Daemon (DISABLED) ───────────────────────────────────────
  // User explicitly requested to disable the automatic golden joe review loop.
  /*
  const goldenWatcherScript = path.join(process.cwd(), "golden-watcher.ts");
  if (fs.existsSync(goldenWatcherScript) && !goldenWatcherProcess) {
    ...
  }
  */
}

function runHermesReview() {
  if (isShuttingDown) return;
  if (hermesProcess && hermesProcess.connected) {
    // Only send the event silently, don't spam the console since it's triggered constantly
    hermesProcess.send({ type: "review-now" });
  } else {
    broadcast({ type: "log", data: { level: "WARN", message: `[hermes] Daemon not connected.` } });
  }
}

// ─── 24/7 Periodic Maintenance Timers ─────────────────────────────────────────

// 1. Periodic Hermes review every 10 minutes
process.env.VITEST ? null : setInterval(() => {
  if (!isShuttingDown) runHermesReview();
}, 10 * 60_000).unref();

// 2. Zombie browser sweep every 10 minutes
process.env.VITEST ? null : setInterval(async () => {
  if (isShuttingDown) return;
  try {
    const { killOurOrphans } = await import("../services/process-cleaner.js");
    const r = await killOurOrphans({ minEtimeSec: 300 }); // Only processes >5min old
    if (r.killed > 0) {
      log.info(`[Maintenance] Zombie sweep: killed=${r.killed}`);
      broadcast({ type: "log", data: { level: "WARN", message: `[🧹 Maintenance] Swept ${r.killed} zombie browser process(es)` } });
    }
  } catch (e: unknown) {
    log.warn(`[Maintenance] Zombie sweep error: ${e instanceof Error ? e.message : String(e)}`);
  }
}, 10 * 60_000).unref();

// 3. Periodic Cloud Sync (Upload recordings, results, backups) every 30 minutes
process.env.VITEST ? null : setInterval(async () => {
  if (isShuttingDown || !gcsUploader) return;
  try {
    const recordingsDir = path.join(process.cwd(), "recordings");
    await gcsUploader.backfillFromDisk(recordingsDir, [".webm"]);
    await gcsUploader.uploadFileIfExists(path.resolve("results.csv"));
    await gcsUploader.uploadFileIfExists(path.join(process.cwd(), "backups", "credentials-pre-update.db"), "backups/");
    await gcsUploader.uploadFileIfExists(path.join(process.cwd(), "permdisabled", "permdisabled.csv"), "permdisabled/");
    log.info(`[Maintenance] Cloud sync complete (Recordings, Results, Backups)`);
  } catch (e: unknown) {
    log.warn(`[Maintenance] Cloud sync error: ${e instanceof Error ? e.message : String(e)}`);
  }
}, 30 * 60_000).unref();

// High-Frequency Engine Vitals Telemetry (every 3 seconds)
process.env.VITEST ? null : setInterval(() => {
  if (isShuttingDown) return;
  const mem = process.memoryUsage();
  let cpuUsage = 0;
  if (process.cpuUsage) {
    const cpu = process.cpuUsage();
    cpuUsage = Math.min(100, Math.round((cpu.user + cpu.system) / 100000));
  }
  broadcast({
    type: "engine-vitals",
    data: {
      cpu: cpuUsage,
      heapMB: Math.round(mem.heapUsed / 1024 / 1024),
      rssMB: Math.round(mem.rss / 1024 / 1024),
      uptime: process.uptime()
    }
  });
}, 3000).unref();

// 3. Memory watchdog every 5 minutes
process.env.VITEST ? null : setInterval(() => {
  if (isShuttingDown) return;
  const mem = process.memoryUsage();
  const heapMB = Math.round(mem.heapUsed / 1024 / 1024);
  const rssMB = Math.round(mem.rss / 1024 / 1024);
  if (heapMB > 1500) {
    log.warn(`[⚠️ Memory] Heap at ${heapMB}MB (RSS: ${rssMB}MB) — elevated. Consider restart if > 2GB.`);
    broadcast({ type: "log", data: { level: "WARN", message: `[⚠️ Memory] Heap: ${heapMB}MB | RSS: ${rssMB}MB — elevated` } });
    // Force GC if available
    if (global.gc) {
      global.gc();
      log.info(`[Memory] Forced garbage collection`);
    }
  } else {
    log.info(`[Memory] Heap: ${heapMB}MB | RSS: ${rssMB}MB`);
  }
}, 5 * 60_000);

// 4. WAL checkpoint every 30 minutes (prevents unbounded WAL growth)
process.env.VITEST ? null : setInterval(() => {
  if (isShuttingDown) return;
  try {
    db.pragma("wal_checkpoint(TRUNCATE)");
    log.info(`[Maintenance] WAL checkpoint completed`);
  } catch (e: unknown) {
    log.warn(`[Maintenance] WAL checkpoint error: ${e instanceof Error ? e.message : String(e)}`);
  }
}, 30 * 60_000).unref();

// 5. Auto-backup every 6 hours (rotate last 8 = 48h of backups)
process.env.VITEST ? null : setInterval(() => {
  if (isShuttingDown) return;
  try {
    const backupDir = path.resolve("backups");
    if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 16);
    const dest = path.join(backupDir, `credentials-auto-${ts}.db`);
    const srcDb = path.resolve("credentials.db");
    if (fs.existsSync(srcDb)) {
      fs.copyFileSync(srcDb, dest);
      log.info(`[Maintenance] Auto-backup: ${dest}`);
      // Rotate — keep only the 8 most recent auto-backups
      const autoBackups = fs.readdirSync(backupDir)
        .filter(f => f.startsWith("credentials-auto-") && f.endsWith(".db"))
        .sort()
        .reverse();
      for (const old of autoBackups.slice(8)) {
        try { fs.unlinkSync(path.join(backupDir, old)); } catch { /* intentional */ }
      }
    }
  } catch (e: unknown) {
    log.warn(`[Maintenance] Auto-backup error: ${e instanceof Error ? e.message : String(e)}`);
  }
}, 6 * 3600_000);

// 6. Hermes Observer stats broadcast (5s interval for dashboard)
process.env.VITEST ? null : setInterval(() => {
  if (isShuttingDown) return;
  try {
    const obs = getHermesObserver();
    const activeSessions = obs.getActiveSessionCount();
    // Only broadcast when there's activity to avoid WS noise
    if (activeSessions > 0 || obs.getTotalOutcomes() > 0) {
      broadcast({
        type: "observer-stats",
        data: {
          llmCalls: obs.getLlmCallCount(),
          insights: obs.getInsightCount(),
          screenshots: obs.getScreenshotCount(),
          anomalies: obs.getAnomalyCount(),
          avgLatency: obs.getAvgLlmLatency(),
          activeSessions,
          totalOutcomes: obs.getTotalOutcomes(),
          successRate: obs.getSuccessRate(),
        }
      });
    }
  } catch { /* non-blocking */ }
}, 5_000);

// ─── Chrome Dashboard Launcher + CDP Observer ─────────────────────────────────

const CDP_DEBUG_PORT = 9224;
let chromeProcess: ChildProcess | null = null;
let cdpObserverInterval: NodeJS.Timeout | null = null;
let cdpObserverWs: any = null;

/**
 * Finds the Chrome binary path for the current OS.
 * Falls back to common installation paths.
 */
function findChromeBinary(): string {
  const platform = os.platform();
  if (platform === "win32") {
    // Windows — check common install locations
    const candidates = [
      path.join(process.env.PROGRAMFILES || "C:\\Program Files", "Google\\Chrome\\Application\\chrome.exe"),
      path.join(process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)", "Google\\Chrome\\Application\\chrome.exe"),
      path.join(process.env.LOCALAPPDATA || "", "Google\\Chrome\\Application\\chrome.exe"),
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }
    return "chrome"; // Fallback to PATH
  } else if (platform === "darwin") {
    const macPaths = [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      path.join(os.homedir(), "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
    ];
    for (const p of macPaths) {
      if (fs.existsSync(p)) return p;
    }
    return "google-chrome"; // Fallback
  } else {
    // Linux
    const linuxPaths = ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium-browser", "/usr/bin/chromium"];
    for (const p of linuxPaths) {
      if (fs.existsSync(p)) return p;
    }
    return "google-chrome";
  }
}

/**
 * Launch Chrome with remote debugging enabled and navigate to dashboard.
 * Uses a separate user-data-dir so it doesn't conflict with other Chrome instances.
 */
function launchChromeDashboard(url: string): void {
  const chromeBin = findChromeBinary();
  // Use a project-local directory so the zombie sweeper can track and clean it
  // (Rule 8: user-data-dirs MUST be in tracked directories, not os.tmpdir)
  const debugUserData = path.join(process.cwd(), ".chrome-dashboard");

  // Don't re-launch if Chrome is already running from us
  if (chromeProcess && !chromeProcess.killed) {
    log.info("[CDP] Chrome dashboard already running — refreshing via CDP...");
    void cdpNavigate(url);
    return;
  }

  const args = [
    `--remote-debugging-port=${CDP_DEBUG_PORT}`,
    `--user-data-dir=${debugUserData}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-infobars",
    "--disable-extensions",
    "--disable-popup-blocking",
    `--window-size=1920,1080`,
    url,
  ];

  log.info(`[CDP] Launching Chrome: ${chromeBin.split(path.sep).pop()} → ${url}`);
  log.info(`[CDP] Debug port: ${CDP_DEBUG_PORT}`);

  try {
    if (os.platform() === "win32") {
      // Windows: build a single command string to avoid DEP0190 deprecation
      // (passing args array with shell:true is deprecated in Node v25+).
      // Quoting the binary path handles paths with spaces (Program Files).
      const cmdStr = `"${chromeBin}" ${args.join(" ")}`;
      chromeProcess = spawn(cmdStr, [], {
        detached: true,
        stdio: "ignore",
        shell: true,
      });
    } else {
      chromeProcess = spawn(chromeBin, args, {
        detached: true,
        stdio: "ignore",
      });
    }

    chromeProcess.unref(); // Don't keep server alive for Chrome

    // Register the dashboard Chrome PID with the zombie cleaner's protection
    // list so it is never killed as an orphan (belt-and-suspenders with the
    // path-based .chrome-dashboard exclusion in process-cleaner.ts).
    if (chromeProcess.pid) {
      protectPid(chromeProcess.pid);
    }

    chromeProcess.on("error", (err) => {
      log.warn(`[CDP] Failed to launch Chrome: ${err instanceof Error ? err.message : String(err)}`);
      log.info(`[CDP] Fallback: attempting system 'start' / 'open'...`);
      if (chromeProcess?.pid) unprotectPid(chromeProcess.pid);
      // Fallback to system default browser
      if (os.platform() === "win32") {
        exec(`start "" "${url}"`).on("error", () => { });
      } else if (os.platform() === "darwin") {
        exec(`open "${url}"`).on("error", () => { });
      } else {
        exec(`xdg-open "${url}"`).on("error", () => { });
      }
      chromeProcess = null;
    });

    chromeProcess.on("exit", (code) => {
      if (chromeProcess?.pid) unprotectPid(chromeProcess.pid);
      log.info(`[CDP] Chrome exited (code: ${code})`);
      chromeProcess = null;
      stopCdpObserver();
    });

    // Start CDP observation after a short delay for Chrome to boot
    setTimeout(() => startCdpObserver(url), 3000).unref();

  } catch (err: unknown) {
    log.error(`[CDP] Chrome launch error: ${err instanceof Error ? err.message : String(err)}`);
    // Fallback to system default browser
    if (os.platform() === "win32") {
      exec(`start "" "${url}"`).on("error", () => { });
    } else {
      exec(`open "${url}"`).on("error", () => { });
    }
  }
}

/**
 * CDP Observer — connects to Chrome's debug port and monitors dashboard health.
 * Reports connection state, page errors, and auto-recovers navigation.
 */
// eslint-disable-next-line @typescript-eslint/require-await
async function startCdpObserver(dashUrl: string): Promise<void> {
  if (cdpObserverInterval) return; // Already running

  log.info(`[CDP Observer] Starting health monitor on port ${CDP_DEBUG_PORT}...`);

  let consecutiveFailures = 0;
  const MAX_FAILURES = 5;
  let lastHealthReport = 0;

  cdpObserverInterval = process.env.VITEST ? null : setInterval(async () => {
    try {
      // Step 1: Get list of pages from Chrome's debug endpoint
      const resp = await fetch(`http://127.0.0.1:${CDP_DEBUG_PORT}/json`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const pages: any[] = await resp.json();

      // Find our dashboard tab
      const dashTab = pages.find(p =>
        p.type === "page" && (p.url.includes(`127.0.0.1:${PORT}`) || p.url.includes("localhost"))
      );

      if (!dashTab) {
        log.warn(`[CDP Observer] Dashboard tab not found in ${pages.length} tabs — attempting to open...`);
        // Open dashboard in a new tab via CDP
        await fetch(`http://127.0.0.1:${CDP_DEBUG_PORT}/json/new?${encodeURIComponent(dashUrl)}`);
        return;
      }

      consecutiveFailures = 0;

      // Step 2: Connect via WebSocket to get page health
      const wsUrl = dashTab.webSocketDebuggerUrl;
      if (wsUrl && !cdpObserverWs) {
        try {
          const { WebSocket: WsClient } = await import("ws");
          cdpObserverWs = new WsClient(wsUrl);
          let msgId = 1;

          cdpObserverWs.on("open", () => {
            log.info(`[CDP Observer] Connected to dashboard tab: ${dashTab.title}`);
            // Enable console and runtime error monitoring
            cdpObserverWs.send(JSON.stringify({ id: msgId++, method: "Console.enable" }));
            cdpObserverWs.send(JSON.stringify({ id: msgId++, method: "Runtime.enable" }));
            cdpObserverWs.send(JSON.stringify({ id: msgId++, method: "Log.enable" }));
          });

          cdpObserverWs.on("message", (raw: any) => {
            try {
              const msg = JSON.parse(raw.toString());
              // Log JS console errors from the dashboard
              if (msg.method === "Runtime.exceptionThrown") {
                const ex = msg.params?.exceptionDetails;
                const txt = ex?.exception?.description || ex?.text || "Unknown";
                broadcast({ type: "log", data: { level: "ERR", message: `[CDP] Dashboard JS error: ${txt.substring(0, 200)}` } });
              }
              // Log console.error calls
              if (msg.method === "Console.messageAdded" && msg.params?.message?.level === "error") {
                broadcast({ type: "log", data: { level: "ERR", message: `[CDP] Console: ${msg.params.message.text?.substring(0, 200)}` } });
              }
              // Track navigation events
              if (msg.method === "Log.entryAdded" && msg.params?.entry?.level === "error") {
                const txt = msg.params.entry.text || "";
                if (txt.includes("WebSocket") || txt.includes("connection")) {
                  log.warn(`[CDP Observer] WS connection issue detected: ${txt.substring(0, 150)}`);
                }
              }
            } catch { /* intentional */ }
          });

          cdpObserverWs.on("close", () => {
            cdpObserverWs = null;
          });

          cdpObserverWs.on("error", () => {
            cdpObserverWs = null;
          });
        } catch {
          cdpObserverWs = null;
        }
      }

      // Step 3: Periodic health report (every 60s)
      const now = Date.now();
      if (now - lastHealthReport > 60_000) {
        lastHealthReport = now;
        const pageCount = pages.filter(p => p.type === "page").length;
        broadcast({ type: "log", data: { level: "INFO", message: `[CDP Observer] Health OK — ${pageCount} tab(s), dashboard: ${dashTab.title}` } });
      }

    } catch (err: unknown) {
      consecutiveFailures++;
      if (consecutiveFailures <= 2) {
        // First few failures — Chrome might still be starting
        return;
      }
      if (consecutiveFailures === 3) {
        log.warn(`[CDP Observer] Cannot reach Chrome debug port (${err instanceof Error ? err.message : String(err)}) — monitoring paused`);
      }
      if (consecutiveFailures >= MAX_FAILURES) {
        log.warn(`[CDP Observer] ${MAX_FAILURES} consecutive failures — stopping observer`);
        stopCdpObserver();
      }
    }
  }, 10_000); // Check every 10 seconds
}

/** Navigate the first dashboard tab to a URL via CDP */
async function cdpNavigate(url: string): Promise<void> {
  try {
    const resp = await fetch(`http://127.0.0.1:${CDP_DEBUG_PORT}/json`);
    if (!resp.ok) return;
    const pages: any[] = await resp.json();
    const dashTab = pages.find(p => p.type === "page" && p.url.includes(`127.0.0.1:${PORT}`));
    if (dashTab) {
      const { WebSocket: WsClient } = await import("ws");
      const ws = new WsClient(dashTab.webSocketDebuggerUrl);
      ws.on("open", () => {
        ws.send(JSON.stringify({ id: 1, method: "Page.navigate", params: { url } }));
        setTimeout(() => ws.close(), 1000).unref();
      });
    }
  } catch { /* intentional */ }
}

/** Stop the CDP observer cleanly */
function stopCdpObserver(): void {
  if (cdpObserverInterval) {
    clearInterval(cdpObserverInterval);
    cdpObserverInterval = null;
  }
  if (cdpObserverWs) {
    try { cdpObserverWs.close(); } catch { /* intentional */ }
    cdpObserverWs = null;
  }
}

startExtraServers();

// --- Feature 1: Real-time Vitals Broadcast ---
process.env.VITEST ? null : setInterval(() => {
  try {
    const load = os.loadavg()[0] || 0;
    const mem = process.memoryUsage();
    const rss = mem.rss / 1024 / 1024;
    broadcast({
      type: "vitals",
      data: {
        load: load.toFixed(2),
        rss: rss.toFixed(1),
        heapUsed: (mem.heapUsed / 1024 / 1024).toFixed(1)
      }
    });
  } catch {
    // silently fail vitals
  }
}, 2000).unref();

process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("unhandledRejection", (reason) => {
  // Suppress known harmless Camoufox/Firefox internal error that spams logs
  const msg = reason instanceof Error ? reason.stack || reason.message : String(reason);
  if (msg.includes("FFPage._onUncaughtError") || msg.includes("FFBrowserContext")) return;
  log.error("Unhandled rejection:", reason);
});
process.on("uncaughtException", (err) => {
  log.error("Uncaught exception:", err);
  gracefulShutdown("uncaughtException");
});app.post("/api/hot-reload", express.json(), (req, res) => {
  const { targetName } = req.body;
  if (!targetName) return res.status(400).json({ error: "Missing targetName" });
  const keys = Object.keys(require.cache).filter(k => k.includes(targetName));
  keys.forEach(k => delete require.cache[k]);
  res.json({ success: true, count: keys.length });
});

app.post("/api/grid/arrange", (req, res) => {
  void globalTiler.acquireSlot(); // dummy acquire to trigger refresh
  res.json({ success: true });
});
