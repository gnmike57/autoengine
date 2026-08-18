/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
/**
 * Timezone + Locale Alignment
 * Aligns timezone and locale with proxy exit IP geolocation.
 * Prevents "location mismatch" bot detection when proxy location doesn't match browser settings.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import { Reader, type CityResponse, type CountryResponse } from "mmdb-lib";

export interface GeoProfile {
  timezone: string;
  locale: string;
  countryCode: string;
  city?: string;
  region?: "VIC" | "NSW" | "QLD" | "WA" | "SA";
  latitude?: number;
  longitude?: number;
  /** True when this profile represents a mobile device. When set, callers
   *  may assume `networkType` is also set (defaulting to "wifi" for non-AU
   *  countries). `carrier` and `isp` are AU-only — non-AU mobile profiles
   *  leave them undefined since the carrier table is AU-specific. Consumers
   *  reading carrier/isp must guard for undefined. */
  mobile?: boolean;
  /** Always populated when `mobile` is true (defaults to "wifi" for non-AU
   *  fallbacks). Safe to read unconditionally when `mobile === true`. */
  networkType?: "4g" | "5g" | "wifi";
  /** AU-only. Undefined on non-AU mobile profiles. */
  carrier?: string;
  /** AU-only. Undefined on non-AU mobile profiles. */
  isp?: string;
}

export const DEFAULT_COUNTRY = (process.env.DEFAULT_COUNTRY || "AU").trim().toUpperCase() || "AU";

const GEO_PROFILES: Record<string, GeoProfile> = {
  "US": { timezone: "America/New_York", locale: "en-US", countryCode: "US" },
  "GB": { timezone: "Europe/London", locale: "en-GB", countryCode: "GB" },
  "DE": { timezone: "Europe/Berlin", locale: "de-DE", countryCode: "DE" },
  "FR": { timezone: "Europe/Paris", locale: "fr-FR", countryCode: "FR" },
  "JP": { timezone: "Asia/Tokyo", locale: "ja-JP", countryCode: "JP" },
  "AU": { timezone: "Australia/Melbourne", locale: "en-AU", countryCode: "AU", city: "Melbourne", latitude: -37.8136, longitude: 144.9631 },
  "SG": { timezone: "Asia/Singapore", locale: "en-SG", countryCode: "SG" },
  "CA": { timezone: "America/Toronto", locale: "en-CA", countryCode: "CA" },
};

const AU_CITY_WEIGHTS: Array<Required<Pick<GeoProfile, "city" | "region" | "latitude" | "longitude">> & { weight: number; timezone: string }> = [
  { city: "Melbourne", region: "VIC", latitude: -37.8136, longitude: 144.9631, timezone: "Australia/Melbourne", weight: 40 },
  { city: "Sydney", region: "NSW", latitude: -33.8688, longitude: 151.2093, timezone: "Australia/Sydney", weight: 40 },
  { city: "Brisbane", region: "QLD", latitude: -27.4698, longitude: 153.0251, timezone: "Australia/Brisbane", weight: 12 },
  { city: "Perth", region: "WA", latitude: -31.9523, longitude: 115.8613, timezone: "Australia/Perth", weight: 5 },
  { city: "Adelaide", region: "SA", latitude: -34.9285, longitude: 138.6007, timezone: "Australia/Adelaide", weight: 3 },
];

// Australian mobile carrier market share (approximate, ACMA 2024).
const AU_MOBILE_CARRIERS: ReadonlyArray<{ carrier: string; isp: string; weight: number }> = [
  { carrier: "Telstra", isp: "Telstra Corporation Ltd", weight: 45 },
  { carrier: "Optus", isp: "Singtel Optus Pty Ltd", weight: 35 },
  { carrier: "Vodafone", isp: "TPG Telecom (Vodafone Hutchison Australia)", weight: 20 },
];

// Mobile-only geo entries. Coordinates are slight offsets from each capital's
// CBD to mimic tower-level dispersion. Network-type weighting biases 5G in
// metros, 4G elsewhere.
const AU_MOBILE_GEOS: Array<{
  city: string;
  region: "VIC" | "NSW" | "QLD" | "WA" | "SA";
  latitude: number;
  longitude: number;
  timezone: string;
  weight: number;
  networkType: "4g" | "5g";
}> = [
  // Melbourne
  { city: "Melbourne", region: "VIC", latitude: -37.8136, longitude: 144.9631, timezone: "Australia/Melbourne", weight: 22, networkType: "5g" },
  { city: "Melbourne", region: "VIC", latitude: -37.7980, longitude: 145.0120, timezone: "Australia/Melbourne", weight: 14, networkType: "4g" },
  // Sydney
  { city: "Sydney", region: "NSW", latitude: -33.8688, longitude: 151.2093, timezone: "Australia/Sydney", weight: 22, networkType: "5g" },
  { city: "Sydney", region: "NSW", latitude: -33.9000, longitude: 151.1800, timezone: "Australia/Sydney", weight: 14, networkType: "4g" },
  // Brisbane
  { city: "Brisbane", region: "QLD", latitude: -27.4698, longitude: 153.0251, timezone: "Australia/Brisbane", weight: 8, networkType: "5g" },
  { city: "Brisbane", region: "QLD", latitude: -27.4810, longitude: 153.0500, timezone: "Australia/Brisbane", weight: 4, networkType: "4g" },
  // Perth
  { city: "Perth", region: "WA", latitude: -31.9523, longitude: 115.8613, timezone: "Australia/Perth", weight: 5, networkType: "4g" },
  // Adelaide
  { city: "Adelaide", region: "SA", latitude: -34.9285, longitude: 138.6007, timezone: "Australia/Adelaide", weight: 3, networkType: "4g" },
];

