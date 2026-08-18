/**
 * backends/profiles/index.ts — Unified backend profile resolution.
 *
 * This module is the SINGLE SOURCE OF TRUTH for per-backend optimal settings.
 * It merges all per-backend/per-mode profile files into the authoritative
 * BACKEND_OPTIMAL_SETTINGS map and exports resolveBackendSettings().
 *
 * Architecture:
 *   stealth.desktop.ts  ─┐
 *   stealth.mobile.ts   ─┤
 *   cloak.desktop.ts    ─┤──▶ BACKEND_OPTIMAL_SETTINGS (merged desktop map)
 *   cloak.mobile.ts     ─┤──▶ BACKEND_MOBILE_SETTINGS  (merged mobile map)
 *   zendriver.desktop.ts─┤
 *   zendriver.mobile.ts ─┘
 *
 * Rules enforced: 32 (per-backend authoritative), 33 (camoufox no httpcloak),
 * 34 (camoufox no stealth JS), 36 (cloakbrowser defense-in-depth),
 * 37 (zendriver mandatory httpcloak), 38 (cache injection disabled),
 * 39 (no frankenstein fingerprints), 40 (TLS-UA consistency).
 */

import type { BackendProfile, BackendSettingsMap } from './types.js';
import type { EngineConfig } from '../../src/core/engine.js';

// ── Desktop profiles ──
import { STEALTH_DESKTOP_PROFILES } from './stealth.desktop.js';
import { CLOAK_DESKTOP_PROFILES } from './cloak.desktop.js';
import { ZENDRIVER_DESKTOP_PROFILES } from './zendriver.desktop.js';

// ── Mobile profiles ──
import { STEALTH_MOBILE_PROFILES } from './stealth.mobile.js';
import { CLOAK_MOBILE_PROFILES } from './cloak.mobile.js';
import { ZENDRIVER_MOBILE_PROFILES } from './zendriver.mobile.js';

// Re-export types
export type { BackendProfile, BackendSettingsMap } from './types.js';

// Re-export individual profile maps for direct access
export { STEALTH_DESKTOP_PROFILES } from './stealth.desktop.js';
export { STEALTH_MOBILE_PROFILES } from './stealth.mobile.js';
export { CLOAK_DESKTOP_PROFILES } from './cloak.desktop.js';
export { CLOAK_MOBILE_PROFILES } from './cloak.mobile.js';
export { ZENDRIVER_DESKTOP_PROFILES } from './zendriver.desktop.js';
export { ZENDRIVER_MOBILE_PROFILES } from './zendriver.mobile.js';

/**
 * BACKEND_OPTIMAL_SETTINGS — The merged desktop settings map.
 * This is the backward-compatible export used by engine.ts, server.ts, and tests.
 */
export const BACKEND_OPTIMAL_SETTINGS: BackendSettingsMap = {
  ...STEALTH_DESKTOP_PROFILES,
  ...CLOAK_DESKTOP_PROFILES,
  ...ZENDRIVER_DESKTOP_PROFILES,
};

/**
 * BACKEND_MOBILE_SETTINGS — The merged mobile settings map.
 * Used when advEmulateMobile is true or the engine is in mobile mode.
 */
export const BACKEND_MOBILE_SETTINGS: BackendSettingsMap = {
  ...STEALTH_MOBILE_PROFILES,
  ...CLOAK_MOBILE_PROFILES,
  ...ZENDRIVER_MOBILE_PROFILES,
};

/**
 * Get the profile for a backend, auto-selecting desktop or mobile.
 */
export function getBackendProfile(backendName: string, isMobile: boolean = false): Partial<BackendProfile> {
  const map = isMobile ? BACKEND_MOBILE_SETTINGS : BACKEND_OPTIMAL_SETTINGS;
  return map[backendName] || {};
}

/**
 * List all known backend names (desktop profiles).
 */
export function getAllBackendNames(): string[] {
  return Object.keys(BACKEND_OPTIMAL_SETTINGS);
}

