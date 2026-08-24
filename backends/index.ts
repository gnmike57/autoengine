/**
 * BACKENDS INDEX
 * Unified session creation, proxy pool, session pooling, and stealth utilities.
 * All logic is defined inline (canonical source of truth).
 */
import { createSpiderCloudSession } from "./spider-cloud.js";
import { createSpiderLocalSession } from "./spider-local.js";

import { createCloakSession } from "./cloak.js";
import { createStealthSession } from "./stealth.js";
import { createZendriverSession } from "./zendriver.js";
import type { ProxyForwarder } from "../src/proxy/proxy-forwarder.js";
import { preValidateProxy } from "../src/proxy/proxy-pre-ping.js";
import { DEFAULT_TARGETS } from "../src/targets/index.js";
import { tlsProxyEngine } from "../src/stealth/tls-proxy.js";
import { getRotationEngine } from "../src/stealth/fingerprint-rotation-engine.js";
import { startCdpEvidenceRecorder } from "../src/services/cdp-evidence-recorder.js";
import {
  MullvadSessionAdapter,
  type MullvadSessionLease,
  type MullvadSessionMode,
} from "../src/proxy/mullvad-session-adapter.js";
// ─── Spider Kill-Switch ────────────────────────────────────────────────────────
// Set to `true` to re-enable spider-cloud and spider-local
// backends app-wide. When `false`, all spider session creation is blocked at
// This gateway and callers fall through to cloak-headless.
export const SPIDER_ENABLED = true;

// Proxy pre-ping cache — avoids redundant 8s pings for the same proxy within 60s.
// Exported for use by proxy-pre-ping consumers.
export { preValidateProxy, DEFAULT_TARGETS };

async function attachCdpEvidence(handle: SessionHandle, opts: SessionOpts): Promise<SessionHandle> {
  if (!opts.enablePlaywrightTracing && !opts.recordVideo) return handle;
  const recorder = await startCdpEvidenceRecorder(handle.page, {
    outputDir: path.join(process.cwd(), "reports", "cdp"),
    sessionId: handle.sessionId,
  }).catch(() => undefined);
  if (!recorder) return handle;

  handle.cdpEvidencePath = recorder.path;
  handle.cdpEvidenceStarted = true;
  handle.cdpEvidenceFinalized = false;
  const originalClose = handle.close.bind(handle);
  let stopPromise: Promise<void> | undefined;
  const stopRecorder = (): Promise<void> => {
    stopPromise ??= recorder.stop().then(() => {
      handle.cdpEvidenceFinalized = true;
    }).catch(() => {
      handle.cdpEvidenceFinalized = false;
    });
    return stopPromise;
  };
  handle.close = async () => {
    await stopRecorder();
    await originalClose();
  };
  const originalForceKill = handle.forceKill?.bind(handle);
  if (originalForceKill) {
    handle.forceKill = () => {
      void stopRecorder();
      originalForceKill();
    };
  }
  return handle;
}

export interface ProxyRequirement {
  required: boolean;
  managedByBackend: boolean;
  pool?: string;
}

