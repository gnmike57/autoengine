/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */
import { Page } from "playwright-core";

/**
 * Monitors execution speed and network latency to predict CAPTCHA thresholds.
 * If threat level spikes, triggers a humanize() routine.
 */
export class ThreatMonitor {
    private networkLags: number[] = [];
    private requestStartTimes = new WeakMap<object, number>();
    private threatScore = 0;
    private knownDomains = new Set([
            'joefortune.zone', 'www.joefortune.zone', 'api.joefortune.zone',
            'ignitioncasino.eu', 'www.ignitioncasino.eu', 'api.ignitioncasino.eu',
            'sentry.io', 'google-analytics.com', 'unpkg.com', 'fonts.googleapis.com'
          ]);
    private flaggedDomains = new Set<string>();

    constructor(private page: Page, private engine: any) {
        page.on('request', (req) => {
          this.requestStartTimes.set(req, Date.now());
          try {
            const url = new URL(req.url());
            const domain = url.hostname.replace(/^www\./, '');
            // Allow subdomains of known domains
            let isKnown = false;
            for (const known of this.knownDomains) {
              if (domain === known || domain.endsWith('.' + known)) {
                isKnown = true;
                break;
              }
            }
            if (!isKnown && !this.flaggedDomains.has(domain) && domain.includes('.')) {
              this.flaggedDomains.add(domain);
              this.threatScore += 25; // Massive penalty for unknown 3rd party scripts
              this.engine.log("WARN", `🚨 [Network Delta Matrix] Unapproved domain contacted: ${domain}. Increasing threat score!`);
            }
          } catch { /* ignore bad urls */ }
        });
        page.on('response', (res) => {
          const req = res.request();
          const startTime = this.requestStartTimes.get(req);
          if (startTime) {
            const lag = Date.now() - startTime;
            this.networkLags.push(lag);
            if (this.networkLags.length > 10) this.networkLags.shift();
            this.evaluateThreat();
            this.requestStartTimes.delete(req);
          }
        });

        // Invisible Turnstile & Cloudflare challenge detection
        if (typeof this.page?.evaluate === "function") {
          this.page.evaluate(() => {
            try {
              const checkChallenges = () => {
                const turnstile = document.querySelector('div.cf-turnstile, iframe[src*="challenges.cloudflare.com"], iframe[src*="turnstile"], [data-sitekey]');
                if (turnstile) {
                  console.debug('__cf_turnstile_detected__');
                }
              };
              const observer = new MutationObserver(() => checkChallenges());
              if (document.body) {
                observer.observe(document.body, { childList: true, subtree: true, attributes: true });
              }
              checkChallenges();
            } catch { /* intentional */ }
          }).catch(() => {});
        }

        page.on('console', (msg) => {
          if (msg.text().includes('__cf_turnstile_detected__')) {
            this.threatScore += 50;
            this.engine.log("WARN", `🚨 [ThreatMonitor] Cloudflare Turnstile / Challenge element detected in DOM!`);
            this.evaluateThreat();
          }
        });
    }

    private evaluateThreat() {
        if (this.networkLags.length < 3) return;
        const avgLag = this.networkLags.reduce((a, b) => a + b, 0) / this.networkLags.length;
        if (avgLag > 3000) {
          this.threatScore += 10;
        } else {
          this.threatScore = Math.max(0, this.threatScore - 2);
        }

        if (this.threatScore > 30) {
          this.engine.log("WARN", `🚨 [ThreatMonitor] High Threat Score (${this.threatScore}). Triggering humanize() evasive maneuvers...`);
          this.threatScore = 0; // Reset after trigger
          this.humanize().catch((e: any) => {
            try {
              this.engine?.log?.("DEBUG", `ThreatMonitor humanize() failed: ${e?.message ?? String(e)}`);
            } catch { /* intentional */ }
          });
        }
    }

    private async humanize() {
        try {
          // Viewport-aware random scrolling and reading delays with Gaussian jitter
          const vp = this.page.viewportSize() || { width: 1280, height: 720 };
          const moveX = Math.round(Math.max(10, Math.min(vp.width - 10, vp.width * 0.1 + Math.random() * vp.width * 0.6)));
          const moveY = Math.round(Math.max(10, Math.min(vp.height - 10, vp.height * 0.1 + Math.random() * vp.height * 0.6)));
          await this.page.mouse.move(moveX, moveY);
          const scrollDown = Math.round(150 + Math.random() * 300);
          await this.page.mouse.wheel(0, scrollDown);
          await new Promise(r => setTimeout(r, Math.round(800 + Math.random() * 1500)));
          await this.page.mouse.wheel(0, -Math.round(scrollDown * 0.5));
          await new Promise(r => setTimeout(r, Math.round(400 + Math.random() * 800)));
        } catch (e: unknown) {
          try {
            this.engine?.log?.("DEBUG", `ThreatMonitor humanize() exception: ${(e instanceof Error ? e.message : String(e)) ?? String(e)}`);
          } catch { /* intentional */ }
        }
    }
}
