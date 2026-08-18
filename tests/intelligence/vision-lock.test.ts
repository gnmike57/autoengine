import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { enforceVisualLock } from "../../src/intelligence/vision-lock.js";

// Mock global fetch
vi.mock("node-fetch", () => ({
  default: vi.fn()
}));

import fetch from "node-fetch";

describe("Vision Lock", () => {
  const testImg = path.join(process.cwd(), "scratch", "test-vision-lock.jpg");

  beforeEach(() => {
    fs.mkdirSync(path.dirname(testImg), { recursive: true });
    fs.writeFileSync(testImg, "fake-image-data");
    process.env.OPENROUTER_API_KEY = "test-key";
  });

  afterEach(() => {
    if (fs.existsSync(testImg)) fs.unlinkSync(testImg);
    delete process.env.OPENROUTER_API_KEY;
    vi.restoreAllMocks();
  });

  it("should return REJECT if OPENROUTER_API_KEY is missing", async () => {
    delete process.env.OPENROUTER_API_KEY;
    const result = await enforceVisualLock(testImg, "SUCCESS");
    expect(result).toBe("REJECT");
  });

  it("should return REJECT if image file does not exist", async () => {
    const result = await enforceVisualLock("non-existent.jpg", "SUCCESS");
    expect(result).toBe("REJECT");
  });

  it("should return CONFIRM when vision model replies with [CONFIRM]", async () => {
    const mockedFetch = fetch as unknown as ReturnType<typeof vi.fn>;
    mockedFetch.mockResolvedValueOnce({
      status: 200,
      json: async () => ({
        choices: [{ message: { content: "Outcome is clear: [CONFIRM]" } }]
      })
    });

    const result = await enforceVisualLock(testImg, "SUCCESSFUL_LOGIN");
    expect(result).toBe("CONFIRM");
  });

  it("should handle HTTP 429 rate limit correctly", async () => {
    const mockedFetch = fetch as unknown as ReturnType<typeof vi.fn>;
    mockedFetch.mockResolvedValueOnce({
      status: 429,
      json: async () => ({ error: { message: "rate limit exceeded" } })
    });

    const result = await enforceVisualLock(testImg, "SUCCESSFUL_LOGIN");
    expect(result).toBe("RATE_LIMIT");
  });
});
