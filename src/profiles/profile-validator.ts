/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unused-vars */
/**
 * Profile Bundle Validator
 *
 * Each profile sub-module (UA, cache, geo, resolution, hardware, fonts) is
 * deterministic in isolation. Bot-detection vendors don't query them in
 * isolation though — they cross-check (e.g. UA Chrome major vs. the
 * client_id cached under a stale browser_version key, or navigator.timezone
 * vs. the proxy exit country). validateProfileBundle() catches the
 * cross-field drifts that cause those vendor checks to fire.
 *
 * Determinism is re-asserted by recomputing each profile from the email and
 * comparing — if a caller stitched together values from different runs (or
 * different libraries), the mismatch surfaces here instead of at runtime.
 */
import { getConsistentHardware, type HardwareProfile } from "./profile-determinism.js";
import { getConsistentUserAgent, type UAProfile } from "./profile-useragent.js";
import { alignGeoToProxy, type GeoProfile } from "./profile-geo-alignment.js";
import { getConsistentResolution, type Resolution } from "./profile-resolution.js";
import { getFontProfile, type FontProfile } from "./profile-fonts.js";
import { getCacheProfile, type CacheProfile } from "./profile-cache.js";
import { profileMetrics } from "./profile-metrics.js";

export interface ProfileBundle {
  email: string;
  ua?: UAProfile;
  cache?: CacheProfile;
  geo?: GeoProfile;
  resolution?: Resolution;
  hardware?: HardwareProfile;
  fonts?: FontProfile;
  /** Optional proxy server string used to derive the expected geo. */
  proxy?: string;
}

export interface ProfileBundleValidation {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

function pushIf<_T>(arr: string[], cond: boolean, msg: string): void {
  if (cond) arr.push(msg);
}

function shallowEqual(a: any, b: any): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    const va = a[k];
    const vb = b[k];
    if (va && typeof va === "object") {
      if (!shallowEqual(va, vb)) return false;
    } else if (va !== vb) {
      return false;
    }
  }
  return true;
}

export function validateProfileBundle(bundle: ProfileBundle): ProfileBundleValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const { email } = bundle;

  if (!email || !email.trim()) {
    errors.push("email: missing");
    profileMetrics.recordValidationFailed();
    return { ok: false, errors, warnings };
  }

  if (bundle.ua) {
    const expected = getConsistentUserAgent(email)!;
    pushIf(errors, !shallowEqual(bundle.ua, expected),
      `ua: drift — got chromeMajor=${bundle.ua.chromeMajor}/${bundle.ua.windowsLabel}, expected ${expected.chromeMajor}/${expected.windowsLabel}`);
  }

  if (bundle.hardware) {
    // Hardware drift is OS-conditional: an NVIDIA renderer on a macOS UA is a
    // separate concern from a same-OS preset mismatch. Use the bundle UA's OS
    // so the expected hardware is drawn from the matching pool.
    const expected = getConsistentHardware(email, bundle.ua?.os);
    pushIf(errors, !shallowEqual(bundle.hardware, expected),
      `hardware: drift — got ${bundle.hardware.cores}c/${bundle.hardware.memory}GB ${bundle.hardware.gpu.renderer}, expected ${expected.cores}c/${expected.memory}GB ${expected.gpu.renderer}`);
  }

  if (bundle.fonts) {
    const expected = getFontProfile(email);
    pushIf(errors, bundle.fonts.name !== expected.name,
      `fonts: drift — got ${bundle.fonts.name}, expected ${expected.name}`);
  }

  if (bundle.resolution) {
    const expected = getConsistentResolution(email);
    pushIf(errors,
      bundle.resolution.width !== expected.width || bundle.resolution.height !== expected.height,
      `resolution: drift — got ${bundle.resolution.width}x${bundle.resolution.height}, expected ${expected.width}x${expected.height}`);
    pushIf(errors, bundle.resolution.width <= 0 || bundle.resolution.height <= 0,
      `resolution: invalid dimensions ${bundle.resolution.width}x${bundle.resolution.height}`);
  }

  if (bundle.cache) {
    const expected = getCacheProfile(email, bundle.cache.chromeMajor);
    pushIf(errors, bundle.cache.clientId !== expected.clientId,
      `cache: clientId drift — got ${bundle.cache.clientId}, expected ${expected.clientId}`);
    pushIf(errors, bundle.cache.lastVisitDaysAgo !== expected.lastVisitDaysAgo,
      `cache: lastVisitDaysAgo drift — got ${bundle.cache.lastVisitDaysAgo}, expected ${expected.lastVisitDaysAgo}`);
  }

  // Cross-field: UA chromeMajor must match the cache profile's chromeMajor.
  // Vendors inspect localStorage.browser_version (seeded from the cache
  // profile) and the actual navigator.userAgent — when they disagree the
  // session looks like a profile that survived a Chrome version change
  // without clearing localStorage, which is a "stale automation" tell.
  if (bundle.ua && bundle.cache) {
    pushIf(errors, bundle.ua.chromeMajor !== bundle.cache.chromeMajor,
      `cross: UA.chromeMajor=${bundle.ua.chromeMajor} ≠ cache.chromeMajor=${bundle.cache.chromeMajor}`);
  }

  // Cross-field: geo profile country must match proxy-derived country.
  // Mismatched timezone/locale vs. IP geo is one of the cheapest "headless
  // automation" tells — covered by alignGeoToProxy at session creation,
  // but a bundle might be constructed from cached pieces.
  if (bundle.geo && bundle.proxy !== undefined) {
    const expected = alignGeoToProxy(bundle.proxy, bundle.email);
    pushIf(errors, bundle.geo.countryCode !== expected.countryCode,
      `cross: geo.countryCode=${bundle.geo.countryCode} ≠ proxy-derived ${expected.countryCode}`);
  }

  // Warn-only: missing recommended fields. These don't break the session but
  // weaken the consistency story across the bundle.
  pushIf(warnings, !bundle.ua, "ua: missing");
  pushIf(warnings, !bundle.cache, "cache: missing");
  pushIf(warnings, !bundle.hardware, "hardware: missing");
  pushIf(warnings, !bundle.resolution, "resolution: missing");

  const ok = errors.length === 0;
  if (!ok) profileMetrics.recordValidationFailed();
  return { ok, errors, warnings };
}
