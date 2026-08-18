/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-return, @typescript-eslint/restrict-template-expressions*/
/**
 * Spider settings — canonical typed surface for the Spider Cloud / Spider Local
 * backends, plus the central env loader (with AU hard-lock coercion), merger,
 * redactor, and backend normaliser.
 *
 * This module is a leaf: it must not import from cloak-backend.ts/engine.ts so
 * those files can import freely from here without cycles.
 *
 * AU hard-lock: the top-level `country` and `locale` fields are literal-typed
 * to "AU"/"en-AU". Non-AU values in env or merged patches are warned and
 * coerced back. The runtime city picker remains pickAustralianCity() in
 * profile-geo-alignment.ts; the cityWeights mirror exported below is
 * display-only and must be kept in sync with that picker.
 */
import { createLogger } from "./logger.js";
import { getEnvInt, getEnvBool, getEnvString } from "./env-utils.js";

const log = createLogger("spider-settings");

// ─── Discriminator types ──────────────────────────────────────────────────────

export type Backend = "cloak" | "spider-cloud" | "spider-local" | "curl-api" | "cloak-headless" | "cloak-headed" | "experimental" | "experimental-elimination" | "stealth" | "zendriver";

// ─── Spider settings value types ──────────────────────────────────────────────

export type AuthParam = "token" | "apiKey";
export type SpiderMode = "sdk" | "cdp";
export type SpiderBrowser = "chrome" | "firefox" | "spider" | "auto";
export type StealthLevel = number | "max";
export type CaptchaMode = "off" | "solve";
export type ProxyType = "residential" | "mobile" | "isp" | "datacenter";
export type ProxyProtocol = "http" | "https" | "socks5";
export type SessionReuseMode = "sticky" | "sticky-until-burn" | "always-fresh";

export type AUCountry = "AU";
export type AULocale = "en-AU";

export interface AUCityWeight {
  city: string;
  weight: number;
  region: "VIC" | "NSW" | "QLD" | "WA" | "SA";
  latitude: number;
  longitude: number;
  timezone: string;
}

/**
 * Canonical Spider settings schema. Flat by design: every key the Epic /
 * T1–T6 tickets reference (e.g. `country`, `stealth`, `apiKey`,
 * `aggressiveBlocklist`, `useResidentialGateway`, `unblockerFallback`) is
 * exposed at the top level so downstream consumers and the dashboard API
 * can read, patch, and redact fields without a grouping prefix. The
 * dashboard is free to derive a grouped view from this object, but the
 * grouped form is intentionally not the exported schema.
 */
export interface SpiderSettings {
  // Connection
  mode: SpiderMode;
  browser: SpiderBrowser;
  requestTimeoutSec: number;
  keepAliveMs: number;
  authParam: AuthParam;
  cdpBackoffMs: number;
  // Stealth
  stealth: StealthLevel;
  maxStealthLevels: number;
  fingerprint: boolean;
  antibot: boolean;
  captcha: CaptchaMode;
  smartRetry: boolean;
  aggressiveBlocklist: boolean;
  // Geo (AU hard-lock)
  country: AUCountry;
  locale: AULocale;
  cityWeights: ReadonlyArray<AUCityWeight>;
  // Proxy
  proxyType: ProxyType;
  proxyProtocol: ProxyProtocol;
  forceProxyProtocol: boolean;
  useResidentialGateway: boolean;
  gatewayPoolSize: number;
  // Concurrency
  maxConcurrency: number;
  staggerMs: number;
  hedge: boolean;
  // Recording
  record: boolean;
  // Escalation
  aiFallback: boolean;
  unblockerFallback: boolean;
  // Session reuse
  sessionReuse: SessionReuseMode;
  // Credit guardrails
  confirmRowsConcurrencyThreshold: number;
  killSwitch: boolean;
  // Auth
  apiKey?: string;
  localApiKey?: string;
  localEndpoint?: string;
  // Mobile emulation (used when osProfile === "android")
  emulateMobile: boolean;
  userAgentClientHintsMobile: boolean;
  mobileDeviceMemory: number;
  mobileScreen: { width: number; height: number; pixelRatio: number };
  touchEvents: boolean;
}

