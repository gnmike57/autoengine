import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { aiDiagnosePage, aiDetectCaptcha } from "../../src/intelligence/ai-page-diagnosis.js";

vi.mock("../../src/intelligence/llm-provider.js", () => {
  const generateContentMock = vi.fn();
  return {
    generateContentWithFallback: generateContentMock,
    isAiAvailable: vi.fn(() => true), // Mock default true
    OPENROUTER_MODEL_NAME: "meta-llama/llama-3.2-90b-vision-instruct:free",
    __generateContentMock: generateContentMock
  };
});

const llmProvider = await import("../../src/intelligence/llm-provider.js");

describe("ai-page-diagnosis", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.mocked(llmProvider.isAiAvailable).mockReturnValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("aiDiagnosePage", () => {
    it("returns 'unknown' if no API key is present", async () => {
      vi.mocked(llmProvider.isAiAvailable).mockReturnValue(false);
      
      const buffer = Buffer.from("fake-image");
      const result = await aiDiagnosePage(buffer);
      
      expect(result.signalAvailable).toBe(false);
      expect(result.pageState).toBe("unknown");
    });

    it("parses valid JSON response successfully", async () => {
      vi.mocked(llmProvider.generateContentWithFallback).mockResolvedValueOnce({
        text: JSON.stringify({
          action: "solve_captcha",
          pageState: "captcha",
          captchaType: "recaptcha",
          details: "found recaptcha",
          confidence: "high"
        }),
        modelUsed: "gemini",
        durationMs: 100,
      });

      const buffer = Buffer.from("fake-image");
      const result = await aiDiagnosePage(buffer, "test-context");

      expect(result.action).toBe("solve_captcha");
      expect(result.pageState).toBe("captcha");
      expect(result.captchaType).toBe("recaptcha");
      expect(result.confidence).toBe("high");
      expect(result.signalAvailable).toBe(true);
      expect(llmProvider.generateContentWithFallback).toHaveBeenCalled();
    });

    it("handles invalid JSON gracefully", async () => {
      vi.mocked(llmProvider.generateContentWithFallback).mockResolvedValueOnce({
        text: "Not valid JSON at all",
        modelUsed: "gemini",
        durationMs: 100,
      });

      const buffer = Buffer.from("fake-image");
      const result = await aiDiagnosePage(buffer);

      expect(result.signalAvailable).toBe(false);
      expect(result.pageState).toBe("unknown");
    });

    it("falls back to default values when JSON contains invalid enum states", async () => {
      vi.mocked(llmProvider.generateContentWithFallback).mockResolvedValueOnce({
        text: JSON.stringify({
          action: "invalid_action",
          pageState: "invalid_state",
          details: "some details",
          confidence: "super-high"
        }),
        modelUsed: "gemini",
        durationMs: 100,
      });

      const buffer = Buffer.from("fake-image");
      const result = await aiDiagnosePage(buffer);

      expect(result.action).toBe("continue"); // Default fallback
      expect(result.pageState).toBe("unknown"); // Default fallback
      expect(result.confidence).toBe("low"); // Default fallback
      expect(result.signalAvailable).toBe(true);
    });

    it("handles API errors gracefully", async () => {
      vi.mocked(llmProvider.generateContentWithFallback).mockRejectedValueOnce(new Error("API Rate Limit"));

      const buffer = Buffer.from("fake-image");
      const result = await aiDiagnosePage(buffer);

      expect(result.signalAvailable).toBe(false);
      expect(result.pageState).toBe("unknown");
      expect(result.details).toContain("API Rate Limit");
    });
  });

  describe("aiDetectCaptcha", () => {
    it("returns captcha info correctly when captcha detected", async () => {
      vi.mocked(llmProvider.generateContentWithFallback).mockResolvedValueOnce({
        text: JSON.stringify({
          action: "solve_captcha",
          pageState: "captcha",
          captchaType: "turnstile",
          details: "found turnstile",
          confidence: "high"
        }),
        modelUsed: "gemini",
        durationMs: 100,
      });

      const buffer = Buffer.from("fake-image");
      const result = await aiDetectCaptcha(buffer);

      expect(result.hasCaptcha).toBe(true);
      expect(result.type).toBe("turnstile");
      expect(result.hasBotChallenge).toBe(false);
    });

    it("returns bot challenge correctly", async () => {
      vi.mocked(llmProvider.generateContentWithFallback).mockResolvedValueOnce({
        text: JSON.stringify({
          action: "switch_backend",
          pageState: "bot_challenge",
          details: "cloudflare IUAM",
          confidence: "high"
        }),
        modelUsed: "gemini",
        durationMs: 100,
      });

      const buffer = Buffer.from("fake-image");
      const result = await aiDetectCaptcha(buffer);

      expect(result.hasCaptcha).toBe(false);
      expect(result.hasBotChallenge).toBe(true);
    });
  });
});
