/**
 * E2E Direct Browser Lifecycle Test
 *
 * Bypasses the full backends/index.ts import chain (which pulls in httpcloak's
 * 64MB SharedArrayBuffer — unusable when system memory is low) and tests each
 * browser engine directly:
 *
 *   - cloakbrowser  (Chromium with stealth patches)
 *   - camoufox-js   (Firefox with anti-fingerprint)
 *   - zendriver     (Python zendriver + Playwright CDP)
 *   - playwright    (vanilla Playwright Chromium baseline)
 *
 * For each browser, the test performs:
 *   1. Launch browser
 *   2. Navigate to test page
 *   3. Verify stealth properties (webdriver, UA, screen, WebGL, WebRTC)
 *   4. Take screenshot
 *   5. Clean shutdown
 *
 * Usage:
 *   npx tsx scripts/e2e-direct-browser-test.ts [--backend=<name>]
 */

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

const TEST_URL = "https://www.browserscan.net/bot-detection";
const FALLBACK_URL = "https://httpbin.org/headers";
const RESULTS_DIR = path.join(process.cwd(), "lifecycle-test-results");

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

function logPass(msg: string) { console.log(`  ${GREEN}✓${RESET} ${msg}`); }
function logFail(msg: string) { console.log(`  ${RED}✗${RESET} ${msg}`); }
function logWarn(msg: string) { console.log(`  ${YELLOW}⚠${RESET} ${msg}`); }
function logHeader(msg: string) { console.log(`\n${BOLD}${CYAN}═══ ${msg} ═══${RESET}`); }

interface StepResult {
  name: string;
  status: "PASS" | "FAIL" | "SKIP";
  detail?: string;
}

interface BackendResult {
  backend: string;
  status: "PASS" | "FAIL" | "SKIP";
  duration: number;
  steps: StepResult[];
}

if (!fs.existsSync(RESULTS_DIR)) fs.mkdirSync(RESULTS_DIR, { recursive: true });

// ── Stealth verification (runs inside browser page) ──
async function verifyStealthProps(page: any): Promise<StepResult> {
  const step: StepResult = { name: "stealthVerification", status: "PASS" };
  try {
    const r = await page.evaluate(() => {
      const c: Record<string, any> = {};
      c.webdriver = (navigator as any).webdriver;
      c.userAgent = navigator.userAgent?.substring(0, 100);
      c.languages = navigator.languages;
      c.cores = navigator.hardwareConcurrency;
      c.memory = (navigator as any).deviceMemory;
      c.platform = navigator.platform;
      c.screen = { w: screen.width, h: screen.height, depth: screen.colorDepth };
      try {
        const cv = document.createElement("canvas");
        const gl = cv.getContext("webgl") || cv.getContext("experimental-webgl");
        if (gl) {
          const ext = (gl as any).getExtension("WEBGL_debug_renderer_info");
          if (ext) {
            c.gpu = (gl as any).getParameter(ext.UNMASKED_RENDERER_WEBGL)?.substring(0, 50);
          }
        }
      } catch { /* intentional */ }
      c.plugins = navigator.plugins?.length ?? 0;
      c.chrome = typeof (window as any).chrome !== "undefined";
      return c;
    });

    const issues: string[] = [];
    if (r.webdriver === true) issues.push("webdriver=true (BOT)");
    if (!r.userAgent) issues.push("no UA");
    if (!r.languages?.length) issues.push("no languages");
    if (r.cores <= 0) issues.push("cores=0");
    if (r.screen.w < 100) issues.push("tiny screen");

    if (issues.length > 0) {
      step.status = "FAIL";
      step.detail = issues.join(", ");
    } else {
      step.detail = `webdriver=${r.webdriver}, cores=${r.cores}, mem=${r.memory ?? "?"}GB, ` +
        `screen=${r.screen.w}x${r.screen.h}, platform=${r.platform}, ` +
        `${r.gpu ? `gpu=${r.gpu}` : "no-webgl"}, chrome=${r.chrome}`;
    }
  } catch (e: unknown) {
    step.status = "FAIL";
    step.detail = (e instanceof Error ? e.message : String(e))?.substring(0, 150);
  }
  return step;
}

