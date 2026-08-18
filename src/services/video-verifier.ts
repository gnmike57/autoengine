/* eslint-disable @typescript-eslint/no-unsafe-assignment*/
import path from 'node:path';
import { createLogger } from "../core/logger.js";
import { generateContentWithFallback, isAiAvailable, OPENROUTER_MODEL_NAME } from "../intelligence/llm-provider.js";
import { extractKeyFrames } from "./video-extraction.js";

const log = createLogger("video-verifier");

// ─── Types ─────────────────────────────────────────────────────────────────────

export type AiVerdict =
  | "disabled"         // "Your account has been disabled" / permdisabled
  | "temp-disabled"    // "temporarily disabled" / tempdisabled
  | "wrong-password"   // "incorrect password" / noaccount-via-exhaustion
  | "no-account"       // "no account found" / explicit noaccount
  | "success"          // logged in successfully
  | "2fa"              // two-factor auth prompt
  | "unclear";         // model couldn't determine

export interface VerificationResult {
  aiVerdict: AiVerdict;
  confidence: "high" | "medium" | "low";
  matches: boolean;           // AI agrees with engine outcome
  reasoning: string;          // one-line AI explanation
  framesAnalyzed: number;
  modelUsed: string;
  durationMs: number;
  /** False when the verifier could not actually inspect the recording (no API
   *  key, no extractable frames, model timed out, unparseable response). The
   *  engine uses this to gate signal-missing fallbacks instead of treating an
   *  empty verdict as a real "no-match" result. */
  signalAvailable?: boolean;
}

export interface VerificationJob {
  email: string;
  rowIndex: number;
  autoBurnCandidate?: boolean; // True if the credential was all-terminal-bad and should be burned if AI matches
  sites: Array<{
    name: string;
    engineOutcome: string;
    videoPath: string;
  }>;
}

// ─── Configuration ─────────────────────────────────────────────────────────────

export function isVerificationAvailable(): boolean {
  return isAiAvailable();
}

// ─── Frame Extraction ──────────────────────────────────────────────────────────
// ─── AI Verification ───────────────────────────────────────────────────────────

const VERIFICATION_PROMPT = `You are analyzing screenshots from a casino website login automation recording.

Your task: Determine what happened on this login page based on the visual evidence.

CRITICAL PRIORITY RULES - YOU MUST EVALUATE THESE STRINGS FIRST BEFORE LOOKING FOR ANYTHING ELSE:
1. "temp-disabled" → You see "temporarily disabled", "too many failed attempts", "locked out", "try again in", "try again later", or "too many attempts".
2. "disabled" → You see "permanently disabled", "account closed", "been disabled", "account suspended", or "no longer active".
3. "wrong-password" → You see "incorrect" (and none of the above are present).

ONLY IF NONE OF THE ABOVE CORE KEYWORDS ARE VISIBLE, EVALUATE THE FOLLOWING:
- "success" → The user appears logged in (dashboard, account page, cashier visible)
- "2fa" → You see a two-factor authentication prompt (authenticator, SMS code)
- "no-account" → You see only screenshots of that email on that site with incorrect on most or all and none with any other key word or phrase or success indicator
- "unclear" → Cannot determine from the frames

IMPORTANT: Focus on the last 3 frames — they show the end state after login attempts.
You MUST prioritize checking for the exact strings listed in the top 3 priority rules before evaluating structural/layout changes.`;

/**
 * Send extracted frames to Gemini or OpenRouter vision and get a verdict.
 */
export async function classifyWithAI(
  frames: Buffer[],
  engineOutcome: string,
  siteName: string,
): Promise<VerificationResult> {
  if (!isAiAvailable()) {
    return {
      aiVerdict: "unclear",
      confidence: "low",
      matches: false,
      reasoning: "AI verification unavailable — evidence cannot be confirmed",
      framesAnalyzed: 0,
      modelUsed: "none",
      durationMs: 0,
      signalAvailable: false,
    };
  }

  if (frames.length === 0) {
    return {
      aiVerdict: "unclear",
      confidence: "low",
      matches: false,
      reasoning: "No frames available for analysis",
      framesAnalyzed: 0,
      modelUsed: OPENROUTER_MODEL_NAME,
      durationMs: 0,
      signalAvailable: false,
    };
  }

  try {
    // Structured output schema
    const responseSchema = {
      type: "object",
      properties: {
        verdict: {
          type: "string",
          description: "One of: disabled, temp-disabled, wrong-password, no-account, success, 2fa, unclear",
        },
        confidence: {
          type: "string",
          description: "One of: high, medium, low",
        },
        reasoning: {
          type: "string",
          description: "One sentence explaining what you see",
        },
      },
      required: ["verdict", "confidence", "reasoning"],
    };

    const result = await generateContentWithFallback({
      prompt: `Site: ${siteName}\n\n${VERIFICATION_PROMPT}`,
      images: frames,
      schema: responseSchema,
      timeoutMs: 30000,
    });

    let parsed: { verdict?: string; confidence?: string; reasoning?: string };
    try {
      parsed = JSON.parse(result.text);
    } catch {
      log.warn(`AI response not valid JSON: ${result.text.slice(0, 200)}`);
      return { aiVerdict: "unclear", confidence: "low", matches: false, reasoning: `Failed to parse AI response: ${result.text.slice(0, 100)}`, framesAnalyzed: frames.length, modelUsed: result.modelUsed, durationMs: result.durationMs, signalAvailable: false };
    }

    const aiVerdict = normalizeVerdict(parsed.verdict || "unclear");
    const confidence = (parsed.confidence === "high" || parsed.confidence === "medium" || parsed.confidence === "low") ? parsed.confidence : "low";
    const matches = checkMatch(engineOutcome, aiVerdict);

    return { aiVerdict, confidence, matches, reasoning: parsed.reasoning || "No reasoning provided", framesAnalyzed: frames.length, modelUsed: result.modelUsed, durationMs: result.durationMs, signalAvailable: true };
  } catch (err) {
    log.warn(`AI verification failed: ${err instanceof Error ? err.message : String(err)}`);
    return { aiVerdict: "unclear", confidence: "low", matches: false, reasoning: `AI API error: ${err instanceof Error ? err.message : String(err)}`, framesAnalyzed: frames.length, modelUsed: "fallback-error", durationMs: 0, signalAvailable: false };
  }
}

