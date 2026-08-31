/* eslint-disable @typescript-eslint/no-misused-promises, no-useless-assignment*/
/**
 * Global zombie-process cleaner for the testing infrastructure.
 *
 * Scope is intentionally narrow: we only ever touch Chromium / CloakBrowser
 * processes whose `--user-data-dir` points into one of OUR profile roots
 * (CLOAK_PROFILE_DIR, $TMPDIR/cloak-profiles, or the repo root). The user's
 * normal Chrome — and any other Playwright project on the box — is safe.
 *
 * Cross-platform: uses `ps -axo` on Unix and `wmic process` on Windows.
 *
 * Surfaces:
 *   findOurOrphans({ minEtimeSec })      → list candidate PIDs
 *   killOurOrphans({ timeoutMs, dryRun}) → SIGTERM, then SIGKILL after timeout
 *   cleanPreviousZombies(opts)           → pre-flight, called at test startup
 *   installGlobalCleanupHandlers(opts)   → SIG*, uncaught*, unhandled* hooks
 */
import { exec, execSync } from "child_process";
import { promisify } from "util";
import * as os from "os";
import * as path from "path";
import { createLogger } from "../core/logger.js";

const IS_WINDOWS = os.platform() === "win32";

function makeLogger(subLabel?: string) {
  return createLogger(subLabel ? `zombie-cleaner:${subLabel}` : "zombie-cleaner");
}

// ─── Protected Process Registry ─────────────────────────────────────────────
// Dashboard Chrome and other server-owned browser processes must never be
// killed by the zombie cleaner.  Two complementary mechanisms:
//   1. PID-based:  protectPid() / unprotectPid() — guards the exact PID tree
//   2. Path-based: PROTECTED_USER_DATA_DIRS — guards the user-data-dir path

const protectedPids = new Set<number>();

/** Mark a PID as server-owned so the zombie reaper will never kill it. */
export function protectPid(pid: number): void   { protectedPids.add(pid); }
/** Remove a PID from the protection list (call on process exit). */
export function unprotectPid(pid: number): void { protectedPids.delete(pid); }

/**
 * Directories whose browser processes are server-owned infrastructure, NOT
 * orphans.  Any Chrome/Firefox with --user-data-dir matching one of these
 * (exact or child path) is unconditionally exempt from cleanup.
 *
 * NOTE: Uses the **basename** for portability — any user-data-dir whose final
 * path component matches is protected, regardless of the absolute path prefix.
 */
const PROTECTED_USER_DATA_DIR_BASENAMES = new Set<string>([
  ".chrome-dashboard",   // CDP-enabled dashboard Chrome
]);

/** Register an additional user-data-dir basename as protected at runtime. */
export function protectUserDataDir(basename: string): void {
  PROTECTED_USER_DATA_DIR_BASENAMES.add(basename);
}

/** Check whether a user-data-dir path is protected from cleanup. */
function isProtectedUserDataDir(uddPath: string): boolean {
  const resolved = path.resolve(uddPath);
  const base = path.basename(resolved);
  return PROTECTED_USER_DATA_DIR_BASENAMES.has(base);
}

type Found = { pid: number; etimeSec: number; cmd: string };

function getProfileRoots(): string[] {
  const roots = new Set<string>();
  const envRoot = (process.env.CLOAK_PROFILE_DIR || "").trim();
  if (envRoot) roots.add(path.resolve(envRoot));
  roots.add(path.join(os.tmpdir(), "cloak-profiles"));
  // The repo root catches anything Playwright drops under cwd (recordings, tmp, etc).
  roots.add(path.resolve(process.cwd()));
  return Array.from(roots);
}

function parseEtimeToSeconds(et: string): number {
  // ps etime format: [[DD-]HH:]MM:SS
  const m = et.match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  if (!m) return 0;
  const d = m[1] ? parseInt(m[1], 10) : 0;
  const h = m[2] ? parseInt(m[2], 10) : 0;
  // @ts-expect-error noUncheckedIndexedAccess
  const mm = parseInt(m[3], 10);
  // @ts-expect-error noUncheckedIndexedAccess
  const ss = parseInt(m[4], 10);
  return d * 86400 + h * 3600 + mm * 60 + ss;
}

/** Browser process names — used on both platforms. */
const BROWSER_EXE_NAMES = [
  "chromium", "chrome", "google chrome", "cloakbrowser",
  "cloak-browser", "firefox", "camoufox",
];

function looksLikeBrowserProcess(cmd: string): boolean {
  return /(^|\/)(chromium|chrome|google chrome|cloakbrowser|cloak-browser|firefox|camoufox)(\s|$)/i.test(cmd) ||
    /\b(chromium|chrome|cloakbrowser|cloak-browser|firefox|camoufox|zendriver_launcher|zendriver_headed_launcher)\b/i.test(cmd);
}

