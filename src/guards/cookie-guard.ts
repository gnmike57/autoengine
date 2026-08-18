/**
 * CookieGuard — Unified, intelligent cookie notice dismissal system.
 *
 * Replaces the previous 4 scattered, overlapping mechanisms:
 *   1. installEarlyCookieDismissHook (MutationObserver initScript)
 *   2. Inline cascade in executeUnifiedLoginChoreography
 *   3. Async cookie watcher (cookie-calibration.json)
 *   4. CSS force-hide
 *
 * Architecture: Hybrid
 *   - Speed layer: lightweight addInitScript that CSS-hides cookie elements
 *     on every DOM mutation (runs inside page context, zero IPC latency)
 *   - Intelligence layer: Playwright-side class that manages dismissal state,
 *     fires viewport clicks to encourage appearance, runs 3-tier cascade,
 *     verifies dismissal via elementFromPoint, and exposes a hard gate
 *     (`waitUntilDismissed`) that blocks the login flow until confirmed.
 *
 * Key behavior:
 *   - Cookie notice ALWAYS appears on both target sites (joe/ignition).
 *   - Typical appearance: 3-10s after page load.
 *   - Viewport click trick speeds up appearance.
 *   - Login submit CANNOT proceed until cookie is dismissed (hard gate).
 *   - Error banners will appear if login submit occurs without dismissal.
 */

import type { Page } from "playwright-core";

/** Cookie overlay selectors to check for presence / hiding. */
const COOKIE_OVERLAY_SELECTORS = [
  ".coi-banner",
  ".coi-banner__overlay",
  ".coi-consent-banner",
  ".cookie-overlay",
  '[id*="cookie"]',
  '[class*="cookie-banner"]',
  '[class*="cookie-notice"]',
  '[class*="cookie-consent"]',
  '[class*="consent-banner"]',
  '[data-testid*="cookie"]',
] as const;

/** Selectors for the "Accept" button in the cookie banner, in priority order. */
const COOKIE_ACCEPT_SELECTORS = [
  ".coi-banner__accept",
  '[data-coi-btn="accept"]',
] as const;

/** Text patterns for the "Accept" button (case-insensitive match). */
const COOKIE_ACCEPT_TEXT_PATTERNS = [
  "ACCEPT ALL",
  "Accept All",
  "ACCEPT",
  "Accept",
  "Got it",
  "GOT IT",
  "I Agree",
  "I AGREE",
  "Agree",
  "Allow All",
  "ALLOW ALL",
] as const;

export interface CookieGuardOptions {
  /** Max time to wait for the cookie notice to appear and be dismissed. Default: 15000ms. */
  maxWaitMs?: number;
  /** Polling interval for checking cookie presence. Default: 200ms. */
  pollIntervalMs?: number;
  /** Form input selectors used for elementFromPoint verification. */
  formSelectors: { username: string; password: string };
  /** Site name for logging. */
  siteName: string;
}

const log = {
  info: (...args: unknown[]) => console.log("[CookieGuard]", ...args),
  warn: (...args: unknown[]) => console.warn("[CookieGuard]", ...args),
  debug: (...args: unknown[]) => console.log("[CookieGuard:DEBUG]", ...args),
};

export class CookieGuard {
  private _dismissed = false;
  private _installed = false;
  private page: Page;
  private options: Required<CookieGuardOptions>;

  constructor(page: Page, options: CookieGuardOptions) {
    this.page = page;
    this.options = {
      maxWaitMs: options.maxWaitMs ?? 15000,
      pollIntervalMs: options.pollIntervalMs ?? 200,
      formSelectors: options.formSelectors,
      siteName: options.siteName,
    };
  }

  /** Whether the cookie banner has been confirmed dismissed. */
  isDismissed(): boolean {
    return this._dismissed;
  }

  /**
   * SPEED LAYER: Install lightweight initScript for instant CSS hiding.
   * Runs inside the page context via MutationObserver. Zero IPC latency.
   * This does NOT confirm dismissal — it's a fast, best-effort hide.
   */
  async install(): Promise<void> {
    if (this._installed) return;
    this._installed = true;

    await this.page.addInitScript(() => {
      let lastRun = 0;
      const COOKIE_HIDE_SELECTORS = [
        ".coi-banner",
        ".coi-banner__overlay",
        ".coi-consent-banner",
        ".cookie-overlay",
        '[id*="cookie"]',
        '[class*="cookie-banner"]',
        '[class*="cookie-notice"]',
        '[class*="cookie-consent"]',
        '[class*="consent-banner"]',
      ];

      const hideCookies = () => {
        // Tier 1: Native API
        try {
          (window as any).CookieInformation?.submitAllCategories?.();
        } catch { /* intentional */ }

        // Tier 3 (fast): CSS Force Hide
        for (const sel of COOKIE_HIDE_SELECTORS) {
          try {
            document.querySelectorAll(sel).forEach((el) => {
              (el as HTMLElement).style.setProperty("display", "none", "important");
            });
          } catch { /* intentional */ }
        }
      };

      const observer = new MutationObserver(() => {
        const now = Date.now();
        if (now - lastRun < 80) return; // Throttle to ~12.5 checks/sec
        lastRun = now;
        hideCookies();
      });

      // Start observing immediately
      if (document.body) {
        observer.observe(document.body, { childList: true, subtree: true });
      } else {
        document.addEventListener("DOMContentLoaded", () => {
          observer.observe(document.body, { childList: true, subtree: true });
        });
      }

      // Initial sync run
      hideCookies();
    }).catch(() => { /* intentional — page may be closed */ });
  }