let mmdbReader: Reader<CityResponse | CountryResponse> | null | undefined;

function seededBucket(seedKey?: string | number): number {
  if (seedKey == null || seedKey === "") return 0;
  const digest = crypto.createHash("sha256").update(String(seedKey).trim().toLowerCase()).digest();
  return digest.readUInt32BE(0) % 100;
}
export function pickAustralianCity(seedKey?: string | number): GeoProfile {
  const totalGeoWeight = AU_CITY_WEIGHTS.reduce((a, c) => a + c.weight, 0);
  const bucket = seededBucket(seedKey) % Math.max(totalGeoWeight, 1);
  let acc = 0;
  const picked = AU_CITY_WEIGHTS.find((c) => {
    acc += c.weight;
    return bucket < acc;
  })!;

  // Removed stateful round-robin to ensure strict determinism per seed

  return {
    timezone: picked.timezone,
    locale: "en-AU",
    countryCode: "AU",
    city: picked.city,
    region: picked.region,
    latitude: picked.latitude,
    longitude: picked.longitude,
  };
}

/**
 * AU-only mobile variant of pickAustralianCity. Uses a tower-level geo table
 * biased toward 5G in metros and 4G elsewhere, and attaches a deterministic
 * AU mobile carrier (Telstra / Optus / Vodafone) weighted by market share.
 * The seed bucket is salted with ":mobile-carrier" so the carrier pick is
 * independent of the city pick — same email won't be perfectly correlated
 * between (city, carrier) which would otherwise leak fingerprint structure.
 *
 * The returned profile is hardcoded to `countryCode: "AU"` / `locale: "en-AU"`.
 * Non-AU mobile callers must use `getGeoProfileForCountry(cc, seed, true)`,
 * which falls back to the static `GEO_PROFILES[cc]` with `mobile: true`
 * stamped on top (no carrier/network metadata — those are AU-only).
 */

export function pickAustralianMobileGeo(seedKey?: string | number): GeoProfile {
  const totalGeoWeight = AU_MOBILE_GEOS.reduce((a, g) => a + g.weight, 0);
  const geoBucket = seededBucket(seedKey) % Math.max(totalGeoWeight, 1);
  let acc = 0;
  const geo = AU_MOBILE_GEOS.find((g) => {
    acc += g.weight;
    return geoBucket < acc;
  })!;

  // Removed stateful round-robin to ensure strict determinism per seed

  const totalCarrierWeight = AU_MOBILE_CARRIERS.reduce((a, c) => a + c.weight, 0);
  const carrierBucket = seededBucket(seedKey == null ? "" : `${seedKey}:mobile-carrier`) % Math.max(totalCarrierWeight, 1);
  let cacc = 0;
  const carrier = AU_MOBILE_CARRIERS.find((c) => {
    cacc += c.weight;
    return carrierBucket < cacc;
  })!;

  return {
    timezone: geo.timezone,
    locale: "en-AU",
    countryCode: "AU",
    city: geo.city,
    region: geo.region,
    latitude: geo.latitude,
    longitude: geo.longitude,
    mobile: true,
    networkType: geo.networkType,
    carrier: carrier.carrier,
    isp: carrier.isp,
  };
}

