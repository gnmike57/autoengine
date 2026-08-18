/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unused-vars */
import { describe, it, expect, vi } from "vitest";

vi.mock("fs", () => ({
  default: {
    existsSync: vi.fn().mockReturnValue(false),
    readFileSync: vi.fn().mockReturnValue("{}"),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
  },
  existsSync: vi.fn().mockReturnValue(false),
  readFileSync: vi.fn().mockReturnValue("{}"),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

import { analyzeInitialResponse, type BlockPrediction } from "../../src/intelligence/block-predictor.js";

function makeMockResponse(headers: Record<string, string>, status: number = 200, bodyContent: Buffer = Buffer.from("ok")) {
  return {
    headers: vi.fn().mockReturnValue(headers),
    status: vi.fn().mockReturnValue(status),
    body: vi.fn().mockResolvedValue(bodyContent),
    timing: vi.fn().mockReturnValue({ responseStart: 100, requestStart: 50 }),
  } as any;
}

describe("block-predictor", () => {
  describe("analyzeInitialResponse", () => {
    it("detects WAF headers (simple name match)", async () => {
      const response = makeMockResponse({
        "cf-mitigated": "challenge",
        "content-type": "text/html",
      });

      const result = await analyzeInitialResponse(response, "joe");

      expect(result.vectors.challenge_headers).toContain("cf-mitigated");
      expect(result.isLikelyBlocked).toBe(true);
      expect(result.confidence).toBeGreaterThan(0);
    });

    it("detects WAF headers with key:value format", async () => {
      const response = makeMockResponse({
        server: "ddos-guard",
        "content-type": "text/html",
      });

      const result = await analyzeInitialResponse(response, "joe");

      expect(result.vectors.challenge_headers).toContain("server: ddos-guard");
      expect(result.isLikelyBlocked).toBe(true);
    });

    it("detects Cloudflare challenge bypass combo", async () => {
      const response = makeMockResponse({
        "cf-ray": "abc123",
        "cf-chl-bypass": "true",
      });

      const result = await analyzeInitialResponse(response, "joe");

      expect(result.vectors.challenge_headers).toContain("cf-chl-bypass");
    });

    it("returns clean prediction when no WAF signals found", async () => {
      const response = makeMockResponse({
        "content-type": "text/html",
        server: "nginx",
      });

      const result = await analyzeInitialResponse(response, "joe");

      expect(result.vectors.challenge_headers).toHaveLength(0);
      // May still be blocked based on body size anomalies, but headers are clean
    });

    it("handles empty headers without crashing", async () => {
      const response = makeMockResponse({});

      const result = await analyzeInitialResponse(response, "unknown-site");
      expect(result).toBeDefined();
      expect(result.vectors.challenge_headers).toHaveLength(0);
    });

    it("handles malformed header values gracefully (key:value split edge case)", async () => {
      // The fixed code uses parts[0] and parts[1] with null guards
      // This test ensures headers with colons in values don't crash
      const response = makeMockResponse({
        "x-datadome-cid": "some:complex:value",
      });

      const result = await analyzeInitialResponse(response, "joe");
      // x-datadome-cid is a simple-name header (no colon in WAF_HEADERS), so it should be detected
      expect(result.vectors.challenge_headers).toContain("x-datadome-cid");
    });

    it("handles body() rejection gracefully", async () => {
      const response = {
        headers: vi.fn().mockReturnValue({}),
        status: vi.fn().mockReturnValue(200),
        body: vi.fn().mockRejectedValue(new Error("Stream consumed")),
        timing: vi.fn().mockReturnValue({ responseStart: 100, requestStart: 50 }),
      } as any;

      const result = await analyzeInitialResponse(response, "joe");
      expect(result).toBeDefined();
    });
  });
});
