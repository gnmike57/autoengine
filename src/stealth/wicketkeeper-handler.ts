
/**
 * Wicketkeeper.io Proof-of-Work Bypass Handler
 *
 * 3-tier strategy for handling Wicketkeeper PoW challenges:
 *   Tier 1: Passive MutationObserver wait for DOM-populated token
 *   Tier 2: Async token farming via Redis queue (or file-based fallback)
 *   Tier 3: Natively compiled solver binary (Rust/Go) as child process
 *
 * Project rules mandate:
 *   - No arbitrary sleeps (use MutationObserver/event-driven patterns)
 *   - 30-second watchdog on all async operations
 *   - Redis queue for (JWT, nonce) pair caching, async from main thread
 *   - Explicit waiting loop for .wicketkeeper hidden class token
 *
 * The 10-minute JWT validity window is exploited by pre-farming tokens
 * in background workers before they're needed by active sessions.
 */

import { type Page } from "playwright-core";
import fs from "node:fs";

import { NativePoWPool } from "../services/pow-pool.js";
import { createLogger } from "../core/logger.js";

const log = createLogger("WICKETKEEPER");

// ── Types ────────────────────────────────────────────────────────────────────

export interface WicketkeeperToken {
  jwt: string;
  nonce: string;
  domain: string;
  createdAt: number;     // epoch ms
  expiresAt: number;     // epoch ms (10-minute window)
}

export interface WicketkeeperConfig {
  /** Path to the PoW solver binary (default: "pow-solver/target/release/pow-solver") */
  solverBinaryPath?: string;
  /** Path to the file-based token queue (used when Redis unavailable) */
  tokenQueuePath?: string;
  /** Maximum time to wait for passive token (default 30000ms) */
  passiveTimeoutMs?: number;
  /** Redis coordinator instance (optional — falls back to file queue) */
  redis?: import("../services/redis-coordinator.js").RedisCoordinator | null;
}

// ── Defaults ─────────────────────────────────────────────────────────────────

const DEFAULT_SOLVER_PATH = process.platform === "win32"
  ? "pow-solver/target/release/pow-solver.exe"
  : "pow-solver/target/release/pow-solver";
const DEFAULT_TOKEN_QUEUE_PATH = "wicketkeeper-tokens.json";
const DEFAULT_PASSIVE_TIMEOUT = 30_000; // 30s watchdog per Rule §2
const TOKEN_VALIDITY_MS = 10 * 60 * 1000; // 10-minute JWT window

// ── Tier 1: Passive MutationObserver Wait ────────────────────────────────────

/**
 * Passively wait for Wicketkeeper to compute and populate its token
 * in the DOM. Uses MutationObserver (not polling) for efficiency.
 *
 * Returns the token string, or null if the 30-second watchdog fires.
 */
export async function waitForWicketkeeperToken(
  page: Page,
  timeoutMs: number = DEFAULT_PASSIVE_TIMEOUT,
): Promise<string | null> {
  log.info(`[Tier 1] Waiting for Wicketkeeper token (timeout: ${timeoutMs}ms)`);

  try {
    const token = await page.evaluate((timeout: number) => {
      return new Promise<string | null>((resolve) => {
        // Check if token is already populated
        const existing = document.querySelector<HTMLInputElement>(
          'input[class*="wicketkeeper"], input[name*="wicketkeeper"], [data-wicketkeeper]'
        );
        if (existing?.value && existing.value.length > 10) {
          resolve(existing.value);
          return;
        }

        // 30-second watchdog timer
        const watchdog = setTimeout(() => {
          observer.disconnect();
          resolve(null);
        }, timeout);

        // MutationObserver targeting the hidden input population
        const observer = new MutationObserver((mutations) => {
          for (const mutation of mutations) {
            // Check added nodes
            for (const node of mutation.addedNodes) {
              if (node instanceof HTMLElement) {
                const input = node.querySelector?.<HTMLInputElement>(
                  'input[class*="wicketkeeper"], input[name*="wicketkeeper"], [data-wicketkeeper]'
                );
                if (input?.value && input.value.length > 10) {
                  clearTimeout(watchdog);
                  observer.disconnect();
                  resolve(input.value);
                  return;
                }
              }
            }

            // Check attribute changes on existing elements
            if (mutation.type === "attributes" && mutation.target instanceof HTMLInputElement) {
              const target = mutation.target;
              if (
                (target.className.includes("wicketkeeper") ||
                 target.name?.includes("wicketkeeper") ||
                 target.hasAttribute("data-wicketkeeper")) &&
                target.value &&
                target.value.length > 10
              ) {
                clearTimeout(watchdog);
                observer.disconnect();
                resolve(target.value);
                return;
              }
            }

            // Check character data changes (value mutations in text nodes)
            if (mutation.type === "characterData") {
              const parent = mutation.target.parentElement;
              if (parent instanceof HTMLElement) {
                // Tokens can be placed in inputs (value) or spans (textContent)
                const text = (parent instanceof HTMLInputElement) ? parent.value : parent.textContent;
                if (text && text.length > 10) {
                  clearTimeout(watchdog);
                  observer.disconnect();
                  resolve(text);
                  return;
                }
              }
            }
          }
        });

        observer.observe(document.body || document.documentElement, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ["value", "data-wicketkeeper"],
          characterData: true,
        });
      });
    }, timeoutMs);

    if (token) {
      log.info(`[Tier 1] Token acquired passively (${token.length} chars)`);
    } else {
      log.warn("[Tier 1] Passive wait timed out");
    }
    return token;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`[Tier 1] Failed: ${msg}`);
    return null;
  }
}

