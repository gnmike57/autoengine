import { createLogger } from "../core/logger.js";

const log = createLogger("BrowserWarmer");

/**
 * BrowserWarmer — DISABLED per Rule 21 (strict-no-warmup-directive).
 *
 * Background navigation to search engines (Google, Yahoo, Bing) or any
 * external URL to "warm up" profiles is completely banned. The engine must
 * proceed directly to the target URL for maximum speed.
 *
 * This module is retained as a no-op stub so existing import sites
 * (`server.ts`, `spider-local.ts`) don't break. All methods are safe to
 * call but do nothing.
 */
export class BrowserWarmer {
  public start(): void {
    log.warn("BrowserWarmer.start() is a no-op — warmup navigation banned by Rule 21");
  }

  public stop(): void {
    // No-op
  }

  public consumeWarmedProfile(_sessionName: string): string | null {
    // No warmed profiles are ever created
    return null;
  }
}

export const browserWarmer = new BrowserWarmer();