function normalizedProxyPool(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

export function resolveProxyRequirement(
  opts: Pick<SessionOpts, "backend" | "proxy" | "proxyPool" | "requireProxy">,
): ProxyRequirement {
  const pool = normalizedProxyPool(opts.proxyPool);
  const disabled = pool === "none" || pool === "off";
  const managedByBackend = opts.backend === "spider-cloud" && ["4r", "4m", "4i"].includes(pool);
  const required = opts.requireProxy ?? (!!opts.proxy || (!!pool && !disabled));
  return { required, managedByBackend, pool: pool || undefined };
}

export function isSessionProxyBound(
  handle: Pick<SessionHandle, "proxyUsed" | "proxyKey">,
  requirement: ProxyRequirement,
): boolean {
  if (!requirement.required) return true;
  if (requirement.managedByBackend) return handle.proxyUsed === "spider-managed";
  return !!handle.proxyUsed && !!handle.proxyKey && handle.proxyUsed !== "DIRECT";
}

function attachSessionNetworkLease(handle: SessionHandle, lease: MullvadSessionLease | undefined): SessionHandle {
  if (!lease) return handle;
  handle.networkLeaseId = lease.id;
  handle.networkLeaseMode = lease.mode;
  handle.networkLeaseIsolation = lease.isolation;
  handle.networkConfigId = lease.configId;
  handle.networkExitProof = lease.exitProof;
  handle.networkLeaseAssertHealthy = lease.assertHealthy;

  const originalClose = handle.close.bind(handle);
  let closePromise: Promise<void> | undefined;
  handle.close = () => {
    closePromise ??= originalClose().finally(() => lease.close());
    return closePromise;
  };
  const originalForceKill = handle.forceKill?.bind(handle);
  if (originalForceKill) {
    handle.forceKill = () => {
      originalForceKill();
      void lease.close();
    };
  }
  return handle;
}

async function finalizeSessionProxyContract(
  handle: SessionHandle,
  opts: SessionOpts,
  requirement: ProxyRequirement,
): Promise<SessionHandle> {
  handle.proxyRequired = requirement.required;
  handle.proxyPool = requirement.pool;
  opts.networkLease?.assertHealthy();
  if (!isSessionProxyBound(handle, requirement)) {
    await handle.close().catch(() => {});
    await opts.networkLease?.close().catch(() => {});
    throw new Error(`proxy-required-session-not-bound:${requirement.pool ?? "explicit"}`);
  }
  const withEvidence = await attachCdpEvidence(handle, opts);
  opts.networkLease?.assertHealthy();
  return attachSessionNetworkLease(withEvidence, opts.networkLease);
}

async function launchSessionWithContract(
  factory: () => Promise<SessionHandle>,
  opts: SessionOpts,
  requirement: ProxyRequirement,
): Promise<SessionHandle> {
  try {
    return await finalizeSessionProxyContract(await factory(), opts, requirement);
  } catch (error) {
    await opts.networkLease?.close().catch(() => {});
    throw error;
  }
}

// Re-export session creation logic unified
export async function createSession(opts: SessionOpts): Promise<SessionHandle> {
  if (opts.email) {
    const engine = getRotationEngine();
    if (opts.advanceRotation) {
      if (opts.rotation === undefined) {
        opts.rotation = engine.getRotation(opts.email);
      }
      engine.recordSession(opts.email);
    } else if (opts.rotation === undefined) {
      opts.rotation = engine.getRotation(opts.email);
    }
  }
  const proxyRequirement = resolveProxyRequirement(opts);
  if (proxyRequirement.required && (proxyRequirement.pool === "none" || proxyRequirement.pool === "off")) {
    throw new Error("proxy-required-but-pool-disabled");
  }

  const isExplicitPool = !!opts.proxyPool && opts.proxyPool !== "off" && opts.proxyPool !== "none";
  const isMullvadPool = opts.proxyPool?.startsWith("mullvad") || opts.mullvadSessionMode !== undefined;

  const mullvadAdapter = MullvadSessionAdapter.fromEnvironment(opts.mullvadSessionMode);
  if (mullvadAdapter.mode !== "disabled" && (!isExplicitPool || isMullvadPool)) {
    if (opts.proxy || opts.networkLease) throw new Error("mullvad-session-conflicts-with-explicit-proxy");
    const lease = await mullvadAdapter.acquire(opts.email ?? crypto.randomUUID());
    opts = {
      ...opts,
      proxy: lease.proxy,
      proxyPool: `mullvad-${lease.mode}`,
      requireProxy: true,
      networkLease: lease,
    };
  }
  if (!opts.proxy && opts.proxyPool && !proxyRequirement.managedByBackend) {
    const picked = pickProxy(opts.excludeProxies ?? [], opts.email, opts.backend, opts.proxyPool);
    if (picked) {
      opts = { ...opts, proxy: picked };
      log.info(`[createSession] Auto-picked proxy from pool "${opts.proxyPool}": ${proxyEntryKey(picked)}`);
    }
  }
  if (proxyRequirement.required && !proxyRequirement.managedByBackend && !opts.proxy) {
    throw new Error(`proxy-required-no-usable-entry:${proxyRequirement.pool ?? "explicit"}`);
  }

  // Apex Enhancement #3: Quantum TLS Evasion
  // ONLY apply Node.js TLS injection to Zendriver. 
  // Camoufox (stealth) handles TLS at the C++ level.
  if (opts.backend?.startsWith("zendriver")) {
    await tlsProxyEngine.loadProfiles();
    const ua = opts.uaProfile?.ua || "Chrome";
    const os = opts.uaProfile?.os || "Windows";
    const tlsProfile = tlsProxyEngine.getProfileMatch(ua, os);
    
    if (tlsProfile) {
      log.info(`[createSession] Applying Quantum TLS Evasion profile: ${tlsProfile.browser} ${tlsProfile.version} (${tlsProfile.id})`);
      opts = {
        ...opts,
        agentOptions: tlsProxyEngine.getStealthAgentOptions(tlsProfile)
      };
    }
  }

  if (SPIDER_ENABLED) {
    if (opts.backend === "spider" || opts.backend === "spider-cloud") {
      return launchSessionWithContract(() => createSpiderCloudSession(opts), opts, proxyRequirement);
    }
    if (opts.backend === "spider-local" || opts.backend === "spider-local-headed") {
      if (opts.backend === "spider-local-headed") opts = { ...opts, headless: false, liveTest: true };
      return launchSessionWithContract(() => createSpiderLocalSession(opts), opts, proxyRequirement);
    }
  } else if (opts.backend === "spider" || opts.backend === "spider-cloud" || opts.backend === "spider-local" || opts.backend === "spider-local-headed") {
    log.warn(`[createSession] Spider backend "${opts.backend}" requested but SPIDER_ENABLED=false — falling back to cloak-headless`);
    opts = { ...opts, backend: "cloak-headless" };
  }
  if (opts.backend?.startsWith("cloak-")) {
    if (opts.backend?.includes("nocloak")) opts = { ...opts, useHttpCloak: false };
    if (opts.backend?.includes("headed")) opts = { ...opts, headless: false, liveTest: true };
    else opts = { ...opts, headless: true, liveTest: false };
    return launchSessionWithContract(() => createCloakSession(opts), opts, proxyRequirement);
  }
  if (opts.backend?.startsWith("stealth")) {
    if (opts.backend?.includes("headed")) opts = { ...opts, headless: false, liveTest: true };
    else opts = { ...opts, headless: true, liveTest: false };
    if (opts.backend?.includes("httpcloak")) opts = { ...opts, useHttpCloak: true };
    // Apex Enhancement #3: Drop Redundant JS Injections for Native Engines
    opts = { ...opts, injectStealthJS: false };
    return launchSessionWithContract(() => createStealthSession(opts), opts, proxyRequirement);
  }
  if (opts.backend?.startsWith("zendriver")) {
    if (opts.backend?.includes("headed")) opts = { ...opts, headless: false, liveTest: true };
    else opts = { ...opts, headless: true, liveTest: false };
    return launchSessionWithContract(() => createZendriverSession(opts), opts, proxyRequirement);
  }
  // Default fallback — cloak-headless (was spider-cloud before spider was disabled)
  const fallbackOpts = { ...opts, backend: "cloak-headless" as const };
  return launchSessionWithContract(() => createCloakSession(fallbackOpts), fallbackOpts, proxyRequirement);
}

/**
 * Backend adapter — switches between Spider Cloud, Spider Local
 * (cloud), and CloakBrowser (local, real Chromium with C++ source-level stealth patches).
 *
 * Selected via env: BACKEND=spider-cloud | spider-local | cloak
 * (default: spider-cloud; legacy BACKEND=spider normalises to spider-cloud).
 * For cloak: AU_PROXY_URL controls outbound proxy; if empty, runs direct.
 *
 * Returns a uniform SessionHandle so engine.ts and fingerprint-test.ts
 * stay backend-agnostic from the consumer side.
 */
import "dotenv/config";
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from "../src/core/logger.js";

export const log = createLogger("cloak-backend");
export const poolLog = createLogger("cloak-pool");
// playwright-core: shared BrowserContext/Page types (what cloakbrowser's
// launchContext() returns) and the chromium client used to connect to
// cloud-managed browser over CDP.
import { type BrowserContext, type Page } from "playwright-core";
import { type HardwareProfile } from "../src/profiles/profile-determinism.js";
import { DEFAULT_COUNTRY, type GeoProfile } from "../src/profiles/profile-geo-alignment.js";
import {
  type CredentialNoiseProfile,
} from "../src/profiles/profile-credential-noise.js";
import { getConsistentUserAgent, type TargetOS, type UAProfile } from "../src/profiles/profile-useragent.js";
import { type FontProfile } from "../src/profiles/profile-fonts.js";
import {
  type Resolution,
} from "../src/profiles/profile-resolution.js";
import { resolveScreenBounds, type ScreenBounds } from "../src/profiles/viewport-resolver.js";
import { type InteractionPattern } from "../src/profiles/profile-interaction.js";
import {
  getExtensionInjectionScript,
  type ExtensionProfile,
} from "../src/profiles/profile-extensions.js";
import { getCacheInjectionScript, type CacheProfile } from "../src/profiles/profile-cache.js";
import { verifyFingerprintCoherence } from "../src/stealth/fingerprint-ai-verifier.js";
import { getEnvInt } from "../src/core/env-utils.js";
import { type Backend, type ProxyProtocol, type SpiderSettings } from "../src/core/spider-settings.js";
import { ProxyScoreTracker, proxyEntryKey } from "../src/proxy/proxy-score-tracker.js";
import { type ClipBox } from "../src/services/screenshot-service.js";
import { buildStealthScripts  } from "../src/stealth/stealth-scripts.js";
import { sanitizeBrowserContext } from "../src/stealth/context-sanitizer.js";
import { profileMetrics } from "../src/profiles/profile-metrics.js";
import { evaluateReuse, QuarantineSet } from "../src/core/pool-decisions.js";
import { misdirectionDenylist } from "../src/core/misdirection-denylist.js";
import ffmpeg from "fluent-ffmpeg";
import ffmpegInstaller from "ffmpeg-static";

if (ffmpegInstaller) {
  ffmpeg.setFfmpegPath(ffmpegInstaller as unknown as string);
}
export type ProxyEntry = {
  server: string;
  username?: string;
  password?: string;
  /** Parsed scheme of `server` — preserved separately so callers (Spider SDK,
   *  Playwright launch options, force-protocol overrides) can reason about
   *  it without re-parsing the URL each time. */
  protocol?: ProxyProtocol;
};

/**
 * Loads a proxy pool from a file in either URL form
 * (`scheme://[user:pass@]host:port`) or LiveProxies-style colon-delimited form
 * (`[scheme://]host:port:user:pass`), one entry per line. Each entry becomes a
 * sticky residential session. `socks5://`, `http://`, and `https://` prefixes
 * on colon-delimited lines are stripped before splitting so the scheme is
 * preserved on the returned `protocol` field.
 */
export function loadProxyPool(filePath: string, envVarName: string): ProxyEntry[] {
  if (!filePath) return [];
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    return raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((line): ProxyEntry | null => {
      // URL form with embedded credentials, e.g. `socks5://user:pass@host:port`.
      // new URL() succeeds here; the colon-delimited fallback below would
      // mis-parse the scheme as the first segment.
      if (/^(https?|socks5):\/\/[^:]+:[^@]+@/i.test(line)) {
        try {
          const u = new URL(line);
          const protocol = u.protocol.replace(":", "").toLowerCase() as ProxyProtocol;
          return {
            server: `${u.protocol}//${u.hostname}${u.port ? ":" + u.port : ""}`,
            username: u.username ? decodeURIComponent(u.username) : undefined,
            password: u.password ? decodeURIComponent(u.password) : undefined,
            protocol,
          };
        } catch (e) {
          log.warn(`Failed to parse proxy URL: ${line} — ${e instanceof Error ? e.message : String(e)}`);
          return null;
        }
      }
      // Colon-delimited form, optionally prefixed with `scheme://`. Strip the
      // prefix first so the colon-split sees only host:port:user:pass parts.
      let protocol: ProxyProtocol = "http";
      let stripped = line;
      const schemeMatch = /^(https?|socks5):\/\//i.exec(line);
      if (schemeMatch) {
      // @ts-expect-error noUncheckedIndexedAccess
        protocol = schemeMatch[1].toLowerCase() as ProxyProtocol;
        stripped = line.slice(schemeMatch[0].length);
      }
      const parts = stripped.split(":");
      if (parts.length < 2) return null; // Must have at least host and port
      const [host, port, user, ...passParts] = parts;
      const pass = passParts.length > 0 ? passParts.join(":") : undefined;
      return { server: `${protocol}://${host}:${port}`, username: user, password: pass, protocol };
    }).filter((e): e is ProxyEntry => e !== null);
  } catch (e: unknown) {
    log.warn(`Failed to read ${envVarName}=${filePath}: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }
}

export const PRIMARY_PROXY_URL = process.env.PRIMARY_PROXY_URL || "http://default-proxy:12323";

export function buildPrimaryPool(): ProxyEntry[] {
  try {
    const u = new URL(PRIMARY_PROXY_URL);
    // Expand to 25 instances with stable, deterministic usernames
    return Array.from({ length: 25 }).map((_, i) => ({
      server: `${u.protocol}//${u.hostname}${u.port ? ":" + u.port : ""}`,
      username: `${u.username}_${i}`,
      password: u.password,
      protocol: u.protocol.replace(":", "").toLowerCase() as ProxyProtocol,
    }));
  } catch (e) {
    log.warn(`Failed to parse PRIMARY_PROXY_URL: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }
}

/** Primary pool (Pool 1) */
export const PROXY_POOL: ProxyEntry[] = buildPrimaryPool();

export const SPIDER_API_KEY = process.env.SPIDER_API_KEY || "";

export function buildSpiderProxyPool(type: "residential" | "mobile" | "isp"): ProxyEntry[] {
  if (!SPIDER_API_KEY) return [];
  const password = `proxy=${type}&country_code=AU&trackers_disabled=false`;
  return [
    {
      server: `http://proxy.spider.cloud:8888`,
      protocol: "http",
      username: SPIDER_API_KEY,
      password: password
    },
    {
      server: `https://proxy.spider.cloud:8888`,
      protocol: "https",
      username: SPIDER_API_KEY,
      password: password
    },
    {
      server: `socks5://proxy.spider.cloud:8888`,
      protocol: "socks5",
      username: SPIDER_API_KEY,
      password: password
    }
  ];
}

