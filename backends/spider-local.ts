import { shouldRecordLocalVideo, finalizeLocalRecording, localProfileRoot, SessionOpts, isolatedProfileDir, checkAiFingerprint, cleanupIsolatedProfile, maybeAddCacheInjectionScript, SessionHandle, stableProfileName, applyProxyProtocolOverride, localRecordVideoOptions, injectStealthScripts, shouldUseCleanLocalProfile, applyStealthContextOverrides } from "./index.js";
import { disableBookmarksBar } from "../src/services/browser-tiler.js";
import { proxyEntryKey } from "../src/proxy/proxy-score-tracker.js";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { type BrowserContext  } from "playwright-core";
import { launchPersistentContext } from "cloakbrowser";
import { browserWarmer } from "../src/services/browser-warmer.js";
import { startProxyForwarder as startNodeProxyForwarder } from "../src/proxy/proxy-forwarder.js";
import { startHttpCloakForwarder } from "./httpcloak-forwarder.js";
import { misdirectionDenylist, BurnedFingerprintError } from "../src/core/misdirection-denylist.js";
import { getCacheProfile } from "../src/profiles/profile-cache.js";
import { buildCredentialNoiseProfile } from "../src/profiles/profile-credential-noise.js";
import { getConsistentHardware } from "../src/profiles/profile-determinism.js";
import { getExtensionProfile } from "../src/profiles/profile-extensions.js";
import { getFontProfile } from "../src/profiles/profile-fonts.js";
import { alignGeoToProxy } from "../src/profiles/profile-geo-alignment.js";
import { getInteractionPattern } from "../src/profiles/profile-interaction.js";
import { getConsistentResolution } from "../src/profiles/profile-resolution.js";
import { getConsistentUserAgent, getUserAgentArgs } from "../src/profiles/profile-useragent.js";
import { loadSpiderSettings, ProxyProtocol } from "../src/core/spider-settings.js";
import { seedStaticAssetCache } from "../src/stealth/static-cache.js";
import { resolveViewport } from "../src/profiles/viewport-resolver.js";

const SCREEN = { width: 1920, height: 1080, pixelRatio: 1, x: 0, y: 0 };

