import { chromium } from "playwright-core";
import { spawn } from "child_process";
import path from "path";
import { createLogger } from "../src/core/logger.js";
import { ConfigStore } from "../src/core/config-store.js";
import { type SessionOpts, type SessionHandle, acquireHeadedSlot, gridBounds, releaseHeadedSlot, applyProxyProtocolOverride, resolveTlsProfile, checkAiFingerprint } from "./index.js";
import { loadSpiderSettings, ProxyProtocol } from "../src/core/spider-settings.js";
import { startProxyForwarder, type ProxyForwarder } from "../src/proxy/proxy-forwarder.js";
import { startHttpCloakForwarder } from "./httpcloak-forwarder.js";
import { fileURLToPath } from "url";
import { getInteractionPattern } from "../src/profiles/profile-interaction.js";
import { getConsistentUserAgent } from "../src/profiles/profile-useragent.js";
import { getConsistentHardware } from "../src/profiles/profile-determinism.js";
import { alignGeoToProxy } from "../src/profiles/profile-geo-alignment.js";
import { proxyEntryKey } from "../src/proxy/proxy-score-tracker.js";
import { misdirectionDenylist, BurnedFingerprintError } from "../src/core/misdirection-denylist.js";
import { buildCredentialNoiseProfile } from "../src/profiles/profile-credential-noise.js";
import { getFontProfile } from "../src/profiles/profile-fonts.js";
import { getConsistentResolution } from "../src/profiles/profile-resolution.js";
import { getExtensionProfile } from "../src/profiles/profile-extensions.js";
import { getCacheProfile } from "../src/profiles/profile-cache.js";
import { FingerprintGenerator } from "fingerprint-generator";
import { FingerprintInjector } from "fingerprint-injector";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const log = createLogger("zendriver");


