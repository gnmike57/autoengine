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
      writeFileSync: vi.fn()
    },
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn()
  };
});

// Mock the actual module used by the implementation
vi.mock("../../src/core/ollama-client.js", () => ({
  askLlama: vi.fn(),
}));

describe("fingerprint-ai-verifier", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let verifyFingerprintCoherence: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ollamaClient: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();

    ollamaClient = await import("../../src/core/ollama-client.js");

    // Dynamically import to pick up fresh mocks
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const module = await import("../../src/stealth/fingerprint-ai-verifier.js?refresh=" + Date.now());
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    verifyFingerprintCoherence = module.verifyFingerprintCoherence;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("loads cache on startup if exists", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      "fp-somehash": { coherent: true, mismatches: [], fixSuggestions: {}, modelUsed: "cached" }
    }));

    // Re-import the module so the top-level cache-load code runs with our mocks
    await import("../../src/stealth/fingerprint-ai-verifier.js?cache-test=" + Date.now());

    // Since we don't know the hash function exactly, we can't easily trigger the cache hit.
    // We just verify it doesn't crash.
    expect(fs.readFileSync).toHaveBeenCalled();
  });

  it("returns bypassed when askLlama throws", async () => {
    vi.mocked(ollamaClient.askLlama).mockRejectedValue(new Error("Connection refused"));

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const res = await verifyFingerprintCoherence({ os: "windows" } as any);

    // askLlama errors are caught by the inner try/catch, returning "bypassed"
    expect(res.modelUsed).toBe("bypassed");
    expect(res.coherent).toBe(true); // defaults to true on error
  });

  it("returns cache hit if available", async () => {
    vi.mocked(ollamaClient.askLlama).mockResolvedValue(
      JSON.stringify({ coherent: true, mismatches: [], fixSuggestions: {} })
    );

    const bundle = { os: "linux" };
    // First call caches it
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await verifyFingerprintCoherence(bundle as any);

    // Second call should hit cache
    vi.mocked(ollamaClient.askLlama).mockClear();

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const res = await verifyFingerprintCoherence(bundle as any);

    expect(ollamaClient.askLlama).not.toHaveBeenCalled();
    expect(res.coherent).toBe(true);
  });

  it("handles valid AI response", async () => {
    vi.mocked(ollamaClient.askLlama).mockResolvedValue(
      JSON.stringify({ coherent: false, mismatches: ["OS mismatch"], fixSuggestions: { os: "mac" } })
    );

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const res = await verifyFingerprintCoherence({ os: "ios" } as any);
    expect(res.coherent).toBe(false);
    expect(res.mismatches).toContain("OS mismatch");
    expect(res.fixSuggestions.os).toBe("mac");
    expect(res.modelUsed).toBe("llama3");
    expect(fs.writeFileSync).toHaveBeenCalled();
  });

  it("handles invalid JSON from AI", async () => {
    vi.mocked(ollamaClient.askLlama).mockResolvedValue("I am an AI and I say yes");

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const res = await verifyFingerprintCoherence({ os: "android" } as any);
    expect(res.modelUsed).toBe("bypassed"); // inner catch returns "bypassed"
    expect(res.coherent).toBe(true);
  });

  it("handles API error gracefully", async () => {
    vi.mocked(ollamaClient.askLlama).mockRejectedValue(new Error("API Down"));

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const res = await verifyFingerprintCoherence({ os: "unknown" } as any);
    // askLlama errors are caught by the inner try/catch, returning "bypassed"
    expect(res.modelUsed).toBe("bypassed");
    expect(res.coherent).toBe(true); // defaults to true
  });
});