async function createSpiderLocalSession(opts: SessionOpts): Promise<SessionHandle> {
  const apiKey = opts.spiderLocalApiKey || (process.env.SPIDER_LOCAL_API_KEY || "").trim();
  if (!apiKey) throw new Error("Spider Local backend requires SPIDER_LOCAL_API_KEY");

  const settings = opts.spiderSettings ?? loadSpiderSettings();
  const protocolOverride: ProxyProtocol | undefined = settings.forceProxyProtocol ? settings.proxyProtocol : undefined;

  // P0 Anti-Detection: Pure random seed per session.
  const seed = opts.fingerprintSeed ?? Math.floor(Math.random() * 89999) + 10000;
  if (misdirectionDenylist.isFingerprintBurned(seed)) throw new BurnedFingerprintError(seed);
  const proxy = opts.proxy ?? undefined;
  // if (!proxy) throw new Error("Spider Local backend requires an AU proxy (Pool 1/2/3); refusing non-AU default egress");
  const proxyServerStr = proxy?.server ?? "DIRECT";
  const proxyKey = proxy ? proxyEntryKey(proxy) : "DIRECT";

  // UA first so hardware pool matches the advertised OS.
  const uaProfile = opts.email ? getConsistentUserAgent(opts.email, opts.osProfile, opts.proxyPool, "chrome", opts.rotation) : undefined;
  const hardwareProfile = opts.email ? getConsistentHardware(opts.email, uaProfile?.os, opts.rotation) : undefined;
  const geoProfile = alignGeoToProxy(proxyServerStr, opts.email ?? seed);
  const noiseProfile = opts.email ? buildCredentialNoiseProfile(opts.email) : undefined;
  const fontProfile = opts.email ? getFontProfile(opts.email) : undefined;
  const interactionProfile = opts.email ? getInteractionPattern(opts.email, opts.requeueCount) : undefined;
  const extensionProfile = opts.email ? getExtensionProfile(opts.email) : undefined;
  const cacheProfile = opts.email ? getCacheProfile(opts.email, uaProfile?.chromeMajor ?? 148) : undefined;
  const resolutionProfile = opts.email ? getConsistentResolution(opts.email) : { width: 1920, height: 1080, share: 0, label: "FHD-fallback" };

  const isHeadless = opts.headless !== false;
  
  // Acquire a grid slot for headed modes so windows tile properly alongside cloak/stealth
  let slot: number | undefined;
  let sBounds: any;
  if (!isHeadless) {
    const { acquireHeadedSlot, gridBounds } = await import("./index.js");
    slot = await acquireHeadedSlot();
    sBounds = await gridBounds(slot);
  }
  
  const mode = isHeadless ? "headless" : (opts.liveTest || process.env.HEADED_GRID_COLS === "1" ? "headed-live" : "headed-grid");
  const resolved = resolveViewport({ email: opts.email, mode, screen: SCREEN, explicitViewport: opts.viewport, rotation: opts.rotation, slotBounds: sBounds });
  const recordLocalVideo = shouldRecordLocalVideo(opts);
  const cleanLocalProfile = shouldUseCleanLocalProfile(opts);
  
  await checkAiFingerprint(opts, { email: opts.email, uaProfile, hardwareProfile, geoProfile, fontProfile, cacheProfile, proxyServerStr, resolved });
  
  const sessionId = `spider-local-${crypto.randomUUID().slice(0, 8)}-${seed}`;
  let userDataDir = cleanLocalProfile
    ? isolatedProfileDir(sessionId, opts.email, false)
    : path.join(localProfileRoot(), stableProfileName(opts.email, seed, false, "-spider-local"));

  // Attempt to use a warmed profile if creating a clean one
  if (cleanLocalProfile) {
    const warmedPath = browserWarmer.consumeWarmedProfile(path.basename(userDataDir));
    if (warmedPath) {
      userDataDir = warmedPath;
    }
  }

  if (!fs.existsSync(userDataDir)) fs.mkdirSync(userDataDir, { recursive: true });
  disableBookmarksBar(userDataDir);
  await seedStaticAssetCache(userDataDir, seed);

  // When forceProxyProtocol is on, the entry's parsed scheme is overridden
  // for the Playwright launch (Playwright accepts socks5:// / http:// /
  // https:// in `server`). The proxy forwarder only ever runs for plain
  // HTTP proxies, so the SOCKS5 override naturally skips it.
  const effectiveProxy = proxy ? applyProxyProtocolOverride(proxy, protocolOverride) : undefined;
  let proxyForwarder: any;
  if (effectiveProxy?.username) {
    if (opts.useHttpCloak ?? true) {
      const profileStr = uaProfile ? (uaProfile.ua.toLowerCase().includes("safari") && !uaProfile.ua.toLowerCase().includes("chrome") ? "safari" : (uaProfile.ua.toLowerCase().includes("firefox") ? "firefox" : `chrome-latest-${uaProfile.os === 'macos' ? 'macos' : uaProfile.os === 'windows' ? 'windows' : uaProfile.os === 'android' ? 'android' : 'linux'}`)) : "chrome-latest";
      proxyForwarder = await startHttpCloakForwarder(effectiveProxy, profileStr);
    } else {
      proxyForwarder = await startNodeProxyForwarder(effectiveProxy);
    }
  }
  const browserProxy = proxyForwarder
    ? { server: proxyForwarder.serverUrl }
    : (effectiveProxy?.server ? effectiveProxy : undefined);
  const recordVideoOptions = localRecordVideoOptions(recordLocalVideo, resolved, sessionId);
  const launchArgs = [
    // WebRTC Leak Protection (basic flags compatible with all Chromium builds)
    "--enforce-webrtc-ip-permission-check",
    "--disable-features=WebRtcHideLocalIpsWithMdns,PasswordCheckup",
    "--password-store=basic",
    // NOTE: --fingerprint=<seed> is a rebrowser-patches flag and is NOT
    // supported by cloakbrowser's own patched Chromium binary. Passing it
    // causes all navigations to fail with chrome-error://chromewebdata/.
    // Similarly, --force-webrtc-ip-handling-policy is not supported.
    `--ignore-certificate-errors`,
    `--test-type`,
    // NOTE: getUserAgentArgs() produces --fingerprint-platform, --fingerprint-browser-version
    // etc. These are rebrowser-patches flags. CloakBrowser handles fingerprinting at its own
    // binary level, so these flags are incompatible and cause navigation failures.
    ...(isHeadless ? ["--disable-features=TranslateUI", "--window-position=-2000,-2000", "--window-size=1280,720"] : ["--disable-features=TranslateUI"]),
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--disable-background-timer-throttling",
    ...(process.env.DEBUG_CDP === "true" ? ["--remote-debugging-port=9222"] : [])
  ];
  if (resolved.forceDpr) launchArgs.push(`--force-device-scale-factor=${resolved.deviceScaleFactor}`);

  let context: BrowserContext;
  try {
    const launchPromise = launchPersistentContext({
      userDataDir,
      headless: false, // Pseudo-headless: force headful to avoid bot detection penalties
      proxy: browserProxy,
      geoip: true,
      humanize: true,
      humanPreset: "default",
      humanConfig: { mistype_chance: 0 },
      viewport: resolved.viewport ?? undefined,
      contextOptions: {
        ignoreHTTPSErrors: true,
        ...(resolved.viewport ? {
          isMobile: uaProfile?.os === "android",
          hasTouch: uaProfile?.os === "android",
          deviceScaleFactor: resolved.deviceScaleFactor,
        } : {}),
        ...(recordVideoOptions.contextOptions || {}),
      },
      timezone: geoProfile.timezone,
      locale: geoProfile.locale,
      args: launchArgs,
      launchOptions: { slowMo: opts.slowMo ?? 100 },
    });
    context = await Promise.race([
      launchPromise,
      new Promise<any>((_, reject) => setTimeout(() => reject(new Error("launchPersistentContext timed out after 20000ms")), 20000))
    ]).catch(err => {
      launchPromise.then(ctx => ctx.close().catch(() => {})).catch(() => {});
      throw err;
    });
  } catch (e) {
    await proxyForwarder?.close().catch(() => { });
    await cleanupIsolatedProfile(cleanLocalProfile ? userDataDir : undefined);
    throw e;
  }
  await applyStealthContextOverrides(context, geoProfile, uaProfile);
  if (opts.injectStealthJS !== false) {
    await injectStealthScripts(context, uaProfile, seed, geoProfile?.timezone, hardwareProfile, "cloak", undefined, opts.captchaServiceUrl);
  }
  
  await maybeAddCacheInjectionScript(context, cacheProfile, opts.enableCacheInjection);
  const page = context.pages()[0] ?? (await context.newPage());

  if (!isHeadless) {
    await import('../src/services/browser-tiler.js').then(m => m.globalTiler.enforceWindowBounds(page, {
      x: resolved.windowPosition?.x ?? 0,
      y: resolved.windowPosition?.y ?? 0,
      width: resolved.windowSize?.width ?? 1280,
      height: resolved.windowSize?.height ?? 720
    }));
  }

  const handle: SessionHandle = {
    context,
    page,
    sessionId,
    recordingUrl: "",
    backend: "spider-local",
    fingerprintSeed: seed,
    proxyUsed: proxyServerStr,
    proxyKey,
    hardwareProfile,
    geoProfile,
    noiseProfile,
    uaProfile,
    fontProfile,
    resolutionProfile: { ...resolutionProfile, label: resolved.resolutionLabel },
    interactionProfile,
    extensionProfile,
    cacheProfile,
    close: async () => {
      await context.close().catch(() => { });
      await proxyForwarder?.close().catch(() => { });
      if (recordLocalVideo) handle.recordingUrl = await finalizeLocalRecording(handle);
      await cleanupIsolatedProfile(cleanLocalProfile ? userDataDir : undefined);
      
      if (slot !== undefined) {
        const { releaseHeadedSlot } = await import("./index.js");
        releaseHeadedSlot(slot);
      }
    },
    forceKill: () => {
      if (slot !== undefined) {
        import("./index.js").then(m => m.releaseHeadedSlot(slot)).catch(() => {});
      }
      context.close().catch(() => { });
      proxyForwarder?.close().catch(() => { });
      if (recordLocalVideo || cleanLocalProfile) {
        cleanupIsolatedProfile(cleanLocalProfile ? userDataDir : undefined).catch(() => {});
      }
    },
  };
  return handle;
}




export { createSpiderLocalSession };