function proxyHostname(proxyUrl: string): string {
  try {
    return new URL(proxyUrl).hostname.toLowerCase();
  } catch {
    // @ts-expect-error noUncheckedIndexedAccess
    return proxyUrl.replace(/^[a-z]+:\/\//i, "").split("@").pop()!.split(":")[0].toLowerCase();
  }
}

const mmdbCache = new Map<string, string | undefined>();
const MAX_MMDB_CACHE_SIZE = 5000;

function mmdbCountryForHost(host: string): string | undefined {
  if (!net.isIP(host)) return undefined;

  if (mmdbCache.has(host)) {
    const val = mmdbCache.get(host);
    mmdbCache.delete(host);
    mmdbCache.set(host, val);
    return val;
  }

  const mmdbPath = (process.env.GEOIP_MMDB_FILE || process.env.MMDB_FILE || "").trim();
  if (!mmdbPath) return undefined;

  let result: string | undefined = undefined;
  try {
    if (mmdbReader === undefined) {
      mmdbReader = fs.existsSync(mmdbPath) ? new Reader<CityResponse | CountryResponse>(fs.readFileSync(mmdbPath)) : null;
    }
    const hit = mmdbReader?.get(host) as any;
    result = hit?.country?.iso_code || hit?.registered_country?.iso_code;
  } catch {
    mmdbReader = null;
  }

  mmdbCache.set(host, result);
  if (mmdbCache.size > MAX_MMDB_CACHE_SIZE) {
    const firstKey = mmdbCache.keys().next().value;
    if (firstKey !== undefined) {
      mmdbCache.delete(firstKey);
    }
  }

  return result;
}

/**
 * Detect country code from proxy URL by hostname pattern matching.
 * For production-grade detection, use MaxMind GeoIP DB or external API.
 */
export function detectCountryFromProxy(proxyUrl: string): string {
  if (!proxyUrl || typeof proxyUrl !== "string") return DEFAULT_COUNTRY;
  const url = proxyUrl.toLowerCase();
  const host = proxyHostname(proxyUrl);
  const mmdbCountry = mmdbCountryForHost(host);
  if (mmdbCountry) return mmdbCountry.toUpperCase();
  if (/(^|[._-])(au|aus|australia)([._-]|$)/.test(host) || host.includes("sticky.lvprx") || host.includes(".au.smartproxy.com") || host.includes("au-residential") || host.includes("au-pr")) return "AU";
  if (url.includes("uk.") || url.includes("britain") || url.includes(".co.uk")) return "GB";
  if (url.includes("de.") || url.includes("germany")) return "DE";
  if (url.includes("fr.") || url.includes("france")) return "FR";
  if (url.includes("jp.") || url.includes("japan")) return "JP";
  if (url.includes("sg.") || url.includes("singapore")) return "SG";
  if (url.includes("ca.") || url.includes("canada")) return "CA";
  if (url.includes("us.") || url.includes("america") || url.includes("united-states")) return "US";
  return DEFAULT_COUNTRY;
}

/**
 * Get timezone and locale aligned to proxy exit location.
 * Returns AU default if proxyUrl is empty or unknown unless DEFAULT_COUNTRY explicitly overrides it.
 * When `mobile` is true and the resolved country is AU, returns a mobile-flavored
 * profile (tower-level geo + carrier + network type).
 */
export function alignGeoToProxy(proxyUrl?: string, seedKey?: string | number, mobile?: boolean): GeoProfile {
  const country = detectCountryFromProxy(proxyUrl || "");
  return getGeoProfileForCountry(country, seedKey, mobile);
}

/**
 * Return the geo profile for an explicit country code. AU uses the weighted
 * city picker so timezone/lat/long stay deterministic per seed; other
 * countries fall back to the static GEO_PROFILES map, then AU as last resort.
 * When `mobile` is true and the country is AU, picks from the mobile-tower
 * table with a deterministic AU carrier attached.
 */
export function getGeoProfileForCountry(country: string, seedKey?: string | number, mobile?: boolean): GeoProfile {
  const cc = (country || "").trim().toUpperCase();
  if (cc === "AU") return mobile ? pickAustralianMobileGeo(seedKey) : pickAustralianCity(seedKey);
  const base = GEO_PROFILES[cc] || GEO_PROFILES[DEFAULT_COUNTRY];
  if (!base) return pickAustralianCity(seedKey);
  // Non-AU mobile callers: keep the country/timezone/locale from the static
  // map but stamp `mobile: true` so downstream UA-CH / launch-flag wiring
  // still emulates a mobile device. networkType defaults to "wifi" so
  // consumers can read it unconditionally on any `mobile === true` profile.
  // Carrier/ISP are AU-only and remain undefined.
  return mobile ? { ...base, mobile: true, networkType: "wifi" } : base;
}

/**
 * Get geo profile with detailed logging.
 */
export function alignGeoToProxyWithLog(
  proxyUrl: string | undefined,
  logFn?: (msg: string) => void,
  mobile?: boolean,
): GeoProfile {
  const geo = alignGeoToProxy(proxyUrl, undefined, mobile);
  let proxyHost = "direct";
  if (proxyUrl) {
    try {
      const hostPart = proxyUrl.includes("@") ? proxyUrl.split("@")[1] : proxyUrl.replace(/^https?:\/\//, "");
      proxyHost = hostPart!.split(":")[0] || "direct";
    } catch {
      proxyHost = "unknown";
    }
  }
  const mobileTag = geo.mobile ? ` [mobile: ${geo.networkType ?? "?"}/${geo.carrier ?? "?"}]` : "";
  const msg = `Geo alignment: ${proxyHost} → ${geo.countryCode} (${geo.timezone} / ${geo.locale})${mobileTag}`;
  if (logFn) logFn(msg);
  return geo;
}

/**
 * Extract launch context arguments for timezone/locale.
 */
export function getGeoLaunchArgs(profile: GeoProfile) {
  return {
    timezone: profile.timezone,
    locale: profile.locale,
  };
}

/**
 * Validate timezone and locale strings (basic sanity check).
 */
export function validateGeoProfile(profile: GeoProfile): boolean {
  const validTimezone = /^[A-Z][a-z]+\/[A-Za-z_]+$/.test(profile.timezone);
  const validLocale = /^[a-z]{2}(-[A-Z]{2})?$/.test(profile.locale);
  return validTimezone && validLocale;
}
