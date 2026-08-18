import type { BackendProfile } from './types.js';

// ┌─────────────────────────────────────────────────────────────────────────────┐
// │ CLOAKBROWSER (cloak) — Desktop Profiles                                    │
// │                                                                             │
// │ Modified Chromium binary with 50+ C++ source-level patches covering        │
// │ Canvas, WebGL, WebRTC, Audio, Fonts, and GPU fingerprinting.               │
// │                                                                             │
// │ • httpCloak:  ON — TLS/JA3 masking that Chromium doesn't do natively.      │
// │   Defense-in-depth: engine patches + TLS masking = maximum stealth.        │
// │   (Rule 36)                                                                 │
// │ • stealthJS:  ON — Apify fingerprint-injector supplements C++ patches      │
// │   with navigator overrides, permission queries, WebRTC leak prevention.    │
// │   These COMPLEMENT rather than conflict with the C++ patches.              │
// │ • cacheInj:   OFF — addInitScript hooks add detection surface (Rule 38).   │
// │ • nocloak variants: httpCloak disabled at gateway (index.ts), browser      │
// │   binary still has all C++ patches active.                                  │
// └─────────────────────────────────────────────────────────────────────────────┘

export const CLOAK_DESKTOP_PROFILES: Record<string, BackendProfile> = {
  'cloak-headless': {
    useHttpCloak: true,
    stealthBypassHttpCloak: false,
    enableCacheInjection: false,
    injectStealthJS: true,
    fpStrategy: 'optimal',
    osProfile: 'windows',
    emulateMobile: false,
    concurrencyWeight: 1.0,
    recordVideo: true,
    enablePlaywrightTracing: true,
    mutateOnRetry: true,
    cleanSession: true,
  },

  'cloak-headed': {
    useHttpCloak: true,
    stealthBypassHttpCloak: false,
    enableCacheInjection: false,
    injectStealthJS: true,
    fpStrategy: 'optimal',
    osProfile: 'windows',
    emulateMobile: false,
    concurrencyWeight: 0.5,
    recordVideo: true,
    enablePlaywrightTracing: true,
    mutateOnRetry: true,
    cleanSession: true,
  },

  // nocloak = CloakBrowser binary but httpCloak disabled by gateway (index.ts).
  'cloak-headless-nocloak': {
    useHttpCloak: false,
    stealthBypassHttpCloak: false,
    enableCacheInjection: false,
    injectStealthJS: true,
    fpStrategy: 'optimal',
    osProfile: 'windows',
    emulateMobile: false,
    concurrencyWeight: 1.0,
    recordVideo: true,
    enablePlaywrightTracing: true,
    mutateOnRetry: true,
    cleanSession: true,
  },

  'cloak-headed-nocloak': {
    useHttpCloak: false,
    stealthBypassHttpCloak: false,
    enableCacheInjection: false,
    injectStealthJS: true,
    fpStrategy: 'optimal',
    osProfile: 'windows',
    emulateMobile: false,
    concurrencyWeight: 0.5,
    recordVideo: true,
    enablePlaywrightTracing: true,
    mutateOnRetry: true,
    cleanSession: true,
  },
};
