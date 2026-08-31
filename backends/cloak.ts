import { type SessionOpts, type SessionHandle, acquireHeadedSlot, gridBounds, releaseHeadedSlot, applyProxyProtocolOverride, resolveTlsProfile, checkAiFingerprint, resolveCacheInjectionState, shouldRecordLocalVideo, shouldUseCleanLocalProfile, HEADED_GRID_SIZE, localRecordVideoOptions } from "./index.js";

import { finalizeLocalRecording, headedQuarantine, acquireHeadlessContext, trackHeadlessContext, cleanupIsolatedProfile, stableProfileName, releaseHeadlessContext, injectStealthScripts, applyStealthContextOverrides, isolatedProfileDir, logReuse, localProfileRoot, poolLog, headedPool, maybeAddCacheInjectionScript, PooledHeadedContext } from "./index.js";
import { loadSpiderSettings, ProxyProtocol } from "../src/core/spider-settings.js";
import { disableBookmarksBar } from "../src/services/browser-tiler.js";
import { proxyEntryKey } from "../src/proxy/proxy-score-tracker.js";
import { ConfigStore } from "../src/core/config-store.js";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { type BrowserContext  } from "playwright-core";
import { launchPersistentContext } from "cloakbrowser";


import { sanitizeBrowserContext } from "../src/stealth/context-sanitizer.js";
import { createLogger } from "../src/core/logger.js";
import { misdirectionDenylist, BurnedFingerprintError } from "../src/core/misdirection-denylist.js";
import { evaluateReuse } from "../src/core/pool-decisions.js";
import { getCacheProfile } from "../src/profiles/profile-cache.js";
import { buildCredentialNoiseProfile } from "../src/profiles/profile-credential-noise.js";
import { getConsistentHardware } from "../src/profiles/profile-determinism.js";
import { getExtensionProfile } from "../src/profiles/profile-extensions.js";
import { getFontProfile } from "../src/profiles/profile-fonts.js";
import { alignGeoToProxy } from "../src/profiles/profile-geo-alignment.js";
import { getInteractionPattern } from "../src/profiles/profile-interaction.js";
import { profileMetrics } from "../src/profiles/profile-metrics.js";
import { getConsistentResolution } from "../src/profiles/profile-resolution.js";
import { getConsistentUserAgent, getUserAgentArgs } from "../src/profiles/profile-useragent.js";
import { startProxyForwarder as startNodeProxyForwarder, type ProxyForwarder } from "../src/proxy/proxy-forwarder.js";
import { startHttpCloakForwarder } from "./httpcloak-forwarder.js";
import { seedStaticAssetCache } from "../src/stealth/static-cache.js";
import { ScreenBounds, resolveViewport } from "../src/profiles/viewport-resolver.js";
// We import all helpers explicitly from index.js
// Additional types
const SCREEN = { width: 1920, height: 1080, pixelRatio: 1, x: 0, y: 0 };
const log = createLogger('cloak-backend');

async function applyCdpOverrides(context: BrowserContext, page: import("playwright-core").Page) {
  try {
    const cdpSession = await context.newCDPSession(page);
    await cdpSession.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `
        delete window.__playwright;
        delete window.__pw_manual;
        delete window.__PW_outOfContext;
        const cdcProps = Object.getOwnPropertyNames(window).filter(p => p.includes('cdc_') || p.includes('wd_') || p.includes('__selenium') || p.includes('__webdriver') || p.includes('__driver') || p.includes('__fxdriver'));
        for (const p of cdcProps) { try { delete window[p]; } catch { /* intentional */ } }
        if (window.chrome && window.chrome.runtime) {
          delete window.chrome.runtime.id;
        }
        delete Object.getPrototypeOf(navigator).webdriver;
      `
    });
  } catch (err) {
    log.debug(`Failed to apply CDP overrides: ${err instanceof Error ? err.message : String(err)}`);
  }
}



