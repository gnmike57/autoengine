/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
import { type Page } from "playwright-core";
import { askLlava } from "../core/ollama-client.js";

export interface VisionCoordinates {
  email: { x: number, y: number, w: number, h: number };
  password: { x: number, y: number, w: number, h: number };
  submit: { x: number, y: number, w: number, h: number };
}

let consecutiveFailures = 0;
let circuitOpenUntil = 0;

/**
 * Feeds a screenshot to Gemini Vision and returns a normalized percentage matrix
 * (0.0 to 1.0) for the X, Y, Width, and Height of the core login elements.
 */
export async function getViewportCoordinateMarkdown(page: Page): Promise<VisionCoordinates | null> {

  if (Date.now() < circuitOpenUntil) {
    console.warn("[AIVision] Circuit breaker OPEN. Bypassing viewport coordinates mapping.");
    return null;
  }

  try {
    const imageBuffer = await page.screenshot({ fullPage: false });

    const prompt = `Analyze this login page screenshot. Return the bounding box coordinates for the "Email/Username Input", "Password Input", and "Login/Submit Button".

    IMPORTANT: Provide the X and Y coordinates of the center of the element, and its Width (w) and Height (h), as decimal percentages of the total image dimensions (from 0.00 to 1.00).

    Reply ONLY with valid, parseable JSON in exactly this structure:
    {
      "email": { "x": 0.50, "y": 0.30, "w": 0.20, "h": 0.05 },
      "password": { "x": 0.50, "y": 0.40, "w": 0.20, "h": 0.05 },
      "submit": { "x": 0.50, "y": 0.50, "w": 0.20, "h": 0.05 }
    }
    If you cannot clearly see these elements, return {"error": "not found"}.`;
    const base64Image = imageBuffer.toString('base64');
    const responseText = await askLlava(prompt, base64Image);

    // Strip markdown formatting if the model responds with code blocks
    const cleanJsonText = responseText.replace(/```json/gi, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(cleanJsonText);
    if (parsed.email && parsed.password && parsed.submit) {
      consecutiveFailures = 0;
      return parsed as VisionCoordinates;
    }

    return null;
  } catch (e) {
    console.error("[AIVision] Coordinate mapping failed:", e);
    consecutiveFailures++;
    if (consecutiveFailures >= 3) {
      circuitOpenUntil = Date.now() + 60000;
      console.warn("[AIVision] Circuit breaker TRIPPED! API disabled for 60s.");
    }
    return null;
  }
}
