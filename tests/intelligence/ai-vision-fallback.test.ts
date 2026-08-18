import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getElementCoordinatesFromVision } from "../../src/intelligence/ai-vision-fallback.js";

vi.mock("../../src/intelligence/llm-provider.js", () => {
  const generateContentMock = vi.fn();
  return {
    generateContentWithFallback: generateContentMock,
    isAiAvailable: vi.fn(() => true), // Mock default true
    OPENROUTER_MODEL_NAME: "meta-llama/llama-3.2-90b-vision-instruct:free", // Updated model for fallback
    __generateContentMock: generateContentMock
  };
});

const llmProvider = await import("../../src/intelligence/llm-provider.js");

describe("ai-vision-fallback", () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(llmProvider.isAiAvailable).mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns null if AI is not available", async () => {
    vi.mocked(llmProvider.isAiAvailable).mockReturnValue(false);
    
    const mockPage = { screenshot: vi.fn() };
     
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    const result = await getElementCoordinatesFromVision(mockPage as any, "login button");
    
    expect(result).toBeNull();
    expect(mockPage.screenshot).not.toHaveBeenCalled();
  });

  it("returns coordinates successfully when AI finds them", async () => {
    const mockPage = {
      screenshot: vi.fn().mockResolvedValue(Buffer.from("fake-screenshot")),
      evaluate: vi.fn().mockResolvedValue(undefined),
    };

    vi.mocked(llmProvider.generateContentWithFallback).mockResolvedValue({
      text: 'Found it here: {"x": 123, "y": 456} at the top right.',
      modelUsed: "gemini",
      durationMs: 100,
    });

     
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    const result = await getElementCoordinatesFromVision(mockPage as any, "login button");
    
    expect(result).toEqual({ x: 123, y: 456 });
    expect(mockPage.screenshot).toHaveBeenCalledWith({ fullPage: false });
  });

  it("returns null when AI returns error JSON", async () => {
    const mockPage = {
      screenshot: vi.fn().mockResolvedValue(Buffer.from("fake-screenshot")),
      evaluate: vi.fn().mockResolvedValue(undefined),
    };

    vi.mocked(llmProvider.generateContentWithFallback).mockResolvedValue({
      text: '{"error": "not found"}',
      modelUsed: "gemini",
      durationMs: 100,
    });

     
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    const result = await getElementCoordinatesFromVision(mockPage as any, "missing button");
    expect(result).toBeNull();
  });

  it("returns null when AI returns invalid format", async () => {
    const mockPage = {
      screenshot: vi.fn().mockResolvedValue(Buffer.from("fake-screenshot")),
      evaluate: vi.fn().mockResolvedValue(undefined),
    };

    vi.mocked(llmProvider.generateContentWithFallback).mockResolvedValue({
      text: 'I could not find any JSON here.',
      modelUsed: "gemini",
      durationMs: 100,
    });

     
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    const result = await getElementCoordinatesFromVision(mockPage as any, "login button");
    expect(result).toBeNull();
  });

  it("returns null and catches exception when AI call fails", async () => {
    const mockPage = {
      screenshot: vi.fn().mockResolvedValue(Buffer.from("fake-screenshot")),
      evaluate: vi.fn().mockResolvedValue(undefined),
    };

    vi.mocked(llmProvider.generateContentWithFallback).mockRejectedValue(new Error("API offline"));

     
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    const result = await getElementCoordinatesFromVision(mockPage as any, "login button");
    expect(result).toBeNull();
  });
});