export type SpiderSettingsPartial = Partial<Omit<SpiderSettings, "cityWeights">>;

// ─── AU city weights mirror (display-only) ───────────────────────────────────
// Mirror of AU_CITY_WEIGHTS in profile-geo-alignment.ts. The runtime picker is
// pickAustralianCity() there — keep both tables in sync when editing either.
// Copied locally (not imported) to keep this module a leaf.
const AU_CITY_WEIGHTS_MIRROR: ReadonlyArray<AUCityWeight> = Object.freeze([
  { city: "Melbourne", weight: 40, region: "VIC", latitude: -37.8136, longitude: 144.9631, timezone: "Australia/Melbourne" },
  { city: "Sydney", weight: 40, region: "NSW", latitude: -33.8688, longitude: 151.2093, timezone: "Australia/Sydney" },
  { city: "Brisbane", weight: 12, region: "QLD", latitude: -27.4698, longitude: 153.0251, timezone: "Australia/Brisbane" },
  { city: "Perth", weight: 5, region: "WA", latitude: -31.9523, longitude: 115.8613, timezone: "Australia/Perth" },
  { city: "Adelaide", weight: 3, region: "SA", latitude: -34.9285, longitude: 138.6007, timezone: "Australia/Adelaide" },
] as const);

// ─── Defaults ────────────────────────────────────────────────────────────────

export const DEFAULT_SPIDER_SETTINGS: SpiderSettings = Object.freeze({
  // Connection
  mode: "sdk",
  browser: "spider",
  requestTimeoutSec: 120,
  keepAliveMs: 25000,
  authParam: "token",
  cdpBackoffMs: 5000,
  // Stealth
  stealth: 0,
  maxStealthLevels: 3,
  fingerprint: true,
  antibot: true,
  captcha: "solve",
  smartRetry: true,
  aggressiveBlocklist: true,
  // Geo (AU hard-lock)
  country: "AU",
  locale: "en-AU",
  cityWeights: AU_CITY_WEIGHTS_MIRROR,
  // Proxy
  proxyType: "residential",
  proxyProtocol: "http",
  forceProxyProtocol: false,
  useResidentialGateway: false,
  gatewayPoolSize: 200,
  // Concurrency
  maxConcurrency: 50,
  staggerMs: 200,
  hedge: true,
  // Recording
  record: true,
  // Escalation
  aiFallback: true,
  unblockerFallback: true,
  // Session reuse
  sessionReuse: "sticky-until-burn",
  // Credit guardrails
  confirmRowsConcurrencyThreshold: 500,
  killSwitch: false,
  // Mobile emulation defaults — off by default; engine flips these on when
  // osProfile === "android". Values mirror a mid-range modern Android (8 GB,
  // 1440×3120 @ 3.5x) so launches without per-credential UA metadata still
  // ship a coherent baseline.
  emulateMobile: false,
  userAgentClientHintsMobile: false,
  mobileDeviceMemory: 8,
  mobileScreen: { width: 1440, height: 3120, pixelRatio: 3.5 },
  touchEvents: false,
});

// Enum allow-lists used for env-value validation.
const MODE_VALUES: readonly SpiderMode[] = ["sdk", "cdp"] as const;
const BROWSER_VALUES: readonly SpiderBrowser[] = ["chrome", "firefox", "spider", "auto"] as const;
const AUTH_PARAM_VALUES: readonly AuthParam[] = ["token", "apiKey"] as const;
const CAPTCHA_VALUES: readonly CaptchaMode[] = ["off", "solve"] as const;
const PROXY_TYPE_VALUES: readonly ProxyType[] = ["residential", "mobile", "isp", "datacenter"] as const;
const PROXY_PROTOCOL_VALUES: readonly ProxyProtocol[] = ["http", "https", "socks5"] as const;
const SESSION_REUSE_VALUES: readonly SessionReuseMode[] = ["sticky", "sticky-until-burn", "always-fresh"] as const;

function pickEnum<T extends string>(
  key: string,
  raw: string,
  allowed: readonly T[],
  def: T,
): T {
  if (raw === "") return def;
  if ((allowed as readonly string[]).includes(raw)) return raw as T;
  log.warn(`${key}="${raw}" is not one of [${allowed.join(", ")}] — using default "${def}"`);
  return def;
}

