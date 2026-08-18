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

process.on("uncaughtException", (err) => {
  if (err instanceof TypeError && err.message.includes("reading 'url'") && err.stack?.includes("FFBrowserContext")) {
    console.warn("[TILE] ⚠ Swallowed Playwright FFBrowserContext pageError crash");
    return;
  }
  console.error("[TILE] Uncaught exception:", err);
  process.exit(1);
});

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

async function waitForLoginSuccess(page: Page, backend: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const currentUrl = page.url().toLowerCase();
    if (!currentUrl.includes("/login")) {
      console.log(`[${backend}] ✅ Success: URL navigated to ${page.url()}`);
      return;
    }
    const hasSuccessBanner = await page.evaluate(() => {
      const alert = document.querySelector('.ol-alert__content');      const all = document.body?.innerText || "";    }).catch(() => false);
    if (hasSuccessBanner) {
      return;
    }
    const formGone = await page.evaluate(() => {
      const user = document.querySelector('#username') || document.querySelector('input[type="email"]');
      const pass = document.querySelector('#password') || document.querySelector('input[type="password"]');
      return !user && !pass;
    }).catch(() => false);
    if (formGone) {
      console.log(`[${backend}] ✅ Success: Login form removed from DOM`);
      return;
    }
    const hasError = await page.evaluate(() => {
      const body = document.body?.innerText?.toLowerCase() || "";
      return body.includes("incorrect") || body.includes("invalid") || body.includes("wrong password");
    }).catch(() => false);
    if (hasError) {
      throw new Error("Login returned incorrect credentials error");
    }
    await new Promise(r => setTimeout(r, 500));
  }
  await page.screenshot({ path: `failure-${backend}-${Date.now()}.png`, fullPage: true }).catch(() => {});
  throw new Error(`Login success not detected within ${timeoutMs}ms`);
}