export const SPIDER_PROXY_RESIDENTIAL_POOL: ProxyEntry[] = buildSpiderProxyPool("residential");
export const SPIDER_PROXY_MOBILE_POOL: ProxyEntry[] = buildSpiderProxyPool("mobile");
export const SPIDER_PROXY_ISP_POOL: ProxyEntry[] = buildSpiderProxyPool("isp");


/** Module-singleton reputation tracker. Engine loads/persists it across runs. */
export const proxyScoreTracker = new ProxyScoreTracker();

// (proxyEntryKey moved to proxy-score-tracker.ts to fix circular dependency)

/**
 * Apply the standard burned-filter → exclude-filter → email-deterministic /
 * scored-pick pipeline to a single pool. Returns `undefined` when the pool
 * has no safe candidates so the caller can fall through to the next tier.
 *
 * When `randomOnly` is true, the email-deterministic and reputation-scored
 * branches are bypassed in favor of uniform random selection. This is the
 * mode used for the built-in pool, where each port is a fresh sticky
 * session and we explicitly do NOT want email→port affinity.
 */
export function pickFromPool(
  pool: ProxyEntry[],
  exclude: string[],
  _email: string | undefined,
  randomOnly = false,
): ProxyEntry | undefined {
  if (pool.length === 0) return undefined;
  
  // Hard denylist filter: sticky sessions burned by site-side misdirection
  // are removed up-front
  const burned = new Set(misdirectionDenylist.getBurnedProxies());
  const safePool = burned.size > 0 ? pool.filter((p) => !burned.has(proxyEntryKey(p))) : pool;
  if (safePool.length === 0) return undefined;

  // Exclude is a real constraint, not a hint.
  const candidates = exclude.length === 0
    ? safePool
    : safePool.filter((p) => !exclude.includes(proxyEntryKey(p)));

  if (candidates.length === 0) return undefined;

  if (randomOnly) {
    return candidates[Math.floor(Math.random() * candidates.length)];
  }
  return proxyScoreTracker.weightedPick(candidates, exclude, DEFAULT_COUNTRY) ?? candidates[Math.floor(Math.random() * candidates.length)];
}

export function pickProxy(exclude: string[] = [], email?: string, backend?: string, proxyPoolOverride?: string): ProxyEntry | undefined {
  const poolToggle = (proxyPoolOverride || process.env.EXTERNAL_PROXY_POOL || "").trim();
  if (backend === "spider-cloud" && ["4r", "4m", "4i"].includes(poolToggle)) {
    return undefined;
  }
  if (poolToggle === "1") {
    return pickFromPool(PROXY_POOL, exclude, email) || (PROXY_POOL.length > 0 ? PROXY_POOL[0] : undefined);
  } else if (poolToggle === "4r") {
    return pickFromPool(SPIDER_PROXY_RESIDENTIAL_POOL, exclude, email);
  } else if (poolToggle === "4m") {
    return pickFromPool(SPIDER_PROXY_MOBILE_POOL, exclude, email);
  } else if (poolToggle === "4i") {
    return pickFromPool(SPIDER_PROXY_ISP_POOL, exclude, email);
  } else if (poolToggle.toLowerCase() === "none" || poolToggle.toLowerCase() === "off") {
    return undefined;
  }

  // Generic numbered pool: load proxy-pool-{id}.txt dynamically (e.g. pool 6, 7, etc.)
  if (poolToggle) {
    const pool = loadNumberedPool(poolToggle);
    if (pool.length > 0) {
      return pickFromPool(pool, exclude, email) || pool[0];
    }
    log.warn(`[pickProxy] Pool "${poolToggle}" resolved to 0 proxies`);
  }

  return undefined;
}

export function getActiveProxyPool(backend?: string, proxyPoolOverride?: string): ProxyEntry[] {
  const poolToggle = (proxyPoolOverride || process.env.EXTERNAL_PROXY_POOL || "").trim();
  if (backend === "spider-cloud" && ["4r", "4m", "4i"].includes(poolToggle)) {
    return [];
  }
  if (poolToggle === "1") {
    return PROXY_POOL;
  } else if (poolToggle === "4r") {
    return SPIDER_PROXY_RESIDENTIAL_POOL;
  } else if (poolToggle === "4m") {
    return SPIDER_PROXY_MOBILE_POOL;
  } else if (poolToggle === "4i") {
    return SPIDER_PROXY_ISP_POOL;
  } else if (poolToggle.toLowerCase() === "none" || poolToggle.toLowerCase() === "off") {
    return [];
  }

  if (poolToggle) {
    return loadNumberedPool(poolToggle);
  }

  return [];
}

// Cache for dynamically loaded numbered proxy pools (proxy-pool-N.txt)
const _numberedPoolCache: Map<string, ProxyEntry[]> = new Map();
function loadNumberedPool(poolId: string): ProxyEntry[] {
  if (_numberedPoolCache.has(poolId)) return _numberedPoolCache.get(poolId)!;
  const poolFile = path.join(process.cwd(), `proxy-pool-${poolId}.txt`);
  const pool = loadProxyPool(poolFile, `POOL_${poolId}`);
  _numberedPoolCache.set(poolId, pool);
  if (pool.length > 0) {
    log.info(`[pickProxy] Loaded pool "${poolId}" from ${poolFile}: ${pool.length} proxies`);
  }
  return pool;
}

/** Total proxy universe across all tiers (PRIMARY + FALLBACK). Used
 *  by the engine row-retry guard ("do we have more proxies to try than the
 *  row has already tried?") where every selectable entry counts equally. */
export function getProxyPoolSize(): number {
  const poolToggle = (process.env.EXTERNAL_PROXY_POOL || "").trim();
  if (poolToggle === "1") return PROXY_POOL.length;
  if (poolToggle === "4r") return SPIDER_PROXY_RESIDENTIAL_POOL.length;
  if (poolToggle === "4m") return SPIDER_PROXY_MOBILE_POOL.length;
  if (poolToggle === "4i") return SPIDER_PROXY_ISP_POOL.length;
  if (poolToggle.toLowerCase() === "none" || poolToggle.toLowerCase() === "off") return 0;
  if (poolToggle) return loadNumberedPool(poolToggle).length;
  return 0;
}

export function getPrimaryPoolSize(): number { return PROXY_POOL.length; }

export const PROXY_INFO = (() => {
  const parts: string[] = [];
  if (PROXY_POOL.length > 0) parts.push(`primary pool of ${PROXY_POOL.length}`);
  if (SPIDER_PROXY_RESIDENTIAL_POOL.length > 0) parts.push(`pool 4r of ${SPIDER_PROXY_RESIDENTIAL_POOL.length} (Spider AU Residential)`);
  if (SPIDER_PROXY_MOBILE_POOL.length > 0) parts.push(`pool 4m of ${SPIDER_PROXY_MOBILE_POOL.length} (Spider AU Mobile)`);
  if (SPIDER_PROXY_ISP_POOL.length > 0) parts.push(`pool 4i of ${SPIDER_PROXY_ISP_POOL.length} (Spider AU ISP)`);
  if (parts.length > 0) return parts.join(" + ");
    return "none — DIRECT";
})();

export interface SessionHandle {
  context: BrowserContext;
  page: Page;
  sessionId: string;
  recordingUrl: string;
  recordingThumbnailUrl?: string;
  recordingHash?: string;
  harUrl?: string;
  tracePath?: string;
  traceStarted?: boolean;
  traceFinalized?: boolean;
  cdpEvidencePath?: string;
  cdpEvidenceStarted?: boolean;
  cdpEvidenceFinalized?: boolean;
  backend: Backend;
  fingerprintSeed?: number;
  proxyUsed?: string;       // gateway display string (server only) — for logs
  proxyKey?: string;        // unique sticky-session identifier (server#username) — for exclusion tracking
  proxyRequired?: boolean;  // true when direct egress is forbidden for this session
  proxyPool?: string;       // normalized pool identifier used for the session contract
  networkLeaseId?: string;
  networkLeaseMode?: Exclude<MullvadSessionMode, "disabled">;
  networkLeaseIsolation?: MullvadSessionLease["isolation"];
  networkConfigId?: string;
  networkExitProof?: string;
  networkLeaseAssertHealthy?: () => void;
  hardwareProfile?: HardwareProfile;
  geoProfile?: GeoProfile;
  noiseProfile?: CredentialNoiseProfile;
  uaProfile?: UAProfile;
  fontProfile?: FontProfile;
  resolutionProfile?: Resolution;
  interactionProfile?: InteractionPattern;
  extensionProfile?: ExtensionProfile;
  cacheProfile?: CacheProfile;
  email?: string;
  configAcronym?: string;
  recordingStartTime?: number;
  videoTrimOffsetMs?: number;
  videoCropBox?: ClipBox;
  /** Ordered list of target-site names this session has been used to test
   *  (e.g. ["joe", "ignition"]). The engine pushes the site name onto this
   *  array immediately before running each site's login flow, so the
   *  recording filename can be tagged with the relevant site tokens — even
   *  though one session covers all targets sequentially. */
  sitesUsed?: string[];
  /** spider-browser SDK instance (spider-cloud backend only). */
  spiderBrowser?: import("spider-browser").SpiderBrowser;
  /** spider-browser SpiderPage (spider-cloud backend only). */
  spiderPage?: import("spider-browser").SpiderPage;
  close: () => Promise<void>;
  forceKill?: () => void;
}

