/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/require-await , @typescript-eslint/no-misused-promises*/
/**
 * Proxy reputation tracker. Records success/fail counts per proxy server
 * and biases future picks toward proxies with healthy history via Laplace-
 * smoothed weighted random selection. Persists to a sidecar JSON file.
 *
 * - Score:    s.success / (s.success + s.fail + 1)   (Laplace smoothing)
 * - Quarantine: trials >= minTrials AND score < minScore → weight 0
 * - Unknown proxies get a neutral weight so fresh entries can compete.
 */
import fs from "node:fs";
import { type ProxyEntry } from "../../backends/index.js";
import { createLogger } from "../core/logger.js";
import { detectCountryFromProxy } from "../profiles/profile-geo-alignment.js";

const log = createLogger("proxy-score-tracker");

/**
 * Unique identifier for a proxy entry. Sticky-residential pools commonly ship
 * many entries that share the same gateway host:port and differ only in the
 * username (the sticky-session token). Excluding by `server` alone collapses
 * all 200 entries into one, defeating row-level proxy rotation; we therefore
 * key by `server#username` so each sticky session can be rotated independently.
 */
export function proxyEntryKey(p: ProxyEntry): string {
  return `${p.server}#${p.username || ""}`;
}

export interface ProxyScore {
  key: string;
  success: number;
  fail: number;
  lastUsed: number; // ms epoch
  server?: string;  // display-friendly host:port, set the last time record() was called with a server
  isJailed?: boolean;
}

export interface ProxyHealthInfo {
  key: string;
  server: string;
  success: number;
  fail: number;
  trials: number;
  score: number;
  isJailed: boolean;
  lastUsed: number;
}

export interface ProxyScoreTrackerOptions {
  minScore?: number;   // default 0.2 — below this and trials >= minTrials → quarantine
  minTrials?: number;  // default 5   — need at least this many trials before quarantining
}

export class ProxyScoreTracker {
  private scores = new Map<string, ProxyScore>();
  private readonly minScore: number;
  private readonly minTrials: number;
  private readonly maxEntries: number;
  private patternBlacklist = new Map<RegExp, number>();

  constructor(opts: ProxyScoreTrackerOptions & { maxEntries?: number; scoresFile?: string } = {}) {
    this.minScore = opts.minScore ?? 0.2;
    this.minTrials = opts.minTrials ?? 5;
    this.maxEntries = opts.maxEntries ?? 10000;
  }

  // Subnet tracking for cluster failures (Item 24)
  private subnetFailures = new Map<string, { count: number; lastFail: number; banLevel: number }>();

  private extractSubnet(server: string): string | undefined {
    const lastDot = server.lastIndexOf('.');
    if (lastDot > 0) {
      return server.substring(0, lastDot);
    }
    return undefined;
  }

  /** Record a per-row outcome against a proxy server. `server` is the
   *  display-friendly host/port string;
   *  optional, kept on the score so diagnostic dumps can surface which
   *  upstream gateway each sticky-session key actually routes through. */
  record(key: string, success: boolean, server?: string): void {
    let existing = this.scores.get(key);
    if (existing) {
      this.scores.delete(key); // Remove to re-insert at the end (LRU behavior)
    } else {
      existing = { key, success: 0, fail: 0, lastUsed: 0 };
    }

    if (success) existing.success++;
    else existing.fail++;
    existing.lastUsed = Date.now();
    if (server) existing.server = server;

    this.scores.set(key, existing);

    // Active Upstream Proxy IP Rotation
    if (!success && this.trialsFor(existing) >= this.minTrials && this.scoreFor(existing) < this.minScore) {
      if (!existing.isJailed) {
        existing.isJailed = true; // Temporary flag to prevent spamming rotation
        import('../core/metrics.js').then(m => m.proxyQuarantineCount.inc({ proxyServer: server || key })).catch(() => {});
        if (process.env.PROXY_ROTATE_URL_TEMPLATE) {
          const url = process.env.PROXY_ROTATE_URL_TEMPLATE.replace(/\[session\]/g, key).replace(/\[host\]/g, server || "");
          fetch(url).catch(err => log.warn(`[ProxyRotate] Failed to rotate ${key}: ${err instanceof Error ? err.message : String(err)}`));
        }
      }
    }

