import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(),
      readFileSync: vi.fn(),
      writeFileSync: vi.fn(),
    },
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
  };
});

// Mock the actual module used by ai-persona-generator
vi.mock("../../src/core/ollama-client.js", () => ({
  askLlama: vi.fn(),
}));

describe("ai-persona-generator", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let getPersona: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ollamaClient: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    vi.mocked(fs.existsSync).mockReturnValue(false);

    ollamaClient = await import("../../src/core/ollama-client.js");

    const mod = await import("../../src/intelligence/ai-persona-generator.js");
    getPersona = mod.getPersona;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("getPersona", () => {
    it("returns cached persona if it exists", async () => {
      // Setup fake cache hit
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
        "persona-123": {
          typingWpm: 99,
          baseKeyDelayMs: 99,
          mouseSpeedMultiplier: 99,
          scrollSpeedMultiplier: 99,
          readingMsPerWord: 99,
          typoRate: 99,
          pauseTendency: 99,
          mouseJitter: 99,
          personaDescription: "Cached persona",
          source: "ai"
        }
      }));

      // Reload module to pick up new mock filesystem state
      vi.resetModules();
      const mod = await import("../../src/intelligence/ai-persona-generator.js");
      const result = await mod.getPersona(123);

      expect(result.typingWpm).toBe(99);
      expect(result.personaDescription).toBe("Cached persona");
      expect(ollamaClient.askLlama).not.toHaveBeenCalled();
    });

    it("uses fallback if askLlama throws (AI not available)", async () => {
      vi.mocked(ollamaClient.askLlama).mockRejectedValue(new Error("Connection refused"));

      const result = await getPersona(456);

      expect(result.source).toBe("fallback");
      expect(result.personaDescription).toContain("456");
    });

    it("uses AI successfully and caches the result", async () => {
      vi.mocked(ollamaClient.askLlama).mockResolvedValueOnce(
        JSON.stringify({
          typingWpm: 50,
          baseKeyDelayMs: 120,
          mouseSpeedMultiplier: 1.1,
          scrollSpeedMultiplier: 1.2,
          readingMsPerWord: 200,
          typoRate: 0.04,
          pauseTendency: 0.2,
          mouseJitter: 0.5,
          personaDescription: "Test AI Persona"
        })
      );

      const result = await getPersona(789);

      expect(result.source).toBe("ai");
      expect(result.typingWpm).toBe(50);
      expect(result.personaDescription).toBe("Test AI Persona");
      expect(ollamaClient.askLlama).toHaveBeenCalled();

      // Should have saved to cache
      expect(fs.writeFileSync).toHaveBeenCalled();
      const cacheCall = vi.mocked(fs.writeFileSync).mock.calls[0]![1] as string;
      expect(cacheCall).toContain("Test AI Persona");
    });

    it("falls back to deterministic generation if AI fails", async () => {
      vi.mocked(ollamaClient.askLlama).mockRejectedValueOnce(new Error("API offline"));

      const result = await getPersona(999);

      expect(result.source).toBe("fallback");
      expect(result.personaDescription).toContain("999");
    });

    it("falls back to deterministic generation if AI returns invalid JSON", async () => {
      vi.mocked(ollamaClient.askLlama).mockResolvedValueOnce("I cannot generate that.");

      const result = await getPersona(111);

      expect(result.source).toBe("fallback");
    });
  });
});
