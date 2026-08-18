/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
import { type Page } from "playwright-core";
import { generateContentWithFallback, isAiAvailable } from "./llm-provider.js";

let consecutiveFailures = 0;
let circuitOpenUntil = 0;

export async function getElementCoordinatesFromVision(page: Page, elementDescription: string): Promise<{x: number, y: number} | null> {
  if (!isAiAvailable()) {
    console.warn("[AIVision] No AI API configured, cannot use visual fallback.");
    return null;
  }

  if (Date.now() < circuitOpenUntil) {
    console.warn("[AIVision] Circuit breaker OPEN. Bypassing visual fallback.");
    return null;
  }

  try {
    // Inject a contrasting coordinate grid overlay to assist the Vision model with obfuscated Canvas UI
    await page.evaluate(() => {
      const overlay = document.createElement('div');
      overlay.id = '__vision_grid_overlay__';
      Object.assign(overlay.style, {
        position: 'fixed', top: '0', left: '0', width: '100vw', height: '100vh',
        pointerEvents: 'none', zIndex: '2147483647',
        backgroundImage: 'linear-gradient(rgba(255,0,0,0.3) 1px, transparent 1px), linear-gradient(90deg, rgba(255,0,0,0.3) 1px, transparent 1px)',
        backgroundSize: '10% 10%'
      });
      document.body.appendChild(overlay);
    }).catch(() => {});

    const imageBuffer = await page.screenshot({ fullPage: false });

    // Remove the grid immediately after the screenshot
    await page.evaluate(() => {
      document.getElementById('__vision_grid_overlay__')?.remove();
    }).catch(() => {});

    const prompt = `Return the center coordinates (X and Y) of the "${elementDescription}" on this webpage screenshot.
A red 10x10% grid overlay has been added to assist you.
If the element is heavily obfuscated inside a Canvas or WebGL context, use the grid lines to estimate its position.
Reply in exactly this JSON format: {"x": 123, "y": 456}. If not found, reply with {"error": "not found"}.`;

    const result = await generateContentWithFallback({
      prompt,
      images: [imageBuffer],
      timeoutMs: 30000,
    });

    const text = result.text;
    const match = text.match(/\{.*?\}/);
    if (match) {
      const parsed = JSON.parse(match[0]);
      if (parsed.x !== undefined && parsed.y !== undefined) {
        consecutiveFailures = 0;
        return { x: parsed.x, y: parsed.y };
      }
    }
    return null;
  } catch (e) {
    console.error("[AIVision] Fallback failed:", e);
    consecutiveFailures++;
    if (consecutiveFailures >= 3) {
      circuitOpenUntil = Date.now() + 60000;
      console.warn("[AIVision] Circuit breaker TRIPPED! API disabled for 60s.");
    }
    return null;
  }
}
