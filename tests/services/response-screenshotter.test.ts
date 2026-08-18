import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { ResponseScreenshotter } from "../../src/services/response-screenshotter.js";

describe("ResponseScreenshotter", () => {
  const testDir = path.join(process.cwd(), "screenshots", "responses");

  afterEach(() => {
    // Clean up test directories if any were created
    if (fs.existsSync(testDir)) {
      try {
        const subdirs = fs.readdirSync(testDir);
        for (const sub of subdirs) {
          if (sub.startsWith("email-")) {
            fs.rmSync(path.join(testDir, sub), { recursive: true, force: true });
          }
        }
      } catch {}
    }
  });

  it("should capture attempt full screenshot and highlighted zoom element", async () => {
    const mockEl = {
      isVisible: vi.fn().mockResolvedValue(true),
      screenshot: vi.fn().mockImplementation(async ({ path: p }) => {
        fs.writeFileSync(p, "fake-image");
      }),
      evaluate: vi.fn().mockResolvedValue(undefined)
    };

    const mockPage: any = {
      $: vi.fn().mockResolvedValue(mockEl),
      $$: vi.fn().mockResolvedValue([]),
      screenshot: vi.fn().mockImplementation(async ({ path: p }) => {
        fs.writeFileSync(p, "fake-image");
      })
    };

    const paths = await ResponseScreenshotter.captureAttempt(mockPage, {
      email: "test@example.com",
      password: "pass",
      site: "joe",
      attemptIdx: 0,
      verdict: "incorrect"
    });

    expect(paths.length).toBeGreaterThanOrEqual(1);
    for (const p of paths) {
      expect(fs.existsSync(p)).toBe(true);
    }
  });
});