// ── WebRTC leak check ──
async function checkWebRtcLeak(page: any): Promise<StepResult> {
  const step: StepResult = { name: "webrtcLeakCheck", status: "PASS" };
  try {
    const r = await page.evaluate(async () => {
      try {
        const pc = new RTCPeerConnection({ iceServers: [] });
        pc.createDataChannel("t");
        const o = await pc.createOffer();
        await pc.setLocalDescription(o);
        await new Promise<void>((res) => {
          if (pc.iceGatheringState === "complete") { res(); return; }
          const t = setTimeout(() => res(), 3000);
          pc.onicegatheringstatechange = () => {
            if (pc.iceGatheringState === "complete") { clearTimeout(t); res(); }
          };
        });
        const sdp = pc.localDescription?.sdp ?? "";
        const cands = sdp.split("\n").filter((l: string) => l.startsWith("a=candidate"));
        pc.close();
        const re = /(?:192\.168\.|10\.|172\.(?:1[6-9]|2[0-9]|3[0-1])\.|127\.0\.0\.1)/;
        const leaks = cands.filter((c: string) => re.test(c));
        return { count: cands.length, leaks: leaks.length };
      } catch (e: unknown) { return { count: 0, leaks: 0, err: (e instanceof Error ? e.message : String(e)) }; }
    });
    if (r.leaks > 0) {
      step.status = "FAIL";
      step.detail = `IP LEAK: ${r.leaks}/${r.count} candidates`;
    } else {
      step.detail = `candidates=${r.count}, leaks=0${r.err ? ` (${r.err})` : ""}`;
    }
  } catch (e: unknown) {
    step.detail = `Skipped: ${(e instanceof Error ? e.message : String(e))?.substring(0, 80)}`;
  }
  return step;
}

// ── Navigate with fallback ──
async function navigateWithFallback(page: any): Promise<StepResult> {
  const step: StepResult = { name: "navigation", status: "PASS" };
  const start = Date.now();
  let url = TEST_URL;
  try {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
    } catch {
      url = FALLBACK_URL;
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });
    }
    const title = await page.title().catch(() => "(none)");
    step.detail = `url=${url}, title="${title}", ${Date.now() - start}ms`;
  } catch (e: unknown) {
    step.status = "FAIL";
    step.detail = (e instanceof Error ? e.message : String(e))?.substring(0, 150);
  }
  return step;
}

// ── Screenshot ──
async function takeScreenshot(page: any, name: string): Promise<StepResult> {
  const step: StepResult = { name: "screenshot", status: "PASS" };
  try {
    const p = path.join(RESULTS_DIR, `${name}-lifecycle.png`);
    await page.screenshot({ path: p, fullPage: false });
    const sz = fs.statSync(p).size;
    step.detail = `${p} (${(sz / 1024).toFixed(1)}KB)`;
  } catch (e: unknown) {
    step.status = "FAIL";
    step.detail = (e instanceof Error ? e.message : String(e))?.substring(0, 150);
  }
  return step;
}

