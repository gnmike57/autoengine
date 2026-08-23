/**
 * hermes-observer.ts
 *
 * Hermes-Observer — Ultra-intelligent LIVE agent running DURING automation batches.
 * Uses LLM (OpenRouter/Ollama) for real-time analysis, suggestions, and corrections.
 *
 * Responsibilities:
 *   1. Manages TimingRecorder lifecycle per session/attempt
 *   2. Triggers ResponseScreenshotter captures after responses
 *   3. Verifies proxy IP geo-origin (Australian requirement)
 *   4. Detects IP duplication across concurrent windows
 *   5. Monitors for anomalies (unusually slow phases, timeouts)
 *   6. 🧠 LLM-powered live screenshot analysis (vision)
 *   7. 🧠 LLM-powered anomaly diagnosis and correction suggestions
 *   8. 🧠 LLM-powered post-attempt analysis with learning
 */

import type { Page } from "playwright-core";
import fs from "node:fs";
import path from "node:path";
import { TimingRecorder, type FlowPhase, type PhaseTimings } from "./timing-telemetry.js";
import { ResponseScreenshotter, type CaptureOptions } from "../services/response-screenshotter.js";
import { HermesLLM, getHermesLLM } from "./hermes-llm.js";
import { createLogger } from "../core/logger.js";

const log = createLogger("HermesObserver");

// ── Global IP Tracking (shared across all sessions) ────────────────────────

const seenIPs: Map<string, string> = new Map();  // IP → sessionId
const sessionIPs: Map<string, string> = new Map();  // sessionId → IP

// ── Intelligence Log ───────────────────────────────────────────────────────

const INTELLIGENCE_DIR = path.join(process.cwd(), "data", "hermes-intelligence");

interface IntelligenceEntry {
  timestamp: string;
  sessionId?: string;
  email?: string;
  site?: string;
  type: "screenshot_analysis" | "anomaly_diagnosis" | "flow_suggestion" | "correction" | "post_attempt" | "external_anomaly";
  attemptIdx?: number;
  verdict?: string;
  analysis?: string;
  suggestion?: string;
  confidence?: number;
  llmModel?: string;
  llmLatencyMs?: number;
  anomalyType?: string;
  details?: Record<string, unknown>;
}

function persistIntelligence(entry: IntelligenceEntry): void {
  try {
    if (!fs.existsSync(INTELLIGENCE_DIR)) {
      fs.mkdirSync(INTELLIGENCE_DIR, { recursive: true });
    }
    const file = path.join(INTELLIGENCE_DIR, "live-observations.jsonl");
    fs.appendFileSync(file, JSON.stringify(entry) + "\n", "utf-8");
  } catch {
    // never block on persistence failure
  }
}

// ── Types ──────────────────────────────────────────────────────────────────

export interface GeoVerification {
  ip: string;
  country: string;
  countryCode: string;
  region: string;
  city: string;
  isAustralian: boolean;
  isDuplicate: boolean;
  duplicateSessionId?: string;
}

export interface ObserverSession {
  sessionId: string;
  email: string;
  site: string;
  backend: string;
  recorder: TimingRecorder;
  page?: Page;
  geoResult?: GeoVerification;
  anomalies: string[];
  llmInsights: string[];
  startTime: number;
  lastVerdict?: string;
  attemptResults: Array<{
    attemptIdx?: number;
    site?: string;
    verdict?: string;
    outcome?: string;
    attempts?: number;
    timestamp?: number;
    timings?: PhaseTimings;
    screenshotPaths?: string[];
    llmAnalysis?: string;
  }>;
}

// ── System Prompts ─────────────────────────────────────────────────────────

