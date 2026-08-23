import { Page } from "playwright-core";
import { executeUnifiedLoginChoreography, type UnifiedChoreographyInput, type UnifiedLoginResult } from "./login-flow.js";
import { getCoordinateMap, coordinateClick } from "../intelligence/coordinate-mapper.js";

export type UniversalLoginOptions = UnifiedChoreographyInput & {
  mode: "stealth-humanized" | "benchmark-direct"; // Benchmark uses evaluate state-bypasses, stealth uses human typing
  backend?: string; // Optional backend name for logging
};
/**
 * @deprecated Use `CookieGuard` from `../guards/cookie-guard.ts` instead.
 * This legacy hook is retained only for backwards compatibility with live tests.
 * 
 * Early hook to instantly dismiss cookie banners the millisecond they appear in the DOM.
 * Executes the 3-tier cascade (API -> Click -> CSS Hide) on every DOM mutation safely.
 */
export async function installEarlyCookieDismissHook(page: Page) {
  await page.addInitScript(() => {
    // Only run heavily every 100ms to avoid thrashing CPU on mutations
    let lastRun = 0;
    const observer = new MutationObserver(() => {
      const now = Date.now();
      if (now - lastRun < 100) return;
      lastRun = now;

      try {
        // Tier 1: Native API
        try { (window as any).CookieInformation?.submitAllCategories?.(); } catch {}

        // Tier 2: UI Click
        const keywords = ["ACCEPT ALL", "Accept All", "ACCEPT", "Accept", "Got it", "Agree"];
        const cssSelectors = [".coi-banner__accept", '[data-coi-btn="accept"]', ".cookie-notice-button", ".cookie-banner-close"];

        cssSelectors.forEach(sel => {
          try {
            document.querySelectorAll(sel).forEach(el => (el as HTMLElement).click());
          } catch {}
        });

        document.querySelectorAll('button, a').forEach(btn => {
          const text = (btn as HTMLElement).innerText || "";
          if (keywords.some(k => text.includes(k))) {
            (btn as HTMLElement).click();
          }
        });

        // Tier 3: CSS Hide
        document.querySelectorAll('.coi-banner__overlay, .cookie-overlay, [class*="cookie"]').forEach(el => {
          (el as HTMLElement).style.setProperty('display', 'none', 'important');
        });
      } catch {}
    });

    // Check immediately upon load, and then observe
    observer.observe(document, { childList: true, subtree: true });

    // Initial sync run
    try {
      document.querySelectorAll('.coi-banner__overlay, .cookie-overlay, [class*="cookie"]').forEach(el => {
        (el as HTMLElement).style.setProperty('display', 'none', 'important');
      });
    } catch {}
  }).catch(() => {});
}

/**
 * Universal Login Flow
 * Handles: Cookie Banners -> Early Remember Me -> Coordinate/Standard Login -> Submission -> Verification
 */
export async function universalLoginFlow(options: UniversalLoginOptions): Promise<UnifiedLoginResult> {
  const { page, siteName, mode } = options;
  console.log(`[UniversalLogin] Starting universal flow for ${siteName} (mode: ${mode})`);

  if (options.cookieGuard && options.attemptIdx === 0) {
    console.log(`[UniversalLogin] Fresh launch on ${siteName} — awaiting mandatory cookie notice appearance & dismissal...`);
    await options.cookieGuard.waitUntilDismissed();
  }

  // Wait for login form to exist
  console.log(`[UniversalLogin] Waiting for login form to appear...`);
  const formReady = await page.waitForSelector('input[type="email"], input[name*="email"], input#email, #username', { state: "visible", timeout: 45000 }).catch(() => null);
  if (!formReady) {
    console.log(`[UniversalLogin] ❌ Login form never appeared! Page did not load fully.`);
    return { success: false };
  }

  // Brief settle for React event handler attachment (handlers bind within ~1 frame)
  await new Promise(r => setTimeout(r, 500));

  const coords = getCoordinateMap(siteName);

  // Wait for page to fully settle before interacting with the React form
  console.log(`[UniversalLogin] Waiting for page network to settle before injecting...`);
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});

  if (mode === "benchmark-direct") {
    console.log(`[UniversalLogin] benchmark-direct uses the canonical one-action choreography for evidence parity`);
  } else {
    console.log(`[UniversalLogin] Executing standard stealth choreography`);
  }
  if (coords?.emailInput && options.attemptIdx === 0) {
    console.log(`[UniversalLogin] Using viewport-independent coordinates for email input`);
    await coordinateClick(page, coords.emailInput).catch(() => {});
  }
  return executeUnifiedLoginChoreography(options);
}