  /**
   * Fire a viewport click at safe coordinates to encourage the cookie
   * notice to appear faster. Some sites trigger the cookie banner on
   * first user interaction.
   */
  async triggerAppearance(): Promise<void> {
    try {
      // Click at a neutral position (bottom-right corner area, away from form)
      const vp = this.page.viewportSize();
      if (!vp) return;
      const x = vp.width - 15;
      const y = vp.height - 15;
      await this.page.mouse.click(x, y);
      log.debug(`Fired appearance trigger click at (${x}, ${y})`);
    } catch { /* intentional — page may be navigating */ }
  }

  /**
   * INTELLIGENCE LAYER: 3-tier cascade dismiss with DOM verification.
   * Returns true if dismissal was confirmed, false if it failed.
   */
  async dismiss(): Promise<boolean> {
    if (this._dismissed) return true;

    try {
      // Tier 1: Native CookieInformation API
      const apiResult = await this.page.evaluate(() => {
        try {
          if ((window as any).CookieInformation?.submitAllCategories) {
            (window as any).CookieInformation.submitAllCategories();
            return true;
          }
        } catch { /* intentional */ }
        return false;
      }).catch(() => false);

      if (apiResult) {
        log.info(`✅ Dismissed via CookieInformation API`);
      }

      // Tier 2: UI Click (cascading selectors)
      let clickSuccess = false;
      for (const sel of COOKIE_ACCEPT_SELECTORS) {
        try {
          const btn = this.page.locator(sel).first();
          if (await btn.isVisible({ timeout: 300 }).catch(() => false)) {
            await btn.click({ timeout: 1500 });
            clickSuccess = true;
            log.info(`✅ Dismissed via selector: ${sel}`);
            break;
          }
        } catch { /* intentional */ }
      }

      // Tier 2b: Text-based button search
      if (!clickSuccess) {
        for (const text of COOKIE_ACCEPT_TEXT_PATTERNS) {
          try {
            const btn = this.page.locator(`button:has-text("${text}")`).first();
            if (await btn.isVisible({ timeout: 200 }).catch(() => false)) {
              await btn.click({ timeout: 1500 });
              clickSuccess = true;
              log.info(`✅ Dismissed via text match: "${text}"`);
              break;
            }
          } catch { /* intentional */ }
        }
      }

      // Tier 3: CSS Force Hide (always runs as final safety net)
      await this.page.evaluate((selectors: string[]) => {
        for (const sel of selectors) {
          try {
            document.querySelectorAll(sel).forEach((el) => {
              (el as HTMLElement).style.setProperty("display", "none", "important");
            });
          } catch { /* intentional */ }
        }
      }, [...COOKIE_OVERLAY_SELECTORS] as string[]).catch(() => {});

      // Brief settle for CSS fade-outs
      await new Promise((r) => setTimeout(r, 200));

      // Verify dismissal
      const verified = await this.verifyDismissed();
      if (verified) {
        this._dismissed = true;
        log.info(`✅ Dismissal VERIFIED — form inputs are accessible`);
      } else {
        log.warn(`⚠ Dismissal attempted but verification failed — form may still be obscured`);
      }

      return this._dismissed;
    } catch (e) {
      log.warn(`Dismiss error: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  }

  /**
   * Verify that the cookie banner is truly gone by checking:
   * 1. No cookie overlay elements are visible in the layout
   * 2. Form inputs are not obscured (elementFromPoint returns the input, not an overlay)
   */
  async verifyDismissed(): Promise<boolean> {
    try {
      return await this.page.evaluate(
        ({ overlaySelectors, userSel, passSel }: { overlaySelectors: string[]; userSel: string; passSel: string }) => {
          // Check 1: Are any cookie overlays still visible?
          for (const sel of overlaySelectors) {
            try {
              const els = document.querySelectorAll(sel);
              for (const el of els) {
                const htmlEl = el as HTMLElement;
                if (htmlEl.offsetParent !== null) {
                  const style = window.getComputedStyle(htmlEl);
                  if (style.display !== "none" && style.visibility !== "hidden" && parseFloat(style.opacity) > 0.1) {
                    // This overlay is still visually present
                    return false;
                  }
                }
              }
            } catch { /* intentional */ }
          }

          // Check 2: Are form inputs accessible via elementFromPoint?
          for (const sel of [userSel, passSel]) {
            try {
              const input = document.querySelector(sel);
              if (!input) continue; // Input not in DOM yet — skip check
              const rect = input.getBoundingClientRect();
              if (rect.width === 0 || rect.height === 0) continue;
              const cx = rect.left + rect.width / 2;
              const cy = rect.top + rect.height / 2;
              const topEl = document.elementFromPoint(cx, cy);
              if (topEl && topEl !== input && !input.contains(topEl) && !(topEl as HTMLElement).closest?.("label")) {
                // Something is covering the input — likely cookie overlay
                return false;
              }
            } catch { /* intentional */ }
          }

          return true;
        },
        {
          overlaySelectors: [...COOKIE_OVERLAY_SELECTORS] as string[],
          userSel: this.options.formSelectors.username,
          passSel: this.options.formSelectors.password,
        }
      );
    } catch {
      // Page closed or evaluation failed — assume dismissed to not block
      return true;
    }
  }

  /**
   * Detect if a cookie overlay is currently present in the DOM.
   */
  async isCookiePresent(): Promise<boolean> {
    try {
      return await this.page.evaluate((selectors: string[]) => {
        for (const sel of selectors) {
          try {
            const els = document.querySelectorAll(sel);
            for (const el of els) {
              const htmlEl = el as HTMLElement;
              if (htmlEl.offsetParent !== null) {
                const style = window.getComputedStyle(htmlEl);
                if (style.display !== "none" && style.visibility !== "hidden") {
                  return true;
                }
              }
            }
          } catch { /* intentional */ }
        }
        return false;
      }, [...COOKIE_OVERLAY_SELECTORS] as string[]);
    } catch {
      return false;
    }
  }

  /**
   * HARD GATE: Block until the cookie notice is confirmed dismissed.
   *
   * Flow:
   *   1. Fire viewport click at T+500ms to encourage appearance
   *   2. Poll every 200ms for cookie overlay presence
   *   3. When detected: run 3-tier dismiss cascade + verify
   *   4. Fire another viewport click at T+2s if still waiting
   *   5. If not dismissed after maxWaitMs: force CSS-hide + warn + proceed
   *
   * @returns true if dismissed (or force-cleared), false only if page closed
   */
  async waitUntilDismissed(): Promise<boolean> {
    if (this._dismissed) return true;

    const { maxWaitMs, pollIntervalMs, siteName } = this.options;
    const startTime = Date.now();
    let appearanceTriggered500 = false;
    let appearanceTriggered2000 = false;
    let dismissAttempts = 0;

    log.info(`${siteName}: Waiting for cookie notice (max ${maxWaitMs / 1000}s)...`);

    while (Date.now() - startTime < maxWaitMs) {
      if (this.page.isClosed()) return false;

      const elapsed = Date.now() - startTime;

      // Fire viewport click at T+500ms to speed up cookie appearance
      if (!appearanceTriggered500 && elapsed >= 500) {
        appearanceTriggered500 = true;
        await this.triggerAppearance();
      }

      // Fire another viewport click at T+2s
      if (!appearanceTriggered2000 && elapsed >= 2000) {
        appearanceTriggered2000 = true;
        await this.triggerAppearance();
      }

      // Check if cookie is present
      const present = await this.isCookiePresent();

      if (present) {
        dismissAttempts++;
        log.info(`${siteName}: Cookie notice detected at T+${elapsed}ms (attempt ${dismissAttempts})`);

        const success = await this.dismiss();
        if (success) {
          log.info(`${siteName}: ✅ Cookie dismissed and verified at T+${Date.now() - startTime}ms`);
          return true;
        }

        // If dismiss failed, wait a bit and retry
        await new Promise((r) => setTimeout(r, 500));
        continue;
      }

      // Check if already dismissed (by initScript speed layer)
      const verified = await this.verifyDismissed();
      if (verified) {
        // No overlay visible and form inputs are accessible — either dismissed or never appeared yet
        // But we know it ALWAYS appears, so keep waiting unless we're past the typical window
        if (elapsed > 8000) {
          // Past the typical 3-10s window — likely already dismissed by initScript
          this._dismissed = true;
          log.info(`${siteName}: ✅ No overlay detected after ${elapsed}ms — likely dismissed by speed layer`);
          return true;
        }
      }

      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }

    // Timeout: force CSS-hide and proceed
    log.warn(`${siteName}: ⚠ Cookie wait timed out after ${maxWaitMs}ms — forcing CSS-hide and proceeding`);
    await this.page.evaluate((selectors: string[]) => {
      for (const sel of selectors) {
        try {
          document.querySelectorAll(sel).forEach((el) => {
            (el as HTMLElement).style.setProperty("display", "none", "important");
          });
        } catch { /* intentional */ }
      }
    }, [...COOKIE_OVERLAY_SELECTORS] as string[]).catch(() => {});

    this._dismissed = true;
    return true;
  }

  /**
   * Re-check and re-dismiss if needed (for use during no-response restart flows).
   */
  async recheckAndDismiss(): Promise<boolean> {
    this._dismissed = false;
    const present = await this.isCookiePresent();
    if (present) {
      log.info(`${this.options.siteName}: Cookie reappeared — re-dismissing`);
      return this.dismiss();
    }
    const verified = await this.verifyDismissed();
    this._dismissed = verified;
    return verified;
  }
}
