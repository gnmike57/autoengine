/**
 * Gaussian (Normal Distribution) RNG Utilities
 *
 * Anti-bot ML classifiers detect uniform distributions trivially.
 * Real human behavior follows Gaussian (bell-curve) distributions —
 * most actions cluster around the mean with rare outliers.
 *
 * Uses the Box-Muller transform to convert uniform Math.random()
 * pairs into normally distributed values.
 */

/**
 * Box-Muller Gaussian RNG.
 * Returns a single normally distributed value with the given mean and stddev.
 */
export function gaussianRandom(mean: number, stddev: number): number {
  // Box-Muller transform: two uniform randoms → one normal random
  let u1 = Math.random();
  const u2 = Math.random();
  // Guard against log(0)
  while (u1 === 0) u1 = Math.random();
  const z0 = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
  return mean + z0 * stddev;
}

/**
 * Gaussian with hard clamp to prevent extreme outliers.
 * Useful when values outside [min, max] would cause errors
 * (e.g. negative delays, coordinates off-screen).
 */
export function gaussianClamped(mean: number, stddev: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, gaussianRandom(mean, stddev)));
}

/**
 * Skewed Gaussian — models real humans who are *usually* fast but
 * occasionally pause (positive skew) or *usually* slow with rare
 * bursts of speed (negative skew).
 *
 * @param skew  Positive values create a right tail (occasional slow outliers).
 *              Negative values create a left tail (occasional fast outliers).
 *              Range: roughly -1.0 to 1.0 for useful results.
 */
export function gaussianSkewed(mean: number, stddev: number, skew: number = 0.3): number {
  const g = gaussianRandom(0, 1);
  // Skew transform: shifts the distribution asymmetrically
  const skewed = g + skew * (g * g - 1);
  return mean + skewed * stddev;
}

/**
 * Gaussian integer — returns a rounded, clamped Gaussian value.
 * Convenience for pixel coordinates, millisecond delays, etc.
 */
export function gaussianInt(mean: number, stddev: number, min: number, max: number): number {
  return Math.round(gaussianClamped(mean, stddev, min, max));
}

/**
 * Bimodal distribution — mix of two Gaussians.
 * Models behaviors that cluster around two peaks (e.g. fast OR slow,
 * center-click OR edge-click).
 *
 * @param weight1  Probability [0-1] of sampling from the first mode.
 */
export function bimodalGaussian(
  mean1: number, stddev1: number,
  mean2: number, stddev2: number,
  weight1: number = 0.7,
): number {
  return Math.random() < weight1
    ? gaussianRandom(mean1, stddev1)
    : gaussianRandom(mean2, stddev2);
}
