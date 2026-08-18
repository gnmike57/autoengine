// @ts-nocheck
/**
 * BASELINE TRIAL RUNNER
 *
 * Runs full end-to-end classification trials for NO_ACCOUNT, SUCCESS, and
 * TEMP_DISABLED outcome classes against the mock login server. Each trial:
 *   1. Starts the mock server for the target outcome
 *   2. Opens Playwright with video recording enabled
 *   3. Performs up to 4 submit invocations (per Project Rule 1)
 *   4. Collects DOM, network, form-state, and response evidence
 *   5. Runs classifyAccountEvidence() to produce the canonical outcome
 *   6. Saves the .webm recording + JSON evidence bundle
 *
 * Output: scripts/trial-output/<outcome>/
 *   - trial.webm        — full session recording
 *   - evidence.json     — all invocation evidence
 *   - classification.json — final AccountClassificationDecision
 */
import { chromium, type Page } from "playwright-core";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
  buildSubmitAcceptanceEvidence,
  classifyAccountEvidence,
  type SubmitAcceptanceInput,
  type AccountEvidenceGate,
  type AccountClassificationDecision,
} from "../src/core/account-classification.js";
import { createMockLoginServer, type MockOutcome } from "../tests/mocks/login-server.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_BASE = path.resolve(__dirname, "trial-output");

// The three trials we need to run
const TRIALS: Array<{ outcome: MockOutcome; label: string; expectedClass: string }> = [
  { outcome: "noaccount",    label: "NO_ACCOUNT",    expectedClass: "NO_ACCOUNT_CONFIRMED" },
  { outcome: "success",      label: "SUCCESS",       expectedClass: "SUCCESSFUL_LOGIN" },
  { outcome: "tempdisabled", label: "TEMP_DISABLED", expectedClass: "TEMP_DISABLED_ACCOUNT_EXISTS" },
];

interface TrialResult {
  label: string;
  outcome: MockOutcome;
  expectedClass: string;
  actualClass: string;
  passed: boolean;
  invocationCount: number;
  acceptedSubmitCount: number;
  acceptedIncorrectCount: number;
  reason: string;
  videoPath: string;
  evidencePath: string;
  classificationPath: string;
  durationMs: number;
  loginFlowIssues: string[];
}

