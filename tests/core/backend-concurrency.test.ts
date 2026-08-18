/**
 * Test 6: Backend Concurrency Weighting — Slot Acquisition
 *
 * Tests the per-backend slot acquisition logic that prevents
 * headed backends from consuming all concurrency slots.
 */
import { describe, it, expect } from "vitest";
import { BACKEND_OPTIMAL_SETTINGS } from "../../src/core/engine.js";

/**
 * Reimplementation of the engine's backend slot logic for isolated testing.
 * This mirrors the exact code in engine.ts processAllRows().
 */
function createSlotManager(globalConcurrency: number, autoOptEnabled: boolean = true) {
  const backendActiveSlots = new Map<string, number>();

  const getBackendMaxSlots = (backendName: string): number => {
    if (!autoOptEnabled) return Infinity;
    const optimal = BACKEND_OPTIMAL_SETTINGS[backendName];
     
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const weight = (optimal as any)?.concurrencyWeight ?? 1.0;
    return Math.max(1, Math.floor(globalConcurrency * weight));
  };

  const acquireBackendSlot = (backendName: string): boolean => {
    if (!autoOptEnabled) return true;
    const current = backendActiveSlots.get(backendName) || 0;
    const max = getBackendMaxSlots(backendName);
    if (current >= max) return false;
    backendActiveSlots.set(backendName, current + 1);
    return true;
  };

  const releaseBackendSlot = (backendName: string): void => {
    if (!autoOptEnabled) return;
    const current = backendActiveSlots.get(backendName) || 0;
    backendActiveSlots.set(backendName, Math.max(0, current - 1));
  };

  return { getBackendMaxSlots, acquireBackendSlot, releaseBackendSlot, backendActiveSlots };
}

describe("per-backend concurrency weighting (Test 6)", () => {
  it("stealth (weight=1.0) at concurrency=8 → max 8 slots", () => {
    const mgr = createSlotManager(8);
    expect(mgr.getBackendMaxSlots("stealth")).toBe(8);
  });

  it("stealth-headed (weight=0.5) at concurrency=8 → max 4 slots", () => {
    const mgr = createSlotManager(8);
    expect(mgr.getBackendMaxSlots("stealth-headed")).toBe(4);
  });

  it("zendriver (weight=0.8) at concurrency=8 → max 6 slots", () => {
    const mgr = createSlotManager(8);
    expect(mgr.getBackendMaxSlots("zendriver")).toBe(6);
  });

  it("zendriver-headed (weight=0.4) at concurrency=8 → max 3 slots", () => {
    const mgr = createSlotManager(8);
    expect(mgr.getBackendMaxSlots("zendriver-headed")).toBe(3);
  });

  it("cloak-headless (weight=1.0) at concurrency=5 → max 5 slots", () => {
    const mgr = createSlotManager(5);
    expect(mgr.getBackendMaxSlots("cloak-headless")).toBe(5);
  });

  it("cloak-headed (weight=0.5) at concurrency=5 → max 2 slots", () => {
    const mgr = createSlotManager(5);
    expect(mgr.getBackendMaxSlots("cloak-headed")).toBe(2);
  });

  it("minimum 1 slot even at concurrency=1 with weight=0.4", () => {
    const mgr = createSlotManager(1);
    expect(mgr.getBackendMaxSlots("zendriver-headed")).toBe(1);
  });

  it("minimum 1 slot even at concurrency=2 with weight=0.4", () => {
    const mgr = createSlotManager(2);
    // floor(2 * 0.4) = floor(0.8) = 0 → max(1,0) = 1
    expect(mgr.getBackendMaxSlots("zendriver-headed")).toBe(1);
  });

  it("acquire returns true until max reached, then false", () => {
    const mgr = createSlotManager(4); // stealth-headed max = 2
    expect(mgr.acquireBackendSlot("stealth-headed")).toBe(true);
    expect(mgr.acquireBackendSlot("stealth-headed")).toBe(true);
    expect(mgr.acquireBackendSlot("stealth-headed")).toBe(false); // At cap
  });

  it("release decrements correctly and allows blocked acquires to proceed", () => {
    const mgr = createSlotManager(4); // stealth-headed max = 2
    mgr.acquireBackendSlot("stealth-headed");
    mgr.acquireBackendSlot("stealth-headed");
    expect(mgr.acquireBackendSlot("stealth-headed")).toBe(false);

    mgr.releaseBackendSlot("stealth-headed");
    expect(mgr.acquireBackendSlot("stealth-headed")).toBe(true); // Now there's room
  });

  it("different backends don't interfere with each other's slot counts", () => {
    const mgr = createSlotManager(4);
    // Fill stealth-headed (max=2)
    mgr.acquireBackendSlot("stealth-headed");
    mgr.acquireBackendSlot("stealth-headed");
    expect(mgr.acquireBackendSlot("stealth-headed")).toBe(false);

    // cloak-headless should still be acquirable (max=4)
    expect(mgr.acquireBackendSlot("cloak-headless")).toBe(true);
    expect(mgr.acquireBackendSlot("cloak-headless")).toBe(true);
  });

  it("release below zero clamps to 0", () => {
    const mgr = createSlotManager(4);
    mgr.releaseBackendSlot("stealth"); // Release when nothing acquired
    expect(mgr.backendActiveSlots.get("stealth")).toBe(0);
  });

  it("when autoOptEnabled=false, all acquires return true (no weighting)", () => {
    const mgr = createSlotManager(1, false);
    for (let i = 0; i < 100; i++) {
      expect(mgr.acquireBackendSlot("stealth-headed")).toBe(true);
    }
  });

  it("when autoOptEnabled=false, getBackendMaxSlots returns Infinity", () => {
    const mgr = createSlotManager(1, false);
    expect(mgr.getBackendMaxSlots("stealth-headed")).toBe(Infinity);
  });

  it("unknown backend gets weight=1.0 (full slots)", () => {
    const mgr = createSlotManager(5);
    expect(mgr.getBackendMaxSlots("totally-unknown")).toBe(5);
  });
});
