import type { BackendProfile } from './types.js';
import { ZENDRIVER_DESKTOP_PROFILES } from './zendriver.desktop.js';

// ┌─────────────────────────────────────────────────────────────────────────────┐
// │ ZENDRIVER — Mobile Profiles                                                 │
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

export const ZENDRIVER_MOBILE_PROFILES: Record<string, BackendProfile> = {
  'zendriver':        mobilize(ZENDRIVER_DESKTOP_PROFILES['zendriver']!),
  'zendriver-headed': mobilize(ZENDRIVER_DESKTOP_PROFILES['zendriver-headed']!),
};
