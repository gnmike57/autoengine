/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Page } from "playwright-core";
import { codegenExporter } from "../services/codegen-exporter.js";

// Ghost-cursor for Bézier humanized mouse paths on Chromium backends
let ghostCursorModule: any = undefined;
const cursorCache = new WeakMap<Page, any>();

async function getGhostCursor(): Promise<any> {
  if (ghostCursorModule === undefined) {
    try {
      ghostCursorModule = await import("ghost-cursor-playwright");
    } catch {
      ghostCursorModule = null; // Mark as unavailable
    }
  }
  return ghostCursorModule;
}

async function getCursorForPage(page: Page): Promise<any> {
  if (cursorCache.has(page)) return cursorCache.get(page);
  const mod = await getGhostCursor();
  if (!mod?.createCursor) return null;
  try {
    const cursor = await mod.createCursor(page);
    cursorCache.set(page, cursor);
    return cursor;
  } catch {
    return null;
  }
}

/**
 * Returns true if the page belongs to a Camoufox/stealth backend.
 * Camoufox handles mouse humanization natively at the C++ level,
 * so we must NOT layer ghost-cursor on top of it.
 */
function isCamoufoxPage(page: Page): boolean {
  const sessionId = (page as unknown as AutomatiPage).__sessionId;
  if (!sessionId) return false;
  return sessionId.startsWith("stealth-");
}
export interface AutomatiWindow extends Window {
  [key: symbol]: any;
  __automatiCookieDismissed?: boolean;
  __automatiSubmitObserverResult?: any;
  __automatiErrorBaseline?: string;
  __hermesMutationTelemetry?: (data: any) => void;
  __automatiCleanupObservers?: () => void;
}

export interface AutomatiPage {
  __canonicalLoginObserverInstalled?: boolean;
  __mousePos?: { x: number; y: number };
  __sessionId?: string;
  evaluate: any;
}

// ── Minimalist/Instant implementation enforcing strict-instant-injection ──

export interface Point { x: number; y: number; }
function setMousePos(page: Page, x: number, y: number): void {
  if (!(page as unknown as AutomatiPage).__mousePos) (page as unknown as AutomatiPage).__mousePos = { x, y };
  else { (page as unknown as AutomatiPage).__mousePos!.x = x; (page as unknown as AutomatiPage).__mousePos!.y = y; }
}

export async function humanMouseMove(
  page: Page,
  toX: number,
  toY: number,
  _speedFactor: number = 1.0,
): Promise<void> {
  const vp = typeof page.viewportSize === "function" ? (page.viewportSize() || { width: 1280, height: 720 }) : { width: 1280, height: 720 };
  const safeX = Math.max(5, Math.min(vp.width - 5, Math.round(toX)));
  const safeY = Math.max(5, Math.min(vp.height - 5, Math.round(toY)));

  // Camoufox: native humanization handles this — just do the move
  if (isCamoufoxPage(page)) {
    const steps = Math.floor(Math.random() * 10) + 5;
    await page.mouse.move(safeX, safeY, { steps });
    setMousePos(page, safeX, safeY);
    return;
  }

  // Chromium backends: use ghost-cursor Bézier paths
  const cursor = await getCursorForPage(page);
  if (cursor?.actions?.move) {
    try {
      await cursor.actions.move(safeX, safeY);
      setMousePos(page, safeX, safeY);
      return;
    } catch { /* fall through to basic */ }
  }

  // Fallback: stepped movement (better than teleport)
  const steps = Math.floor(Math.random() * 10) + 5;
  await page.mouse.move(safeX, safeY, { steps });
  setMousePos(page, safeX, safeY);
}

export async function injectMicroTremor(
  _page: Page,
  _baseX: number,
  _baseY: number,
  _durationMs: number,
): Promise<void> {
  // STRICT RULE: Zero wasted milliseconds. Bypassing tremor.
}

export async function humanScroll(
  page: Page,
  targetDelta: number,
): Promise<void> {
  await page.mouse.wheel(0, Math.round(targetDelta));
}

export function resetMousePosition(x: number = 400, y: number = 300, page?: Page): void {
  if (page) {
    const vp = typeof page.viewportSize === "function" ? (page.viewportSize() || { width: 1280, height: 720 }) : { width: 1280, height: 720 };
    const safeX = Math.max(5, Math.min(vp.width - 5, Math.round(x)));
    const safeY = Math.max(5, Math.min(vp.height - 5, Math.round(y)));
    setMousePos(page, safeX, safeY);
  }
}

export function getSafeRestingPosition(viewportWidth: number, viewportHeight: number): Point {
  return { x: viewportWidth / 2, y: viewportHeight / 2 };
}

