/**
 * Screen Resolution Alignment
 * Maps credential email to a realistic viewport drawn from the StatCounter
 * desktop resolution distribution. Same email always returns the same
 * resolution — keeps fingerprint stable across sessions while making the
 * batch as a whole look heterogeneous.
 */

import * as crypto from "crypto";

export interface Resolution {
  width: number;
  height: number;
  /** Approximate desktop share (%) from public market reports. */
  share: number;
  /** Human label for logging. */
  label: string;
}

/**
 * Realistic desktop resolutions weighted by global market share.
 * Sourced from Statcounter Global Stats — Desktop Screen Resolution Worldwide,
 * 2025–April 2026 trailing data. Pool excludes mobile/tablet noise (e.g.
 * 800×600, 1280×1200) so the fingerprint always lands in a dense desktop bucket.
 * The hash distribution is uniform; share is exposed for diagnostics only.
 */
const RESOLUTION_POOL: Resolution[] = [
  { width: 1920, height: 1080, share: 22, label: "FHD" },
  { width: 1536, height: 864, share: 10, label: "FHD-125-scaled" },
  { width: 1366, height: 768, share: 8, label: "HD-laptop" },
  { width: 2560, height: 1440, share: 7, label: "QHD" },
  { width: 1440, height: 900, share: 5, label: "MBP-13" },
  { width: 1600, height: 900, share: 4, label: "HD+" },
  { width: 1280, height: 720, share: 4, label: "HD-window" },
  { width: 1280, height: 800, share: 3, label: "WXGA" },
  { width: 1680, height: 1050, share: 2, label: "WSXGA+" },
  { width: 3840, height: 2160, share: 2, label: "4K-UHD" },
];

/**
 * Realistic mobile resolutions weighted by global market share (Android).
 */
const MOBILE_RESOLUTION_POOL: Resolution[] = [
  { width: 360, height: 800, share: 11, label: "Mobile-360" },
  { width: 412, height: 915, share: 9, label: "Mobile-412" },
  { width: 393, height: 873, share: 5, label: "Mobile-393" },
  { width: 384, height: 854, share: 4, label: "Mobile-384" },
  { width: 360, height: 780, share: 4, label: "Mobile-360-Alt" },
  { width: 412, height: 892, share: 4, label: "Mobile-412-Alt" },
  { width: 360, height: 760, share: 3, label: "Mobile-360-Short" },
];
function hashEmail(email: string, rotation: number = 0): number {
  let normalized = email.trim().toLowerCase();
  if (rotation > 0) normalized = `${normalized}:rot${rotation}`;
  const digest = crypto.createHash("sha256").update(normalized).digest();
  return digest.readUInt32BE(0);
}

/**
 * Get the deterministic resolution for an email.
 * Same email → same resolution every call.
 */
export function getConsistentResolution(email: string, os?: "windows" | "macos" | "linux" | "android", rotation: number = 0): Resolution {
  const pool = os === "android" ? MOBILE_RESOLUTION_POOL : RESOLUTION_POOL;
  const idx = hashEmail(email, rotation) % pool.length;
  // @ts-expect-error noUncheckedIndexedAccess
  return { ...pool[idx] };
}

/**
 * Logged variant — returns the resolution and emits a one-line summary.
 */
export function getConsistentResolutionWithLog(
  email: string,
  logFn?: (msg: string) => void,
  rotation: number = 0
): Resolution {
  const r = getConsistentResolution(email, undefined, rotation);
  const mut = rotation > 0 ? ` (mut${rotation})` : "";
  const msg = `Resolution${mut}: ${email} → ${r.width}x${r.height} (${r.label}, ~${r.share}% share)`;
  if (logFn) logFn(msg);
  return r;
}
/** Number of resolutions in the pool. */
export function getResolutionPoolSize(): number {
  return RESOLUTION_POOL.length;
}

/** Read-only view of the pool. */
export function listResolutionPool(): readonly Resolution[] {
  return RESOLUTION_POOL;
}
/**
 * Realistic devicePixelRatio buckets for desktop browsers (2025–2026):
 *   1.0  → no OS scaling (legacy + low-DPI desktops)        ~55%
 *   1.25 → Windows 125% scale (most common HiDPI default)   ~22%
 *   1.5  → Windows 150% / 4K @ 150%                          ~13%
 *   2.0  → Retina / true HiDPI (macOS native, 4K @ 200%)    ~10%
 * Bizarre values like 0.8 or 0.75 are absent — they instantly tag a fingerprint
 * as synthetic. Hash uses a different byte than the resolution picker so the
 * (resolution, dpr) pair varies across credentials independently.
 */
const DPR_BUCKETS: Array<{ dpr: number; weight: number }> = [
  { dpr: 1.0, weight: 55 },
  { dpr: 1.25, weight: 22 },
  { dpr: 1.5, weight: 13 },
  { dpr: 2.0, weight: 10 },
];

/**
 * Get the deterministic devicePixelRatio for an email.
 * Same email → same DPR every call. Independent hash byte from resolution.
 */
export function getConsistentDeviceScaleFactor(email: string, rotation: number = 0): number {
  let normalized = email.trim().toLowerCase();
  if (rotation > 0) normalized = `${normalized}:rot${rotation}`;
  const digest = crypto.createHash("sha256").update(normalized).digest();
  const sample = digest.readUInt32BE(4) % 100; // [0, 99]
  let cumulative = 0;
  for (const b of DPR_BUCKETS) {
    cumulative += b.weight;
    if (sample < cumulative) return b.dpr;
  }
  return 1.0;
}
