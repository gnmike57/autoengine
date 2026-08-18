/**
 * Redis Coordinator
 *
 * Central Redis coordinator for cross-agent state sharing:
 *   - Wicketkeeper token farming queue
 *   - Detection blacklist synchronization
 *   - Successful fingerprint profile sharing
 *
 * Design:
 *   - Redis is the DEFAULT primary store when REDIS_URL is set
 *   - Graceful degradation: all methods silently return defaults when
 *     Redis is unavailable (no errors, no connection attempts)
 *   - Connection is lazy — only established on first use
 *   - Auto-reconnect with exponential backoff
 *
 * Environment variable: REDIS_URL (e.g. "redis://localhost:6379")
 */

import { createLogger } from "../core/logger.js";

const log = createLogger("REDIS");

// ── Types ────────────────────────────────────────────────────────────────────

export interface RedisCoordinatorConfig {
  /** Redis connection URL. Falls back to REDIS_URL env var. */
  url?: string;
  /** Key prefix for namespacing (default: "stealth:") */
  keyPrefix?: string;
  /** Connection timeout in ms (default: 5000) */
  connectTimeoutMs?: number;
}

export interface FarmedToken {
  jwt: string;
  nonce: string;
  domain: string;
  createdAt: number;
  expiresAt: number;
}

// ── Defaults ─────────────────────────────────────────────────────────────────

const DEFAULT_KEY_PREFIX = "stealth:";
const DEFAULT_CONNECT_TIMEOUT = 5000;
const TOKEN_QUEUE_TTL_SECONDS = 600; // 10 minutes (JWT validity)
const BLACKLIST_TTL_SECONDS = 86400; // 24 hours

/** Minimal interface for the dynamically-imported ioredis client (optional dep) */
interface RedisClient {
  once(event: string, cb: (...args: any[]) => void): void;
  on(event: string, cb: (...args: any[]) => void): void;
  removeListener(event: string, cb: (...args: any[]) => void): void;
  lpush(key: string, ...values: string[]): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
  rpop(key: string): Promise<string | null>;
  llen(key: string): Promise<number>;
  sadd(key: string, ...members: string[]): Promise<number>;
  smembers(key: string): Promise<string[]>;
  ltrim(key: string, start: number, stop: number): Promise<string>;
  lrange(key: string, start: number, stop: number): Promise<string[]>;
  setex(key: string, seconds: number, value: string): Promise<string>;
  set(key: string, value: string): Promise<string | null>;
  get(key: string): Promise<string | null>;
  quit(): Promise<string>;
  disconnect(): void;
}

// ── Redis Coordinator ────────────────────────────────────────────────────────

export class RedisCoordinator {
  private readonly url: string | null;
  private readonly keyPrefix: string;
  private readonly connectTimeoutMs: number;
  private client: RedisClient | null = null;
  private connected = false;
  private connectionFailed = false;

  constructor(config: RedisCoordinatorConfig = {}) {
    this.url = config.url ?? process.env.REDIS_URL ?? null;
    this.keyPrefix = config.keyPrefix ?? DEFAULT_KEY_PREFIX;
    this.connectTimeoutMs = config.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT;

    if (this.url) {
      log.info(`[redis] Configured with URL: ${this.url.replace(/\/\/[^@]*@/, "//***@")}`);
    } else {
      log.info("[redis] No REDIS_URL — all operations will use file-backed fallback");
    }
  }

  // ── Connection management ──────────────────────────────────────────────

  /**
   * Check if Redis is available and connected.
   */
  get isAvailable(): boolean {
    return this.connected && this.client !== null;
  }

  /**
   * Lazy-connect to Redis. Only called on first use.
   */
  private connectPromise: Promise<boolean> | null = null;

  /**
   * Lazy-connect to Redis. Only called on first use.
   * Concurrent callers share the same connection attempt promise.
   */
  private async ensureConnection(): Promise<boolean> {
    if (this.connected && this.client) return true;
    if (this.connectionFailed || !this.url) return false;

    // If a connection attempt is in progress, await it instead of returning false
    if (this.connectPromise) return this.connectPromise;

    this.connectPromise = this._doConnect();
    try {
      return await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }

  private async _doConnect(): Promise<boolean> {
    try {
      // Dynamic import of ioredis (optional dependency)
      // Handle both ESM and CJS exports
      const ioredisModule = await import("ioredis");

      const RedisConstructor = (ioredisModule as Record<string, unknown>).default ?? ioredisModule;

      this.client = new (RedisConstructor as new (...args: unknown[]) => RedisClient)(this.url, {
        connectTimeout: this.connectTimeoutMs,
        maxRetriesPerRequest: 2,
        retryStrategy: (times: number) => {
          if (times > 3) {
            log.warn("[redis] Max retries exceeded, marking connection failed");
            this.connectionFailed = true;
            return null;
          }
          return Math.min(times * 500, 3000);
        },
        lazyConnect: false,
      });

      // Wait for connection
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error("Connection timeout"));
        }, this.connectTimeoutMs);

        const onReady = () => {
          clearTimeout(timer);
          this.client!.removeListener("error", onError);
          // Attach permanent error listener to prevent unhandled process crashes on dropped connections
          this.client!.on("error", (err: Error) => log.warn(`[redis] connection error: ${err.message}`));
          resolve();
        };

        const onError = (err: Error) => {
          clearTimeout(timer);
          this.client!.removeListener("ready", onReady);
          reject(err);
        };

