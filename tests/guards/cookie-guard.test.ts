import { describe, it, expect, vi } from "vitest";
import { CookieGuard } from "../../src/guards/cookie-guard.js";

describe("CookieGuard", () => {
  const formSelectors = { username: "#email", password: "#password" };

  it("should install initScript and report initial state", async () => {
    const addInitScript = vi.fn().mockResolvedValue(undefined);
    const mockPage: any = {
      addInitScript,
      viewportSize: () => ({ width: 1280, height: 720 }),
      mouse: { click: vi.fn().mockResolvedValue(undefined) }
    };

    const guard = new CookieGuard(mockPage, {
      siteName: "joe",
      formSelectors
    });

    expect(guard.isDismissed()).toBe(false);
    await guard.install();
    expect(addInitScript).toHaveBeenCalled();
  });

  it("should trigger appearance click at neutral coordinates", async () => {
    const click = vi.fn().mockResolvedValue(undefined);
    const mockPage: any = {
      viewportSize: () => ({ width: 1000, height: 800 }),
      mouse: { click }
    };

    const guard = new CookieGuard(mockPage, { siteName: "ignition", formSelectors });
    await guard.triggerAppearance();
    expect(click).toHaveBeenCalledWith(985, 785);
  });

  it("should dismiss via Tier 1 API if evaluate succeeds", async () => {
    const mockPage: any = {
      evaluate: vi.fn().mockResolvedValue(true),
      locator: vi.fn()
    };

    const guard = new CookieGuard(mockPage, { siteName: "joe", formSelectors });
    const dismissed = await guard.dismiss();
    expect(dismissed).toBe(true);
    expect(guard.isDismissed()).toBe(true);
  });
});
