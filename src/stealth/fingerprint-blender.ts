/**
 * Fingerprint Blender
 *
 * Blends attributes from multiple successful fingerprint profiles to
 * generate new, plausible profiles. When a credential succeeds, its
 * full profile bundle is stored in the "successful_fingerprints" DB.
 * New sessions pull 3 profiles from the DB and blend them by randomly
 * choosing each attribute from one of the source profiles.
 *
 * This produces fingerprints that are individually realistic (every
 * attribute came from a real successful session) while being unique
 * combinations that haven't been seen before.
 */

import fs from "node:fs";
import { djb2Hash } from "../core/crypto-utils.js";
import { type HardwareProfile } from "../profiles/profile-determinism.js";
import { type UAProfile } from "../profiles/profile-useragent.js";
import { type GeoProfile } from "../profiles/profile-geo-alignment.js";
import type { RedisCoordinator } from "../services/redis-coordinator.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface SuccessfulProfile {
  email: string;
  timestamp: string;         // ISO-8601
  ua: UAProfile;
  hardware: HardwareProfile;
  geo: Partial<GeoProfile>;
  seed: number;
  backend: string;
  /** Optional outcome tag for filtering. */
  outcome?: string;
}

export interface BlendedProfile {
  ua: UAProfile;
  hardware: HardwareProfile;
  geo: Partial<GeoProfile>;
  sources: string[];  // emails of source profiles
}

export interface BlenderOptions {
  /** Path to the successful profiles JSON store. */
  dbPath?: string;
  /** Number of source profiles to blend from (default 3). */
  sourceCount?: number;
  /** Optional logger. */
  log?: (msg: string) => void;
  /** Optional Redis coordinator for cluster-wide profile sharing. */
  redis?: RedisCoordinator | null;
}

// ── Defaults ─────────────────────────────────────────────────────────────────

const DEFAULT_DB_PATH = "successful-fingerprints.json";
const DEFAULT_SOURCE_COUNT = 3;

// ── Store ────────────────────────────────────────────────────────────────────

function loadProfiles(filePath: string): SuccessfulProfile[] {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, "utf-8")) as SuccessfulProfile[];
    }
  } catch {
    // Start fresh
  }
  return [];
}

function saveProfiles(profiles: SuccessfulProfile[], filePath: string): void {
  try {
    // Keep only last 500 profiles to avoid unbounded growth
    const trimmed = profiles.slice(-500);
    fs.writeFileSync(filePath, JSON.stringify(trimmed, null, 2), "utf-8");
  } catch {
    // Non-critical
  }
}

// ── Blender ──────────────────────────────────────────────────────────────────

export class FingerprintBlender {
  private readonly dbPath: string;
  private readonly sourceCount: number;
  private readonly log: (msg: string) => void;
  private readonly redis: RedisCoordinator | null;
  private profiles: SuccessfulProfile[];

  constructor(opts: BlenderOptions = {}) {
    this.dbPath = opts.dbPath ?? DEFAULT_DB_PATH;
    this.sourceCount = opts.sourceCount ?? DEFAULT_SOURCE_COUNT;
    this.log = opts.log ?? (() => {});
    this.redis = opts.redis ?? null;
    this.profiles = loadProfiles(this.dbPath);
  }

  /**
   * Record a successful profile for future blending.
   */
  recordSuccess(profile: SuccessfulProfile): void {
    this.profiles.push(profile);
    if (this.profiles.length > 500) {
      this.profiles = this.profiles.slice(-500);
    }
    saveProfiles(this.profiles, this.dbPath);
    this.log(`[blender] Recorded success: ${profile.email} (${profile.backend})`);

    // Also push to Redis for cluster-wide sharing
    if (this.redis) {
      void this.redis.pushSuccessfulProfile(profile as unknown as Record<string, unknown>)
        .catch(() => {});
    }
  }