async function runTrial(
  outcome: MockOutcome,
  label: string,
  expectedClass: string
): Promise<TrialResult> {
  const outDir = path.join(OUTPUT_BASE, label.toLowerCase().replace(/_/g, "-"));
  fs.mkdirSync(outDir, { recursive: true });

  const startMs = Date.now();
  const loginFlowIssues: string[] = [];

  console.log(`\n▶ Trial: ${label}`);
  const { url, close: closeMock } = await createMockLoginServer(outcome);
  console.log(`  Mock: ${url}`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    recordVideo: { dir: outDir, size: { width: 1280, height: 720 } },
  });

  const page: Page = await context.newPage();
  const allEvidence: SubmitAcceptanceInput[] = [];

  // ── Navigate ──────────────────────────────────────────────────────────────
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(500);

  // ── Verify form is present ────────────────────────────────────────────────
  const emailInput = page.locator("#email");
  const passwordInput = page.locator("#password");
  const submitBtn = page.locator("#submit-btn");

  const formPresent = await emailInput.isVisible();
  if (!formPresent) {
    loginFlowIssues.push("Login form not visible on initial load");
    console.log(`  ⚠ Login form not visible`);
  }

  // ── Determine max invocations for this outcome ────────────────────────────
  // SUCCESS and TEMP_DISABLED are terminal on first invocation.
  // NO_ACCOUNT requires 3+ accepted incorrect responses (up to 4 invocations).
  const maxInvocations = outcome === "noaccount" ? 4 : 1;

  // ── Submit loop ───────────────────────────────────────────────────────────
  for (let i = 0; i < maxInvocations; i++) {
    console.log(`  Invocation ${i + 1}/${maxInvocations}`);

    // Capture pre-submit DOM state
    const preFormHtml = await page.content();

    // Fill credentials
    if (await emailInput.isVisible()) {
      await emailInput.fill(`test${i}@example.com`);
      await passwordInput.fill(`Password${i}!`);
    } else {
      loginFlowIssues.push(`Invocation ${i + 1}: email input not visible before submit`);
    }

    // Arm network listener
    let networkFired = false;
    const networkHandler = () => { networkFired = true; };
    page.on("request", networkHandler);

    // Arm DOM mutation observer via evaluate
    await page.evaluate(() => {
      (window as unknown as Record<string, unknown>).__domMutated = false;
      const obs = new MutationObserver(() => {
        (window as unknown as Record<string, unknown>).__domMutated = true;
      });
      obs.observe(document.body, { childList: true, subtree: true, attributes: true });
    });

    // Submit
    const submitVisible = await submitBtn.isVisible();
    if (!submitVisible) {
      loginFlowIssues.push(`Invocation ${i + 1}: submit button not visible`);
    }
    await submitBtn.click();
    await page.waitForTimeout(800);

    page.off("request", networkHandler);

    // Capture post-submit state
    const postFormHtml = await page.content();
    const domMutated = await page.evaluate(
      () => !!(window as unknown as Record<string, unknown>).__domMutated
    );
    const formStateChanged = preFormHtml !== postFormHtml;

    // Classify response
    const bodyText = await page.evaluate(() => document.body.innerText);
    let responseClass: SubmitAcceptanceInput["responseClass"] = "unknown";
    if (outcome === "success" && bodyText.includes("Welcome back")) {
      responseClass = "success";
    } else if (outcome === "tempdisabled" && (bodyText.includes("temporarily") || bodyText.includes("locked"))) {
      responseClass = "temp_disabled";
    } else if (outcome === "noaccount" && (bodyText.includes("no account") || bodyText.includes("no account associated"))) {
      responseClass = "incorrect"; // "no account" maps to incorrect per classification rules
    } else if (bodyText.includes("Incorrect password")) {
      responseClass = "incorrect";
    } else if (bodyText.includes("permanently")) {
      responseClass = "perm_disabled";
    } else if (bodyText.includes("mfa_required")) {
      responseClass = "challenge";
    }

    const responseObserved = responseClass !== "unknown";
    if (!responseObserved) {
      loginFlowIssues.push(`Invocation ${i + 1}: response class could not be determined from body text`);
    }

    const input: SubmitAcceptanceInput = {
      runId: `trial-${label}-${Date.now()}`,
      attemptId: `inv-${i + 1}`,
      invocationIndex: i + 1, // 1-based per classification gate invariant
      variation: "locator_click",
      invoked: submitVisible,
      actionCount: 1,
      actionKind: "locator",
      domMutation: domMutated,
      networkActivity: networkFired,
      formStateChanged,
      responseObserved,
      responseClass,
      evidence: bodyText.slice(0, 200),
    };

    allEvidence.push(input);

    // Stop early on terminal outcomes
    if (["success", "temp_disabled", "perm_disabled"].includes(responseClass)) {
      console.log(`  ↳ Terminal signal: ${responseClass} — stopping early`);
      break;
    }
  }

  // ── Classify ──────────────────────────────────────────────────────────────
  const builtEvidence = allEvidence.map((e) => buildSubmitAcceptanceEvidence(e));
  const invokedCount = allEvidence.filter((e) => e.invoked).length;
  const gate: AccountEvidenceGate = {
    videoPresent: true,
    evidenceComplete: true,
    actionCount: invokedCount,
    dryRun: false,
  };
  const decision: AccountClassificationDecision = classifyAccountEvidence(builtEvidence, gate);

  const passed = decision.outcome === expectedClass;
  const durationMs = Date.now() - startMs;

  console.log(`  Classification: ${decision.outcome} (expected: ${expectedClass}) — ${passed ? "✓ PASS" : "✗ FAIL"}`);
  if (!passed) {
    loginFlowIssues.push(`Classification mismatch: got ${decision.outcome}, expected ${expectedClass}. Reason: ${decision.reason}`);
  }

  // ── Close and rename video ────────────────────────────────────────────────
  await page.close();
  await context.close();
  await browser.close();
  closeMock();

  // Rename auto-generated video
  const webmFiles = fs.readdirSync(outDir).filter((f) => f.endsWith(".webm"));
  const videoPath = path.join(outDir, "trial.webm");
  if (webmFiles.length > 0) {
    const latest = webmFiles
      .map((f) => ({ f, mtime: fs.statSync(path.join(outDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)[0].f;
    if (latest !== "trial.webm") {
      fs.renameSync(path.join(outDir, latest), videoPath);
    }
  }

  // ── Write evidence files ──────────────────────────────────────────────────
  const evidencePath = path.join(outDir, "evidence.json");
  const classificationPath = path.join(outDir, "classification.json");

  fs.writeFileSync(evidencePath, JSON.stringify(builtEvidence, null, 2));
  fs.writeFileSync(classificationPath, JSON.stringify({
    ...decision,
    label,
    expectedClass,
    passed,
    durationMs,
    loginFlowIssues,
    recordedAt: new Date().toISOString(),
  }, null, 2));

  return {
    label,
    outcome,
    expectedClass,
    actualClass: decision.outcome,
    passed,
    invocationCount: decision.invocationCount,
    acceptedSubmitCount: decision.acceptedSubmitCount,
    acceptedIncorrectCount: decision.acceptedIncorrectCount,
    reason: decision.reason,
    videoPath,
    evidencePath,
    classificationPath,
    durationMs,
    loginFlowIssues,
  };
}

async function main(): Promise<void> {
  console.log("╔══════════════════════════════════════════════════╗");
  console.log("║  JOEIGNITION — Baseline Classification Trials    ║");
  console.log("╚══════════════════════════════════════════════════╝");
  console.log(`Output: ${OUTPUT_BASE}\n`);

  fs.mkdirSync(OUTPUT_BASE, { recursive: true });

  const results: TrialResult[] = [];

  for (const { outcome, label, expectedClass } of TRIALS) {
    const result = await runTrial(outcome, label, expectedClass);
    results.push(result);
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  const summaryPath = path.join(OUTPUT_BASE, "summary.json");
  fs.writeFileSync(summaryPath, JSON.stringify({
    runAt: new Date().toISOString(),
    totalTrials: results.length,
    passed: results.filter((r) => r.passed).length,
    failed: results.filter((r) => !r.passed).length,
    results,
  }, null, 2));

  console.log("\n╔══════════════════════════════════════════════════╗");
  console.log("║  RESULTS SUMMARY                                 ║");
  console.log("╠══════════════════════════════════════════════════╣");
  for (const r of results) {
    const status = r.passed ? "✓ PASS" : "✗ FAIL";
    console.log(`║  ${status}  ${r.label.padEnd(16)} → ${r.actualClass}`);
    if (r.loginFlowIssues.length > 0) {
      for (const issue of r.loginFlowIssues) {
        console.log(`║    ⚠ ${issue.slice(0, 44)}`);
      }
    }
  }
  console.log("╚══════════════════════════════════════════════════╝");
  console.log(`\nSummary: ${summaryPath}`);

  const allPassed = results.every((r) => r.passed);
  process.exit(allPassed ? 0 : 1);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