export interface SessionOpts {
  mode?: string;
  projectId?: string;
  viewport?: { width: number; height: number };
  slowMo?: number;
  fingerprintSeed?: number;
  advanceRotation?: boolean;
  headless?: boolean;
  timeoutSec?: number;
  excludeProxies?: string[];
  proxy?: ProxyEntry;
  email?: string;
  rotation?: number;
  backend?: "spider" | "spider-cloud" | "spider-local" | "spider-local-headed" | "cloak-headed" | "cloak-headless" | "cloak-headless-nocloak" | "cloak-headed-nocloak" | "stealth" | "stealth-headed" | "stealth-httpcloak" | "zendriver" | "zendriver-headed" | "split-local" | "split-local-headed" | "split-local-stealth" | "golden-benchmark" | "experimental" | "experimental-elimination" | "curl-api";
  spiderApiKey?: string;
  spiderLocalApiKey?: string;
  spiderSettings?: SpiderSettings;
  osProfile?: TargetOS;
  /** Per-call only; never persisted. Used by the validated single-recovery
   *  BurnedFingerprintError path to reuse a specific Spider session id. */
  spiderSessionIdOverride?: string;
  /** Per-call only; never persisted. Allows exactly one bypass of the
   *  misdirectionDenylist.isFingerprintBurned(seed) guard during recovery. */
  spiderRecoveryBypassBurnedSeed?: boolean;
  liveTest?: boolean;
  enableCacheInjection?: boolean;
  recordVideo?: boolean;
  enablePlaywrightTracing?: boolean;
  cleanSession?: boolean;
  agentOptions?: Record<string, any>;
  /** Two-letter country code from engine config — accepted here as a pass-through
   *  so engine.ts callers can forward `config.proxyCountry` without TS friction.
   *  Currently unused by createSession itself (proxy country is inferred from
   *  the selected proxy); retained as a hook for future routing logic. */
  proxyCountry?: string;
  /** BCP-47 locale override from engine config. Currently coerced to "en-AU"
   *  downstream; accepted at the surface so engine.ts callers can forward
   *  `config.locale` without TS friction. */
  locale?: string;
  /** Request mode hook from engine config (e.g. "stealth-max", "fast"); reserved
   *  for routing/launch-arg variation. Accepted at the surface to keep
   *  engine.ts callers free of excess-property errors. */
  requestMode?: string;
  parallelSiteTesting?: boolean;
  useHttpCloak?: boolean;
  stealthBypassHttpCloak?: boolean;
  proxyPool?: string;
  mullvadSessionMode?: MullvadSessionMode;
  networkLease?: MullvadSessionLease;
  /** Fail closed when no usable proxy can be bound. Defaults to true whenever
   *  a non-off proxy pool or explicit proxy is configured. */
  requireProxy?: boolean;
  // ─── Mobile / Android emulation ────────────────────────────────────────────
  /** Emulate a mobile device. Engine sets this `true` when osProfile==="android".
   *  When true, downstream launch wiring should apply touch events, mobile
   *  viewport, Sec-CH-UA-Mobile=?1, and pull the per-credential mobile UA
   *  metadata from profile-useragent.ts. */
  mobile?: boolean;
  /** Override window/viewport size, e.g. "1440x3120". Defaults to the
   *  per-credential UAProfile.screen when omitted. */
  windowSize?: string;
  /** Override CSS-px pixel ratio, e.g. 3.5. Defaults to the per-credential
   *  UAProfile.screen.pixelRatio when omitted. */
  deviceScaleFactor?: number;
  /** Force `hasTouch: true` on the Playwright context and inject pointer:coarse
   *  media-query overrides. Defaults to true when `mobile` is true. */
  touchEvents?: boolean;
  requeueCount?: number;
  injectStealthJS?: boolean;
  captchaServiceUrl?: string;
  uaProfile?: UAProfile;
}

export function envFlag(name: string): boolean | undefined {
  const raw = process.env[name];
  if (raw == null || raw === "") return undefined;
  return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
}

export function shouldRecordLocalVideo(opts: SessionOpts): boolean {
  if (typeof opts.recordVideo === "boolean") return opts.recordVideo;
  const explicit = envFlag("CLOAK_RECORD_VIDEO") ?? envFlag("LOCAL_RECORD_VIDEO");
  return explicit ?? !!opts.liveTest;
}

export function shouldUseCleanLocalProfile(opts: Pick<SessionOpts, "cleanSession">): boolean {
  if (typeof opts.cleanSession === "boolean") return opts.cleanSession;
  const reuse = envFlag("CLOAK_REUSE_PROFILES") ?? envFlag("LOCAL_REUSE_PROFILES");
  return !(reuse ?? false);
}

export function localProfileRoot(): string {
  // Rule 8: user-data-dirs MUST be in tracked directories, not os.tmpdir()
  return process.env.CLOAK_PROFILE_DIR || path.join(process.cwd(), ".cloak-profiles");
}

export function stableProfileName(email: string | undefined, seed: number, headed: boolean, retrySuffix: string): string {
  const base = email ? `email-${crypto.createHash("sha256").update(email).digest("hex").slice(0, 16)}` : `seed-${seed}${headed ? "-headed" : ""}`;
  return `${base}${retrySuffix}`;
}

/** Sanitize a path component to prevent directory traversal. */
export function sanitizePathComponent(str: string): string {
  return str.replace(/[^a-zA-Z0-9_-]/g, '');
}

export function isolatedProfileDir(sessionId: string, email: string | undefined, headed: boolean): string {
  const safeSessionId = sanitizePathComponent(sessionId);
  if (!safeSessionId || safeSessionId.length < 4) {
    throw new Error('Invalid sessionId');
  }
  const emailPart = email ? crypto.createHash("sha256").update(email.toLowerCase().trim()).digest("hex").slice(0, 8) : "anon";
  return path.join(localProfileRoot(), "isolated-sessions", `${safeSessionId}-${emailPart}-${headed ? "headed" : "headless"}`);
}

export async function cleanupIsolatedProfile(userDataDir: string | undefined): Promise<void> {
  if (!userDataDir) return;
  await fs.promises.rm(userDataDir, { recursive: true, force: true }).catch((e) => {
    log.debug(`Failed to cleanup isolated profile directory ${userDataDir}: ${e instanceof Error ? e.message : String(e)}`);
  });
}

export function localRecordingDir(): string {
  return path.resolve(process.env.CLOAK_RECORDING_DIR || process.env.LOCAL_RECORDING_DIR || "recordings");
}

export function videoSizeFor(resolved: { viewport: { width: number; height: number } | null; windowSize: { width: number; height: number } | null }) {
  const size = resolved.viewport ?? resolved.windowSize ?? { width: 1280, height: 720 };
  return { width: Math.max(1, Math.floor(size.width)), height: Math.max(1, Math.floor(size.height)) };
}

/**
 * Build an authenticated proxy URL from a `ProxyEntry`. When `overrideProtocol`
 * is supplied, the returned URL's scheme is rewritten to that value — used by
 * the Spider Cloud / Spider Local paths when `forceProxyProtocol` is on so
 * the SDK (and Playwright when applicable) connect over a uniform scheme
 * regardless of what the pool file declared.
 */