        this.client!.once("ready", onReady);
        this.client!.once("error", onError);
      });

      this.connected = true;
      log.info("[redis] Connected successfully");
      return true;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`[redis] Connection failed: ${msg} — falling back to file storage`);
      this.connectionFailed = true;
      this.client = null;
      return false;
    }
  }

  private key(suffix: string): string {
    return `${this.keyPrefix}${suffix}`;
  }

  // ── Token farming queue ────────────────────────────────────────────────

  /**
   * Push a farmed Wicketkeeper token to the Redis queue.
   */
  async pushToken(domain: string, jwt: string, nonce: string): Promise<void> {
    if (!(await this.ensureConnection())) return;

    const token: FarmedToken = {
      jwt, nonce, domain,
      createdAt: Date.now(),
      expiresAt: Date.now() + (TOKEN_QUEUE_TTL_SECONDS * 1000),
    };

    try {
      const queueKey = this.key(`wk:tokens:${domain}`);
      await this.client!.lpush(queueKey, JSON.stringify(token));
      await this.client!.expire(queueKey, TOKEN_QUEUE_TTL_SECONDS);
      log.info(`[redis] Token pushed: ${queueKey}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`[redis] pushToken failed: ${msg}`);
    }
  }

  /**
   * Pop a pre-farmed token from the queue.
   * Automatically evicts expired tokens.
   */
  async popToken(domain: string): Promise<FarmedToken | null> {
    if (!(await this.ensureConnection())) return null;

    const now = Date.now();
    const queueKey = this.key(`wk:tokens:${domain}`);

    try {
      // Pop from the right (FIFO order)
      let attempts = 0;
      while (attempts < 10) {
        const raw = await this.client!.rpop(queueKey);
        if (!raw) return null;

        const token = JSON.parse(raw) as FarmedToken;
        if (token.expiresAt > now) {
          return token;
        }
        // Expired — continue popping
        attempts++;
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`[redis] popToken failed: ${msg}`);
    }
    return null;
  }

  /**
   * Get queue depth for a domain's token queue.
   */
  async getQueueDepth(queueKey: string): Promise<number> {
    if (!(await this.ensureConnection())) return 0;
    try {
      return await this.client!.llen(this.key(queueKey));
    } catch {
      return 0;
    }
  }

  // ── Detection blacklist ────────────────────────────────────────────────

  /**
   * Push a blacklisted detection vector to Redis.
   */
  async pushBlacklistedVector(vector: string, ttlSeconds: number = BLACKLIST_TTL_SECONDS): Promise<void> {
    if (!(await this.ensureConnection())) return;

    try {
      const setKey = this.key("blacklisted_vectors");
      await this.client!.sadd(setKey, vector);
      await this.client!.expire(setKey, ttlSeconds);
      log.info(`[redis] Vector blacklisted: ${vector}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`[redis] pushBlacklistedVector failed: ${msg}`);
    }
  }

  /**
   * Get all currently blacklisted vectors from Redis.
   */
  async getBlacklistedVectors(): Promise<string[]> {
    if (!(await this.ensureConnection())) return [];

    try {
      const setKey = this.key("blacklisted_vectors");
      return await this.client!.smembers(setKey);
    } catch {
      return [];
    }
  }

  // ── Successful profiles ────────────────────────────────────────────────

  /**
   * Push a successful fingerprint profile to Redis for blending.
   */
  async pushSuccessfulProfile(profile: Record<string, unknown>): Promise<void> {
    if (!(await this.ensureConnection())) return;

    try {
      const listKey = this.key("successful_fingerprints");
      await this.client!.lpush(listKey, JSON.stringify(profile));
      // Keep only last 500 profiles
      await this.client!.ltrim(listKey, 0, 499);
      log.info("[redis] Profile pushed to successful_fingerprints");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`[redis] pushSuccessfulProfile failed: ${msg}`);
    }
  }

  /**
   * Get N successful profiles from Redis for blending.
   */
  async getSuccessfulProfiles(count: number): Promise<Record<string, unknown>[]> {
    if (!(await this.ensureConnection())) return [];

    try {
      const listKey = this.key("successful_fingerprints");
      const raw = await this.client!.lrange(listKey, 0, count - 1);
      return raw.map((r: string) => JSON.parse(r) as Record<string, unknown>);
    } catch {
      return [];
    }
  }

  // ── Generic operations ─────────────────────────────────────────────────

  /**
   * Set a key with TTL.
   */
  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    if (!(await this.ensureConnection())) return;
    try {
      if (ttlSeconds) {
        await this.client!.setex(this.key(key), ttlSeconds, value);
      } else {
        await this.client!.set(this.key(key), value);
      }
    } catch {
      // Silent fallback
    }
  }

  /**
   * Get a value by key.
   */
  async get(key: string): Promise<string | null> {
    if (!(await this.ensureConnection())) return null;
    try {
      return await this.client!.get(this.key(key));
    } catch {
      return null;
    }
  }

  /**
   * Gracefully disconnect.
   */
  async disconnect(): Promise<void> {
    if (this.client) {
      try {
        await this.client.quit();
      } catch {
        try {
          this.client.disconnect();
        } catch {
          // Force disconnect
        }
      }
      this.client = null;
      this.connected = false;
      log.info("[redis] Disconnected");
    }
  }
}

// ── Singleton ────────────────────────────────────────────────────────────────

let _singleton: RedisCoordinator | undefined;

export function getRedisCoordinator(config?: RedisCoordinatorConfig): RedisCoordinator {
  if (!_singleton) {
    _singleton = new RedisCoordinator(config);
  }
  return _singleton;
}

/**
 * Check if Redis is configured (not necessarily connected).
 */
export function isRedisConfigured(): boolean {
  return !!(process.env.REDIS_URL);
}

export function _resetRedisCoordinator(): void {
  if (_singleton) {
    void _singleton.disconnect();
  }
  _singleton = undefined;
}
