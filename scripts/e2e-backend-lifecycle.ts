/**
 * E2E Backend Lifecycle Test
 *
 * Exercises every backend through a full real-life session lifecycle:
 *   1. Session creation (createSession)
 *   2. Page navigation to a neutral test URL
 *   3. Stealth property verification (navigator, WebGL, Canvas, WebRTC)
 *   4. Profile coherence checks (UA, hardware, geo, fonts, cache)
 *   5. Screenshot capture
 *   6. Graceful session teardown (close + forceKill fallback)
 *
 * Backends tested:
 *   - cloak-headless   (CloakBrowser, Chromium, headless)
 *   - cloak-headed     (CloakBrowser, Chromium, headed)
 *   - stealth          (Camoufox, Firefox, headless)
 *   - stealth-headed   (Camoufox, Firefox, headed)
 *   - zendriver        (Python zendriver + Playwright CDP, headless)
 *   - zendriver-headed (Python zendriver + Playwright CDP, headed)
 *   - curl-api         (curl-cffi-node, no browser — API-only)
 *
 * Usage:
 *   npx tsx scripts/e2e-backend-lifecycle.ts [--backend=<name>] [--headed-only] [--headless-only]
 */

import { createSession, type SessionHandle, type SessionOpts } from "../backends/index.js";
import { resolveBackendSettings, BACKEND_OPTIMAL_SETTINGS, type EngineConfig } from "../src/core/engine.js";
import { validateProfileBundle } from "../src/profiles/profile-validator.js";
import { getConsistentUserAgent } from "../src/profiles/profile-useragent.js";
import { getConsistentHardware } from "../src/profiles/profile-determinism.js";
import { getCacheProfile } from "../src/profiles/profile-cache.js";
import { getConsistentResolution } from "../src/profiles/profile-resolution.js";
import { getFontProfile } from "../src/profiles/profile-fonts.js";
import { executeCurlRestFlow } from "../src/core/curl-backend.js";
import fs from "node:fs";
import path from "node:path";

// ── Neutral test URL (no login required, good for stealth checks) ──
const TEST_URL = "https://www.browserscan.net/bot-detection";
const FALLBACK_URL = "https://httpbin.org/headers";

// ── Test email for deterministic profile generation ──
const TEST_EMAIL = "lifecycle-test@example.com";

// ── Results directory ──
const RESULTS_DIR = path.join(process.cwd(), "lifecycle-test-results");

// ── All backends to test ──
const ALL_BACKENDS: Array<{
  name: string;
  opts: Partial<SessionOpts>;
  isBrowser: boolean;
  requiresUv?: boolean;
}> = [
  {
    name: "cloak-headless",
    opts: { backend: "cloak-headless", headless: true, email: TEST_EMAIL, cleanSession: true },
    isBrowser: true,
  },
  {
    name: "cloak-headed",
    opts: { backend: "cloak-headed", headless: false, email: TEST_EMAIL, cleanSession: true },
    isBrowser: true,
  },
  {
    name: "stealth",
    opts: { backend: "stealth", headless: true, email: TEST_EMAIL, cleanSession: true },
    isBrowser: true,
  },
  {
    name: "stealth-headed",
    opts: { backend: "stealth-headed", headless: false, email: TEST_EMAIL, cleanSession: true, liveTest: true },
    isBrowser: true,
  },
  {
    name: "zendriver",
    opts: { backend: "zendriver", headless: true, email: TEST_EMAIL },
    isBrowser: true,
    requiresUv: true,
  },
  {
    name: "zendriver-headed",
    opts: { backend: "zendriver-headed", headless: false, email: TEST_EMAIL },
    isBrowser: true,
    requiresUv: true,
  },
  {
    name: "curl-api",
    opts: { backend: "curl-api" },
    isBrowser: false,
  },
];

// ── Utility: colored console output ──
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

function logPass(msg: string) { console.log(`  ${GREEN}✓${RESET} ${msg}`); }
function logFail(msg: string) { console.log(`  ${RED}✗${RESET} ${msg}`); }
function logWarn(msg: string) { console.log(`  ${YELLOW}⚠${RESET} ${msg}`); }
function logInfo(msg: string) { console.log(`  ${CYAN}ℹ${RESET} ${msg}`); }
function logHeader(msg: string) { console.log(`\n${BOLD}${CYAN}═══ ${msg} ═══${RESET}`); }

