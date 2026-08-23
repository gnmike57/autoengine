import { type BrowserContext, type Page  } from "playwright-core";
import { Camoufox as StealthBrowser } from "camoufox-js";
import { createLogger } from "../src/core/logger.js";
import { ConfigStore } from "../src/core/config-store.js";
import path from "path";
import fs from "fs";
import { type SessionOpts, type SessionHandle, acquireHeadedSlot, gridBounds, releaseHeadedSlot, applyProxyProtocolOverride, checkAiFingerprint } from "./index.js";
import { loadSpiderSettings, ProxyProtocol } from "../src/core/spider-settings.js";
import { startProxyForwarder, type ProxyForwarder } from "../src/proxy/proxy-forwarder.js";
import { startHttpCloakForwarder } from "./httpcloak-forwarder.js";
import { getInteractionPattern } from "../src/profiles/profile-interaction.js";
import { globalTiler } from "../src/services/browser-tiler.js";
import { getConsistentUserAgent } from "../src/profiles/profile-useragent.js";
import { getConsistentHardware } from "../src/profiles/profile-determinism.js";
import { misdirectionDenylist, BurnedFingerprintError } from "../src/core/misdirection-denylist.js";
import { buildCredentialNoiseProfile } from "../src/profiles/profile-credential-noise.js";
import { getFontProfile } from "../src/profiles/profile-fonts.js";
import { getConsistentResolution } from "../src/profiles/profile-resolution.js";
import { getExtensionProfile } from "../src/profiles/profile-extensions.js";
import { getCacheProfile } from "../src/profiles/profile-cache.js";
import { proxyEntryKey } from "../src/proxy/proxy-score-tracker.js";
import { alignGeoToProxy, type GeoProfile } from "../src/profiles/profile-geo-alignment.js";
import { exec } from "child_process";

const log = createLogger("stealth-backend");

export async function shutdownStealthPool(): Promise<void> {
  // No-op: Warm pool has been removed to allow strict per-identity fingerprinting.
}

