/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unused-expressions, @typescript-eslint/no-unused-vars, @typescript-eslint/require-await , @typescript-eslint/no-misused-promises, @typescript-eslint/ban-ts-comment, no-useless-assignment, @typescript-eslint/restrict-template-expressions, no-unassigned-vars, preserve-caught-error, @typescript-eslint/no-require-imports*/
import "dotenv/config";
import { execSync } from "child_process";
import { ConfigStore, type AppConfig } from "../../src/core/config-store.js";
import { createSession, pickProxy, type SessionHandle, type SessionOpts } from "../../backends/index.js";
import { BrowserTiler } from "../../src/services/browser-tiler.js";
import { type Page } from "playwright-core";
import fs from "fs";
import path from "path";
import { installEarlyRememberMeHook, universalLoginFlow } from "../../src/targets/universal-login.js";
import { CookieGuard } from "../../src/guards/cookie-guard.js";
import { loadPrivateGoldenCredential } from "../../src/services/private-golden-credentials.js";

// Guard against Playwright's FFBrowserContext crash (known bug with Camoufox)
process.on("uncaughtException", (err) => {
  if (err instanceof TypeError && err.message.includes("reading 'url'") && err.stack?.includes("FFBrowserContext")) {
    console.warn("[TILE] ⚠ Swallowed Playwright FFBrowserContext pageError crash");
    return;
  }
  console.error("[TILE] Uncaught exception:", err);
  process.exit(1);
});

// Added CLI parsing for --targets
const args = process.argv.slice(2);
const targetsArg = args.find(a => a.startsWith('--targets='))?.split('=')[1] || 'joe,ignition';
const testTargets = targetsArg.split(',').map(t => t.trim().toLowerCase());

const JOE_URL = "https://www.joefortune.zone/login";
const IGNITION_URL = "https://www.ignitioncasino.ooo/login";
const joeGolden = loadPrivateGoldenCredential("joe");
const ignitionGolden = loadPrivateGoldenCredential("ignition");
const JOE_EMAIL = joeGolden.email;
const JOE_PASSWORD = joeGolden.password;
const IGNITION_EMAIL = ignitionGolden.email;
const IGNITION_PASSWORD = ignitionGolden.password;
const TIMEOUT_MS = 90000;

const appConfig: AppConfig = ConfigStore.load();
process.env.SPIDER_LOCAL_API_KEY = "dummy_key_for_test";

function nukeAllBrowsers(): void {
  if (process.platform === "win32") {
    try { execSync(`taskkill /F /IM camoufox.exe /T`, { stdio: "ignore", timeout: 5000 }); } catch {}
    try { execSync(`taskkill /F /IM chrome.exe /T`, { stdio: "ignore", timeout: 5000 }); } catch {}
  } else {
    try { execSync(`pkill -9 -f camoufox`, { stdio: "ignore", timeout: 5000 }); } catch {}
    try { execSync(`pkill -9 -f chrome`, { stdio: "ignore", timeout: 5000 }); } catch {}
  }
}

/**
 * SPA-aware success detector. * banner appears while the URL may still be /login for a brief period.
 * This function polls for EITHER signal:
 *   Signal A: URL navigates away from /login */
async function waitForLoginSuccess(page: Page, backend: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  
  while (Date.now() < deadline) {
    // Signal A: URL changed away from /login
    const currentUrl = page.url().toLowerCase();
    if (!currentUrl.includes("/login")) {
      console.log(`[${backend}] ✅ Success: URL navigated to ${page.url()}`);
      return;
    }
    
    
    
    // Signal C: Login form has vanished (SPA unmount)
    const formGone = await page.evaluate(() => {
      const user = document.querySelector('#username') || document.querySelector('input[type="email"]');
      const pass = document.querySelector('#password') || document.querySelector('input[type="password"]');
      return !user && !pass;
    }).catch(() => false);
    
    if (formGone) {
      console.log(`[${backend}] ✅ Success: Login form removed from DOM`);
      return;
    }
    
    // Signal D: Error detected — fail fast
    const hasError = await page.evaluate(() => {
      const body = document.body?.innerText?.toLowerCase() || "";
      return body.includes("incorrect") || 
             body.includes("invalid") || 
             body.includes("wrong password") ||
             body.includes("disabled") ||
             body.includes("locked") ||
             body.includes("too many") ||
             body.includes("no account") ||
             body.includes("not found");
    }).catch(() => false);
    
    if (hasError) {
      throw new Error("Login returned incorrect credentials error");
    }
    
    await new Promise(r => setTimeout(r, 500));
  }
  
  await page.screenshot({ path: `failure-${backend}-${Date.now()}.png`, fullPage: true }).catch(() => {});
  throw new Error(`Login success not detected within ${timeoutMs}ms`);
}