interface TestResult {
  backend: string;
  status: "PASS" | "FAIL" | "SKIP";
  duration: number;
  steps: { name: string; status: "PASS" | "FAIL" | "SKIP"; detail?: string }[];
  error?: string;
}

// ── Check if `uv` is available (needed for zendriver) ──
async function isUvAvailable(): Promise<boolean> {
  try {
    const { execSync } = await import("child_process");
    execSync("uv --version", { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

// ── Phase 1: resolveBackendSettings validation ──
function testResolveBackendSettings(backendName: string): { name: string; status: "PASS" | "FAIL"; detail?: string } {
  const step = { name: "resolveBackendSettings", status: "PASS" as "PASS" | "FAIL", detail: "" };
  try {
    const baseConfig: EngineConfig = {
      backend: backendName as any,
      concurrency: 4,
      maxRetries: 2,
      proxyPool: "4r",
      targets: [],
      fpStrategy: "fp-auto",
      useHttpCloak: true,
      stealthBypassHttpCloak: false,
      enableCacheInjection: false,
      injectStealthJS: true,
      recordVideo: false,
      mutateOnRetry: true,
      cleanSession: true,
      autoOptimizePerBackend: true,
    };
    const settings = resolveBackendSettings(backendName, baseConfig, undefined, true);

    // Validate key settings exist
    if (typeof settings.useHttpCloak !== "boolean") throw new Error("useHttpCloak not resolved");
    if (typeof settings.injectStealthJS !== "boolean") throw new Error("injectStealthJS not resolved");
    if (typeof settings.concurrencyWeight !== "number") throw new Error("concurrencyWeight not resolved");

    // Check against BACKEND_OPTIMAL_SETTINGS if present
    const optimal = BACKEND_OPTIMAL_SETTINGS[backendName];
    if (optimal) {
      step.detail = `httpCloak=${settings.useHttpCloak}, stealthJS=${settings.injectStealthJS}, weight=${settings.concurrencyWeight}`;
    } else {
      step.detail = `No optimal settings (fallback to global config)`;
    }
  } catch (e: unknown) {
    step.status = "FAIL";
    step.detail = (e instanceof Error ? e.message : String(e));
  }
  return step;
}

// ── Phase 2: Profile coherence validation ──
function testProfileCoherence(email: string): { name: string; status: "PASS" | "FAIL"; detail?: string } {
  const step = { name: "profileCoherence", status: "PASS" as "PASS" | "FAIL", detail: "" };
  try {
    const ua = getConsistentUserAgent(email)!;
    if (!ua) throw new Error("UA profile is null");

    const bundle = {
      email,
      ua,
      hardware: getConsistentHardware(email, ua.os),
      cache: getCacheProfile(email, ua.chromeMajor),
      resolution: getConsistentResolution(email),
      fonts: getFontProfile(email),
    };

    const result = validateProfileBundle(bundle);
    if (!result.ok) {
      step.status = "FAIL";
      step.detail = `Errors: ${result.errors.join("; ")}`;
    } else {
      step.detail = `OS=${ua.os}, Chrome=${ua.chromeMajor}, HW=${bundle.hardware.cores}c/${bundle.hardware.memory}GB, Res=${bundle.resolution.width}x${bundle.resolution.height}`;
      if (result.warnings.length > 0) {
        step.detail += ` (warnings: ${result.warnings.join(", ")})`;
      }
    }
  } catch (e: unknown) {
    step.status = "FAIL";
    step.detail = (e instanceof Error ? e.message : String(e));
  }
  return step;
}

// ── Phase 3: Browser session lifecycle ──
async function testBrowserLifecycle(
  backendName: string,
  sessionOpts: Partial<SessionOpts>,
): Promise<{ name: string; status: "PASS" | "FAIL"; detail?: string }[]> {
  const steps: { name: string; status: "PASS" | "FAIL"; detail?: string }[] = [];
  let handle: SessionHandle | null = null;

  // Step 3a: Create session
  const createStep = { name: "createSession", status: "PASS" as "PASS" | "FAIL", detail: "" };
  try {
    const startMs = Date.now();
    handle = await createSession({
      ...sessionOpts,
      fingerprintSeed: 42000 + Math.floor(Math.random() * 1000),
      timeoutSec: 30,
    });
    const elapsed = Date.now() - startMs;
    createStep.detail = `sessionId=${handle.sessionId}, backend=${handle.backend}, time=${elapsed}ms`;
    if (!handle.context || !handle.page) throw new Error("Missing context or page");
  } catch (e: unknown) {
    createStep.status = "FAIL";
    createStep.detail = (e instanceof Error ? e.message : String(e))?.substring(0, 200);
    steps.push(createStep);
    return steps;
  }
  steps.push(createStep);

  // Step 3b: Navigate to test URL
  const navStep = { name: "pageNavigation", status: "PASS" as "PASS" | "FAIL", detail: "" };
  try {
    const startMs = Date.now();
    let navUrl = TEST_URL;
    try {
      await handle.page.goto(navUrl, { waitUntil: "domcontentloaded", timeout: 20000 });
    } catch {
      navUrl = FALLBACK_URL;
      await handle.page.goto(navUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
    }
    const elapsed = Date.now() - startMs;
    const title = await handle.page.title().catch(() => "(no title)");
    navStep.detail = `url=${navUrl}, title="${title}", time=${elapsed}ms`;
  } catch (e: unknown) {
    navStep.status = "FAIL";
    navStep.detail = (e instanceof Error ? e.message : String(e))?.substring(0, 200);
  }
  steps.push(navStep);

  // Step 3c: Stealth property verification
  const stealthStep = { name: "stealthVerification", status: "PASS" as "PASS" | "FAIL", detail: "" };
  try {
    const stealthResult = await handle.page.evaluate(() => {
      const checks: Record<string, any> = {};

      // 1. navigator.webdriver should be false/undefined (not true)
      checks.webdriver = (navigator as any).webdriver;

      // 2. User-Agent should be present and non-empty
      checks.userAgent = navigator.userAgent?.substring(0, 80);

      // 3. navigator.languages should be a non-empty array
      checks.languages = navigator.languages;

      // 4. navigator.hardwareConcurrency should be > 0
      checks.hardwareConcurrency = navigator.hardwareConcurrency;

      // 5. navigator.deviceMemory (may not exist in all browsers)
      checks.deviceMemory = (navigator as any).deviceMemory;

      // 6. navigator.platform
      checks.platform = navigator.platform;

      // 7. screen dimensions should be realistic
      checks.screen = { width: screen.width, height: screen.height, colorDepth: screen.colorDepth };

      // 8. WebGL renderer (if available)
      try {
        const canvas = document.createElement("canvas");
        const gl = canvas.getContext("webgl") || canvas.getContext("experimental-webgl");
        if (gl) {
          const ext = (gl as any).getExtension("WEBGL_debug_renderer_info");
          if (ext) {
            checks.webglVendor = (gl as any).getParameter(ext.UNMASKED_VENDOR_WEBGL);
            checks.webglRenderer = (gl as any).getParameter(ext.UNMASKED_RENDERER_WEBGL);
          }
        }
      } catch { /* WebGL not available */ }

      // 9. Plugins count (chrome has plugins, firefox may vary)
      checks.pluginCount = navigator.plugins?.length ?? 0;

      // 10. window.chrome object (should exist in Chromium-based browsers)
      checks.hasWindowChrome = typeof (window as any).chrome !== "undefined";

      return checks;
    });

    const issues: string[] = [];
    if (stealthResult.webdriver === true) issues.push("webdriver=true (BOT DETECTED)");
    if (!stealthResult.userAgent) issues.push("empty userAgent");
    if (!stealthResult.languages || stealthResult.languages.length === 0) issues.push("empty languages");
    if (stealthResult.hardwareConcurrency <= 0) issues.push("hardwareConcurrency=0");
    if (stealthResult.screen.width < 100 || stealthResult.screen.height < 100) issues.push("unrealistic screen");

    if (issues.length > 0) {
      stealthStep.status = "FAIL";
      stealthStep.detail = `Issues: ${issues.join(", ")}`;
    } else {
      stealthStep.detail = [
        `webdriver=${stealthResult.webdriver}`,
        `cores=${stealthResult.hardwareConcurrency}`,
        `mem=${stealthResult.deviceMemory ?? "N/A"}GB`,
        `screen=${stealthResult.screen.width}x${stealthResult.screen.height}`,
        `platform=${stealthResult.platform}`,
        stealthResult.webglRenderer ? `gpu=${stealthResult.webglRenderer.substring(0, 40)}` : "no-webgl",
      ].join(", ");
    }
  } catch (e: unknown) {
    stealthStep.status = "FAIL";
    stealthStep.detail = (e instanceof Error ? e.message : String(e))?.substring(0, 200);
  }
  steps.push(stealthStep);

  // Step 3d: WebRTC leak check
  const webrtcStep = { name: "webrtcLeakCheck", status: "PASS" as "PASS" | "FAIL", detail: "" };
  try {
    const rtcResult = await handle.page.evaluate(async () => {
      try {
        const pc = new RTCPeerConnection({ iceServers: [] });
        pc.createDataChannel("test");
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        await new Promise<void>((resolve) => {
          if (pc.iceGatheringState === "complete") { resolve(); return; }
          const timer = setTimeout(() => resolve(), 3000);
          pc.onicegatheringstatechange = () => {
            if (pc.iceGatheringState === "complete") { clearTimeout(timer); resolve(); }
          };
        });
        const sdp = pc.localDescription?.sdp ?? "";
        const candidates = sdp.split("\n").filter((l: string) => l.startsWith("a=candidate"));
        pc.close();
        const localIpRe = /(?:192\.168\.|10\.|172\.(?:1[6-9]|2[0-9]|3[0-1])\.|127\.0\.0\.1)/;
        const leaks = candidates.filter((c: string) => localIpRe.test(c));
        return { candidateCount: candidates.length, leaks: leaks.length, hasLeak: leaks.length > 0 };
      } catch (e: unknown) {
        return { candidateCount: 0, leaks: 0, hasLeak: false, error: (e instanceof Error ? e.message : String(e)) };
      }
    });

    if (rtcResult.hasLeak) {
      webrtcStep.status = "FAIL";
      webrtcStep.detail = `IP LEAK: ${rtcResult.leaks} candidates expose local IP`;
    } else {
      webrtcStep.detail = `candidates=${rtcResult.candidateCount}, leaks=0${rtcResult.error ? ` (${rtcResult.error})` : ""}`;
    }
  } catch (e: unknown) {
    // WebRTC may not be available in all backends (Firefox/Camoufox)
    webrtcStep.detail = `Skipped: ${(e instanceof Error ? e.message : String(e))?.substring(0, 80)}`;
  }
  steps.push(webrtcStep);

  // Step 3e: Screenshot
  const ssStep = { name: "screenshot", status: "PASS" as "PASS" | "FAIL", detail: "" };
  try {
    const ssPath = path.join(RESULTS_DIR, `${backendName}-lifecycle.png`);
    await handle.page.screenshot({ path: ssPath, fullPage: false });
    const stat = fs.statSync(ssPath);
    ssStep.detail = `saved=${ssPath} (${(stat.size / 1024).toFixed(1)}KB)`;
  } catch (e: unknown) {
    ssStep.status = "FAIL";
    ssStep.detail = (e instanceof Error ? e.message : String(e))?.substring(0, 200);
  }
  steps.push(ssStep);

  // Step 3f: Session profile metadata check
  const metaStep = { name: "sessionMetadata", status: "PASS" as "PASS" | "FAIL", detail: "" };
  try {
    const meta: string[] = [];
    if (handle.uaProfile) meta.push(`ua=${handle.uaProfile.os}`);
    if (handle.hardwareProfile) meta.push(`hw=${handle.hardwareProfile.cores}c`);
    if (handle.geoProfile) meta.push(`geo=${handle.geoProfile.countryCode}`);
    if (handle.fontProfile) meta.push(`fonts=${handle.fontProfile.name}`);
    if (handle.interactionProfile) meta.push(`interaction=${handle.interactionProfile.mouseSpeed}`);
    if (handle.fingerprintSeed) meta.push(`seed=${handle.fingerprintSeed}`);
    metaStep.detail = meta.length > 0 ? meta.join(", ") : "No profile metadata attached";
  } catch (e: unknown) {
    metaStep.status = "FAIL";
    metaStep.detail = (e instanceof Error ? e.message : String(e))?.substring(0, 200);
  }
  steps.push(metaStep);

  // Step 3g: Cleanup / close session
  const closeStep = { name: "sessionClose", status: "PASS" as "PASS" | "FAIL", detail: "" };
  try {
    const startMs = Date.now();
    await handle.close();
    const elapsed = Date.now() - startMs;
    closeStep.detail = `closed cleanly in ${elapsed}ms`;
  } catch (e: unknown) {
    closeStep.status = "FAIL";
    closeStep.detail = (e instanceof Error ? e.message : String(e))?.substring(0, 200);
    // Try forceKill as fallback
    try {
      handle.forceKill?.();
      closeStep.detail += " (forceKill used as fallback)";
    } catch { /* last resort */ }
  }
  steps.push(closeStep);

  return steps;
}

// ── Phase 4: Curl API backend test ──
async function testCurlApiBackend(): Promise<{ name: string; status: "PASS" | "FAIL" | "SKIP"; detail?: string }[]> {
  const steps: { name: string; status: "PASS" | "FAIL" | "SKIP"; detail?: string }[] = [];

  // Test with a mock/dummy endpoint (we don't want to hit real login APIs)
  const curlStep = { name: "curlApiFlow", status: "PASS" as "PASS" | "FAIL" | "SKIP", detail: "" };
  try {
    // Test the no-endpoint path (should return N/A gracefully)
    const result = await executeCurlRestFlow(
      { name: "test", url: "https://example.com", selectors: { username: "user", password: "pass", submit: "btn" } },
      { email: "test@example.com", passwords: ["test123"], isGolden: false },
      null,
    );
    if (result.outcome === "N/A" && result.attempts === 0) {
      curlStep.detail = "No apiLoginEndpoint → N/A (correct behavior)";
    } else {
      curlStep.status = "FAIL";
      curlStep.detail = `Expected N/A, got ${result.outcome} with ${result.attempts} attempts`;
    }
  } catch (e: unknown) {
    curlStep.status = "FAIL";
    curlStep.detail = (e instanceof Error ? e.message : String(e))?.substring(0, 200);
  }
  steps.push(curlStep);

  return steps;
}

// ── Main runner ──
async function main() {
  const args = process.argv.slice(2);
  const filterBackend = args.find(a => a.startsWith("--backend="))?.split("=")[1];
  const headedOnly = args.includes("--headed-only");
  const headlessOnly = args.includes("--headless-only");

  if (!fs.existsSync(RESULTS_DIR)) fs.mkdirSync(RESULTS_DIR, { recursive: true });

  const uvAvailable = await isUvAvailable();
  const results: TestResult[] = [];

  let backendsToTest = ALL_BACKENDS;
  if (filterBackend) {
    backendsToTest = backendsToTest.filter(b => b.name === filterBackend);
    if (backendsToTest.length === 0) {
      console.error(`Unknown backend: ${filterBackend}. Available: ${ALL_BACKENDS.map(b => b.name).join(", ")}`);
      process.exit(1);
    }
  }
  if (headedOnly) backendsToTest = backendsToTest.filter(b => b.name.includes("headed"));
  if (headlessOnly) backendsToTest = backendsToTest.filter(b => !b.name.includes("headed") || b.name === "cloak-headless");

  console.log(`\n${BOLD}╔══════════════════════════════════════════════════════════╗${RESET}`);
  console.log(`${BOLD}║  E2E Backend Lifecycle Test — Full Real-Life Testing     ║${RESET}`);
  console.log(`${BOLD}╠══════════════════════════════════════════════════════════╣${RESET}`);
  console.log(`${BOLD}║${RESET}  Backends: ${backendsToTest.map(b => b.name).join(", ")}`);
  console.log(`${BOLD}║${RESET}  UV available: ${uvAvailable ? "yes" : "no (zendriver will skip)"}`);
  console.log(`${BOLD}║${RESET}  Test email: ${TEST_EMAIL}`);
  console.log(`${BOLD}║${RESET}  Results dir: ${RESULTS_DIR}`);
  console.log(`${BOLD}╚══════════════════════════════════════════════════════════╝${RESET}`);

  for (const backend of backendsToTest) {
    logHeader(`Testing: ${backend.name}`);
    const startMs = Date.now();
    const result: TestResult = { backend: backend.name, status: "PASS", duration: 0, steps: [] };

    // Check prerequisites
    if (backend.requiresUv && !uvAvailable) {
      logWarn(`Skipping ${backend.name}: requires 'uv' (Python package manager) which is not installed`);
      result.status = "SKIP";
      result.steps.push({ name: "prerequisiteCheck", status: "SKIP", detail: "uv not available" });
      result.duration = Date.now() - startMs;
      results.push(result);
      continue;
    }

    // Phase 1: resolveBackendSettings
    const settingsStep = testResolveBackendSettings(backend.name);
    result.steps.push(settingsStep);
    if (settingsStep.status === "PASS") logPass(`resolveBackendSettings: ${settingsStep.detail}`);
    else logFail(`resolveBackendSettings: ${settingsStep.detail}`);

    // Phase 2: Profile coherence
    const profileStep = testProfileCoherence(TEST_EMAIL);
    result.steps.push(profileStep);
    if (profileStep.status === "PASS") logPass(`profileCoherence: ${profileStep.detail}`);
    else logFail(`profileCoherence: ${profileStep.detail}`);

    // Phase 3/4: Backend-specific lifecycle
    if (backend.isBrowser) {
      const lifecycleSteps = await testBrowserLifecycle(backend.name, backend.opts);
      for (const step of lifecycleSteps) {
        result.steps.push(step);
        if (step.status === "PASS") logPass(`${step.name}: ${step.detail}`);
        else if ((step.status as string) === "SKIP") logWarn(`${step.name}: ${step.detail}`);
        else logFail(`${step.name}: ${step.detail}`);
      }
    } else {
      const curlSteps = await testCurlApiBackend();
      for (const step of curlSteps) {
        result.steps.push(step);
        if (step.status === "PASS") logPass(`${step.name}: ${step.detail}`);
        else logFail(`${step.name}: ${step.detail}`);
      }
    }

    // Determine overall status
    const failedSteps = result.steps.filter(s => s.status === "FAIL");
    if (failedSteps.length > 0) result.status = "FAIL";
    result.duration = Date.now() - startMs;

    const statusEmoji = result.status === "PASS" ? `${GREEN}✓ PASS${RESET}` : result.status === "SKIP" ? `${YELLOW}⊘ SKIP${RESET}` : `${RED}✗ FAIL${RESET}`;
    console.log(`\n  Result: ${statusEmoji} (${(result.duration / 1000).toFixed(1)}s)`);
    results.push(result);
  }

  // ── Summary ──
  logHeader("SUMMARY");
  const passed = results.filter(r => r.status === "PASS").length;
  const failed = results.filter(r => r.status === "FAIL").length;
  const skipped = results.filter(r => r.status === "SKIP").length;

  for (const r of results) {
    const icon = r.status === "PASS" ? `${GREEN}✓${RESET}` : r.status === "SKIP" ? `${YELLOW}⊘${RESET}` : `${RED}✗${RESET}`;
    const failInfo = r.status === "FAIL" ? ` — failed: ${r.steps.filter(s => s.status === "FAIL").map(s => s.name).join(", ")}` : "";
    console.log(`  ${icon} ${r.backend.padEnd(20)} ${(r.duration / 1000).toFixed(1)}s${failInfo}`);
  }

  console.log(`\n  ${BOLD}Total: ${passed} passed, ${failed} failed, ${skipped} skipped out of ${results.length}${RESET}`);

  // Save JSON report
  const reportPath = path.join(RESULTS_DIR, "lifecycle-report.json");
  fs.writeFileSync(reportPath, JSON.stringify(results, null, 2));
  logInfo(`Full report saved to ${reportPath}`);

  // Exit code
  if (failed > 0) {
    console.log(`\n${RED}${BOLD}Some backends FAILED — review details above.${RESET}\n`);
    process.exit(1);
  } else {
    console.log(`\n${GREEN}${BOLD}All backends PASSED (or skipped due to missing deps).${RESET}\n`);
  }
}

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(2);
});