export function proxyUrlWithCredentials(proxy: ProxyEntry, overrideProtocol?: ProxyProtocol): string {
  const wantsRewrite = overrideProtocol !== undefined && proxy.protocol !== overrideProtocol;
  let serverStr = proxy.server;

  if (wantsRewrite) {
    serverStr = serverStr.replace(/^[a-z0-9+.-]+:\/\//i, `${overrideProtocol}://`);
  }

  if (!proxy.username && !proxy.password) {
    return serverStr;
  }

  try {
    const u = new URL(serverStr);
    if (proxy.username) u.username = proxy.username;
    if (proxy.password) u.password = proxy.password;

    let out = u.toString();
    if (out.endsWith("/") && !serverStr.endsWith("/")) {
      out = out.slice(0, -1);
    }
    return out;
  } catch (e) {
    log.warn(`Failed to inject proxy credentials into URL: ${serverStr} — ${e instanceof Error ? e.message : String(e)}`);
    return serverStr;
  }
}

/**
 * Force the proxy string to use the SOCKS5 protocol for maximum stealth.
 */
export function forceSocks5(proxy: ProxyEntry): ProxyEntry {
  if (proxy.server.startsWith("socks5://")) return proxy;
  return {
    ...proxy,
    server: proxy.server.replace(/^[a-z0-9+.-]+:\/\//i, "socks5://"),
    protocol: "socks5",
  };
}

/**
 * Force the proxy string to use the HTTP protocol for legacy compatibility.
 */
export function forceHttp(proxy: ProxyEntry): ProxyEntry {
  if (proxy.server.startsWith("http://")) return proxy;
  return {
    ...proxy,
    server: proxy.server.replace(/^[a-z0-9+.-]+:\/\//i, "http://"),
    protocol: "http",
  };
}

/**
 * Return a `ProxyEntry` whose `server` scheme matches `overrideProtocol`,
 * leaving the entry untouched when no override is requested or when the
 * entry already uses the override protocol. Used by the spider-local
 * Playwright launch path so `launchPersistentContext({ proxy })` receives
 * the right scheme when `forceProxyProtocol` is on. The corresponding
 * SDK-side rewrite happens in `proxyUrlWithCredentials`.
 */
export function applyProxyProtocolOverride(
  proxy: ProxyEntry,
  overrideProtocol?: ProxyProtocol,
): ProxyEntry {
  if (!overrideProtocol || overrideProtocol === proxy.protocol) return proxy;
  return {
    ...proxy,
    server: proxy.server.replace(/^[a-z0-9+.-]+:\/\//i, `${overrideProtocol}://`),
    protocol: overrideProtocol,
  };
}

/** Resolve the httpcloak TLS profile string from a UA profile.
 *  Centralized here to avoid duplication across cloak.ts and zendriver.ts (Improvement #9).
 *  Rule 40 (strict-tls-ua-consistency): TLS profile MUST match the browser engine's UA family. */
export function resolveTlsProfile(uaProfile: ReturnType<typeof getConsistentUserAgent> | undefined): string {
  if (!uaProfile) return "chrome-latest";
  const ua = uaProfile.ua.toLowerCase();
  if (ua.includes("safari") && !ua.includes("chrome")) return "safari";
  if (ua.includes("firefox")) return "firefox";
  const os = uaProfile.os === 'macos' ? 'macos' : uaProfile.os === 'windows' ? 'windows' : uaProfile.os === 'android' ? 'android' : 'linux';
  return `chrome-latest-${os}`;
}

export async function applyStealthContextOverrides(context: BrowserContext, geoProfile: GeoProfile | undefined, uaProfile: UAProfile | undefined): Promise<void> {
  const headers: Record<string, string> = {};

  // Dynamic Accept-Language based on geo profile locale
  if (geoProfile?.locale) {
    const lang = geoProfile.locale;  // e.g. "en-AU", "en-US", "de-DE"
    const baseLang = lang.split("-")[0];  // e.g. "en", "de"
    headers["Accept-Language"] = baseLang === lang ? `${lang};q=0.9` : `${lang},${baseLang};q=0.9`;
    headers["Sec-CH-Lang"] = `"${lang}"`;
  }

  if (uaProfile) {
    const platform = uaProfile.os === "macos" ? "macOS" : uaProfile.os === "linux" ? "Linux" : uaProfile.os === "android" ? "Android" : "Windows";
    const arch = uaProfile.architecture;
    const chromeVersion = uaProfile.chromeMajor;

    // Experimental Sec-CH-UA construction - aligns perfectly with emulated UA.
    // Prevents mismatch detection where UA=Windows but CH=macOS (default on Mac).
    const brands = [
      { brand: "Not;A=Brand", version: "99" },
      { brand: "Chromium", version: String(chromeVersion) },
      { brand: "Google Chrome", version: String(chromeVersion) }
    ];
    headers["Sec-CH-UA"] = brands.map(b => `"${b.brand}";v="${b.version}"`).join(", ");
    headers["Sec-CH-UA-Mobile"] = uaProfile.os === "android" ? "?1" : "?0";
    headers["Sec-CH-UA-Platform"] = `"${platform}"`;
    headers["Sec-CH-UA-Platform-Version"] = `"${uaProfile.platformVersion}"`;
    headers["Sec-CH-UA-Arch"] = `"${arch}"`;
    headers["Sec-CH-UA-Bitness"] = arch === "x64" ? '"64"' : '"arm"';
    headers["Sec-CH-UA-Model"] = uaProfile.os === "android" ? `"${(uaProfile as any).mobileModel || ""}"` : '""';
  }

  if (Object.keys(headers).length > 0) {
    await context.setExtraHTTPHeaders(headers).catch((e) => {
      log.debug(`Failed to set extra HTTP headers: ${e instanceof Error ? e.message : String(e)}`);
    });
  }

  if (geoProfile && typeof geoProfile.latitude === "number" && typeof geoProfile.longitude === "number") {
    await context.setGeolocation({ latitude: geoProfile.latitude, longitude: geoProfile.longitude }).catch((e) => {
      log.debug(`Failed to set geolocation: ${e instanceof Error ? e.message : String(e)}`);
    });
  }
}

/**
 * Inject all stealth init scripts (Client-Hints alignment, font bounding box
 * spoofing, AudioContext obfuscation) into a browser context.
 * Called after applyStealthContextOverrides on every session creation path.
 */
export async function injectStealthScripts(
  context: Pick<BrowserContext, "addInitScript">,
  uaProfile: UAProfile | undefined,
  fingerprintSeed: number | undefined,
  timezone?: string,
  hardwareProfile?: HardwareProfile,
  backendType?: "stealth" | "cloak" | "zendriver",
  fpStrategy?: "optimal" | "native-only" | "full-stealth",
  captchaServiceUrl?: string,
  injectStealthJS: boolean = true
): Promise<void> {
  if (!injectStealthJS) return;
  const scripts = buildStealthScripts({
    uaProfile,
    fingerprintSeed,
    timezone,
    hardwareProfile,
    backendType,
    fpStrategy,
    captchaServiceUrl,
  });
  for (const script of scripts) {
    await context.addInitScript(script).catch((e) => {
      log.debug(`Failed to inject stealth script: ${e instanceof Error ? e.message : String(e)}`);
    });
  }
}

/**
 * Inject stealth scripts via CDP (for Spider sessions where we don't own the context).
 */
export async function injectStealthScriptsCDP(
  cdp: { send: (method: string, params: Record<string, unknown>) => Promise<unknown> },
  uaProfile: UAProfile | undefined,
  fingerprintSeed: number | undefined,
  timezone?: string,
  hardwareProfile?: HardwareProfile,
  backendType?: "stealth" | "cloak" | "zendriver",
  fpStrategy?: "optimal" | "native-only" | "full-stealth",
  captchaServiceUrl?: string,
  injectStealthJS: boolean = true
): Promise<void> {
  if (!injectStealthJS) return;
  const scripts = buildStealthScripts({
    uaProfile,
    fingerprintSeed,
    timezone,
    hardwareProfile,
    backendType,
    fpStrategy,
    captchaServiceUrl,
  });
  for (const script of scripts) {
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: script }).catch((e: any) => {
      log.debug(`Failed to inject stealth script via CDP: ${e?.message ?? e}`);
    });
  }
}

export function localRecordVideoOptions(enabled: boolean, resolved: { viewport: { width: number; height: number } | null; windowSize: { width: number; height: number } | null }, sessionId: string) {
  if (!enabled) return {};
  const dir = localRecordingDir();
  fs.mkdirSync(dir, { recursive: true });
  // cloakbrowser forwards Playwright context options through `contextOptions`;
  // top-level unknown fields are intentionally ignored by its wrapper.
  const contextOptions: any = { recordVideo: { dir, size: videoSizeFor(resolved) } };
  contextOptions.recordHar = { path: path.join(dir, `${sessionId}.har`), urlFilter: "**/*" };
  return { contextOptions };
}

/** Filesystem-safe, length-capped slug from a credential email. Mirrors the
 *  ScreenshotService rules so recordings and screenshots share an attribution
 *  format. Returns "nocred" when no email is available. */
export function emailSlugForFilename(email: string | undefined): string {
  if (!email) return "nocred";
  const cleaned = email.trim().toLowerCase().replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 64);
  return cleaned || "nocred";
}

export async function finalizeLocalRecording(handle: SessionHandle): Promise<string> {
  const { page, sessionId, email, videoTrimOffsetMs, videoCropBox } = handle;
  const video = page.video();
  if (!video) return "";
  try {
    const src = await video.path();
    if (!src) return "";
    const ext = path.extname(src) || ".webm";
    const slug = emailSlugForFilename(email);
    const now = new Date();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    const hh = String(now.getHours()).padStart(2, '0');
    const min = String(now.getMinutes()).padStart(2, '0');
    const sec = String(now.getSeconds()).padStart(2, '0');
    const tsShort = `${mm}${dd}_${hh}${min}${sec}`;
    const configStr = handle.configAcronym ? `__${handle.configAcronym}` : "";
    // Build a site-token marker (JOE / IGN, or both for combined sessions) so
    // each recording's filename advertises which target(s) it actually covers.
    // Operator directive: each tile/file must carry an IGN or JOE token.
    const siteTokenMap: Record<string, string> = { joe: "JOE", ignition: "IGN" };
    const siteTokens = Array.from(new Set((handle.sitesUsed ?? [])
      .map(s => siteTokenMap[s.toLowerCase()] ?? s.toUpperCase().slice(0, 3))))
      .filter(Boolean);
    const siteStr = siteTokens.length > 0 ? `__${siteTokens.join("_")}` : "";
    const dest = path.join(localRecordingDir(), `${slug}${siteStr}${configStr}__${tsShort}${ext}`);

    // If no post-processing required, just use native saveAs and delete
    if (!videoTrimOffsetMs && !videoCropBox) {
      if (src !== dest) {
        await video.saveAs(dest).catch((e) => {
          log.debug(`Failed to save video file natively: ${e instanceof Error ? e.message : String(e)}`);
        });
        await video.delete().catch(() => {});
      }
      const finalPath = fs.existsSync(dest) ? dest : src;
      return path.relative(process.cwd(), finalPath).split(path.sep).join("/");
    }

    // Post-processing with ffmpeg (Trim + Crop)
    const tempDest = dest.replace(ext, `.processed${ext}`);
    const FFMPEG_TIMEOUT_MS = 60000; // 1 minute max per ffmpeg operation

    try {
      await new Promise<void>((resolve, reject) => {
        let command = ffmpeg(src);
        // eslint-disable-next-line prefer-const
        let timeoutId: NodeJS.Timeout;
        let sigkillTimer: NodeJS.Timeout | undefined;
        let settled = false;
        const settle = (fn: () => void) => { if (!settled) { settled = true; fn(); } };

        // Escalating-kill cleanup: SIGTERM first, then SIGKILL after a 2s
        // grace if the process hasn't exited yet (the 'end'/'error' callbacks
        // below clear the SIGKILL timer when they fire). Without escalation a
        // stuck ffmpeg can survive SIGTERM and remain as a zombie indefinitely.
        const cleanup = () => {
          clearTimeout(timeoutId);
          try { command.kill('SIGTERM'); } catch { /* already dead */ }
          sigkillTimer = setTimeout(() => {
            try { command.kill('SIGKILL'); } catch { /* already dead */ }
          }, 2000);
          sigkillTimer.unref?.();
        };

        timeoutId = setTimeout(() => {
          cleanup();
          settle(() => reject(new Error('ffmpeg operation timed out')));
        }, FFMPEG_TIMEOUT_MS);

        // Trim start if offset exists
        if (videoTrimOffsetMs && videoTrimOffsetMs > 0) {
          command = command.setStartTime(videoTrimOffsetMs / 1000);
        }

        // Crop if box exists — sanity check coordinates to avoid filter re-init errors
        if (videoCropBox && videoCropBox.width > 0 && videoCropBox.height > 0) {
          // -vf "crop=w:h:x:y"
          const w = Math.floor(videoCropBox.width);
          const h = Math.floor(videoCropBox.height);
          const x = Math.max(0, Math.floor(videoCropBox.x));
          const y = Math.max(0, Math.floor(videoCropBox.y));
          command = command.videoFilters(`crop=${w}:${h}:${x}:${y}`);
        }

        command
          .output(tempDest)
          .on("end", () => {
            clearTimeout(timeoutId);
            if (sigkillTimer) clearTimeout(sigkillTimer);
            settle(resolve);
          })
          .on("error", (err) => {
            clearTimeout(timeoutId);
            if (sigkillTimer) clearTimeout(sigkillTimer);
            settle(() => reject(err));
          })
          .run();
      });

      if (fs.existsSync(tempDest)) {
        await fs.promises.rename(tempDest, dest).catch((e) => {
          log.warn(`Failed to rename processed video: ${e instanceof Error ? e.message : String(e)}`);
        });
        await fs.promises.unlink(src).catch((e) => {
          log.warn(`Failed to clean up raw webm: ${e instanceof Error ? e.message : String(e)}`);
        });
      }
    } catch (err) {
      log.warn(`Video post-processing failed for ${sessionId}: ${err instanceof Error ? err.message : String(err)} — falling back to raw recording`);
      if (src !== dest) {
        await fs.promises.rename(src, dest).catch((e) => {
          log.warn(`Failed to rename raw video on fallback: ${e instanceof Error ? e.message : String(e)}`);
        });
      }
    }

    const finalPath = fs.existsSync(dest) ? dest : src;
    const relPath = path.relative(process.cwd(), finalPath).split(path.sep).join("/");

    // #34 Evidence Integrity Checksums
    try {
      const crypto = await import('crypto');
      const fileBuffer = fs.readFileSync(finalPath);
      const hashSum = crypto.createHash('sha256');
      hashSum.update(fileBuffer);
      handle.recordingHash = hashSum.digest('hex');
      import('../src/core/database.js').then(({ saveEvidenceChecksum }) => {
        saveEvidenceChecksum(sessionId, relPath, "recording", handle.recordingHash!);
      }).catch(e => log.warn(`Failed to dynamically import database.js: ${e}`));
    } catch (e) {
      log.warn(`Failed to hash video: ${e instanceof Error ? e.message : String(e)}`);
    }

    // #32 Video Thumbnail Generation
    const thumbnailPath = finalPath.replace(ext, ".thumb.jpg");
    try {
      await new Promise<void>((resolve, reject) => {
        ffmpeg(finalPath)
          .screenshots({
            timestamps: [3],
            filename: path.basename(thumbnailPath),
            folder: path.dirname(thumbnailPath),
            size: '320x?'
          })
          .on('end', () => resolve())
          .on('error', reject);
      });
      handle.recordingThumbnailUrl = path.relative(process.cwd(), thumbnailPath).split(path.sep).join("/");
    } catch (e) {
      log.warn(`Failed to generate thumbnail: ${e instanceof Error ? e.message : String(e)}`);
    }

    // Assign HAR path if exists
    const harPath = path.join(localRecordingDir(), `${sessionId}.har`);
    if (fs.existsSync(harPath)) {
      handle.harUrl = path.relative(process.cwd(), harPath).split(path.sep).join("/");
    }

    return relPath;
  } catch (err: unknown) {
    log.error(`finalizeLocalRecording error for ${sessionId}:`, err);
    return "";
  }
}

export interface CacheInjectionState {
  enabled: boolean;
}

export function resolveCacheInjectionState(
  cacheProfile: CacheProfile | undefined,
  enableCacheInjection: boolean | undefined
): CacheInjectionState {
  const enabled = (enableCacheInjection ?? false) && !!cacheProfile;
  return { enabled };
}

/**
 * Pooled contexts can be reused across credentials when the cache-injection
 * state matches. The injected script is now identity-free (no per-email
 * client_id, no last_visit timestamp) so any two enabled states are
 * interchangeable — only the enabled/disabled bit needs to agree.
 */
export function isCacheInjectionStateCompatible(
  existing: CacheInjectionState | undefined,
  requested: CacheInjectionState
): boolean {
  return !!existing && existing.enabled === requested.enabled;
}

export async function maybeAddCacheInjectionScript(
  context: Pick<BrowserContext, "addInitScript">,
  cacheProfile: CacheProfile | undefined,
  enableCacheInjection: boolean | undefined
): Promise<CacheInjectionState> {
  const state = resolveCacheInjectionState(cacheProfile, enableCacheInjection);
  if (state.enabled && cacheProfile) {
    await context.addInitScript(getCacheInjectionScript(cacheProfile));
  }
  return state;
}

import { globalTiler } from "../src/services/browser-tiler.js";

const configCols = getEnvInt("HEADED_GRID_COLS", 2);
const configRows = getEnvInt("HEADED_GRID_ROWS", 2);
const initialGridSize = configCols * configRows;
globalTiler.reconfigure(initialGridSize);

export const HEADED_GRID_SIZE = initialGridSize;

export const SCREEN = await resolveScreenBounds();

export interface PooledHeadedContext {
  context: BrowserContext;
  slot: number;
  bounds: ScreenBounds;
  // Sticky-session key (server#username) of the proxy this context was
  // launched with. Compared on reuse — if the next caller hands us a
  // different key (typically because the row-level retry loop rotated
  // sticky sessions after a 407/auth failure), the pooled context is
  // evicted and a fresh one is launched. launchPersistentContext's proxy
  // arg is launch-time-only, so without this headed retries would
  // silently reuse the dead proxy session.
  proxyKey?: string;
  proxyForwarder?: ProxyForwarder;
  cacheInjectionState?: CacheInjectionState;
  recordVideoEnabled?: boolean;
}

export const headedPool: Map<number, PooledHeadedContext> = new Map();
export async function gridBounds(slot: number): Promise<ScreenBounds> {
  const bounds = await globalTiler.getBounds(slot);
  if (!bounds) return { x: 0, y: 0, width: 960, height: 540 };
  return bounds;
}

export async function acquireHeadedSlot(): Promise<number> {
  return globalTiler.acquireSlot();
}

export function releaseHeadedSlot(n: number): void {
  globalTiler.releaseSlot(n);
}

export async function shutdownHeadedPool(): Promise<void> {
  const entries = Array.from(headedPool.values());
  headedPool.clear();
  await Promise.all(entries.map(async (p) => {
    await p.context.close().catch((e: any) => {
      log.warn(`Failed to close headed context: ${e instanceof Error ? e.message : String(e)}`);
    });
    await p.proxyForwarder?.close().catch((e: any) => {
      log.warn(`Failed to close headed proxy forwarder: ${e instanceof Error ? e.message : String(e)}`);
    });
  }));
}

export const HEADLESS_POOL_SIZE = getEnvInt("HEADLESS_POOL_SIZE", 5);
export const headlessPool: Map<string, Promise<BrowserContext>> = new Map();
export const headlessCacheInjectionStates: Map<string, CacheInjectionState> = new Map();
export const headlessProxyKeys: Map<string, string | undefined> = new Map();
export const headlessProxyForwarders: Map<string, ProxyForwarder | undefined> = new Map();
export const headlessInUse: Set<string> = new Set();
// Contexts the eviction loop wanted to drop but couldn't because they were
// in-use. releaseHeadlessContext drains this on the way out so we never
// close() an in-use context out from under an active session.
export const headlessPendingEvict: Set<string> = new Set();
// Keys whose last sanitization run reported errors. Acquires for these keys
// are denied until trackHeadlessContext rebinds the slot with a freshly
// launched context (which is by construction clean). Without this gate a
// flaky sanitize would leave a partially-cleared context in the pool and
// the next session would inherit cookies/localStorage from the prior one.
export const headlessQuarantine = new QuarantineSet<string>();
export const headedQuarantine = new QuarantineSet<number>();

export function logReuse(scope: string, decision: "allowed" | "denied", reasons: string[], key: string): void {
  // Reuse decisions are emitted from the pool acquire paths so we can audit
  // why a session got a fresh context vs. a recycled one when investigating
  // fingerprint drift or proxy-rotation failures after the fact.
  const tag = decision === "allowed" ? "reuse-allowed" : "reuse-denied";
  poolLog.info(`${scope} ${tag} key=${key}${reasons.length ? ` reasons=${reasons.join(",")}` : ""}`);
  if (decision === "allowed") profileMetrics.recordReuseAllowed();
  else profileMetrics.recordReuseDenied(reasons);
}

export async function evictHeadlessKey(userDataDir: string): Promise<void> {
  const ctxPromise = headlessPool.get(userDataDir);
  const forwarder = headlessProxyForwarders.get(userDataDir);
  headlessPool.delete(userDataDir);
  headlessCacheInjectionStates.delete(userDataDir);
  headlessProxyKeys.delete(userDataDir);
  headlessProxyForwarders.delete(userDataDir);
  if (ctxPromise) {
    ctxPromise.then(ctx => {
      ctx.close().catch((e: any) => log.warn(`Failed to close evicted headless context: ${e instanceof Error ? e.message : String(e)}`));
    }).catch(() => {});
  }
  await forwarder?.close().catch((e: any) => {
    log.warn(`Failed to close evicted forwarder: ${e instanceof Error ? e.message : String(e)}`);
  });
}

export async function acquireHeadlessContext(userDataDir: string, requestedCacheInjectionState: CacheInjectionState, requestedProxyKey: string | undefined): Promise<BrowserContext | null> {
  if (HEADLESS_POOL_SIZE <= 0) return null;
  if (headlessInUse.has(userDataDir)) return null;
  if (headlessQuarantine.has(userDataDir)) {
    logReuse("headless", "denied", ["quarantined"], userDataDir);
    await evictHeadlessKey(userDataDir);
    return null;
  }
  // Claim the slot SYNCHRONOUSLY before any await so a second concurrent
  // acquire for the same userDataDir hits the `headlessInUse.has(...)`
  // early-return above rather than racing past it and clobbering the
  // headlessPool entry the first caller is about to write. Cleared on every
  // early-return path below; the slot stays held on success until release.
  headlessInUse.add(userDataDir);

  const ctxPromise = headlessPool.get(userDataDir);
  if (!ctxPromise) { headlessInUse.delete(userDataDir); return null; }

  // Serialize on any inflight operations for this pool entry
  const ctx = await ctxPromise;

  const decision = evaluateReuse({
    existingProxyKey: headlessProxyKeys.get(userDataDir),
    requestedProxyKey,
    existingCacheInjectionState: headlessCacheInjectionStates.get(userDataDir),
    requestedCacheInjectionState,
  });
  if (!decision.allowed) {
    logReuse("headless", "denied", decision.reasons, userDataDir);
    headlessInUse.delete(userDataDir);
    await evictHeadlessKey(userDataDir);
    return null;
  }

  // Create a new promise that represents the context AFTER sanitize completes
  const sanitizePromise = (async () => {
    const sanitizeResult = await sanitizeBrowserContext(ctx).catch((e) => ({ errors: [String(e)] }));
    if (headlessQuarantine.recordSanitizeResult(userDataDir, sanitizeResult.errors.length)) {
      throw new Error("sanitize-failed");
    }
    return ctx;
  })();

  headlessPool.set(userDataDir, sanitizePromise);
  
  try {
    await sanitizePromise;
  } catch {
    headlessInUse.delete(userDataDir);
    logReuse("headless", "denied", ["sanitize-failed"], userDataDir);
    await evictHeadlessKey(userDataDir);
    return null;
  }
  
  logReuse("headless", "allowed", [], userDataDir);
  return ctx;
}

export function trackHeadlessContext(userDataDir: string, ctx: BrowserContext, cacheInjectionState: CacheInjectionState, proxyKey: string | undefined, proxyForwarder: ProxyForwarder | undefined): void {
  if (HEADLESS_POOL_SIZE <= 0) return;
  // Fresh context binding clears any prior quarantine on this key.
  headlessQuarantine.clear(userDataDir);
  headlessInUse.add(userDataDir);
  // Map iteration order is insertion order — first key is the oldest. Walk
  // until we find an entry that's safe to evict (not the current key, not
  // in-use). If every candidate is in-use, mark the oldest non-self one for
  // deferred eviction via releaseHeadlessContext.
  while (headlessPool.size >= HEADLESS_POOL_SIZE) {
    let evictKey: string | undefined;
    for (const k of headlessPool.keys()) {
      if (k === userDataDir) continue;
      if (headlessInUse.has(k)) continue;
      evictKey = k;
      break;
    }
    if (!evictKey) {
      // All eligible entries are in-use — defer eviction.
      for (const k of headlessPool.keys()) {
        if (k !== userDataDir && headlessInUse.has(k)) {
          headlessPendingEvict.add(k);
          break;
        }
      }
      break;
    }
    const evicted = headlessPool.get(evictKey);
    const forwarder = headlessProxyForwarders.get(evictKey);
    headlessPool.delete(evictKey);
    headlessCacheInjectionStates.delete(evictKey);
    headlessProxyKeys.delete(evictKey);
    headlessProxyForwarders.delete(evictKey);
    if (evicted) {
      evicted.then(ctx => ctx.close().catch((e: any) => {
        log.warn(`Failed to close evicted context during pool eviction: ${e instanceof Error ? e.message : String(e)}`);
      })).catch(() => {});
    }
    forwarder?.close().catch((e: any) => {
      log.warn(`Failed to close evicted forwarder during pool eviction: ${e instanceof Error ? e.message : String(e)}`);
    });
  }
  headlessPool.set(userDataDir, Promise.resolve(ctx));
  headlessCacheInjectionStates.set(userDataDir, cacheInjectionState);
  headlessProxyKeys.set(userDataDir, proxyKey);
  headlessProxyForwarders.set(userDataDir, proxyForwarder);
}

export async function releaseHeadlessContext(userDataDir: string): Promise<void> {
  headlessInUse.delete(userDataDir);
  // Drain any deferred eviction targeting this key.
  if (headlessPendingEvict.has(userDataDir)) {
    headlessPendingEvict.delete(userDataDir);
    const ctx = headlessPool.get(userDataDir);
    if (ctx) {
      const forwarder = headlessProxyForwarders.get(userDataDir);
      headlessPool.delete(userDataDir);
      headlessCacheInjectionStates.delete(userDataDir);
      headlessProxyKeys.delete(userDataDir);
      headlessProxyForwarders.delete(userDataDir);
      if (ctx) {
        void ctx.then(c => c.close().catch((e: any) => {
          log.warn(`Failed to close context during pending eviction: ${e instanceof Error ? e.message : String(e)}`);
        })).catch(() => {});
      }
      await forwarder?.close().catch((e: any) => {
        log.warn(`Failed to close forwarder during pending eviction: ${e instanceof Error ? e.message : String(e)}`);
      });
    }
    return;
  }
  if (HEADLESS_POOL_SIZE <= 0) {
    const ctx = headlessPool.get(userDataDir);
    if (ctx) {
      const forwarder = headlessProxyForwarders.get(userDataDir);
      headlessPool.delete(userDataDir);
      headlessCacheInjectionStates.delete(userDataDir);
      headlessProxyKeys.delete(userDataDir);
      headlessProxyForwarders.delete(userDataDir);
      if (ctx) {
        void ctx.then(c => c.close().catch((e: any) => {
          log.warn(`Failed to close context during pool size cleanup: ${e instanceof Error ? e.message : String(e)}`);
        })).catch(() => {});
      }
      await forwarder?.close().catch((e: any) => {
        log.warn(`Failed to close forwarder during pool size cleanup: ${e instanceof Error ? e.message : String(e)}`);
      });
    }
  }
}

export async function shutdownHeadlessPool(): Promise<void> {
  const entries = Array.from(headlessPool.values());
  const forwarders = Array.from(headlessProxyForwarders.values());
  headlessPool.clear();
  headlessCacheInjectionStates.clear();
  headlessProxyKeys.clear();
  headlessProxyForwarders.clear();
  headlessInUse.clear();
  await Promise.all([
    ...entries.map(async (c) => {
      try {
        const ctx = await c;
        await ctx.close();
      } catch { /* ignore */ }
    }),
    ...forwarders.map((f) => f?.close().catch(() => { })),
  ]);
}

export async function checkAiFingerprint(_opts: SessionOpts, bundle: { email?: string, uaProfile?: any, hardwareProfile?: any, geoProfile?: any, fontProfile?: any, cacheProfile?: any, proxyServerStr?: string, resolved?: any }) {
  if (bundle.email && bundle.uaProfile && bundle.hardwareProfile && bundle.geoProfile && bundle.cacheProfile) {
    await verifyFingerprintCoherence({
      email: bundle.email,
      ua: bundle.uaProfile,
      hardware: bundle.hardwareProfile,
      geo: bundle.geoProfile,
      fonts: bundle.fontProfile,
      cache: bundle.cacheProfile,
      proxy: bundle.proxyServerStr,
      resolution: bundle.resolved ? { width: bundle.resolved.viewport?.width ?? 1920, height: bundle.resolved.viewport?.height ?? 1080, share: 0, label: "fallback" } : undefined
    });
  }
}

export const SPIDER_AGGRESSIVE_BLOCKED_URLS = [
  "*://*.perimeterx.net/*",
  "*://*.datadome.co/*",
  "*://*.imperva.com/*",
  "*://*.akamaihd.net/sensor*",
  "*://*.newrelic.com/*",
  "*://*.nr-data.net/*",
  "*://*.segment.io/*",
  "*://*.rum.cloudflare.com/*",
];

export function buildSpiderWssUrl(
  settings: SpiderSettings,
  opts: { apiKey: string; sessionId: string; viewport: { width: number; height: number }; geoProfile: GeoProfile; uaProfile?: UAProfile; proxyUrl?: string }
): string {
  const params = new URLSearchParams();
  // The raw Spider Cloud CDP endpoint strictly expects 'token'
  params.set("token", opts.apiKey);
  params.set("country", "AU");
  params.set("browser", settings.browser || "auto");
  params.set("sessionId", opts.sessionId);
  
  // Use "s" for stealth level as per SDK specification
  if (settings.stealth !== undefined && Number(settings.stealth) > 0) {
    params.set("s", String(settings.stealth));
  }
  
  if (opts.proxyUrl) {
    params.set("proxy_url", opts.proxyUrl); // Must be proxy_url, not proxyUrl
  }

  return `wss://browser.spider.cloud/v1/browser?${params.toString()}`;
}

export async function applySpiderCdpHardening(
  page: Page,
  ctx: { uaProfile?: UAProfile; geoProfile: GeoProfile; settings: SpiderSettings; cacheProfile?: CacheProfile; extensionProfile?: ExtensionProfile; fingerprintSeed?: number; hardwareProfile?: HardwareProfile }
): Promise<void> {
  const cdp = await page.context().newCDPSession(page);

  if (ctx.uaProfile) {
    const platform = ctx.uaProfile.os === "macos" ? "macOS" : ctx.uaProfile.os === "linux" ? "Linux" : ctx.uaProfile.os === "android" ? "Android" : "Windows";
    await cdp.send("Network.setUserAgentOverride", {
      userAgent: ctx.uaProfile.ua,
      acceptLanguage: "en-AU,en;q=0.9",
      platform,
      userAgentMetadata: {
        brands: [
          { brand: "Not;A=Brand", version: "99" },
          { brand: "Chromium", version: String(ctx.uaProfile.chromeMajor) },
          { brand: "Google Chrome", version: String(ctx.uaProfile.chromeMajor) }
        ],
        fullVersionList: [
          { brand: "Not;A=Brand", version: "99.0.0.0" },
          { brand: "Chromium", version: ctx.uaProfile.chromeVersion },
          { brand: "Google Chrome", version: ctx.uaProfile.chromeVersion }
        ],
        fullVersion: ctx.uaProfile.chromeVersion,
        platform,
        platformVersion: ctx.uaProfile.platformVersion,
        architecture: ctx.uaProfile.architecture === "arm64" ? "arm" : "x86",
        bitness: "64",
        model: "",
        mobile: ctx.uaProfile.os === "android",
        wow64: false,
      }
    }).catch(e => log.warn(`CDP Network.setUserAgentOverride failed: ${e}`));
  }

  await cdp.send("Emulation.setTimezoneOverride", { timezoneId: ctx.geoProfile.timezone }).catch(e => log.warn(`CDP Emulation.setTimezoneOverride failed: ${e}`));
  await cdp.send("Emulation.setLocaleOverride", { locale: "en-AU" }).catch(e => log.warn(`CDP Emulation.setLocaleOverride failed: ${e}`));

  if (ctx.uaProfile?.os === "android") {
    await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 }).catch(e => log.warn(`CDP Emulation.setTouchEmulationEnabled failed: ${e}`));
    await cdp.send("Emulation.setEmitTouchEventsForMouse", { enabled: true, configuration: "mobile" }).catch(e => log.warn(`CDP Emulation.setEmitTouchEventsForMouse failed: ${e}`));
  }

  if (ctx.geoProfile.latitude !== undefined && ctx.geoProfile.longitude !== undefined) {
    await cdp.send("Emulation.setGeolocationOverride", {
      latitude: ctx.geoProfile.latitude,
      longitude: ctx.geoProfile.longitude,
      accuracy: 50
    }).catch(e => log.warn(`CDP Emulation.setGeolocationOverride failed: ${e}`));
  }

  // P0 Anti-Detection: REMOVED Page.setBypassCSP — this is one of the most
  // reliably detected CDP commands by anti-bot systems (DataDome, Cloudflare).
  // No real user ever has CSP bypassed. Scripts are already injected via
  // Page.addScriptToEvaluateOnNewDocument which runs before CSP is enforced.

  if (ctx.settings.aggressiveBlocklist) {
    await cdp.send("Network.setBlockedURLs", { urls: SPIDER_AGGRESSIVE_BLOCKED_URLS }).catch(e => log.warn(`CDP Network.setBlockedURLs failed: ${e}`));
  }

  if (ctx.cacheProfile) {
    try {
      await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
        source: getCacheInjectionScript(ctx.cacheProfile)
      });
    } catch (e) {
      log.warn(`CDP Page.addScriptToEvaluateOnNewDocument (cacheProfile) failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  if (ctx.extensionProfile) {
    try {
      await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
        source: getExtensionInjectionScript(ctx.extensionProfile)
      });
    } catch (e) {
      log.warn(`CDP Page.addScriptToEvaluateOnNewDocument (extensionProfile) failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Inject stealth scripts (Client-Hints alignment, font spoofing, AudioContext obfuscation)
  await injectStealthScriptsCDP(cdp as any, ctx.uaProfile, ctx.fingerprintSeed, undefined, ctx.hardwareProfile, "zendriver");
}

export function attachSpiderHeartbeat(context: BrowserContext, intervalMs: number, _sessionId: string): () => void {
  if (intervalMs <= 0) return () => { };

  const interval = setInterval(() => {
    const page = context.pages()[0];
    if (!page) return;

    page.context().newCDPSession(page)
      .then(cdp => {
        return cdp.send("Browser.getVersion")
          .finally(() => cdp.detach().catch(() => { }));
      })
      .catch(e => log.warn(`[spider-cloud] heartbeat probe failed: ${e}`));
  }, intervalMs);

  if (interval.unref) interval.unref();

  return () => {
    clearInterval(interval);
  };
}

export { BurnedFingerprintError, misdirectionDenylist } from "../src/core/misdirection-denylist.js";
export { evaluateReuse } from "../src/core/pool-decisions.js";
export type { ProxyProtocol } from "../src/core/spider-settings.js";
export type { ScreenBounds } from "../src/profiles/viewport-resolver.js";
export type { ProxyForwarder } from "../src/proxy/proxy-forwarder.js";