async function runGoldenFlow(backend: string, targetName: string, targetUrl: string, email: string, pass: string): Promise<SessionHandle> {
  const proxy = pickProxy([], email, backend, appConfig.proxyPool);
  const opts: SessionOpts = {
    backend: backend as any,
    headless: false,
    liveTest: true,
    proxy,
    email,
    cleanSession: true,
    recordVideo: false,
    useHttpCloak: appConfig.useHttpCloak,
    stealthBypassHttpCloak: appConfig.stealthBypassHttpCloak,
    injectStealthJS: appConfig.injectStealthJS,
    proxyPool: appConfig.proxyPool,
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

  // Async Early Remember Me click hook installed BEFORE navigation
  await installEarlyRememberMeHook(page);

  console.log(`[${backend}-${targetName}] Navigating to ${targetUrl}...`);
  let navOk = false;
  for (const url of [targetUrl]) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(async () => {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
      });
      await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
      navOk = true;
      break;
    } catch (e: any) {
      console.log(`[${backend}-${targetName}] Navigation to ${url} failed: ${e.message.slice(0, 100)}`);
    }
  }
  if (!navOk) throw new Error("Navigation failed");
  
  console.log(`[${backend}-${targetName}] Starting universalLoginFlow...`);
  
  const result = await universalLoginFlow({
    page,
    siteName: targetName as "joe" | "ignition",
    targetEmail: email,
    password: pass,
    attemptIdx: 0,
    selectors: { username: "dummy", password: "dummy", submit: "dummy" },
    inputText: async () => true,
    viewport: { width: 1280, height: 800 },
    mode: "benchmark-direct"
  });

  if (!result.success) {
    throw new Error(`Login success not detected (networkVerdict: ${result.networkVerdict})`);
  }
  
  console.log(`[${backend}-${targetName}] Submitted. Waiting for success...`);
  await waitForLoginSuccess(page, backend, TIMEOUT_MS);

  // Cashier verification
  console.log(`[${backend}-${targetName}] Navigating to cashier for verification...`);
  const cashierUrl = new URL("/account/cashier/deposit/cc", new URL(targetUrl).origin).toString();
  const bounceRe = /\/(login|signin|sign-in)(\?|$|\/)/;
  let bounced = false;
  const bounceListener = (frame: any) => {
    if (frame !== page.mainFrame()) return;
    if (bounceRe.test(frame.url().toLowerCase())) bounced = true;
  };
  page.on("framenavigated", bounceListener);

  try {
    try {
      await page.goto(cashierUrl, { timeout: 20000, waitUntil: "networkidle" });
    } catch {
      console.log(`[${backend}-${targetName}] networkidle timed out, falling back to domcontentloaded`);
      try {
        await page.goto(cashierUrl, { timeout: 15000, waitUntil: "domcontentloaded" });
      } catch {
        throw new Error("Cashier navigation failed entirely");
      }
    }

    if (bounced) throw new Error("Cashier bounced to login -- session not valid");

    console.log(`[${backend}-${targetName}] Waiting for cashier DOM to settle...`);
    await page.evaluate(() => {
      return new Promise<void>((resolve) => {
        let timer: ReturnType<typeof setTimeout>;
        const SETTLE_MS = 800;
        const MAX_WAIT_MS = 8000;
        const hardDeadline = setTimeout(() => { observer.disconnect(); resolve(); }, MAX_WAIT_MS);
        const observer = new MutationObserver(() => {
          clearTimeout(timer);
          timer = setTimeout(() => { observer.disconnect(); clearTimeout(hardDeadline); resolve(); }, SETTLE_MS);
        });
        observer.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });
        timer = setTimeout(() => { observer.disconnect(); clearTimeout(hardDeadline); resolve(); }, SETTLE_MS);
      });
    }).catch(() => {});

    if (bounced) throw new Error("Cashier bounced to login after DOM settle -- session not valid");

    const finalUrl = page.url().toLowerCase();
    if (bounceRe.test(finalUrl)) {
      throw new Error("Cashier bounced to login -- session not valid");
    }
    if (finalUrl.includes("/cashier") || finalUrl.includes("/deposit") || finalUrl.includes("/account")) {
      console.log(`[${backend}-${targetName}] Cashier page loaded and DOM settled: ${page.url()}`);
    } else {
      console.log(`[${backend}-${targetName}] Cashier URL ambiguous after settle: ${page.url()}`);
    }
  } finally {
    page.off("framenavigated", bounceListener);
  }

  return handle;
}

async function captureAndCompositeTiledScreenshot(handlePairs: { handle: SessionHandle; backend: string }[], outputPath: string): Promise<void> {
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
      console.warn(`  ⚠️ ${backend}: screenshot failed`);
    }
  }
  const chromiumHandle = handlePairs.find(h => !h.backend.includes("stealth"));
  if (!chromiumHandle) return;
  try {
    const ctx = chromiumHandle.handle.context || chromiumHandle.handle.page.context();
    const compositePage = await ctx.newPage();
    await compositePage.setViewportSize({ width: 1920, height: 1080 });
    const imgTags = screenshotPaths.map((p, i) => {
      const b64 = fs.readFileSync(p).toString("base64");
      return `<div class="tile"><img src="data:image/png;base64,${b64}" /><div class="label">${labels[i] || `backend-${i}`}</div></div>`;
    }).join("");
    const html = `
      <html>
        <head><style>
          body { background: #111; color: white; font-family: monospace; padding: 20px; display: grid; grid-template-columns: repeat(4, 1fr); gap: 20px; }
          .tile { position: relative; border: 2px solid #444; border-radius: 8px; overflow: hidden; background: #222; }
          .tile img { width: 100%; height: 100%; object-fit: contain; }
          .label { position: absolute; bottom: 10px; left: 10px; background: rgba(0,0,0,0.8); padding: 5px 10px; border-radius: 4px; font-weight: bold; font-size: 18px; }
        </style></head>
        <body>${imgTags}</body>
      </html>
    `;
    await compositePage.setContent(html);
    await new Promise(r => setTimeout(r, 1000));
    await compositePage.screenshot({ path: outputPath, fullPage: true });
    console.log(`✅ Composite screenshot saved to ${outputPath}`);
    await compositePage.close().catch(() => {});
  } catch (err: any) {
    console.error("Composite failed", err.message);
  }
}