    // Subnet-Level Quarantine Intelligence (Item 24)
    if (!success && server) {
      const subnet = this.extractSubnet(server);
      if (subnet) {
        const now = Date.now();
        const info = this.subnetFailures.get(subnet) || { count: 0, lastFail: 0, banLevel: 0 };
        // Reset count and banLevel if older than 1 hour (allows recovery)
        if (now - info.lastFail > 60 * 60 * 1000) {
          info.count = 0;
          info.banLevel = 0;
        }
        info.count++;
        info.lastFail = now;
        this.subnetFailures.set(subnet, info);

        // Quarantine /24 subnet if 3+ consecutive failures across different IPs
        if (info.count >= 3) {
          info.banLevel++;
          // Exponential backoff: 5, 15, 60, 240 mins (capped at 4 hours)
          const banMinutes = [5, 15, 60, 240][Math.min(info.banLevel - 1, 3)] || 240;
          const banDurationMs = banMinutes * 60 * 1000;

          const pattern = new RegExp(`//${subnet.replace(/\./g, '\\.')}\\.`);
          this.patternBlacklist.set(pattern, now + banDurationMs);
          log.warn(`Subnet quarantine triggered for ${subnet}.x (/24) for ${banMinutes} minutes (level ${info.banLevel}).`);

          info.count = 0; // Reset consecutive fail count but maintain banLevel
        }
      }
    } else if (success && server) {
      const subnet = this.extractSubnet(server);
      if (subnet) this.subnetFailures.delete(subnet);
    }

    if (this.scores.size > this.maxEntries) {
      // Map iterates in insertion order. The first item is the oldest.
      const firstKey = this.scores.keys().next().value;
      if (firstKey !== undefined) {
        this.scores.delete(firstKey);
      }
    }
  }

  /** Laplace-smoothed score: gives unseen proxies a chance, penalises losers. Decays older scores using a 2-hour half-life. */
  private scoreFor(s: ProxyScore): number {
    const ageMs = Date.now() - s.lastUsed;
    const halfLifeMs = 2 * 60 * 60 * 1000; // 2 hours
    const decay = Math.pow(0.5, ageMs / halfLifeMs);
    const effSuccess = s.success * decay;
    const effFail = s.fail * decay;
    return effSuccess / (effSuccess + effFail + 1);
  }

  private trialsFor(s: ProxyScore): number {
    const ageMs = Date.now() - s.lastUsed;
    const halfLifeMs = 2 * 60 * 60 * 1000;
    const decay = Math.pow(0.5, ageMs / halfLifeMs);
    return (s.success + s.fail) * decay;
  }

  /**
   * Returns a detailed list of all tracked proxies and their current health/quarantine status.
   * Useful for UI visualization.
   */
  getDetailedScores(): ProxyHealthInfo[] {
    const arr: ProxyHealthInfo[] = [];
    for (const [key, s] of this.scores.entries()) {
      const trials = this.trialsFor(s);
      const score = this.scoreFor(s);
      const isJailed = trials >= this.minTrials && score < this.minScore;
      arr.push({
        key,
        server: s.server || key,
        success: s.success,
        fail: s.fail,
        trials,
        score,
        isJailed,
        lastUsed: s.lastUsed
      });
    }
    // Sort so jailed are at the bottom, then by highest score first
    return arr.sort((a, b) => {
      if (a.isJailed !== b.isJailed) return a.isJailed ? 1 : -1;
      return b.score - a.score;
    });
  }

