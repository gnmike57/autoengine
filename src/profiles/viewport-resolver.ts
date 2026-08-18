/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment */
import os from "node:os";
import { exec as execCb } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execCb);
import { getEnvInt } from "../core/env-utils.js";
import { createLogger } from "../core/logger.js";

const log = createLogger("viewport-resolver");
import {
  getConsistentResolution,
  getConsistentDeviceScaleFactor,
  type Resolution
} from "./profile-resolution.js";

export type ResolverMode = "headless" | "headless-live" | "headed-grid" | "headed-live";

export interface ScreenBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ResolvedViewport {
  viewport: { width: number; height: number } | null;
  windowSize: { width: number; height: number } | null;
  windowPosition: { x: number; y: number } | null;
  deviceScaleFactor: number;
  forceDpr: boolean;
  resolutionLabel: string;
}

export interface ResolverInput {
  email?: string;
  mode: ResolverMode;
  screen: ScreenBounds;
  slotBounds?: ScreenBounds;
  explicitViewport?: { width: number; height: number };
  nativeDpr?: number;
  rotation?: number;
}

const PLATFORM = os.platform();
const IS_MAC = PLATFORM === "darwin";

let cachedScreenBounds: ScreenBounds | null = null;

/**
 * Detect the actual usable screen size. Platform-aware (macOS, Windows).
 * Cached after first call. Never throws.
 */
export async function resolveScreenBounds(): Promise<ScreenBounds> {
  if (cachedScreenBounds) return cachedScreenBounds;

  const fallback = IS_MAC
    ? { width: 1512, height: 945, menuY: 26 }
    : { width: 1920, height: 1040, menuY: 0 };

  const opts = { encoding: "utf-8" as const, timeout: 2500, stdio: ["ignore", "pipe", "ignore"] as any };
  let detected = { ...fallback };

  try {
    if (IS_MAC) {
      try {
        const { stdout: sp } = await exec(`system_profiler SPDisplaysDataType 2>/dev/null`, opts);
        const m = sp.match(/Resolution:\s*(\d+)\s*x\s*(\d+)/);
        if (m) {
          // @ts-expect-error noUncheckedIndexedAccess
          const w = parseInt(m[1], 10);
          // @ts-expect-error noUncheckedIndexedAccess
          const h = parseInt(m[2], 10);
          const logicalW = w > 2000 ? Math.round(w / 2) : w;
          const logicalH = h > 1400 ? Math.round(h / 2) : h;
          detected = { width: logicalW, height: logicalH - 26, menuY: 26 };
        }
      } catch {
        const { stdout } = await exec(
          `osascript -e 'tell application "Finder" to get bounds of window of desktop'`,
          opts
        );
        const out = stdout.trim();
        const m = out.match(/(\d+),\s*(\d+),\s*(\d+),\s*(\d+)/);
        if (m) {
          // @ts-expect-error noUncheckedIndexedAccess
          const right = parseInt(m[3], 10);
          // @ts-expect-error noUncheckedIndexedAccess
          const bottom = parseInt(m[4], 10);
          detected = { width: right, height: bottom - 26, menuY: 26 };
        }
      }
    } else if (PLATFORM === "win32") {
      const { stdout } = await exec(
        `powershell -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea | Select Width,Height | ConvertTo-Csv -NoTypeInformation"`,
        opts
      );
      const out = stdout;
      const lines = out.trim().split(/\r?\n/);
      if (lines.length >= 2) {
        // @ts-expect-error noUncheckedIndexedAccess
        const [w, h] = lines[1].replace(/"/g, "").split(",").map((s) => parseInt(s, 10));
        if (w && h) detected = { width: w, height: h, menuY: 0 };
      }
    }
  } catch {
    // Keep fallback
  }

  const width = getEnvInt("SCREEN_WIDTH", detected.width);
  const height = getEnvInt("SCREEN_HEIGHT", detected.height);
  const index = getEnvInt("SCREEN_INDEX", 0);
  const x = getEnvInt("SCREEN_X", index * width);
  const y = getEnvInt("SCREEN_Y", detected.menuY);

  cachedScreenBounds = { x, y, width, height };
  log.info(`Screen: ${width}×${height} @ (${x},${y}) (index=${index})`);
  return cachedScreenBounds;
}

/**
 * Single source of truth for window/viewport/DPR selection.
 */
export function resolveViewport(input: ResolverInput): ResolvedViewport {
  const { email, mode, screen, slotBounds, explicitViewport, nativeDpr, rotation = 0 } = input;

  // 1. Determine base resolution and DPR from credential (or fallback)
  let res: Resolution;
  let dpr: number;

  if (email) {
    res = getConsistentResolution(email, undefined, rotation);
    dpr = getConsistentDeviceScaleFactor(email, rotation);
  } else {
    res = { width: 1920, height: 1080, share: 0, label: "FHD-fallback" };
    dpr = 1.0;
  }

  // Defensive: swap to landscape if pool produces portrait (existing pool is all landscape)
  if (res.height > res.width) {
    log.warn(`Swap portrait to landscape for ${res.label}`);
    const tmp = res.width;
    res.width = res.height;
    res.height = tmp;
  }

  // 2. Resolve Viewport
  let viewport: { width: number; height: number } | null = null;

  if (mode === "headed-live" || mode === "headed-grid") {
    // headed-live or headed-grid: let Chromium use real window area
    // explicitViewport MUST be ignored to comply with strict-dynamic-viewports
    viewport = null;
  } else if (explicitViewport) {
    viewport = { ...explicitViewport };
  } else if (mode === "headless") {
    // Mathematically align inner viewport with realistic OS taskbar and browser chrome footprint.
    // Typical Windows/Mac chrome + taskbar footprint is ~104px height.
    viewport = { width: res.width, height: Math.max(500, res.height - 104) };
  } else if (mode === "headless-live") {
    // Live diagnostics should match the visible headed-live surface as closely
    // as possible while still running without a native window.
    viewport = { width: screen.width, height: screen.height };
  }

  // 3. Resolve Window Size & Position
  let windowSize: { width: number; height: number } | null = null;
  let windowPosition: { x: number; y: number } | null = null;
  let resolutionLabel = res.label;

  if (mode === "headed-live") {
    windowSize = { width: screen.width, height: screen.height };
    windowPosition = { x: screen.x, y: screen.y };
    resolutionLabel = `headed-live (${windowSize.width}x${windowSize.height})`;
  } else if (mode === "headless-live") {
    resolutionLabel = `headless-live (${screen.width}x${screen.height})`;
  } else if (mode === "headed-grid" && slotBounds) {
    windowSize = { width: slotBounds.width, height: slotBounds.height };
    windowPosition = { x: slotBounds.x, y: slotBounds.y };
    resolutionLabel = `headed-grid (${windowSize.width}x${windowSize.height})`;
  }

  // 4. Determine if we should force DPR
  // forceDpr is true ONLY for headless mode (or headed when nativeDpr matches within ±0.01)
  let forceDpr = false;
  if (mode === "headless" || mode === "headless-live") {
    forceDpr = true;
  } else if (mode === "headed-live" || mode === "headed-grid") {
    // Reduce zoom/scale for headful modes so we can see the full viewport when tiled
    dpr = 0.7;
    forceDpr = true;
  } else if (nativeDpr !== undefined && Math.abs(nativeDpr - dpr) <= 0.01) {
    forceDpr = true;
  }

  return {
    viewport,
    windowSize,
    windowPosition,
    deviceScaleFactor: dpr,
    forceDpr,
    resolutionLabel,
  };
}