async function createCloakSession(opts: SessionOpts): Promise<SessionHandle> {
  const slowMo = opts.slowMo ?? 100;
  // P0 Anti-Detection: Always use random seeds per session to prevent
  // cross-session fingerprint correlation. Email-derived seeds made the same
  // email produce the same Canvas/WebGL/Audio fingerprint across proxy rotations.
  const seed = opts.fingerprintSeed ?? Math.floor(Math.random() * 89999) + 10000;
  // Refuse to launch with a fingerprint seed that a prior misdirection event
  // permanently disabled. Seeds are email-derived, so the only safe action
  // is to abort the row — bubbled to the engine for terminal N/A handling.
  if (misdirectionDenylist.isFingerprintBurned(seed)) {
    throw new BurnedFingerprintError(seed);
  }
  const sessionId = `cloak-${crypto.randomUUID().slice(0, 8)}-${seed}`;
  const proxy = opts.proxy;
  const proxyServerStr: string | undefined = proxy?.server;

  const settings = opts.spiderSettings ?? loadSpiderSettings();
  const protocolOverride: ProxyProtocol | undefined = settings.forceProxyProtocol ? settings.proxyProtocol : undefined;
  const effectiveProxy = proxy ? applyProxyProtocolOverride(proxy, protocolOverride) : undefined;

  // Compute the UA first so the hardware pool can be aligned to the
  // advertised OS — keeps GPU vendor/renderer plausible (no NVIDIA RTX on
  // macOS, no Apple Silicon on Windows).
  const uaProfile = opts.email ? getConsistentUserAgent(opts.email, opts.osProfile, opts.proxyPool, "chrome", opts.rotation) : undefined;
  const hardwareProfile = opts.email ? getConsistentHardware(opts.email, uaProfile?.os, opts.rotation) : undefined;
  const geoProfile = opts.email ? alignGeoToProxy(proxyServerStr, opts.email) : alignGeoToProxy(proxyServerStr, seed);
  const noiseProfile = opts.email ? buildCredentialNoiseProfile(opts.email) : undefined;
  const fontProfile = opts.email ? getFontProfile(opts.email) : undefined;

  const envHeadless = (process.env.HEADLESS ?? "true").toLowerCase() !== "false";
  const headlessEffective = opts.headless ?? envHeadless;

  const interactionProfile = opts.email ? getInteractionPattern(opts.email, opts.requeueCount) : undefined;
  const extensionProfile = opts.email ? getExtensionProfile(opts.email) : undefined;
  const cacheProfile = opts.email ? getCacheProfile(opts.email, uaProfile?.chromeMajor ?? 148) : undefined;
  const requestedCacheInjectionState = resolveCacheInjectionState(cacheProfile, opts.enableCacheInjection);
  const recordLocalVideo = shouldRecordLocalVideo(opts);
  const cleanLocalProfile = shouldUseCleanLocalProfile(opts) || opts.enablePlaywrightTracing;

  const launchArgs = [
    // WebRTC Leak Protection
    "--enforce-webrtc-ip-permission-check",
    "--disable-features=WebRtcHideLocalIpsWithMdns,PasswordCheckup",
    "--password-store=basic",
    "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
    `--fingerprint=${seed}`,
    // Shield extension REMOVED: its hardcoded en-US/America/New_York/GTX 1080
    // values catastrophically conflict with our per-credential stealth-scripts.ts
    // identity (en-AU/Australia/variable hardware). This mismatch is the primary
    // detection vector flagged by Fingerprint.com's suspect score.
    `--ignore-certificate-errors`,
    ...(effectiveProxy ? [`--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1`] : []),
    `--enable-quic`,
    `--enable-http2`,
    ...(process.env.DEBUG_CDP === "true" ? ["--remote-debugging-port=9222"] : []),
    ...(uaProfile ? getUserAgentArgs(uaProfile) : []),
  ];

  // Resolve viewport before branches
  const configConcurrency = ConfigStore.load().concurrency;
  const mode = (headlessEffective ? (opts.liveTest ? "headless-live" : "headless") : (configConcurrency > 1 ? "headed-grid" : "headed-live"));
  let slot: number | undefined;
  let sBounds: ScreenBounds | undefined;
  let slotReleased = false;
  const releaseSlot = () => {
    if (slot !== undefined && !slotReleased) {
      slotReleased = true;
      releaseHeadedSlot(slot);
    }
  };

  if (!headlessEffective) {
    slot = await acquireHeadedSlot();
    sBounds = await gridBounds(slot);
  }

  const resolved = resolveViewport({
    email: opts.email,
    mode,
    screen: SCREEN,
    slotBounds: sBounds,
    explicitViewport: headlessEffective ? { width: 800, height: 600 } : opts.viewport,
    rotation: opts.rotation,
  });
  const recordVideoOptions = localRecordVideoOptions(recordLocalVideo, resolved, sessionId);

  try {
    await checkAiFingerprint(opts, { email: opts.email, uaProfile, hardwareProfile, geoProfile, fontProfile, cacheProfile, proxyServerStr, resolved });
  } catch (err) {
    releaseSlot();
    throw err;
  }

  if (!headlessEffective && slot !== undefined && sBounds !== undefined) {
    const currentProxyKey = effectiveProxy ? proxyEntryKey(effectiveProxy) : undefined;
    if (cleanLocalProfile) {
      const stalePooled = headedPool.get(slot);
      if (stalePooled) {
        logReuse("headed", "denied", ["cleanSession"], `slot${slot}`);
        headedPool.delete(slot);
        await stalePooled.context.close().catch((e: any) => {
          log.warn(`Failed to close stale pooled context: ${e instanceof Error ? e.message : String(e)}`);
        });
        await stalePooled.proxyForwarder?.close().catch((e: any) => {
          log.warn(`Failed to close stale pooled forwarder: ${e instanceof Error ? e.message : String(e)}`);
        });
      }
    }
    let pooled: PooledHeadedContext | undefined = cleanLocalProfile ? undefined : headedPool.get(slot);
    // Proxy-mismatch eviction: the launchPersistentContext proxy arg is
    // launch-time-only, so when the row-level retry loop hands us a new
    // sticky-session key (e.g. after a 407) we MUST tear down the pooled
    // context or the retry will silently reuse the dead proxy. Closing here
    // also avoids racing the close listener that the prior session attached.
    if (pooled) {
      const decision = evaluateReuse({
        existingProxyKey: pooled.proxyKey,
        requestedProxyKey: currentProxyKey,
        existingCacheInjectionState: pooled.cacheInjectionState,
        requestedCacheInjectionState,
        quarantined: headedQuarantine.has(slot),
        recordVideoMismatch: !!pooled.recordVideoEnabled !== recordLocalVideo,
      });
      if (!decision.allowed) {
        logReuse("headed", "denied", decision.reasons, `slot${slot}`);
        headedPool.delete(slot);
        await pooled.context.close().catch(() => { });
        await pooled.proxyForwarder?.close().catch(() => { });
        pooled = undefined;
      } else {
        logReuse("headed", "allowed", [], `slot${slot}`);
      }
    }
    let headedUserDataDir: string | undefined;
    let proxyForwarder: ProxyForwarder | undefined;  // Hoisted: must be visible in both pooled and fresh paths for close()
    let traceStarted = false;
    if (!pooled) {
      const disableImages = (process.env.HEADED_DISABLE_IMAGES ?? "false").toLowerCase() === "true";

      // Apply the slot-resolved window position + size when the viewport
      // resolver gave us explicit bounds (headed-grid → quadrant; headed-live
      // → full screen). Falls back to --start-maximized only when no bounds
      // were resolved, since --start-maximized conflicts with explicit
      // --window-position / --window-size and would override them.
      const useExplicitWindowBounds = !!(resolved.windowPosition && resolved.windowSize);
      const headedArgs = [
        ...launchArgs,
        ...(useExplicitWindowBounds
          ? [
              `--window-position=${resolved.windowPosition!.x},${resolved.windowPosition!.y}`,
              `--window-size=${resolved.windowSize!.width},${resolved.windowSize!.height}`,
            ]
          : []),
        "--disable-features=TranslateUI",
        "--disable-backgrounding-occluded-windows",
        "--disable-renderer-backgrounding",
        "--disable-background-timer-throttling",
        ...(disableImages ? ["--blink-settings=imagesEnabled=false"] : []),
      ];
      log.info(
        `headed-launch slot=${slot} mode=${mode} bounds=${useExplicitWindowBounds
          ? `pos(${resolved.windowPosition!.x},${resolved.windowPosition!.y}) size(${resolved.windowSize!.width}x${resolved.windowSize!.height})`
          : "maximized"}`
      );

      // Retry suffix: when the row-level loop is rotating proxies after an
      // earlier 407, the previous chromium hasn't necessarily released the
      // userDataDir's SingletonLock yet — launching against the same dir
      // races and chromium exits immediately ("Target page, context or
      // browser has been closed"). Each retry therefore gets its own dir.
      const headedRetrySuffix = (opts.excludeProxies && opts.excludeProxies.length > 0)
        ? `-retry${opts.excludeProxies.length}`
        : "";
      headedUserDataDir = cleanLocalProfile
        ? isolatedProfileDir(sessionId, opts.email, true)
        : path.join(localProfileRoot(), stableProfileName(opts.email, seed, true, headedRetrySuffix));
      if (!fs.existsSync(headedUserDataDir)) fs.mkdirSync(headedUserDataDir, { recursive: true });
      disableBookmarksBar(headedUserDataDir);
      if (cleanLocalProfile) profileMetrics.recordCleanCreated();
      await seedStaticAssetCache(headedUserDataDir, seed);

      const useGeoIp = !!proxy;
      // Advanced workaround for headed Chromium proxy-auth failures:
      // Playwright/Chromium headed has known bugs where authenticated upstream
      // proxies intermittently surface as net::ERR_INVALID_AUTH_CREDENTIALS
      // even when credentials are valid. We launch a local unauthenticated
      // forward proxy and inject Proxy-Authorization there, so Chromium only
      // sees http://127.0.0.1:<port> with no auth challenge.
      // proxyForwarder is hoisted above; assign it here for the fresh-launch path
      if (effectiveProxy) {
        if (opts.useHttpCloak) {
          const profileStr = resolveTlsProfile(uaProfile);
          proxyForwarder = await startHttpCloakForwarder(effectiveProxy, profileStr);
        } else if (effectiveProxy.username) {
          // Issue 23: Fall back to basic TCP forwarder for authenticated proxies
          // when httpCloak is disabled. Chromium headed has a known bug where
          // proxy-auth intermittently surfaces as ERR_INVALID_AUTH_CREDENTIALS.
          proxyForwarder = await startNodeProxyForwarder(effectiveProxy);
        }
      }
      const browserProxy = proxyForwarder ? { server: proxyForwarder.serverUrl } : effectiveProxy;
      let newCtx: BrowserContext;
      try {
        const launchPromise = launchPersistentContext({
          userDataDir: headedUserDataDir,
          headless: false,
          proxy: browserProxy,
          geoip: useGeoIp,
          humanize: true,
          humanPreset: (opts.liveTest && opts.slowMo !== 0) ? "careful" : "default",
          humanConfig: { mistype_chance: 0.01 }, // Aggressive Humanization: Introduce mistypes
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
          ...(geoProfile ? { timezone: geoProfile.timezone, locale: geoProfile.locale } : {}),
          args: headedArgs,
          launchOptions: { slowMo: 50 }, // Aggressive Humanization: Set slowMo to 50ms
        });

        newCtx = await Promise.race([
          launchPromise,
          new Promise<any>((_, reject) => setTimeout(() => reject(new Error("launchPersistentContext timed out after 20000ms")), 20000))
        ]).catch(err => {
          launchPromise.then(ctx => ctx.close().catch(() => {})).catch(() => {});
          throw err;
        });
      } catch (e: unknown) {
        releaseSlot();
        await proxyForwarder?.close().catch(() => { });
        if (cleanLocalProfile) await cleanupIsolatedProfile(headedUserDataDir);
        const err = e instanceof Error ? e : new Error(String(e));
        (err as Error & { proxyKey?: string }).proxyKey = currentProxyKey;
        (err as Error & { proxyServer?: string }).proxyServer = effectiveProxy?.server;
        throw err;
      }

      await applyStealthContextOverrides(newCtx, geoProfile, uaProfile);
      if (opts.injectStealthJS !== false) {
        await injectStealthScripts(newCtx, uaProfile, seed, geoProfile?.timezone, hardwareProfile, "cloak", undefined, opts.captchaServiceUrl);
      }
      await maybeAddCacheInjectionScript(newCtx, cacheProfile, opts.enableCacheInjection);

      if (opts.enablePlaywrightTracing) {
        try {
          await newCtx.tracing.start({ screenshots: true, snapshots: true, sources: true });
          traceStarted = true;
          log.info(`[${sessionId}] Enabled Playwright Tracing for Cloak (Headed)`);
        } catch (err: unknown) {
          log.warn(`[${sessionId}] Failed to start trace: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      const page = newCtx.pages()[0] ?? (await newCtx.newPage());
      await applyCdpOverrides(newCtx, page);
      const nativeDpr = await page.evaluate(() => window.devicePixelRatio).catch(() => null);
      if (nativeDpr != null && Math.abs(nativeDpr - resolved.deviceScaleFactor) > 0.01) {
        log.warn(`DPR mismatch: native=${nativeDpr} credential=${resolved.deviceScaleFactor} — skipping --force-device-scale-factor`);
      }

      newCtx.on("close", () => {
        headedPool.delete(slot);
        void proxyForwarder?.close().catch(() => { });
        if (!slotReleased) {
          slotReleased = true;
          releaseHeadedSlot(slot);
        }
      });
      pooled = { context: newCtx, slot, bounds: sBounds, proxyKey: currentProxyKey, proxyForwarder, cacheInjectionState: requestedCacheInjectionState, recordVideoEnabled: recordLocalVideo };
      // Fresh launch clears any prior quarantine on this slot.
      headedQuarantine.clear(slot);
      if (!cleanLocalProfile) headedPool.set(slot, pooled);
    } else {
      // Sanitization failures quarantine the slot so the NEXT acquire forces
      // a fresh launch. The current session continues with the pooled
      // context — we can't re-launch mid-call without restructuring the
      // surrounding control flow, and the existing best-effort policy
      // already swallows sanitize errors here.
      await applyStealthContextOverrides(pooled.context, geoProfile, uaProfile);
      if (opts.injectStealthJS !== false) {
        await injectStealthScripts(pooled.context, uaProfile, seed, geoProfile?.timezone, hardwareProfile, "cloak", undefined, opts.captchaServiceUrl);
      }
      const sanitizeResult = await sanitizeBrowserContext(pooled.context).catch((e) => ({ errors: [String(e)] }));
      if (headedQuarantine.recordSanitizeResult(slot, sanitizeResult.errors.length)) {
        poolLog.warn(`headed sanitize-failed slot=${slot} — quarantined for next acquire`);
      }
    }

    const pageRef = pooled.context.pages()[0] ?? (await pooled.context.newPage());
    const ctxRef = pooled.context;

    if (sBounds) {
      await import('../src/services/browser-tiler.js').then(m => m.globalTiler.enforceWindowBounds(pageRef, sBounds, undefined, "cloak-headed"));
    }

    // Build minimal Resolution-shaped object for resolutionProfile
    const poolRes = opts.email ? getConsistentResolution(opts.email) : { width: 1920, height: 1080, share: 0, label: "FHD-fallback" };

    const handle: SessionHandle = {
      context: ctxRef,
      page: pageRef,
      sessionId,
      recordingUrl: "",
      traceStarted,
      traceFinalized: false,
      backend: "cloak",
      fingerprintSeed: seed,
      proxyUsed: proxyServerStr,
      proxyKey: currentProxyKey,
      hardwareProfile,
      geoProfile,
      noiseProfile,
      uaProfile,
      fontProfile,
      resolutionProfile: { ...poolRes, label: resolved.resolutionLabel },
      interactionProfile,
      extensionProfile,
      cacheProfile,
      email: opts.email,
      recordingStartTime: Date.now(),
      close: async () => {
        if (handle.traceStarted && !handle.traceFinalized) {
          try {
            const traceDir = path.join(process.cwd(), "reports", "traces");
            if (!fs.existsSync(traceDir)) fs.mkdirSync(traceDir, { recursive: true });
            const tracePath = path.join(traceDir, `cloak-trace-${sessionId}.zip`);
            await ctxRef.tracing.stop({ path: tracePath });
            handle.tracePath = tracePath;
            handle.traceFinalized = true;
            log.info(`[${sessionId}] Playwright Trace saved to ${tracePath}`);
          } catch (err: unknown) {
            handle.traceFinalized = false;
            log.warn(`[${sessionId}] Failed to save trace: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        // Memory hardening: explicitly close all pages before teardown to force GC
        await Promise.all(ctxRef.pages().map(p => p.close().catch(() => {})));
        log.info(`[${sessionId}] Attempting to close session.`);
        try {
          if (recordLocalVideo) {
            log.info(`[${sessionId}] Closing context for recording...`);
            await ctxRef.close().catch((e) => log.warn(`[${sessionId}] Error closing context with recording: ${e.message || e}`));
            handle.recordingUrl = await finalizeLocalRecording(handle);
          } else if (cleanLocalProfile) {
            log.info(`[${sessionId}] Closing context for clean profile...`);
            await ctxRef.close().catch((e) => log.warn(`[${sessionId}] Error closing context for clean profile: ${e.message || e}`));
          } else {
            log.info(`[${sessionId}] Sanitizing and releasing context...`);
            await sanitizeBrowserContext(ctxRef).catch((e) => log.warn(`[${sessionId}] Error sanitizing context: ${e.message || e}`));
          }
        } finally {
          log.info(`[${sessionId}] Closing proxy forwarder...`);
          await proxyForwarder?.close().catch((e: any) => log.warn(`[${sessionId}] Error closing proxy forwarder: ${e.message || e}`));
          if (cleanLocalProfile) {
            log.info(`[${sessionId}] Cleaning up isolated profile...`);
            await cleanupIsolatedProfile(headedUserDataDir).catch((e: any) => log.warn(`[${sessionId}] Error cleaning up isolated profile: ${e.message || e}`));
          }
          releaseSlot();
          log.info(`[${sessionId}] Session closed.`);
        }
      },
      forceKill: () => {
        releaseSlot();
        ctxRef.close().catch(() => {});
        proxyForwarder?.close().catch(() => {});
        if (cleanLocalProfile) {
          cleanupIsolatedProfile(headedUserDataDir).catch(() => {});
        }
      },
    };
    return handle;
  }

  const headlessLaunchArgs = [
    ...launchArgs,
    "--window-position=-2000,-2000",
    // Issue 21: Use realistic window size for pseudo-headless. A 1x1 window
    // causes window.outerWidth/outerHeight to report 1x1 — an extreme
    // anti-bot signal. 1280x720 is a common resolution that passes checks.
    "--window-size=1280,720",
  ];
  if (resolved.forceDpr) {
    headlessLaunchArgs.push(`--force-device-scale-factor=${resolved.deviceScaleFactor}`);
  }

  const headlessRetrySuffix = (opts.excludeProxies && opts.excludeProxies.length > 0)
    ? `-retry${opts.excludeProxies.length}`
    : "";
  const userDataDir = cleanLocalProfile
    ? isolatedProfileDir(sessionId, opts.email, false)
    : path.join(localProfileRoot(), stableProfileName(opts.email, seed, false, headlessRetrySuffix));
  if (!fs.existsSync(userDataDir)) fs.mkdirSync(userDataDir, { recursive: true });
  if (cleanLocalProfile) profileMetrics.recordCleanCreated();
  await seedStaticAssetCache(userDataDir, seed);

  const useGeoIp = !!effectiveProxy;
  const currentProxyKey = effectiveProxy ? proxyEntryKey(effectiveProxy) : undefined;
  let proxyForwarder: ProxyForwarder | undefined;
  let traceStarted = false;
  if (effectiveProxy) {
    if (opts.useHttpCloak) {
      const profileStr = resolveTlsProfile(uaProfile);
      proxyForwarder = await startHttpCloakForwarder(effectiveProxy, profileStr);
    } else if (effectiveProxy.username) {
      // Issue 23: Fall back to basic TCP forwarder for authenticated proxies
      proxyForwarder = await startNodeProxyForwarder(effectiveProxy);
    }
  }
  const browserProxy = proxyForwarder ? { server: proxyForwarder.serverUrl } : effectiveProxy;
  let context = (recordLocalVideo || cleanLocalProfile) ? null : await acquireHeadlessContext(userDataDir, requestedCacheInjectionState, currentProxyKey);
  if (!context) {
    try {
      const launchPromise = launchPersistentContext({
        userDataDir,
        headless: false, // Pseudo-headless: launch headed to avoid headless penalties
        proxy: browserProxy,
        geoip: useGeoIp,
        humanize: true,
        humanPreset: "default",
        // Mistype simulation disabled — see the headed branch for rationale.
        humanConfig: { mistype_chance: 0.005 },  // Small mistype chance for realistic behavioral simulation
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
        ...(geoProfile ? { timezone: geoProfile.timezone, locale: geoProfile.locale } : {}),
        args: headlessLaunchArgs,
        launchOptions: { slowMo },
      });
      context = await Promise.race([
        launchPromise,
        new Promise<any>((_, reject) => setTimeout(() => reject(new Error("launchPersistentContext timed out after 20000ms")), 20000))
      ]).catch(err => {
        launchPromise.then(ctx => ctx.close().catch(() => {})).catch(() => {});
        throw err;
      });
    } catch (e: unknown) {
      await proxyForwarder?.close().catch(() => { });
      if (cleanLocalProfile) await cleanupIsolatedProfile(userDataDir);
      const err = e instanceof Error ? e : new Error(String(e));
      (err as Error & { proxyKey?: string }).proxyKey = currentProxyKey;
      (err as Error & { proxyServer?: string }).proxyServer = effectiveProxy?.server;
      throw err;
    }
    await applyStealthContextOverrides(context!, geoProfile, uaProfile);
    if (opts.injectStealthJS !== false) {
      await injectStealthScripts(context!, uaProfile, seed, geoProfile?.timezone, hardwareProfile, "cloak", undefined, opts.captchaServiceUrl);
    }
    await maybeAddCacheInjectionScript(context!, cacheProfile, opts.enableCacheInjection);

    if (opts.enablePlaywrightTracing) {
      try {
        await context!.tracing.start({ screenshots: true, snapshots: true, sources: true });
        traceStarted = true;
        log.info(`[${sessionId}] Enabled Playwright Tracing for Cloak (Headless)`);
      } catch (err: unknown) {
        log.warn(`[${sessionId}] Failed to start trace: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (!recordLocalVideo && !cleanLocalProfile) {
      trackHeadlessContext(userDataDir, context!, requestedCacheInjectionState, currentProxyKey, proxyForwarder);
    }
  } else {
    await applyStealthContextOverrides(context, geoProfile, uaProfile);
    if (opts.injectStealthJS !== false) {
      await injectStealthScripts(context, uaProfile, seed, geoProfile?.timezone, hardwareProfile, "cloak", undefined, opts.captchaServiceUrl);
    }
    await proxyForwarder?.close().catch(() => { });
  }

  const page = context!.pages()[0] ?? (await context!.newPage());
  await applyCdpOverrides(context!, page);
  const poolRes = opts.email ? getConsistentResolution(opts.email) : { width: 1920, height: 1080, share: 0, label: "FHD-fallback" };

  const handle: SessionHandle = {
    context: context!,
    page,
    sessionId,
    recordingUrl: "",
    traceStarted,
    traceFinalized: false,
    backend: "cloak",
    fingerprintSeed: seed,
    proxyUsed: proxyServerStr,
    proxyKey: currentProxyKey,
    hardwareProfile,
    geoProfile,
    noiseProfile,
    uaProfile,
    fontProfile,
    resolutionProfile: { ...poolRes, label: resolved.resolutionLabel },
    interactionProfile,
    extensionProfile,
    cacheProfile,
    email: opts.email,
    close: async () => {
      // Memory hardening: explicitly close all pages before teardown to force GC
      await Promise.all(context!.pages().map(p => p.close().catch(() => {})));
      
      if (handle.traceStarted && !handle.traceFinalized) {
        try {
          const traceDir = path.join(process.cwd(), "reports", "traces");
          if (!fs.existsSync(traceDir)) fs.mkdirSync(traceDir, { recursive: true });
          const tracePath = path.join(traceDir, `cloak-trace-${sessionId}.zip`);
          await context!.tracing.stop({ path: tracePath });
          handle.tracePath = tracePath;
          handle.traceFinalized = true;
          log.info(`[${sessionId}] Playwright Trace saved to ${tracePath}`);
        } catch (err: unknown) {
          handle.traceFinalized = false;
          log.warn(`[${sessionId}] Failed to save trace: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      
      if (recordLocalVideo || cleanLocalProfile) {
        await context!.close().catch(() => { });
        await proxyForwarder?.close().catch(() => { });
        if (recordLocalVideo) handle.recordingUrl = await finalizeLocalRecording(handle);
        await cleanupIsolatedProfile(cleanLocalProfile ? userDataDir : undefined);
      } else {
        await releaseHeadlessContext(userDataDir);
      }
    },
    forceKill: () => {
      // Fast teardown: do not wait for pages or video processing
      context!.close().catch(() => {});
      proxyForwarder?.close().catch(() => {});
      if (recordLocalVideo || cleanLocalProfile) {
        cleanupIsolatedProfile(cleanLocalProfile ? userDataDir : undefined).catch(() => {});
      } else {
        releaseHeadlessContext(userDataDir).catch(() => {});
      }
    }
  };
  return handle;
}

export { createCloakSession };
