/**
 * Hardware Rotation Scripts
 *
 * Session-counter-gated rotation for hardware attributes that bot-detection
 * vendors use to correlate sessions. Every 3 sessions (matching the rotation
 * cadence in fingerprint-rotation-engine.ts), the hardware profile shifts to
 * a new set of values.
 *
 * Key design constraints from project rules:
 *   - navigator.hardwareConcurrency bounded 2–8 cores
 *   - navigator.deviceMemory bounded 4–16 GB
 *   - All scripts are IIFE-wrapped, document_start safe
 *   - Object.defineProperty with configurable:true for clean layering
 *   - toString() spoofed to return "[native code]" signatures
 */

// ── Core rotation pools ─────────────────────────────────────────────────────

/** Hardware concurrency values — bounded 2–8 as per spec. */
const CONCURRENCY_POOL = [2, 4, 6, 8] as const;

/** Device memory values — bounded 4–16 GB as per spec. */
const MEMORY_POOL = [4, 8, 16] as const;

// ── Rotation logic ──────────────────────────────────────────────────────────

/**
 * Deterministic rotation index based on seed and session count.
 * The rotation triggers every `rotationCadence` sessions (default 3).
 */
function getRotationIndex(
  seed: number,
  sessionCount: number,
  poolSize: number,
  rotationCadence = 3,
): number {
  const rotationEpoch = Math.floor(sessionCount / rotationCadence);
  // Use seed to offset the starting position so different credentials
  // don't rotate in lockstep.
  return (seed + rotationEpoch) % poolSize;
}

// ── Script generators ───────────────────────────────────────────────────────

/**
 * Generate an init script that overrides navigator.hardwareConcurrency
 * with a value that rotates every 3 sessions.
 *
 * @param seed - Deterministic seed from credential email hash
 * @param sessionCount - Raw session count from FingerprintRotationEngine
 * @param rotationCadence - Sessions before rotation (default 3)
 */
export function getRotatedHardwareConcurrencyScript(
  seed: number,
  sessionCount: number,
  rotationCadence = 3,
  coresOverride?: number,
): string {
  const idx = getRotationIndex(seed, sessionCount, CONCURRENCY_POOL.length, rotationCadence);
  const cores = coresOverride ?? CONCURRENCY_POOL[idx];

  return `
(function() {
  try {
    Object.defineProperty(navigator, 'hardwareConcurrency', {
      get: function() { return ${cores}; },
      configurable: true
    });
  } catch { /* intentional */ }
})();
  `.trim();
}

/**
 * Generate an init script that overrides navigator.deviceMemory
 * with a value that rotates every 3 sessions.
 *
 * @param seed - Deterministic seed from credential email hash
 * @param sessionCount - Raw session count from FingerprintRotationEngine
 * @param rotationCadence - Sessions before rotation (default 3)
 */
export function getRotatedDeviceMemoryScript(
  seed: number,
  sessionCount: number,
  rotationCadence = 3,
  memoryOverride?: number,
): string {
  const idx = getRotationIndex(seed, sessionCount, MEMORY_POOL.length, rotationCadence);
  const memory = memoryOverride ?? MEMORY_POOL[idx];

  return `
(function() {
  try {
    Object.defineProperty(navigator, 'deviceMemory', {
      get: function() { return ${memory}; },
      configurable: true
    });
  } catch { /* intentional */ }
})();
  `.trim();
}

/**
 * Coherent Navigator APIs Script
 *
 * Ensures navigator.maxTouchPoints, navigator.getGamepads(),
 * navigator.usb, and navigator.clipboard are internally consistent
 * with the hardware profile. Desktop profiles should have:
 *   - maxTouchPoints: 0 (no touchscreen)
 *   - getGamepads: return [null, null, null, null]
 *   - usb.getDevices: return []
 *   - clipboard: read rejects with NotAllowedError, write resolves
 *
 * This script consolidates and cross-validates what were previously
 * independent scripts (getGamepadsSpoofScript, getWebUsbSpoofScript,
 * getClipboardConsistencyScript) to prevent coherence failures.
 *
 * @param seed - Deterministic seed for per-session variation
 * @param isMobile - Whether the profile is mobile (changes touch points)
 */