// ═══════════════════════════════════════════════════════════════════
// Backend 1: CloakBrowser (Chromium with C++ stealth patches)
// ═══════════════════════════════════════════════════════════════════
async function testCloakBrowser(): Promise<BackendResult> {
  const result: BackendResult = { backend: "cloakbrowser", status: "PASS", duration: 0, steps: [] };
  const start = Date.now();

  const launchStep: StepResult = { name: "launch", status: "PASS" };
  let context: any = null;
  let page: any = null;
  try {
    const { launchPersistentContext } = await import("cloakbrowser");
    const tmpDir = path.join(RESULTS_DIR, "cloak-profile-" + Date.now());
    fs.mkdirSync(tmpDir, { recursive: true });

    context = await launchPersistentContext({
      userDataDir: tmpDir,
      headless: false,
      viewport: { width: 1280, height: 720 },
      humanize: true,
      contextOptions: { ignoreHTTPSErrors: true },
      args: [
        "--window-position=-2000,-2000",
        "--window-size=1280,720",
        "--fingerprint=42001",
        "--enforce-webrtc-ip-permission-check",
        "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
      ],
    });
    page = context.pages()[0] || await context.newPage();
    launchStep.detail = `CloakBrowser launched (pseudo-headless), pages=${context.pages().length}`;
  } catch (e: unknown) {
    launchStep.status = "FAIL";
    launchStep.detail = (e instanceof Error ? e.message : String(e))?.substring(0, 200);
    result.steps.push(launchStep);
    result.status = "FAIL";
    result.duration = Date.now() - start;
    return result;
  }
  result.steps.push(launchStep);

  result.steps.push(await navigateWithFallback(page));
  result.steps.push(await verifyStealthProps(page));
  result.steps.push(await checkWebRtcLeak(page));
  result.steps.push(await takeScreenshot(page, "cloakbrowser"));

  // Close
  const closeStep: StepResult = { name: "close", status: "PASS" };
  try {
    await context.close();
    closeStep.detail = `closed in ${Date.now() - start}ms`;
  } catch (e: unknown) {
    closeStep.status = "FAIL";
    closeStep.detail = (e instanceof Error ? e.message : String(e))?.substring(0, 150);
  }
  result.steps.push(closeStep);

  if (result.steps.some(s => s.status === "FAIL")) result.status = "FAIL";
  result.duration = Date.now() - start;
  return result;
}

// ═══════════════════════════════════════════════════════════════════
// Backend 2: Camoufox (Firefox with anti-fingerprint)
// ═══════════════════════════════════════════════════════════════════
async function testCamoufox(): Promise<BackendResult> {
  const result: BackendResult = { backend: "camoufox", status: "PASS", duration: 0, steps: [] };
  const start = Date.now();

  const launchStep: StepResult = { name: "launch", status: "PASS" };
  let browser: any = null;
  let page: any = null;
  try {
    const { Camoufox } = await import("camoufox-js");
    browser = await Camoufox({
      headless: "virtual",
      humanize: 1.5,
      geoip: false,
    });
    const ctx = browser.contexts()[0] || await browser.newContext({ ignoreHTTPSErrors: true });
    page = ctx.pages()[0] || await ctx.newPage();
    launchStep.detail = `Camoufox launched (virtual headless), contexts=${browser.contexts().length}`;
  } catch (e: unknown) {
    launchStep.status = "FAIL";
    launchStep.detail = (e instanceof Error ? e.message : String(e))?.substring(0, 200);
    result.steps.push(launchStep);
    result.status = "FAIL";
    result.duration = Date.now() - start;
    return result;
  }
  result.steps.push(launchStep);

  result.steps.push(await navigateWithFallback(page));
  result.steps.push(await verifyStealthProps(page));
  result.steps.push(await checkWebRtcLeak(page));
  result.steps.push(await takeScreenshot(page, "camoufox"));

  const closeStep: StepResult = { name: "close", status: "PASS" };
  try {
    await browser.close();
    closeStep.detail = `closed in ${Date.now() - start}ms`;
  } catch (e: unknown) {
    closeStep.status = "FAIL";
    closeStep.detail = (e instanceof Error ? e.message : String(e))?.substring(0, 150);
  }
  result.steps.push(closeStep);

  if (result.steps.some(s => s.status === "FAIL")) result.status = "FAIL";
  result.duration = Date.now() - start;
  return result;
}

