import { SessionOpts, SessionHandle, proxyUrlWithCredentials, checkAiFingerprint, applyStealthContextOverrides, injectStealthScripts, maybeAddCacheInjectionScript } from "./index.js";
import { proxyEntryKey } from "../src/proxy/proxy-score-tracker.js";
import { emailHash } from "../src/core/crypto-utils.js";
import { createLogger } from "../src/core/logger.js";
import { pickAustralianCity } from "../src/profiles/profile-geo-alignment.js";
import { getConsistentUserAgent } from "../src/profiles/profile-useragent.js";
import { getConsistentHardware } from "../src/profiles/profile-determinism.js";
import { misdirectionDenylist, BurnedFingerprintError } from "../src/core/misdirection-denylist.js";
import { buildCredentialNoiseProfile } from "../src/profiles/profile-credential-noise.js";
import { getFontProfile } from "../src/profiles/profile-fonts.js";
import { getConsistentResolution } from "../src/profiles/profile-resolution.js";
import { getExtensionProfile } from "../src/profiles/profile-extensions.js";
import { getCacheProfile } from "../src/profiles/profile-cache.js";
import { getInteractionPattern } from "../src/profiles/profile-interaction.js";
import { loadSpiderSettings, ProxyProtocol, Backend } from "../src/core/spider-settings.js";
import { resolveViewport } from "../src/profiles/viewport-resolver.js";
const SCREEN = { width: 1920, height: 1080, pixelRatio: 1, x: 0, y: 0 };
const log = createLogger('spider-cloud-backend');

