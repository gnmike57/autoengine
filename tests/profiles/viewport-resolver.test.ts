import { describe, it, expect } from "vitest";
import { resolveViewport } from "../../src/profiles/viewport-resolver.js";

describe("viewport-resolver", () => {
  const mockScreen = { x: 0, y: 26, width: 1512, height: 919 };

  it("determinism for same email across runs", () => {
    const email = "test@example.com";
    const res1 = resolveViewport({ email, mode: "headless", screen: mockScreen });
    const res2 = resolveViewport({ email, mode: "headless", screen: mockScreen });
    expect(res1).toEqual(res2);
  });

  it("headless returns pool viewport with forceDpr: true", () => {
    const res = resolveViewport({ email: "a@b.com", mode: "headless", screen: mockScreen });
    expect(res.viewport).not.toBeNull();
    expect(res.windowSize).toBeNull();
    expect(res.forceDpr).toBe(true);
  });

  it("headed-live with screen returns null viewport and screen bounds", () => {
    const res = resolveViewport({ email: "a@b.com", mode: "headed-live", screen: mockScreen });
    expect(res.viewport).toBeNull();
    expect(res.windowSize).toEqual({ width: mockScreen.width, height: mockScreen.height });
    expect(res.windowPosition).toEqual({ x: mockScreen.x, y: mockScreen.y });
    expect(res.resolutionLabel).toContain("headed-live");
  });

  it("headless-live uses headed-live screen dimensions as its viewport", () => {
    const res = resolveViewport({ email: "a@b.com", mode: "headless-live", screen: mockScreen });
    expect(res.viewport).toEqual({ width: mockScreen.width, height: mockScreen.height });
    expect(res.windowSize).toBeNull();
    expect(res.windowPosition).toBeNull();
    expect(res.forceDpr).toBe(true);
    expect(res.resolutionLabel).toContain("headless-live");
  });

  it("headed-grid with slotBounds returns slot dimensions", () => {
    const slot = { x: 100, y: 100, width: 500, height: 500 };
    const res = resolveViewport({ email: "a@b.com", mode: "headed-grid", screen: mockScreen, slotBounds: slot });
    expect(res.windowSize).toEqual({ width: 500, height: 500 });
    expect(res.windowPosition).toEqual({ x: 100, y: 100 });
    expect(res.resolutionLabel).toContain("headed-grid");
  });

  it("explicitViewport is ignored for viewport in headed modes to comply with strict-dynamic-viewports", () => {
    const explicit = { width: 800, height: 600 };
    const res = resolveViewport({
      email: "a@b.com",
      mode: "headed-live",
      screen: mockScreen,
      explicitViewport: explicit
    });
    expect(res.viewport).toBeNull();
    expect(res.windowSize).toEqual({ width: mockScreen.width, height: mockScreen.height });
  });

  it("never returns portrait without explicitViewport", () => {
    // We can't easily force the pool to return portrait if it doesn't have any,
    // but we can verify the swap logic if we were to mock the pool.
    // For now, just a sanity check that it's landscape.
    const res = resolveViewport({ email: "a@b.com", mode: "headless", screen: mockScreen });
    expect(res.viewport!.width).toBeGreaterThanOrEqual(res.viewport!.height);
  });

  it("nativeDpr matching credential DPR within 0.01 in headed modes -> forceDpr: true", () => {
    const input = { email: "a@b.com", mode: "headed-live" as const, screen: mockScreen };
    const base = resolveViewport(input);
    const withMatch = resolveViewport({ ...input, nativeDpr: base.deviceScaleFactor });
    expect(withMatch.forceDpr).toBe(true);

    // In headed modes (headed-live, headed-grid), forceDpr is always true
    // for consistent zoom/scale behavior regardless of nativeDpr
    const withMismatch = resolveViewport({ ...input, nativeDpr: base.deviceScaleFactor + 0.1 });
    expect(withMismatch.forceDpr).toBe(true);
  });

  it("DPR is one of {1.0, 1.25, 1.5, 2.0}", () => {
    const validDprs = [1.0, 1.25, 1.5, 2.0];
    for (let i = 0; i < 20; i++) {
      const res = resolveViewport({ email: `user${i}@test.com`, mode: "headless", screen: mockScreen });
      expect(validDprs).toContain(res.deviceScaleFactor);
    }
  });

  it("undefined email -> fallback FHD + DPR 1.0", () => {
    const res = resolveViewport({ mode: "headless", screen: mockScreen });
    expect(res.viewport).toEqual({ width: 1920, height: 976 });
    expect(res.deviceScaleFactor).toBe(1.0);
    expect(res.resolutionLabel).toBe("FHD-fallback");
  });
});
