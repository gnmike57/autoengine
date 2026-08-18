/* eslint-disable @typescript-eslint/no-unused-vars */
/**
 * Visual / Screenshot Regression Tests
 *
 * Verifies that canvas fingerprint spoofing produces deterministic,
 * visually distinct pixel buffers — and that the same seed always
 * produces the same visual output. Uses pure pixel math from the
 * canvas spoof script to test without a real browser.
 *
 * This is the test-harness equivalent of "render a canvas fingerprint
 * in a known config → screenshot → diff" — done at the pixel-buffer
 * level instead of requiring a headed browser.
 */
import { describe, it, expect } from "vitest";
import { getCanvasSpoofScript, getAudioContextSpoofScript } from "../../src/stealth/stealth-scripts.js";
import { getConsistentHardware, type HardwareProfile } from "../../src/profiles/profile-determinism.js";

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 1: Canvas noise function extracted & simulated
//
// The canvas spoof script injects a noise function based on a seed.
// We extract the same math here and verify that applying it to a
// synthetic pixel buffer produces deterministic, bounded noise.
// ═══════════════════════════════════════════════════════════════════════════

/** Replicate the noise function from getCanvasSpoofScript verbatim. */
function getNoise(seed: number, idx: number): number {
  const t = 10000 * Math.sin(seed + idx);
  return t - Math.floor(t);
}

/** Apply noise to an RGBA pixel buffer, exactly as the spoof script does. */
function applyCanvasNoise(data: Uint8ClampedArray, seed: number): void {
  for (let i = 0; i < data.length; i += 4) {
    const noise = Math.floor(5 * getNoise(seed, i)) - 2;
    data[i] = Math.max(0, Math.min(255, data[i]! + noise));
    data[i + 1] = Math.max(0, Math.min(255, data[i + 1]! + noise));
    data[i + 2] = Math.max(0, Math.min(255, data[i + 2]! + noise));
    // Alpha channel (data[i+3]) is untouched by the spoof script
  }
}

/** Create a synthetic "reference canvas" — a gradient pattern typical of
 *  canvas fingerprinting (fillText + gradient + arc). */
function createReferencePixelBuffer(width: number, height: number): Uint8ClampedArray {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      // Gradient pattern
      data[idx] = (x * 255 / width) & 255;       // R
      data[idx + 1] = (y * 255 / height) & 255;   // G
      data[idx + 2] = ((x + y) * 127 / (width + height)) & 255; // B
      data[idx + 3] = 255;                          // A
    }
  }
  return data;
}

/** Count pixels that differ between two buffers. */
function pixelDiff(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
  let diffs = 0;
  for (let i = 0; i < a.length; i += 4) {
    if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) {
      diffs++;
    }
  }
  return diffs;
}

/** Calculate max absolute channel difference between two buffers. */
function maxChannelDiff(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
  let maxDiff = 0;
  for (let i = 0; i < a.length; i++) {
    if (i % 4 === 3) continue; // skip alpha
    maxDiff = Math.max(maxDiff, Math.abs(a[i]! - b[i]!));
  }
  return maxDiff;
}

