/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unused-vars, no-useless-assignment*/
/**
 * Stealth Init Scripts — Injected via addInitScript / Page.addScriptToEvaluateOnNewDocument
 *
 * These scripts run at document_start (before any site JS) and patch browser
 * APIs that advanced fingerprinting services (FingerprintJS, DataDome,
 * Cloudflare Turnstile, reCAPTCHA v3) use to profile the environment.
 *
 * Mobile device spoofs have been extracted to stealth-scripts/mobile-spoofs.ts.
 * New code should import from:
 *   import { getMobilePlatformOverrideScript } from "./mobile-spoofs.js";
 *   import { emailToSeed } from "./mobile-spoofs.js";
 *
 * This file retains the canonical definitions for backward compatibility.
 *
 * Three core layers:
 *   1. Client-Hints / navigator alignment (sec-ch-ua ↔ navigator.userAgentData)
 *   2. Font bounding-box metric spoofing (OS text-rendering alignment)
 *   3. AudioContext frequency-response obfuscation (sound-card fingerprint)
 *
 * Each script is self-contained, IIFE-wrapped, and safe to inject on any
 * origin. They use Object.defineProperty with configurable:true so they
 * layer cleanly on top of CloakBrowser's native C++ patches without conflict.
 */

import type { UAProfile } from "../profiles/profile-useragent.js";

// Mobile spoofs — canonical definitions in stealth-scripts/mobile-spoofs.ts
import {
  getMobilePlatformOverrideScript,
  getMobileTouchPointsScript,
  getDesktopTouchPointsScript,
  getMobileOntouchstartScript,
  getMobileOrientationScript,
  getMobileConnectionScript,
  getMobileWebGLRendererScript,
  getMobileVibrateScript,
  getMobileScreenDimensionsScript,
  getMobileBatteryScript,
  getMobilePointerTypeScript,
  emailToSeed,
} from "./mobile-spoofs.js";

// Advanced stealth modules — previously unreferenced, now wired into buildStealthScripts
import {
  getRotatedHardwareConcurrencyScript,
  getRotatedDeviceMemoryScript,
  getCoherentNavigatorApisScript,
} from "./scripts/hardware-rotation.js";
import {
  getEnhancedAccelerometerScript,
  getEnhancedBatteryScript,
  getComputedStyleInterceptScript,
} from "./scripts/sensor-simulator.js";
import {
  getRecaptchaHookScript,
  getUnifiedBehavioralScript,
} from "./scripts/recaptcha-interceptor.js";

// ─────────────────────────────────────────────────────────────────────────────
// 0. Global Function.prototype.toString Cloak
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Advanced fingerprinters use Function.prototype.toString.call(hookedFunction)
 * to verify if a native API has been tampered with. Standard overrides
 * (like func.toString = () => "[native code]") fail this deep inspection.
 * This script installs a Proxy on Function.prototype.toString that safely
 * intercepts calls to any function we have spoofed.
 */
