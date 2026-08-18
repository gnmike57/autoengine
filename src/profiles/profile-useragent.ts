/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/restrict-template-expressions*/
/**
 * User Agent Freshness
 * Maps credential email to a contemporary Chrome/Windows UA profile.
 * Same email always returns the same UA — keeps fingerprint stable.
 *
 * Pool is sourced from the upstream spider-rs/ua_generator Rust crate
 * (https://github.com/spider-rs/ua_generator) and materialised into
 * data/ua-pool.json by `npm run sync:ua`. Runtime loads that JSON at
 * module init; no network or Rust toolchain at server boot. If the JSON
 * is missing (fresh clone before sync) we fall back to the bundled pool
 * below so tests and live sessions still have a deterministic UA pool.
 */

import * as crypto from "crypto";
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger } from "../core/logger.js";

const log = createLogger("profile-useragent");

export interface UAProfile {
  ua: string;
  chromeVersion: string;     // full version e.g. "147.0.0.0" (modern reduced UA freezes minors to 0.0.0)
  chromeMajor: number;       // major e.g. 147
  windowsVersion: string;    // legacy alias of platformVersion, retained for log/format compatibility
  windowsLabel: "Win10" | "Win11" | "macOS Apple Silicon" | "macOS Intel" | "Linux" | "Android";
  os: "windows" | "macos" | "linux" | "android";
  platformVersion: string;   // Sec-CH-UA-Platform-Version payload — e.g. "10.0.26100", "10.15.7"
  architecture: "x64" | "arm64";
  isBot?: boolean;
  // ─── Mobile-only metadata (populated when os === "android") ─────────────────
  mobile?: boolean;
  deviceModel?: string;      // e.g. "SM-S928B", "Pixel 8 Pro"
  deviceMemory?: number;     // gigabytes, navigator.deviceMemory clamps at 8
  screen?: { width: number; height: number; pixelRatio: number };
  touchSupport?: boolean;
  webgl?: { vendor: string; renderer: string };
  battery?: { charging: boolean; level: number };
  connection?: { type: "4g" | "5g" | "wifi"; downlink: number; rtt: number };
  apifyFingerprint?: any; // The complete deterministic Apify fingerprint payload
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Bundled fallback pool — used when data/ua-pool.json is absent.
 */
const BUNDLED_POOL: UAProfile[] = [
  {
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
    chromeVersion: "147.0.0.0", chromeMajor: 147, windowsVersion: "10.0.26100",
    windowsLabel: "Win11", os: "windows", platformVersion: "10.0.26100", architecture: "x64"
  },
  {
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
    chromeVersion: "147.0.0.0", chromeMajor: 147, windowsVersion: "10.0.19045",
    windowsLabel: "Win10", os: "windows", platformVersion: "10.0.19045", architecture: "x64"
  },
  {
    ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
    chromeVersion: "147.0.0.0", chromeMajor: 147, windowsVersion: "10.15.7",
    windowsLabel: "macOS Apple Silicon", os: "macos", platformVersion: "10.15.7", architecture: "arm64"
  },
  {
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
    chromeVersion: "146.0.0.0", chromeMajor: 146, windowsVersion: "10.0.22621",
    windowsLabel: "Win11", os: "windows", platformVersion: "10.0.22621", architecture: "x64"
  },
  {
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
    chromeVersion: "145.0.0.0", chromeMajor: 145, windowsVersion: "10.0.19044",
    windowsLabel: "Win10", os: "windows", platformVersion: "10.0.19044", architecture: "x64"
  },
  {
    ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
    chromeVersion: "146.0.0.0", chromeMajor: 146, windowsVersion: "10.15.7",
    windowsLabel: "macOS Intel", os: "macos", platformVersion: "10.15.7", architecture: "x64"
  },
  {
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.1 Safari/537.36",
    chromeVersion: "147.0.0.1", chromeMajor: 147, windowsVersion: "10.0.26101",
    windowsLabel: "Win11", os: "windows", platformVersion: "10.0.26101", architecture: "x64"
  },
  {
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.2 Safari/537.36",
    chromeVersion: "147.0.0.2", chromeMajor: 147, windowsVersion: "10.0.26102",
    windowsLabel: "Win11", os: "windows", platformVersion: "10.0.26102", architecture: "x64"
  },
  {
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.3 Safari/537.36",
    chromeVersion: "147.0.0.3", chromeMajor: 147, windowsVersion: "10.0.26103",
    windowsLabel: "Win11", os: "windows", platformVersion: "10.0.26103", architecture: "x64"
  },
  {
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.4 Safari/537.36",
    chromeVersion: "147.0.0.4", chromeMajor: 147, windowsVersion: "10.0.26104",
    windowsLabel: "Win11", os: "windows", platformVersion: "10.0.26104", architecture: "x64"
  },
  {
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.5 Safari/537.36",
    chromeVersion: "147.0.0.5", chromeMajor: 147, windowsVersion: "10.0.26105",
    windowsLabel: "Win11", os: "windows", platformVersion: "10.0.26105", architecture: "x64"
  },
  {
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.6 Safari/537.36",
    chromeVersion: "147.0.0.6", chromeMajor: 147, windowsVersion: "10.0.26106",
    windowsLabel: "Win11", os: "windows", platformVersion: "10.0.26106", architecture: "x64"
  }
];

function isMobileScreen(x: unknown): boolean {
  if (x === undefined) return true;
  if (!x || typeof x !== "object") return false;
  const s = x as Record<string, unknown>;
  return typeof s.width === "number" && Number.isFinite(s.width)
    && typeof s.height === "number" && Number.isFinite(s.height)
    && typeof s.pixelRatio === "number" && Number.isFinite(s.pixelRatio);
}

function isMobileConnection(x: unknown): boolean {
  if (x === undefined) return true;
  if (!x || typeof x !== "object") return false;
  const c = x as Record<string, unknown>;
  return typeof c.type === "string" && c.type.length > 0
    && typeof c.downlink === "number" && Number.isFinite(c.downlink)
    && typeof c.rtt === "number" && Number.isFinite(c.rtt);
}

function isUAProfile(x: unknown): x is UAProfile {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  const baseOk = typeof o.ua === "string" && o.ua.startsWith("Mozilla/5.0")
    && typeof o.chromeVersion === "string" && typeof o.chromeMajor === "number"
    && typeof o.platformVersion === "string" && typeof o.windowsVersion === "string"
    && (o.os === "windows" || o.os === "macos" || o.os === "linux" || o.os === "android")
    && (o.architecture === "x64" || o.architecture === "arm64")
    && typeof o.windowsLabel === "string"
    && (o.isBot === undefined || typeof o.isBot === "boolean")
    && (o.mobile === undefined || typeof o.mobile === "boolean");
  if (!baseOk) return false;

  if (o.deviceModel !== undefined && typeof o.deviceModel !== "string") return false;
  if (o.deviceMemory !== undefined && (typeof o.deviceMemory !== "number" || !Number.isFinite(o.deviceMemory))) return false;
  if (!isMobileScreen(o.screen)) return false;
  if (o.touchSupport !== undefined && typeof o.touchSupport !== "boolean") return false;
  if (o.webgl !== undefined) {
    if (!o.webgl || typeof o.webgl !== "object") return false;
    const w = o.webgl as Record<string, unknown>;
    if (typeof w.vendor !== "string" || typeof w.renderer !== "string") return false;
  }
  if (o.battery !== undefined) {
    if (!o.battery || typeof o.battery !== "object") return false;
    const b = o.battery as Record<string, unknown>;
    if (typeof b.charging !== "boolean") return false;
    if (typeof b.level !== "number" || !Number.isFinite(b.level)) return false;
  }
  if (!isMobileConnection(o.connection)) return false;
  return true;
}

function loadPool(filename: string): UAProfile[] {
  const candidates = [
    path.resolve(process.cwd(), "data", filename),
    path.resolve(__dirname, "data", filename),
    path.resolve(__dirname, "..", "data", filename),
  ];
  for (const p of candidates) {
    try {
      if (!fs.existsSync(p)) continue;
      const raw = JSON.parse(fs.readFileSync(p, "utf-8"));
      const pool: unknown[] = Array.isArray(raw?.pool) ? raw.pool : Array.isArray(raw) ? raw : [];
      const valid = pool.filter(isUAProfile);
      const dropped = pool.length - valid.length;
      if (dropped > 0) {
        log.warn(`${p}: dropped ${dropped} of ${pool.length} entries failing shape validation`);
      }
      if (valid.length > 0) return valid;
    } catch (e: unknown) {
      log.warn(`failed to load ${p}: ${(e instanceof Error ? e.message : String(e)) || e}`);
    }
  }
  log.warn(`data/${filename} not found — falling back to bundled pool`);
  return BUNDLED_POOL;
}

const UA_POOL_CHROME: UAProfile[] = loadPool("ua-pool-chrome.json");
const UA_POOL_FIREFOX: UAProfile[] = loadPool("ua-pool-firefox.json");

function hashEmail(email: string, rotation: number = 0): number {
  let normalized = email.trim().toLowerCase();
  if (rotation > 0) normalized = `${normalized}:rot${rotation}`;
  const digest = crypto.createHash("sha256").update(normalized).digest();
  return digest.readUInt32BE(0);
}

export type TargetOS = "off" | "auto" | "auto-proxy" | "mixed" | "macos" | "windows" | "android" | "linux";
/** Only 3 valid strategies remain after audit-driven consolidation:
 *  - "optimal"     → Auto-selects per-backend tier (stealth=zero JS, cloak=supplementary, zendriver=full)
 *  - "native-only" → Zero JS injection, rely entirely on binary-level patches
 *  - "full-stealth" → Maximum JS injection regardless of backend
 *  Legacy aliases kept for backward compat with saved configs: */
export type FpStrategy = "optimal" | "native-only" | "full-stealth" | "fp-auto" | "fp-camoufox" | "fp-cloak" | "fp-zendriver" | "none" | "fp-fb-optimized" | "apify";

type PrecomputedMap = Record<TargetOS, UAProfile[]>;

function buildPrecomputedPools(pool: UAProfile[]): PrecomputedMap {
  const noBots = pool.filter(p => !p.isBot);
  const mixed = noBots.length > 0 ? noBots : pool;
  return {
    off: [],
    auto: [],
    "auto-proxy": [],
    mixed,
    macos: noBots.filter(p => p.os === "macos"),
    windows: noBots.filter(p => p.os === "windows"),
    android: noBots.filter(p => p.os === "android"),
    linux: noBots.filter(p => p.os === "linux")
  };
}

const PRECOMPUTED_POOLS_CHROME = buildPrecomputedPools(UA_POOL_CHROME);
const PRECOMPUTED_POOLS_FIREFOX = buildPrecomputedPools(UA_POOL_FIREFOX);

export function getConsistentUserAgent(
  email: string,
  targetOs: TargetOS = "mixed",
  proxyString?: string,
  engine: "chrome" | "firefox" = "chrome",
  rotation: number = 0
): UAProfile | undefined {
  if (targetOs === "off") return undefined;

  let resolvedOs = targetOs;
  if (targetOs === "auto") {
    const h = hashEmail(email, rotation) % 100;
    if (h < 60) resolvedOs = "windows";
    else if (h < 75) resolvedOs = "macos";
    else if (h < 95) resolvedOs = "android";
    else resolvedOs = "linux";
  } else if (targetOs === "auto-proxy") {
    if (proxyString && proxyString.includes("spider") && proxyString.includes("au")) {
      const h = hashEmail(email, rotation) % 100;
      resolvedOs = h < 70 ? "windows" : "macos";
    } else {
      resolvedOs = "mixed";
    }
  }

  const precomputed = engine === "chrome" ? PRECOMPUTED_POOLS_CHROME : PRECOMPUTED_POOLS_FIREFOX;

  let pool = precomputed[resolvedOs as keyof typeof precomputed];
  if (!pool || pool.length === 0) {
    pool = precomputed.mixed;
  }

  if (!pool || pool.length === 0) return undefined;

  const h = hashEmail(email, rotation);
  return pool[h % pool.length];
}

export function getConsistentUserAgentWithLog(
  email: string,
  targetOs: TargetOS = "mixed",
  proxyString?: string,
  onLog?: (msg: string) => void,
  rotation: number = 0
): UAProfile | undefined {
  const ua = getConsistentUserAgent(email, targetOs, proxyString, "chrome", rotation);
  if (ua) {
    const mut = rotation > 0 ? ` (mut${rotation})` : "";
    const msg = `UA freshness${mut}: ${email} → Chrome ${ua.chromeMajor} on ${ua.windowsLabel} (${ua.windowsVersion})`;
    if (onLog) onLog(msg);
  }
  return ua;
}

export function getUserAgentArgs(profile: UAProfile): string[] {
  const platform = profile.os === "macos" ? "macOS"
    : profile.os === "android" ? "Android"
    : profile.os === "linux" ? "Linux"
    : "Windows";
  const args = [
    `--fingerprint-platform=${platform}`,
    `--fingerprint-platform-version=${profile.platformVersion}`,
    `--fingerprint-architecture=${profile.architecture}`,
    `--fingerprint-browser-version=${profile.chromeVersion}`,
  ];
  if (profile.mobile) {
    args.push("--fingerprint-mobile");
    if (profile.screen) {
      args.push(`--fingerprint-screen=${profile.screen.width}x${profile.screen.height}`);
      args.push(`--fingerprint-device-scale-factor=${profile.screen.pixelRatio}`);
    }
    if (profile.touchSupport) args.push("--fingerprint-touch-events");
    if (profile.deviceMemory) args.push(`--fingerprint-device-memory=${profile.deviceMemory}`);
    if (profile.connection) args.push(`--fingerprint-network-type=${profile.connection.type}`);
  }
  return args;
}

export function getUserAgentPoolSize(): number {
  return UA_POOL_CHROME.length;
}

export function listUserAgentPool(): readonly UAProfile[] {
  return UA_POOL_CHROME;
}

export const _test = {
  isMobileScreen,
  isMobileConnection,
  isUAProfile,
  loadPool
};