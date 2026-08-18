/**
 * Profile-quality counters for the cloak-backend pool and sanitization
 * pipeline. These are counters/gauges, not timers — they answer "how often
 * are we reusing vs. launching fresh, and how often is sanitization or
 * validation falling over?" which the manager-metrics module doesn't cover.
 *
 * Deliberately small and dependency-free so any module (cloak-backend,
 * context-sanitizer, profile-validator) can import it without dragging in
 * EventEmitter or the manager subsystem.
 */

export interface ProfileMetricsSnapshot {
  reuseAllowed: number;
  reuseDenied: number;
  reuseDeniedReasons: Record<string, number>;
  cleanCreated: number;
  sanitizedOk: number;
  sanitizedWithErrors: number;
  quarantined: number;
  validationFailed: number;
  cacheSeeded: number;
  cacheSanitized: number;
}

const state: ProfileMetricsSnapshot = {
  reuseAllowed: 0,
  reuseDenied: 0,
  reuseDeniedReasons: {},
  cleanCreated: 0,
  sanitizedOk: 0,
  sanitizedWithErrors: 0,
  quarantined: 0,
  validationFailed: 0,
  cacheSeeded: 0,
  cacheSanitized: 0,
};

export const profileMetrics = {
  recordReuseAllowed(): void { state.reuseAllowed++; },

  recordReuseDenied(reasons: string[]): void {
    state.reuseDenied++;
    for (const r of reasons) {
      state.reuseDeniedReasons[r] = (state.reuseDeniedReasons[r] ?? 0) + 1;
    }
  },

  recordCleanCreated(): void { state.cleanCreated++; },

  recordSanitized(errorCount: number): void {
    if (errorCount > 0) state.sanitizedWithErrors++;
    else state.sanitizedOk++;
  },

  recordQuarantined(): void { state.quarantined++; },

  recordValidationFailed(): void { state.validationFailed++; },

  recordCacheSeeded(): void { state.cacheSeeded++; },

  recordCacheSanitized(): void { state.cacheSanitized++; },

  snapshot(): ProfileMetricsSnapshot {
    return {
      ...state,
      reuseDeniedReasons: { ...state.reuseDeniedReasons },
    };
  },

  reset(): void {
    state.reuseAllowed = 0;
    state.reuseDenied = 0;
    state.reuseDeniedReasons = {};
    state.cleanCreated = 0;
    state.sanitizedOk = 0;
    state.sanitizedWithErrors = 0;
    state.quarantined = 0;
    state.validationFailed = 0;
    state.cacheSeeded = 0;
    state.cacheSanitized = 0;
  },
};
