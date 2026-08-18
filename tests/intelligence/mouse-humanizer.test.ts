import { describe, it, expect, vi } from "vitest";
import {
  humanMouseMove,
  humanScroll,
  resetMousePosition,
  getSafeRestingPosition,
  humanClickAt,
  humanClickSelector
} from "../../src/intelligence/mouse-humanizer.js";

describe("Mouse Humanizer", () => {
  it("should calculate safe resting position in center of viewport", () => {
    const pt = getSafeRestingPosition(1280, 720);
    expect(pt).toEqual({ x: 640, y: 360 });
  });

  it("should reset mouse position on page object", () => {
    const mockPage: any = {};
    resetMousePosition(500, 300, mockPage);
    expect(mockPage.__mousePos).toEqual({ x: 500, y: 300 });
  });

  it("should execute humanMouseMove on Camoufox stealth page", async () => {
    const move = vi.fn().mockResolvedValue(undefined);
    const mockPage: any = {
      __sessionId: "stealth-12345-6789",
      mouse: { move }
    };

    await humanMouseMove(mockPage, 100, 200);
    expect(move).toHaveBeenCalledWith(100, 200, expect.objectContaining({ steps: expect.any(Number) }));
    expect(mockPage.__mousePos).toEqual({ x: 100, y: 200 });
  });

  it("should execute humanScroll via mouse wheel", async () => {
    const wheel = vi.fn().mockResolvedValue(undefined);
    const mockPage: any = {
      mouse: { wheel }
    };

    await humanScroll(mockPage, 300);
    expect(wheel).toHaveBeenCalledWith(0, 300);
  });

  it("should execute humanClickAt at coordinates", async () => {
    const move = vi.fn().mockResolvedValue(undefined);
    const down = vi.fn().mockResolvedValue(undefined);
    const up = vi.fn().mockResolvedValue(undefined);
    const mockPage: any = {
      __sessionId: "stealth-test",
      mouse: { move, down, up }
    };

    await humanClickAt(mockPage, 150, 250);
    expect(move).toHaveBeenCalled();
    expect(down).toHaveBeenCalled();
    expect(up).toHaveBeenCalled();
  });

  it("should execute humanClickSelector by finding element bounding box", async () => {
    const move = vi.fn().mockResolvedValue(undefined);
    const down = vi.fn().mockResolvedValue(undefined);
    const up = vi.fn().mockResolvedValue(undefined);
    const mockLocator = {
      first: () => ({
        isVisible: vi.fn().mockResolvedValue(true),
        boundingBox: vi.fn().mockResolvedValue({ x: 100, y: 100, width: 200, height: 50 }),
        click: vi.fn().mockResolvedValue(undefined)
      })
    };

    const mockPage: any = {
      __sessionId: "stealth-test",
      locator: vi.fn().mockReturnValue(mockLocator),
      mouse: { move, down, up }
    };

    await humanClickSelector(mockPage, "#login-button");
    expect(mockPage.locator).toHaveBeenCalledWith("#login-button");
  });
});
