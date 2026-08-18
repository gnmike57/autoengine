import { describe, it, expect, vi } from "vitest";
import { installEarlyCookieDismissHook, universalLoginFlow } from "../../src/targets/universal-login.js";

// Mock executeUnifiedLoginChoreography
vi.mock("../../src/targets/login-flow.js", () => ({
  executeUnifiedLoginChoreography: vi.fn().mockResolvedValue({ success: true, networkVerdict: "success" })
}));

describe("Universal Login Flow", () => {
  it("should install legacy cookie dismiss hook without error", async () => {
    const addInitScript = vi.fn().mockResolvedValue(undefined);
    const mockPage: any = { addInitScript };

    await installEarlyCookieDismissHook(mockPage);
    expect(addInitScript).toHaveBeenCalledTimes(1);
  });

  it("should return failure if login form does not appear", async () => {
    const mockPage: any = {
      waitForSelector: vi.fn().mockResolvedValue(null)
    };

    const result = await universalLoginFlow({
      page: mockPage,
      siteName: "joe",
      email: "test@example.com",
      password: "Password123",
      attemptIdx: 0,
      mode: "stealth-humanized"
    } as any);

    expect(result.success).toBe(false);
  });

  it("should proceed to choreography when form is ready", async () => {
    const mockPage: any = {
      waitForSelector: vi.fn().mockResolvedValue({}),
      waitForLoadState: vi.fn().mockResolvedValue(undefined),
      viewportSize: () => ({ width: 1000, height: 800 }),
      mouse: { move: vi.fn(), down: vi.fn(), up: vi.fn() }
    };

    const result = await universalLoginFlow({
      page: mockPage,
      siteName: "joe",
      email: "test@example.com",
      password: "Password123",
      attemptIdx: 0,
      mode: "stealth-humanized"
    } as any);

    expect(result.success).toBe(true);
    expect(result.networkVerdict).toBe("success");
  });
});