async function runGoldenFlow(backend: string, targetName: string = "joe", proxyPool?: string): Promise<SessionHandle> {
  const email = targetName === "ignition" ? IGNITION_EMAIL : JOE_EMAIL;
  const proxy = pickProxy([], email, backend, proxyPool || appConfig.proxyPool);

  const opts: SessionOpts = {
    backend: backend as any,
    headless: false, // Force headed for tiling
    liveTest: true,
    proxy,
    email,
    cleanSession: true,
    recordVideo: false,
    useHttpCloak: appConfig.useHttpCloak,
    stealthBypassHttpCloak: appConfig.stealthBypassHttpCloak,
    injectStealthJS: appConfig.injectStealthJS,
    proxyPool: proxyPool || appConfig.proxyPool,
  };

  const handle = await createSession(opts);
  const page = handle.page;
  const ctx = handle.context;
  
  if (ctx) {
    ctx.setDefaultTimeout(TIMEOUT_MS);
    ctx.setDefaultNavigationTimeout(TIMEOUT_MS);
  } else {
    page.setDefaultTimeout(TIMEOUT_MS);
    page.setDefaultNavigationTimeout(TIMEOUT_MS);
  }

  const urlsToTry = targetName === "ignition" 
    ? [IGNITION_URL, "https://www.ignitioncasino.com/login"] 
    : [JOE_URL];

  // CookieGuard speed layer replaces installEarlyCookieDismissHook
  const cookieGuard = new CookieGuard(page, {
    formSelectors: { username: 'input[type="email"]', password: 'input[type="password"]' },
    siteName: targetName,
    maxWaitMs: 15000,
  });
  await cookieGuard.install();
  await installEarlyRememberMeHook(page);

  console.log(`[${backend}] Navigating to demo.fingerprint.com/playground to capture suspect score...`);
  let suspectScore: number | string = "N/A";
  try {
    await page.goto("https://demo.fingerprint.com/playground", { waitUntil: "domcontentloaded", timeout: 20000 }).catch(async () => {
      await page.goto("https://demo.fingerprint.com/playground", { waitUntil: "domcontentloaded", timeout: 20000 });
    });
    await page.waitForFunction(
      () => (document.body.innerText || '').match(/suspect\s*score/i),
      { timeout: 10000 }
    ).catch(() => {});
    const allText: string = await page.evaluate("document.body.innerText || ''");
    const match = allText.match(/Suspect Score[:\s]*(\d+)/i) || allText.match(/suspect_score:\s*(\d+)/i);
    if (match) {
      suspectScore = parseInt(match[1] ?? '0');
    }
  } catch (e: any) {
    console.warn(`[${backend}] Failed to capture suspect score: ${e.message}`);
  }
  
  console.log(`[${backend}] 🔍 Suspect Score: ${suspectScore}`);

  console.log(`[${backend}] Navigating to ${urlsToTry[0]}...`);
  
  // Navigate with retry to handle transient DNS/proxy failures
  let navOk = false;
  for (const url of urlsToTry) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(async () => {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
      });
      await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
      navOk = true;
      break;
    } catch (e: any) {
      console.log(`[${backend}] Navigation to ${url} failed: ${e.message.slice(0, 100)}`);
    }
  }
  
  if (!navOk) {
    throw new Error("All navigation URLs failed");
  }
  
  console.log(`[${backend}] Starting universalLoginFlow...`);
  
  const result = await universalLoginFlow({
    page,
    siteName: targetName as "joe" | "ignition",
    targetEmail: email,
    password: targetName === "ignition" ? IGNITION_PASSWORD : JOE_PASSWORD,
    attemptIdx: 0,
    selectors: { username: "dummy", password: "dummy", submit: "dummy" },
    inputText: async () => true, // Dummy, backend won't use it in benchmark-direct mode
    viewport: { width: 1280, height: 800 },
    mode: "benchmark-direct"
  });

  if (!result.success) {
    throw new Error(`Login success not detected (networkVerdict: ${result.networkVerdict})`);
  }
  
  // Use SPA-aware success detection
  await waitForLoginSuccess(page, backend, TIMEOUT_MS);
  
  if (targetName === "joe") {
    console.log(`[${backend}] ✅ Joe Fortune logged in successfully. Immediately navigating to Ignition...`);
    const igUrl = "https://www.ignitioncasino.ooo/login";
    try {
      await page.goto(igUrl, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(async () => {
        await page.goto(igUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
      });
      await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
      
      console.log(`[${backend}] Starting universalLoginFlow for ignition...`);
      const igResult = await universalLoginFlow({
        page,
        siteName: "ignition",
        targetEmail: IGNITION_EMAIL,
        password: IGNITION_PASSWORD,
        attemptIdx: 0,
        selectors: { username: "dummy", password: "dummy", submit: "dummy" },
        inputText: async () => true,
        viewport: { width: 1280, height: 800 },
        mode: "benchmark-direct"
      });
      
      if (!igResult.success) {
        throw new Error(`Ignition login success not detected (networkVerdict: ${igResult.networkVerdict})`);
      }
      
      await waitForLoginSuccess(page, backend, TIMEOUT_MS);
      console.log(`[${backend}] ✅ Ignition logged in successfully after Joe.`);
    } catch (e: any) {
      console.warn(`[${backend}] ❌ Failed to login to Ignition after Joe: ${e.message}`);
      throw e;
    }
  }
  
  return handle;
}

/**
 * Capture each browser's page screenshot and composite into a 2x2 grid.
 * Uses Playwright page.screenshot() (works regardless of Windows session).
 * Composites by reusing one of the already-open Chromium browsers to render
 * an HTML grid page — avoids needing standard Playwright browsers installed.
 */
async function captureAndCompositeTiledScreenshot(
  handlePairs: { handle: SessionHandle; backend: string }[],
  outputPath: string
): Promise<void> {
  console.log(`Capturing individual page screenshots from ${handlePairs.length} browsers...`);
  const screenshotDir = path.resolve(process.cwd(), "tile-screenshots");
  if (!fs.existsSync(screenshotDir)) fs.mkdirSync(screenshotDir, { recursive: true });

  const screenshotPaths: string[] = [];
  const labels: string[] = [];
  for (const { handle, backend } of handlePairs) {
    const ssPath = path.join(screenshotDir, `${backend}.png`);
    try {
      await handle.page.screenshot({ path: ssPath, fullPage: false });
      screenshotPaths.push(ssPath);
      labels.push(backend);
      console.log(`  📸 ${backend}: captured`);
    } catch (e: any) {
      console.warn(`  ⚠️ ${backend}: screenshot failed — ${e.message.slice(0, 80)}`);
    }
  }

  // Find a Chromium-based handle to reuse for the composite rendering
  // (stealth is Camoufox/Firefox — skip it, use cloak/spider/zendriver)
  const chromiumHandle = handlePairs.find(h =>
    !h.backend.includes("stealth")
  );

  if (!chromiumHandle) {
    console.log(`No Chromium handle available for composite. Individual screenshots saved to ${screenshotDir}`);
    return;
  }

  try {
    // Open a new page in the existing browser context
    const ctx = chromiumHandle.handle.context || chromiumHandle.handle.page.context();
    const compositePage = await ctx.newPage();
    await compositePage.setViewportSize({ width: 1920, height: 1080 });

    // Build HTML with embedded base64 images
    const imgTags = screenshotPaths.map((p, i) => {
      const b64 = fs.readFileSync(p).toString("base64");
      const label = labels[i] || `backend-${i}`;
      return `<div class="tile">
        <div class="label">✅ ${label} — LOGGED IN</div>
        <img src="data:image/png;base64,${b64}" />
      </div>`;
    }).join("\n");

    const html = `<!DOCTYPE html>
<html><head><style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: #1a1a2e; display: grid; grid-template-columns: 1fr 1fr 1fr 1fr; grid-template-rows: 1fr; width: 1920px; height: 1080px; }
  .tile { position: relative; overflow: hidden; }
  .tile img { width: 100%; height: 100%; object-fit: cover; }
  .label { position: absolute; top: 0; left: 0; right: 0; background: rgba(0,0,0,0.7); color: #0f0; font: bold 18px monospace; padding: 8px 14px; z-index: 10; }
</style></head><body>${imgTags}</body></html>`;

    await compositePage.setContent(html, { waitUntil: "load" });
    await new Promise(r => setTimeout(r, 1000)); // Let base64 images decode
    await compositePage.screenshot({ path: outputPath, fullPage: false });
    console.log(`\n🖼️  Composite tiled screenshot saved to: ${outputPath}`);
    await compositePage.close().catch(() => {});
  } catch (e: any) {
    console.error(`Composite failed: ${e.message}. Individual screenshots are in ${screenshotDir}`);
  }
}

async function main() {
  console.log("Starting 4-backend concurrent tiling test...");
  
  const MAX_ATTEMPTS = 1;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    console.log(`\n=== TILE TEST ATTEMPT ${attempt} - VARIETY OF SITES ===\n`);
    nukeAllBrowsers();
    await new Promise(r => setTimeout(r, 3000));
    
    const backends = [
      { id: "cloak-headed", target: "joe" },
      { id: "stealth-headed", target: "bovada" },
      { id: "cloak-headed-nocloak", target: "ignition" },
      { id: "zendriver-headed", target: "slots" }
    ];
    const tiler = new BrowserTiler(4);
      
      // Stagger launches by 5 seconds each to reduce CPU contention
    const promises = backends.map(async (combo, i) => {
      const backend = combo.id;
      const targetName = combo.target;
      await new Promise(r => setTimeout(r, i * 5000));
      console.log(`[${backend}] Launching (stagger offset: ${i * 5}s) for ${targetName}...`);
      return runGoldenFlow(backend, targetName).catch(err => {
        console.error(`[${backend}] ❌ Flow Failed: ${err.message}`);
        throw err;
      });
    });
      
      const results = await Promise.allSettled(promises);
      
      let successCount = 0;
      const handles: SessionHandle[] = [];
      
      results.forEach((res, i) => {
        const combo = backends[i];
        if (res.status === "fulfilled") {
          successCount++;
          handles.push(res.value);
          console.log(`  ✅ ${combo.id}: PASS`);
        } else {
          console.log(`  ❌ ${combo.id}: FAIL — ${res.reason?.message?.slice(0, 120) || 'unknown'}`);
        }
      });
      
      console.log(`\nResult: ${successCount}/4 backends succeeded.`);
      
      if (successCount === 4) {
        console.log(`All 4 backends logged in successfully!`);
        
        // Give them a moment to render the final state
        await new Promise(r => setTimeout(r, 3000));
        
        // Build handle+backend pairs for screenshot capture
        const handlePairs: { handle: SessionHandle; backend: string }[] = [];
        for (let i = 0; i < results.length; i++) {
          if (results[i].status === 'fulfilled') {
            handlePairs.push({ handle: (results[i] as PromiseFulfilledResult<SessionHandle>).value, backend: backends[i].id });
          }
        }
        
        const screenshotPath = path.resolve(process.cwd(), `desktop-verification-variety.png`);
        await captureAndCompositeTiledScreenshot(handlePairs, screenshotPath);
        
        for (const h of handles) {
          await h.close().catch(() => {});
        }
        nukeAllBrowsers();
        console.log(`✅ Golden Tile Test completed perfectly.`);
      } else {
        console.error(`Attempt ${attempt} failed. Cleaning up...`);
        for (const h of handles) {
          await h.close().catch(() => {});
        }
        nukeAllBrowsers();
        await new Promise(r => setTimeout(r, 2000));
        
        if (attempt === MAX_ATTEMPTS) {
          console.error(`❌ Max attempts (${MAX_ATTEMPTS}) reached. Best result: ${successCount}/4.`);
          process.exit(1);
        }
      }
    }
    console.log("\n=== TILE TEST COMPLETED ===");
}

main().catch((err: any) => {
  console.error("Fatal:", err);
  nukeAllBrowsers();
  process.exit(1);
});
