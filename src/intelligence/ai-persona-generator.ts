/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/**
 * AI-Driven Behavioral Profile Generation — Improvement #5
 *
 * Uses Gemini to generate persona-based behavioral parameters:
 * typing speed, mouse speed, scroll patterns, reading speed, error rates.
 * Each email seed gets a unique, realistic persona that feeds into
 * the Gaussian RNG distributions for typing, mouse, and scroll behaviors.
 *
 * Results are cached per email seed to avoid repeated API calls.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from "../core/logger.js";
import { askLlama } from "../core/ollama-client.js";
import { z } from "zod";

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

const personaSchema = z.object({
  typingWpm: z.number().default(45).transform(v => clamp(v, 20, 100)),
  baseKeyDelayMs: z.number().default(100).transform(v => clamp(v, 40, 250)),
  mouseSpeedMultiplier: z.number().default(1.0).transform(v => clamp(v, 0.4, 1.8)),
  scrollSpeedMultiplier: z.number().default(1.0).transform(v => clamp(v, 0.3, 2.0)),
  readingMsPerWord: z.number().default(250).transform(v => clamp(v, 100, 500)),
  typoRate: z.number().default(0.03).transform(v => clamp(v, 0.005, 0.10)),
  pauseTendency: z.number().default(0.3).transform(v => clamp(v, 0.05, 0.8)),
  mouseJitter: z.number().default(0.6).transform(v => clamp(v, 0.2, 1.8)),
  personaDescription: z.string().default("AI-generated persona"),
});

const log = createLogger("ai-persona");

const CACHE_FILE = path.resolve(process.cwd(), "persona-cache.json");
export interface BehavioralPersona {
  /** Words per minute for typing (30-90 range) */
  typingWpm: number;
  /** Base inter-key delay in ms */
  baseKeyDelayMs: number;
  /** Mouse speed multiplier (0.5 = slow, 1.0 = normal, 1.5 = fast) */
  mouseSpeedMultiplier: number;
  /** Scroll speed multiplier */
  scrollSpeedMultiplier: number;
  /** Reading speed — ms per word on screen */
  readingMsPerWord: number;
  /** Probability of typing error (0.01-0.08) */
  typoRate: number;
  /** Tendency to pause while typing (0.0-1.0) */
  pauseTendency: number;
  /** How erratic mouse movements are (0.3-1.5) */
  mouseJitter: number;
  /** Generated persona description */
  personaDescription: string;
  /** Whether this was AI-generated or fallback */
  source: "ai" | "fallback";
}

// In-memory cache loaded from disk
let personaCache: Record<string, BehavioralPersona> = {};
try {
  if (fs.existsSync(CACHE_FILE)) {
    personaCache = JSON.parse(fs.readFileSync(CACHE_FILE, "utf-8"));
  }
} catch (e) {
  log.warn(`Failed to load persona cache: ${String(e)}`);
}

function saveCache() {
  try {
    const keys = Object.keys(personaCache);
    if (keys.length > 10000) {
      const toDelete = keys.slice(0, keys.length - 10000);
      for (const k of toDelete) delete personaCache[k];
    }
    fs.writeFileSync(CACHE_FILE, JSON.stringify(personaCache, null, 2), "utf-8");
  } catch (e) {
    log.warn(`Failed to save persona cache: ${String(e)}`);
  }
}

const PERSONA_PROMPT = `You are generating realistic browser interaction behavioral parameters for a simulated human user.

Create a believable persona with natural browsing characteristics. The persona should feel like a real person — not a power user, not unusually slow, just normal human variation.

Generate the following parameters:
- typingWpm: Words per minute (realistic range: 25 for elderly/non-native to 85 for fast typist. Average: 40-55)
- baseKeyDelayMs: Milliseconds between keystrokes (derived from WPM but with personality. 70-200ms range)
- mouseSpeedMultiplier: How fast they move the mouse (0.6 = deliberate/careful, 1.0 = average, 1.4 = quick/impatient)
- scrollSpeedMultiplier: How fast they scroll (0.5 = reads carefully, 1.0 = normal, 1.5 = skims)
- readingMsPerWord: How long they spend per word when reading (150-400ms)
- typoRate: Probability of making a typo per character (0.01 = careful, 0.06 = sloppy)
- pauseTendency: How often they pause mid-action (0.1 = focused, 0.7 = easily distracted)
- mouseJitter: How shaky/imprecise their mouse movements are (0.3 = precise gamer, 1.2 = elderly/touchpad)
- personaDescription: One-sentence description of this persona (e.g., "A 45-year-old office worker browsing during lunch break on a Windows laptop")

Make the parameters internally consistent — e.g., a fast typist should have low baseKeyDelayMs, a careful reader should have high readingMsPerWord and low scrollSpeedMultiplier.

Return ONLY valid JSON.`;

/**
 * Generate or retrieve a behavioral persona for an email seed.
 * Uses AI when available, falls back to deterministic generation from seed.
 */
export async function getPersona(emailSeed: number): Promise<BehavioralPersona> {
  const cacheKey = `persona-${emailSeed}`;

  // Return cached persona
  if (personaCache[cacheKey]) {
    return personaCache[cacheKey];
  }

  // Try AI generation using Local Llama3
  try {
    const persona = await generateAiPersona(emailSeed);
    personaCache[cacheKey] = persona;
    saveCache();
    log.info(`🤖 AI Persona generated: ${persona.personaDescription} (WPM=${persona.typingWpm}, mouse=${persona.mouseSpeedMultiplier.toFixed(2)})`);
    return persona;
  } catch (err) {
    log.warn(`AI persona generation failed, using fallback: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Deterministic fallback from seed
  const fallback = generateFallbackPersona(emailSeed);
  personaCache[cacheKey] = fallback;
  saveCache();
  return fallback;
}

async function generateAiPersona(seed: number): Promise<BehavioralPersona> {
  const resultText = await askLlama(`Seed: ${seed}\n\n${PERSONA_PROMPT}`, undefined, true);

  // Parse raw JSON, will throw if invalid format
  const parsedData = JSON.parse(resultText.trim());

  // Validate with defaults and clamp bounds
  const parsed = personaSchema.parse(parsedData);

  return {
    ...parsed,
    source: "ai",
  };
}

/**
 * Deterministic fallback persona generation from seed.
 * Uses hash-based distribution to create varied but consistent personas.
 */
function generateFallbackPersona(seed: number): BehavioralPersona {
  // Use seed to deterministically generate persona parameters
  const h = (offset: number) => {
    const x = Math.sin(seed + offset) * 10000;
    return x - Math.floor(x); // 0-1 range
  };

  const typingWpm = Math.round(30 + h(1) * 50); // 30-80
  const baseKeyDelayMs = Math.round(60000 / (typingWpm * 5)); // Derived from WPM

  return {
    typingWpm,
    baseKeyDelayMs,
    mouseSpeedMultiplier: 0.6 + h(2) * 0.8, // 0.6-1.4
    scrollSpeedMultiplier: 0.5 + h(3) * 1.0, // 0.5-1.5
    readingMsPerWord: Math.round(150 + h(4) * 250), // 150-400
    typoRate: 0.01 + h(5) * 0.05, // 0.01-0.06
    pauseTendency: 0.1 + h(6) * 0.5, // 0.1-0.6
    mouseJitter: 0.3 + h(7) * 0.9, // 0.3-1.2
    personaDescription: `Deterministic persona (seed ${seed})`,
    source: "fallback",
  };
}
