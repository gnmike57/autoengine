import type { BackendProfile } from './types.js';

// ┌─────────────────────────────────────────────────────────────────────────────┐
// │ CAMOUFOX (stealth) — Desktop Profiles                                      │
// │                                                                             │
// │ Modified Firefox binary with C++ engine-level anti-fingerprint patches.     │
// │ Canvas, WebGL, Audio, Navigator, Fonts all spoofed at the C++ layer.       │
// │                                                                             │
// │ • httpCloak:  BYPASS — Camoufox has SOCKS5 auth hangs with httpCloak       │
// │   (Rule 33). The basic proxyForwarder is proven stable.                    │
// │ • stealthJS:  OFF — JS overrides conflict with Juggler context (Rule 34). │
// │ • cacheInj:   OFF — addInitScript hooks detectable (Rule 38).             │
// │ • geoip:      Manual via alignGeoToProxy (Rule 35).                        │
// └─────────────────────────────────────────────────────────────────────────────┘

export const STEALTH_DESKTOP_PROFILES: Record<string, BackendProfile> = {
  'stealth': {
    useHttpCloak: false,
    stealthBypassHttpCloak: true,
    enableCacheInjection: false,
    injectStealthJS: false,
    fpStrategy: 'native-only',
    osProfile: 'windows',
    emulateMobile: false,
    concurrencyWeight: 1.0,
    recordVideo: true,
    mutateOnRetry: true,
    cleanSession: true,
  },

  'stealth-headed': {
    useHttpCloak: false,
    stealthBypassHttpCloak: true,
    enableCacheInjection: false,
    injectStealthJS: false,
    fpStrategy: 'native-only',
    osProfile: 'windows',
    emulateMobile: false,
    concurrencyWeight: 0.5,
    recordVideo: true,
    mutateOnRetry: true,
    cleanSession: true,
  },
};