async function createSpiderCloudSession(opts: SessionOpts): Promise<SessionHandle> {
  const settings = opts.spiderSettings ?? loadSpiderSettings();
  const apiKey = (opts.spiderApiKey ?? settings.apiKey ?? process.env.SPIDER_API_KEY ?? "").trim();
  if (!apiKey) throw new Error("spider-cloud backend requires SPIDER_API_KEY");

  const seed = opts.fingerprintSeed ?? Math.floor(Math.random() * 89999) + 10000;

  if (misdirectionDenylist.isFingerprintBurned(seed)) {
    throw new BurnedFingerprintError(seed);
  }
  const geoProfile = pickAustralianCity(opts.email ? emailHash(opts.email) : seed);
  geoProfile.locale = "en-AU";
  geoProfile.countryCode = "AU";

  const uaProfile = opts.email ? getConsistentUserAgent(opts.email, opts.osProfile, opts.proxyPool, "chrome", opts.rotation) : undefined;
  const hardwareProfile = opts.email ? getConsistentHardware(opts.email, uaProfile?.os, opts.rotation) : undefined;
  const noiseProfile = opts.email ? buildCredentialNoiseProfile(opts.email) : undefined;
  const fontProfile = opts.email ? getFontProfile(opts.email) : undefined;
  const extensionProfile = opts.email ? getExtensionProfile(opts.email) : undefined;
  const cacheProfile = opts.email ? getCacheProfile(opts.email, uaProfile?.chromeMajor ?? 148) : undefined;
  const interactionProfile = opts.email ? getInteractionPattern(opts.email, opts.requeueCount) : undefined;
  const resolutionProfile = opts.email ? getConsistentResolution(opts.email) : { width: 1920, height: 1080, share: 0, label: "FHD-fallback" };
  const resolved = resolveViewport({
    email: opts.email,
    mode: (opts.headless === false ? "headed" : "headless") as any,
    screen: SCREEN,
    explicitViewport: opts.viewport,
    rotation: opts.rotation
  });

  const proxy = opts.proxy;
  const proxyServerStr = proxy?.server;
  const proxyKey = proxy ? proxyEntryKey(proxy) : undefined;

  await checkAiFingerprint(opts, { email: opts.email, uaProfile, hardwareProfile, geoProfile, fontProfile, cacheProfile, proxyServerStr, resolved });

  // Build an authenticated proxy URL for the Spider SDK (if we have our own proxy)
  const protocolOverride: ProxyProtocol | undefined = settings.forceProxyProtocol ? settings.proxyProtocol : undefined;
  const sdkProxyUrl = proxy ? proxyUrlWithCredentials(proxy, protocolOverride) : undefined;

  const sessionId = `spider-cloud-${Date.now()}-${seed}`;

  const { SpiderBrowser } = await import("spider-browser");

  const isSpiderManagedPool = opts.proxyPool && ["4r", "4m", "4i"].includes(opts.proxyPool);

  const spider = new SpiderBrowser({
    apiKey,
    stealth: isSpiderManagedPool ? 3 : 0,             // maximum stealth level
    proxyUrl: !isSpiderManagedPool ? sdkProxyUrl : undefined,
    maxStealthLevels: settings.maxStealthLevels ?? 3, // allow full escalation
    captcha: settings.captcha ?? "solve",             // auto-solve CAPTCHAs
    smartRetry: settings.smartRetry ?? true,          // auto browser switching on block
    maxRetries: 3,
    hedge: settings.hedge ?? true,                    // race multiple approaches for speed
    country: "AU",                                    // geo-route to Australian proxies
    city: geoProfile.city,                            // city-level geo-routing
    region: geoProfile.region,                        // state/region geo-routing
    locale: "en-AU",                                  // browser locale
    acceptLanguage: "en-AU,en-US;q=0.9,en;q=0.8",    // Accept-Language header
    timezone: geoProfile.timezone || "Australia/Sydney", // timezone override
    record: settings.record ?? true,                  // session recording
    browser: "auto",                                  // let server pick best browser
    mode: "cua",                                      // full rendering mode for form interaction
    connectTimeoutMs: 30000,
    commandTimeoutMs: 30000,
    logLevel: "warn",
  } as any);

  // Wire SDK events to our logging
  spider.on("captcha.detected", (d) => log.info(`[spider-cloud] 🛡️  CAPTCHA detected: ${d.types.join(", ")} on ${d.url}`));
  spider.on("captcha.solving", (d) => log.info(`[spider-cloud] 🔄 Solving CAPTCHA round ${d.round} on ${d.url}`));
  spider.on("captcha.solved", (d) => log.info(`[spider-cloud] ✅ CAPTCHA solved on ${d.url}`));
  spider.on("captcha.failed", (d) => log.warn(`[spider-cloud] ❌ CAPTCHA failed on ${d.url}: ${d.reason}`));
  spider.on("stealth.escalated", (d) => log.info(`[spider-cloud] 🔒 Stealth escalated ${d.from}→${d.to}: ${d.reason}`));
  spider.on("browser.switching", (d) => log.info(`[spider-cloud] 🔄 Browser switching ${d.from}→${d.to}: ${d.reason}`));
  spider.on("browser.switched", (d) => log.info(`[spider-cloud] ✅ Browser switched to ${d.browser}`));
  spider.on("retry.attempt", (d) => log.info(`[spider-cloud] 🔁 Retry ${d.attempt}/${d.maxRetries}: ${d.error}`));
  spider.on("metering", (d) => log.info(`[spider-cloud] 💰 Credits remaining: ${d.credits}, session cost: ${d.session_credits_used ?? "?"}`));

  // Initialize WebSocket connection
  await spider.init();
  log.info(`[spider-cloud] Connected. Browser=${spider.browser}, stealth=${spider.stealthLevel}, credits=${spider.credits ?? "?"}`);
  log.info(`[spider-cloud] AU hard-lock active country=AU city=${geoProfile.city} region=${geoProfile.region} tz=${geoProfile.timezone}`);

  // Set viewport to match our profile ONLY if explicit/headless bounds were provided.
  // If viewport is null (e.g. adaptive headful), we allow the browser to natively adopt its bounds
  if (resolved.viewport) {
    await spider.page.setViewport(resolved.viewport.width, resolved.viewport.height).catch(() => {});
  }

  // Inject standardized core stealth overrides (aligns language, timezone, geo, canvas/webgl masks)
  // We use `spider.page.context()` to get the underlying Playwright BrowserContext if exposed,
  // but since Spider-Browser might abstract it, we attempt to apply it directly if context is available.
  const spiderContext = (spider.page as any).context ? (spider.page as any).context() : null;
  if (spiderContext) {
    await applyStealthContextOverrides(spiderContext, geoProfile, uaProfile);
    if (opts.injectStealthJS !== false) {
      await injectStealthScripts(spiderContext, uaProfile, seed, geoProfile?.timezone, hardwareProfile, "cloak");
    }
    await maybeAddCacheInjectionScript(spiderContext, cacheProfile, opts.enableCacheInjection);
  } else {
    log.warn(`[spider-cloud] spider.page.context() unavailable. Stealth overrides may be incomplete.`);
  }

  return {
    context: null as any,
    page: spider.page as any,
    sessionId,
    recordingUrl: "",
    backend: "spider-cloud" as Backend,
    fingerprintSeed: seed,
    email: opts.email,
    proxyUsed: proxyServerStr ?? "spider-managed",
    proxyKey,
    geoProfile,
    uaProfile,
    hardwareProfile,
    noiseProfile,
    fontProfile,
    extensionProfile,
    cacheProfile,
    interactionProfile,
    resolutionProfile,
    spiderBrowser: spider,
    spiderPage: spider.page,
    close: async () => {
      await spider.close().catch(() => {});
    },
    forceKill: () => {
      spider.close().catch(() => {});
    },
  };
}




export { createSpiderCloudSession };
