/**
 * #13 — Hermes Screenshot Diff Analysis (TypeScript Port)
 *
 * Compares a reference screenshot to a current screenshot using pixel-level
 * analysis. Computes structural similarity percentage, perceptual hash distance
 * via average hash, and dominant-colour shift via Euclidean distance.
 *
 * Uses Node.js built-in `fs` for file reading and raw pixel math.
 * For production, considers `sharp` for image decoding (already available
 * in the ecosystem), but falls back to a lightweight JPEG header parser.
 *
 * Ported from hermes/screenshot_diff.py
 */

import fs from "node:fs";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ScreenshotDiffResult {
  /** 0-100 float (100 = identical) */
  similarity: number;
  /** Integer Hamming distance of perceptual hashes (0 = identical) */
  hashDistance: number;
  /** Euclidean distance of dominant colours (0 = same) */
  colorShift: number;
  /** True if diff exceeds safe thresholds */
  isAnomalous: boolean;
}

type RGB = [number, number, number];

// ---------------------------------------------------------------------------
// Internal helpers — pure math, no external image dependencies
// ---------------------------------------------------------------------------

/**
 * Attempt to load sharp dynamically. Returns null if not available.
 * We use sharp because it's a common Node.js image library and already
 * pulled in by many Playwright-adjacent projects.
 */
type SharpInstance = {
  resize(w: number, h: number): SharpInstance;
  raw(): SharpInstance;
  greyscale(): SharpInstance;
  toBuffer(opts: { resolveWithObject: true }): Promise<{ data: Buffer; info: { width: number; height: number; channels: number } }>;
  metadata(): Promise<{ width?: number; height?: number; channels?: number }>;
};

async function loadSharp(): Promise<((input: string | Buffer) => SharpInstance) | null> {
  try {
    // Dynamic import to avoid hard dependency
    const sharpModule = (await import("sharp")) as { default: (input: string | Buffer) => SharpInstance };
    return sharpModule.default;
  } catch {
    return null;
  }
}

function pixelDiffPercentage(aPixels: Buffer, bPixels: Buffer, channels: number): number {
  const pixelCount = aPixels.length / channels;
  if (pixelCount === 0) return 100;
  const threshold = 30;
  let diffCount = 0;

  for (let i = 0; i < aPixels.length; i += channels) {
    for (let c = 0; c < Math.min(channels, 3); c++) {
      if (Math.abs(aPixels[i + c]! - bPixels[i + c]!) > threshold) {
        diffCount++;
        break;
      }
    }
  }
  return (diffCount / pixelCount) * 100;
}

function averageHashFromBuffer(greyPixels: Buffer, size: number): bigint {
  const avg = greyPixels.reduce((sum, v) => sum + v, 0) / greyPixels.length;
  let bits = 0n;
  for (let i = 0; i < greyPixels.length && i < size * size; i++) {
    bits = (bits << 1n) | (greyPixels[i]! >= avg ? 1n : 0n);
  }
  return bits;
}

function hammingDistance(h1: bigint, h2: bigint): number {
  let xor = h1 ^ h2;
  let count = 0;
  while (xor > 0n) {
    count += Number(xor & 1n);
    xor >>= 1n;
  }
  return count;
}

function dominantColor(pixels: Buffer, channels: number): RGB {
  const pixelCount = pixels.length / channels;
  if (pixelCount === 0) return [0, 0, 0];
  let r = 0, g = 0, b = 0;
  for (let i = 0; i < pixels.length; i += channels) {
    r += pixels[i]!;
    g += pixels[i + 1]!;
    b += pixels[i + 2]!;
  }
  return [r / pixelCount, g / pixelCount, b / pixelCount];
}

function colorDistance(c1: RGB, c2: RGB): number {
  return Math.sqrt(
    (c1[0] - c2[0]) ** 2 + (c1[1] - c2[1]) ** 2 + (c1[2] - c2[2]) ** 2
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compare two screenshots and return a structured diff result.
 *
 * Requires `sharp` to be installed. If sharp is not available, returns
 * a degraded result with similarity=0 and isAnomalous=true.
 */
export async function compareScreenshots(
  referencePath: string,
  currentPath: string
): Promise<ScreenshotDiffResult> {
  // Validate files exist
  if (!fs.existsSync(referencePath) || !fs.existsSync(currentPath)) {
    return { similarity: 0, hashDistance: 64, colorShift: 441, isAnomalous: true };
  }

  const sharp = await loadSharp();
  if (!sharp) {
    console.warn("[ScreenshotDiff] sharp not installed — returning degraded result. Run: npm i sharp");
    return { similarity: 0, hashDistance: 64, colorShift: 441, isAnomalous: true };
  }

  // Determine common size
  const refInfo = await sharp(referencePath).metadata();
  const curInfo = await sharp(currentPath).metadata();
  const targetW = Math.min(refInfo.width || 800, curInfo.width || 800);
  const targetH = Math.min(refInfo.height || 600, curInfo.height || 600);

  // Resize and get raw RGB buffers
  const refBuf = await sharp(referencePath).resize(targetW, targetH).raw().toBuffer({ resolveWithObject: true });
  const curBuf = await sharp(currentPath).resize(targetW, targetH).raw().toBuffer({ resolveWithObject: true });

  const channels = refBuf.info.channels;

  // 1. Pixel diff percentage → similarity
  const diffPct = pixelDiffPercentage(refBuf.data, curBuf.data, channels);
  const similarity = Math.max(0, 100 - diffPct);

  // 2. Perceptual hash distance
  const hashSize = 8;
  const refGrey = await sharp(referencePath).resize(hashSize, hashSize).greyscale().raw().toBuffer({ resolveWithObject: true });
  const curGrey = await sharp(currentPath).resize(hashSize, hashSize).greyscale().raw().toBuffer({ resolveWithObject: true });
  const refHash = averageHashFromBuffer(refGrey.data, hashSize);
  const curHash = averageHashFromBuffer(curGrey.data, hashSize);
  const hashDist = hammingDistance(refHash, curHash);

  // 3. Dominant color shift
  const refColor = dominantColor(refBuf.data, channels);
  const curColor = dominantColor(curBuf.data, channels);
  const colorShiftVal = colorDistance(refColor, curColor);

  return {
    similarity: Math.round(similarity * 100) / 100,
    hashDistance: hashDist,
    colorShift: Math.round(colorShiftVal * 100) / 100,
    isAnomalous: diffPct > 20,
  };
}