/** Windows-specific: match image name against known browser executables. */
function looksLikeBrowserExe(imageName: string): boolean {
  const lower = imageName.toLowerCase().replace(/\.exe$/i, "");
  return BROWSER_EXE_NAMES.some((name) => lower === name.replace(/\s/g, "")) ||
    /^(chromium|chrome|cloakbrowser|cloak-browser|firefox|camoufox)$/i.test(lower);
}

function extractUserDataDir(cmd: string): string | undefined {
  const quoted = cmd.match(/(?:--user-data-dir=|--profile=|-profile\s+)("([^"]+)"|'([^']+)'|(\S+))/);
  if (!quoted) return undefined;
  // Extract from the first available capture group
  return (quoted[2] || quoted[3] || quoted[4] || "").replace(/^['"]|['"]$/g, "");
}

const execAsync = promisify(exec);

// ─── Windows WMI CreationDate parser ──────────────────────────────────────────
// WMI CreationDate format: "20260610070000.000000+600"
// ─── Windows process discovery ──────────────────────────────────────────────

async function findOurOrphansWindows(opts: { minEtimeSec?: number; excludePids?: number[] }): Promise<Found[]> {
  const log = makeLogger("win-discovery");
  const roots = getProfileRoots();
  const excludeSelf = new Set<number>([process.pid, ...(opts.excludePids ?? []), ...protectedPids]);
  const found: Found[] = [];

  // Strategy 1: Use PowerShell Get-CimInstance for reliable command-line extraction.
  // wmic is deprecated on modern Windows; PowerShell is universally available.
  try {
    const psCmd = `powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -match 'chrome|chromium|firefox|camoufox|cloakbrowser' } | Select-Object ProcessId,CommandLine,CreationDate | ConvertTo-Csv -NoTypeInformation"`;
    const { stdout } = await execAsync(psCmd, { maxBuffer: 10 * 1024 * 1024, timeout: 15000 });

    const lines = stdout.split(/\r?\n/).filter((l) => l.trim());
    // First line is CSV header: "ProcessId","CommandLine","CreationDate"
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i]!;
      // Parse CSV — fields are double-quoted
      const fields = parseCsvLine(line);
      if (fields.length < 3) continue;

      const pid = parseInt(fields[0]!, 10);
      if (isNaN(pid) || excludeSelf.has(pid)) continue;

      const cmdLine = fields[1] || "";
      const creationDateStr = fields[2] || "";

      // Compute etime from creation date
      let etimeSec = 0;
      if (creationDateStr) {
        // PowerShell outputs dates like "6/10/2026 5:00:00 PM" or ISO format
        try {
          const created = new Date(creationDateStr);
          if (!isNaN(created.getTime())) {
            etimeSec = Math.max(0, Math.floor((Date.now() - created.getTime()) / 1000));
          }
        } catch { /* ignore parse errors */ }
      }

      // eslint-disable-next-line no-useless-escape
      if (!looksLikeBrowserProcess(cmdLine) && !looksLikeBrowserExe(cmdLine.split(/[\\\/]/).pop() || "")) continue;

      // Check --user-data-dir scoping
      const udd = extractUserDataDir(cmdLine);
      if (udd) {
        // Skip server-owned browser directories (dashboard Chrome, etc.)
        if (isProtectedUserDataDir(udd)) continue;
        const dir = path.resolve(udd);
        if (!roots.some((r) => dir === r || dir.startsWith(r + path.sep))) continue;
      }
      // On Windows, if no --user-data-dir in command line, still match camoufox / zendriver unconditionally
      // (Camoufox uses -profile which may not be detected, and zombie processes MUST be killed)
      if (!udd && !/(camoufox|zendriver_launcher|zendriver_headed_launcher)/i.test(cmdLine)) continue;

      if (opts.minEtimeSec != null && etimeSec < opts.minEtimeSec) continue;

      found.push({ pid, etimeSec, cmd: sanitizeCmd(cmdLine || `[pid:${pid}]`) });
    }
  } catch (e: unknown) {
    log.warn(`PowerShell discovery failed: ${e instanceof Error ? e.message : String(e)}. Falling back to tasklist.`);
    // Strategy 2: Fallback — use tasklist to at least find browser processes by name
    return findOurOrphansTasklist(opts);
  }

  return found;
}

/** Minimal fallback: tasklist can find processes by image name but has no command-line info.
 *  This catches camoufox.exe zombies unconditionally (no --user-data-dir filtering). */
