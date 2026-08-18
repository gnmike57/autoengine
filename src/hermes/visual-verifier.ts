
import { Page } from "playwright-core";
import "dotenv/config";

export async function verifyLoginSuccessVisually(page: Page): Promise<boolean> {
  const DISABLE_VISUAL_VERIFICATION = process.env.DISABLE_VISUAL_VERIFICATION;
  if (DISABLE_VISUAL_VERIFICATION === 'true') {
    console.log("[Hermes Verifier] Visual verification disabled. Skipping.");
    return true;
  }

  try {
    console.log(`[Hermes Verifier] Capturing visual snapshot for confidence verification...`);
    // Capture screenshot via raw CDP to bypass Python bridge latency (Zendriver fix)
    let base64Image = "";
    try {
      const cdp = await page.context().newCDPSession(page);
      const res = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 60 });
      base64Image = res.data;
    } catch {
      // Fallback to standard Playwright if CDP fails
      const screenshotBuffer = await page.screenshot({ type: "jpeg", quality: 60 });
      base64Image = screenshotBuffer.toString("base64");
    }

    const promptText = `
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
    `;

    // Local llama.cpp server endpoint for MiniCPM-V
    const url = "http://127.0.0.1:8080/v1/chat/completions";
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    const response = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        // Authorization header is usually not required for local llama-server unless configured
        'Authorization': `Bearer local-dummy-key`
      },
      body: JSON.stringify({
        // Model name is ignored by llama-server but required for OpenAI API compatibility
        model: "minicpm-v-2_6-local",
        messages: [{
          role: "user",
          content: [
            { type: "text", text: promptText },
            { type: "image_url", image_url: { url: `data:image/jpeg;base64,${base64Image}` } }
          ]
        }]
      })
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
  } catch (e: unknown) {
    console.warn(`[Hermes Verifier] Visual verification failed due to error: ${e instanceof Error ? e.message : String(e)}`);
    console.error("[Hermes Verifier] Visual verification crashed — marking as failed to avoid false positives");
    return false; // Fail closed: if verifier crashes, don't trust the result
  }
}