const SYSTEM_PROMPT_LIVE = `You are Hermes-Observer, an ultra-intelligent real-time automation analyst embedded inside a web credential testing system. Your job is to observe screenshots and telemetry from live browser sessions and provide instant, actionable intelligence.

You are analyzing login flow automation targeting Australian gambling sites (JoeFortune, Ignition Casino). The automation fills credentials and submits login forms.

Your analysis must be:
1. CONCISE — max 3 sentences
2. ACTIONABLE — always include what should happen next
3. SPECIFIC — reference exact UI elements you see

Key things to detect:
- Cookie banners blocking the form (CRITICAL — must be dismissed first)
- Error messages: "incorrect password", "account disabled", "too many attempts"
- Success indicators: "Welcome!" with exclamation mark
- CAPTCHA challenges or bot detection
- Form submission state (button color changes, loading spinners)
- Page navigation (redirected to login = failed, redirected to dashboard/cashier = success)
- Honeypot pages: "Identity Verification", "Under Review"
- 2FA prompts: "Authenticator", "verification code"

IMPORTANT: "Welcome" WITHOUT "!" is NOT a success. Only "Welcome!" (with !) counts.`;

const SYSTEM_PROMPT_ANOMALY = `You are Hermes-Observer diagnosing an anomaly in a live web automation session. Analyze the timing data and context to explain what went wrong and suggest a specific correction.

Output format:
DIAGNOSIS: [1 sentence explanation]
CORRECTION: [1 sentence actionable fix]
CONFIDENCE: [0.0-1.0]`;

const SYSTEM_PROMPT_POST_ATTEMPT = `You are Hermes-Observer performing post-attempt analysis. Given the screenshot and telemetry from a completed login attempt, analyze the result and provide learning insights.

Output format:
RESULT: [What happened - in 1 sentence]
LEARNING: [What pattern should be remembered - in 1 sentence]
NEXT_ACTION: [What the automation should do next - in 1 sentence]`;

// ── HermesObserver ──────────────────────────────────────────────────────────

export class HermesObserver {
  private sessions: Map<string, ObserverSession> = new Map();
  private llm: HermesLLM;
  private staleCleanupTimer: ReturnType<typeof setInterval> | null = null;
  
  // Self-repair loop prevention
  private globalRepairCooldownUntil: number = 0;
  private anomalyRepairHistory: Map<string, { attempts: number, lastAttemptAt: number, failedSuggestions: string[] }> = new Map();

  constructor() {
    this.llm = getHermesLLM();
    if (this.llm.isAvailable()) {
      log.info("[HermesObserver] 🧠 LLM intelligence ACTIVE — live analysis enabled");
    } else {
      log.info("[HermesObserver] 📊 LLM unavailable — running in telemetry-only mode");
    }
    this.staleCleanupTimer = setInterval(() => this.cleanupStaleSessions(), 5 * 60 * 1000);
    if (this.staleCleanupTimer) this.staleCleanupTimer.unref();
  }

  private cleanupStaleSessions(): void {
    const now = Date.now();
    const maxAge = 30 * 60 * 1000;
    interface StaleInfo { email: string; site: string; startTime: number; }
    const stale = new Map<string, StaleInfo>();
    for (const [sid, session] of this.sessions) {
      if (now - session.startTime > maxAge) {
        stale.set(sid, { email: session.email, site: session.site, startTime: session.startTime });
      }
    }
    for (const [sid, info] of stale) {
      log.warn(`[HermesObserver] Cleaning stale session: ${sid} (${info.email} @ ${info.site}) — started ${Math.round((now - info.startTime) / 1000)}s ago`);
      this.endSession(sid);
    }
  }