export function getToStringCloakScript(): string {
  return `
(function() {
  try {
    var origToString = Function.prototype.toString;
    var proxyToString = new Proxy(origToString, {
      apply: function(target, thisArg, args) {
        if (thisArg === proxyToString) {
          return "function toString() { [native code] }";
        }
        if (thisArg && typeof thisArg === 'function') {
          try {
            if (thisArg.hasOwnProperty('toString') && typeof thisArg.toString === 'function') {
              var val = thisArg.toString();
              if (typeof val === 'string' && val.indexOf('[native code]') !== -1) {
                return val;
              }
            }
          } catch (e) {}
        }
        return origToString.apply(thisArg, args);
      }
    });
    Object.defineProperty(Function.prototype, 'toString', {
      value: proxyToString,
      configurable: true,
      enumerable: false,
      writable: true
    });
  } catch (e) {}
})();
  `.trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Client-Hints / navigator.userAgentData Strict Alignment
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build an init script that patches `navigator.userAgentData` so that
 * `sec-ch-ua`, `sec-ch-ua-platform`, and the UA string all agree perfectly.
 *
 * Without this, Chromium's default `navigator.userAgentData.brands` reflects
 * the *real* binary's version, while the HTTP headers are overridden via
 * `setExtraHTTPHeaders`. Fingerprinters compare the two and flag the mismatch.
 */
export function getClientHintsAlignmentScript(uaProfile: UAProfile): string {
  const platform = uaProfile.os === "macos" ? "macOS"
    : uaProfile.os === "linux" ? "Linux"
    : uaProfile.os === "android" ? "Android"
    : "Windows";
  const chromeVersion = String(uaProfile.chromeMajor);
  const fullVersion = uaProfile.chromeVersion;
  const platformVersion = uaProfile.platformVersion;
  const bitness = uaProfile.architecture === "x64" ? "64" : "64"; // ARM macs still report 64

  const brands = JSON.stringify([
    { brand: "Not;A=Brand", version: "99" },
    { brand: "Chromium", version: chromeVersion },
    { brand: "Google Chrome", version: chromeVersion },
  ]);

  const fullVersionBrands = JSON.stringify([
    { brand: "Not;A=Brand", version: "99.0.0.0" },
    { brand: "Chromium", version: fullVersion },
    { brand: "Google Chrome", version: fullVersion },
  ]);

  return `
(function() {
  try {
    var brands = ${brands};
    var fullVersionBrands = ${fullVersionBrands};
    var platform = ${JSON.stringify(platform)};
    var platformVersion = ${JSON.stringify(platformVersion)};
    var architecture = ${JSON.stringify(uaProfile.architecture === "arm64" ? "arm" : "x86")};
    var bitness = ${JSON.stringify(bitness)};
    var mobile = ${JSON.stringify(uaProfile.os === "android")};
    var model = "";
    var fullVersion = ${JSON.stringify(fullVersion)};
    var wow64 = false;

    // Build a compliant NavigatorUAData-like object
    var uaData = {
      brands: brands,
      mobile: mobile,
      platform: platform,
      toJSON: function() {
        return { brands: brands, mobile: mobile, platform: platform };
      },
      getHighEntropyValues: function(hints) {
        return Promise.resolve({
          brands: brands,
          fullVersionList: fullVersionBrands,
          mobile: mobile,
          model: model,
          platform: platform,
          platformVersion: platformVersion,
          architecture: architecture,
          bitness: bitness,
          uaFullVersion: fullVersion,
          wow64: wow64,
        });
      }
    };

    // Only override if the existing value doesn't already match
    if (navigator.userAgentData) {
      try {
        var origDesc = Object.getOwnPropertyDescriptor(Navigator.prototype, 'userAgentData');
        if (origDesc && origDesc.get) {
          origDesc.get = new Proxy(origDesc.get, {
            apply: function(target, thisArg, args) { return uaData; }
          });
          Object.defineProperty(Navigator.prototype, 'userAgentData', origDesc);
        } else {
          Object.defineProperty(navigator, 'userAgentData', {
            get: function() { return uaData; },
            configurable: true,
            enumerable: true,
          });
        }
      } catch { /* intentional */ }
    }
  } catch { /* intentional */ }
})();
  `.trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Font Bounding-Box Metric Spoofing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fingerprinters measure the *exact* pixel dimensions that a browser renders
 * specific text into a hidden canvas. Because Windows ClearType and macOS
 * Core Text produce subtly different glyph metrics for the same font, the
 * rendered width at 72px "mmmmmmmmmmlli" exposes the true OS.
 *
 * This script hooks CanvasRenderingContext2D.measureText and applies a
 * deterministic, per-session OS-aligned noise offset so the metrics are:
 *   1. Consistent within a session (same seed → same offsets)
 *   2. Aligned with the declared OS (Windows metrics are ~0.5–2% wider
 *      than macOS for common fonts at the same size)
 *   3. Non-zero noise prevents exact fingerprint matching across sessions
 */
export function getFontMetricSpoofScript(os: "windows" | "macos" | "linux" | "android", seed: number): string {
  // Windows ClearType renders slightly wider glyphs than macOS Core Text
  // for the same font/size. We encode that bias into the offset.
  const osBias = os === "windows" ? 0.35 : os === "linux" ? 0.10 : os === "android" ? -0.05 : -0.15;

  return `
(function() {
  try {
    var seed = ${seed};
    var osBias = ${osBias};

    // Deterministic PRNG (mulberry32) seeded per-session
    function mulberry32(a) {
      return function() {
        a |= 0; a = a + 0x6D2B79F5 | 0;
        var t = Math.imul(a ^ a >>> 15, 1 | a);
        t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
      };
    }
    var rng = mulberry32(seed);

    // Pre-compute a small noise table so identical calls return identical results
    var noiseCache = {};

    function getNoiseForKey(key) {
      if (noiseCache[key] !== undefined) return noiseCache[key];
      // ±0.8px jitter + OS bias
      var noise = (rng() - 0.5) * 1.6 + osBias;
      noiseCache[key] = noise;
      return noise;
    }

    var originalMeasureText = CanvasRenderingContext2D.prototype.measureText;
    var fakeMeasureText = function(text) {
      // Stage 8.4: Restrict system font bounding box measurements (OS-exclusive fonts)
      var currentFont = (this.font || '').toLowerCase();
      var isMac = ${os === "macos"};
      var isWindows = ${os === "windows"};
      if (isMac && (currentFont.indexOf('segoe') !== -1 || currentFont.indexOf('calibri') !== -1 || currentFont.indexOf('lucida console') !== -1)) {
        var origFont = this.font;
        this.font = '10px sans-serif';
        var fallbackResult = originalMeasureText.call(this, text);
        this.font = origFont;
        return fallbackResult;
      }
      if (isWindows && (currentFont.indexOf('helvetica neue') !== -1 || currentFont.indexOf('apple color emoji') !== -1)) {
        var origFont = this.font;
        this.font = '10px sans-serif';
        var fallbackResult = originalMeasureText.call(this, text);
        this.font = origFont;
        return fallbackResult;
      }

      var result = originalMeasureText.call(this, text);
      if (!text || text.length === 0) return result;

      var key = (this.font || '10px sans-serif') + '|' + text.substring(0, 64);
      var noise = getNoiseForKey(key);

      // Wrap the TextMetrics so .width returns a noised value
      var origWidth = result.width;
      var origABB = result.actualBoundingBoxLeft;
      var origABBR = result.actualBoundingBoxRight;

      try {
        Object.defineProperty(result, 'width', {
          get: function() { return origWidth + noise; },
          configurable: true,
        });
        if (typeof origABBR === 'number') {
          Object.defineProperty(result, 'actualBoundingBoxRight', {
            get: function() { return origABBR + noise; },
            configurable: true,
          });
        }
      } catch { /* intentional */ }

      return result;
    };
    fakeMeasureText.toString = function() { return "function measureText() { [native code] }"; };
    CanvasRenderingContext2D.prototype.measureText = fakeMeasureText;

    // Also hook DOMRect bounds to prevent layout-based font fingerprinting
    var originalGBCR = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function() {
      var rect = originalGBCR.call(this);
      if (!rect) return rect;

      // We only want to noise small elements (like text spans) or fingerprint canvas
      var isSmall = rect.width < 500 && rect.height < 500;
      if (!isSmall) return rect;

      // Deterministic noise based on node name and text content
      var nodeText = this.textContent ? this.textContent.substring(0, 32) : '';
      var key = this.nodeName + '|' + nodeText + '|' + rect.width.toFixed(1);
      var noise = getNoiseForKey(key) * 0.1; // scale down noise for layout

      // Return a proper DOMRect (not a plain object) to avoid tampering detection
      return new DOMRect(
        rect.x,
        rect.y,
        rect.width + noise,
        rect.height + (noise * 0.8)
      );
    };

  } catch { /* intentional */ }
})();
  `.trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. AudioContext Frequency-Response Obfuscation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * FingerprintJS and similar libraries create an OfflineAudioContext, run an
 * OscillatorNode through a DynamicsCompressorNode, and read back the
 * resulting AudioBuffer's channel data. The exact float32 values expose the
 * audio stack (hardware + OS + driver). Since all our sessions run on the
 * same host machine, without spoofing every session shares an identical
 * audio fingerprint — an instant correlation signal.
 *
 * This script hooks AudioBuffer.getChannelData and
 * AnalyserNode.getFloatFrequencyData to apply deterministic per-session
 * micro-noise to every sample.
 */
export function getAudioContextSpoofScript(seed: number): string {
  return `
(function() {
  try {
    var seed = ${seed};

    // Deterministic PRNG (mulberry32) — separate instance from font spoofing
    function mulberry32(a) {
      return function() {
        a |= 0; a = a + 0x6D2B79F5 | 0;
        var t = Math.imul(a ^ a >>> 15, 1 | a);
        t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
      };
    }
    var audioRng = mulberry32(seed ^ 0xAA55AA55);

    // Noise magnitude — small enough to be inaudible (1e-7 scale),
    // large enough to differentiate sessions in float32 space.
    // Dynamic noise scaling (Stealth Reinforcement): makes the noise
    // distribution curve itself unique per seed.
    var NOISE_MAG = 1e-7 * (1 + (seed % 100) / 50);

    // Hook AudioBuffer.getChannelData
    var origGetChannelData = AudioBuffer.prototype.getChannelData;
    var poisonedBuffers = new WeakSet();

    AudioBuffer.prototype.getChannelData = function(channel) {
      var data = origGetChannelData.call(this, channel);
      if (!poisonedBuffers.has(this)) {
        poisonedBuffers.add(this);
        for (var i = 0; i < data.length; i++) {
          data[i] += (audioRng() - 0.5) * 2 * NOISE_MAG;
        }
      }
      return data;
    };
    AudioBuffer.prototype.getChannelData.toString = function() { return "function getChannelData() { [native code] }"; };

    // Hook AnalyserNode.getFloatFrequencyData
    if (typeof AnalyserNode !== 'undefined') {
      var origGetFloatFreq = AnalyserNode.prototype.getFloatFrequencyData;
      AnalyserNode.prototype.getFloatFrequencyData = function(array) {
        origGetFloatFreq.call(this, array);
        for (var i = 0; i < array.length; i++) {
          array[i] += (audioRng() - 0.5) * 0.001;
        }
      };
      AnalyserNode.prototype.getFloatFrequencyData.toString = function() { return "function getFloatFrequencyData() { [native code] }"; };

      var origGetByteFreq = AnalyserNode.prototype.getByteFrequencyData;
      AnalyserNode.prototype.getByteFrequencyData = function(array) {
        origGetByteFreq.call(this, array);
        // Byte-level: jitter ±1 on ~30% of bins
        for (var i = 0; i < array.length; i++) {
          if (audioRng() < 0.3) {
            array[i] = Math.max(0, Math.min(255, array[i] + (audioRng() < 0.5 ? -1 : 1)));
          }
        }
      };
      AnalyserNode.prototype.getByteFrequencyData.toString = function() { return "function getByteFrequencyData() { [native code] }"; };
    }

    // Hook OfflineAudioContext.startRendering result
    if (typeof OfflineAudioContext !== 'undefined') {
      var origStartRendering = OfflineAudioContext.prototype.startRendering;
      OfflineAudioContext.prototype.startRendering = function() {
        return origStartRendering.call(this).then(function(buffer) {
          // Ensure getChannelData poisoning runs on rendered buffers
          try {
            for (var ch = 0; ch < buffer.numberOfChannels; ch++) {
              buffer.getChannelData(ch); // triggers our hook
            }
          } catch { /* intentional */ }
          return buffer;
        });
      };
    }
  } catch { /* intentional */ }
})();
  `.trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. navigator.webdriver Override
// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// 5. Browser Autofill Simulation
// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// Composite: All stealth scripts for a session
// ─────────────────────────────────────────────────────────────────────────────

export interface StealthScriptConfig {
  uaProfile?: UAProfile;
  hardwareProfile?: import("../profiles/profile-determinism.js").HardwareProfile;
  fingerprintSeed?: number;
  /** Timezone IANA string from the geo profile (e.g. "Australia/Melbourne", "America/New_York").
   *  When set, the Intl.DateTimeFormat and Date.getTimezoneOffset APIs are
   *  overridden to match, preventing timezone-vs-proxy mismatch detection. */
  timezone?: string;
  /** Accept-Language locale from the geo profile (e.g. "en-AU", "en-US"). */
  locale?: string;
  /** Backend type — determines which stealth tiers are injected.
   *  "stealth" = Camoufox (skip most JS, C++ handles it)
   *  "cloak" = CloakBrowser (supplementary JS on top of C++ patches)
   *  "zendriver" = Stock Chromium (full JS stealth suite required)
   *  Default: "zendriver" (maximum protection) */
  backendType?: "stealth" | "cloak" | "zendriver";
  /** Fingerprint strategy — "optimal" auto-selects per-backend,
   *  "native-only" skips all JS, "full-stealth" injects everything. */
  fpStrategy?: "optimal" | "native-only" | "full-stealth";
  /** Raw session count for hardware rotation (from FingerprintRotationEngine).
   *  When set, hardwareConcurrency and deviceMemory rotate every 3 sessions. */
  sessionCount?: number;
  /** Proxy IP for timezone-to-proxy geo sync. When set and no explicit
   *  timezone is configured, derives timezone from proxy geolocation. */
  proxyIp?: string;
  /** Optional captcha solving service URL for reCAPTCHA v3 interception.
   *  When set, grecaptcha.execute routes tokens through this endpoint. */
  captchaServiceUrl?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Timezone Alignment (dynamic, per-session)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Timezone offset lookup table for common IANA zones.
 * getTimezoneOffset() returns minutes WEST of UTC (so UTC+10 = -600).
 */
const TZ_OFFSETS: Record<string, number> = {
  "Australia/Melbourne": -660,  // AEDT (UTC+11 during DST, UTC+10 otherwise)
  "Australia/Sydney": -660,
  "Australia/Brisbane": -600,
  "Australia/Perth": -480,
  "Australia/Adelaide": -630,
  "America/New_York": 300,
  "America/Chicago": 360,
  "America/Denver": 420,
  "America/Los_Angeles": 480,
  "America/Toronto": 300,
  "Europe/London": 0,
  "Europe/Berlin": -60,
  "Europe/Paris": -60,
  "Asia/Tokyo": -540,
  "Asia/Singapore": -480,
  "Asia/Kolkata": -330,
  "Pacific/Auckland": -780,
};

export function getTimezoneAlignmentScript(timezone: string, locale: string = "en-US"): string {
  // Look up the offset, or derive a reasonable one
  const offset = TZ_OFFSETS[timezone];
  const offsetVal = offset !== undefined ? offset : -600; // fallback to AEST

  return `
(function() {
  try {
    var targetTZ = ${JSON.stringify(timezone)};
    var targetOffset = ${offsetVal};
    var targetLocale = ${JSON.stringify(locale)};

    // Override Intl.DateTimeFormat.resolvedOptions to return our timezone
    if (typeof Intl !== 'undefined') {
      if (Intl.DateTimeFormat) {
        var origDTFResolved = Intl.DateTimeFormat.prototype.resolvedOptions;
        Intl.DateTimeFormat.prototype.resolvedOptions = function() {
          var opts = origDTFResolved.call(this);
          opts.timeZone = targetTZ;
          opts.locale = targetLocale;
          return opts;
        };
        Intl.DateTimeFormat.prototype.resolvedOptions.toString = function() { return "function resolvedOptions() { [native code] }"; };
      }

      // Improvement #3: Intl/Timezone Spoofing Doesn't Cover Intl.RelativeTimeFormat, etc.
      var intlClasses = ['RelativeTimeFormat', 'ListFormat', 'Segmenter', 'NumberFormat', 'PluralRules', 'Collator'];
      for (var i = 0; i < intlClasses.length; i++) {
        var cls = intlClasses[i];
        if (Intl[cls]) {
          (function(IntlClass) {
            var origResolved = IntlClass.prototype.resolvedOptions;
            IntlClass.prototype.resolvedOptions = function() {
              var opts = origResolved.call(this);
              opts.locale = targetLocale;
              return opts;
            };
            IntlClass.prototype.resolvedOptions.toString = function() { return "function resolvedOptions() { [native code] }"; };
          })(Intl[cls]);
        }
      }
    }

    // Override Date.prototype.getTimezoneOffset to return matching offset
    Date.prototype.getTimezoneOffset = function() {
      return targetOffset;
    };
    Date.prototype.getTimezoneOffset.toString = function() { return "function getTimezoneOffset() { [native code] }"; };
  } catch { /* intentional */ }
})();
  `.trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Canvas, WebGL, Plugins, WebRTC Overrides
// ─────────────────────────────────────────────────────────────────────────────

export function getHardwareSpoofScript(seed: number, hardwareProfile?: import("../profiles/profile-determinism.js").HardwareProfile): string {
  let cores = 4;
  let mem = 8;

  if (hardwareProfile) {
    cores = hardwareProfile.cores;
    mem = hardwareProfile.memory;
  } else {
    const coresOptions = [4, 6, 8, 12, 16];
    cores = coresOptions[seed % coresOptions.length]!;
    const memOptions = [8, 8, 16, 32];
    mem = memOptions[(seed >> 2) % memOptions.length]!;
  }

  return `
(function() {
  try {
    var cores = ${cores};
    var mem = ${mem};
    if (navigator.hardwareConcurrency !== undefined) {
      Object.defineProperty(navigator, 'hardwareConcurrency', { get: function() { return cores; }, configurable: true, enumerable: true });
    }
    if (navigator.deviceMemory !== undefined) {
      Object.defineProperty(navigator, 'deviceMemory', { get: function() { return mem; }, configurable: true, enumerable: true });
    }
  } catch { /* intentional */ }
})();
`;
}
export function getPluginsSpoofScript(): string {
  return `
(function() {
  try {
    var mimeTypes = [
      { type: "application/pdf", suffixes: "pdf", description: "Portable Document Format", enabledPlugin: null },
      { type: "text/pdf", suffixes: "pdf", description: "Portable Document Format", enabledPlugin: null }
    ];
    var pluginNames = ["PDF Viewer", "Chrome PDF Viewer", "Chromium PDF Viewer", "Microsoft Edge PDF Viewer", "WebKit built-in PDF"];
    var plugins = pluginNames.map(function(name) {
      var p = mimeTypes.slice();
      p.name = name;
      p.filename = "internal-pdf-viewer";
      p.description = "Portable Document Format";
      p.length = 2;
      return p;
    });

    var pluginsList = plugins.slice();
    pluginsList.length = plugins.length;
    pluginsList.item = function(i) { return pluginsList[i] || null; };
    pluginsList.namedItem = function(n) { return pluginsList.find(function(p) { return p.name === n; }) || null; };
    pluginsList.refresh = function() {};

    var mimeTypesList = mimeTypes.slice();
    mimeTypesList.length = mimeTypes.length;
    mimeTypesList.item = function(i) { return mimeTypesList[i] || null; };
    mimeTypesList.namedItem = function(n) { return mimeTypesList.find(function(m) { return m.type === n; }) || null; };

    Object.defineProperty(navigator, "plugins", { get: function() { return pluginsList; }, configurable: true });
    Object.defineProperty(navigator, "mimeTypes", { get: function() { return mimeTypesList; }, configurable: true });
    Object.defineProperty(navigator, "pdfViewerEnabled", { get: function() { return true; }, configurable: true });
  } catch { /* intentional */ }
})();
`;
}

export function getWebRTCSpoofScript(): string {
  return `
(function() {
  try {
    if (window.RTCPeerConnection) {
      var OriginalRTC = window.RTCPeerConnection;
      var localIPRegex = /(?:192\\.168\\.|10\\.|172\\.(?:1[6-9]|2[0-9]|3[0-1])\\.|127\\.0\\.0\\.1|0\\.0\\.0\\.0|::1|fe80:)/;

      // Scrub local IPs from SDP candidate lines
      function scrubSDP(sdp) {
        if (!sdp || typeof sdp !== 'string') return sdp;
        var NL = String.fromCharCode(10);
        var lines = sdp.split(NL);
        var out = [];
        for (var i = 0; i < lines.length; i++) {
          var ln = lines[i];
          if (ln.indexOf('a=candidate:') === 0 && localIPRegex.test(ln)) {
            continue;
          }
          out.push(ln);
        }
        return out.join(NL);
      }

      function RTCPeerConnectionProxy(config) {
        var conf = config || { iceServers: [] };
        var pc = Reflect.construct(OriginalRTC, [conf]);

        // ── Patch createOffer/createAnswer to scrub SDP ──
        var origCreateOffer = pc.createOffer.bind(pc);
        pc.createOffer = function(options) {
          return origCreateOffer(options).then(function(offer) {
            return new RTCSessionDescription({
              type: offer.type,
              sdp: scrubSDP(offer.sdp)
            });
          });
        };

        var origCreateAnswer = pc.createAnswer.bind(pc);
        pc.createAnswer = function(options) {
          return origCreateAnswer(options).then(function(answer) {
            return new RTCSessionDescription({
              type: answer.type,
              sdp: scrubSDP(answer.sdp)
            });
          });
        };

        // ── Patch setLocalDescription to scrub before setting ──
        var origSetLocal = pc.setLocalDescription.bind(pc);
        pc.setLocalDescription = function(desc) {
          if (desc && desc.sdp) {
            desc = new RTCSessionDescription({
              type: desc.type,
              sdp: scrubSDP(desc.sdp)
            });
          }
          return origSetLocal(desc);
        };

        // ── Patch localDescription getter ──
        Object.defineProperty(pc, 'localDescription', {
          get: function() {
            var desc = Object.getOwnPropertyDescriptor(OriginalRTC.prototype, 'localDescription').get.call(this);
            if (desc && desc.sdp) {
              return new RTCSessionDescription({
                type: desc.type,
                sdp: scrubSDP(desc.sdp)
              });
            }
            return desc;
          },
          configurable: true
        });

        // ── Filter icecandidate events ──
        var origAddEventListener = pc.addEventListener;
        pc.addEventListener = function(type, listener, options) {
          if (type === 'icecandidate') {
            var origListener = listener;
            listener = function(event) {
              if (event.candidate && event.candidate.candidate) {
                if (localIPRegex.test(event.candidate.candidate)) {
                  return; // Drop local IP candidates
                }
              }
              origListener.call(this, event);
            };
          }
          return origAddEventListener.call(this, type, listener, options);
        };

        Object.defineProperty(pc, 'onicecandidate', {
          set: function(val) {
            var listener = val;
            if (typeof val === 'function') {
              listener = function(event) {
                if (event.candidate && event.candidate.candidate) {
                  if (localIPRegex.test(event.candidate.candidate)) {
                    return;
                  }
                }
                val.call(this, event);
              };
            }
            origAddEventListener.call(this, 'icecandidate', listener);
          },
          configurable: true,
          enumerable: true
        });

        return pc;
      }

      RTCPeerConnectionProxy.prototype = OriginalRTC.prototype;
      Object.setPrototypeOf(RTCPeerConnectionProxy, OriginalRTC);
      if (typeof OriginalRTC.generateCertificate === "function") {
        RTCPeerConnectionProxy.generateCertificate = OriginalRTC.generateCertificate.bind(OriginalRTC);
      }
      window.RTCPeerConnection = RTCPeerConnectionProxy;
      if (window.webkitRTCPeerConnection) {
        window.webkitRTCPeerConnection = RTCPeerConnectionProxy;
      }
    }
  } catch { /* intentional */ }
})();
`;
}

import fs from 'fs';
import path from 'path';
import { getScreenNoiseScript, getCssMediaQueryCoherenceScript } from "./scripts/screen-spoofs.js";
import { getDeviceMotionSpoofScript, getDynamicBatterySpoofScript } from "./scripts/sensor-spoofs.js";
import { mutatePayload } from "./scripts/ast-mutator.js";
import { getWebGLSpoofScript } from "./scripts/webgl-spoofs.js";
import { getCanvasSpoofScript } from "./scripts/canvas-spoofs.js";

function getOptimizedSeed(): number {
  try {
    const weightsPath = path.join(process.cwd(), 'hermes', 'stealth-weights.json');
    if (fs.existsSync(weightsPath)) {
      const weights = JSON.parse(fs.readFileSync(weightsPath, 'utf8'));
      if (weights && weights.length > 0) {
        // Simple roulette wheel selection
        const totalWeight = weights.reduce((sum: number, w: any) => sum + w.successRate, 0);
        let random = Math.random() * totalWeight;
        for (const w of weights) {
          random -= w.successRate;
          if (random <= 0) return w.seed;
        }
        return weights[0].seed;
      }
    }
  } catch {
    // Fallback on error
  }
  return Math.floor(Math.random() * 89999) + 10000;
}

/**
 * Build an array of all stealth init script bodies for a given session config.
 * Each element is a self-contained IIFE string ready for addInitScript() or
 * Page.addScriptToEvaluateOnNewDocument().
 *
 * Tier Architecture:
 *   Tier 1 (CORE):        webdriver, timezone, client hints — always needed for Chromium
 *   Tier 2 (FINGERPRINT): WebGL, canvas, audio, hardware, plugins, battery, etc.
 *   Tier 3 (BEHAVIORAL):  reCAPTCHA v3 RAF loop, visibility, devtools evasion
 *   Tier M (MOBILE):      10 mobile coherence scripts — only when emulateMobile=true
 *
 * Per-Backend Logic (when fpStrategy="optimal"):
 *   Camoufox:    Tier 3 + M only (C++ handles everything else — proven by FP.com score 3 vs 17 with JS)
 *   CloakBrowser: Tier 1 + Tier 2 (supplementary only) + Tier 3 + M
 *   Zendriver:   ALL tiers (zero C++ patches, JS is the only defense)
 */
export function buildStealthScripts(config: StealthScriptConfig): string[] {
  const scripts: string[] = [];
  const seed = config.fingerprintSeed ?? getOptimizedSeed();
  const backend = config.backendType ?? "zendriver"; // Default to max protection
  const strategy = config.fpStrategy ?? "optimal";
  const isMobile = config.uaProfile?.mobile ?? false;
  const os: "windows" | "macos" | "linux" | "android" = config.uaProfile?.os ?? "windows";

  // ── "native-only" strategy: inject NOTHING (backend handles everything) ──
  if (strategy === "native-only") {
    return scripts.map(s => mutatePayload(s, seed));
  }

  // ── Resolve which tiers this backend needs ──
  // "full-stealth" forces all tiers regardless of backend
  const forceAll = strategy === "full-stealth";
  const isCamoufox = backend === "stealth" && !forceAll;
  const isCloak = backend === "cloak" && !forceAll;
  // Zendriver or forceAll = inject everything

  // ═══════════════════════════════════════════════════════════════════════════
  // TIER 1: CORE — Always needed for Chromium backends, skip for Camoufox
  // ═══════════════════════════════════════════════════════════════════════════
  if (!isCamoufox) {
    // Global Function.prototype.toString cloak (must run before ANY other overrides)
    scripts.push(getToStringCloakScript());

    // navigator.webdriver override
    scripts.push(getWebdriverOverrideScript());

    // Dynamic timezone alignment
    if (config.timezone) {
      const locale = config.timezone.includes("Australia") ? "en-AU" :
                     config.timezone.includes("London") ? "en-GB" : "en-US";
      scripts.push(getTimezoneAlignmentScript(config.timezone, locale));
    }

    // Client-Hints / navigator.userAgentData alignment
    if (config.uaProfile) {
      scripts.push(getClientHintsAlignmentScript(config.uaProfile));
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // TIER 2: FINGERPRINT — Full for Zendriver, supplementary for CloakBrowser
  // CloakBrowser's C++ patches handle: Canvas, WebGL, GPU, Fonts, Screen
  // So CloakBrowser only needs: Battery, Permissions, Speech, Connection, etc.
  // Camoufox: SKIP entirely (C++ at Firefox engine level handles all)
  // ═══════════════════════════════════════════════════════════════════════════
  if (!isCamoufox) {
    // ── Scripts needed by ALL Chromium backends (supplementary) ──

    // Battery: use enhanced constrained-range battery from sensor-simulator
    // (replaces legacy getBatteryApiSpoofScript / getDynamicBatterySpoofScript)
    scripts.push(getEnhancedBatteryScript(seed));

    scripts.push(getPermissionsApiSpoofScript(seed));
    scripts.push(getCSSSupportsSpoofScript(config.uaProfile?.chromeMajor ?? 130));
    scripts.push(getFeaturePolicyScript());
    scripts.push(getCrossOriginIsolationScript());
    scripts.push(getSpeechVoicesSpoofScript(os));
    scripts.push(getNotificationConsistencyScript(seed));
    scripts.push(getPerformanceTimingSpoofScript(seed));
    scripts.push(getDeviceOrientationSpoofScript());
    scripts.push(getGeolocationSpoofScript());
    scripts.push(getIndexedDBConsistencyScript());
    scripts.push(getNavigatorConnectionSpoofScript(seed));
    scripts.push(getPerformanceMemorySpoofScript());

    // ── Hardware rotation: session-counter-gated rotation every 3 sessions ──
    // Replaces static getHardwareSpoofScript with dynamic rotation from hardware-rotation.ts
    const sessionCount = config.sessionCount ?? 0;
    scripts.push(getRotatedHardwareConcurrencyScript(seed, sessionCount, 3, config.hardwareProfile?.cores));
    scripts.push(getRotatedDeviceMemoryScript(seed, sessionCount, 3, config.hardwareProfile?.memory));

    // ── Coherent Navigator APIs: cross-validates touch, gamepads, USB, clipboard ──
    scripts.push(getCoherentNavigatorApisScript(seed, isMobile));

    scripts.push(getPluginsSpoofScript());
    scripts.push(getWebRTCSpoofScript());

    // ── Storage Emulation ──
    // Seeds indexedDB with pseudo-databases and injects localStorage keys with TTL.
    scripts.push(getStorageEmulationScript(seed));
    scripts.push(getStorageSandboxScript(seed));

    // ── Enhanced Sensor Spoofing (replaces legacy getDeviceMotionSpoofScript) ──
    // Perlin-like drift accelerometer + gyroscope with configurable stddev.
    scripts.push(getEnhancedAccelerometerScript(seed));

    // ── Screen Noise & Dimensions ──
    scripts.push(getScreenNoiseScript(seed));

    // ── CSS Media Query Coherence ──
    scripts.push(getCssMediaQueryCoherenceScript(isMobile));

    // ── ComputedStyle intercept: normalizes rendering differences ──
    scripts.push(getComputedStyleInterceptScript(config.uaProfile?.chromeMajor ?? 130));

    // ── Scripts only Zendriver needs (CloakBrowser C++ handles these) ──
    if (!isCloak) {
      scripts.push(getFontMetricSpoofScript(os, seed));
      scripts.push(getAudioContextSpoofScript(seed));

      // WebGL vendor/renderer spoofing
      let vendor = "Google Inc. (NVIDIA)";
      let renderer = "ANGLE (NVIDIA, NVIDIA GeForce GTX 1080 Direct3D11 vs_5_0 ps_5_0, D3D11)";

      if (config.hardwareProfile?.gpu) {
        vendor = `Google Inc. (${config.hardwareProfile.gpu.vendor})`;
        const graphicsApi = os === "windows" ? "Direct3D11 vs_5_0 ps_5_0, D3D11" : "OpenGL 4.1";
        renderer = `ANGLE (${config.hardwareProfile.gpu.vendor}, ${config.hardwareProfile.gpu.renderer}, ${graphicsApi})`;
      } else if (config.uaProfile?.webgl) {
        vendor = config.uaProfile.webgl.vendor;
        renderer = config.uaProfile.webgl.renderer;
      } else {
        const arch = config.uaProfile?.architecture ?? "x64";
        if (os === "macos") {
          if (arch === "arm64") {
            vendor = "Google Inc. (Apple)";
            const mSeries = seed % 3 === 0 ? "M2" : seed % 3 === 1 ? "M3" : "M1";
            renderer = `ANGLE (Apple, Apple ${mSeries} Pro, OpenGL 4.1)`;
          } else {
            vendor = "Google Inc. (Intel)";
            renderer = "ANGLE (Intel Inc., Intel(R) Iris(TM) Plus Graphics 640, OpenGL 4.1)";
          }
        } else if (os === "windows") {
          if (arch === "arm64") {
            vendor = "Google Inc. (Qualcomm)";
            renderer = "ANGLE (Qualcomm, Adreno (TM) 690, Direct3D11 vs_5_0 ps_5_0, D3D11)";
          } else {
            const gpuBrand = seed % 3;
            if (gpuBrand === 0) {
              vendor = "Google Inc. (NVIDIA)";
              renderer = "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)";
            } else if (gpuBrand === 1) {
              vendor = "Google Inc. (AMD)";
              renderer = "ANGLE (AMD, AMD Radeon RX 6700 XT Direct3D11 vs_5_0 ps_5_0, D3D11)";
            } else {
              vendor = "Google Inc. (Intel)";
              renderer = "ANGLE (Intel, Intel(R) UHD Graphics 770 Direct3D11 vs_5_0 ps_5_0, D3D11)";
            }
          }
        } else if (os === "linux") {
          vendor = "Google Inc. (Intel)";
          renderer = "ANGLE (Intel, Mesa Intel UHD Graphics 630, OpenGL 4.6)";
        }
      }
      scripts.push(getWebGLSpoofScript(vendor, renderer));
      scripts.push(getCanvasSpoofScript(seed));

      // FingerprintJS Smart Signal evasion (only Zendriver needs these)
      scripts.push(getAntiVmDetectionScript());
      scripts.push(getIncognitoEvasionScript());
      scripts.push(getScreenConsistencyScript());
    }

    // Autofill simulation helper (all Chromium backends)
    scripts.push(getAutofillSimulationScript());
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // TIER 3: BEHAVIORAL — Injected for ALL backends (including Camoufox headed)
  // reCAPTCHA v3 scoring depends on behavioral signals, not fingerprints
  //
  // Replaced legacy separate scripts (getRecaptchaV3ScoreBoostScript,
  // getBezierMouseTrajectoryScript, getScrollEmulationScript,
  // getRecaptchaInterceptionScript) with the unified behavioral emulation
  // and enhanced reCAPTCHA hook from recaptcha-interceptor.ts
  // ═══════════════════════════════════════════════════════════════════════════
  scripts.push(getDevToolsEvasionScript());

  // ── Unified Behavioral Emulation (replaces 3 separate scripts) ──
  // Coordinates RAF-driven micro-events, Bézier mouse trajectories,
  // natural scroll with inertia, and focus/visibility management.
  scripts.push(getUnifiedBehavioralScript(isMobile));

  // ── Enhanced reCAPTCHA v3 Hook (replaces legacy getRecaptchaInterceptionScript) ──
  // Delays grecaptcha.execute, injects behavioral burst, force-sets
  // g-recaptcha-response, and walks ___grecaptcha_cfg callback tree.
  scripts.push(getRecaptchaHookScript(config.captchaServiceUrl));

  // ═══════════════════════════════════════════════════════════════════════════
  // TIER M: MOBILE COHERENCE — Only when emulateMobile toggle is ON
  // Zero impact on desktop. These 10 scripts fix all known detection vectors
  // for desktop-pretending-to-be-mobile.
  // ═══════════════════════════════════════════════════════════════════════════
  if (isMobile) {
    scripts.push(getMobilePlatformOverrideScript());       // #1: platform = "Linux armv8l"
    scripts.push(getMobileTouchPointsScript());            // #2: maxTouchPoints = 5
    scripts.push(getMobileOntouchstartScript());           // #3: ontouchstart support
    scripts.push(getMobileOrientationScript());            // #4: portrait-primary orientation
    scripts.push(getMobileConnectionScript(seed));         // #5: cellular connection (overrides desktop wifi)
    scripts.push(getMobileWebGLRendererScript(seed));      // #6: Adreno/Mali GPU (overrides desktop NVIDIA/AMD)
    scripts.push(getMobileVibrateScript());                // #7: navigator.vibrate()
    scripts.push(getMobileScreenDimensionsScript(seed));   // #8: mobile screen + high DPR (overrides desktop)
    scripts.push(getMobileBatteryScript(seed));            // #9: mobile battery (overrides desktop charging=true)
    scripts.push(getMobilePointerTypeScript());            // #10: pointerType = "touch"
  } else {
    // ═══════════════════════════════════════════════════════════════════════════
    // TIER D: DESKTOP COHERENCE — Fix touchscreen laptop leaking maxTouchPoints
    // Host machines with touchscreens report maxTouchPoints=10 but the spoofed
    // profile is desktop (no mobile UA). This mismatch is a coherence failure
    // that costs 3 suspect points. Force maxTouchPoints=0 for desktop profiles.
    // ═══════════════════════════════════════════════════════════════════════════
    scripts.push(getDesktopTouchPointsScript());           // maxTouchPoints = 0
  }

  return scripts.map(s => mutatePayload(s, seed));
}

// ─────────────────────────────────────────────────────────────────────────────
// Layer 7: Scrapfly-Detected Missing Fingerprint Vectors
// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// Layer 8: reCAPTCHA v3 Behavioral Score Maximizer
// ─────────────────────────────────────────────────────────────────────────────

export function getRecaptchaV3ScoreBoostScript(isMobile: boolean): string {
  return `
(function() {
  try {
    // 1. Immediately fire a focus event (reCAPTCHA checks if tab was ever focused)
    window.dispatchEvent(new Event('focus', { bubbles: false }));
    document.dispatchEvent(new Event('focus', { bubbles: false }));

    // 2. Set document.hasFocus to always return true
    if (document.hasFocus && !document.hasFocus()) {
      Object.defineProperty(document, 'hasFocus', {
        value: function() { return true; },
        configurable: true, writable: true
      });
    }

    // 3. Set document.visibilityState and hidden
    Object.defineProperty(document, 'visibilityState', {
      get: function() { return 'visible'; },
      configurable: true
    });
    Object.defineProperty(document, 'hidden', {
      get: function() { return false; },
      configurable: true
    });

    // 4. CONTINUOUS RAF-driven behavioral event loop (Improvement #13)
    // v3's JS collector uses requestAnimationFrame to continuously sample
    // telemetry. We generate micro-events every 100-200ms throughout the
    // page lifetime, not just at injection time.
    var lastMouseX = 400 + Math.floor(Math.random() * 200);
    var lastMouseY = 300 + Math.floor(Math.random() * 100);
    var frameCount = 0;
    var lastEventTime = 0;
    var maxDurationMs = 60000; // Stop after 60s to avoid resource waste
    var startTime = Date.now();

    function rafLoop(timestamp) {
      if (Date.now() - startTime > maxDurationMs) return; // Auto-stop
      frameCount++;

      // Fire a micro-event every 8-15 RAF frames (~130-250ms at 60fps)
      var eventInterval = 8 + Math.floor(Math.random() * 7);
      if (frameCount % eventInterval === 0) {
        var eventType = Math.random();

        if (eventType < 0.45) {
          // Mouse micro-drift (most common idle signal)
          lastMouseX += (Math.random() - 0.5) * 6;
          lastMouseY += (Math.random() - 0.5) * 4;
          lastMouseX = Math.max(50, Math.min(1230, lastMouseX));
          lastMouseY = Math.max(50, Math.min(670, lastMouseY));
          if (${isMobile}) {
            // Item 15: Touch Events Missing on Mobile Profiles
            var touch = new Touch({
              identifier: Date.now(),
              target: document.body,
              clientX: Math.round(lastMouseX),
              clientY: Math.round(lastMouseY),
              radiusX: 2.5, radiusY: 2.5, rotationAngle: 10, force: 0.5,
            });
            document.dispatchEvent(new TouchEvent('touchmove', {
              bubbles: true, cancelable: true, touches: [touch], targetTouches: [touch], changedTouches: [touch]
            }));
          } else {
            document.dispatchEvent(new MouseEvent('mousemove', {
              bubbles: true, clientX: Math.round(lastMouseX), clientY: Math.round(lastMouseY)
            }));
          }
        } else if (eventType < 0.65) {
          // Pointer event (Chrome fires both mouse and pointer)
          try {
            document.dispatchEvent(new PointerEvent('pointermove', {
              bubbles: true, clientX: Math.round(lastMouseX), clientY: Math.round(lastMouseY),
              pointerId: 1, pointerType: 'mouse', isPrimary: true
            }));
          } catch { /* intentional */ }
        } else if (eventType < 0.75) {
          // Focus/blur cycle (rare but signals active user)
          window.dispatchEvent(new Event('focus', { bubbles: false }));
        } else if (eventType < 0.85) {
          // Micro-scroll (user adjusting view)
          window.dispatchEvent(new Event('scroll', { bubbles: true }));
        }
        // 15% of the time: intentional no-op (humans don't move every frame)
      }

      requestAnimationFrame(rafLoop);
    }

    // Start RAF loop after initial settle (250-500ms)
    setTimeout(function() { requestAnimationFrame(rafLoop); }, 250 + Math.floor(Math.random() * 250));

    // 5. Initial burst of events (for immediate v3 signals)
    setTimeout(function() {
      document.dispatchEvent(new MouseEvent('mouseenter', {
        bubbles: true, clientX: lastMouseX, clientY: lastMouseY
      }));
    }, 200 + Math.floor(Math.random() * 200));

    // 6. Hook grecaptcha.execute to ensure minimum 3s delay after page load
    // (instant execution is a strong bot signal for v3 scoring)
    var pageLoadTime = Date.now();
    var MIN_DELAY_MS = 3000;

    function patchGrecaptcha() {
      if (typeof grecaptcha === 'undefined' || !grecaptcha.execute) return;
      if (grecaptcha.__patched) return;
      var origExecute = grecaptcha.execute;
      grecaptcha.execute = function(siteKey, opts) {
        var elapsed = Date.now() - pageLoadTime;
        if (elapsed < MIN_DELAY_MS) {
          // Inject a burst of behavioral events right before execute
          for (var b = 0; b < 3; b++) {
            document.dispatchEvent(new MouseEvent('mousemove', {
              bubbles: true,
              clientX: lastMouseX + (Math.random() - 0.5) * 20,
              clientY: lastMouseY + (Math.random() - 0.5) * 15
            }));
          }
          return new Promise(function(resolve, reject) {
            setTimeout(function() {
              origExecute.call(grecaptcha, siteKey, opts).then(resolve).catch(reject);
            }, MIN_DELAY_MS - elapsed);
          });
        }
        return origExecute.call(grecaptcha, siteKey, opts);
      };
      grecaptcha.__patched = true;
    }

    // Try patching immediately and also after delays (recaptcha loads async)
    patchGrecaptcha();
    setTimeout(patchGrecaptcha, 500);
    setTimeout(patchGrecaptcha, 1500);
    setTimeout(patchGrecaptcha, 3000);
    setTimeout(patchGrecaptcha, 5000);
  } catch { /* intentional */ }
})();
  `.trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// Layer 10: Storage Emulation — indexedDB seeding & localStorage TTL injection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Storage Emulation — seed indexedDB with pseudo-databases and inject
 * localStorage keys with TTL. Real browsers accumulate storage artifacts
 * from extensions, service workers, and prior visits. An empty storage
 * footprint is a strong bot signal.
 *
 * - Seeds indexedDB.databases() with realistic system DBs (userSessionDB, prefsCache).
 * - Injects localStorage keys (clientID, authToken, theme) with 12-hour TTL.
 * - Keys are deterministic per seed so the same credential always looks the same.
 */
export function getStorageEmulationScript(seed: number): string {
  // Deterministic client ID from seed
  const clientId = ((seed * 2654435761) >>> 0).toString(16).padStart(8, "0");
  const authToken = ((seed * 1597334677) >>> 0).toString(36).padStart(12, "0");
  const themeChoice = seed % 3 === 0 ? "dark" : "light";
  const ttlHours = 12;
  const ttlMs = ttlHours * 60 * 60 * 1000;

  return `
(function() {
  try {
    // ── localStorage injection with TTL ──
    var storageKeys = {
      "clientID": "${clientId}",
      "authToken": "${authToken}",
      "theme": "${themeChoice}",
      "consent_given": "true",
      "last_visit": new Date(Date.now() - Math.floor(Math.random() * 86400000)).toISOString(),
      "_ga_session": Math.floor(Math.random() * 999999).toString()
    };

    var TTL_MS = ${ttlMs};
    var now = Date.now();

    for (var key in storageKeys) {
      if (!localStorage.getItem(key)) {
        try {
          localStorage.setItem(key, storageKeys[key]);
          localStorage.setItem(key + "__ttl", (now + TTL_MS).toString());
        } catch { /* intentional */ }
      }
    }

    // TTL eviction on next load
    for (var i = 0; i < localStorage.length; i++) {
      var k = localStorage.key(i);
      if (k && k.endsWith("__ttl")) {
        var expiry = parseInt(localStorage.getItem(k) || "0", 10);
        if (expiry > 0 && now > expiry) {
          var dataKey = k.replace("__ttl", "");
          localStorage.removeItem(dataKey);
          localStorage.removeItem(k);
        }
      }
    }

    // ── indexedDB seeding ──
    if (window.indexedDB) {
      var dbNames = ["userSessionDB", "prefsCache", "__sw_cache_v2"];
      dbNames.forEach(function(name) {
        try {
          var req = indexedDB.open(name, 1);
          req.onupgradeneeded = function(e) {
            var db = e.target.result;
            if (!db.objectStoreNames.contains("data")) {
              db.createObjectStore("data", { keyPath: "id" });
            }
          };
          req.onsuccess = function(e) {
            try {
              var db = e.target.result;
              var tx = db.transaction("data", "readwrite");
              var store = tx.objectStore("data");
              store.put({ id: "init", ts: Date.now(), seed: ${seed} });
              db.close();
            } catch { /* intentional */ }
          };
          req.onerror = function() {};
        } catch { /* intentional */ }
      });
    }
  } catch { /* intentional */ }
})();
  `.trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// Layer 11: DeviceMotion & Sensor Spoofing
// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// Layer 12: reCAPTCHA v3 Token Interception & Behavioral Obfuscation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Bézier-curve mouse trajectory generator — produces natural-looking mouse
 * movements between two points using cubic Bézier curves with randomised
 * control points. reCAPTCHA v3 analyzes mouse trajectory smoothness and
 * velocity distribution; straight-line movements score poorly.
 */
export function getBezierMouseTrajectoryScript(): string {
  return `
(function() {
  try {
    window.__bezierMouseMove = function(fromX, fromY, toX, toY, durationMs, callback) {
      durationMs = durationMs || 400 + Math.floor(Math.random() * 300);
      // Control points with randomised offset for natural curvature
      var cpRange = Math.max(Math.abs(toX - fromX), Math.abs(toY - fromY)) * 0.4;
      var cp1x = fromX + (toX - fromX) * 0.25 + (Math.random() - 0.5) * cpRange;
      var cp1y = fromY + (toY - fromY) * 0.25 + (Math.random() - 0.5) * cpRange;
      var cp2x = fromX + (toX - fromX) * 0.75 + (Math.random() - 0.5) * cpRange;
      var cp2y = fromY + (toY - fromY) * 0.75 + (Math.random() - 0.5) * cpRange;

      var steps = Math.max(10, Math.floor(durationMs / 16));
      var step = 0;
      var startTime = performance.now();

      function bezier(t, p0, p1, p2, p3) {
        var u = 1 - t;
        return u*u*u*p0 + 3*u*u*t*p1 + 3*u*t*t*p2 + t*t*t*p3;
      }

      function tick() {
        step++;
        var t = Math.min(step / steps, 1);
        // Ease-in-out for velocity realism
        var eased = t < 0.5 ? 2*t*t : -1 + (4 - 2*t)*t;
        var x = Math.round(bezier(eased, fromX, cp1x, cp2x, toX));
        var y = Math.round(bezier(eased, fromY, cp1y, cp2y, toY));

        document.dispatchEvent(new MouseEvent('mousemove', {
          bubbles: true, clientX: x, clientY: y
        }));
        try {
          document.dispatchEvent(new PointerEvent('pointermove', {
            bubbles: true, clientX: x, clientY: y,
            pointerId: 1, pointerType: 'mouse', isPrimary: true
          }));
        } catch { /* intentional */ }

        if (step < steps) {
          var delay = (durationMs / steps) + (Math.random() - 0.5) * 4;
          setTimeout(tick, Math.max(1, delay));
        } else if (callback) {
          callback();
        }
      }

      tick();
    };
  } catch { /* intentional */ }
})();
  `.trim();
}

/**
 * Scroll emulation with randomised inertia — simulates natural scroll
 * behaviour with velocity decay. reCAPTCHA v3 checks scroll event
 * patterns; instant or uniform scrolling is a bot tell.
 */
export function getScrollEmulationScript(): string {
  return `
(function() {
  try {
    window.__naturalScroll = function(targetY, durationMs) {
      durationMs = durationMs || 600 + Math.floor(Math.random() * 400);
      var startY = window.scrollY || window.pageYOffset || 0;
      var distance = targetY - startY;
      var startTime = performance.now();
      var velocity = distance > 0
        ? (400 + Math.random() * 500)   // 400-900 px/sec downward
        : -(400 + Math.random() * 500); // upward

      function easeOutQuart(t) {
        return 1 - Math.pow(1 - t, 4);
      }

      function step(now) {
        var elapsed = now - startTime;
        var t = Math.min(elapsed / durationMs, 1);
        var eased = easeOutQuart(t);
        var currentY = startY + distance * eased;

        window.scrollTo(0, Math.round(currentY));
        window.dispatchEvent(new Event('scroll', { bubbles: true }));

        if (t < 1) {
          // Add micro-jitter to timing (human hand tremor)
          requestAnimationFrame(step);
        }
      }

      requestAnimationFrame(step);
    };

    // Auto-trigger a small idle scroll after page load
    setTimeout(function() {
      var maxScroll = Math.max(0, document.body.scrollHeight - window.innerHeight);
      if (maxScroll > 100) {
        var scrollTarget = 50 + Math.floor(Math.random() * Math.min(200, maxScroll));
        window.__naturalScroll(scrollTarget, 800 + Math.floor(Math.random() * 400));
      }
    }, 2000 + Math.floor(Math.random() * 3000));
  } catch { /* intentional */ }
})();
  `.trim();
}

/**
 * Enhanced reCAPTCHA v3 interception — intercepts grecaptcha.execute to:
 * 1. Route token requests through an optional external solving service
 * 2. Force-set the g-recaptcha-response field
 * 3. Override ___grecaptcha_cfg callback functions
 * 4. Ensure minimum behavioural delay before execution
 *
 * If no captchaServiceUrl is provided, falls back to the standard
 * delayed-execute approach from getRecaptchaV3ScoreBoostScript.
 */
export function getRecaptchaInterceptionScript(captchaServiceUrl?: string): string {
  const serviceUrl = captchaServiceUrl || "";
  return `
(function() {
  try {
    var CAPTCHA_SERVICE_URL = "${serviceUrl}";
    var PAGE_LOAD_TIME = Date.now();
    var MIN_DELAY_MS = 3000;

    function patchRecaptcha() {
      if (typeof grecaptcha === 'undefined' || !grecaptcha.execute) return;
      if (grecaptcha.__patched) return;  // Same guard as ScoreBoostScript — only first patcher wins

      var origExecute = grecaptcha.execute;
      grecaptcha.execute = function(siteKey, opts) {
        var action = (opts && opts.action) || 'submit';
        var elapsed = Date.now() - PAGE_LOAD_TIME;

        // If external captcha service is configured, route to it
        if (CAPTCHA_SERVICE_URL) {
          return fetch(CAPTCHA_SERVICE_URL + '/' + siteKey + '/' + action, {
            method: 'GET',
            headers: { 'Accept': 'text/plain' }
          })
          .then(function(resp) { return resp.text(); })
          .then(function(token) {
            // Force-set the response field
            var responseEl = document.getElementById('g-recaptcha-response');
            if (responseEl) responseEl.value = token;

            // Override cfg callbacks
            if (window.___grecaptcha_cfg && window.___grecaptcha_cfg.fns) {
              window.___grecaptcha_cfg.fns.forEach(function(fn) {
                try { fn(token); } catch { /* intentional */ }
              });
            }
            return token;
          })
          .catch(function() {
            // Fallback to original on service failure
            return origExecute.call(grecaptcha, siteKey, opts);
          });
        }

        // No service — use delayed execution with behavioural burst
        if (elapsed < MIN_DELAY_MS) {
          // Inject burst of mouse events before execute
          for (var b = 0; b < 5; b++) {
            document.dispatchEvent(new MouseEvent('mousemove', {
              bubbles: true,
              clientX: 200 + Math.floor(Math.random() * 800),
              clientY: 150 + Math.floor(Math.random() * 400)
            }));
          }
          return new Promise(function(resolve, reject) {
            setTimeout(function() {
              origExecute.call(grecaptcha, siteKey, opts).then(resolve).catch(reject);
            }, MIN_DELAY_MS - elapsed);
          });
        }
        return origExecute.call(grecaptcha, siteKey, opts);
      };
      grecaptcha.__patched = true;
    }

    // Retry patching at intervals (recaptcha loads asynchronously)
    patchRecaptcha();
    setTimeout(patchRecaptcha, 500);
    setTimeout(patchRecaptcha, 1500);
    setTimeout(patchRecaptcha, 3000);
    setTimeout(patchRecaptcha, 5000);
    setTimeout(patchRecaptcha, 10000);
  } catch { /* intentional */ }
})();
  `.trim();
}

export function getStorageSandboxScript(_seed: number): string {
  return `
(function() {
  try {
    var prefix = "__" + \${seed} + "_";

    // Sandboxing localStorage
    var origSetItem = Storage.prototype.setItem;
    var origGetItem = Storage.prototype.getItem;
    var origRemoveItem = Storage.prototype.removeItem;
    var origClear = Storage.prototype.clear;
    var origKey = Storage.prototype.key;

    if (origSetItem && origGetItem) {
      Storage.prototype.setItem = new Proxy(origSetItem, {
        apply: function(target, thisArg, args) {
          if (thisArg === window.localStorage) {
            args[0] = prefix + args[0];
          }
          return Reflect.apply(target, thisArg, args);
        }
      });
      Storage.prototype.getItem = new Proxy(origGetItem, {
        apply: function(target, thisArg, args) {
          if (thisArg === window.localStorage) {
            args[0] = prefix + args[0];
          }
          return Reflect.apply(target, thisArg, args);
        }
      });
      Storage.prototype.removeItem = new Proxy(origRemoveItem, {
        apply: function(target, thisArg, args) {
          if (thisArg === window.localStorage) {
            args[0] = prefix + args[0];
          }
          return Reflect.apply(target, thisArg, args);
        }
      });
    }

    // Sandboxing IndexedDB
    if (window.indexedDB && window.indexedDB.open) {
      var idbProto = IDBFactory.prototype;
      if (idbProto && idbProto.open) {
        idbProto.open = new Proxy(idbProto.open, {
          apply: function(target, thisArg, args) {
            if (args[0] && typeof args[0] === 'string') {
              args[0] = prefix + args[0];
            }
            return Reflect.apply(target, thisArg, args);
          }
        });
      }
    }
  } catch { /* intentional */ }
})();
  `.trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// Layer 13: Mobile Device Fingerprint Coherence
// Canonical definitions live in stealth-scripts/mobile-spoofs.ts.
// Re-exported here for backward compatibility.
// ─────────────────────────────────────────────────────────────────────────────

// Re-export for backward compatibility (consumers importing from stealth-scripts.js)
export {
  getMobilePlatformOverrideScript,
  getMobileTouchPointsScript,
  getDesktopTouchPointsScript,
  getMobileOntouchstartScript,
  getMobileOrientationScript,
  getMobileConnectionScript,
  getMobileWebGLRendererScript,
  getMobileVibrateScript,
  getMobileScreenDimensionsScript,
  getMobileBatteryScript,
  getMobilePointerTypeScript,
  emailToSeed, getScreenNoiseScript, getCssMediaQueryCoherenceScript, getDeviceMotionSpoofScript, getDynamicBatterySpoofScript };export { getWebGLSpoofScript } from './scripts/webgl-spoofs.js';
import {
  getWebdriverOverrideScript,
  getAutofillSimulationScript
} from "./scripts/core-overrides.js";

import {
  getBatteryApiSpoofScript,
  getPermissionsApiSpoofScript,
  getSpeechVoicesSpoofScript,
  getAntiVmDetectionScript,
  getIncognitoEvasionScript,
  getDevToolsEvasionScript,
  getNotificationConsistencyScript,
  getScreenConsistencyScript,
  getPerformanceTimingSpoofScript,
  getGamepadsSpoofScript,
  getDeviceOrientationSpoofScript,
  getGeolocationSpoofScript,
  getIndexedDBConsistencyScript,
  getClipboardConsistencyScript,
  getWebUsbSpoofScript,
  getNavigatorConnectionSpoofScript,
  getPerformanceMemorySpoofScript,
  getCSSSupportsSpoofScript,
  getFeaturePolicyScript,
  getCrossOriginIsolationScript
} from "./scripts/api-spoofs.js";

export { getCanvasSpoofScript } from './scripts/canvas-spoofs.js';
export { getBatteryApiSpoofScript, getPermissionsApiSpoofScript, getSpeechVoicesSpoofScript, getAntiVmDetectionScript, getIncognitoEvasionScript, getDevToolsEvasionScript, getNotificationConsistencyScript, getScreenConsistencyScript, getPerformanceTimingSpoofScript, getGamepadsSpoofScript, getDeviceOrientationSpoofScript, getGeolocationSpoofScript, getIndexedDBConsistencyScript, getClipboardConsistencyScript, getWebUsbSpoofScript, getNavigatorConnectionSpoofScript, getPerformanceMemorySpoofScript, getCSSSupportsSpoofScript, getFeaturePolicyScript, getCrossOriginIsolationScript } from "./scripts/api-spoofs.js";
export { getWebdriverOverrideScript, getAutofillSimulationScript, WEBDRIVER_OVERRIDE_SCRIPT, AUTOFILL_SIMULATION_SCRIPT } from "./scripts/core-overrides.js";