function parseStealth(raw: string, def: StealthLevel): StealthLevel {
  if (raw === "") return def;
  if (raw === "max") return "max";
  const n = parseInt(raw, 10);
  if (Number.isFinite(n) && n >= 0 && n <= 9 && `${n}` === raw) {
    return n;
  }
  log.warn(`SPIDER_CLOUD_STEALTH="${raw}" is not 0..9 or "max" — using default "${String(def)}"`);
  return def;
}

/**
 * Clamp an integer env value to [min, max] (or to a one-sided minimum when
 * `max` is undefined), warning before the value is changed. The warning
 * mirrors the established style — env var name, provided value, allowed
 * bound/range, and clamped value — so operator misconfigurations are
 * visible in the loader output instead of being silently corrected.
 */
function clampInt(
  key: string,
  raw: number,
  min: number,
  max?: number,
): number {
  if (max !== undefined) {
    if (raw < min || raw > max) {
      const clamped = Math.min(max, Math.max(min, raw));
      log.warn(`${key}=${raw} out of range [${min},${max}], clamping to ${clamped}`);
      return clamped;
    }
    return raw;
  }
  if (raw < min) {
    log.warn(`${key}=${raw} below minimum ${min}, clamping to ${min}`);
    return min;
  }
  return raw;
}

// ─── Env loader ──────────────────────────────────────────────────────────────

/**
 * Build a SpiderSettings from defaults overlaid with environment variables.
 * Uses the canonical SPIDER_CLOUD_* / SPIDER_* variable names from the spec
 * (no aliases). Applies the AU hard-lock and per-field range clamps; the
 * `cityWeights` mirror is always taken from DEFAULT_SPIDER_SETTINGS.
 */