export async function createStealthSession(opts: SessionOpts): Promise<SessionHandle> {
  const seed = opts.fingerprintSeed ?? Math.floor(Math.random() * 89999) + 10000;

  if (misdirectionDenylist.isFingerprintBurned(seed)) {
    throw new BurnedFingerprintError(seed);
  }

  const sessionId = `stealth-${Date.now()}-${seed}`;
  const extDirs: string[] = [];

  log.info(`[${sessionId}] Creating stealth session...`);
  const startMs = Date.now();

  const isLinux = process.platform === "linux";
  const configConcurrency = ConfigStore.load().concurrency;
  const headlessEffective = opts.liveTest ? false : (opts.headless ?? (isLinux ? "virtual" : true));
  const mode = (headlessEffective ? (opts.liveTest ? "headless-live" : "headless") : (configConcurrency > 1 ? "headed-grid" : "headed-live"));
  const headless: boolean | "virtual" = headlessEffective;

  // ── Profile enrichment ──
  const uaProfile = opts.email ? getConsistentUserAgent(opts.email, opts.osProfile, opts.proxyPool, "firefox", opts.rotation) : undefined;
  const hardwareProfile = opts.email ? getConsistentHardware(opts.email, uaProfile?.os, opts.rotation, opts.proxyPool) : undefined;
  const noiseProfile = opts.email ? buildCredentialNoiseProfile(opts.email) : undefined;
  const fontProfile = opts.email ? getFontProfile(opts.email) : undefined;
  const extensionProfile = opts.email ? getExtensionProfile(opts.email) : undefined;
  const cacheProfile = opts.email ? getCacheProfile(opts.email, uaProfile?.chromeMajor ?? 148) : undefined;
  const interactionProfile = opts.email ? getInteractionPattern(opts.email, opts.requeueCount) : undefined;

  // ── Geo alignment (locale + timezone for Camoufox) ──
  // Since geoip: false (SOCKS5 timeout issues, Rule 35), we manually resolve
  // the locale from the proxy metadata so navigator.language matches the proxy geo.
  let geoProfile: GeoProfile | undefined;
  if (opts.proxy?.server) {
    try {
      geoProfile = alignGeoToProxy(opts.proxy.server, opts.proxyCountry);
    } catch { /* non-fatal — defaults to no locale override */ }
  }

  // ── AI Fingerprint Verifier Gate ──
  // Blocks session launch if the generated profiles form an impossible combination.
  // Note: 'resolved' is missing here since Camoufox handles its own viewport resolution natively,
  // but we can pass a dummy or undefined and let checkAiFingerprint use a fallback.
  await checkAiFingerprint(opts, {
    email: opts.email,
    uaProfile,
    hardwareProfile,
    geoProfile,
    fontProfile,
    cacheProfile,
    proxyServerStr: opts.proxy?.server
  });

  // ── Network Routing & TLS Identity ──
  let forwarder: ProxyForwarder | null = null;
  const settings = opts.spiderSettings ?? loadSpiderSettings();
  const protocolOverride: ProxyProtocol | undefined = settings.forceProxyProtocol ? settings.proxyProtocol : undefined;
  
  let effectiveProxyForBrowser: any = undefined;
  if (opts.proxy) {
    const effectiveProxy = applyProxyProtocolOverride(opts.proxy, protocolOverride);
    // BACKEND_OPTIMAL_SETTINGS for stealth sets useHttpCloak=false, stealthBypassHttpCloak=true.
    // This means Camoufox ALWAYS uses the basic TCP forwarder (Rule 33: SOCKS5 auth hangs with httpCloak).
    const shouldUseHttpCloak = opts.useHttpCloak === true && opts.stealthBypassHttpCloak !== true;
    if (shouldUseHttpCloak) {
      try {
        forwarder = await startHttpCloakForwarder(effectiveProxy, "firefox-latest");
        log.info(`[${sessionId}] Using httpcloak proxy (firefox-latest TLS profile)`);
        effectiveProxyForBrowser = { server: forwarder.serverUrl };
      } catch (e: unknown) {
        log.warn(`[${sessionId}] httpcloak failed, falling back to TCP forwarder: ${e instanceof Error ? e.message : String(e)}`);
        forwarder = await startProxyForwarder(effectiveProxy, "firefox");
        effectiveProxyForBrowser = { server: forwarder.serverUrl };
      }
    } else {
      // Standard path: basic TCP tunnel handles SOCKS5 auth without TLS fingerprint masking.
      // Camoufox's Firefox network stack already has a native Firefox TLS profile.
      forwarder = await startProxyForwarder(effectiveProxy, "firefox");
      log.info(`[${sessionId}] Using TCP proxy-forwarder (Camoufox native TLS)`);
      effectiveProxyForBrowser = { server: forwarder.serverUrl };
    }
  }

  // Cold-start a new browser EVERY session to guarantee strict identity isolation.
  //
  // ── Humanize duration: random 0.4–0.9s per session ──
  // Creates natural behavioral diversity: each browser instance gets a unique
  // cursor speed. Range 0.4–0.9s is faster and more realistic than the old
  // profile-based values (0.8/1.5/2.5s) which felt sluggish.
  const humanizeMaxSeconds = 0.4 + Math.random() * 0.5; // 0.4–0.9s range

  const browserConfig: any = {
    headless,
    geoip: false,         // Disabled: SOCKS5 proxy IP validation times out (Rule 35)
    humanize: humanizeMaxSeconds,  // Per-session cursor speed from interaction profile
    block_webrtc: (opts as any).allowTrackers ? false : true,   // CRITICAL: Prevent real IP leak via STUN/TURN (Issue 1)
    block_images: (opts as any).allowTrackers ? false : true,   // Native engine-level image blocking — faster & undetectable vs route interception (Issue 3)
    os: uaProfile?.os === 'macos' ? 'macos' : uaProfile?.os === 'linux' ? 'linux' : 'windows',
    i_know_what_im_doing: true,
    // ── Issue 8b: Unlock window.moveTo/resizeTo for tiling ──
    // Firefox blocks these by default via dom.disable_window_move_resize.
    // Disabling this pref allows the JS fallback path in browser-tiler.ts
    // to work as a safety net when resizer.exe and node-window-manager
    // both fail to find the window.
    firefoxUserPrefs: {
      'dom.disable_window_move_resize': false,
      'privacy.resistFingerprinting.letterboxing': false,
      'browser.sessionstore.resume_from_crash': false,
      'browser.sessionstore.max_resumed_crashes': 0,
      'toolkit.startup.max_resumed_crashes': -1,
      'browser.sessionstore.enabled': false,
      'browser.sessionstore.restore_on_demand': false,
      'browser.sessionstore.max_tabs_undo': 0,
      'browser.sessionstore.privacy_level': 2,
      'browser.startup.page': 0,
    },
  };

  // ── Locale alignment (Issue 4) ──
  // When geoip is disabled, Camoufox has no way to auto-detect locale.
  // We explicitly pass it from the geo profile so navigator.language and
  // Accept-Language headers match the proxy's geographic location.
  if (geoProfile?.locale) {
    browserConfig.locale = geoProfile.locale;
  }
  
  if (effectiveProxyForBrowser) {
    browserConfig.proxy = effectiveProxyForBrowser;
  }
  
  if (uaProfile && uaProfile.apifyFingerprint && uaProfile.apifyFingerprint.fingerprint) {
    const clonedFp = JSON.parse(JSON.stringify(uaProfile.apifyFingerprint.fingerprint));
    if (clonedFp.audio) {
      delete clonedFp.audio;
    }
    browserConfig.fingerprint = clonedFp;
  }

  // Ensure hardware determinism syncs natively with Camoufox.
  // ONLY do this if fingerprint object is already populated, because creating a partial 
  // object crashes Camoufox (it expects screen, navigator, etc.).
  if (hardwareProfile && browserConfig.fingerprint) {
    browserConfig.fingerprint.hardwareConcurrency = hardwareProfile.cores;
    browserConfig.fingerprint.deviceMemory = hardwareProfile.memory;
  }
  
  let slot: number | undefined;
  if (!headlessEffective) {
    slot = await acquireHeadedSlot();
    const bounds = await gridBounds(slot);
    browserConfig.window = [bounds.width, bounds.height];
    browserConfig.args = ["-width", String(bounds.width), "-height", String(bounds.height)];
    // Also store bounds for the page resize pass
    (browserConfig)._initialBounds = bounds;

    // Issue 8: Force Camoufox to natively tile without fighting macOS
    // Camoufox enforces its window size to match the spoofed screen fingerprint.
    // By overriding the screen fingerprint to exactly match our grid tile size,
    // Camoufox will natively construct a perfectly sized window.
    if (mode === "headed-grid" && bounds) {
      if (!browserConfig.fingerprint) {
        browserConfig.fingerprint = {};
      }
      browserConfig.fingerprint.screen = {
        width: 1920,
        height: 1080,
        availWidth: 1920,
        availHeight: 1040,
        availTop: 0,
        availLeft: 0,
        colorDepth: 24,
        pixelDepth: 24
      };
    }

    if (mode === 'headed-grid' && bounds) {
       try {
           // We explicitly bypass OS accessibility restrictions by injecting a custom WebExtension
           // that calls browser.windows.update() internally to resize the physical window natively!
           // This also acts as a dynamic messaging bridge so we can remote-control it in real-time.
           const extDir = path.join(process.cwd(), 'data', 'temp_profiles', `resizer_ext_${Date.now()}`);
           extDirs.push(extDir);
           if (!fs.existsSync(extDir)) fs.mkdirSync(extDir, { recursive: true });
           
           fs.writeFileSync(path.join(extDir, 'manifest.json'), JSON.stringify({
               "manifest_version": 2,
               "name": "Automati Dynamic Resizer",
               "version": "1.0",
               "browser_specific_settings": {
                   "gecko": {
                       "id": "resizer@automati.local"
                   }
               },
               "background": {
                   "scripts": ["background.js"]
               },
               "content_scripts": [{
                   "matches": ["<all_urls>"],
                   "js": ["content.js"],
                   "run_at": "document_start"
               }],
               "permissions": ["windows", "<all_urls>"]
           }), 'utf8');
           
           fs.writeFileSync(path.join(extDir, 'background.js'), `
               // Initial snap to grid
               browser.windows.getCurrent().then(win => {
                   browser.windows.update(win.id, { 
                       left: ${Math.floor(bounds.x)}, 
                       top: ${Math.floor(bounds.y)}, 
                       width: ${Math.floor(bounds.width)}, 
                       height: ${Math.floor(bounds.height)} 
                   });
               });
               
               // Dynamic remote-control listener
               browser.runtime.onMessage.addListener((msg, sender) => {
                   if (msg && msg.type === "NATIVE_RESIZE") {
                       browser.windows.update(sender.tab.windowId, {
                           left: msg.bounds.x,
                           top: msg.bounds.y,
                           width: msg.bounds.width,
                           height: msg.bounds.height
                       });
                   }
               });
           `, 'utf8');

           fs.writeFileSync(path.join(extDir, 'content.js'), `
               window.addEventListener("message", (event) => {
                   if (event.data && event.data.type === "NATIVE_RESIZE") {
                       browser.runtime.sendMessage(event.data);
                   }
               });
           `, 'utf8');
           
           if (!browserConfig.addons) browserConfig.addons = [];
           browserConfig.addons.push(extDir);
           log.info(`[${sessionId}] WebExtension Tiling active. Injected dynamic resizer addon at ${extDir}`);
       } catch (e: any) {
           log.warn(`[${sessionId}] Failed to inject WebExtension for tiling: ${e.message}`);
       }
    }
  } else {
    // True native headless mode: no OS window created, zero dialog interference
    browserConfig.headless = true;
    browserConfig.window = [1280, 720];
    browserConfig.args = ["-width", "1280", "-height", "720"];
  }

  let browser: any;
  try {
    console.log("[STEALTH] Launching Camoufox with:", JSON.stringify(browserConfig, null, 2));
    const launchPromise = StealthBrowser(browserConfig);
    browser = await Promise.race([
      launchPromise,
      new Promise<any>((_, reject) => setTimeout(() => reject(new Error("StealthBrowser launch timed out after 45000ms")), 45000))
    ]).catch(err => {
      // If timeout wins, the launch promise may still resolve later. Destroy it instantly to prevent zombie Firefox instances.
      launchPromise.then(b => b.close().catch(() => {})).catch(() => {});
      throw err;
    });
  } catch (err: unknown) {
    log.error(`[${sessionId}] StealthBrowser launch failed: ${err instanceof Error ? err.message : String(err)}`);
    if (forwarder) await forwarder.close().catch(() => {});
    throw err;
  }

  const browserPid = typeof (browser).process === "function" ? (browser).process()?.pid : undefined;
  if (browserPid) log.info(`[${sessionId}] Camoufox OS Process ID: ${browserPid}`);

  const contextOpts: any = {
    ignoreHTTPSErrors: true,
    viewport: null
  };
  // DO NOT set viewport, locale, timezoneId — Camoufox manages these natively


  let context: BrowserContext;
  let page: Page;
  let isDefaultContext = false;
  try {
    // Camoufox often spawns a default context and page. 
    // Creating a new context in headful mode can hang Firefox.
    const contexts = browser.contexts();
    if (contexts.length > 0) {
      context = contexts[0];
      isDefaultContext = true;
    } else {
      const contextPromise = browser.newContext(contextOpts);
      context = await Promise.race([
        contextPromise,
        new Promise<any>((_, rej) => setTimeout(() => rej(new Error("browser.newContext timed out")), 30000))
      ]).catch(err => {
        contextPromise.then((ctx: BrowserContext) => ctx.close().catch(() => {})).catch(() => {});
        throw err;
      });
    }

    context.on('weberror', () => { /* suppress */ });
    
    const pages = context.pages();
    if (pages.length === 0) {
      // Governance note: This change is the human-approved override of automati-self-heal's Golden Template Lock for a scoped stealth-lifecycle fix.
      // Sequential Page Acquisition to prevent Camoufox Juggler protocol deadlocks.
      log.debug(`[${sessionId}] No pages yet — attempting sequential page acquisition`);

      let acquiredPage: Page | null = null;
      
      const acquirePromise = (async (): Promise<Page> => {
        // Fast path: brief poll before arming listener in case it's already attaching
        for (let i = 0; i < 3; i++) {
          await new Promise(r => setTimeout(r, 100));
          const currentPages = context.pages();
          if (currentPages.length > 0) {
            log.debug(`[${sessionId}] Default page attached during fast poll`);
            return currentPages[0] as Page;
          }
        }

        if (isDefaultContext) {
          // 1. Listen for default page natively attaching
          log.debug(`[${sessionId}] Waiting for native default page...`);
          try {
            // Mode-aware wait: pseudo-headless/headed can take longer
            const waitTime = (browserConfig.headless === false) ? 8000 : 5000;
            const newPage = await context.waitForEvent('page', { timeout: waitTime });
            log.debug(`[${sessionId}] Default page attached natively via event`);
            return newPage;
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            log.debug(`[${sessionId}] Native default-page attach timed out: ${msg}`);
          }
        }

        // 2. Fallback: strictly sequential newPage()
        log.debug(`[${sessionId}] Safely invoking fallback newPage() sequentially`);
        try {
          return await Promise.race([
            context.newPage(),
            new Promise<never>((_, rej) => setTimeout(() => rej(new Error("newPage fallback timed out")), 10000))
          ]);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          throw new Error(`newPage fallback failed: ${msg}`, { cause: err });
        }
      })();

      // Master 20s timeout boundary
      const timeoutPromise = new Promise<never>((_, rej) =>
        setTimeout(() => rej(new Error("Page acquisition master boundary timed out after 20s")), 20000)
      );

      acquiredPage = await Promise.race([acquirePromise, timeoutPromise]);

      if (!acquiredPage) {
        throw new Error("Page acquisition failed to return a valid page");
      }
      
      page = acquiredPage;
    } else {
      page = pages[0] as Page;
    }
    
    // Verify the page is actually functional
    await Promise.race([
      page.evaluate(() => document.readyState),
      new Promise((_, rej) => setTimeout(() => rej(new Error("page.evaluate functional test timed out")), 5000))
    ]).catch(() => {
      throw new Error('Page created but not functional — browser may be corrupted');
    });

    // Reposition the window (for headed slots or pseudo-headless hidden off-screen)
    if ((browserConfig)._initialBounds) {
      const bounds = (browserConfig)._initialBounds;
      await globalTiler.enforceWindowBounds(page, bounds, browserPid, "stealth");
    }
  } catch (e: unknown) {
    log.error(`[${sessionId}] Context/page creation failed: ${e instanceof Error ? e.message : String(e)}`);
    if (forwarder) await forwarder.close();
    if (browser) await browser.close().catch(() => {});
    throw e;
  }

  // --- Tracing for Camoufox ---
  // Replaces the missing native .webm functionality, or enables manual tracing
  let traceStarted = false;
  if (opts.recordVideo || opts.enablePlaywrightTracing) {
    try {
      await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
      traceStarted = true;
      log.info(`[${sessionId}] Enabled Playwright Tracing for Camoufox`);
    } catch (err: unknown) {
      log.warn(`[${sessionId}] Failed to enable Playwright Tracing: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // --- CDP Network Latency Emulation ---
  // This is safe — it adds realistic network delay, doesn't touch fingerprinting
  try {
    const cdp = await context.newCDPSession(page);
    const latency = Math.floor(Math.random() * 20) + 10; // 10-30ms
    await cdp.send("Network.emulateNetworkConditions", {
      offline: false,
      latency: latency,
      downloadThroughput: -1,
      uploadThroughput: -1
    }).catch(() => {});
  } catch (e) {
    log.debug(`[${sessionId}] Failed to set CDP network latency: ${String(e)}`);
  }

  // --- Font Enumeration Masking ---
  // Supplements Camoufox's built-in font spoofing
  // REMOVED: Camoufox's Juggler context often crashes when injecting addInitScripts.
  // Camoufox already natively spoofs fonts.
  const elapsed = Date.now() - startMs;
  const localeTag = geoProfile?.locale ? ` locale=${geoProfile.locale}` : "";
  log.info(`[${sessionId}] Session ready in ${(elapsed / 1000).toFixed(1)}s (fingerprint: Camoufox-native, humanize=${humanizeMaxSeconds}s, webrtc=blocked, images=blocked${localeTag})`);

  const handle: SessionHandle = {
    context,
    page,
    sessionId,
    recordingUrl: "",
    traceStarted,
    traceFinalized: false,
    backend: "stealth",
    fingerprintSeed: seed,
    proxyUsed: opts.proxy?.server,
    proxyKey: opts.proxy ? proxyEntryKey(opts.proxy) : undefined,
    geoProfile,
    hardwareProfile,
    uaProfile,
    noiseProfile,
    fontProfile,
    resolutionProfile: opts.email ? getConsistentResolution(opts.email) : { width: 1920, height: 1080, share: 0, label: "FHD-fallback" },
    extensionProfile,
    cacheProfile,
    interactionProfile,
    close: async () => {
      if (slot !== undefined) {
        releaseHeadedSlot(slot);
      }
      
      if (handle.traceStarted && !handle.traceFinalized) {
        try {
          const recDir = path.join(process.cwd(), "reports", "traces");
          if (!fs.existsSync(recDir)) fs.mkdirSync(recDir, { recursive: true });
          const tracePath = path.join(recDir, `stealth-trace-${sessionId}.zip`);
          await context.tracing.stop({ path: tracePath });
          handle.tracePath = tracePath;
          handle.traceFinalized = true;
          log.info(`[${sessionId}] Playwright Trace saved to ${tracePath}`);
        } catch (err: unknown) {
          handle.traceFinalized = false;
          log.debug(`[${sessionId}] Failed to save Playwright Trace: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      log.info(`[${sessionId}] Aggressively terminating stealth browser (PID: ${browserPid || 'Unknown'})...`);
      
      // Layer 3: Attempt graceful close bounded by strict 3000ms timeout
      const closePromise = browser.close().catch((e: any) => log.warn(`Graceful close rejected: ${e instanceof Error ? e.message : String(e)}`));
      const timeoutPromise = new Promise((_, rej) => setTimeout(() => rej(new Error("Browser close timed out")), 3000));
      
      try {
        await Promise.race([closePromise, timeoutPromise]);
      } catch (e: unknown) {
        log.error(`[${sessionId}] Graceful teardown failed or timed out: ${e instanceof Error ? e.message : String(e)}`);
      }

      // Final OS-Level Kill Guarantee
      if (browserPid) {
        try {
          if (process.platform === "win32") {
            exec(`taskkill /PID ${browserPid} /F /T`, () => {});
          } else {
            process.kill(browserPid, "SIGKILL");
          }
        } catch (killErr: unknown) {
          log.debug(`[${sessionId}] SIGKILL fallback executed: ${killErr instanceof Error ? killErr.message : String(killErr)}`);
        }
      }

      for (const d of extDirs) {
        try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
      }
      if (forwarder) await forwarder.close();
      log.info(`[${sessionId}] Session entirely eradicated from memory.`);
    },
    forceKill: () => {
      if (slot !== undefined) {
        releaseHeadedSlot(slot);
      }
      if (browserPid) {
        log.warn(`[${sessionId}] INSTANT FORCE KILL triggered on PID ${browserPid}`);
        try {
          if (process.platform === "win32") {
            void import("child_process").then(cp => cp.exec(`taskkill /PID ${browserPid} /F /T`, () => {}));
          } else {
            process.kill(browserPid, "SIGKILL");
          }
        } catch { /* intentional */ }
      }
      for (const d of extDirs) {
        try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
      }
      if (forwarder) forwarder.close().catch(() => {});
    }
  };
  return handle;
}