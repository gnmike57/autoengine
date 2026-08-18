/**
 * Scheduled Fingerprint Rotation Script
 *
 * Called by the GitHub Actions fingerprint-rotation workflow every 3 hours.
 * Reads the credential database and advances the rotation counter for
 * any credential that has exceeded its session threshold.
 */

import fs from "node:fs";
import path from "node:path";
import { FingerprintRotationEngine } from "../src/stealth/fingerprint-rotation-engine.js";
import { DetectionFeedbackLoop } from "../src/stealth/detection-feedback.js";
import { ResearchOrchestrator } from "../src/intelligence/research-orchestrator.js";

const PROJECT_ROOT = path.resolve(import.meta.dirname ?? ".", "..");

async function main() {
  const mode = process.env.ROTATION_MODE || "manual";
  console.log(`[rotate] Fingerprint rotation — mode: ${mode}`);
  console.log(`[rotate] Timestamp: ${new Date().toISOString()}`);

  // Initialise engines
  const engine = new FingerprintRotationEngine({
    ledgerPath: path.join(PROJECT_ROOT, "rotation-ledger.json"),
    sessionsPerRotation: 3,
    log: console.log,
  });

  const feedback = new DetectionFeedbackLoop({
    dbPath: path.join(PROJECT_ROOT, "detection-blacklist.json"),
    log: console.log,
  });

  const orchestrator = new ResearchOrchestrator({
    statePath: path.join(PROJECT_ROOT, "research-state.json"),
    skillsPath: path.join(PROJECT_ROOT, "research-skills.json"),
    feedbackLoop: feedback,
    log: console.log,
  });

  // Load credentials (if CSV exists)
  const csvPath = path.join(PROJECT_ROOT, "credentials.csv");
  let emails: string[] = [];

  if (fs.existsSync(csvPath)) {
    const csv = fs.readFileSync(csvPath, "utf-8");
    emails = csv
      .split("\n")
      .slice(1) // skip header
      .map(line => line.split(",")[0]?.trim())
      .filter((e): e is string => !!e && e.includes("@"));
    console.log(`[rotate] Found ${emails.length} credentials`);
  } else {
    console.log("[rotate] No credentials.csv found — nothing to rotate");
    return;
  }

  // Report rotation for each credential (Read-only)
  let activeRotations = 0;
  for (const email of emails) {
    const rotation = engine.getRotation(email);
    const sessions = engine.getSessionCount(email);
    if (rotation > 0 || sessions > 0) {
      activeRotations++;
      console.log(`[rotate] ${email}: rotation ${rotation}, sessions ${sessions}`);
    }
  }

  console.log(`\n[rotate] Summary:`);
  console.log(`  Total credentials: ${emails.length}`);
  console.log(`  Active rotations reported: ${activeRotations}`);
  console.log(`  Active blacklist entries: ${feedback.size}`);
  console.log(`  Research targets: ${orchestrator.getTargets().length}`);
  console.log(`  Deployed skills: ${orchestrator.getAllSkills().length}`);
}

main().catch(err => {
  console.error("[rotate] Fatal error:", err);
  process.exit(1);
});