export function loadSpiderSettings(): SpiderSettings {
  const d = DEFAULT_SPIDER_SETTINGS;

  const mode = pickEnum<SpiderMode>(
    "SPIDER_CLOUD_MODE",
    getEnvString("SPIDER_CLOUD_MODE").toLowerCase(),
    MODE_VALUES,
    d.mode,
  );
  const browser = pickEnum<SpiderBrowser>(
    "SPIDER_CLOUD_BROWSER",
    getEnvString("SPIDER_CLOUD_BROWSER").toLowerCase(),
    BROWSER_VALUES,
    d.browser,
  );
  const stealth = parseStealth(getEnvString("SPIDER_CLOUD_STEALTH").toLowerCase(), d.stealth);
  const authParam = pickEnum<AuthParam>(
    "SPIDER_CLOUD_AUTH_PARAM",
    getEnvString("SPIDER_CLOUD_AUTH_PARAM"),
    AUTH_PARAM_VALUES,
    d.authParam,
  );
  const captcha = pickEnum<CaptchaMode>(
    "SPIDER_CLOUD_CAPTCHA",
    getEnvString("SPIDER_CLOUD_CAPTCHA").toLowerCase(),
    CAPTCHA_VALUES,
    d.captcha,
  );
  const proxyType = pickEnum<ProxyType>(
    "SPIDER_CLOUD_PROXY_TYPE",
    getEnvString("SPIDER_CLOUD_PROXY_TYPE").toLowerCase(),
    PROXY_TYPE_VALUES,
    d.proxyType,
  );
  const proxyProtocol = pickEnum<ProxyProtocol>(
    "SPIDER_PROXY_PROTOCOL",
    getEnvString("SPIDER_PROXY_PROTOCOL").toLowerCase(),
    PROXY_PROTOCOL_VALUES,
    d.proxyProtocol,
  );
  const sessionReuse = pickEnum<SessionReuseMode>(
    "SPIDER_SESSION_REUSE",
    getEnvString("SPIDER_SESSION_REUSE").toLowerCase(),
    SESSION_REUSE_VALUES,
    d.sessionReuse,
  );

  // Range clamps with spec-format warnings.
  const requestTimeoutSec = clampInt(
    "SPIDER_CLOUD_REQUEST_TIMEOUT",
    getEnvInt("SPIDER_CLOUD_REQUEST_TIMEOUT", d.requestTimeoutSec),
    5,
    255,
  );
  const maxConcurrency = clampInt(
    "SPIDER_CLOUD_MAX_CONCURRENCY",
    getEnvInt("SPIDER_CLOUD_MAX_CONCURRENCY", d.maxConcurrency),
    1,
    100,
  );
  const keepAliveMs = clampInt(
    "SPIDER_CLOUD_KEEPALIVE_MS",
    getEnvInt("SPIDER_CLOUD_KEEPALIVE_MS", d.keepAliveMs),
    0,
  );
  const cdpBackoffMs = clampInt(
    "SPIDER_CLOUD_BACKOFF_MS",
    getEnvInt("SPIDER_CLOUD_BACKOFF_MS", d.cdpBackoffMs),
    0,
  );
  const maxStealthLevels = clampInt(
    "SPIDER_CLOUD_MAX_STEALTH_LEVELS",
    getEnvInt("SPIDER_CLOUD_MAX_STEALTH_LEVELS", d.maxStealthLevels),
    0,
  );
  const gatewayPoolSize = clampInt(
    "SPIDER_GATEWAY_POOL_SIZE",
    getEnvInt("SPIDER_GATEWAY_POOL_SIZE", d.gatewayPoolSize),
    1,
  );
  const staggerMs = clampInt(
    "SPIDER_CLOUD_STAGGER_MS",
    getEnvInt("SPIDER_CLOUD_STAGGER_MS", d.staggerMs),
    0,
  );
  const confirmRowsConcurrencyThreshold = clampInt(
    "SPIDER_CONFIRM_THRESHOLD",
    getEnvInt("SPIDER_CONFIRM_THRESHOLD", d.confirmRowsConcurrencyThreshold),
    0,
  );

  // AU hard-lock: warn-and-force on any non-AU country/locale override.
  const rawCountry = getEnvString("SPIDER_CLOUD_COUNTRY");
  if (rawCountry && rawCountry.toUpperCase() !== "AU") {
    log.warn(`Non-AU override ignored: SPIDER_CLOUD_COUNTRY=${rawCountry}`);
  }
  const rawLocale = getEnvString("SPIDER_CLOUD_LOCALE");
  if (rawLocale && rawLocale !== "en-AU") {
    log.warn(`Non-AU override ignored: SPIDER_CLOUD_LOCALE=${rawLocale}`);
  }

  const apiKey = getEnvString("SPIDER_API_KEY");
  const localApiKey = getEnvString("SPIDER_LOCAL_API_KEY");
  const localEndpoint = getEnvString("SPIDER_LOCAL_ENDPOINT");

  return {
    mode,
    browser,
    requestTimeoutSec,
    keepAliveMs,
    authParam,
    cdpBackoffMs,
    stealth,
    maxStealthLevels,
    fingerprint: getEnvBool("SPIDER_CLOUD_FINGERPRINT", d.fingerprint),
    antibot: getEnvBool("SPIDER_CLOUD_ANTIBOT", d.antibot),
    captcha,
    smartRetry: getEnvBool("SPIDER_CLOUD_SMART_RETRY", d.smartRetry),
    aggressiveBlocklist: getEnvBool("SPIDER_CLOUD_AGGRESSIVE_BLOCKLIST", d.aggressiveBlocklist),
    country: "AU",
    locale: "en-AU",
    cityWeights: d.cityWeights,
    proxyType,
    proxyProtocol,
    forceProxyProtocol: getEnvBool("SPIDER_FORCE_PROXY_PROTOCOL", d.forceProxyProtocol),
    useResidentialGateway: getEnvBool("SPIDER_CLOUD_USE_RESIDENTIAL_GATEWAY", d.useResidentialGateway),
    gatewayPoolSize,
    maxConcurrency,
    staggerMs,
    hedge: getEnvBool("SPIDER_CLOUD_HEDGE", d.hedge),
    record: getEnvBool("SPIDER_CLOUD_RECORD", d.record),
    aiFallback: getEnvBool("SPIDER_AI_FALLBACK", d.aiFallback),
    unblockerFallback: getEnvBool("SPIDER_UNBLOCKER_FALLBACK", d.unblockerFallback),
    sessionReuse,
    confirmRowsConcurrencyThreshold,
    killSwitch: getEnvBool("SPIDER_KILL_SWITCH", d.killSwitch),
    emulateMobile: getEnvBool("SPIDER_EMULATE_MOBILE", d.emulateMobile),
    userAgentClientHintsMobile: getEnvBool("SPIDER_UA_CH_MOBILE", d.userAgentClientHintsMobile),
    mobileDeviceMemory: clampInt(
      "SPIDER_MOBILE_DEVICE_MEMORY",
      getEnvInt("SPIDER_MOBILE_DEVICE_MEMORY", d.mobileDeviceMemory),
      1,
      32,
    ),
    mobileScreen: d.mobileScreen,
    touchEvents: getEnvBool("SPIDER_TOUCH_EVENTS", d.touchEvents),
    ...(apiKey ? { apiKey } : {}),
    ...(localApiKey ? { localApiKey } : {}),
    ...(localEndpoint ? { localEndpoint } : {}),
  };
}