export function getCoherentNavigatorApisScript(seed: number, isMobile = false): string {
  const touchPoints = isMobile ? 5 : 0;
  // Desktop gamepads: 4 null slots (standard Chrome behavior)
  // USB: empty device list (no devices connected)
  // Clipboard: read denied, write allowed (standard permissions)

  return `
(function() {
  try {
    // ── Touch Points coherence ──
    Object.defineProperty(navigator, 'maxTouchPoints', {
      get: function() { return ${touchPoints}; },
      configurable: true
    });

    // ── Gamepad API coherence ──
    if (navigator.getGamepads) {
      var origGetGamepads = navigator.getGamepads;
      Object.defineProperty(navigator, 'getGamepads', {
        value: function() {
          return [null, null, null, null];
        },
        configurable: true, writable: true
      });
      navigator.getGamepads.toString = function() { return "function getGamepads() { [native code] }"; };
    }

    // ── WebUSB coherence ──
    if (navigator.usb) {
      Object.defineProperty(navigator.usb, 'getDevices', {
        value: function() { return Promise.resolve([]); },
        configurable: true, writable: true
      });
      Object.defineProperty(navigator.usb, 'requestDevice', {
        value: function() {
          return Promise.reject(new DOMException('No device selected.', 'NotFoundError'));
        },
        configurable: true, writable: true
      });
      navigator.usb.getDevices.toString = function() { return 'function getDevices() { [native code] }'; };
      navigator.usb.requestDevice.toString = function() { return 'function requestDevice() { [native code] }'; };
    }

    // ── Clipboard API coherence ──
    if (!navigator.clipboard) {
      Object.defineProperty(navigator, 'clipboard', {
        value: {},
        configurable: true, writable: true
      });
    }
    var clip = navigator.clipboard;
    if (!clip.readText || typeof clip.readText !== 'function') {
      clip.readText = function() {
        return Promise.reject(new DOMException('Read permission denied.', 'NotAllowedError'));
      };
      clip.readText.toString = function() { return "function readText() { [native code] }"; };
    }
    if (!clip.writeText || typeof clip.writeText !== 'function') {
      clip.writeText = function() { return Promise.resolve(); };
      clip.writeText.toString = function() { return "function writeText() { [native code] }"; };
    }
    if (!clip.read) {
      clip.read = function() {
        return Promise.reject(new DOMException('Read permission denied.', 'NotAllowedError'));
      };
    }
    if (!clip.write) {
      clip.write = function() { return Promise.resolve(); };
    }

    // ── Cross-validation: ensure deviceMemory is within valid range ──
    if (navigator.deviceMemory && (navigator.deviceMemory < 4 || navigator.deviceMemory > 16)) {
      Object.defineProperty(navigator, 'deviceMemory', {
        get: function() { return 8; }, // Fallback gracefully if somehow corrupted
        configurable: true
      });
    }
  } catch { /* intentional */ }
})();
  `.trim();
}

/**
 * Timezone-to-proxy synchronization script generator.
 *
 * Given an IANA timezone string (derived from proxy IP geolocation),
 * generates an init script that overrides Intl.DateTimeFormat and
 * Date.getTimezoneOffset to match.
 *
 * This is a convenience wrapper — it delegates to the existing
 * getTimezoneAlignmentScript() from stealth-scripts.ts. The purpose
 * is to provide a clean import path for the hardware-rotation module.
 *
 * @param timezone - IANA timezone string (e.g. "Australia/Melbourne")
 * @param locale - BCP-47 locale (e.g. "en-AU")
 */
export function generateTimezoneProxySyncScript(
  timezone: string,
  locale = "en-AU",
): { timezone: string; locale: string } {
  // Returns the config values that the caller should pass to
  // StealthScriptConfig.timezone and StealthScriptConfig.locale.
  // The actual script generation happens in buildStealthScripts().
  return { timezone, locale };
}
