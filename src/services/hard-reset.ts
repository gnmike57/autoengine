/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/**
 * Hard-reset CLI — wipes local browser state and burn bookkeeping so the
 * next run starts from a clean slate.
 *
 * What it removes:
 *   • Every cloak profile directory under $CLOAK_PROFILE_DIR (and the default
 *     $TMPDIR/cloak-profiles fallback), including persistent and isolated
 *     per-session subdirectories.
 *   • The pre-warmed static cache directory ($CLOAK_STATIC_CACHE_DIR, default
 *     .cloak-static-cache) — both Joe and Ignition pre-warmed assets live in
 *     a single shared cache root, so wiping it drops both at once.
 *
 * What it touches (mutates, not deletes):
 *   • progress.json — every per-site row that ended in an N/A outcome whose
 *     error matches an UPDATE YOUR PIN / PIN UPDATE / LOGIN VERIFICATION
 *     misdirection (or a "requeued:" marker) is reverted to
 *     {outcome: "queued", attempts: 0, error: removed}. The top-level
 *     row.status is also reset to "queued" if no other site on the row
 *     remains in a terminal state.
 *
 * Idempotent: missing paths and absent rows are silently skipped.
 * Destructive by default; pass --dry to preview without writing anything.
 */
import "dotenv/config";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as readline from "readline/promises";
import { getStaticCacheDir } from "../stealth/static-cache.js";
import { createLogger } from "../core/logger.js";

const log = createLogger("hard-reset");
const DRY_RUN = process.argv.includes("--dry");
const FORCE = process.argv.includes("--force") || process.env.HARD_RESET_CONFIRM === "1";

async function rmrf(target: string): Promise<boolean> {
  if (!fs.existsSync(target)) return false;
  if (DRY_RUN) { log.info(`(dry-run) would remove ${target}`); return true; }
  await fs.promises.rm(target, { recursive: true, force: true });
  return true;
}

function profileRoots(): string[] {
  const out = new Set<string>();
  const env = (process.env.CLOAK_PROFILE_DIR || "").trim();
  if (env) out.add(path.resolve(env));
  out.add(path.join(os.tmpdir(), "cloak-profiles"));
  out.add(path.join(process.cwd(), "cloak-profiles"));
  return [...out];
}

async function resetProgressJson(file = "progress.json"): Promise<{ rowsTouched: number; sitesReset: number }> {
  if (!fs.existsSync(file)) { log.info(`${file} absent — skipping progress reset`); return { rowsTouched: 0, sitesReset: 0 }; }
  const raw = await fs.promises.readFile(file, "utf-8");
  let data: { rows?: Array<{ sites?: Record<string, { outcome?: string; attempts?: number; error?: string }>; status?: string }>; updatedAt?: string; [key: string]: unknown };
  try { data = JSON.parse(raw); } catch (e: unknown) {
    log.error(`${file} is not valid JSON (${e instanceof Error ? e.message : String(e)}); refusing to mutate`);
    return { rowsTouched: 0, sitesReset: 0 };
  }
  if (!Array.isArray(data?.rows)) { log.warn(`${file} has no .rows[] — nothing to reset`); return { rowsTouched: 0, sitesReset: 0 }; }
  let rowsTouched = 0;
  let sitesReset = 0;
  for (const row of data.rows) {
    if (!row?.sites || typeof row.sites !== "object") continue;
    let rowTouched = false;
    for (const siteName of Object.keys(row.sites)) {
      const site = row.sites[siteName];
      const err: string = site?.error ?? "";
      const looksLikeMisdirection = site?.outcome === "N/A" && (
        err.startsWith("misdirection:") || err.startsWith("requeued:")
      );
      if (looksLikeMisdirection) {
        site.outcome = "queued";
        site.attempts = 0;
        delete site.error;
        sitesReset++;
        rowTouched = true;
      }
    }
    if (rowTouched) {
      rowsTouched++;
      // If no site is in a terminal state any more, the row goes back to queued.
      const anyTerminal = Object.values(row.sites).some((s) =>
        s?.outcome && !["queued", "testing"].includes(s.outcome));
      if (!anyTerminal && row.status !== "queued") row.status = "queued";
    }
  }
  if (rowsTouched === 0) {
    log.info(`${file} contains no misdirection rows — nothing to do`);
    return { rowsTouched, sitesReset };
  }
  if (DRY_RUN) {
    log.info(`(dry-run) would reset ${sitesReset} site(s) across ${rowsTouched} row(s) in ${file}`);
    return { rowsTouched, sitesReset };
  }
  data.updatedAt = new Date().toISOString();
  const tmp = `${file}.tmp`;
  await fs.promises.writeFile(tmp, JSON.stringify(data, null, 2));
  await fs.promises.rename(tmp, file);
  return { rowsTouched, sitesReset };
}

async function confirmDestructiveReset(): Promise<void> {
  if (DRY_RUN || FORCE) return;
  if (!process.stdin.isTTY) {
    throw new Error("Refusing destructive hard reset without an interactive TTY. Re-run with --dry or --force.");
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question('This will delete cloak profiles/static cache and mutate progress.json. Type "RESET" to continue: ');
    if (answer !== "RESET") throw new Error("Hard reset cancelled");
  } finally {
    rl.close();
  }
}

async function main(): Promise<void> {
  await confirmDestructiveReset();
  log.info(DRY_RUN ? "DRY RUN — no files will be modified" : "executing hard reset");

  for (const root of profileRoots()) {
    if (await rmrf(root)) log.info(`removed profile root: ${root}`);
    else log.info(`profile root absent: ${root}`);
  }

  const staticCache = getStaticCacheDir();
  if (await rmrf(staticCache)) log.info(`removed static cache: ${staticCache}`);
  else log.info(`static cache absent: ${staticCache}`);

  const { rowsTouched, sitesReset } = await resetProgressJson("progress.json");
  log.info(`progress.json: ${sitesReset} site outcome(s) reset across ${rowsTouched} row(s)`);

  log.info(DRY_RUN ? "dry run complete" : "hard reset complete");
}

main().catch((err: unknown) => { log.error(err instanceof Error ? err.message : String(err)); process.exit(1); });
