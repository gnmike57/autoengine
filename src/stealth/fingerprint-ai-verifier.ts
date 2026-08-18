/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from "../core/logger.js";
import { askLlama } from "../core/ollama-client.js";
import { type ProfileBundle } from "../profiles/profile-validator.js";

const log = createLogger("fingerprint-ai");

const CACHE_FILE = path.resolve(process.cwd(), "fingerprint-ai-cache.json");
export interface AiFingerprintCheck {
  coherent: boolean;
  mismatches: string[];
  fixSuggestions: Record<string, string>;
  modelUsed: string;
}

// In-memory cache loaded from disk
let aiCheckCache: Record<string, AiFingerprintCheck> = {};
try {
  if (fs.existsSync(CACHE_FILE)) {
    aiCheckCache = JSON.parse(fs.readFileSync(CACHE_FILE, "utf-8"));
  }
} catch (e) {
  log.warn(`Failed to load AI fingerprint cache: ${String(e)}`);
}

function saveCache() {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(aiCheckCache, null, 2), "utf-8");
  } catch (e) {
    log.warn(`Failed to save AI fingerprint cache: ${String(e)}`);
  }
}

const VERIFICATION_PROMPT = `You are a bot-detection bypass engineer analyzing a browser fingerprint bundle.
Your task is to ensure the generated fingerprint components are fully coherent and look like a real, naturally occurring user session.

Analyze the provided JSON fingerprint bundle and cross-check the following for consistency:
1. User-Agent vs OS/Platform: Does the UA match the OS, and does the hardware (cores/memory/GPU) match the OS? (e.g., Apple Silicon on Mac, no NVIDIA on Mac).
2. Resolution vs Device Type: Is a desktop UA paired with a mobile resolution, or vice versa?
3. Geolocation vs Proxy: Does the timezone and locale align with the country implied by the proxy?
4. WebGL renderer vs OS: Does the GPU vendor/renderer make sense for the claimed OS?
5. Font list vs OS: Are the listed fonts appropriate for the claimed operating system?
6. Client Hints vs UA: Do sec-ch-ua brands match the claimed Chrome version?

Return a JSON verdict with:
- "coherent" (boolean): true if the fingerprint looks perfectly natural, false if it has obvious mismatches.
- "mismatches" (array of strings): List of specific inconsistencies found. Empty if perfectly coherent.
- "fixSuggestions" (object): Key-value pairs of suggested overrides to fix the profile (e.g., {"osProfile": "windows", "gpu": "Intel Iris Plus"}). Empty if coherent.

Only output valid JSON matching this schema. Focus only on obvious "bot" tells — minor imperfections that real users also have are fine.`;

export async function verifyFingerprintCoherence(
  bundle: ProfileBundle
): Promise<AiFingerprintCheck> {
  // Generate a cache key from the bundle contents
  const bundleStr = JSON.stringify(bundle);
  const cacheKey = simpleHash(bundleStr);

  // Return cached result if available
  if (aiCheckCache[cacheKey]) {
    log.debug(`AI fingerprint check cache hit for ${cacheKey}`);
    return aiCheckCache[cacheKey];
  }

  try {
    let parsed: any;
    try {
      const prompt = `Analyze this browser fingerprint bundle for coherence:\n\n${JSON.stringify(bundle, null, 2)}\n\n${VERIFICATION_PROMPT}`;
      const responseText = await askLlama(prompt, undefined, true);
      parsed = JSON.parse(responseText.trim());
    } catch {
      log.warn(`AI fingerprint response not valid JSON`);
      return { coherent: true, mismatches: [], fixSuggestions: {}, modelUsed: "bypassed" };
    }

    const check: AiFingerprintCheck = {
      coherent: parsed.coherent === true,
      mismatches: Array.isArray(parsed.mismatches) ? parsed.mismatches : [],
      fixSuggestions: typeof parsed.fixSuggestions === "object" ? parsed.fixSuggestions : {},
      modelUsed: "llama3",
    };

    // Cache the result
    aiCheckCache[cacheKey] = check;
    saveCache();

    if (!check.coherent) {
      log.warn(
        `⚠ Fingerprint INCOHERENT — ${check.mismatches.length} mismatch(es): ` +
        check.mismatches.join("; ")
      );
    } else {
      log.info(`✓ Fingerprint coherent (verified by llama3)`);
    }

    return check;
  } catch (err) {
    log.warn(`AI fingerprint verification failed: ${err instanceof Error ? err.message : String(err)}`);
    return { coherent: true, mismatches: [], fixSuggestions: {}, modelUsed: "error" };
  }
}

/** Simple string hash for cache keys */
function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0; // Convert to 32-bit integer
  }
  return `fp-${Math.abs(hash).toString(36)}`;
}