// ═══════════════════════════════════════════════════════════════════
// Backend 3: Zendriver (Python + Playwright CDP)
// ═══════════════════════════════════════════════════════════════════
async function testZendriver(): Promise<BackendResult> {
  const result: BackendResult = { backend: "zendriver", status: "PASS", duration: 0, steps: [] };
  const start = Date.now();

  // Check uv availability
  let uvAvailable = false;
  try { execSync("uv --version", { stdio: "pipe" }); uvAvailable = true; } catch { /* intentional */ }
  if (!uvAvailable) {
    result.status = "SKIP";
    result.steps.push({ name: "prerequisite", status: "SKIP", detail: "uv not installed" });
    result.duration = Date.now() - start;
    return result;
  }

  const launchStep: StepResult = { name: "launch", status: "PASS" };
  let browser: any = null;
  let page: any = null;
  try {
    const { chromium } = await import("playwright-core");
    const { spawn } = await import("node:child_process");

    const pyScript = path.join(process.cwd(), "backends", "python", "zendriver_launcher.py");
    if (!fs.existsSync(pyScript)) {
      throw new Error(`Zendriver launcher not found: ${pyScript}`);
    }

    const proc = spawn("uv", ["run", pyScript], {
      cwd: process.cwd(),
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
    });

    // Send config
    proc.stdin.write(JSON.stringify({ proxy: null, userAgent: null, os: null }));
    proc.stdin.end();

    // Wait for WS endpoint
    const wsEndpoint = await new Promise<string>((resolve, reject) => {
      let buf = "";
      const timeout = setTimeout(() => { proc.kill(); reject(new Error("Zendriver timeout (30s)")); }, 30000);
      proc.stdout.on("data", (d: Buffer) => {
        buf += d.toString();
        const match = buf.match(/ZENDRIVER_WS_ENDPOINT=(ws:\/\/[^\s]+)/);
        if (match?.[1]) { clearTimeout(timeout); resolve(match[1]); }
      });
      proc.stderr.on("data", (d: Buffer) => {
        const msg = d.toString();
        if (msg.includes("ERROR") || msg.includes("Traceback")) {
          clearTimeout(timeout);
          reject(new Error(`Zendriver stderr: ${msg.substring(0, 200)}`));
        }
      });
      proc.on("exit", (code: number) => { clearTimeout(timeout); reject(new Error(`Zendriver exited with code ${code}`)); });
    });

    browser = await chromium.connectOverCDP(wsEndpoint);
    const ctx = browser.contexts()[0] || await browser.newContext();
    page = ctx.pages()[0] || await ctx.newPage();
    launchStep.detail = `Zendriver launched via CDP (${wsEndpoint.substring(0, 40)}...)`;
  } catch (e: unknown) {
    launchStep.status = "FAIL";
    launchStep.detail = (e instanceof Error ? e.message : String(e))?.substring(0, 200);
    result.steps.push(launchStep);
    result.status = "FAIL";
    result.duration = Date.now() - start;
    return result;
  }
  result.steps.push(launchStep);

  result.steps.push(await navigateWithFallback(page));
  result.steps.push(await verifyStealthProps(page));
  result.steps.push(await checkWebRtcLeak(page));
  result.steps.push(await takeScreenshot(page, "zendriver"));

  const closeStep: StepResult = { name: "close", status: "PASS" };
  try {
    await browser.close();
    closeStep.detail = `closed in ${Date.now() - start}ms`;
  } catch (e: unknown) {
    closeStep.status = "FAIL";
    closeStep.detail = (e instanceof Error ? e.message : String(e))?.substring(0, 150);
  }
  result.steps.push(closeStep);

  if (result.steps.some(s => s.status === "FAIL")) result.status = "FAIL";
  result.duration = Date.now() - start;
  return result;
}

// ═══════════════════════════════════════════════════════════════════
// Backend 4: Vanilla Playwright (baseline comparison)
// ═══════════════════════════════════════════════════════════════════
async function testPlaywright(): Promise<BackendResult> {
  const result: BackendResult = { backend: "playwright-vanilla", status: "PASS", duration: 0, steps: [] };
  const start = Date.now();

  const launchStep: StepResult = { name: "launch", status: "PASS" };
  let browser: any = null;
  let page: any = null;
  try {
    const { chromium } = await import("playwright-core");
    browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
    page = await ctx.newPage();
    launchStep.detail = `Playwright Chromium launched (headless)`;
  } catch (e: unknown) {
    launchStep.status = "FAIL";
    launchStep.detail = (e instanceof Error ? e.message : String(e))?.substring(0, 200);
    result.steps.push(launchStep);
    result.status = "FAIL";
    result.duration = Date.now() - start;
    return result;
  }
  result.steps.push(launchStep);

  result.steps.push(await navigateWithFallback(page));
  result.steps.push(await verifyStealthProps(page));
  result.steps.push(await checkWebRtcLeak(page));
  result.steps.push(await takeScreenshot(page, "playwright-vanilla"));

  const closeStep: StepResult = { name: "close", status: "PASS" };
  try {
    await browser.close();
    closeStep.detail = `closed in ${Date.now() - start}ms`;
  } catch (e: unknown) {
    closeStep.status = "FAIL";
    closeStep.detail = (e instanceof Error ? e.message : String(e))?.substring(0, 150);
  }
  result.steps.push(closeStep);

  if (result.steps.some(s => s.status === "FAIL")) result.status = "FAIL";
  result.duration = Date.now() - start;
  return result;
}

