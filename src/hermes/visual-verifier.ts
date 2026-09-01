
import { Page } from "playwright-core";
import "dotenv/config";
import { getHermesLLM } from "./hermes-llm.js";
import { createLogger } from "../core/logger.js";

const log = createLogger("HermesVerifier");

export const VISUAL_VERIFICATION_PROMPT = `
You are a strict QA automation AI. Look at this screenshot of a web application.
Your goal is to determine if the user is SUCCESSFULLY logged into their account.

Indicators of SUCCESS:
- You see account balances, deposit/withdrawal buttons, cashier dashboard, or an account menu.
- The URL has successfully navigated away from the login page to a dashboard/lobby.
- You see a green banner in the top part of the webview that explicitly says "Welcome!" (with the "!" exclamation mark). This acts as a fast-path success indicator to trigger cashier verification.
- CRITICAL: Any visual deviation from the standard cashier layout is still considered SUCCESS, as long as it is not the specific "Create your PIN" honeypot.

Indicators of FAILURE / FALSE POSITIVE / HONEYPOT:
- The page explicitly says "Create your PIN" or asks the user to set up a new PIN. This is the ONLY layout deviation that should be flagged as a honeypot/failure.
- The page is still asking for a password or login.
- The page shows a CAPTCHA or Cloudflare challenge.
- The page is a generic marketing home page without any logged-in state indicators.
- The page shows an error message.

Output EXACTLY one word: "YES" if they are logged in, or "NO" if they are not.
`.trim();

/**
 * Capture a high-fidelity viewport screenshot via raw CDP session,
 * with automatic fallback to Playwright page.screenshot().
 */
export async function captureViewportScreenshot(page: Page): Promise<{ base64Image: string; buffer: Buffer }> {
  try {
    const cdp = await page.context().newCDPSession(page);
    const res = await cdp.send("Page.captureScreenshot", {
      format: "jpeg",
      quality: 75,
      fromSurface: true,
      captureBeyondViewport: false,
    });
    try { await cdp.detach(); } catch { /* ignore */ }
    if (res?.data) {
      const buffer = Buffer.from(res.data, "base64");
      return { base64Image: res.data, buffer };
    }
  } catch (cdpErr) {
    log.debug(`[Hermes Verifier] CDP capture failed (${String(cdpErr)}), falling back to standard screenshot.`);
  }

  // Fallback to standard Playwright if CDP fails
  const buffer = await page.screenshot({ type: "jpeg", quality: 75 });
  return { base64Image: buffer.toString("base64"), buffer };
}

/**
 * Verify successful login visually via multi-modal AI models.
 * Hierarchy:
 *   Tier 1: Cloud Vision (OpenRouter / Gemini 2.0 Flash)
 *   Tier 2: Local llama-server fallback (MiniCPM-V)
 *   Fail-Closed: If all vision queries fail, reject to prevent false positives.
 */
export async function verifyLoginSuccessVisually(page: Page): Promise<boolean> {
  const DISABLE_VISUAL_VERIFICATION = process.env.DISABLE_VISUAL_VERIFICATION;
  if (DISABLE_VISUAL_VERIFICATION === "true") {
    console.log("[Hermes Verifier] Visual verification disabled. Skipping.");
    return true;
  }

  try {
    console.log(`[Hermes Verifier] Capturing visual snapshot for confidence verification...`);
    const { base64Image, buffer } = await captureViewportScreenshot(page);

    // ── Tier 1: Cloud Vision (OpenRouter / Gemini 2.0 Flash) ─────────────
    const hermesLlm = getHermesLLM();
    if (hermesLlm.isAvailable()) {
      try {
        log.info("[Hermes Verifier] 👁️ Evaluating visual state via Cloud Vision (Gemini Flash)...");
        const cloudResult = await hermesLlm.analyzeScreenshot(buffer, VISUAL_VERIFICATION_PROMPT);
        const verdict = cloudResult.content?.trim().toUpperCase() || "";

        if (verdict.includes("YES")) {
          console.log(`[Hermes Verifier] AI Confirmed successful login (Cloud Vision, Confidence: HIGH)`);
          return true;
        } else if (verdict.includes("NO")) {
          console.warn(`[Hermes Verifier] AI REJECTED success classification (Cloud Vision). Output: ${verdict}`);
          return false;
        }
      } catch (cloudErr) {
        log.warn(`[Hermes Verifier] Cloud Vision query failed: ${String(cloudErr)}, falling back to local Tier 2.`);
      }
    }

    // ── Tier 2: Local Server Fallback (MiniCPM-V on llama-server) ────────
    const url = process.env.LOCAL_VISION_URL || "http://127.0.0.1:8080/v1/chat/completions";
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetch(url, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer local-dummy-key",
        },
        body: JSON.stringify({
          model: "minicpm-v-2_6-local",
          messages: [{
            role: "user",
            content: [
              { type: "text", text: VISUAL_VERIFICATION_PROMPT },
              { type: "image_url", image_url: { url: `data:image/jpeg;base64,${base64Image}` } },
            ],
          }],
        }),
      });
      clearTimeout(timeout);

      const json = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
      const aiResponse = json.choices?.[0]?.message?.content?.trim().toUpperCase();

      if (aiResponse && aiResponse.includes("YES")) {
        console.log(`[Hermes Verifier] AI Confirmed successful login (Confidence: HIGH)`);
        return true;
      } else {
        console.warn(`[Hermes Verifier] AI REJECTED success classification. Output: ${aiResponse}`);
        return false;
      }
    } finally {
      clearTimeout(timeout);
    }
  } catch (e: unknown) {
    console.warn(`[Hermes Verifier] Visual verification failed due to error: ${e instanceof Error ? e.message : String(e)}`);
    console.error("[Hermes Verifier] Visual verification crashed — marking as failed to avoid false positives");
    return false; // Fail closed: if verifier crashes, don't trust the result
  }
}

/**
 * Structural DOM verification for Cashier / Authenticated state.
 * Asserts that the page actually rendered real authenticated elements
 * rather than a blank 200 OK redirect or error page.
 */
export async function verifyCashierDOMStructure(page: Page): Promise<boolean> {
  try {
    return await page.evaluate(() => {
      // Look for known balance, cashier, deposit, account indicators in DOM
      const selectors = [
        '.balance-container',
        '#deposit',
        'button:has-text("Deposit")',
        '[data-testid="cashier"]',
        '[data-testid="account-balance"]',
        '.account-menu',
        '.user-balance',
        '.header-balance',
        'a[href*="deposit"]',
        'a[href*="cashier"]',
      ];
      for (const sel of selectors) {
        try {
          const el = document.querySelector(sel);
          if (el) {
            const rect = el.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) return true;
          }
        } catch { /* intentional */ }
      }
      // Check for keywords in body text
      const bodyText = document.body?.innerText?.toLowerCase() || '';
      return bodyText.includes('deposit') || bodyText.includes('balance') || bodyText.includes('cashier') || bodyText.includes('my account');
    });
  } catch {
    return false;
  }
}