  /**
   * Start observing a new session. Called when a browser session launches.
   */
  startSession(
    email: string,
    site: string,
    backend: string,
    page?: Page
  ): string {
    const sessionId = `obs_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    const recorder = new TimingRecorder(sessionId, email, site, backend);
    const session: ObserverSession = {
      sessionId,
      email,
      site,
      backend,
      recorder,
      page,
      anomalies: [],
      llmInsights: [],
      startTime: Date.now(),
      attemptResults: [],
    };

    this.sessions.set(sessionId, session);
    log.info(`[HermesObserver] 👁️ Session started: ${sessionId} (${email} @ ${site})`);
    return sessionId;
  }

  /**
   * Get the timing recorder for a session.
   */
  getRecorder(sessionId: string): TimingRecorder | undefined {
    return this.sessions.get(sessionId)?.recorder;
  }

  /**
   * Get the session object.
   */
  getSession(sessionId: string): ObserverSession | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Mark a phase start on the session's recorder.
   */
  markPhaseStart(sessionId: string, phase: FlowPhase): void {
    this.sessions.get(sessionId)?.recorder.markPhaseStart(phase);
  }

  /**
   * Mark a phase end on the session's recorder.
   */
  markPhaseEnd(sessionId: string, phase: FlowPhase): number {
    return this.sessions.get(sessionId)?.recorder.markPhaseEnd(phase) ?? 0;
  }

  /**
   * Set the current attempt index.
   */
  setAttemptIdx(sessionId: string, idx: number): void {
    this.sessions.get(sessionId)?.recorder.setAttemptIdx(idx);
  }

  /**
   * Capture response screenshots after a login attempt.
   */
  async captureResponse(
    page: Page,
    sessionId: string,
    opts: Omit<CaptureOptions, "email" | "site">
  ): Promise<string[]> {
    const session = this.sessions.get(sessionId);
    if (!session) return [];

    return ResponseScreenshotter.captureAttempt(page, {
      ...opts,
      email: session.email,
      site: session.site,
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 🧠 LLM-POWERED LIVE INTELLIGENCE
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * 🧠 LIVE: Analyze a screenshot with the vision LLM in real-time.
   * Called after each login attempt response to understand what the page shows.
   * Non-blocking — fires asynchronously and logs results.
   */
  async analyzeScreenshotLive(
    page: Page,
    sessionId: string,
    attemptIdx: number,
    verdict: string
  ): Promise<string | null> {
    if (!this.llm.isAvailable()) return null;
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    try {
      const buffer = await page.screenshot({ type: "png", fullPage: false }).catch(() => null);
      if (!buffer) return null;

      const prompt = `Analyze this screenshot from a login automation attempt.
Session: ${session.email} @ ${session.site}
Attempt: ${attemptIdx + 1}/4
Current verdict from code: "${verdict}"

What do you see on the page? Is the verdict correct? Any issues or corrections needed?`;

      const result = await this.llm.analyzeScreenshot(buffer, prompt);

      if (result.content) {
        const insight = `[Attempt ${attemptIdx + 1}] ${result.content}`;
        session.llmInsights.push(insight);
        log.info(`[HermesObserver] 🧠 Live analysis [${sessionId}]: ${result.content.substring(0, 200)}`);

        persistIntelligence({
          timestamp: new Date().toISOString(),
          sessionId,
          email: session.email,
          site: session.site,
          type: "screenshot_analysis",
          attemptIdx,
          verdict,
          analysis: result.content,
          llmModel: result.model,
          llmLatencyMs: result.latencyMs,
        });

        return result.content;
      }
    } catch (err) {
      log.warn(`[HermesObserver] Screenshot analysis failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    return null;
  }