// ── Tier 2: Async Token Farming ──────────────────────────────────────────────

/**
 * Token farm that pre-computes Wicketkeeper tokens in the background.
 * Uses Redis as the primary queue, with file-based fallback.
 */
export class WicketkeeperTokenFarm {
  private readonly tokenQueuePath: string;
  private readonly redis: import("../services/redis-coordinator.js").RedisCoordinator | null;

  constructor(config: WicketkeeperConfig = {}) {
    this.tokenQueuePath = config.tokenQueuePath ?? DEFAULT_TOKEN_QUEUE_PATH;
    this.redis = config.redis ?? null;
  }

  /**
   * Push a farmed token to the queue.
   */
  async pushToken(token: WicketkeeperToken): Promise<void> {
    const redisKey = `wk:tokens:${token.domain}`;

    // Try Redis first
    if (this.redis) {
      try {
        await this.redis.pushToken(token.domain, token.jwt, token.nonce);
        log.info(`[Tier 2] Token pushed to Redis: ${redisKey}`);
        return;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(`[Tier 2] Redis push failed, falling back to file: ${msg}`);
      }
    }

    // File-based fallback
    this.pushToFile(token);
  }

  /**
   * Pop a pre-farmed token from the queue.
   * Returns null if no valid tokens are available.
   */
  async popToken(domain: string): Promise<WicketkeeperToken | null> {
    const now = Date.now();

    // Try Redis first
    if (this.redis) {
      try {
        const result = await this.redis.popToken(domain);
        if (result) {
          // Verify it's not expired
          if (result.expiresAt > now) {
            log.info(`[Tier 2] Token popped from Redis: ${domain}`);
            return result;
          }
          log.warn(`[Tier 2] Expired token from Redis, discarding`);
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(`[Tier 2] Redis pop failed: ${msg}`);
      }
    }

    // File-based fallback
    return this.popFromFile(domain);
  }

  /**
   * Get the current queue depth for a domain.
   */
  async getQueueDepth(domain: string): Promise<number> {
    if (this.redis) {
      try {
        return await this.redis.getQueueDepth(`wk:tokens:${domain}`);
      } catch {
        // Fall through to file
      }
    }
    return this.getFileQueueDepth(domain);
  }

  // ── File-based queue internals ──────────────────────────────────────────

  private pushToFile(token: WicketkeeperToken): void {
    try {
      const tokens = this.loadFileQueue();
      tokens.push(token);
      fs.writeFileSync(this.tokenQueuePath, JSON.stringify(tokens, null, 2), "utf-8");
      log.info(`[Tier 2] Token pushed to file queue: ${token.domain}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`[Tier 2] File push failed: ${msg}`);
    }
  }

  private popFromFile(domain: string): WicketkeeperToken | null {
    try {
      const tokens = this.loadFileQueue();
      const now = Date.now();

      // Find first valid (non-expired) token for this domain
      const idx = tokens.findIndex(
        t => t.domain === domain && t.expiresAt > now,
      );

      if (idx === -1) return null;

      const [token] = tokens.splice(idx, 1);
      // Also evict all expired tokens while we're here
      const cleaned = tokens.filter(t => t.expiresAt > now);
      fs.writeFileSync(this.tokenQueuePath, JSON.stringify(cleaned, null, 2), "utf-8");

      log.info(`[Tier 2] Token popped from file queue: ${domain}`);
      return token ?? null;
    } catch {
      return null;
    }
  }

  private getFileQueueDepth(domain: string): number {
    try {
      const tokens = this.loadFileQueue();
      const now = Date.now();
      return tokens.filter(t => t.domain === domain && t.expiresAt > now).length;
    } catch {
      return 0;
    }
  }

  private loadFileQueue(): WicketkeeperToken[] {
    try {
      if (fs.existsSync(this.tokenQueuePath)) {
        return JSON.parse(fs.readFileSync(this.tokenQueuePath, "utf-8")) as WicketkeeperToken[];
      }
    } catch {
      // Start fresh
    }
    return [];
  }
}

// ── Tier 3: Native PoW Solver ────────────────────────────────────────────────

/**
 * Interface to a natively compiled PoW solver (Rust/Go binary).
 * Falls back to Tier 1 passive wait if the binary is not available.
 */
export class NativePoWSolver {
  private readonly pool: NativePoWPool;

  constructor(_binaryPath: string = DEFAULT_SOLVER_PATH) {
    // We now use the Node.js native worker pool instead of external binary
    this.pool = new NativePoWPool(2);
    log.info(`[Tier 3] Native Node.js Worker PoW solver initialized`);
  }

  get isAvailable(): boolean {
    return true; // The native Node.js solver is always available
  }

  /**
   * Solve a PoW challenge using the worker pool.
   *
   * @param jwt - JWT from the Wicketkeeper challenge endpoint
   * @param difficulty - Difficulty level (number of leading zeros)
   * @returns The nonce solution, or null on failure
   */
  async solve(jwt: string, difficulty: number): Promise<string | null> {
    return new Promise<string | null>((resolve) => {
      const timeout = setTimeout(() => {
        log.error("[Tier 3] Solver timed out after 30s");
        resolve(null);
      }, 30_000);

      this.pool.solve(jwt, difficulty)
        .then(nonce => {
          clearTimeout(timeout);
          if (nonce) {
            log.info(`[Tier 3] Solution found via pool: ${nonce.substring(0, 16)}...`);
            resolve(nonce);
          } else {
            log.error("[Tier 3] Solver returned empty output");
            resolve(null);
          }
        })
        .catch(err => {
          clearTimeout(timeout);
          log.error(`[Tier 3] Execution failed: ${err instanceof Error ? err.message : String(err)}`);
          resolve(null);
        });
    });
  }
}

// ── Lazy solver singleton ────────────────────────────────────────────────────

let _solver: NativePoWSolver | undefined;

function getSolver(binaryPath?: string): NativePoWSolver {
  if (!_solver) {
    _solver = new NativePoWSolver(binaryPath);
  }
  return _solver;
}

export async function handleWicketkeeper(
  page: Page,
  domain: string,
  config: WicketkeeperConfig = {},
): Promise<string | null> {
  const farm = getTokenFarm(config);
  const solver = getSolver(config.solverBinaryPath);
  const passiveTimeout = config.passiveTimeoutMs ?? DEFAULT_PASSIVE_TIMEOUT;

  // ── Tier 2: Check pre-farmed tokens first (fastest path) ──
  const farmedToken = await farm.popToken(domain);
  if (farmedToken) {
    log.info(`[orchestrator] Using pre-farmed token for ${domain}`);
    return farmedToken.jwt;
  }

  // ── Tier 3: Native solver (if binary exists) ──
  if (solver.isAvailable) {
    // Extract challenge from page if possible
    const challengeData = await extractChallenge(page);
    if (challengeData) {
      const nonce = await solver.solve(challengeData.jwt, challengeData.difficulty);
      if (nonce) {
        // Cache the solved token for future use
        await farm.pushToken({
          jwt: challengeData.jwt,
          nonce,
          domain,
          createdAt: Date.now(),
          expiresAt: Date.now() + TOKEN_VALIDITY_MS,
        });
        return challengeData.jwt;
      }
    }
  }

  // ── Tier 1: Passive DOM wait (final fallback) ──
  return waitForWicketkeeperToken(page, passiveTimeout);
}

// ── Challenge extraction helper ──────────────────────────────────────────────

interface ChallengeData {
  jwt: string;
  difficulty: number;
}

async function extractChallenge(page: Page): Promise<ChallengeData | null> {
  try {
    return await page.evaluate(() => {
      // Look for Wicketkeeper challenge data in the DOM
      const challengeEl = document.querySelector<HTMLElement>(
        "[data-wk-challenge], [data-wicketkeeper-challenge]"
      );
      if (challengeEl) {
        const jwt = challengeEl.getAttribute("data-wk-jwt") ??
                     challengeEl.getAttribute("data-jwt") ?? "";
        const difficulty = parseInt(
          challengeEl.getAttribute("data-wk-difficulty") ??
          challengeEl.getAttribute("data-difficulty") ?? "20",
          10,
        );
        if (jwt) return { jwt, difficulty };
      }

      // Look in script tags for challenge config
      const scripts = document.querySelectorAll("script");
      for (const script of scripts) {
        const text = script.textContent ?? "";
        const jwtMatch = text.match(/wicketkeeper[^"]*jwt["']?\s*[:=]\s*["']([^"']+)/i);
        const diffMatch = text.match(/wicketkeeper[^"]*difficulty["']?\s*[:=]\s*(\d+)/i);
        if (jwtMatch?.[1]) {
          return {
            jwt: jwtMatch[1],
            difficulty: diffMatch?.[1] ? parseInt(diffMatch[1], 10) : 20,
          };
        }
      }

      return null;
    });
  } catch {
    return null;
  }
}

// ── Singleton factory ────────────────────────────────────────────────────────

let _farm: WicketkeeperTokenFarm | undefined;

export function getTokenFarm(config?: WicketkeeperConfig): WicketkeeperTokenFarm {
  if (!_farm) {
    _farm = new WicketkeeperTokenFarm(config);
  }
  return _farm;
}

export function _resetTokenFarm(): void {
  _farm = undefined;
}
