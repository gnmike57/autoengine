const fs = require('fs');

let content = fs.readFileSync('src/services/video-verifier.ts', 'utf8');

// Replace imports
content = content.replace(
  /import \{ GoogleGenerativeAI, type Part \} from "@google\/generative-ai";/,
  `import { generateContentWithFallback, isAiAvailable, GEMINI_MODEL_NAME } from "../intelligence/llm-provider.js";`
);

// Replace configuration block
content = content.replace(
  /\/\/ ─── Configuration ───[\s\S]+?export function isVerificationAvailable\(\): boolean \{[\s\S]+?\}/,
  `// ─── Configuration ─────────────────────────────────────────────────────────────

export function isVerificationAvailable(): boolean {
  return isAiAvailable();
}`
);

// Replace classifyWithAI function
const classifyRegex = /export async function classifyWithAI\([\s\S]+?\}\n\}/;
const classifyReplacement = `export async function classifyWithAI(
  frames: Buffer[],
  engineOutcome: string,
  siteName: string,
): Promise<VerificationResult> {
  if (!isAiAvailable()) {
    return {
      aiVerdict: "unclear",
      confidence: "low",
      matches: true,
      reasoning: "AI verification unavailable — no API key or local endpoint configured",
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
      matches: true,
      reasoning: "No frames available for analysis",
      framesAnalyzed: 0,
      modelUsed: GEMINI_MODEL_NAME,
      durationMs: 0,
      signalAvailable: false,
    };
  }

  try {
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
      prompt: \`Site: \${siteName}\\n\\n\${VERIFICATION_PROMPT}\`,
      images: frames,
      schema: responseSchema,
      timeoutMs: 30000,
    });

    let parsed: { verdict?: string; confidence?: string; reasoning?: string };
    try {
      parsed = JSON.parse(result.text);
    } catch {
      log.warn(\`AI response not valid JSON: \${result.text.slice(0, 200)}\`);
      return { aiVerdict: "unclear", confidence: "low", matches: true, reasoning: \`Failed to parse AI response: \${result.text.slice(0, 100)}\`, framesAnalyzed: frames.length, modelUsed: result.modelUsed, durationMs: result.durationMs, signalAvailable: false };
    }

    const aiVerdict = normalizeVerdict(parsed.verdict || "unclear");
    const confidence = (parsed.confidence === "high" || parsed.confidence === "medium" || parsed.confidence === "low") ? parsed.confidence : "low";
    const matches = checkMatch(engineOutcome, aiVerdict);

    return { aiVerdict, confidence, matches, reasoning: parsed.reasoning || "No reasoning provided", framesAnalyzed: frames.length, modelUsed: result.modelUsed, durationMs: result.durationMs, signalAvailable: true };
  } catch (err) {
    log.warn(\`AI verification failed: \${err instanceof Error ? err.message : String(err)}\`);
    return { aiVerdict: "unclear", confidence: "low", matches: true, reasoning: \`AI API error: \${err instanceof Error ? err.message : String(err)}\`, framesAnalyzed: frames.length, modelUsed: "fallback-error", durationMs: 0, signalAvailable: false };
  }
}`;

content = content.replace(classifyRegex, classifyReplacement);

// Replace verifySiteRecording modelUsed default
content = content.replace(
  /modelUsed: MODEL_NAME,/g,
  `modelUsed: "none",`
);

// Replace validateAiConfig
const validateRegex = /export async function validateAiConfig\(\): Promise<boolean> \{[\s\S]+?\}\n\}/;
const validateReplacement = `export async function validateAiConfig(): Promise<boolean> {
  if (isAiAvailable()) {
    log.info("🤖 AI verification is armed and configured via llm-provider.");
    return true;
  }
  log.warn("No AI API key or local endpoint configured. AI verification features will be disabled.");
  return false;
}`;

content = content.replace(validateRegex, validateReplacement);

fs.writeFileSync('src/services/video-verifier.ts', content);
