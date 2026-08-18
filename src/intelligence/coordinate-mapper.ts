import fs from "fs";
import path from "path";
import { Page } from "playwright-core";

export interface ViewportCoordinate {
  vw: number; // percentage of viewport width (0.0 - 1.0)
  vh: number; // percentage of viewport height (0.0 - 1.0)
}

export interface SiteCoordinateMap {
  emailInput?: ViewportCoordinate;
  passwordInput?: ViewportCoordinate;
  submitButton?: ViewportCoordinate;
  rememberMeCheckbox?: ViewportCoordinate;
  cookieBannerAccept?: ViewportCoordinate;
}

const CONFIG_DIR = path.join(process.cwd(), "config", "coordinates");

/**
 * Resolves a coordinate map for a given site. Returns null if not calibrated.
 */
export function getCoordinateMap(siteName: string): SiteCoordinateMap | null {
  const filePath = path.join(CONFIG_DIR, `${siteName}.json`);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    const data = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(data) as SiteCoordinateMap;
  } catch (err) {
    console.error(`[CoordinateMapper] Failed to read ${filePath}:`, err);
    return null;
  }
}

/**
 * Saves a coordinate map for a given site.
 */
export function saveCoordinateMap(siteName: string, map: SiteCoordinateMap): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
  const filePath = path.join(CONFIG_DIR, `${siteName}.json`);
  fs.writeFileSync(filePath, JSON.stringify(map, null, 2));
  console.log(`[CoordinateMapper] Saved coordinate map to ${filePath}`);
}

/**
 * Resolves absolute (x, y) pixels from a viewport coordinate.
 */
export function resolveAbsoluteCoordinate(page: Page, coord: ViewportCoordinate): { x: number; y: number } {
  const viewportSize = page.viewportSize();
  if (!viewportSize) {
    throw new Error("Viewport size is not set on the page.");
  }
  const x = Math.round(viewportSize.width * coord.vw);
  const y = Math.round(viewportSize.height * coord.vh);
  return { x, y };
}

import { gaussianInt } from "../core/gaussian-rng.js";

/**
 * Executes a click on a viewport coordinate, with a randomized 70% inner bounding box spread.
 */
export async function coordinateClick(page: Page, coord: ViewportCoordinate): Promise<void> {
  const { x, y } = resolveAbsoluteCoordinate(page, coord);

  // Randomize slightly around the target (assuming a 20x20 target area) using Gaussian dist
  const offsetX = gaussianInt(0, 3, -5, 5);
  const offsetY = gaussianInt(0, 3, -5, 5);

  const finalX = x + offsetX;
  const finalY = y + offsetY;

  await page.mouse.move(finalX, finalY, { steps: 5 });
  await page.mouse.down();

  // 60-150ms hold latency using Gaussian dist
  const delay = gaussianInt(105, 30, 60, 150);
  await new Promise(r => setTimeout(r, delay));

  await page.mouse.up();
}
