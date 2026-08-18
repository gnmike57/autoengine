/**
 * Time-of-Day Behavioral Profile
 *
 * Real users are slower and sloppier late at night, and faster during
 * business hours. Anti-bot systems correlate behavioral speed with
 * session timestamps — a uniform speed profile across all hours is
 * a known anomaly signal.
 *
 * This module exports a multiplier applied to all timing values
 * (keystroke delays, hover dwell, inter-action pauses) so sessions
 * at 3 AM are naturally 20-40% slower than sessions at 2 PM.
 */

import { gaussianClamped } from "../core/gaussian-rng.js";

/**
 * Get a speed multiplier based on the current hour.
 * Values > 1.0 = slower (longer delays). Values < 1.0 = faster.
 *
 * Distribution by hour:
 *   01:00–05:00  → 1.2–1.6  (night owl: tired, slow, sloppy)
 *   06:00–08:00  → 1.0–1.2  (early morning: warming up)
 *   09:00–12:00  → 0.8–1.0  (peak focus: fast and accurate)
 *   13:00–14:00  → 1.0–1.15 (post-lunch dip)
 *   15:00–17:00  → 0.85–1.0 (afternoon focus)
 *   18:00–21:00  → 0.95–1.15 (evening: relaxed browsing)
 *   22:00–00:00  → 1.1–1.4  (getting tired)
 */
export function getTimeOfDayMultiplier(): number {
  const hour = new Date().getHours();

  if (hour >= 1 && hour <= 5) {
    return gaussianClamped(1.4, 0.15, 1.15, 1.7);     // night: slow & sloppy
  }
  if (hour >= 6 && hour <= 8) {
    return gaussianClamped(1.1, 0.08, 0.95, 1.25);     // early morning
  }
  if (hour >= 9 && hour <= 12) {
    return gaussianClamped(0.9, 0.08, 0.75, 1.05);     // peak focus
  }
  if (hour >= 13 && hour <= 14) {
    return gaussianClamped(1.05, 0.06, 0.92, 1.2);     // post-lunch
  }
  if (hour >= 15 && hour <= 17) {
    return gaussianClamped(0.92, 0.07, 0.8, 1.05);     // afternoon focus
  }
  if (hour >= 18 && hour <= 21) {
    return gaussianClamped(1.05, 0.08, 0.9, 1.2);      // evening
  }
  if (hour >= 22 || hour === 0) {
    return gaussianClamped(1.25, 0.12, 1.05, 1.5);     // late night
  }
  // Fallback — should never reach here
  return gaussianClamped(1.0, 0.1, 0.8, 1.2);
}

/**
 * Get a "sloppiness" factor based on time of day.
 * Higher values = more likely to make typos, overshoot clicks, etc.
 * Range: 0.0 (precise) to 1.0 (sloppy).
 */
export function getTimeOfDaySloppiness(): number {
  const hour = new Date().getHours();

  if (hour >= 1 && hour <= 5) {
    return gaussianClamped(0.6, 0.15, 0.3, 0.85);      // very sloppy at night
  }
  if (hour >= 9 && hour <= 12) {
    return gaussianClamped(0.15, 0.08, 0.02, 0.35);    // precise during work
  }
  if (hour >= 22 || hour === 0) {
    return gaussianClamped(0.4, 0.12, 0.15, 0.65);     // getting sloppy
  }
  return gaussianClamped(0.25, 0.1, 0.05, 0.45);       // default moderate
}
