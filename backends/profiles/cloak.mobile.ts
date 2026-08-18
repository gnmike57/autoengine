import type { BackendProfile } from './types.js';
import { CLOAK_DESKTOP_PROFILES } from './cloak.desktop.js';

// ┌─────────────────────────────────────────────────────────────────────────────┐
// │ CLOAKBROWSER (cloak) — Mobile Profiles                                     │
// │                                                                             │
// │ Same engine constraints as desktop, but with mobile emulation:             │
// │ • Android UA + mobile viewport + maxTouchPoints=5                          │
// │ • Lower concurrency weight (mobile sessions are heavier)                   │
// │ • All httpCloak/stealthJS/cacheInjection settings inherited from desktop   │
// └─────────────────────────────────────────────────────────────────────────────┘

function mobilize(desktop: BackendProfile): BackendProfile {
  return {
    ...desktop,
    osProfile: 'android',
    emulateMobile: true,
    concurrencyWeight: desktop.concurrencyWeight * 0.8,
  };
}

export const CLOAK_MOBILE_PROFILES: Record<string, BackendProfile> = {
  'cloak-headless':         mobilize(CLOAK_DESKTOP_PROFILES['cloak-headless']!),
  'cloak-headed':           mobilize(CLOAK_DESKTOP_PROFILES['cloak-headed']!),
  'cloak-headless-nocloak': mobilize(CLOAK_DESKTOP_PROFILES['cloak-headless-nocloak']!),
  'cloak-headed-nocloak':   mobilize(CLOAK_DESKTOP_PROFILES['cloak-headed-nocloak']!),
};
