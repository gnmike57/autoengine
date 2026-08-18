import { type Page, type Route, type Request } from "playwright-core";
import { createLogger } from "../core/logger.js";

const log = createLogger("StaticCache");

interface CachedAsset {
    body: Buffer;
    contentType: string;
    headers: Record<string, string>;
}

// Global In-Memory Cache shared across all sessions and backends
const memoryCache = new Map<string, CachedAsset>();

// Ultra-Safe List: Only cache these extensions.
// JavaScript (.js) is explicitly EXCLUDED to prevent caching dynamic nonces or honeypot scripts.
// HTML (.html) is explicitly EXCLUDED to ensure fresh CSRF tokens.
const SAFE_ASSET_REGEX = /\.(css|woff2?|ttf|png|svg|jpg|jpeg|gif|ico)$/i;

let totalCacheHits = 0;
let totalBytesSaved = 0;

/**
 * Attaches the static asset interceptor to the page.
 * Requests matching the safe list will be served from memory if available,
 * completely bypassing the proxy and saving bandwidth/time.
 */
export async function attachStaticCache(page: Page, sessionId: string) {
    try {
        await page.route('**/*', async (route: Route, request: Request) => {
            const url = request.url();

            // Only cache GET requests
            if (request.method() !== 'GET') {
                await route.continue().catch(() => {});
                return;
            }

            // Check if URL matches ultra-safe list
            if (SAFE_ASSET_REGEX.test(url) || url.endsWith('/favicon.ico')) {
                const cached = memoryCache.get(url);

                if (cached) {
                    totalCacheHits++;
                    totalBytesSaved += cached.body.length;

                    // Periodically log cache stats (every 100 hits)
                    if (totalCacheHits % 100 === 0) {
                        log.info(`[StaticCache] Saved ${(totalBytesSaved / 1024 / 1024).toFixed(2)} MB across ${totalCacheHits} hits`);
                    }

                    await route.fulfill({
                        status: 200,
                        headers: {
                            ...cached.headers,
                            'x-automati-cache': 'HIT' // Custom header for debugging
                        },
                        body: cached.body,
                        contentType: cached.contentType
                    }).catch(() => {});
                    return;
                }

                // Not in cache, fetch it using the page's context (which routes through its proxy)
                try {
                    const response = await page.request.fetch(request, { maxRetries: 1 });
                    const body = await response.body();
                    const headers = response.headers();
                    const contentType = headers['content-type'] || 'application/octet-stream';

                    // Only cache successful responses that actually have a body
                    if (response.ok() && body.length > 0) {
                        if (memoryCache.size >= 1000) {
                            const firstKey = memoryCache.keys().next().value;
                            if (firstKey) memoryCache.delete(firstKey);
                        }
                        memoryCache.set(url, { body, headers, contentType });
                    }

                    await route.fulfill({ response, body }).catch(() => {});
                    return;
                } catch {
                    // If page.request.fetch fails (e.g. proxy timeout), fallback to let the browser try
                    await route.continue().catch(() => {});
                    return;
                }
            }

            // Not a safe static asset, continue normally
            await route.continue().catch(() => {});
        });

        log.debug(`[${sessionId}] Ultra-Safe Static Asset Cache attached`);
    } catch (e: any) {
        log.warn(`[${sessionId}] Failed to attach static cache: ${e.message}`);
    }
}
