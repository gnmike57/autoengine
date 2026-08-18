/**
 * BackendProfile — per-backend optimal configuration.
 *
 * These are architectural constraints determined by the browser engine,
 * NOT user preferences. They cannot be overridden from the dashboard.
 *
 * See rules: 32 (per-backend authoritative), 33 (camoufox no httpcloak),
 * 34 (camoufox no stealth JS), 36 (cloakbrowser defense-in-depth),
 * 37 (zendriver mandatory httpcloak), 38 (cache injection disabled),
 * 39 (no frankenstein fingerprints), 40 (TLS-UA consistency).
 */
export interface BackendProfile {
  // ── Network / TLS layer ──
  useHttpCloak: boolean;
  stealthBypassHttpCloak: boolean;

  // ── Fingerprint injection layer ──
  enableCacheInjection: boolean;
  injectStealthJS: boolean;
  fpStrategy: string;

  // ── Platform identity ──
  osProfile: string;            // "windows" | "macos" | "linux" | "android" | "ios"
  emulateMobile: boolean;       // true → mobile UA + viewport + touch

  // ── Concurrency ──
  concurrencyWeight: number;    // 1.0 = full slot, 0.5 = half (headed uses more resources)

  // ── Session behavior ──
  recordVideo: boolean;
  enablePlaywrightTracing: boolean;
  mutateOnRetry: boolean;
  cleanSession: boolean;
}

/**
 * Type for the merged settings map used by resolveBackendSettings().
 * Uses Record<string, any> to avoid type conflicts between BackendProfile.fpStrategy (string)
 * and EngineConfig.fpStrategy (FpStrategy union). The actual type safety is enforced
 * by the individual profile files which use the strict BackendProfile interface.
 */
export type BackendSettingsMap = Record<string, Record<string, any>>;
