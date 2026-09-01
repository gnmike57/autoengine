/**
 * Pure pool decision helpers extracted from cloak-backend so they can be
 * unit-tested without standing up a real browser launch. Two pieces:
 *
 *  - evaluateReuse(): given the pooled slot's state and the caller's request,
 *    return an "allow / deny + reasons" decision. The headed and headless
 *    paths in cloak-backend.ts both used to inline this logic with slightly
 *    different orderings; centralising guarantees the reason strings stay in
 *    a stable, audit-friendly order ("quarantined" → "proxyKey" →
 *    "cacheInjection" → "recordVideo").
 *
 *  - QuarantineSet: a tiny Set<K> wrapper that records profileMetrics on
 *    transitions so callers can't forget the metric. add() is idempotent for
 *    the metric — re-quarantining a key that's already quarantined does NOT
 *    double-count.
 */
import { profileMetrics } from "../profiles/profile-metrics.js";

/**
 * Locally typed mirror of cloak-backend's CacheInjectionState. Kept here to
 * avoid importing from cloak-backend (which would create a load-order cycle
 * because cloak-backend constructs QuarantineSet at module init).
 */
export interface CacheInjectionState {
  enabled: boolean;
  profileKey?: string;
}

function isCacheInjectionStateCompatible(
  existing: CacheInjectionState | undefined,
  requested: CacheInjectionState,
): boolean {
  return !!existing && existing.enabled === requested.enabled && existing.profileKey === requested.profileKey;
}

export interface ReuseInputs {
  /** Sticky-session key of the proxy the pooled context was launched with. */
  existingProxyKey: string | undefined;
  /** Sticky-session key the current caller wants. */
  requestedProxyKey: string | undefined;
  /** Cache-injection state captured when the pooled context was created. */
  existingCacheInjectionState: CacheInjectionState | undefined;
  /** Cache-injection state the current caller wants. */
  requestedCacheInjectionState: CacheInjectionState;
  /** True when the slot is currently quarantined for failed sanitization. */
  quarantined?: boolean;
  /**
   * Optional: when the caller's recordVideo flag disagrees with the pooled
   * context's launch-time recordVideo flag, reuse is denied. Headed-only —
   * the headless pool never enables recordVideo on reused contexts.
   */
  recordVideoMismatch?: boolean;
}

export interface ReuseDecision {
  allowed: boolean;
  reasons: string[];
}

const ALLOWED_DECISION: ReuseDecision = { allowed: true, reasons: [] };

/**
 * Evaluate whether a pooled context may be reused. Pure — no IO, no side
 * effects. Reason order is fixed so log/metrics consumers can rely on it.
 */
export function evaluateReuse(inputs: ReuseInputs): ReuseDecision {
  const reasons: string[] = [];
  if (inputs.quarantined) reasons.push("quarantined");
  if (inputs.existingProxyKey !== inputs.requestedProxyKey) reasons.push("proxyKey");
  if (!isCacheInjectionStateCompatible(inputs.existingCacheInjectionState, inputs.requestedCacheInjectionState)) {
    reasons.push("cacheInjection");
  }
  if (inputs.recordVideoMismatch) reasons.push("recordVideo");
  if (reasons.length === 0) return ALLOWED_DECISION;
  return { allowed: false, reasons };
}

/**
 * Encapsulates the "this key's last sanitization failed, refuse reuse until
 * a fresh launch rebinds it" pattern. Wraps a Set<K> plus the metrics calls
 * so callers can't accidentally forget recordQuarantined() or leave the
 * counter out of sync with the set.
 */
export class QuarantineSet<K> {
  private readonly map = new Map<K, number>();
  private readonly ttlMs: number;

  constructor(ttlMs: number = 10 * 60 * 1000) {
    this.ttlMs = ttlMs;
  }

  has(key: K): boolean {
    const timestamp = this.map.get(key);
    if (!timestamp) return false;
    if (Date.now() - timestamp > this.ttlMs) {
      this.map.delete(key);
      return false;
    }
    return true;
  }

  /**
   * Mark a key as quarantined. Records profileMetrics.recordQuarantined() iff
   * this call actually transitions the key from "not quarantined" to
   * "quarantined" — re-adding an already-quarantined key is a no-op.
   * Returns true when the metric was recorded.
   */
  add(key: K): boolean {
    const isAlreadyQuarantined = this.has(key);
    this.map.set(key, Date.now());
    if (isAlreadyQuarantined) return false;
    profileMetrics.recordQuarantined();
    return true;
  }

  /** Remove a key from quarantine (e.g. after a fresh launch). Idempotent. */
  clear(key: K): void {
    this.map.delete(key);
  }

  size(): number {
    // Evict expired before calculating size
    const now = Date.now();
    for (const [key, timestamp] of this.map.entries()) {
      if (now - timestamp > this.ttlMs) {
        this.map.delete(key);
      }
    }
    return this.map.size;
  }

  /**
   * Convenience: inspect a sanitization result and quarantine the key when
   * the result reported any errors. Returns true when the key was newly
   * quarantined.
   */
  recordSanitizeResult(key: K, errorCount: number): boolean {
    profileMetrics.recordSanitized(errorCount);
    if (errorCount > 0) return this.add(key);
    return false;
  }
}
