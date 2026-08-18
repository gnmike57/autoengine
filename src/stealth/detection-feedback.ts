/**
 * Detection Feedback Loop
 *
 * Tracks fingerprint detection vectors that cause blocks and maintains
 * a blacklist with 24-hour TTL. When a session is blocked, the suspected
 * detection vector (e.g. "css_supports_mismatch", "webgl_vendor_mismatch",
 * "recaptcha_high_risk") is pushed to the blacklist. Subsequent sessions
 * consult the blacklist to avoid using known-bad configurations.
 *
 * Integrates with the fingerprint rotation engine and framework config
 * to skip blacklisted vectors when building profiles.
 */

import fs from "node:fs";
import type { RedisCoordinator } from "../services/redis-coordinator.js";
import { ResearchOrchestrator } from "../intelligence/research-orchestrator.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface BlacklistEntry {
  vector: string;
  reason: string;
  target?: string;       // e.g. "ignitioncasino.ooo"
  backend?: string;      // e.g. "cloak-headless"
  createdAt: number;     // epoch ms
  expiresAt: number;     // epoch ms
  hitCount: number;      // number of times this vector triggered a block
}

export interface DetectionEvent {
  vector: string;
  reason: string;
  target?: string;
  backend?: string;
  email?: string;
  timestamp?: number;
}

export interface FeedbackOptions {
  /** Path to persist the blacklist JSON. */
  dbPath?: string;
  /** Blacklist TTL in hours (default 24). */
  ttlHours?: number;
  /** Optional logger. */
  log?: (msg: string) => void;
  /** Optional Redis coordinator for cluster-wide sync. */
  redis?: RedisCoordinator | null;
}

// ── Well-known detection vectors ─────────────────────────────────────────────

export const DETECTION_VECTORS = {
  CSS_SUPPORTS_MISMATCH: "css_supports_mismatch",
  WEBGL_VENDOR_MISMATCH: "webgl_vendor_mismatch",
  CANVAS_NOISE_DETECTED: "canvas_noise_detected",
  WEBDRIVER_DETECTED: "webdriver_detected",
  RECAPTCHA_HIGH_RISK: "recaptcha_high_risk",
  RECAPTCHA_LOW_SCORE: "recaptcha_low_score",
  TIMEZONE_MISMATCH: "timezone_mismatch",
  BATTERY_API_MISSING: "battery_api_missing",
  DEVICE_MEMORY_MISMATCH: "device_memory_mismatch",
  HARDWARE_CONCURRENCY_MISMATCH: "hardware_concurrency_mismatch",
  PERMISSIONS_API_ANOMALY: "permissions_api_anomaly",
  AUDIO_CONTEXT_ANOMALY: "audio_context_anomaly",
  FONT_ENUMERATION_MISMATCH: "font_enumeration_mismatch",
  WEBRTC_LEAK: "webrtc_leak",
  HEADLESS_DETECTED: "headless_detected",
  AUTOMATION_CONTROLLED: "automation_controlled",
  RATE_LIMITED: "rate_limited",
  IP_REPUTATION_BAD: "ip_reputation_bad",
  SESSION_REPLAY_DETECTED: "session_replay_detected",
  BEHAVIORAL_SCORE_LOW: "behavioral_score_low",
} as const;

export type DetectionVector = typeof DETECTION_VECTORS[keyof typeof DETECTION_VECTORS];

// ── Defaults ─────────────────────────────────────────────────────────────────

const DEFAULT_DB_PATH = "detection-blacklist.json";
const DEFAULT_TTL_HOURS = 24;

// ── Persistence ──────────────────────────────────────────────────────────────

function loadBlacklist(filePath: string): BlacklistEntry[] {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, "utf-8")) as BlacklistEntry[];
    }
  } catch {
    // Start fresh
  }
  return [];
}

function saveBlacklist(entries: BlacklistEntry[], filePath: string): void {
  try {
    fs.writeFileSync(filePath, JSON.stringify(entries, null, 2), "utf-8");
  } catch {
    // Non-critical
  }
}

// ── Feedback engine ──────────────────────────────────────────────────────────

export class DetectionFeedbackLoop {
  private readonly dbPath: string;
  private readonly ttlMs: number;
  private readonly log: (msg: string) => void;
  private readonly redis: RedisCoordinator | null;
  private entries: BlacklistEntry[];

  constructor(opts: FeedbackOptions = {}) {
    this.dbPath = opts.dbPath ?? DEFAULT_DB_PATH;
    this.ttlMs = (opts.ttlHours ?? DEFAULT_TTL_HOURS) * 60 * 60 * 1000;
    this.log = opts.log ?? (() => {});
    this.redis = opts.redis ?? null;
    this.entries = loadBlacklist(this.dbPath);
    this.evictExpired();
  }