// ═══════════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════════
async function main() {
  const args = process.argv.slice(2);
  const filter = args.find(a => a.startsWith("--backend="))?.split("=")[1];

  const tests: { name: string; fn: () => Promise<BackendResult> }[] = [
    { name: "playwright-vanilla", fn: testPlaywright },
    { name: "cloakbrowser", fn: testCloakBrowser },
    { name: "camoufox", fn: testCamoufox },
    { name: "zendriver", fn: testZendriver },
  ];

  const toRun = filter ? tests.filter(t => t.name === filter) : tests;
  if (toRun.length === 0) {
    console.error(`Unknown backend: ${filter}. Available: ${tests.map(t => t.name).join(", ")}`);
    process.exit(1);
  }

  console.log(`\n${BOLD}╔══════════════════════════════════════════════════════╗${RESET}`);
  console.log(`${BOLD}║  Direct Browser E2E Lifecycle Test                    ║${RESET}`);
  console.log(`${BOLD}╠══════════════════════════════════════════════════════╣${RESET}`);
  console.log(`${BOLD}║${RESET}  Backends: ${toRun.map(t => t.name).join(", ")}`);
  console.log(`${BOLD}║${RESET}  Results: ${RESULTS_DIR}`);
  console.log(`${BOLD}╚══════════════════════════════════════════════════════╝${RESET}`);

  const results: BackendResult[] = [];

  for (const t of toRun) {
    logHeader(`Testing: ${t.name}`);
    try {
      const r = await t.fn();
      results.push(r);
      for (const s of r.steps) {
        if (s.status === "PASS") logPass(`${s.name}: ${s.detail}`);
        else if (s.status === "SKIP") logWarn(`${s.name}: ${s.detail}`);
        else logFail(`${s.name}: ${s.detail}`);
      }
      const icon = r.status === "PASS" ? `${GREEN}✓ PASS` : r.status === "SKIP" ? `${YELLOW}⊘ SKIP` : `${RED}✗ FAIL`;
      console.log(`\n  Result: ${icon}${RESET} (${(r.duration / 1000).toFixed(1)}s)`);
    } catch (e: unknown) {
      logFail(`FATAL: ${e instanceof Error ? e.message : String(e)}`);
      results.push({ backend: t.name, status: "FAIL", duration: 0, steps: [{ name: "fatal", status: "FAIL", detail: (e instanceof Error ? e.message : String(e)) }] });
    }
  }

  // Summary
  logHeader("SUMMARY");
  const passed = results.filter(r => r.status === "PASS").length;
  const failed = results.filter(r => r.status === "FAIL").length;
  const skipped = results.filter(r => r.status === "SKIP").length;

  for (const r of results) {
    const icon = r.status === "PASS" ? `${GREEN}✓${RESET}` : r.status === "SKIP" ? `${YELLOW}⊘${RESET}` : `${RED}✗${RESET}`;
    const failInfo = r.status === "FAIL" ? ` — ${r.steps.filter(s => s.status === "FAIL").map(s => s.name).join(", ")}` : "";
    console.log(`  ${icon} ${r.backend.padEnd(22)} ${(r.duration / 1000).toFixed(1)}s${failInfo}`);
  }

  console.log(`\n  ${BOLD}Total: ${passed} passed, ${failed} failed, ${skipped} skipped / ${results.length}${RESET}`);

  const report = path.join(RESULTS_DIR, "direct-browser-report.json");
  fs.writeFileSync(report, JSON.stringify(results, null, 2));
  console.log(`\n  Report: ${report}\n`);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error("Fatal:", e); process.exit(2); });