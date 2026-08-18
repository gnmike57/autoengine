/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
import type { Page } from "playwright";
import { createLogger } from "../core/logger.js";

const log = createLogger("live-auditor");

export interface FingerprintMismatch {
  expectedUA: string;
  expectedOS: string;
  actualJA3?: string;
  actualHTTP2?: string;
  actualNavigatorUserAgent?: string;
  actualHardwareConcurrency?: number;
}

/**
 * Asynchronously triggers a non-blocking fetch from within the Playwright context
 * to the local `/audit-fp` endpoint to verify TLS, HTTP2, and JS Fingerprint coherence.
 * Mismatches are logged to telemetry.
 * Does NOT await the fetch result to prevent slowing down page.goto.
 */
export function startAsyncFingerprintAudit(
  page: Page,
  expectedUA: string,
  expectedOS: string,
  serverPort: number = 3011
): void {
  const auditUrl = `http://localhost:${serverPort}/audit-fp`;

  // Inject a non-blocking evaluate call
  page.evaluate(
    (args) => {
      const { url, expectedUA, expectedOS } = args;

      // We perform an asynchronous fetch that we don't await,
      // sending client-side JS evidence in the payload
      fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          expectedUA,
          expectedOS,
          jsEvidence: {
            userAgent: navigator.userAgent,
            hardwareConcurrency: navigator.hardwareConcurrency,
            deviceMemory: (navigator as any).deviceMemory,
            platform: navigator.platform,
            vendor: navigator.vendor,
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone
          }
        })
      }).catch(e => console.error("LiveAuditor Fetch Failed:", e));
    },
    { url: auditUrl, expectedUA, expectedOS }
  ).catch(e => {
    log.debug(`Failed to inject live auditor: ${e.message}`);
  });
}