  /**
   * Record a detection event — adds or increments the blacklist entry
   * for the given vector.
   */
  recordDetection(event: DetectionEvent): void {
    const now = event.timestamp ?? Date.now();
    const key = this.entryKey(event.vector, event.target, event.backend);

    const existing = this.entries.find(e => this.entryKey(e.vector, e.target, e.backend) === key);

    if (existing) {
      existing.hitCount++;
      existing.expiresAt = now + this.ttlMs; // Refresh TTL on repeat hit
      existing.reason = event.reason;
      this.log(`[feedback] Incremented: ${event.vector} (${existing.hitCount} hits)`);
    } else {
      this.entries.push({
        vector: event.vector,
        reason: event.reason,
        target: event.target,
        backend: event.backend,
        createdAt: now,
        expiresAt: now + this.ttlMs,
        hitCount: 1,
      });
      this.log(`[feedback] Blacklisted: ${event.vector} — ${event.reason}`);
    }

    this.persist();

    // Sync to Redis if available
    if (this.redis) {
      void this.redis.pushBlacklistedVector(
        event.vector,
        Math.floor(this.ttlMs / 1000),
      ).catch(() => {});
    }

    // Trigger AutoResearchClaw to research a fix for this detection vector
    if (event.target) {
      try {
        const orchestrator = new ResearchOrchestrator({ log: (m) => this.log(m) });
        orchestrator.registerTarget(event.target, [event.vector]);
        void orchestrator.research(event.target).catch((e) => {
          this.log(`[feedback] ARC trigger failed: ${e instanceof Error ? e.message : String(e)}`);
        });
      } catch (e) {
        this.log(`[feedback] Failed to instantiate ARC: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  /**
   * Check if a detection vector is currently blacklisted.
   */
  isBlacklisted(vector: string, target?: string, backend?: string): boolean {
    this.evictExpired();
    const now = Date.now();
    return this.entries.some(e =>
      e.vector === vector &&
      e.expiresAt > now &&
      (!target || !e.target || e.target === target) &&
      (!backend || !e.backend || e.backend === backend),
    );
  }

  /**
   * Get all active (non-expired) blacklisted vectors.
   */
  getActiveBlacklist(target?: string, backend?: string): BlacklistEntry[] {
    this.evictExpired();
    const now = Date.now();
    return this.entries.filter(e =>
      e.expiresAt > now &&
      (!target || !e.target || e.target === target) &&
      (!backend || !e.backend || e.backend === backend),
    );
  }

  /**
   * Get vectors to avoid for a specific target/backend combination.
   * Returns the set of vector strings that should be skipped.
   */
  getVectorsToAvoid(target?: string, backend?: string): Set<string> {
    const active = this.getActiveBlacklist(target, backend);
    return new Set(active.map(e => e.vector));
  }

  /**
   * Clear a specific vector from the blacklist (e.g. after a fix is deployed).
   */
  clearVector(vector: string, target?: string): void {
    this.entries = this.entries.filter(e =>
      !(e.vector === vector && (!target || e.target === target)),
    );
    this.persist();
    this.log(`[feedback] Cleared: ${vector}${target ? ` for ${target}` : ""}`);
  }

  /**
   * Clear all blacklist entries.
   */
  clearAll(): void {
    this.entries = [];
    this.persist();
    this.log("[feedback] Cleared all blacklist entries");
  }

  /** Number of active entries. */
  get size(): number {
    this.evictExpired();
    return this.entries.filter(e => e.expiresAt > Date.now()).length;
  }

  /** Full snapshot for dashboard. */
  snapshot(): BlacklistEntry[] {
    return [...this.entries];
  }

  // ── Internals ──────────────────────────────────────────────────────────

  private entryKey(vector: string, target?: string, backend?: string): string {
    return `${vector}|${target ?? "*"}|${backend ?? "*"}`;
  }

  private evictExpired(): void {
    const now = Date.now();
    const before = this.entries.length;
    this.entries = this.entries.filter(e => e.expiresAt > now);
    if (this.entries.length < before) {
      this.persist();
    }
  }

  private persistTimeout: ReturnType<typeof setTimeout> | null = null;

  private persist(): void {
    if (this.persistTimeout) return;
    this.persistTimeout = setTimeout(() => {
      saveBlacklist(this.entries, this.dbPath);
      this.persistTimeout = null;
    }, 2000);
  }

  /** Immediately persist entries to disk (bypasses debounce). */
  flush(): void {
    if (this.persistTimeout) {
      clearTimeout(this.persistTimeout);
      this.persistTimeout = null;
    }
    saveBlacklist(this.entries, this.dbPath);
  }

  /**
   * Sync local blacklist entries TO Redis for cluster-wide sharing.
   */
  async syncToRedis(): Promise<void> {
    if (!this.redis) return;
    const active = this.getActiveBlacklist();
    for (const entry of active) {
      const ttlSeconds = Math.max(1, Math.floor((entry.expiresAt - Date.now()) / 1000));
      await this.redis.pushBlacklistedVector(entry.vector, ttlSeconds).catch(() => {});
    }
    this.log(`[feedback] Synced ${active.length} entries to Redis`);
  }

  /**
   * Sync blacklisted vectors FROM Redis into local store.
   */
  async syncFromRedis(): Promise<void> {
    if (!this.redis) return;
    const vectors = await this.redis.getBlacklistedVectors().catch(() => [] as string[]);
    const now = Date.now();
    let added = 0;
    for (const vector of vectors) {
      const key = this.entryKey(vector);
      const exists = this.entries.some(e => this.entryKey(e.vector) === key);
      if (!exists) {
        this.entries.push({
          vector,
          reason: "synced from Redis",
          createdAt: now,
          expiresAt: now + this.ttlMs,
          hitCount: 1,
        });
        added++;
      }
    }
    if (added > 0) {
      this.persist();
      this.log(`[feedback] Synced ${added} entries from Redis`);
    }
  }
}

// ── Singleton ────────────────────────────────────────────────────────────────

let _singleton: DetectionFeedbackLoop | undefined;

export function getFeedbackLoop(opts?: FeedbackOptions): DetectionFeedbackLoop {
  if (!_singleton) {
    _singleton = new DetectionFeedbackLoop(opts);
  }
  return _singleton;
}

export function _resetFeedbackLoop(): void {
  _singleton = undefined;
}