export async function humanClick(page: Page): Promise<void> {
  // Ultrafast click
  await page.mouse.down();
  await new Promise(r => setTimeout(r, Math.floor(Math.random() * (150 - 60 + 1)) + 60));
  await page.mouse.up();
}

export async function humanClickAt(
  page: Page,
  x: number,
  y: number,
  options?: { clickCount?: number; skipJitter?: boolean },
): Promise<void> {
  const vp = typeof page.viewportSize === "function" ? (page.viewportSize() || { width: 1280, height: 720 }) : { width: 1280, height: 720 };
  const targetX = Math.max(5, Math.min(vp.width - 5, Math.round(x)));
  const targetY = Math.max(5, Math.min(vp.height - 5, Math.round(y)));

  if ((page as unknown as AutomatiPage).__sessionId) {
    codegenExporter.logAction((page as unknown as AutomatiPage).__sessionId!, `await page.mouse.click(${targetX}, ${targetY});`);
  }
  const count = options?.clickCount ?? 1;

  // Camoufox: native humanization — use simple click (Camoufox adds Bézier paths internally)
  if (isCamoufoxPage(page)) {
    for (let c = 0; c < count; c++) {
      await page.mouse.move(targetX, targetY);
      await page.mouse.down();
      await new Promise(r => setTimeout(r, Math.floor(Math.random() * (150 - 60 + 1)) + 60));
      await page.mouse.up();
      if (c < count - 1) await new Promise(r => setTimeout(r, Math.floor(Math.random() * 30) + 10));
    }
    setMousePos(page, targetX, targetY);
    return;
  }

  // Chromium backends: use ghost-cursor Bézier paths for human-like movement + click
  const cursor = await getCursorForPage(page);
  if (cursor?.actions?.click) {
    try {
      for (let c = 0; c < count; c++) {
        // ghost-cursor moves to the position with a Bézier curve, then clicks
        await cursor.actions.move(targetX, targetY);
        await page.mouse.down();
        await new Promise(r => setTimeout(r, Math.floor(Math.random() * (150 - 60 + 1)) + 60));
        await page.mouse.up();
        if (c < count - 1) await new Promise(r => setTimeout(r, Math.floor(Math.random() * 30) + 10));
      }
      setMousePos(page, targetX, targetY);
      return;
    } catch { /* fall through to basic */ }
  }

  // Fallback: stepped movement (still better than raw teleport)
  for (let c = 0; c < count; c++) {
    const steps = Math.floor(Math.random() * 8) + 5;
    await page.mouse.move(targetX, targetY, { steps });
    await page.mouse.down();
    await new Promise(r => setTimeout(r, Math.floor(Math.random() * (150 - 60 + 1)) + 60));
    await page.mouse.up();
    if (c < count - 1) await new Promise(r => setTimeout(r, Math.floor(Math.random() * 30) + 10));
  }
  setMousePos(page, targetX, targetY);
}

export async function humanClickSelector(
  page: Page,
  selector: string,
  opts?: { force?: boolean; timeout?: number; clickCount?: number; description?: string },
): Promise<void> {
  if ((page as unknown as AutomatiPage).__sessionId) {
    codegenExporter.logAction((page as unknown as AutomatiPage).__sessionId!, `await page.click('${selector}');`);
  }

  // Chromium backends: try ghost-cursor for selector-based clicks
  if (!isCamoufoxPage(page)) {
    const cursor = await getCursorForPage(page);
    if (cursor?.actions?.click) {
      try {
        await cursor.actions.click({ target: selector });
        return;
      } catch { /* fall through to native click */ }
    }
  }

  // Calculate 70% inner bounding box
  try {
    if (typeof page.locator === "function") {
      const loc = page.locator(selector).first();
      const box = await loc.boundingBox();
      if (box) {
        const xMin = box.x + box.width * 0.15;
        const xMax = box.x + box.width * 0.85;
        const yMin = box.y + box.height * 0.15;
        const yMax = box.y + box.height * 0.85;
        const rx = Math.random() * (xMax - xMin) + xMin;
        const ry = Math.random() * (yMax - yMin) + yMin;
        await humanClickAt(page, rx, ry, opts);
        return;
      }
    }
  } catch { /* fallback to basic click if element is missing */ }

  // STRICT RULE: native click with humanized 60-150ms delay
  if (typeof page.click === "function") {
    await page.click(selector, {
      delay: Math.floor(Math.random() * (150 - 60 + 1)) + 60,
      force: opts?.force,
      timeout: opts?.timeout,
      clickCount: opts?.clickCount ?? 1,
    });
  }
}
