/**
 * Page Interaction Patterns
 * Per-credential mouse/typing behaviour profile. Same email → same persona.
 *
 * Goal: defeat behaviour-cluster detection that flags swarms of accounts
 * sharing identical click cadence and typing speed. cloakbrowser's `humanize`
 * gives us realistic mouse curves; this layer adds per-persona timing
 * variance on top (delays between actions, per-keystroke pacing, hover
 * dwell time, scroll jitter).
 *
 * All jitter/variance now uses Gaussian (bell-curve) distributions instead
 * of uniform Math.random(). Real human behavior clusters around the mean
 * with rare outliers — uniform distributions are trivially detectable
 * by anti-bot ML classifiers.
 */

import * as crypto from "crypto";
import { gaussianClamped, gaussianSkewed } from "../core/gaussian-rng.js";

export type MouseSpeed = "slow" | "normal" | "fast";
export type TypingSpeed = "hunt-peck" | "normal" | "fluent";

export interface InteractionPattern {
  name: string;                 // human label, e.g. "deliberate-typer"
  mouseSpeed: MouseSpeed;
  typingSpeed: TypingSpeed;
  /** Base ms between successive UI actions (jittered ±50% at call time). */
  pauseFrequency: number;
  /** Pixel deviation injected into mouse hover targets. */
  jitterAmount: number;
  /** Mean ms between keystrokes (Playwright `delay` param). */
  keystrokeDelayMs: number;
  /** ms to dwell on hover before clicking. */
  hoverDwellMs: number;
}

const PATTERNS: InteractionPattern[] = [
  {
    name: "deliberate-typer",
    mouseSpeed: "slow", typingSpeed: "hunt-peck",
    pauseFrequency: 320, jitterAmount: 6,
    keystrokeDelayMs: 140, hoverDwellMs: 280,
  },
  {
    name: "average-user",
    mouseSpeed: "normal", typingSpeed: "normal",
    pauseFrequency: 160, jitterAmount: 3,
    keystrokeDelayMs: 70, hoverDwellMs: 140,
  },
  {
    name: "power-user",
    mouseSpeed: "fast", typingSpeed: "fluent",
    pauseFrequency: 80, jitterAmount: 1,
    keystrokeDelayMs: 35, hoverDwellMs: 70,
  },
  {
    name: "cautious-newcomer",
    mouseSpeed: "slow", typingSpeed: "hunt-peck",
    pauseFrequency: 400, jitterAmount: 8,
    keystrokeDelayMs: 170, hoverDwellMs: 350,
  },
  {
    name: "impatient-rusher",
    mouseSpeed: "fast", typingSpeed: "fluent",
    pauseFrequency: 60, jitterAmount: 2,
    keystrokeDelayMs: 28, hoverDwellMs: 55,
  },
  {
    name: "distracted-multitasker",
    mouseSpeed: "normal", typingSpeed: "normal",
    pauseFrequency: 250, jitterAmount: 5,
    keystrokeDelayMs: 95, hoverDwellMs: 200,
  },
  {
    name: "mobile-crossover",
    mouseSpeed: "slow", typingSpeed: "normal",
    pauseFrequency: 200, jitterAmount: 7,
    keystrokeDelayMs: 110, hoverDwellMs: 180,
  },
  {
    name: "confident-regular",
    mouseSpeed: "fast", typingSpeed: "fluent",
    pauseFrequency: 100, jitterAmount: 2,
    keystrokeDelayMs: 45, hoverDwellMs: 90,
  },
];

function hashEmail(email: string): number {
  const normalized = email.trim().toLowerCase();
  const digest = crypto.createHash("sha256").update(normalized).digest();
  return digest.readUInt32BE(0);
}

/**
 * Get the deterministic interaction pattern for an email.
 * Same email → same pattern every call.
 */
export function getInteractionPattern(email: string, requeueCount: number = 0): InteractionPattern {
  const idx = hashEmail(email) % PATTERNS.length;
  const base = { ...PATTERNS[idx] } as InteractionPattern;

  if (requeueCount > 0) {
    const seed = hashEmail(email + "-retry-" + requeueCount);
    // Deterministic shift between -0.15 and +0.15
    const shift = -0.15 + (seed % 31) / 100.0;

    base.pauseFrequency = Math.max(20, Math.round(base.pauseFrequency * (1 + shift)));
    base.keystrokeDelayMs = Math.max(10, Math.round(base.keystrokeDelayMs * (1 + shift)));
    base.hoverDwellMs = Math.max(20, Math.round(base.hoverDwellMs * (1 + shift)));
  }

  return base;
}

/**
 * Logged variant — returns the pattern and emits a one-line summary.
 */
export function getInteractionPatternWithLog(
  email: string,
  logFn?: (msg: string) => void,
  requeueCount: number = 0
): InteractionPattern {
  const p = getInteractionPattern(email, requeueCount);
  const msg = `Interaction: ${email} → ${p.name} (mouse=${p.mouseSpeed}, type=${p.typingSpeed}, kbd=${p.keystrokeDelayMs}ms)${requeueCount > 0 ? ` [shifted by requeue ${requeueCount}]` : ''}`;
  if (logFn) logFn(msg);
  return p;
}

/**
 * Compute a randomized inter-action pause for this pattern.
 * Uses Gaussian distribution centered on `pauseFrequency` with
 * stddev = 35% of base. Most pauses cluster near the mean;
 * occasional outliers simulate distraction or impatience.
 */
export function getActionDelayMs(pattern: InteractionPattern): number {
  const base = pattern.pauseFrequency;
  return Math.max(20, Math.round(gaussianSkewed(base, base * 0.35, 0.2)));
}

/**
 * Compute a per-keystroke delay for `page.type(..., { delay })`.
 * Gaussian distribution with positive skew (occasional long pauses
 * simulating mid-word thinking). Stddev = 30% of base.
 */
export function getKeystrokeDelayMs(pattern: InteractionPattern): number {
  const base = pattern.keystrokeDelayMs;
  return Math.max(8, Math.round(gaussianSkewed(base, base * 0.3, 0.25)));
}

/**
 * Compute a hover dwell time before a click.
 * Power users barely linger; deliberate users sit on the button for ~300ms.
 * Gaussian with positive skew — occasional long hover = hesitation.
 */
export function getHoverDwellMs(pattern: InteractionPattern): number {
  const base = pattern.hoverDwellMs;
  return Math.max(15, Math.round(gaussianSkewed(base, base * 0.35, 0.3)));
}

/**
 * Pixel offset to apply to a click/hover target so coordinates aren't
 * perfectly centred (real users miss centre by a few pixels).
 *
 * Uses 2D Gaussian: Y-axis is tighter than X-axis because humans are
 * more precise vertically than horizontally. Occasional outliers from
 * the Gaussian tail simulate hurried/sloppy clicks.
 */
export function getCursorJitter(pattern: InteractionPattern): { dx: number; dy: number } {
  const j = pattern.jitterAmount;
  if (j <= 0) return { dx: 0, dy: 0 };
  return {
    dx: Math.round(gaussianClamped(0, j * 0.6, -j * 2, j * 2)),
    dy: Math.round(gaussianClamped(0, j * 0.4, -j * 1.5, j * 1.5)),
  };
}

/** All known patterns, for tests / diagnostics. */
export function listInteractionPatterns(): readonly InteractionPattern[] {
  return PATTERNS;
}

/** Number of patterns in the rotation. */
export function getInteractionPatternPoolSize(): number {
  return PATTERNS.length;
}
