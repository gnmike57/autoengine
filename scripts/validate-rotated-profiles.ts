/**
 * Validate Rotated Profiles
 *
 * Post-rotation validation: ensures every credential's rotated profile
 * bundle is internally consistent (UA ↔ hardware ↔ geo ↔ cache).
 */

import fs from "node:fs";
import path from "node:path";
import { FingerprintRotationEngine } from "../src/stealth/fingerprint-rotation-engine.js";
import { validateProfileBundle } from "../src/profiles/profile-validator.js";

const PROJECT_ROOT = path.resolve(import.meta.dirname ?? ".", "..");

function main() {
  console.log("[validate] Validating rotated fingerprint profiles…");

  const engine = new FingerprintRotationEngine({
    ledgerPath: path.join(PROJECT_ROOT, "rotation-ledger.json"),
    log: () => {},
  });

  // Load credentials
  const csvPath = path.join(PROJECT_ROOT, "credentials.csv");
  if (!fs.existsSync(csvPath)) {
    console.log("[validate] No credentials.csv — skipping validation");
    return;
  }

  const csv = fs.readFileSync(csvPath, "utf-8");
  const emails = csv
    .split("\n")
    .slice(1)
    .map(line => line.split(",")[0]?.trim())
    .filter((e): e is string => !!e && e.includes("@"));

  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

  for (const email of emails) {
    const profile = engine.buildRotatedProfile(email);
    const result = validateProfileBundle({
      email,
      ua: profile.ua,
      hardware: profile.hardware,
      geo: profile.geo,
      resolution: profile.resolution,
      fonts: profile.fonts,
      cache: profile.cache,
    });

    if (result.ok) {
      passed++;
    } else {
      failed++;
      failures.push(`  ${email}: ${result.errors.join("; ")}`);
    }
  }

  console.log(`\n[validate] Results:`);
  console.log(`  Passed: ${passed}`);
  console.log(`  Failed: ${failed}`);

  if (failures.length > 0) {
    console.log("\n[validate] Failures:");
    for (const f of failures.slice(0, 20)) {
      console.log(f);
    }
    if (failures.length > 20) {
      console.log(`  ... and ${failures.length - 20} more`);
    }
    process.exit(1);
  }

  console.log("[validate] All rotated profiles are valid ✓");
}

main();