// ── ExperimentalConfig type (subset used for overrides) ──
interface ExperimentalConfig {
  enableCacheInjection?: boolean;
  fpStrategy?: string;
  [key: string]: any;
}

/**
 * Resolve the effective settings for a backend by layering:
 *   1. BACKEND_OPTIMAL_SETTINGS (AUTHORITATIVE — these are architectural constraints)
 *   2. ExperimentalConfig overrides (per-backend in Darwin/rotation modes)
 *   3. Global EngineConfig (fallback for settings NOT defined in the optimal matrix)
 *
 * Per-backend optimal settings WIN over global config because they represent
 * browser engine constraints, not user preferences:
 *   - Camoufox must NEVER use httpCloak (SOCKS5 auth hangs — Rule 33)
 *   - Camoufox must NEVER use injectStealthJS (conflicts with Juggler)
 *   - CloakBrowser SHOULD use httpCloak (TLS masking for Chromium)
 * These are not overridable from the dashboard.
 */
export function resolveBackendSettings(
  backendName: string,
  config: EngineConfig,
  expConfig?: ExperimentalConfig,
  autoOptimize: boolean = true,
  isMobile: boolean = false,
): {
  useHttpCloak: boolean;
  stealthBypassHttpCloak: boolean;
  enableCacheInjection: boolean;
  injectStealthJS: boolean;
  fpStrategy: string;
  // ── Extended per-backend settings (only applied when autoOptimize=true) ──
  osProfile: string | undefined;
  emulateMobile: boolean;
  concurrencyWeight: number;
  recordVideo: boolean | undefined;
  mutateOnRetry: boolean | undefined;
  cleanSession: boolean | undefined;
} {
  const optimal = getBackendProfile(backendName, isMobile);

  // Stealth/httpCloak/cacheInjection settings are ALWAYS authoritative (architectural constraints).
  // Extended settings (osProfile, concurrencyWeight, etc.) only apply when autoOptimize=true.
  return {
    // ── Architectural constraints (always authoritative) ──
    useHttpCloak:            optimal.useHttpCloak            ?? config.useHttpCloak ?? false,
    stealthBypassHttpCloak:  optimal.stealthBypassHttpCloak  ?? config.stealthBypassHttpCloak ?? false,
    enableCacheInjection:    expConfig?.enableCacheInjection ?? optimal.enableCacheInjection ?? config.enableCacheInjection ?? false,
    injectStealthJS:         optimal.injectStealthJS         ?? config.injectStealthJS ?? true,
    
    // ── Fingerprint Strategy Resolution ──
    // Only 3 strategies exist: optimal, native-only, full-stealth
    // All legacy values normalize to "optimal" which auto-selects per-backend tier
    fpStrategy: (() => {
       const base = expConfig?.fpStrategy ?? config.fpStrategy ?? "optimal";
       // Normalize ALL legacy aliases to 'optimal'
       const LEGACY_TO_OPTIMAL = new Set(["fp-auto", "fp-camoufox", "fp-cloak", "fp-zendriver", "fp-fb-optimized", "none", "apify"]);
       if (LEGACY_TO_OPTIMAL.has(base)) return "optimal";
       // Only 3 valid values: optimal, native-only, full-stealth
       if (base === "native-only" || base === "full-stealth") return base;
       return "optimal";
    })(),

    // ── Extended per-backend settings (autoOptimize gate) ──
    osProfile:            autoOptimize ? optimal.osProfile                             : undefined,
    emulateMobile:        autoOptimize ? (optimal.emulateMobile ?? false)              : false,
    concurrencyWeight:    autoOptimize ? (optimal.concurrencyWeight ?? 1.0)            : 1.0,
    recordVideo:          autoOptimize ? (optimal.recordVideo ?? config.recordVideo)   : undefined,
    mutateOnRetry:        autoOptimize ? (optimal.mutateOnRetry ?? config.mutateOnRetry) : undefined,
    cleanSession:         autoOptimize ? (optimal.cleanSession ?? config.cleanSession) : undefined,
  };
}
