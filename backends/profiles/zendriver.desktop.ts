import type { BackendProfile } from './types.js';

// ┌─────────────────────────────────────────────────────────────────────────────┐
// │ ZENDRIVER — Desktop Profiles                                                │
// │                                                                             │
// │ Raw Chromium via Python/CDP (nodriver/zendriver launcher).                  │
// │ Zero C++ source patches — ALL stealth comes from JS injection + TLS mask.  │
// │                                                                             │
// │ • httpCloak:  ON — CRITICAL. Without it, the default Chromium TLS          │
// │   handshake (JA3/JA4 signature) is trivially identifiable before a single  │
// │   byte of page content loads (Rule 37).                                     │
// │ • stealthJS:  ON — fingerprint-injector JS is the PRIMARY and ONLY        │
// │   anti-detect layer. Handles CDP trace removal and all browser-level       │
// │   fingerprint spoofing (Rule 37).                                           │
// │ • cacheInj:   OFF — addInitScript hooks add detection surface (Rule 38).   │
// └─────────────────────────────────────────────────────────────────────────────┘

export const ZENDRIVER_DESKTOP_PROFILES: Record<string, BackendProfile> = {
  'zendriver': {
    useHttpCloak: true,
    stealthBypassHttpCloak: false,
    enableCacheInjection: false,
    injectStealthJS: true,
    fpStrategy: 'optimal',
    osProfile: 'windows',
    emulateMobile: false,
    concurrencyWeight: 0.8,
    recordVideo: true,
    enablePlaywrightTracing: true,
    mutateOnRetry: true,
    cleanSession: true,
  },

  'zendriver-headed': {
    useHttpCloak: true,
    stealthBypassHttpCloak: false,
    enableCacheInjection: false,
    injectStealthJS: true,
    fpStrategy: 'optimal',
    osProfile: 'windows',
    emulateMobile: false,
    concurrencyWeight: 0.4,
    recordVideo: true,
    enablePlaywrightTracing: true,
    mutateOnRetry: true,
    cleanSession: true,
  },
};