// ─── Merge / redact ──────────────────────────────────────────────────────────

/**
 * Merge a partial patch onto a base SpiderSettings. Shallow spread; the
 * `cityWeights` mirror is preserved from `base` (the partial type excludes
 * it). Non-AU country/locale overrides in the patch warn and are forced.
 */
export function mergeSpiderSettings(
  base: SpiderSettings,
  patch: SpiderSettingsPartial,
): SpiderSettings {
  // Shallow merge with cityWeights pinned to base
  const merged: SpiderSettings = { ...base, ...patch, cityWeights: base.cityWeights };

  // Country coercion (always) with conditional warning
  if (patch.country !== undefined) {
    if (String(patch.country).toUpperCase() !== "AU") {
      log.warn(`Non-AU override ignored (merge): country="${patch.country}" — forcing "AU"`);
    }
    merged.country = "AU";
  }

  // Locale coercion (always) with conditional warning
  if (patch.locale !== undefined) {
    if (patch.locale !== "en-AU") {
      log.warn(`Non-AU override ignored (merge): locale="${patch.locale}" — forcing "en-AU"`);
    }
    merged.locale = "en-AU";
  }

  return merged;
}

/**
 * Return a clone of `s` with `apiKey` and `localApiKey` replaced by "***"
 * when defined. `localEndpoint` is not a secret and is passed through.
 */
export function redactSpiderSettings(s: SpiderSettings): SpiderSettings {
  const out: SpiderSettings = { ...s };
  if (s.apiKey !== undefined) out.apiKey = "***";
  if (s.localApiKey !== undefined) out.localApiKey = "***";
  return out;
}

// ─── Backend normaliser ──────────────────────────────────────────────────────

/**
 * Map a raw backend string (env var or dashboard payload) to the canonical
 * Backend discriminator, preserving the "cloak-headed"/"cloak-headless"
 * launch-flag distinction. Legacy "cloak" maps to "cloak-headed"; legacy
 * "spider" maps to "spider-cloud". Empty/unknown → "spider-cloud".
 */
export function normalizeBackend(
  raw: string | undefined,
): Backend | "cloak-headed" | "cloak-headless" {
  const trimmed = (raw ?? "").trim().toLowerCase();
  if (trimmed === "") return "spider-cloud";
  switch (trimmed) {
    case "cloak":
      return "cloak-headed";
    case "cloak-headed":
      return "cloak-headed";
    case "cloak-headless":
      return "cloak-headless";

    case "spider":
      return "spider-cloud";
    case "spider-cloud":
      return "spider-cloud";
    case "spider-local":
      return "spider-local";
    case "stealth":
      return "stealth";
    case "camofox": // Alias for typos
      return "stealth";

    case "curl-api":
      return "curl-api";
    case "zendriver":
      return "zendriver";
    case "experimental":
      return "experimental";
    case "experimental-elimination":
      return "experimental-elimination";
    case "golden-benchmark":
      return "golden-benchmark" as any;
    default:
      log.warn(`Unknown backend "${raw}" — using fallback "spider-cloud"`);
      return "spider-cloud";
  }
}
