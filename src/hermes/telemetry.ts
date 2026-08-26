/**
 * #11 — Structured Failure Telemetry Feed (TypeScript Port)
 *
 * Provides typed interfaces and a parser for converting raw websocket
 * row-update events into structured failure telemetry records before
 * enqueueing for Hermes analysis.
 *
 * Also includes a per-domain rate-limit tracker.
 *
 * Ported from hermes/telemetry.py
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FailureTelemetry {
  failureType: string;
  consecutiveCount: number;
  lastNOutcomes: string[];
  screenshotPaths: string[];
  recordingPath: string;
  creditsSpent: number;
  backendUsed: string;
  proxyRegion: string;
  timestamp: string;
}

export interface RowUpdateEvent {
  type?: string;
  data?: {
    outcome?: string;
    consecutiveCount?: number;
    screenshots?: string[];
    screenshot?: string;
    recording?: string;
    creditsSpent?: number;
    backend?: string;
    proxyRegion?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * Convert a raw websocket row-update event into a FailureTelemetry record.
 */
export function parseRowUpdate(
  event: RowUpdateEvent,
  recentOutcomes?: string[]
): FailureTelemetry {
  const data = event.data ?? {};
  const outcome = String(data.outcome ?? "");

  // Infer failure_type from outcome prefix
  let failureType: string;
  const outcomeLower = outcome.toLowerCase();
  const prefix = outcome ? (outcome.split("-")[0] || "") : "";

  if (outcomeLower.includes("403") || outcomeLower.includes("waf")) {
    failureType = "waf-block-403";
  } else if (outcomeLower.includes("429") || outcomeLower.includes("rate_limit")) {
    failureType = "rate-limit-429";
  } else if (outcomeLower.includes("428") || outcomeLower.includes("mfa_required")) {
    failureType = "mfa-challenge-428";
  } else if (outcomeLower.includes("redirect_loop") || outcomeLower.includes("bounce")) {
    failureType = "redirect-loop-login";
  } else if (outcomeLower.includes("pin") || outcomeLower.includes("honeypot")) {
    failureType = "honeypot-detected";
  } else {
    switch (prefix) {
      case "blocked":
        failureType = "blocked";
        break;
      case "api":
        failureType = "api-error";
        break;
      case "error":
        failureType = "runtime-error";
        break;
      case "N/A":
        failureType = "not-available";
        break;
      default:
        failureType = "unknown";
        break;
    }
  }

  // Collect screenshot paths from event data if present
  let screenshots: string[] = [];
  if (Array.isArray(data.screenshots)) {
    screenshots = data.screenshots.map(String);
  } else if (data.screenshot) {
    screenshots = [String(data.screenshot)];
  }

  return {
    failureType,
    consecutiveCount: Number(data.consecutiveCount ?? 0),
    lastNOutcomes: recentOutcomes ? [...recentOutcomes] : [],
    screenshotPaths: screenshots,
    recordingPath: String(data.recording ?? ""),
    creditsSpent: Number(data.creditsSpent ?? 0),
    backendUsed: String(data.backend ?? ""),
    proxyRegion: String(data.proxyRegion ?? ""),
    timestamp: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Rate-limit Tracker
// ---------------------------------------------------------------------------

const domainRequests = new Map<string, number[]>();

/**
 * Track requests per target domain.
 * If a domain gets > 50 requests in a minute, returns `RATE_LIMIT_WARNING`.
 */
export function trackRequest(domain: string): string | null {
  const now = Date.now();
  let timestamps = domainRequests.get(domain) ?? [];

  // Keep only timestamps within the last 60 seconds
  timestamps = timestamps.filter((t) => now - t <= 60000);
  timestamps.push(now);
  domainRequests.set(domain, timestamps);

  // Prevent memory leaks for one-off/stale domains
  if (Math.random() < 0.01) {
    for (const [key, times] of domainRequests.entries()) {
      const active = times.filter((t) => now - t <= 60000);
      if (active.length === 0) {
        domainRequests.delete(key);
      } else if (active.length < times.length) {
        domainRequests.set(key, active);
      }
    }
  }

  if (timestamps.length > 50) {
    return "RATE_LIMIT_WARNING";
  }
  return null;
}

/** Reset all rate-limit tracking state. */
export function resetTracking(): void {
  domainRequests.clear();
}