async function findOurOrphansTasklist(opts: { minEtimeSec?: number; excludePids?: number[] }): Promise<Found[]> {
  const excludeSelf = new Set<number>([process.pid, ...(opts.excludePids ?? [])]);
  const found: Found[] = [];
  const targets = ["camoufox.exe", "cloakbrowser.exe"];

  for (const exe of targets) {
    try {
      const { stdout } = await execAsync(`tasklist /FI "IMAGENAME eq ${exe}" /FO CSV /NH`, { timeout: 10000 });
      for (const line of stdout.split(/\r?\n/)) {
        const fields = parseCsvLine(line);
        if (fields.length < 2) continue;
        const pid = parseInt(fields[1]!, 10);
        if (isNaN(pid) || excludeSelf.has(pid)) continue;
        // No etime available from tasklist — use 0 (matches everything unless minEtimeSec is set)
        if (opts.minEtimeSec != null && opts.minEtimeSec > 0) continue;
        found.push({ pid, etimeSec: 0, cmd: `${exe} [pid:${pid}]` });
      }
    } catch { /* tasklist failed for this exe — skip */ }
  }

  return found;
}

/** Parse a single CSV line respecting double-quoted fields. */
function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"'; // Escaped quote
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        fields.push(current.trim());
        current = "";
      } else {
        current += ch;
      }
    }
  }
  fields.push(current.trim());
  return fields;
}

// ─── Unix process discovery (original) ──────────────────────────────────────

async function findOurOrphansUnix(opts: { minEtimeSec?: number; excludePids?: number[] }): Promise<Found[]> {
  const roots = getProfileRoots();
  const excludeSelf = new Set<number>([process.pid, ...(opts.excludePids ?? []), ...protectedPids]);
  let stdout = "";
  try {
    const { stdout: out } = await execAsync("ps -axo pid=,etime=,command=");
    stdout = out;
  } catch {
    return [];
  }

  const found: Found[] = [];
  for (const line of stdout.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\S+)\s+(.+)$/);
    if (!m) continue;
    // @ts-expect-error noUncheckedIndexedAccess
    const pid = parseInt(m[1], 10);
    if (excludeSelf.has(pid)) continue;
    // @ts-expect-error noUncheckedIndexedAccess
    const etimeSec = parseEtimeToSeconds(m[2]);
    // @ts-expect-error noUncheckedIndexedAccess
    const cmd = sanitizeCmd(m[3]);
    if (!looksLikeBrowserProcess(cmd)) continue;
    // Require an explicit --user-data-dir flag that lands inside one of our roots.
    const udd = extractUserDataDir(cmd);
    if (udd) {
      // Skip server-owned browser directories (dashboard Chrome, etc.)
      if (isProtectedUserDataDir(udd)) continue;
      const dir = path.resolve(udd);
      if (!roots.some((r) => dir === r || dir.startsWith(r + path.sep))) continue;
    } else {
      // On Unix, if no --user-data-dir in command line, still match camoufox / zendriver unconditionally
      // (Camoufox uses -profile which may not be detected, and zombie processes MUST be killed)
      if (!/(camoufox|zendriver_launcher|zendriver_headed_launcher)/i.test(cmd)) continue;
    }
    if (opts.minEtimeSec != null && etimeSec < opts.minEtimeSec) continue;
    found.push({ pid, etimeSec, cmd });
  }
  return found;
}

// ─── Cross-platform entry point ─────────────────────────────────────────────

export async function findOurOrphans(opts: { minEtimeSec?: number; excludePids?: number[] } = {}): Promise<Found[]> {
  return IS_WINDOWS
    ? findOurOrphansWindows(opts)
    : findOurOrphansUnix(opts);
}

/** Strip ASCII control characters that could interfere with regex parsing. */
function sanitizeCmd(cmd: string): string {
  // eslint-disable-next-line no-control-regex
  return cmd.replace(/[\x00-\x1F\x7F]/g, '');
}

// ─── Cross-platform kill helpers ────────────────────────────────────────────

function sendSignal(pid: number, sig: "SIGTERM" | "SIGKILL"): boolean {
  if (IS_WINDOWS) {
    // On Windows, process.kill() only works for Node child processes.
    // Use taskkill for reliable killing of arbitrary PIDs.
    try {
      execSync(`taskkill /F /T /PID ${pid}`, { stdio: "ignore", timeout: 5000 });
      return true;
    } catch { return false; }
  }
  try { process.kill(pid, sig); return true; } catch { return false; }
}

