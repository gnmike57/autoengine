/**
 * One-shot tool: rename existing .webm recordings to the new
 * `<emailSlug>__<sessionId>.webm` format that finalizeLocalRecording in
 * cloak-backend.ts now produces.
 *
 * Joins each recording against progress.json (and live-test-progress.json)
 * by sessionId → email, then renames. Files that already follow the new
 * format are skipped. Files for which no email can be resolved are listed
 * but not touched.
 *
 * Usage:
 *   npx tsx rename-recordings.ts          # dry-run: print the plan, no renames
 *   npx tsx rename-recordings.ts --apply  # actually rename the files
 */
import * as fs from "fs";
import * as path from "path";

const APPLY = process.argv.includes("--apply");
const RECORDINGS_DIR = path.resolve(process.env.CLOAK_RECORDING_DIR || process.env.LOCAL_RECORDING_DIR || "recordings");
const PROGRESS_FILES = ["progress.json", "live-test-progress.json"];

interface ProgressRow {
  email?: string;
  sessionId?: string;
  recordingUrl?: string;
}
interface ProgressJSON {
  rows?: ProgressRow[];
}

/** Mirror of emailSlugForFilename in cloak-backend.ts. Kept inline so this
 *  tool is fully self-contained and can be run independently. */
function emailSlugForFilename(email: string | undefined): string {
  if (!email) return "nocred";
  const cleaned = email.trim().toLowerCase().replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 64);
  return cleaned || "nocred";
}

async function loadSessionEmailMap(): Promise<Map<string, string>> {
  const m = new Map<string, string>();
  for (const f of PROGRESS_FILES) {
    if (!fs.existsSync(f)) continue;
    try {
      const data = JSON.parse(await fs.promises.readFile(f, "utf-8")) as ProgressJSON;
      for (const row of data.rows ?? []) {
        if (row.sessionId && row.email && !m.has(row.sessionId)) {
          m.set(row.sessionId, row.email);
        }
      }
    } catch (e: unknown) {
      console.warn(`[rename-recordings] Failed to parse ${f}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return m;
}

async function planRenames(): Promise<{ renames: Array<{ from: string; to: string }>; alreadyOk: string[]; orphans: string[] }> {
  if (!fs.existsSync(RECORDINGS_DIR)) {
    console.error(`[rename-recordings] recordings dir not found: ${RECORDINGS_DIR}`);
    return { renames: [], alreadyOk: [], orphans: [] };
  }
  const sessionEmail = await loadSessionEmailMap();
  const renames: Array<{ from: string; to: string }> = [];
  const alreadyOk: string[] = [];
  const orphans: string[] = [];
  const entries = (await fs.promises.readdir(RECORDINGS_DIR)).sort();
  for (const name of entries) {
    if (!name.toLowerCase().endsWith(".webm")) continue;
    // New format already: `<slug>__<sessionId>.webm` — leave alone.
    if (name.includes("__")) { alreadyOk.push(name); continue; }
    // Old format: `<sessionId>.webm` — e.g. cloak-4d1bf740-64858.webm
    const sessionId = name.replace(/\.webm$/i, "");
    const email = sessionEmail.get(sessionId);
    if (!email) { orphans.push(name); continue; }
    const slug = emailSlugForFilename(email);
    const newName = `${slug}__${sessionId}.webm`;
    if (newName === name) { alreadyOk.push(name); continue; }
    renames.push({ from: name, to: newName });
  }
  return { renames, alreadyOk, orphans };
}

async function applyRenames(plan: ReturnType<typeof planRenames> extends Promise<infer T> ? T : never): Promise<{ renamed: number; skipped: number; failed: number }> {
  let renamed = 0, skipped = 0, failed = 0;
  await Promise.all(plan.renames.map(async ({ from, to }) => {
    const src = path.join(RECORDINGS_DIR, from);
    const dest = path.join(RECORDINGS_DIR, to);
    if (fs.existsSync(dest)) {
      console.warn(`[rename-recordings] SKIP collision: ${to} already exists; leaving ${from}`);
      skipped++;
      return;
    }
    try {
      await fs.promises.rename(src, dest);
      renamed++;
    } catch (e: unknown) {
      console.error(`[rename-recordings] FAIL ${from} → ${to}: ${e instanceof Error ? e.message : String(e)}`);
      failed++;
    }
  }));
  return { renamed, skipped, failed };
}

async function main(): Promise<void> {
  console.log(`[rename-recordings] dir=${RECORDINGS_DIR} mode=${APPLY ? "APPLY" : "DRY-RUN"}`);
  const plan = await planRenames();
  console.log(`[rename-recordings] plan: ${plan.renames.length} rename(s), ${plan.alreadyOk.length} already-ok, ${plan.orphans.length} orphan(s) (no progress.json match)`);
  if (plan.renames.length > 0) {
    console.log(`[rename-recordings] first 10 renames:`);
    for (const r of plan.renames.slice(0, 10)) console.log(`  ${r.from}  →  ${r.to}`);
    if (plan.renames.length > 10) console.log(`  … and ${plan.renames.length - 10} more`);
  }
  if (plan.orphans.length > 0) {
    console.log(`[rename-recordings] orphans (no email — left alone):`);
    for (const o of plan.orphans.slice(0, 10)) console.log(`  ${o}`);
    if (plan.orphans.length > 10) console.log(`  … and ${plan.orphans.length - 10} more`);
  }
  if (!APPLY) {
    console.log(`[rename-recordings] dry-run complete. Pass --apply to perform the renames.`);
    return;
  }
  const result = await applyRenames(plan);
  console.log(`[rename-recordings] done: renamed=${result.renamed} skipped=${result.skipped} failed=${result.failed}`);
}

void main();