import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { getPersona, type BehavioralPersona } from "../../src/intelligence/ai-persona-generator.js";

// Mock askLlama
vi.mock("../../src/core/ollama-client.js", () => ({
  askLlama: vi.fn().mockResolvedValue(JSON.stringify({
    typingWpm: 55,
    baseKeyDelayMs: 90,
    mouseSpeedMultiplier: 1.1,
    scrollSpeedMultiplier: 1.0,
    readingMsPerWord: 220,
    typoRate: 0.02,
    pauseTendency: 0.25,
    mouseJitter: 0.5,
    personaDescription: "Mocked AI Typist"
  }))
}));

describe("AI Persona Generator", () => {
  const cacheFile = path.resolve(process.cwd(), "persona-cache.json");

  afterEach(() => {
    if (fs.existsSync(cacheFile)) {
      try {
        fs.unlinkSync(cacheFile);
      } catch {}
    }
  });

  it("should generate AI behavioral persona and return valid metrics", async () => {
    const persona = await getPersona(123456);
    expect(persona).toBeDefined();
    expect(persona.typingWpm).toBe(55);
    expect(persona.baseKeyDelayMs).toBe(90);
    expect(persona.source).toBe("ai");
    expect(persona.personaDescription).toBe("Mocked AI Typist");
  });

  it("should use fallback persona when AI generation throws", async () => {
    const { askLlama } = await import("../../src/core/ollama-client.js");
    (askLlama as any).mockRejectedValueOnce(new Error("LLM offline"));

    const fallbackPersona = await getPersona(999999);
    expect(fallbackPersona).toBeDefined();
    expect(fallbackPersona.source).toBe("fallback");
    expect(fallbackPersona.typingWpm).toBeGreaterThan(0);
  });
});