function normalizeVerdict(raw: string): AiVerdict {
  const lower = raw.toLowerCase().trim();
  const map: Record<string, AiVerdict> = {
    "disabled": "disabled",
    "temp-disabled": "temp-disabled",
    "temporarily-disabled": "temp-disabled",
    "tempdisabled": "temp-disabled",
    "wrong-password": "wrong-password",
    "incorrect": "wrong-password",
    "no-account": "no-account",
    "noaccount": "no-account",
    "success": "success",
    "2fa": "2fa",
    "unclear": "unclear",
  };
  return map[lower] || "unclear";
}

/**
 * Check if AI verdict matches the engine's outcome.
 *
 * Mapping: engine outcome → expected AI verdicts that would agree
 *   permdisabled → disabled
 *   tempdisabled → temp-disabled
 *   noaccount    → wrong-password OR no-account (both mean "didn't get in")
 *   success      → success
 *   2FA          → 2fa
 */
function checkMatch(engineOutcome: string, aiVerdict: AiVerdict): boolean {
  switch (engineOutcome) {
    case "permdisabled":
      return aiVerdict === "disabled";
    case "tempdisabled":
      return aiVerdict === "temp-disabled";
    case "noaccount":
      // "noaccount" in engine = exhausted all passwords with "incorrect" responses.
      // AI seeing "wrong-password" or "no-account" both agree with this.
      return aiVerdict === "wrong-password" || aiVerdict === "no-account";
    case "success":
      return aiVerdict === "success";
    case "2FA":
      return aiVerdict === "2fa";
    case "honeypot":
      // Honeypot pages often look like real login pages but aren't.
      // If AI sees wrong-password, disabled, or no-account, that's consistent.
      // If AI sees success, that contradicts the honeypot classification.
      return aiVerdict !== "success";
    case "skipped":
    case "N/A":
    case "queued":
    case "testing":
      // Non-terminal outcomes — don't dispute
      return true;
    default:
      return true; // don't dispute unknown outcomes
  }
}

// ─── High-Level Verification API ───────────────────────────────────────────────

/**
 * Verify a single site's recording for a credential row.
 * Extracts frames → sends to AI → returns result.
 */
export async function verifySiteRecording(
  videoPath: string,
  engineOutcome: string,
  siteName: string,
): Promise<VerificationResult> {
  log.info(`🤖 Verifying ${siteName} recording: ${path.basename(videoPath)} (engine=${engineOutcome})`);

  const frames = await extractKeyFrames(videoPath);
  if (frames.length === 0) {
    log.warn(`  No frames extracted from ${path.basename(videoPath)} — skipping AI verification`);
    return {
      aiVerdict: "unclear",
      confidence: "low",
      matches: false,
      reasoning: "No frames could be extracted from recording",
      framesAnalyzed: 0,
      modelUsed: "none",
      durationMs: 0,
      signalAvailable: false,
    };
  }

  const result = await classifyWithAI(frames, engineOutcome, siteName);

  const icon = result.matches ? "✓" : "⚠";
  const level = result.matches ? "info" : "warn";
  log[level](
    `  🤖 ${icon} AI verdict: ${result.aiVerdict} (${result.confidence}) ` +
    `${result.matches ? "agrees" : "DISAGREES"} with engine=${engineOutcome} — ` +
    `${result.reasoning} [${result.durationMs}ms, ${result.framesAnalyzed} frames]`
  );

  return result;
}

/**
 * Process a full verification job (all sites for one credential row).
 * Returns per-site results.
 */
export async function processVerificationJob(
  job: VerificationJob,
): Promise<Map<string, VerificationResult>> {
  const results = new Map<string, VerificationResult>();

  for (const site of job.sites) {
    try {
      const result = await verifySiteRecording(site.videoPath, site.engineOutcome, site.name);
      results.set(site.name, result);
    } catch (err) {
      log.warn(`Verification failed for ${site.name}/${job.email}: ${err instanceof Error ? err.message : String(err)}`);
      results.set(site.name, {
        aiVerdict: "unclear",
        confidence: "low",
        matches: false,
        reasoning: `Verification error: ${err instanceof Error ? err.message : String(err)}`,
        framesAnalyzed: 0,
        modelUsed: "none",
        durationMs: 0,
        signalAvailable: false,
      });
    }
  }

  return results;
}

/**
 * Validates that the configured AI verification endpoint is valid.
 * Fails fast so the app can warn the user on startup.
 */
export function validateAiConfig(): boolean {
  if (isAiAvailable()) {
    log.info("🤖 AI verification is armed and configured via llm-provider.");
    return true;
  }
  log.warn("No AI API key or local endpoint configured. AI verification features will be disabled.");
  return false;
}