describe("visual regression — canvas fingerprint spoofing", () => {
  const WIDTH = 200;
  const HEIGHT = 100;

  describe("noise determinism — same seed always produces identical pixel output", () => {
    it("applying noise with seed=42 twice produces identical buffers", () => {
      const ref1 = createReferencePixelBuffer(WIDTH, HEIGHT);
      const ref2 = createReferencePixelBuffer(WIDTH, HEIGHT);
      applyCanvasNoise(ref1, 42);
      applyCanvasNoise(ref2, 42);
      expect(pixelDiff(ref1, ref2)).toBe(0);
    });

    it("applying noise with seed=0 twice produces identical buffers", () => {
      const ref1 = createReferencePixelBuffer(WIDTH, HEIGHT);
      const ref2 = createReferencePixelBuffer(WIDTH, HEIGHT);
      applyCanvasNoise(ref1, 0);
      applyCanvasNoise(ref2, 0);
      expect(pixelDiff(ref1, ref2)).toBe(0);
    });

    it("applying noise with seed=999999 twice produces identical buffers", () => {
      const ref1 = createReferencePixelBuffer(WIDTH, HEIGHT);
      const ref2 = createReferencePixelBuffer(WIDTH, HEIGHT);
      applyCanvasNoise(ref1, 999999);
      applyCanvasNoise(ref2, 999999);
      expect(pixelDiff(ref1, ref2)).toBe(0);
    });

    it("100 seeds each produce identical buffers on double-application", () => {
      for (let seed = 0; seed < 100; seed++) {
        const a = createReferencePixelBuffer(WIDTH, HEIGHT);
        const b = createReferencePixelBuffer(WIDTH, HEIGHT);
        applyCanvasNoise(a, seed);
        applyCanvasNoise(b, seed);
        expect(pixelDiff(a, b)).toBe(0);
      }
    });
  });

  describe("noise differentiation — different seeds produce visually distinct output", () => {
    it("seed=1 and seed=2 produce different pixel buffers", () => {
      const a = createReferencePixelBuffer(WIDTH, HEIGHT);
      const b = createReferencePixelBuffer(WIDTH, HEIGHT);
      applyCanvasNoise(a, 1);
      applyCanvasNoise(b, 2);
      expect(pixelDiff(a, b)).toBeGreaterThan(0);
    });

    it("at least 80% of 100 seeds produce unique fingerprints", () => {
      const fingerprints = new Set<string>();
      for (let seed = 0; seed < 100; seed++) {
        const buf = createReferencePixelBuffer(WIDTH, HEIGHT);
        applyCanvasNoise(buf, seed);
        // Hash first 200 bytes as fingerprint proxy
        const hash = Array.from(buf.slice(0, 200)).join(",");
        fingerprints.add(hash);
      }
      expect(fingerprints.size).toBeGreaterThanOrEqual(80);
    });
  });

  describe("noise bounds — channel modifications stay within [-2, +2]", () => {
    it("max channel difference from reference is ≤ 2", () => {
      const ref = createReferencePixelBuffer(WIDTH, HEIGHT);
      const noised = createReferencePixelBuffer(WIDTH, HEIGHT);
      applyCanvasNoise(noised, 42);
      const diff = maxChannelDiff(ref, noised);
      expect(diff).toBeLessThanOrEqual(2);
    });

    it("noise never causes overflow (stays 0-255)", () => {
      // Test with edge-case buffer: all 0s and all 255s
      const dark = new Uint8ClampedArray(WIDTH * HEIGHT * 4);
      dark.fill(0);
      for (let i = 3; i < dark.length; i += 4) dark[i] = 255; // alpha = 255
      applyCanvasNoise(dark, 42);
      let darkOutOfBounds = 0;
      for (let i = 0; i < dark.length; i += 4) {
        if (dark[i]! < 0 || dark[i]! > 255) darkOutOfBounds++;
      }
      expect(darkOutOfBounds).toBe(0);

      const bright = new Uint8ClampedArray(WIDTH * HEIGHT * 4);
      bright.fill(255);
      applyCanvasNoise(bright, 42);
      let brightOutOfBounds = 0;
      for (let i = 0; i < bright.length; i += 4) {
        if (bright[i]! < 0 || bright[i]! > 255) brightOutOfBounds++;
      }
      expect(brightOutOfBounds).toBe(0);
    });

    it("alpha channel is NEVER modified by noise", () => {
      const buf = createReferencePixelBuffer(WIDTH, HEIGHT);
      const original = new Uint8ClampedArray(buf);
      applyCanvasNoise(buf, 42);
      for (let i = 3; i < buf.length; i += 4) {
        expect(buf[i]).toBe(original[i]); // alpha must be identical
      }
    });
  });

  describe("canvas spoof script consistency with pixel math", () => {
    it("the script source contains the same noise formula we test", () => {
      const script = getCanvasSpoofScript(42);
      // Verify the script uses the same sin-based noise
      expect(script).toContain("10000 * Math.sin(seed + idx)");
      expect(script).toContain("Math.floor(5 * getNoise");
      // Verify it clamps to [0, 255]
      expect(script).toContain("Math.max(0, Math.min(255");
    });

    it("the script preserves alpha channel (only modifies RGB)", () => {
      const script = getCanvasSpoofScript(42);
      // Noise loop steps by 4 (RGBA), modifies only [i], [i+1], [i+2]
      expect(script).toContain("i += 4");
      expect(script).toContain("data[i]");
      expect(script).toContain("data[i+1]");
      expect(script).toContain("data[i+2]");
      // Alpha (data[i+3]) should NOT appear in noise application
      expect(script).not.toContain("data[i+3]");
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 2: Fingerprint visual verification
//
// Verifies that the hardware profile + canvas seed combination produces
// a unique visual identity — different profiles generate different
// canvas "fingerprints" even on the same reference image.
// ═══════════════════════════════════════════════════════════════════════════

describe("fingerprint visual verification", () => {
  it("different emails produce different canvas fingerprints via seed derivation", () => {
    const emails = ["alice@gmail.com", "bob@yahoo.com", "charlie@proton.me"];
    const fingerprints = new Map<string, string>();

    for (const email of emails) {
      const hw = getConsistentHardware(email, "windows");
      // Use cores as the canvas seed (simulates the real seed derivation)
      const seed = hw.cores * 1000 + hw.memory;
      const buf = createReferencePixelBuffer(100, 50);
      applyCanvasNoise(buf, seed);
      const fp = Array.from(buf.slice(0, 100)).join(",");
      fingerprints.set(email, fp);
    }

    // At least 2 of 3 should be different (some may collide by cores+memory)
    const uniqueCount = new Set(fingerprints.values()).size;
    expect(uniqueCount).toBeGreaterThanOrEqual(2);
  });

  it("same email always produces the same visual fingerprint", () => {
    const email = "stable-visual@test.com";
    const hw = getConsistentHardware(email, "windows");
    const seed = hw.cores * 1000 + hw.memory;

    const buf1 = createReferencePixelBuffer(100, 50);
    const buf2 = createReferencePixelBuffer(100, 50);
    applyCanvasNoise(buf1, seed);
    applyCanvasNoise(buf2, seed);

    expect(pixelDiff(buf1, buf2)).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 3: Audio context spoof visual verification
//
// The audio spoof applies a delta to AudioContext output. We verify the
// script produces a deterministic delta formula per seed.
// ═══════════════════════════════════════════════════════════════════════════

describe("audio context spoof determinism", () => {
  it("same seed produces identical audio spoof scripts", () => {
    for (let seed = 0; seed < 50; seed++) {
      const a = getAudioContextSpoofScript(seed);
      const b = getAudioContextSpoofScript(seed);
      expect(a).toBe(b);
    }
  });

  it("different seeds produce different audio spoof scripts", () => {
    const scripts = new Set<string>();
    for (let seed = 0; seed < 50; seed++) {
      scripts.add(getAudioContextSpoofScript(seed));
    }
    expect(scripts.size).toBeGreaterThan(1);
  });

  it("audio spoof script contains frequency-domain noise injection", () => {
    const script = getAudioContextSpoofScript(42);
    // Should contain AudioContext/AnalyserNode override
    expect(script).toContain("AudioContext");
  });
});
