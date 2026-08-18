/**
 * #19 — Hermes Credential Triage (TypeScript Port)
 *
 * Classifies a failure event into one of five categories and maps each
 * to a remediation strategy string the agent can act on.
 *
 * Ported from hermes/triage.py
 */

// ---------------------------------------------------------------------------
// Failure categories and their remediation strategies
// ---------------------------------------------------------------------------

export type TriageCategory =
  | "infrastructure"
  | "site_change"
  | "credential_invalid"
  | "rate_limited"
  | "toxic_anomaly"
  | "unknown";

const REMEDIATION: Record<TriageCategory, string> = {
  infrastructure:
    "Rotate proxy or tunnel endpoint. Check VPN status and retry with " +
    "a different proxy_region. Verify that the backend service is reachable.",
  site_change:
    "DOM structure has likely changed. Inspect the latest Markdown dump " +
    "and screenshot, then update Playwright selectors in engine.ts.",
  credential_invalid:
    "Credential is permanently invalid (disabled/noaccount). Mark as " +
    "tested-bad and dequeue. Do NOT retry.",
  rate_limited:
    "Too many attempts detected. Back off for 5-10 minutes, rotate IP, " +
    "and reduce concurrency before retrying.",
  toxic_anomaly:
    "Toxic context detected (WAF block, 2FA, honeypot). Permanently poison context, " +
    "rotate proxy, and throttle worker to 1 active slot.",
  unknown:
    "Failure could not be categorised. Collect screenshots and logs, " +
    "escalate to the full diagnostic pipeline.",
};

// ---------------------------------------------------------------------------
// Pattern sets (case-insensitive)
// ---------------------------------------------------------------------------

const INFRA_PATTERNS: RegExp[] = [
  /proxy/i,
  /tunnel/i,
  /ECONNREFUSED/i,
  /ETIMEDOUT/i,
  /socket hang up/i,
  /network\s*error/i,
  /ERR_CONNECTION/i,
  /502|503|504/i,
  /crash/i,
];

const TOXIC_PATTERNS: RegExp[] = [
  /blocked/i,
  /403/i,
  /honeypot/i,
  /2fa/i,
  /mfa_required/i,
];

const SITE_CHANGE_PATTERNS: RegExp[] = [
  /selector/i,
  /locator/i,
  /DOM/i,
  /element not found/i,
  /timeout waiting/i,
  /page\s*changed/i,
  /unexpected\s*(modal|dialog|popup)/i,
];

const CRED_INVALID_PATTERNS: RegExp[] = [
  /noaccount/i,
  /permanently/i,
  /\bdisabled\b/i,
  /invalid.*credential/i,
  /account.*not.*found/i,
  /deactivated/i,
];

const RATE_LIMIT_PATTERNS: RegExp[] = [
  /rate.?limit/i,
  /too many (attempts|requests)/i,
  /429/i,
  /throttl/i,
  /captcha/i,
  /temporarily_disabled/i,
  /tempdisabled/i,
];

function matches(text: string, patterns: RegExp[]): boolean {
  return patterns.some((rx) => rx.test(text));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface TriageEvent {
  data?: {
    outcome?: string;
    error?: string;
    message?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/**
 * Classify a failure event into a triage category.
 *
 * Returns one of: `infrastructure`, `site_change`, `credential_invalid`,
 * `rate_limited`, `unknown`.
 */
export function classifyFailure(event: TriageEvent): TriageCategory {
  const data = event.data ?? {};
  const outcome = String(data.outcome ?? "");
  const error = String(data.error ?? "");
  const message = String(data.message ?? "");
  const blob = `${outcome} ${error} ${message}`;

  // Rate limiting is checked before toxic to avoid false positives
  // (e.g., outcome="blocked" with error="rate limit" should be rate_limited, not toxic)
  if (matches(blob, RATE_LIMIT_PATTERNS)) return "rate_limited";
  if (matches(blob, INFRA_PATTERNS)) return "infrastructure";
  if (matches(blob, TOXIC_PATTERNS)) return "toxic_anomaly";
  if (matches(blob, CRED_INVALID_PATTERNS)) return "credential_invalid";
  if (matches(blob, SITE_CHANGE_PATTERNS)) return "site_change";
  return "unknown";
}

/** Return the remediation strategy string for a triage category. */
export function getRemediation(category: TriageCategory): string {
  return REMEDIATION[category] ?? REMEDIATION.unknown;
}

/**
 * Group similar error strings together based on word-overlap (Jaccard similarity).
 */
export function clusterErrors(errors: string[]): Map<string, string[]> {
  const clusters = new Map<string, string[]>();
  const clusterReps = new Map<string, Set<string>>();

  function getWords(text: string): Set<string> {
    return new Set(text.toLowerCase().match(/\w+/g) ?? []);
  }

  for (const error of errors) {
    const words = getWords(error);
    let matchedCluster: string | null = null;

    for (const [clusterRep, repWords] of clusterReps.entries()) {
      const union = new Set([...words, ...repWords]);
      if (union.size === 0) {
        if (words.size === 0) {
          matchedCluster = clusterRep;
          break;
        }
        continue;
      }
      const intersection = new Set([...words].filter((w) => repWords.has(w)));
      const jaccard = intersection.size / union.size;
      if (jaccard > 0.5) {
        matchedCluster = clusterRep;
        break;
      }
    }

    if (matchedCluster !== null) {
      clusters.get(matchedCluster)!.push(error);
    } else {
      clusters.set(error, [error]);
      clusterReps.set(error, words);
    }
  }

  return clusters;
}
