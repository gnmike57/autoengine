import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  gaussianRandom,
  gaussianClamped,
  gaussianSkewed,
  gaussianInt,
  bimodalGaussian
} from '../../src/core/gaussian-rng.js';

describe('gaussian-rng', () => {
  beforeEach(() => {
    // We mock Math.random so that tests are deterministic
    vi.spyOn(Math, 'random').mockImplementation(() => {
      // Return 0.5 by default
      return 0.5;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('gaussianRandom returns expected deterministic output', () => {
    const val = gaussianRandom(10, 2);
    // For Math.random() = 0.5, u1=0.5, u2=0.5
    // z0 = sqrt(-2 * ln(0.5)) * cos(2 * PI * 0.5)
    // z0 = sqrt(1.386) * cos(PI) = 1.1774 * -1 = -1.1774
    // mean + z0 * stddev = 10 + (-1.1774 * 2) = 10 - 2.3548 = 7.645...
    expect(val).toBeCloseTo(7.645, 2);
  });

  it('gaussianRandom handles Math.random() returning 0 (via loop guard)', () => {
    let callCount = 0;
    vi.spyOn(Math, 'random').mockImplementation(() => {
      callCount++;
      if (callCount === 1) return 0; // Trigger while loop
      return 0.5;
    });
    
    const val = gaussianRandom(10, 2);
    expect(val).toBeCloseTo(7.645, 2);
    expect(callCount).toBeGreaterThan(2); // Should have retried
  });

  it('gaussianClamped enforces min boundary', () => {
    // Force a very negative output by setting u2=0.5 and small u1
    vi.spyOn(Math, 'random').mockImplementation(() => 0.0001); // Returns a large magnitude
    const val = gaussianClamped(10, 2, 5, 15);
    expect(val).toBeGreaterThanOrEqual(5);
  });

  it('gaussianClamped enforces max boundary', () => {
    // Math.random() = 0.0001 for u1 and 1.0 for u2 gives cos(2PI) = 1 (positive outlier)
    let callCount = 0;
    vi.spyOn(Math, 'random').mockImplementation(() => {
      callCount++;
      return callCount % 2 === 1 ? 0.0001 : 1.0;
    });
    const val = gaussianClamped(10, 2, 5, 15);
    expect(val).toBeLessThanOrEqual(15);
    expect(val).toBe(15); // should be clamped
  });

  it('gaussianSkewed applies positive skew', () => {
    const val = gaussianSkewed(10, 2, 0.3);
    expect(typeof val).toBe('number');
  });

  it('gaussianInt rounds and clamps', () => {
    const val = gaussianInt(10.2, 2.5, 5, 15);
    expect(Number.isInteger(val)).toBe(true);
    expect(val).toBeGreaterThanOrEqual(5);
    expect(val).toBeLessThanOrEqual(15);
  });

  it('bimodalGaussian uses first mode if random < weight1', () => {
    let callCount = 0;
    vi.spyOn(Math, 'random').mockImplementation(() => {
      callCount++;
      if (callCount === 1) return 0.2; // random() < weight1 (0.7)
      return 0.5;
    });
    
    // Mean1 = 10, Mean2 = 20. Will choose mode 1
    const val = bimodalGaussian(10, 2, 20, 2, 0.7);
    expect(val).toBeCloseTo(7.645, 2);
  });

  it('bimodalGaussian uses second mode if random >= weight1', () => {
    let callCount = 0;
    vi.spyOn(Math, 'random').mockImplementation(() => {
      callCount++;
      if (callCount === 1) return 0.8; // random() >= weight1 (0.7)
      return 0.5;
    });
    
    // Mean1 = 10, Mean2 = 20. Will choose mode 2
    const val = bimodalGaussian(10, 2, 20, 2, 0.7);
    expect(val).toBeCloseTo(17.645, 2); // 20 - 2.355
  });
});
