// @ts-nocheck
/**
 * RECORD BASELINE — Synthetic Video Fixture Generator
 *
 * Records a .webm video fixture for a given outcome class using the mock login
 * server and Playwright. Output is stored in tests/vision/fixtures/.
 *
 * Usage:
 *   npx tsx scripts/record-baseline.ts --outcome=noaccount
 *   npx tsx scripts/record-baseline.ts --outcome=all
 */
import { chromium } from "playwright-core";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { createMockLoginServer, type MockOutcome } from "../tests/mocks/login-server.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.resolve(__dirname, "../tests/vision/fixtures");

const ALL_OUTCOMES: MockOutcome[] = [
  "noaccount",
  "success",
  "tempdisabled",
  "permdisabled",
  "2fa",
  "incorrect",
  "blocked",
];

const OUTCOME_FILE_MAP: Record<MockOutcome, string> = {
  noaccount: "no-account-baseline",
  success: "success-baseline",
  tempdisabled: "temp-disabled-baseline",
  permdisabled: "perm-disabled-baseline",
  "2fa": "2fa-baseline",
  incorrect: "incorrect-baseline",
  blocked: "blocked-baseline",
};

async function recordBaseline(outcome: MockOutcome): Promise<void> {
  console.log(`\n▶ Recording baseline for: ${outcome}`);

  const { url, close } = await createMockLoginServer(outcome);
  console.log(`  Mock server: ${url}`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    recordVideo: {
      dir: FIXTURES_DIR,
      size: { width: 1280, height: 720 },
    },
  });

  const page = await context.newPage();

  try {
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(800);

    // Fill in credentials
    const emailInput = page.locator("#email");
    const passwordInput = page.locator("#password");
    const submitBtn = page.locator("#submit-btn");

    if (await emailInput.isVisible()) {
      await emailInput.fill("test@example.com");
      await page.waitForTimeout(300);
      await passwordInput.fill("TestPassword123!");
      await page.waitForTimeout(300);
      await submitBtn.click();
      await page.waitForTimeout(1500);
    } else {
      // Blocked page — just wait for render
      await page.waitForTimeout(1500);
    }

    console.log(`  ✓ Interaction complete`);
  } finally {
    // Close page to flush video
    await page.close();
    await context.close();
    await browser.close();
    close();
  }

  // Rename the auto-generated video file to our canonical name
  const files = fs.readdirSync(FIXTURES_DIR).filter((f) => f.endsWith(".webm"));
  if (files.length === 0) {
    throw new Error(`No .webm file found in ${FIXTURES_DIR}`);
  }

  // Find the most recently modified .webm
  const latest = files
    .map((f) => ({ f, mtime: fs.statSync(path.join(FIXTURES_DIR, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)[0].f;

  const targetName = `${OUTCOME_FILE_MAP[outcome]}.webm`;
  const targetPath = path.join(FIXTURES_DIR, targetName);

  // Don't rename if it's already the right name
  if (latest !== targetName) {
    fs.renameSync(path.join(FIXTURES_DIR, latest), targetPath);
  }

  // Write sidecar JSON
  const sidecar = {
    outcome,
    domTrigger: outcome,
    httpStatus: outcome === "blocked" ? 403 : outcome === "2fa" ? 428 : 200,
    recordedAt: new Date().toISOString(),
    engineVersion: JSON.parse(
      fs.readFileSync(path.resolve(__dirname, "../package.json"), "utf8")
    ).version as string,
    fixture: targetName,
  };
  fs.writeFileSync(
    path.join(FIXTURES_DIR, `${OUTCOME_FILE_MAP[outcome]}.json`),
    JSON.stringify(sidecar, null, 2)
  );

  console.log(`  ✓ Saved: ${targetPath}`);
  console.log(`  ✓ Sidecar: ${OUTCOME_FILE_MAP[outcome]}.json`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const outcomeArg = args.find((a) => a.startsWith("--outcome="))?.split("=")[1];

  if (!outcomeArg) {
    console.error("Usage: npx tsx scripts/record-baseline.ts --outcome=<outcome|all>");
    process.exit(1);
  }

  fs.mkdirSync(FIXTURES_DIR, { recursive: true });

  const targets: MockOutcome[] =
    outcomeArg === "all" ? ALL_OUTCOMES : [outcomeArg as MockOutcome];

  for (const outcome of targets) {
    if (!ALL_OUTCOMES.includes(outcome)) {
      console.error(`Unknown outcome: ${outcome}. Valid: ${ALL_OUTCOMES.join(", ")}`);
      process.exit(1);
    }
    await recordBaseline(outcome);
  }

  console.log("\n✅ All baselines recorded successfully.");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
