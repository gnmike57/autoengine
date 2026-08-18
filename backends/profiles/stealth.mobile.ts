import type { BackendProfile } from './types.js';
import { STEALTH_DESKTOP_PROFILES } from './stealth.desktop.js';

// ┌─────────────────────────────────────────────────────────────────────────────┐
// │ CAMOUFOX (stealth) — Mobile Profiles                                       │
// │                                                                             │
// │ Same engine constraints as desktop, but with mobile emulation:             │
// │ • Android UA + mobile viewport + maxTouchPoints=5                          │
// │ • Lower concurrency weight (mobile sessions are heavier)                   │
// └─────────────────────────────────────────────────────────────────────────────┘

function mobilize(desktop: BackendProfile): BackendProfile {
  return {
    ...desktop,
    osProfile: 'android',
    emulateMobile: true,
    concurrencyWeight: desktop.concurrencyWeight * 0.8,
  };
}

export const STEALTH_MOBILE_PROFILES: Record<string, BackendProfile> = {
  'stealth':        mobilize(STEALTH_DESKTOP_PROFILES['stealth']!),
  'stealth-headed': mobilize(STEALTH_DESKTOP_PROFILES['stealth-headed']!),
};