  /**
   * 🧠 LIVE: Diagnose a timing anomaly in real-time.
   * Called when a phase takes unexpectedly long or short.
   */
  async diagnoseAnomaly(
    sessionId: string,
    phase: string,
    actualMs: number,
    expectedMs: number,
    context: string
  ): Promise<{ diagnosis: string; correction: string; confidence: number } | null> {
    if (!this.llm.isAvailable()) return null;
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    try {
      const userContent = `Phase: ${phase}
Expected duration: ${expectedMs}ms
Actual duration: ${actualMs}ms
Deviation: ${actualMs > expectedMs ? "+" : ""}${actualMs - expectedMs}ms (${Math.round((actualMs / expectedMs) * 100)}% of expected)
Session: ${session.email} @ ${session.site} (${session.backend})
Context: ${context}
Anomalies so far: ${session.anomalies.join("; ") || "none"}`;

      const result = await this.llm.analyzeText(SYSTEM_PROMPT_ANOMALY, userContent);

      if (result.content) {
        const lines = result.content.split("\n");
        const diagnosis = lines.find(l => l.startsWith("DIAGNOSIS:"))?.replace("DIAGNOSIS:", "").trim() || result.content;
        const correction = lines.find(l => l.startsWith("CORRECTION:"))?.replace("CORRECTION:", "").trim() || "";
        const confLine = lines.find(l => l.startsWith("CONFIDENCE:"))?.replace("CONFIDENCE:", "").trim() || "0.5";
        const confidence = parseFloat(confLine) || 0.5;

        log.info(`[HermesObserver] 🧠 Anomaly diagnosed [${sessionId}]: ${diagnosis}`);
        if (correction) log.info(`[HermesObserver] 💡 Correction: ${correction}`);

        session.anomalies.push(`[LLM] ${diagnosis}`);

        persistIntelligence({
          timestamp: new Date().toISOString(),
          sessionId,
          email: session.email,
          site: session.site,
          type: "anomaly_diagnosis",
          attemptIdx: -1,
          analysis: diagnosis,
          suggestion: correction,
          confidence,
          llmModel: result.model,
          llmLatencyMs: result.latencyMs,
        });

        return { diagnosis, correction, confidence };
      }
    } catch (err) {
      log.warn(`[HermesObserver] Anomaly diagnosis failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    return null;
  }

  /**
   * 🧠 LIVE: Full post-attempt analysis combining screenshot + telemetry.
   * This is the main intelligence method — called after each attempt completes.
   */
  async analyzeAttemptComplete(
    page: Page,
    sessionId: string,
    attemptIdx: number,
    verdict: string,
    timings: PhaseTimings,
    screenshotPaths: string[]
  ): Promise<string | null> {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    // Store attempt result regardless of LLM availability
    session.attemptResults.push({
      attemptIdx,
      verdict,
      timings: { ...timings },
      screenshotPaths: [...screenshotPaths],
    });
    session.lastVerdict = verdict;

    if (!this.llm.isAvailable()) return null;

    try {
      // Get a fresh screenshot for analysis
      const buffer = await page.screenshot({ type: "png", fullPage: false }).catch(() => null);
      if (!buffer) return null;

      const timingsSummary = Object.entries(timings)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => `${k}: ${v}ms`)
        .join(", ");

      const previousAttempts = session.attemptResults
        .slice(0, -1) // exclude current
        .map(a => `  Attempt ${(a.attemptIdx ?? 0) + 1}: ${a.verdict ?? a.outcome ?? "?"} (${a.llmAnalysis?.substring(0, 80) || "no analysis"})`)
        .join("\n");

      const prompt = `Post-attempt analysis for a login automation:
Session: ${session.email} @ ${session.site} (${session.backend})
Attempt: ${attemptIdx + 1}/4
Verdict from code: "${verdict}"
Timings: ${timingsSummary}
${previousAttempts ? `Previous attempts:\n${previousAttempts}` : "First attempt"}
Anomalies: ${session.anomalies.join("; ") || "none"}

Look at this screenshot and tell me: Is the verdict correct? What should happen next?`;

      const result = await this.llm.analyzeScreenshot(buffer, prompt);

      if (result.content) {
        // Parse structured response
        const lines = result.content.split("\n");
        const resultLine = lines.find(l => l.startsWith("RESULT:"))?.replace("RESULT:", "").trim();
        const learning = lines.find(l => l.startsWith("LEARNING:"))?.replace("LEARNING:", "").trim();
        const nextAction = lines.find(l => l.startsWith("NEXT_ACTION:"))?.replace("NEXT_ACTION:", "").trim();

        const analysis = resultLine || result.content;

        // Store on the attempt result
        const lastResult = session.attemptResults[session.attemptResults.length - 1];
        if (lastResult) lastResult.llmAnalysis = analysis;

        session.llmInsights.push(`[Post-Attempt ${attemptIdx + 1}] ${analysis}`);
        if (learning) session.llmInsights.push(`[Learning] ${learning}`);

        log.info(`[HermesObserver] 🧠 Post-attempt [${sessionId}] A${attemptIdx + 1}: ${analysis}`);
        if (nextAction) log.info(`[HermesObserver] ➡️ Next: ${nextAction}`);

        persistIntelligence({
          timestamp: new Date().toISOString(),
          sessionId,
          email: session.email,
          site: session.site,
          type: "post_attempt",
          attemptIdx,
          verdict,
          analysis: result.content,
          suggestion: nextAction,
          llmModel: result.model,
          llmLatencyMs: result.latencyMs,
        });

        return analysis;
      }
    } catch (err) {
      log.warn(`[HermesObserver] Post-attempt analysis failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    return null;
  }

  /**
   * 🧠 LIVE: Suggest correction when an unexpected state is detected.
   * For example, if the cookie banner is still visible after dismissal.
   */
  async suggestCorrection(
    sessionId: string,
    issue: string,
    currentState: string
  ): Promise<string | null> {
    if (!this.llm.isAvailable()) return null;
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    // 1. Check Global Cooldown
    if (Date.now() < this.globalRepairCooldownUntil) {
      log.warn(`[HermesObserver] 🛑 Skipping self-repair for [${sessionId}] due to active global cooldown.`);
      return null;
    }

    // 2. Track Anomaly Repair History
    let history = this.anomalyRepairHistory.get(issue);
    if (!history) {
      history = { attempts: 0, lastAttemptAt: 0, failedSuggestions: [] };
      this.anomalyRepairHistory.set(issue, history);
    }
    
    // Reset history if it's been more than 24 hours
    if (Date.now() - history.lastAttemptAt > 24 * 60 * 60 * 1000) {
      history.attempts = 0;
      history.failedSuggestions = [];
    }

    // 3. Max Attempts Threshold
    if (history.attempts >= 2) {
      log.error(`[HermesObserver] 🛑 Halt! Anomaly "${issue}" has failed repair >2 times in 24h. Escalating to human review.`);
      persistIntelligence({
        timestamp: new Date().toISOString(),
        sessionId,
        type: "external_anomaly",
        anomalyType: "INFINITE_REPAIR_LOOP_PREVENTED",
        details: { issue, history }
      });
      return null;
    }

    history.attempts++;
    history.lastAttemptAt = Date.now();

    try {
      const historyContext = history.failedSuggestions.length > 0 
        ? `\nPREVIOUS FAILED ATTEMPTS for this anomaly (DO NOT REPEAT THESE):\n${history.failedSuggestions.join('\n')}\nYou must explicitly attempt a RADICALLY DIFFERENT APPROACH.`
        : "";

      const userContent = `Issue detected: ${issue}
Current automation state: ${currentState}
Session: ${session.email} @ ${session.site}
Attempt results so far: ${session.attemptResults.map(a => `A${(a.attemptIdx ?? 0) + 1}=${a.verdict ?? a.outcome ?? "?"}`).join(", ") || "none"}${historyContext}

What is the most likely cause and what correction should be applied immediately?`;

      const result = await this.llm.analyzeText(SYSTEM_PROMPT_LIVE, userContent);

      if (result.content) {
        log.info(`[HermesObserver] 💡 Correction [${sessionId}]: ${result.content.substring(0, 200)}`);
        
        // Track the suggestion so we don't repeat it
        history.failedSuggestions.push(result.content);
        
        // Apply 1-hour global cooldown
        this.globalRepairCooldownUntil = Date.now() + 60 * 60 * 1000;
        log.info(`[HermesObserver] ⏱️ Global repair cooldown activated for 1 hour.`);

        persistIntelligence({
          timestamp: new Date().toISOString(),
          sessionId,
          email: session.email,
          site: session.site,
          type: "correction",
          attemptIdx: session.attemptResults.length,
          analysis: issue,
          suggestion: result.content,
          llmModel: result.model,
          llmLatencyMs: result.latencyMs,
        });

        return result.content;
      }
    } catch (err) {
      log.warn(`[HermesObserver] Correction suggestion failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    return null;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 🌐 GEO & IP VERIFICATION
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Verify the proxy IP geo-origin for a session.
   */
  async verifyGeo(page: Page, sessionId: string): Promise<GeoVerification | null> {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    try {
      const geoData = await page.evaluate(async () => {
        try {
          const res = await fetch("http://ip-api.com/json/?fields=query,country,countryCode,regionName,city");
          return await res.json() as {
            query: string;
            country: string;
            countryCode: string;
            regionName: string;
            city: string;
          };
        } catch {
          return null;
        }
      });

      if (!geoData) {
        log.warn(`[HermesObserver] Geo-IP fetch failed for session ${sessionId}`);
        return null;
      }

      const ip = geoData.query;
      const isAustralian = geoData.countryCode === "AU";
      const isDuplicate = seenIPs.has(ip) && seenIPs.get(ip) !== sessionId;
      const duplicateSessionId = isDuplicate ? seenIPs.get(ip) : undefined;

      seenIPs.set(ip, sessionId);
      sessionIPs.set(sessionId, ip);

      const result: GeoVerification = {
        ip,
        country: geoData.country,
        countryCode: geoData.countryCode,
        region: geoData.regionName,
        city: geoData.city,
        isAustralian,
        isDuplicate,
        duplicateSessionId,
      };

      session.geoResult = result;

      if (!isAustralian) {
        const anomaly = `Non-Australian IP: ${ip} (${geoData.countryCode})`;
        session.anomalies.push(anomaly);
        log.warn(`[HermesObserver] ❌ ${anomaly}`);
        // Ask LLM for correction suggestion (non-blocking)
        void this.suggestCorrection(sessionId, anomaly, "GEO_VERIFICATION");
      }

      if (isDuplicate) {
        const anomaly = `Duplicate IP: ${ip} also used by ${duplicateSessionId}`;
        session.anomalies.push(anomaly);
        log.warn(`[HermesObserver] ⚠️ ${anomaly}`);
      }

      log.info(
        `[HermesObserver] 🌐 ${sessionId}: ${ip} → ${geoData.city}, ${geoData.country} ${isAustralian ? "✅" : "❌"}`
      );

      return result;
    } catch (err) {
      log.warn(`[HermesObserver] Geo verification error: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 📊 SESSION LIFECYCLE
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Record an anomaly for a session.
   */
  recordAnomaly(sessionId: string, message: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.anomalies.push(message);
      log.warn(`[HermesObserver] ⚠️ Anomaly [${sessionId}]: ${message}`);
    }
  }

  /**
   * Finalize a session's timing recording.
   */
  finalizeSession(sessionId: string, verdict: string, success: boolean): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.recorder.finalize(verdict, success);
    log.info(
      `[HermesObserver] 📊 Session ${sessionId} finalized: ${verdict} (${success ? "✅" : "❌"}) — ` +
      `${session.llmInsights.length} LLM insights, ${session.anomalies.length} anomalies`
    );
  }

  /**
   * Reset a session's recorder for the next attempt.
   */
  resetForNextAttempt(sessionId: string): void {
    this.sessions.get(sessionId)?.recorder.resetForNextAttempt();
  }

  /**
   * End a session and clean up tracking.
   */
  endSession(sessionId: string): void {
    const ip = sessionIPs.get(sessionId);
    if (ip && seenIPs.get(ip) === sessionId) {
      seenIPs.delete(ip);
    }
    sessionIPs.delete(sessionId);
    this.sessions.delete(sessionId);
    log.info(`[HermesObserver] 👋 Session ended: ${sessionId}`);
  }

  /**
   * Get all currently active session IDs.
   */
  getActiveSessions(): string[] {
    return Array.from(this.sessions.keys());
  }

  /**
   * Get the current IP for a session (for overlay display).
   */
  getSessionIP(sessionId: string): string | undefined {
    return sessionIPs.get(sessionId);
  }

  /**
   * Check if an IP is unique across all active sessions.
   */
  isIPUnique(ip: string, sessionId: string): boolean {
    return !seenIPs.has(ip) || seenIPs.get(ip) === sessionId;
  }

  /**
   * Get LLM statistics.
   */
  getLLMStats() {
    return this.llm.getStats();
  }

  /**
   * Get all insights for a session.
   */
  getSessionInsights(sessionId: string): string[] {
    return this.sessions.get(sessionId)?.llmInsights ?? [];
  }

  /**
   * Record an outcome for a session (called by engine after login flow completes).
   */
  recordOutcome(sessionId: string, site: string, outcome: string, attempts: number = 1): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.attemptResults.push({ site, outcome, attempts, timestamp: Date.now() });
      this.totalOutcomes++;
      if (outcome === "success" || outcome === "2FA") {
        this.totalSuccesses++;
      }
      log.info(`[HermesObserver] 📊 Outcome recorded: ${session.email} @ ${site} → ${outcome} (attempt ${attempts})`);

      // Fire non-blocking LLM analysis if available
      if (this.llm.isAvailable() && session.page) {
        void this.analyzeScreenshotLive(session.page, sessionId, attempts - 1, outcome).catch(() => {});
      }
    }
  }

  /**
   * Report an anomaly from external systems (watchdog, block-predictor, etc.)
   */
  reportAnomaly(type: string, details: Record<string, unknown>): void {
    this.totalAnomalies++;
    log.warn(`[HermesObserver] ⚠️ Anomaly reported: ${type} — ${JSON.stringify(details).substring(0, 200)}`);

    persistIntelligence({
      timestamp: new Date().toISOString(),
      type: "external_anomaly",
      anomalyType: type,
      details,
    });
  }

  /**
   * Get recent insights across all sessions (for Hermes Review context).
   */
  getRecentInsights(limit: number = 10): string[] {
    const allInsights: Array<{ insight: string; time: number }> = [];
    for (const session of this.sessions.values()) {
      for (const insight of session.llmInsights) {
        allInsights.push({ insight, time: session.startTime });
      }
    }
    return allInsights
      .sort((a, b) => b.time - a.time)
      .slice(0, limit)
      .map(i => i.insight);
  }

  // ─── Stats Getters (for server broadcast) ──────────────────────────────

  private totalOutcomes = 0;
  private totalSuccesses = 0;
  private totalAnomalies = 0;

  getLlmCallCount(): number {
    return this.llm.getStats().requestCount;
  }

  getInsightCount(): number {
    let count = 0;
    for (const session of this.sessions.values()) {
      count += session.llmInsights.length;
    }
    return count;
  }

  getScreenshotCount(): number {
    return this.totalOutcomes; // 1 screenshot per outcome
  }

  getAnomalyCount(): number {
    return this.totalAnomalies;
  }

  getAvgLlmLatency(): number {
    const stats = this.llm.getStats();
    return stats.requestCount > 0 ? Math.round(stats.avgLatencyMs) : 0;
  }

  getActiveSessionCount(): number {
    return this.sessions.size;
  }

  getTotalOutcomes(): number {
    return this.totalOutcomes;
  }

  getSuccessRate(): number {
    return this.totalOutcomes > 0 ? this.totalSuccesses / this.totalOutcomes : 0;
  }
}

// ── Singleton ──────────────────────────────────────────────────────────────

let _instance: HermesObserver | null = null;

export function getHermesObserver(): HermesObserver {
  if (!_instance) {
    _instance = new HermesObserver();
  }
  return _instance;
}