function pidAlive(pid: number): boolean {
  if (IS_WINDOWS) {
    try {
      const out = execSync(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`, { timeout: 5000, encoding: "utf-8" });
      // tasklist returns "INFO: No tasks are running..." if PID not found
      return !out.includes("No tasks") && out.includes(String(pid));
    } catch { return false; }
  }
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function killOurOrphans(opts: { timeoutMs?: number; dryRun?: boolean; minEtimeSec?: number; excludePids?: number[] } = {}): Promise<{ killed: number; survived: number; dryRun: number }> {
  const timeout = opts.timeoutMs ?? 5000;
  const found = await findOurOrphans({ minEtimeSec: opts.minEtimeSec, excludePids: opts.excludePids });
  if (found.length === 0) return { killed: 0, survived: 0, dryRun: 0 };
  if (opts.dryRun) return { killed: 0, survived: 0, dryRun: found.length };

  if (IS_WINDOWS) {
    // Windows: taskkill /F is already a hard kill, no SIGTERM/SIGKILL dance needed
    let killed = 0, survived = 0;
    for (const f of found) {
      const ok = sendSignal(f.pid, "SIGKILL");
      if (ok) {
        killed++;
      } else {
        if (pidAlive(f.pid)) {
          survived++;
        } else {
          killed++; // Process is dead (taskkill probably threw because it was already gone)
        }
      }
    }
    return { killed, survived, dryRun: 0 };
  }

  // Unix: graceful SIGTERM → wait → SIGKILL
  for (const f of found) sendSignal(f.pid, "SIGTERM");
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline && found.some((f) => pidAlive(f.pid))) {
    await delay(150);
  }
  let killed = 0, survived = 0;
  for (const f of found) {
    if (!pidAlive(f.pid)) { killed++; continue; }
    sendSignal(f.pid, "SIGKILL");
    await delay(50);
    if (pidAlive(f.pid)) survived++; else killed++;
  }
  return { killed, survived, dryRun: 0 };
}

export async function cleanPreviousZombies(opts: { label?: string; minEtimeSec?: number; timeoutMs?: number } = {}): Promise<void> {
  // Pre-flight: only target processes older than 5s by default so we never
  // race with siblings that this same operator is intentionally running.
  const minEtimeSec = opts.minEtimeSec ?? 5;
  const found = await findOurOrphans({ minEtimeSec });
  if (found.length === 0) return;
  const log = makeLogger(opts.label);
  log.info(`found ${found.length} orphan Chromium PID(s) older than ${minEtimeSec}s — cleaning`);
  const r = await killOurOrphans({ timeoutMs: opts.timeoutMs ?? 5000, minEtimeSec });
  log.info(`cleanup: killed=${r.killed} survived=${r.survived}`);
}

let reaperInterval: NodeJS.Timeout | null = null;

export function startPeriodicZombieReaper(intervalMs: number = 30000, minEtimeSec: number = 30): void {
  if (reaperInterval) return;
  const log = makeLogger('periodic');
  log.info(`Starting periodic zombie reaper (interval: ${intervalMs}ms, minEtime: ${minEtimeSec}s, platform: ${os.platform()})`);
  reaperInterval = setInterval(async () => {
    try {
      const found = await findOurOrphans({ minEtimeSec });
      if (found.length > 0) {
        log.warn(`Reaper detected ${found.length} stalled zombie browsers older than ${minEtimeSec}s. Terminating...`);
        const r = await killOurOrphans({ timeoutMs: 5000, minEtimeSec });
        log.info(`Reaper result: killed=${r.killed} survived=${r.survived}`);
      }
    } catch {
      log.warn('Reaper failed to scan for zombies');
    }
  }, intervalMs);
  reaperInterval.unref?.();
}

export function stopPeriodicZombieReaper(): void {
  if (reaperInterval) {
    clearInterval(reaperInterval);
    reaperInterval = null;
    const log = makeLogger('periodic');
    log.info('Stopped periodic zombie reaper');
  }
}
export function installGlobalCleanupHandlers(opts: { label?: string } = {}): void {
  const log = makeLogger(opts.label || "global-hook");
  const cleanup = () => {
    try {
      if (IS_WINDOWS) {
        execSync(`taskkill /F /IM cloakbrowser.exe /T 2>NUL`);
        execSync(`taskkill /F /IM camoufox.exe /T 2>NUL`);
      } else {
        // Fallback for Unix: try to kill pids based on naive search
        // We can't easily do ps -axo async here because we might be in a sync exit hook
        // but we can run a sync command.
        try {
          const out = execSync("ps -axo pid=,command=").toString();
          for (const line of out.split('\n')) {
            const m = line.match(/^\s*(\d+)\s+(.+)$/);
            if (!m) continue;
            const pid = parseInt(m[1] as string, 10);
            const cmd = m[2];
            if (cmd && /(camoufox|cloakbrowser|chrome.*--user-data-dir)/i.test(cmd)) {
              if (cmd.includes("chrome-dashboard")) continue;
              try { process.kill(pid, "SIGKILL"); } catch { }
            }
          }
        } catch {}
      }
    } catch { }
  };

  process.on("uncaughtException", (err) => {
    log.error(`Uncaught exception: ${err instanceof Error ? err.message : String(err)}`);
    cleanup();
  });

  process.on("unhandledRejection", (err) => {
    log.error(`Unhandled rejection: ${err instanceof Error ? err.message : String(err)}`);
    cleanup();
  });

  process.on("exit", () => {
    cleanup();
  });
}