  /**
   * Weighted random selection over the candidate pool. Quarantined proxies
   * (trials >= minTrials && score < minScore) get weight 0. Unknown proxies
   * get a neutral baseline weight (avg of seen scores, capped at 0.5) so
   * they can compete fairly with the established pool.
   * Falls back to raw smoothed weights if every candidate is quarantined,
   * so we never return undefined when candidates exist.
   * If targetCountry is provided, matching proxies receive a 2x weight boost (Item 22).
   */
  weightedPick(pool: ProxyEntry[], exclude: string[] = [], targetCountry?: string): ProxyEntry | undefined {
    if (pool.length === 0) return undefined;

    // Precompute keys and filter out excluded proxies in one pass.
    // This avoids repeatedly calling proxyEntryKey inside the loops.
    const excludeSet = exclude.length > 0 ? new Set(exclude) : null;
    const candidatePairs: { p: ProxyEntry; key: string }[] = [];

    for (const p of pool) {
      const key = proxyEntryKey(p);
      if (excludeSet && excludeSet.has(key)) continue;
      candidatePairs.push({ p, key });
    }

    if (candidatePairs.length === 0) return undefined;

    // Neutral baseline for unknown proxies — average of seen scores among CURRENT candidates, capped at 0.5.
    // This prevents historical scores of dead/removed proxies from dragging down the baseline for fresh proxies.
    let sumSeen = 0;
    let countSeen = 0;
    for (const { key } of candidatePairs) {
      const s = this.scores.get(key);
      if (s) {
        sumSeen += this.scoreFor(s);
        countSeen++;
      }
    }
    const avgSeen = countSeen > 0 ? sumSeen / countSeen : 0.5;
    // Give unknown proxies at least a minimal baseline (e.g. 0.2) so they can out-compete 0-weighted quarantined proxies.
    const unknownWeight = Math.max(0.2, Math.min(0.5, avgSeen));

    const now = Date.now();
    for (const [pattern, expiry] of this.patternBlacklist.entries()) {
      if (now > expiry) {
        this.patternBlacklist.delete(pattern);
      }
    }

    const computeWeight = (key: string, quarantineEnabled: boolean): number => {
      if (quarantineEnabled) {
        for (const pattern of this.patternBlacklist.keys()) {
          if (pattern.test(key)) {
            return 0; // Temporarily banned via pattern/subnet block
          }
        }
      }

      const s = this.scores.get(key);
      if (!s) {
        if (targetCountry && detectCountryFromProxy(key) === targetCountry) return unknownWeight * 2;
        return unknownWeight;
      }
      if (quarantineEnabled && this.trialsFor(s) >= this.minTrials && this.scoreFor(s) < this.minScore) {
        return 0;
      }
      let weight = this.scoreFor(s);
      if (targetCountry && detectCountryFromProxy(key) === targetCountry) {
        weight *= 2; // boost geo-aligned proxies
      }
      return weight;
    };

    // First pass: with quarantine. If everything zero, retry without.
    let weights = candidatePairs.map(({ key }) => computeWeight(key, true));
    let total = weights.reduce((a, b) => a + b, 0);
    if (total === 0) {
      weights = candidatePairs.map(({ key }) => computeWeight(key, false));
      total = weights.reduce((a, b) => a + b, 0);
      // Still zero (e.g. all unknown with avgSeen=0): pick uniformly.
      if (total === 0) {
        return candidatePairs[Math.floor(Math.random() * candidatePairs.length)]!.p;
      }
    }

    let r = Math.random() * total;
    for (let i = 0; i < candidatePairs.length; i++) {
      const weight = weights[i];
      if (weight !== undefined) r -= weight;
      if (r <= 0) return candidatePairs[i]!.p;
    }
    return candidatePairs[candidatePairs.length - 1]!.p; // numerical-safety fallback
  }

  private saveTimeout: ReturnType<typeof setTimeout> | null = null;
  private pendingSave = false;

  /** Best-effort write of the scores map to a sidecar JSON file with debouncing (Item 23). */
  async saveScores(filePath: string): Promise<void> {
    this.pendingSave = true;
    if (this.saveTimeout) return; // Debounced

    this.saveTimeout = setTimeout(async () => {
      this.saveTimeout = null;
      if (!this.pendingSave) return;
      this.pendingSave = false;

      const arr = Array.from(this.scores.values());
      const tmpPath = `${filePath}.tmp`;
      try {
        await fs.promises.writeFile(tmpPath, JSON.stringify(arr, null, 2));
        await fs.promises.rename(tmpPath, filePath);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        log.warn(`Failed to save scores to ${filePath}: ${msg}`);
      }

      // Issue 17: Re-check after write — if new records arrived during the
      // async writeFile, pendingSave will be true again and we need to
      // re-arm the save to avoid silently losing data.
      if (this.pendingSave) {
        void this.saveScores(filePath);
      }
    }, 5000);
  }

  /** Best-effort load of scores from a sidecar JSON file. No-op if absent. */
  async loadScores(filePath: string): Promise<void> {
    if (!fs.existsSync(filePath)) return;
    try {
      const raw = await fs.promises.readFile(filePath, "utf-8");
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) {
        log.warn(`${filePath} is not an array — ignoring`);
        return;
      }
      this.scores.clear();
      for (const item of arr) {
        const key = item.key || (typeof item.server === "string" ? (item.server.includes("#") ? item.server : `${item.server}#""`) : null);
        if (key && typeof key === "string") {
          this.scores.set(key, {
            key,
            success: Number(item.success) || 0,
            fail: Number(item.fail) || 0,
            lastUsed: Number(item.lastUsed) || 0,
            server: typeof item.server === "string" ? item.server : undefined,
          });
        }
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      log.warn(`Failed to parse ${filePath}: ${msg}`);
    }
  }

  /** Diagnostics — number of tracked proxies. */
  size(): number {
    return this.scores.size;
  }

  /**
   * Temporarily ban a cluster of proxies (e.g. subnet, specific domain)
   * if multiple instances fail identically.
   */
  banPattern(pattern: RegExp, durationMs: number = 300000): void {
    this.patternBlacklist.set(pattern, Date.now() + durationMs);
    log.warn(`[ProxyScoreTracker] Subnet/Pattern ${pattern} banned for ${durationMs / 1000}s`);
  }
}