  /**
   * Blend attributes from N random successful profiles into a new profile.
   * Each attribute is independently chosen from one of the source profiles.
   *
   * If fewer than `sourceCount` profiles exist, returns undefined (not
   * enough data to blend).
   */
  blend(seedKey: string): BlendedProfile | undefined {
    if (this.profiles.length < this.sourceCount) {
      this.log(`[blender] Not enough profiles to blend (${this.profiles.length}/${this.sourceCount})`);
      return undefined;
    }

    // Pick N distinct profiles using a deterministic-ish selection
    const hash = djb2Hash(seedKey);
    const sources: SuccessfulProfile[] = [];
    const usedIndices = new Set<number>();

    for (let i = 0; i < this.sourceCount; i++) {
      let idx = (hash + i * 7919) % this.profiles.length;
      // Avoid duplicates
      let attempts = 0;
      while (usedIndices.has(idx) && attempts < this.profiles.length) {
        idx = (idx + 1) % this.profiles.length;
        attempts++;
      }
      usedIndices.add(idx);
      sources.push(this.profiles[idx]!);
    }

    // Blend: for each attribute category, pick randomly from sources
    const pick = <T>(extractor: (p: SuccessfulProfile) => T, attrIdx: number): T => {
      const sourceIdx = (hash + attrIdx * 31) % sources.length;
      return extractor(sources[sourceIdx]!);
    };

    const blended: BlendedProfile = {
      ua: pick(p => p.ua, 0),
      hardware: pick(p => p.hardware, 1),
      geo: pick(p => p.geo, 2),
      sources: sources.map(s => s.email),
    };

    this.log(
      `[blender] Blended from [${blended.sources.join(", ")}]: ` +
      `ua=${blended.ua.chromeMajor}/${blended.ua.os} ` +
      `hw=${blended.hardware.cores}c/${blended.hardware.memory}GB`,
    );

    return blended;
  }

  /** Number of stored successful profiles. */
  get size(): number {
    return this.profiles.length;
  }

  /** Get all stored profiles (for dashboard). */
  getAll(): SuccessfulProfile[] {
    return [...this.profiles];
  }

  /** Clear all stored profiles. */
  clear(): void {
    this.profiles = [];
    saveProfiles(this.profiles, this.dbPath);
  }

  /**
   * Blend from Redis profiles when available.
   * Falls back to local file-based blend() if Redis is unavailable
   * or doesn't have enough profiles.
   */
  async blendFromRedis(seedKey: string): Promise<BlendedProfile | undefined> {
    if (!this.redis) {
      return this.blend(seedKey);
    }

    try {
      const redisProfiles = await this.redis.getSuccessfulProfiles(this.sourceCount);
      // Validate structure before using — Redis data may be stale or malformed
      const validProfiles = redisProfiles.filter(
        (p): p is Record<string, unknown> & { ua: string; hardware: Record<string, unknown>; geo: Record<string, unknown> } =>
          typeof p === "object" &&
          p !== null &&
          typeof (p).ua === "string" &&
          typeof (p).hardware === "object" &&
          typeof (p).geo === "object",
      );

      if (validProfiles.length >= this.sourceCount) {
        const sources = validProfiles as unknown as SuccessfulProfile[];
        const hash = djb2Hash(seedKey);

        const pick = <T>(extractor: (p: SuccessfulProfile) => T, attrIdx: number): T => {
          const sourceIdx = (hash + attrIdx * 31) % sources.length;
          return extractor(sources[sourceIdx]!);
        };

        const blended: BlendedProfile = {
          ua: pick(p => p.ua, 0),
          hardware: pick(p => p.hardware, 1),
          geo: pick(p => p.geo, 2),
          sources: sources.map(s => s.email || "redis"),
        };

        this.log(`[blender] Blended from Redis: ${blended.sources.join(", ")}`);
        return blended;
      }
    } catch {
      // Fall through to local
    }

    this.log("[blender] Redis insufficient or invalid, falling back to local blend");
    return this.blend(seedKey);
  }
}

// ── Singleton ────────────────────────────────────────────────────────────────

let _singleton: FingerprintBlender | undefined;

export function getBlender(opts?: BlenderOptions): FingerprintBlender {
  if (!_singleton) {
    _singleton = new FingerprintBlender(opts);
  }
  return _singleton;
}

export function _resetBlender(): void {
  _singleton = undefined;
}
