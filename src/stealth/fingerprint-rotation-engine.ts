 
/**
 * Fingerprint Rotation Engine
 *
 * Manages session-counter-based fingerprint rotation, timezone↔proxy
 * geo-synchronisation, and dynamic attribute blending across sessions.
 *
 * Key concepts:
 *  • Each credential is assigned a **rotation counter** that increments
 *    every N sessions (default 3). The counter feeds into every
 *    deterministic profile function (hardware, fonts, UA, cache, geo)
 *    so the same credential gets a *different but internally-consistent*
 *    fingerprint bundle after the Nth attempt.
 *
 *  • Timezone/locale are always re-derived from the active proxy IP so
 *    a profile rotation never desynchronises the geo signals.
 *
 *  • A `RotationLedger` tracks per-credential session counts and
 *    rotation history, persisted to a JSON file.
 */

import fs from "node:fs";
import { emailToFingerprintSeed } from "../core/crypto-utils.js";
import { getConsistentHardware, type HardwareProfile } from "../profiles/profile-determinism.js";
import { getConsistentUserAgent, type UAProfile } from "../profiles/profile-useragent.js";
import { alignGeoToProxy, type GeoProfile } from "../profiles/profile-geo-alignment.js";
import { getConsistentResolution, type Resolution } from "../profiles/profile-resolution.js";
import { getFontProfile, type FontProfile } from "../profiles/profile-fonts.js";
import { getCacheProfile, type CacheProfile } from "../profiles/profile-cache.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface RotationEntry {
  email: string;
  sessionCount: number;
  currentRotation: number;
  lastRotatedAt: string;       // ISO-8601
  history: number[];           // rotation indices used
}

export interface RotatedProfile {
  email: string;
  rotation: number;
  seed: number;
  ua: UAProfile;
  hardware: HardwareProfile;
  geo: GeoProfile;
  resolution: Resolution;
  fonts: FontProfile;
  cache: CacheProfile;
}

export interface RotationEngineOptions {
  /** Sessions before a fingerprint rotation (default 3). */
  sessionsPerRotation?: number;
  /** Path to persist the rotation ledger JSON. */
  ledgerPath?: string;
  /** Optional logger. */
  log?: (msg: string) => void;
}

// ── Defaults ─────────────────────────────────────────────────────────────────

const DEFAULT_SESSIONS_PER_ROTATION = 3;
const DEFAULT_LEDGER_PATH = "rotation-ledger.json";

// ── Ledger persistence ───────────────────────────────────────────────────────

type Ledger = Map<string, RotationEntry>;

function loadLedger(filePath: string): Ledger {
  const ledger: Ledger = new Map();
  try {
    if (fs.existsSync(filePath)) {
      const raw = JSON.parse(fs.readFileSync(filePath, "utf-8")) as RotationEntry[];
      for (const entry of raw) {
        ledger.set(entry.email.toLowerCase().trim(), entry);
      }
    }
  } catch {
    // Start fresh on any parse error
  }
  return ledger;
}

function saveLedger(ledger: Ledger, filePath: string): void {
  const entries = Array.from(ledger.values());
  try {
    fs.writeFileSync(filePath, JSON.stringify(entries, null, 2), "utf-8");
  } catch {
    // Non-critical — ledger will be rebuilt on next run
  }
}

// ── Engine ───────────────────────────────────────────────────────────────────

export class FingerprintRotationEngine {
  private readonly sessionsPerRotation: number;
  private readonly ledgerPath: string;
  private readonly log: (msg: string) => void;
  private ledger: Ledger;

  constructor(opts: RotationEngineOptions = {}) {
    this.sessionsPerRotation = opts.sessionsPerRotation ?? DEFAULT_SESSIONS_PER_ROTATION;
    this.ledgerPath = opts.ledgerPath ?? DEFAULT_LEDGER_PATH;
    this.log = opts.log ?? (() => {});
    this.ledger = loadLedger(this.ledgerPath);
  }

  // ── Public API ─────────────────────────────────────────────────────────

  /**
   * Record a session attempt for `email` and return the current rotation
   * counter. Automatically increments the rotation when the session
   * threshold is crossed.
   */
  recordSession(email: string): number {
    const key = email.toLowerCase().trim();
    let entry = this.ledger.get(key);

    if (!entry) {
      entry = {
        email: key,
        sessionCount: 0,
        currentRotation: 0,
        lastRotatedAt: new Date().toISOString(),
        history: [0],
      };
      this.ledger.set(key, entry);
    }

    entry.sessionCount++;

    if (entry.sessionCount >= this.sessionsPerRotation) {
      entry.sessionCount = 0;
      entry.currentRotation++;
      entry.lastRotatedAt = new Date().toISOString();
      entry.history.push(entry.currentRotation);
      this.log(`[rotation] ${key} → rotation ${entry.currentRotation}`);
    }

    this.persist();
    return entry.currentRotation;
  }

