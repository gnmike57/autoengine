/* eslint-disable @typescript-eslint/unbound-method */
import { Page } from "playwright-core";

/**
 * Watchdog to monitor Playwright Page for 30+ seconds of inactivity (default).
 * Detects hard sleeps and stuck locators and forcefully terminates the session.
 */
export class IdleWatchdog {
    private lastActivity = Date.now();
    private intervalId: NodeJS.Timeout | null = null;
    private isDestroyed = false;

    constructor(private page: Page, private onIdle: () => void, private timeoutMs: number = 30000) {
        this.ping = this.ping.bind(this);
        page.on('request', this.ping);
        page.on('response', this.ping);
        page.on('framenavigated', this.ping);
        page.on('console', this.ping);
        page.evaluate(() => {
          try {
            const observer = new MutationObserver(() => {
              console.debug('__wd_ping__');
            });
            observer.observe(document, { childList: true, subtree: true, attributes: true });
            (window as any).__wd_observer = observer;
          } catch { /* intentional */ }
        }).catch(() => {});
        this.intervalId = setInterval(() => this.check(), 1000);
    }

    ping() {
        if (this.isDestroyed) return;
        this.lastActivity = Date.now();
    }

    check() {
        if (this.isDestroyed) return;
        
        // Memory Pre-emption (1.5GB limit)
        const rss = process.memoryUsage().rss;
        if (rss > 1.5 * 1024 * 1024 * 1024) {
          console.error(`[IdleWatchdog] CRITICAL: RSS Memory exceeded 1.5GB (${Math.round(rss / 1024 / 1024)}MB). Triggering graceful drain.`);
          this.onIdle();
          this.destroy();
          this.page.close({ runBeforeUnload: false }).catch(() => {});
          this.page.context().close().catch(() => {});
          return;
        }

        if (Date.now() - this.lastActivity >= this.timeoutMs) {
          // 🚨 Automatic fallback system: aggressively close the window on 30s timeout
          this.onIdle();
          this.destroy(); // Destroy immediately so we don't spam

          // Forcefully kill the page to break any stuck locators
          this.page.close({ runBeforeUnload: false }).catch(() => {});
          this.page.context().close().catch(() => {});
        }
    }

    destroy() {
        this.isDestroyed = true;
        if (this.intervalId) {
          clearInterval(this.intervalId);
          this.intervalId = null;
        }

        this.page.removeListener('request', this.ping);
        this.page.removeListener('response', this.ping);
        this.page.removeListener('framenavigated', this.ping);
        this.page.removeListener('console', this.ping);

        this.page.evaluate(() => {
          try {
            if ((window as any).__wd_observer) {
              (window as any).__wd_observer.disconnect();
              delete (window as any).__wd_observer;
            }
          } catch { /* intentional */ }
        }).catch(() => {});
    }
}