async function runTarget(targetName: string, url: string, email: string, pass: string): Promise<void> {
  console.log(`\n===========================================`);
  console.log(`🚀 STARTING TARGET: ${targetName}`);
  console.log(`===========================================\n`);
  
  const backends = ['cloak-headed', 'stealth-headed', 'cloak-headed-nocloak', 'zendriver-headed'];
  
  const MAX_ATTEMPTS = 2;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    console.log(`\n=== ${targetName} ATTEMPT ${attempt} ===\n`);
    const results = await Promise.allSettled([
      runGoldenFlow('cloak', targetName, url, email, pass).catch(e => { throw Object.assign(e, { backend: 'cloak' }) }),
      runGoldenFlow('stealth', targetName, url, email, pass).catch(e => { throw Object.assign(e, { backend: 'stealth' }) }),
      runGoldenFlow('cloak-nocloak', targetName, url, email, pass).catch(e => { throw Object.assign(e, { backend: 'cloak-nocloak' }) }),
      runGoldenFlow('zendriver', targetName, url, email, pass).catch(e => { throw Object.assign(e, { backend: 'zendriver' }) }),
    ]);
    
    let successCount = 0;
    const handles: SessionHandle[] = [];
    for (let i = 0; i < results.length; i++) {
      const res = results[i];
      if (res.status === 'fulfilled') {
        successCount++;
        handles.push(res.value);
        console.log(`  ✅ ${backends[i]}: PASS`);
      } else {
        console.log(`  ❌ ${backends[i]}: FAIL — ${res.reason?.message?.slice(0, 120) || 'unknown'}`);
      }
    }
    console.log(`\nResult for ${targetName}: ${successCount}/4 backends succeeded.`);
    
    if (successCount === 4) {
      console.log(`All 4 backends logged in successfully to ${targetName}!`);
      await new Promise(r => setTimeout(r, 3000));
      const handlePairs = [];
      for (let i = 0; i < results.length; i++) {
        if (results[i].status === 'fulfilled') {
          handlePairs.push({ handle: (results[i] as PromiseFulfilledResult<SessionHandle>).value, backend: backends[i] + '-' + targetName });
        }
      }
      const screenshotPath = path.resolve(process.cwd(), `mega-tile-${targetName}.png`);
      await captureAndCompositeTiledScreenshot(handlePairs, screenshotPath);
      for (const h of handles) await h.close().catch(() => {});
      nukeAllBrowsers();
      console.log(`✅ ${targetName} Phase completed.`);
      return; // Success
    } else {
      console.error(`Attempt ${attempt} failed. Cleaning up...`);
      for (const h of handles) await h.close().catch(() => {});
      nukeAllBrowsers();
      await new Promise(r => setTimeout(r, 2000));
      if (attempt === MAX_ATTEMPTS) {
        throw new Error(`Max attempts reached for ${targetName}. Best result: ${successCount}/4.`);
      }
    }
  }
}

async function main() {
  nukeAllBrowsers();
  
  // Phase 1: Joe Fortune
  await runTarget("JoeFortune", "https://www.joefortune.win/login", "phuttasopit@hotmail.co.th", "Tomo06032553");
  
  // Phase 2: Ignition Casino
  await runTarget("IgnitionCasino", "https://www.ignitioncasino.ooo/login", "Mattdonor@yahoo.com", "Dada0707#");
  
  console.log("\n===========================================");
  console.log("🎉 MEGA TILE TEST: ALL 8 LOGINS SUCCESSFUL!");
  console.log("===========================================\n");
}

main().catch(err => {
  console.error("Fatal:", err);
  nukeAllBrowsers();
  process.exit(1);
});
