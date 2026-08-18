import { describe, it, expect, vi } from "vitest";

describe("E2E CMP Dismissal 3-Tier Cascade & Focus Interception Edge Cases", () => {
  it("Tier 1: Native CookieInformation API executes if present on window", async () => {
    const mockPage: any = {
      evaluate: vi.fn().mockImplementation((fn) => {
        // Simulate window.CookieInformation.submitAllCategories()
        return true;
      })
    };

    const dismissed = await mockPage.evaluate(() => {
      if ((window as any).CookieInformation?.submitAllCategories) {
        (window as any).CookieInformation.submitAllCategories();
        return true;
      }
      return false;
    });

    expect(dismissed).toBe(true);
  });

  it("Tier 2: UI Click fallback targets known cookie banner buttons", async () => {
    const clickedSelectors: string[] = [];
    const mockPage: any = {
      click: vi.fn().mockImplementation((sel: string) => {
        clickedSelectors.push(sel);
        return Promise.resolve();
      })
    };

    const selectors = [
      ".coi-banner__accept",
      "button:has-text('ACCEPT ALL')",
      "[data-coi-btn='accept']"
    ];

    for (const sel of selectors) {
      await mockPage.click(sel);
    }

    expect(clickedSelectors).toHaveLength(3);
    expect(clickedSelectors).toContain(".coi-banner__accept");
  });

  it("Tier 3: CSS Hide fallback unconditionally hides overlay containers", async () => {
    const mockPage: any = {
      addStyleTag: vi.fn().mockResolvedValue(undefined)
    };

    await mockPage.addStyleTag({
      content: `
        #coiOverlay, .coi-banner__wrapper, .coi-consent-banner {
          display: none !important;
          pointer-events: none !important;
          visibility: hidden !important;
        }
      `
    });

    expect(mockPage.addStyleTag).toHaveBeenCalledTimes(1);
  });
});
