/**
 * Centralised timing constants for the automation engine.
 *
 * Previously these magic numbers were scattered across engine.ts (30+ inline
 * sleep / setTimeout / timeout literals). Pulling them into one file makes
 * tuning a single tweak instead of a hunt-and-replace.
 *
 * All values are in milliseconds unless noted otherwise.
 */

export const Timings = {
  // ── Cookie / consent banner handling ──────────────────────────────────
  /** How long to poll for site-specific cookie selectors (calibrated). */
  COOKIE_CALIBRATED_POLL_BUDGET: 1000,
  /** Visibility check timeout per cookie candidate. */
  COOKIE_VISIBLE_CHECK: 50,
  /** Click timeout for the matched cookie button. */
  COOKIE_CLICK_TIMEOUT: 1000,
  /** Wait for the banner to disappear from layout after click. */
  COOKIE_DISAPPEAR_TIMEOUT: 2000,
  /** Settle buffer after dismissal so CSS fade-outs complete and pointer-events release.
   *  Reduced from 200ms → CookieGuard now verifies via elementFromPoint. */
  COOKIE_POST_DISMISS_SETTLE: 100,

  // ── Page navigation ───────────────────────────────────────────────────
  /** Hard timeout for page.goto. Blueprint mandates 30s for domcontentloaded. */
  GOTO_TIMEOUT: 30000,
  /** Number of retry attempts on transient goto errors. */
  GOTO_RETRY_ATTEMPTS: 2,
  /** Base backoff between goto retries (doubled each attempt). */
  GOTO_RETRY_BASE: 1000,

  // ── Login flow ────────────────────────────────────────────────────────
  /** Idle wait before sampling submit-button baseline (let hover style detach).
   *  Reduced from 10ms — hover detach is near-instant. */
  SUBMIT_IDLE_PRESAMPLE: 5,
  /** Composite "is truly idle" gate timeout per attempt. */
  SUBMIT_READY_GATE_TIMEOUT: 1000,
  /** Polling interval inside the submit-ready gate. */
  SUBMIT_READY_GATE_POLL: 20,
  /** Wait for networkidle after a submit attempt. */
  POST_SUBMIT_NETWORKIDLE_TIMEOUT: 1000,
  /** Settle sleep after networkidle (DOM stability buffer).
   *  Reduced from 20ms — SubmitTracker now provides event-driven readiness. */
  POST_SUBMIT_DOM_SETTLE: 10,
  /** How long to wait after click before starting the response race.
   *  Reduced from 20ms — the fast race starts almost immediately. */
  POST_CLICK_RACE_DELAY: 10,
  /** Fast-poll race window for ui/network detection. */
  FAST_RACE_WINDOW: 2000,
  /** Polling cadence inside the fast race. */
  FAST_RACE_POLL: 20,
  /** Slow fallback DOM-scan timeout for the LAST attempt only. */
  RESPONSE_TIMEOUT_LAST_ATTEMPT: 2000,
  /** Blueprint ACT I Sequence 6: API race max wait (15s per blueprint). */
  RESPONSE_TIMEOUT_DEFAULT: 15000,
  /** Pause between failed attempts so the form has time to reset.
   *  Reduced from 200ms — SubmitTracker's waitUntilReady() + 500ms buffer covers this. */
  INTER_ATTEMPT_PAUSE: 100,

  // ── Input / typing ────────────────────────────────────────────────────
  /** Per-keystroke delay in fast-human mode. */
  KEYSTROKE_DELAY_FAST: 5,
  /** Per-keystroke delay in normal speed mode. */
  KEYSTROKE_DELAY_NORMAL: 2,
  /** Click-down delay on submit button in normal speed mode (random ±). */
  SUBMIT_CLICK_DELAY_NORMAL_BASE: 2,
  /** Random jitter added to submit click in normal mode. */
  SUBMIT_CLICK_DELAY_NORMAL_JITTER: 2,

  // ── Concurrency / staggering ──────────────────────────────────────────
  /** Per-slot stagger between session creations. */
  SESSION_STAGGER_BASE: 500,
  /** Cleanup stale BB sessions overall budget. */
  STALE_SESSION_CLEANUP_TIMEOUT: 15000,
  /** Brief settle after issuing REQUEST_RELEASE on stale BB sessions. */
  STALE_SESSION_RELEASE_SETTLE: 2000,

  // ── Persistence (progress.json) ───────────────────────────────────────
  /** Debounce window for batched async checkpoint writes. */
  PROGRESS_DEBOUNCE: 1000,

  // ── Limits ────────────────────────────────────────────────────────────
  /** Max bytes accepted for credentials.csv to avoid OOM. */
  MAX_CSV_BYTES: 50 * 1024 * 1024,
  /** Screenshot retention window — files older than this are pruned. */
  SCREENSHOT_RETENTION_MS: 72 * 60 * 60 * 1000,
  /** Periodic interval at which the screenshot cleanup runs. */
  SCREENSHOT_CLEANUP_INTERVAL_MS: 6 * 60 * 60 * 1000,
  /** JPEG quality for screenshots [0-100]. */
  SCREENSHOT_JPEG_QUALITY: 75,
  /** Format for screenshots. */
  SCREENSHOT_FORMAT: "jpeg" as const,
  /** Base directory for screenshots. */
  SCREENSHOT_DIR: "screenshots" as const,
  /** Max images to keep in the dashboard carousel. */
  SCREENSHOT_CAROUSEL_MAX: 50,
  /** Max screenshots allowed in the background write queue before dropping. */
  SCREENSHOT_QUEUE_MAX: 200,
  /** Hard cap on wall-clock time for a SINGLE target site within a credential
   *  row. If a site (Joe or Ignition) exceeds this, it is forcibly abandoned
   *  and marked N/A while the other site may still complete. */
  SITE_HARD_TIMEOUT_MS: 150_000,
  /** Hard cap on total wall-clock time spent on a single credential row
   *  (across all sites + proxy retries). 300s = 2× SITE_HARD_TIMEOUT_MS
   *  to cover sequential-mode execution with headroom. */
  ROW_HARD_TIMEOUT_MS: 300_000,
} as const;

// Dynamic timings mutated by the real-time orchestrator (Hermes)
// to iteratively optimize speed.
export const DynamicTimings = { ...Timings };

export type TimingKey = keyof typeof Timings;

/**
 * Computes an elastic timeout dynamically scaled by proxy network latency.
 * If proxy latency exceeds 500ms, timeouts scale up gracefully (up to 1.5x)
 * to prevent false-positive timeouts on slow rotating proxy nodes.
 */
export function computeElasticTimeout(baseTimeoutMs: number, proxyPingLatencyMs?: number): number {
  if (!proxyPingLatencyMs || proxyPingLatencyMs <= 300) {
    return baseTimeoutMs;
  }
  const jitterFactor = Math.min(1.5, 1.0 + (proxyPingLatencyMs - 300) / 1000);
  return Math.round(baseTimeoutMs * jitterFactor);
}
