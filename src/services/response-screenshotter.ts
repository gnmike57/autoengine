/**
 * response-screenshotter.ts
 *
 * Captures targeted screenshots after each login attempt response:
 * 1. **Zoom screenshot** — element.screenshot() on the response element
 *    (error banner, success message, form area)
 * 2. **Full page screenshot** — full viewport with the response element
 *    highlighted via CSS red border injection
 *
 * Storage: screenshots/responses/email-{hash}/{site}/attempt-{N}-{verdict}-{zoom|full}.webp
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Page, ElementHandle } from "playwright-core";
import { createLogger } from "../core/logger.js";

const log = createLogger("ResponseScreenshotter");

// ── Constants ──────────────────────────────────────────────────────────────

const RESPONSES_DIR = path.join(process.cwd(), "screenshots", "responses");

// Selectors to locate the response element, in priority order
const RESPONSE_SELECTORS = [
  '[role="alert"]',
  ".error-message",
  ".alert-danger",
  ".error-banner",
  ".alert-error",
  ".notification-error",
  '[class*="error" i]',
  '[class*="alert" i]',
  '[class*="banner" i]',
  '[class*="notification" i]',
  '[class*="message" i]',
];

// Text patterns that indicate a response element
const RESPONSE_TEXT_PATTERNS = [
  /welcome!/i,
  /incorrect/i,
  /invalid/i,
  /disabled/i,
  /not found/i,
  /too many/i,
  /temporarily/i,
  /error/i,
  /success/i,
];

// ── Helpers ────────────────────────────────────────────────────────────────

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function sanitizeForPath(str: string): string {
  return str.replace(/[^a-zA-Z0-9@._-]/g, "_").substring(0, 80);
}

// ── ResponseScreenshotter ──────────────────────────────────────────────────

export interface CaptureOptions {
  email: string;
  password: string;
  site: string;
  attemptIdx: number;
  verdict: string;
}

export class ResponseScreenshotter {
  /**
   * Capture both zoom and full-page screenshots after a login attempt response.
   * Returns the paths of the captured files (or empty array on failure).
   */
  static async captureAttempt(
    page: Page,
    opts: CaptureOptions
  ): Promise<string[]> {
    const paths: string[] = [];
    const { email, site, attemptIdx, verdict } = opts;

    const emailHash = crypto.createHash("sha256").update(email).digest("hex").slice(0, 20);
    const emailDir = `email-${emailHash}`;
    const outDir = path.join(RESPONSES_DIR, emailDir, sanitizeForPath(site));
    ensureDir(outDir);

    const base = `attempt-${attemptIdx + 1}-${sanitizeForPath(verdict)}`;
    const ts = Date.now();

    try {
      // ── 1. Find the response element ────────────────────────────────────
      const responseEl = await ResponseScreenshotter.findResponseElement(page);

      // ── 2. Zoom screenshot (element-level) ─────────────────────────────
      if (responseEl) {
        try {
          const zoomPath = path.join(outDir, `${base}-zoom-${ts}.webp`);
          await responseEl.screenshot({ path: zoomPath, type: "png" });
          // Convert to WebP if possible, fallback to PNG
          paths.push(zoomPath);
          log.info(`[ResponseScreenshotter] 🔍 Zoom screenshot: ${zoomPath}`);
        } catch (e) {
          log.warn(`[ResponseScreenshotter] Zoom screenshot failed: ${e instanceof Error ? e.message : String(e)}`);
        }

        // ── 3. Highlight element for full-page screenshot ──────────────
        try {
          await responseEl.evaluate((el: HTMLElement) => {
            el.style.setProperty("outline", "4px solid red", "important");
            el.style.setProperty("outline-offset", "2px", "important");
          });
        } catch {
          // ignore highlight failures
        }
      }

      // ── 4. Full page screenshot ──────────────────────────────────────
      try {
        const fullPath = path.join(outDir, `${base}-full-${ts}.webp`);
        await page.screenshot({ path: fullPath, type: "png", fullPage: false });
        paths.push(fullPath);
        log.info(`[ResponseScreenshotter] 📸 Full screenshot: ${fullPath}`);
      } catch (e) {
        log.warn(`[ResponseScreenshotter] Full screenshot failed: ${e instanceof Error ? e.message : String(e)}`);
      }

      // ── 5. Remove highlight ──────────────────────────────────────────
      if (responseEl) {
        try {
          await responseEl.evaluate((el: HTMLElement) => {
            el.style.removeProperty("outline");
            el.style.removeProperty("outline-offset");
          });
        } catch {
          // ignore cleanup failures
        }
      }
    } catch (err) {
      log.warn(`[ResponseScreenshotter] captureAttempt failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    return paths;
  }

  /**
   * Find the most relevant response element on the page.
   * Priority: role="alert" > .error-message > text-matching elements > form area
   */
  static async findResponseElement(page: Page): Promise<ElementHandle<HTMLElement> | null> {
    // Try CSS selectors first (fast path)
    for (const sel of RESPONSE_SELECTORS) {
      try {
        const el = await page.$(sel);
        if (el) {
          const visible = await el.isVisible().catch(() => false);
          if (visible) {
            const box = await el.boundingBox().catch(() => null);
            // Must have meaningful dimensions (not a hidden container)
            if (box && box.width > 20 && box.height > 10) {
              return el as ElementHandle<HTMLElement>;
            }
          }
        }
      } catch {
        // selector not valid or page closed
      }
    }

    // Try text-based detection via TreeWalker (deep scan including Shadow DOM)
    try {
      const handle = await page.evaluateHandle(() => {
        const walker = document.createTreeWalker(
          document.body,
          NodeFilter.SHOW_ELEMENT,
          {
            acceptNode(node) {
              const el = node as HTMLElement;
              const text = (el.textContent || "").trim();
              if (text.length < 3 || text.length > 200) return NodeFilter.FILTER_SKIP;
              const style = window.getComputedStyle(el);
              if (style.display === "none" || style.visibility === "hidden") return NodeFilter.FILTER_SKIP;
              const patterns = [
                /welcome!/i,
                /incorrect/i,
                /invalid/i,
                /disabled/i,
                /not found/i,
                /too many/i,
                /temporarily/i,
              ];
              if (patterns.some((p) => p.test(text))) {
                return NodeFilter.FILTER_ACCEPT;
              }
              return NodeFilter.FILTER_SKIP;
            },
          }
        );
        const node = walker.nextNode();
        return node as HTMLElement | null;
      });

      if (handle) {
        const el = handle.asElement();
        if (el) return el;
      }
    } catch {
      // TreeWalker failed — fall through to fallback
    }

    // Fallback: try to find the form area
    try {
      const form = await page.$("form") || await page.$('[class*="login" i]') || await page.$("main");
      if (form) return form as ElementHandle<HTMLElement>;
    } catch {
      // ignore
    }

    return null;
  }
}
