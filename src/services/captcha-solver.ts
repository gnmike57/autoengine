/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access */
import { Page } from "playwright-core";
import { createLogger } from "../core/logger.js";

const log = createLogger("CAPTCHA");

/**
 * CAPTCHA Detection & Handling
 *
 * Target sites use INVISIBLE reCAPTCHA v3 (score-based, 0.0–1.0).
 * There are NO puzzle CAPTCHAs to solve. Score maximization is handled
 * by the stealth scripts layer (recaptcha-interceptor.ts):
 *   - grecaptcha.execute hook with minimum 3s delay
 *   - Bézier mouse trajectory behavioral emulation
 *   - Continuous RAF-driven micro-events for telemetry
 *   - ___grecaptcha_cfg callback override
 *
 * This module provides detection utilities for identifying CAPTCHA
 * types present on a page, and routes to the appropriate handler
 * if a visual CAPTCHA is ever encountered (future-proofing).
 */

/**
 * Detect what type of CAPTCHA (if any) is present on the page.
 * Returns the CAPTCHA type or null if none detected.
 */
export async function detectCaptchaType(page: Page): Promise<
  "recaptcha-v3" | "recaptcha-v2" | "turnstile" | "hcaptcha" | null
> {
  try {
    return await page.evaluate(() => {
      // reCAPTCHA v3 (invisible — score-based, no puzzle)
      if (
        typeof (window as any).grecaptcha !== "undefined" ||
        document.querySelector('script[src*="recaptcha/api.js"]') ||
        document.querySelector('script[src*="recaptcha/enterprise.js"]')
      ) {
        // Check if it's v2 (has visible badge/checkbox) or v3 (invisible)
        const v2Frame = document.querySelector('iframe[src*="recaptcha"][src*="anchor"]');
        const v2Checkbox = document.querySelector('.g-recaptcha[data-sitekey]');
        if (v2Frame || v2Checkbox) return "recaptcha-v2" as const;
        return "recaptcha-v3" as const;
      }

      // Cloudflare Turnstile
      if (document.querySelector('iframe[src*="challenges.cloudflare.com"]')) {
        return "turnstile" as const;
      }

      // hCaptcha
      if (document.querySelector('iframe[src*="hcaptcha"]')) {
        return "hcaptcha" as const;
      }

      return null;
    });
  } catch {
    return null;
  }
}

/**
 * Check if the page has reCAPTCHA v3 (score-based, no puzzle).
 * This is the expected CAPTCHA type on target sites.
 */
export async function isReCaptchaV3Only(page: Page): Promise<boolean> {
  const type = await detectCaptchaType(page);
  return type === "recaptcha-v3";
}

/**
 * Main CAPTCHA handler entry point.
 *
 * For reCAPTCHA v3: Logs detection and confirms score-based handling
 * is active via stealth scripts. No puzzle solving needed.
 *
 * For visual CAPTCHAs (v2, Turnstile, hCaptcha): Logs a warning.
 * These are NOT expected on target sites. If encountered, it likely
 * indicates a detection failure that should be investigated.
 */
export async function detectAndSolveCaptcha(page: Page, _apiKey?: string): Promise<boolean> {
  const captchaType = await detectCaptchaType(page);

  if (!captchaType) return false;

  if (captchaType === "recaptcha-v3") {
    log.info("reCAPTCHA v3 detected — score-based, handled by stealth scripts layer");
    return false; // No action needed — stealth scripts handle scoring
  }

  // Visual CAPTCHA detected — this is unexpected on target sites
  log.warn(
    `Visual CAPTCHA detected: ${captchaType}. ` +
    `This is NOT expected on target sites. ` +
    `Possible detection failure — investigate fingerprint coherence.`
  );

  // Log for detection feedback loop
  log.error(
    `[DETECTION EVENT] vector=visual_captcha_${captchaType} ` +
    `reason="Unexpected visual CAPTCHA appeared — possible fingerprint detection"`
  );

  return false;
}