  /**
   * Get the current rotation counter without incrementing sessions.
   */
  getRotation(email: string): number {
    const key = email.toLowerCase().trim();
    return this.ledger.get(key)?.currentRotation ?? 0;
  }

  /**
   * Get the raw session count (not rotation index) for a credential.
   * This is needed by the hardware rotation module to know when
   * the next rotation trigger will fire.
   */
  getSessionCount(email: string): number {
    const key = email.toLowerCase().trim();
    return this.ledger.get(key)?.sessionCount ?? 0;
  }

  /**
   * Sessions before a fingerprint rotation triggers.
   */
  get rotationCadence(): number {
    return this.sessionsPerRotation;
  }

  /**
   * Force-set a specific rotation for a credential (e.g. after a burn).
   */
  forceRotation(email: string, rotation: number): void {
    const key = email.toLowerCase().trim();
    let entry = this.ledger.get(key);
    if (!entry) {
      entry = {
        email: key,
        sessionCount: 0,
        currentRotation: rotation,
        lastRotatedAt: new Date().toISOString(),
        history: [rotation],
      };
      this.ledger.set(key, entry);
    } else {
      entry.currentRotation = rotation;
      entry.sessionCount = 0;
      entry.lastRotatedAt = new Date().toISOString();
      entry.history.push(rotation);
    }
    this.persist();
    this.log(`[rotation] ${key} → forced to rotation ${rotation}`);
  }

  /**
   * Build a fully-rotated, internally-consistent fingerprint profile
   * for the given credential and proxy.
   */
  buildRotatedProfile(
    email: string,
    proxyUrl?: string,
    mobile?: boolean,
  ): RotatedProfile {
    const rotation = this.getRotation(email);
    const seed = emailToFingerprintSeed(email, rotation);
    const ua = getConsistentUserAgent(email, "mixed", proxyUrl, "chrome", rotation);
    if (!ua) throw new Error(`[rotation] No UA profile available for ${email}`);
    const hardware = getConsistentHardware(email, ua.os, rotation);
    const geo = alignGeoToProxy(proxyUrl, email, mobile);
    const resolution = getConsistentResolution(email, ua.os, rotation);
    const fonts = getFontProfile(email);
    const cache = getCacheProfile(email, ua.chromeMajor);

    this.log(
      `[rotation] Profile for ${email}: rot=${rotation} seed=${seed} ` +
      `ua=${ua.chromeMajor}/${ua.os} hw=${hardware.cores}c/${hardware.memory}GB ` +
      `geo=${geo.countryCode} res=${resolution.width}x${resolution.height}`,
    );

    return { email, rotation, seed, ua, hardware, geo, resolution, fonts, cache };
  }

  /**
   * Reset a credential's rotation counter (e.g. on success).
   */
  resetRotation(email: string): void {
    const key = email.toLowerCase().trim();
    const entry = this.ledger.get(key);
    if (entry) {
      entry.currentRotation = 0;
      entry.sessionCount = 0;
      entry.lastRotatedAt = new Date().toISOString();
      this.persist();
    }
  }

  /**
   * Get the full ledger snapshot (for dashboard display).
   */
  snapshot(): RotationEntry[] {
    return Array.from(this.ledger.values());
  }

  /**
   * Get the entry for a single credential.
   */
  getEntry(email: string): RotationEntry | undefined {
    return this.ledger.get(email.toLowerCase().trim());
  }

  /** Number of tracked credentials. */
  get size(): number {
    return this.ledger.size;
  }

  // ── Internals ──────────────────────────────────────────────────────────

  private persistTimeout: ReturnType<typeof setTimeout> | null = null;
  private persist(): void {
    if (this.persistTimeout) return;
    this.persistTimeout = setTimeout(() => {
      saveLedger(this.ledger, this.ledgerPath);
      this.persistTimeout = null;
    }, 2000);
  }

  /** Immediately persist ledger to disk (bypasses debounce). */
  flush(): void {
    if (this.persistTimeout) {
      clearTimeout(this.persistTimeout);
      this.persistTimeout = null;
    }
    saveLedger(this.ledger, this.ledgerPath);
  }
}

// ── Convenience factory ──────────────────────────────────────────────────────

let _singleton: FingerprintRotationEngine | undefined;

export function getRotationEngine(opts?: RotationEngineOptions): FingerprintRotationEngine {
  if (!_singleton) {
    _singleton = new FingerprintRotationEngine(opts);
  }
  return _singleton;
}

/** Reset the singleton (used in tests). */
export function _resetRotationEngine(): void {
  _singleton = undefined;
}
