/**
 * Anonymous Cache Authenticity
 * Pre-populates only generic localStorage hints needed for functional site
 * stability. The injected state is intentionally NOT per-credential: two
 * different emails produce the same script body so sessions cannot be linked
 * through cache/localStorage breadcrumbs.
 *
 * The deterministic CacheProfile fields below are retained for diagnostics and
 * backward-compatible callers, but high-entropy values (`last_visit`,
 * `client_id`, browser version, tracking/cache tokens) are no longer emitted by
 * getCacheInjectionScript().
 *
 * NOTE: ADDITIVE only — we never overwrite keys that the site itself sets.
 * The injection runs at the document_start phase via context.addInitScript.
 */

import * as crypto from "crypto";

const CACHE_ANCHOR_MS = Number(process.env.CACHE_ANCHOR_MS || "") || Date.now();

export interface CacheProfile {
  email: string;
  /** Diagnostic-only; no longer injected into localStorage. */
  lastVisitDaysAgo: number;
  /** Diagnostic-only; no longer injected into localStorage. */
  lastVisitIso: string;
  /** Generic timezone hint used by the anonymous injection script. */
  timezone: string;
  /** Diagnostic-only; no longer injected into localStorage. */
  clientId: string;
  /** Diagnostic-only; no longer injected into localStorage. */
  chromeMajor: number;
  /** Diagnostic-only; no longer used to open Cache API buckets. */
  serviceWorkerHint: boolean;
}

function hashEmail(email: string): Buffer {
  const normalized = email.trim().toLowerCase();
  return crypto.createHash("sha256").update(normalized).digest();
}

function uuidFromHash(hash: Buffer): string {
  const hex = hash.toString("hex");
  // RFC4122-shaped (variant bits not strictly enforced — this is a synthetic id).
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function longTailedDays(hash: Buffer): number {
  const bucket = hash.readUInt32BE(4) % 100;
  const value = hash.readUInt32BE(8);
  if (bucket < 55) return 1 + (value % 7);
  if (bucket < 85) return 8 + (value % 23);
  if (bucket < 97) return 31 + (value % 60);
  return 91 + (value % 90);
}

const dtfCache = new Map<string, Intl.DateTimeFormat>();

function getDtf(timezone: string): Intl.DateTimeFormat {
  let dtf = dtfCache.get(timezone);
  if (!dtf) {
    dtf = new Intl.DateTimeFormat("en-AU", {
      timeZone: timezone,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
      hour12: false,
    });
    dtfCache.set(timezone, dtf);
  }
  return dtf;
}

function zonedParts(date: Date, timezone: string): Record<string, string> {
  const parts = getDtf(timezone).formatToParts(date);
  return Object.fromEntries(parts.filter((p) => p.type !== "literal").map((p) => [p.type, p.value]));
}

function offsetFor(date: Date, timezone: string): string {
  const p = zonedParts(date, timezone);
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
  const offsetMin = Math.round((asUtc - date.getTime()) / 60000);
  const sign = offsetMin >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMin);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

function zonedIso(date: Date, timezone: string): string {
  const p = zonedParts(date, timezone);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${offsetFor(date, timezone)}`;
}

/**
 * Get the deterministic cache profile for an email.
 * Same email → same profile every call.
 */
export function getCacheProfile(email: string, chromeMajor = 136): CacheProfile {
  const normalized = email.trim().toLowerCase();
  const hash = hashEmail(normalized);
  const u32 = hash.readUInt32BE(0);
  const days = longTailedDays(hash);
  const timezone = process.env.DEFAULT_TIMEZONE || "Australia/Melbourne";
  const jitterMs = (hash.readUInt32BE(12) % 86_400_000);
  const lastVisitIso = zonedIso(new Date(CACHE_ANCHOR_MS - days * 86_400_000 - jitterMs), timezone);
  return {
    email: normalized,
    lastVisitDaysAgo: days,
    lastVisitIso,
    timezone,
    clientId: uuidFromHash(hash),
    chromeMajor,
    serviceWorkerHint: (u32 % 2) === 0,
  };
}

/**
 * Logged variant — returns the profile and emits a one-line summary.
 */
export function getCacheProfileWithLog(
  email: string,
  chromeMajor?: number,
  logFn?: (msg: string) => void
): CacheProfile {
  const p = getCacheProfile(email, chromeMajor);
  if (logFn) logFn(`Cache: ${email} → last_visit ${p.lastVisitDaysAgo}d ago, client_id=${p.clientId.slice(0, 8)}…, sw=${p.serviceWorkerHint}`);
  return p;
}

/**
 * Build the addInitScript body that seeds localStorage with breadcrumbs.
 *
 * ANONYMOUS by design: the script intentionally writes NO per-credential
 * identifiers. High-entropy breadcrumbs (`client_id`, `last_visit`,
 * `browser_version`) were previously emitted from the CacheProfile and made
 * every session linkable across runs — anyone reading localStorage could
 * fingerprint the operator across credentials. The injection now seeds only
 * the single generic key (`user_timezone`) that real Chrome installs in many
 * locales and that some sites rely on for functional stability. Idempotent:
 * never overwrites a key the site has already set.
 *
 * The CacheProfile parameter is retained so the call signature is stable for
 * existing callers; only `profile.timezone` is read.
 */
export function getCacheInjectionScript(profile: CacheProfile): string {
  return `
(function() {
  try {
    if (typeof localStorage === 'undefined') return;
    function setIfAbsent(k, v) {
      try { if (localStorage.getItem(k) === null) localStorage.setItem(k, v); } catch { /* intentional */ }
    }
    setIfAbsent('user_timezone', ${JSON.stringify(profile.timezone)});
  } catch { /* intentional */ }
})();
  `;
}
