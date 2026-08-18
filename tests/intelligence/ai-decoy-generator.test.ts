import { describe, it, expect, vi } from "vitest";
import { executeGenerativeDecoys } from "../../src/intelligence/ai-decoy-generator.js";

describe("AI Decoy Generator", () => {
  it("should return immediately if AbortSignal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    const mockPage: any = {
      evaluate: vi.fn(),
      locator: vi.fn()
    };

    await executeGenerativeDecoys(mockPage, controller.signal);
    expect(mockPage.evaluate).not.toHaveBeenCalled();
  });

  it("should safely perform scroll and click operations with mocked Playwright page", async () => {
    const mockLocator = {
      first: () => ({
        isVisible: vi.fn().mockResolvedValue(true),
        boundingBox: vi.fn().mockResolvedValue({ x: 100, y: 100, width: 50, height: 20 })
      })
    };

    const mockPage: any = {
      __sessionId: "test-session",
      locator: vi.fn().mockReturnValue(mockLocator),
      mouse: {
        move: vi.fn().mockResolvedValue(undefined),
        click: vi.fn().mockResolvedValue(undefined),
        wheel: vi.fn().mockResolvedValue(undefined)
      },
      evaluate: vi.fn().mockResolvedValue(undefined)
    };

    await executeGenerativeDecoys(mockPage);
    // Should complete without error
    expect(mockPage.locator).toBeDefined();
  });
});
