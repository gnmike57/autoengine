/**
 * Standalone zombie cleaner.
 *
 *   npm run clean:zombies            # cleans all orphan Chromium PIDs we own
 *   npx tsx clean-zombies.ts --dry   # report only, no kills
 *
 * "Ours" = Chromium / CloakBrowser processes whose --user-data-dir lands
 * inside the configured cloak-profile root, $TMPDIR/cloak-profiles, or the
 * repo root. The normal user Chrome is never targeted.
 */
import { findOurOrphans, killOurOrphans, installGlobalCleanupHandlers } from "./process-cleaner.js";
installGlobalCleanupHandlers();

async function main(): Promise<void> {
  const dryRun = process.argv.slice(2).includes("--dry");
  const found = await findOurOrphans({ minEtimeSec: 0 });
  if (found.length === 0) {
    console.log("[clean-zombies] no orphan Chromium PIDs found");
    return;
  }
  console.log(`[clean-zombies] found ${found.length} orphan PID(s):`);
  for (const f of found) {
    const preview = f.cmd.length > 140 ? f.cmd.slice(0, 137) + "..." : f.cmd;
    console.log(`  pid=${f.pid} etime=${f.etimeSec}s ${preview}`);
  }
  if (dryRun) {
    console.log("[clean-zombies] --dry specified; not killing");
    return;
  }
  const r = await killOurOrphans({ timeoutMs: 5000, minEtimeSec: 0 });
  console.log(`[clean-zombies] killed=${r.killed} survived=${r.survived}`);
  if (r.survived > 0) process.exitCode = 1;
}

main().then(() => process.exit(process.exitCode ?? 0)).catch((err) => {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  console.error("[clean-zombies] failed:", err?.message || err);
  process.exit(1);
});