export async function createZendriverSession(opts: SessionOpts): Promise<SessionHandle> {
  const seed = opts.fingerprintSeed ?? Math.floor(Math.random() * 89999) + 10000;

  // Issue 29: Refuse to launch with a fingerprint seed that a prior misdirection
  // event permanently burned. Seeds are email-derived, so the only safe action is
  // to abort the row — bubbled to the engine for terminal N/A handling.
  if (misdirectionDenylist.isFingerprintBurned(seed)) {
    throw new BurnedFingerprintError(seed);
  }

  const isHeaded = opts.headless === false;
  const sessionId = `zendriver${isHeaded ? '-headed' : ''}-${Date.now()}-${seed}`;

  log.info(`[${sessionId}] Booting Zendriver (${isHeaded ? 'headed' : 'headless'})...`);
  const pythonScript = path.join(__dirname, "python", isHeaded ? "zendriver_headed_launcher.py" : "zendriver_launcher.py");
  const rootDir = path.join(__dirname, "..");
  
  let slot: number | undefined;
  let sBounds: any;
  if (isHeaded) {
    slot = await acquireHeadedSlot();
    sBounds = await gridBounds(slot);
  }

  const uaProfile = opts.email ? getConsistentUserAgent(opts.email, opts.osProfile, opts.proxyPool, "chrome", opts.rotation) : undefined;
  const hardwareProfile = opts.email ? getConsistentHardware(opts.email, uaProfile?.os, opts.rotation, opts.proxyPool) : undefined;
  const geoProfile = opts.email ? alignGeoToProxy(opts.proxy?.server, opts.email) : alignGeoToProxy(opts.proxy?.server, seed);
  // Issue 31: Compute all profile fields that the engine reads downstream
  const noiseProfile = opts.email ? buildCredentialNoiseProfile(opts.email) : undefined;
  const fontProfile = opts.email ? getFontProfile(opts.email) : undefined;
  const extensionProfile = opts.email ? getExtensionProfile(opts.email) : undefined;
  const cacheProfile = opts.email ? getCacheProfile(opts.email, uaProfile?.chromeMajor ?? 148) : undefined;
  // Issue 31: Build resolution profile for downstream fingerprint info logging
  const resolutionProfile = opts.email ? getConsistentResolution(opts.email) : { width: 1920, height: 1080, share: 0, label: "FHD-fallback" };

  await checkAiFingerprint(opts, { email: opts.email, uaProfile, hardwareProfile, geoProfile, fontProfile, cacheProfile, proxyServerStr: opts.proxy?.server, resolved: { viewport: { width: resolutionProfile.width, height: resolutionProfile.height } } });

  const delimiter = process.platform === 'win32' ? ';' : ':';
  const homeDir = process.platform === 'win32' ? process.env.USERPROFILE : process.env.HOME;
  const localBin = homeDir ? path.join(homeDir, '.local', 'bin') : '';
  const pathEnv = process.env.PATH ? `${process.env.PATH}${localBin ? delimiter + localBin : ''}` : localBin;
  const zendriverProcess = spawn("uv", ["run", pythonScript], {
    cwd: rootDir,
    env: { ...process.env, PATH: pathEnv, PYTHONUNBUFFERED: "1" }
  });

  zendriverProcess.on("error", (err) => {
    log.error(`[${sessionId}] Failed to spawn uv (zendriver): ${err.message}`);
  });


  let forwarder: ProxyForwarder | null = null;
  let proxyConfig: any = undefined;
  const settings = opts.spiderSettings ?? loadSpiderSettings();
  const protocolOverride: ProxyProtocol | undefined = settings.forceProxyProtocol ? settings.proxyProtocol : undefined;

  // Issue 32: Hoist effectiveProxy to outer scope so proxyKey/proxyUsed use the
  // protocol-overridden proxy, matching what the forwarder actually connects through.
  const effectiveProxy = opts.proxy ? applyProxyProtocolOverride(opts.proxy, protocolOverride) : undefined;
  const currentProxyKey = effectiveProxy ? proxyEntryKey(effectiveProxy) : undefined;

  if (effectiveProxy) {
    if (opts.useHttpCloak !== false) {
      try {
        // Issue 34: Use clean resolveTlsProfile function instead of inline ternary
        const profileStr = resolveTlsProfile(uaProfile);
        forwarder = await startHttpCloakForwarder(effectiveProxy, profileStr);
        log.info(`[${sessionId}] Using httpcloak proxy (${profileStr} TLS profile)`);
      } catch (e: unknown) {
        log.warn(`[${sessionId}] httpcloak failed, falling back to basic forwarder: ${e instanceof Error ? e.message : String(e)}`);
        forwarder = await startProxyForwarder(effectiveProxy, "zendriver");
      }
    } else {
      forwarder = await startProxyForwarder(effectiveProxy, "zendriver");
    }
    proxyConfig = { server: forwarder.serverUrl };
  }
  const config = ConfigStore.load();
  try {
    zendriverProcess.stdin.write(JSON.stringify({
      proxy: proxyConfig,
      userAgent: uaProfile?.ua,
      os: uaProfile?.os,
      bounds: sBounds,
      macOSTilingEngine: config.macOSTilingEngine
    }) + "\n");
    zendriverProcess.stdin.end();
  } catch (e) {
    zendriverProcess.kill();
    if (forwarder) await forwarder.close();
    throw new Error(`Zendriver stdin write failed: ${String(e)}`);
  }

  let wsEndpoint = "";
  
  await new Promise<void>((resolve, reject) => {
    let outputBuffer = "";
    
    // Safety check: ensure we kill the python script if we timeout
    const timeoutId = setTimeout(() => {
      zendriverProcess.kill();
      reject(new Error("Zendriver launcher timeout"));
    }, 15000);

    zendriverProcess.stdout.on("data", (data) => {
      outputBuffer += data.toString();
      // Process line-by-line to ignore non-JSON warnings
      const lines = outputBuffer.split("\n");
      // Keep the last incomplete line in the buffer
      outputBuffer = lines.pop() || "";
      
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line.trim());
          if (parsed.ws_endpoint) {
            wsEndpoint = parsed.ws_endpoint;
            clearTimeout(timeoutId);
            resolve();
          }
        } catch (e) {
          // Ignore parse errors for logging lines from python
        }
      }
    });
    
    zendriverProcess.stderr.on("data", (data) => {
      log.error(`[${sessionId}] python stderr: ${data.toString().trim()}`);
    });
    
    zendriverProcess.on("close", (code) => {
      if (!wsEndpoint) {
        clearTimeout(timeoutId);
        reject(new Error(`Zendriver process exited with code ${code} before endpoint was found`));
      }
    });
  }).catch((e) => {
    zendriverProcess.kill();
    if (forwarder) forwarder.close().catch(() => {});
    throw e;
  });

  let browser: any;
  let retries = 5;
  while (retries > 0) {
    try {
      browser = await Promise.race([
        chromium.connectOverCDP(wsEndpoint),
        new Promise<any>((_, rej) => setTimeout(() => rej(new Error("connectOverCDP timeout")), 10000))
      ]);
      break;
    } catch (e) {
      retries--;
      if (retries === 0) {
        zendriverProcess.kill();
        if (forwarder) await forwarder.close();
        throw new Error(`Failed to connect to Zendriver CDP at ${wsEndpoint}: ${String(e)}`);
      }
      await new Promise(r => setTimeout(r, 100 * Math.pow(2, 5 - retries)));
    }
  }
  
  const contextPromise = browser.contexts()[0] ? Promise.resolve(browser.contexts()[0]) : browser.newContext({ ignoreHTTPSErrors: true });
  const context = await Promise.race([
    contextPromise,
    new Promise((_, rej) => setTimeout(() => rej(new Error("Zendriver newContext timed out")), 15000))
  ]).catch((e: any) => {
    zendriverProcess.kill();
    throw e;
  });

  const pagePromise = context.pages()[0] ? Promise.resolve(context.pages()[0]) : context.newPage();
  const page = await Promise.race([
    pagePromise,
    new Promise((_, rej) => setTimeout(() => rej(new Error("Zendriver newPage timed out")), 15000))
  ]).catch((e: any) => {
    zendriverProcess.kill();
    throw e;
  });

  if (isHeaded && sBounds) {
    // Issue 35: Pass backendName for diagnostic logging
    await import('../src/services/browser-tiler.js').then(m => m.globalTiler.enforceWindowBounds(page, sBounds, undefined, "zendriver-headed"));
  }

  let traceStarted = false;
  if (opts.enablePlaywrightTracing) {
    try {
      await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
      traceStarted = true;
    } catch (err: unknown) {
      log.warn(`[${sessionId}] Failed to start Playwright Trace: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── Aggressive CDP Trace Removal (BEFORE any page loads) ──
  // Zendriver's CDP architecture exposes automation traces. We must remove
  // them at the earliest possible point via Runtime.evaluate on the default
  // context, then also via addInitScript for future navigations.
  const cdpInitPromise = (async () => {
    try {
      const cdpSession = await context.newCDPSession(page);
      
      // 1. Remove navigator.webdriver at the CDP level (most robust method)
      await cdpSession.send('Page.addScriptToEvaluateOnNewDocument', {
        source: `
          // Remove Playwright/CDP/Selenium traces
          delete window.__playwright;
          delete window.__pw_manual;
          delete window.__PW_outOfContext;
          const cdcProps = Object.getOwnPropertyNames(window).filter(p => p.includes('cdc_') || p.includes('wd_') || p.includes('__selenium') || p.includes('__webdriver') || p.includes('__driver') || p.includes('__fxdriver'));
          for (const p of cdcProps) { try { delete window[p]; } catch { /* intentional */ } }
          
          // Strengthen CDP Runtime Cloaking (Hide chrome.runtime.id)
          if (window.chrome && window.chrome.runtime) {
            delete window.chrome.runtime.id;
          }
          
          // Ensure navigator.webdriver is definitively undefined
          delete Object.getPrototypeOf(navigator).webdriver;

          // Prevent firebug detection
          if (window.Firebug) delete window.Firebug;
          
          // Override permissions query for notifications (automation giveaway)
          const origQuery = window.navigator.permissions?.query;
          if (origQuery) {
            const queryProxy = new Proxy(origQuery, {
              apply: function(target, thisArg, args) {
                if (args[0] && args[0].name === 'notifications') {
                  return Promise.resolve({ state: Notification.permission });
                }
                return Reflect.apply(target, thisArg, args);
              }
            });
            // Cloak the proxy's toString
            const origToString = Function.prototype.toString;
            const toStringProxy = new Proxy(origToString, {
              apply: function(target, thisArg, args) {
                if (thisArg === queryProxy) {
                  return "function query() { [native code] }";
                }
                return Reflect.apply(target, thisArg, args);
              }
            });
            Function.prototype.toString = toStringProxy;
            window.navigator.permissions.query = queryProxy;
          }
        `
      }).catch(() => {});
      
      // 2. Apply geo alignment via CDP (more robust than JS-level overrides)
      if (geoProfile) {
        await cdpSession.send('Emulation.setTimezoneOverride', {
          timezoneId: geoProfile.timezone
        }).catch(() => {});
        await cdpSession.send('Emulation.setLocaleOverride', {
          locale: geoProfile.locale
        }).catch(() => {});
        log.info(`[${sessionId}] Geo aligned: tz=${geoProfile.timezone} locale=${geoProfile.locale}`);
      }
      
      // 3. Add network latency emulation for realism
      const latency = Math.floor(Math.random() * 20) + 10;
      await cdpSession.send('Network.emulateNetworkConditions', {
        offline: false,
        latency: latency,
        downloadThroughput: -1,
        uploadThroughput: -1
      }).catch(() => {});
      
    } catch (e: unknown) {
      log.warn(`[${sessionId}] CDP cleanup/geo setup failed: ${e instanceof Error ? e.message : String(e)}`);
    }

    // ── Fingerprint Injection ──
    if (uaProfile && opts.injectStealthJS !== false) {
      let fingerprintObj: any = uaProfile.apifyFingerprint;
      
      // Fallback if apifyFingerprint is missing from the pool
      if (!fingerprintObj) {
        const fpGen = new FingerprintGenerator();
        const osFamily = uaProfile.os === 'macos' ? 'macos' : uaProfile.os === 'linux' ? 'linux' : 'windows';
        const browserStr = uaProfile.ua.toLowerCase().includes('firefox') ? 'firefox' : 'chrome';
        
        fingerprintObj = fpGen.getFingerprint({
          devices: ['desktop'],
          operatingSystems: [osFamily],
          browsers: [browserStr],
          // Use hardware profile for coherent GPU/screen config
          ...(hardwareProfile ? {
            screen: { minWidth: 1280, maxWidth: 1920 },
          } : {}),
        });
        // Dynamically override the generated UA to precisely match our HTTP header profile
        fingerprintObj.fingerprint.navigator.userAgent = uaProfile.ua;
        
        // Align hardware concurrency and device memory with our profile
        if (hardwareProfile) {
          fingerprintObj.fingerprint.navigator.hardwareConcurrency = hardwareProfile.cores;
          fingerprintObj.fingerprint.navigator.deviceMemory = hardwareProfile.memory;
        }
      }
      
      const injector = new FingerprintInjector();
      await injector.attachFingerprintToPlaywright(context, fingerprintObj);

      // Enforce perfect network correlation for standard Chromium
      const spoofedHeaders: Record<string, string> = {};
      if (fingerprintObj.headers?.['sec-ch-ua']) spoofedHeaders['sec-ch-ua'] = fingerprintObj.headers['sec-ch-ua'];
      if (fingerprintObj.headers?.['sec-ch-ua-mobile']) spoofedHeaders['sec-ch-ua-mobile'] = fingerprintObj.headers['sec-ch-ua-mobile'];
      if (fingerprintObj.headers?.['sec-ch-ua-platform']) spoofedHeaders['sec-ch-ua-platform'] = fingerprintObj.headers['sec-ch-ua-platform'];
      // Add Accept-Language from geo profile for locale coherence (header-only, no JS conflict)
      if (geoProfile?.locale) {
        const lang = geoProfile.locale;
        const baseLang = lang.split("-")[0];
        spoofedHeaders['Accept-Language'] = baseLang === lang ? `${lang};q=0.9` : `${lang},${baseLang};q=0.9`;
      }
      if (Object.keys(spoofedHeaders).length > 0) {
        await context.setExtraHTTPHeaders(spoofedHeaders);
      }

      // NOTE: Do NOT inject buildStealthScripts() here. FingerprintInjector already patches
      // navigator, Battery, Permissions, Hardware, WebGL, Canvas, Audio, etc. Adding our
      // own stealth-scripts.ts overrides on top creates Frankenstein fingerprints (Rule 39)
      // that INCREASE the suspect score (full-stealth=16 vs optimal=3 in audit data).
      // FingerprintInjector's statistically consistent profiles are the sole fingerprint layer.
    }
  })();

  await Promise.race([
    cdpInitPromise,
    new Promise((_, rej) => setTimeout(() => rej(new Error("Zendriver CDP initialization timed out")), 15000))
  ]).catch((e: any) => {
    zendriverProcess.kill();
    throw e;
  });



  const handle: SessionHandle = {
    context,
    page,
    sessionId,
    recordingUrl: "",
    traceStarted,
    traceFinalized: false,
    backend: "zendriver",
    fingerprintSeed: seed,
    // Issue 32: Use effectiveProxy (protocol-overridden) for accurate tracking
    proxyUsed: effectiveProxy?.server,
    proxyKey: currentProxyKey,
    geoProfile,
    hardwareProfile,
    uaProfile,
    // Issue 31: Attach all profile fields the engine reads downstream
    noiseProfile,
    fontProfile,
    resolutionProfile,
    extensionProfile,
    cacheProfile,
    email: opts.email,
    interactionProfile: opts.email ? getInteractionPattern(opts.email, opts.requeueCount) : undefined,
    close: async () => {
      // Issue 33: Release headed slot if applicable (slot is only set for headed mode)
      if (slot !== undefined) {
        releaseHeadedSlot(slot);
      }
      
      if (handle.traceStarted && !handle.traceFinalized) {
        try {
          const fs = await import("fs");
          const path = await import("path");
          const recDir = path.join(process.cwd(), "reports", "traces");
          if (!fs.existsSync(recDir)) fs.mkdirSync(recDir, { recursive: true });
          const tracePath = path.join(recDir, `zendriver-trace-${sessionId}.zip`);
          await context.tracing.stop({ path: tracePath });
          handle.tracePath = tracePath;
          handle.traceFinalized = true;
          log.info(`[${sessionId}] Playwright Trace saved to ${tracePath}`);
        } catch (err: unknown) {
          handle.traceFinalized = false;
          log.debug(`[${sessionId}] Failed to save Playwright Trace: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      await browser.close().catch(() => {});
      zendriverProcess.kill();
      if (forwarder) await forwarder.close();
    },
    // Issue 38: Fast teardown for hard timeouts — don't await anything
    forceKill: () => {
      if (slot !== undefined) {
        releaseHeadedSlot(slot);
      }
      browser.close().catch(() => {});
      zendriverProcess.kill();
      if (forwarder) forwarder.close().catch(() => {});
    },
  };
  return handle;
}