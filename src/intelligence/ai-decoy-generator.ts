/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument */
import type { Page } from "playwright-core";
import { humanClickSelector, humanScroll } from "./mouse-humanizer.js";
import { globalRLLedger } from "./ai-rl-ledger.js";

async function sleepWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return;
  if (ms <= 0) return;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener("abort", onAbort);
  });
}

/**
 * Parses the page text and executes a series of logically sound but random
 * human decoy interactions (reading text, clicking non-submit links) to
 * heavily obfuscate the bot's deterministic signature.
 *
 * Runs concurrently and aborts instantly if the main flow signals readiness.
 */
export async function executeGenerativeDecoys(page: Page, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return;

  const possibleDecoySelectors = [
    "text='Forgot'",
    "text='Remember'",
    "text='Help'",
    "text='Terms'",
    "text='Privacy'",
    "text='Login'"
  ];

  const scope = (page as any).__sessionId || "global";

  // 1. Synthesize a random scroll burst
  if (Math.random() < 0.6) {
    if (signal?.aborted) return;
    const scrollDelta = globalRLLedger.getTiming(scope, "decoy_scroll", 150, 50, 50, 400);
    await humanScroll(page, scrollDelta).catch(() => {});
    await sleepWithSignal(globalRLLedger.getTiming(scope, "decoy_read_pause", 100, 50, 10, 200), signal);

    if (signal?.aborted) return;
    // Scroll back up
    await humanScroll(page, -scrollDelta).catch(() => {});
  }

  // 2. Synthesize random clicks on non-destructive text
  const decoyCount = Math.floor(globalRLLedger.getTiming(scope, "decoy_count", 1, 0.5, 0, 2));

  for (let i = 0; i < decoyCount; i++) {
    if (signal?.aborted) return;
    const selector = possibleDecoySelectors[Math.floor(Math.random() * possibleDecoySelectors.length)]!;

    try {
      const isVisible = await page.locator(selector).first().isVisible({ timeout: 50 }).catch(() => false);
      if (isVisible && !signal?.aborted) {
        await humanClickSelector(page, selector, { timeout: 200 });
        await sleepWithSignal(globalRLLedger.getTiming(scope, "decoy_inter_click", 50, 25, 10, 100), signal);
      }
    } catch {
      // Ignore if element is missing or not clickable
    }
  }
}
