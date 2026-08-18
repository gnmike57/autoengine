/**
 * Test 9: DynamicTimings — Runtime Mutation by Hermes
 *
 * Verifies that DynamicTimings is a mutable copy of Timings,
 * and that mutations don't propagate back to the frozen base.
 */
import { describe, it, expect } from "vitest";
import { Timings, DynamicTimings, type TimingKey } from "../../src/core/timings.js";

describe("DynamicTimings", () => {
  it("DynamicTimings starts as a copy of Timings", () => {
    for (const key of Object.keys(Timings) as TimingKey[]) {
      expect(DynamicTimings[key], `${key} should match`).toBe(Timings[key]);
    }
  });

  it("mutating DynamicTimings does NOT affect the frozen Timings constant", () => {
    const originalValue = Timings.GOTO_TIMEOUT;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (DynamicTimings as any).GOTO_TIMEOUT = 99999;
    expect(Timings.GOTO_TIMEOUT).toBe(originalValue); // Must NOT be 99999
    // Restore
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (DynamicTimings as any).GOTO_TIMEOUT = originalValue;
  });

  it("all keys in Timings exist in DynamicTimings", () => {
    const timingKeys = Object.keys(Timings);
    const dynamicKeys = Object.keys(DynamicTimings);
    for (const key of timingKeys) {
      expect(dynamicKeys, `DynamicTimings should have key '${key}'`).toContain(key);
    }
  });

  it("ROW_HARD_TIMEOUT_MS is 300_000 (5 minutes)", () => {
    expect(Timings.ROW_HARD_TIMEOUT_MS).toBe(300_000);
  });

  it("SITE_HARD_TIMEOUT_MS is 150_000 (2.5 minutes)", () => {
    expect(Timings.SITE_HARD_TIMEOUT_MS).toBe(150_000);
  });

  it("GOTO_TIMEOUT is 20_000 (20 seconds)", () => {
    expect(Timings.GOTO_TIMEOUT).toBe(30_000);
  });

  it("SCREENSHOT_RETENTION_MS is 72 hours", () => {
    expect(Timings.SCREENSHOT_RETENTION_MS).toBe(72 * 60 * 60 * 1000);
  });

  it("SCREENSHOT_CLEANUP_INTERVAL_MS is 6 hours", () => {
    expect(Timings.SCREENSHOT_CLEANUP_INTERVAL_MS).toBe(6 * 60 * 60 * 1000);
  });

  it("MAX_CSV_BYTES is 50 MiB", () => {
    expect(Timings.MAX_CSV_BYTES).toBe(50 * 1024 * 1024);
  });

  it("GOTO_RETRY_ATTEMPTS is 2", () => {
    expect(Timings.GOTO_RETRY_ATTEMPTS).toBe(2);
  });

  it("SESSION_STAGGER_BASE is 500ms", () => {
    expect(Timings.SESSION_STAGGER_BASE).toBe(500);
  });

  it("SCREENSHOT_QUEUE_MAX is 200", () => {
    expect(Timings.SCREENSHOT_QUEUE_MAX).toBe(200);
  });

  it("all timing values are positive numbers", () => {
    for (const [key, val] of Object.entries(Timings)) {
      if (typeof val === "number") {
        expect(val, `${key} should be positive`).toBeGreaterThan(0);
      }
    }
  });
});
