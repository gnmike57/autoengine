import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";

// Mock the llm-provider
vi.mock("../../src/intelligence/llm-provider.js", () => {
  const generateContentMock = vi.fn();
  return {
    generateContentWithFallback: generateContentMock,
    isAiAvailable: vi.fn(() => true), // Mock default true
    OPENROUTER_MODEL_NAME: "meta-llama/llama-3.2-90b-vision-instruct:free",
    __generateContentMock: generateContentMock
  };
});

vi.mock("child_process", () => {
  const spawnMock = vi.fn();
  const execMock = vi.fn();
  return {
    spawn: spawnMock,
    exec: execMock,
  };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(),
      promises: {
        ...actual.promises,
        readdir: vi.fn(),
        readFile: vi.fn(),
        rm: vi.fn(),
        mkdtemp: vi.fn(),
      }
    },
    existsSync: vi.fn(),
    promises: {
      ...actual.promises,
      readdir: vi.fn(),
      readFile: vi.fn(),
      rm: vi.fn(),
      mkdtemp: vi.fn(),
    }
  };
});

vi.mock("ffmpeg-static", () => ({ default: "/fake/ffmpeg" }));


const llmProvider = await import("../../src/intelligence/llm-provider.js");
const cp = await import("child_process");

describe("video-verifier", () => {
  let isVerificationAvailable: any;
  let extractKeyFrames: any;
  let classifyWithAI: any;
  let verifySiteRecording: any;
  let processVerificationJob: any;
  let validateAiConfig: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    process.env.GEMINI_API_KEY = "fake-key";
    
    vi.mocked(llmProvider.isAiAvailable).mockReturnValue(true);

    const mod = await import("../../src/services/video-verifier.js");
    const extractionMod = await import("../../src/services/video-extraction.js");
    isVerificationAvailable = mod.isVerificationAvailable;
    extractKeyFrames = extractionMod.extractKeyFrames;
    classifyWithAI = mod.classifyWithAI;
    verifySiteRecording = mod.verifySiteRecording;
    processVerificationJob = mod.processVerificationJob;
    validateAiConfig = mod.validateAiConfig;
  });

  describe("isVerificationAvailable", () => {
    it("returns true if valid", async () => {
      expect(isVerificationAvailable()).toBe(true);
    });
  });

  describe("validateAiConfig", () => {
    it("returns false if no key is present", async () => {
      vi.mocked(llmProvider.isAiAvailable).mockReturnValueOnce(false);
      const result = await validateAiConfig();
      expect(result).toBe(false);
    });

    it("returns true when available", async () => {
      const result = await validateAiConfig();
      expect(result).toBe(true);
    });
  });

  describe("classifyWithAI", () => {
    const dummyBuffer = Buffer.from("dummy");

    it("returns unclear if AI not available", async () => {
      vi.mocked(llmProvider.isAiAvailable).mockReturnValueOnce(false);
      const result = await classifyWithAI([dummyBuffer], "success", "TestSite");
      expect(result.aiVerdict).toBe("unclear");
      expect(result.matches).toBe(false);
      expect(result.signalAvailable).toBe(false);
    });

    it("returns unclear if no frames", async () => {
      const result = await classifyWithAI([], "success", "TestSite");
      expect(result.aiVerdict).toBe("unclear");
      expect(result.matches).toBe(false);
      expect(result.signalAvailable).toBe(false);
    });

    it("parses valid JSON response", async () => {
      vi.mocked(llmProvider.generateContentWithFallback).mockResolvedValueOnce({
        text: JSON.stringify({ verdict: "wrong-password", confidence: "high", reasoning: "saw error" }),
        modelUsed: "gemini",
        durationMs: 100,
      });
      const result = await classifyWithAI([dummyBuffer], "noaccount", "TestSite");
      expect(result.aiVerdict).toBe("wrong-password");
      expect(result.matches).toBe(true);
      expect(result.signalAvailable).toBe(true);
    });

    it("returns unclear on error", async () => {
      vi.mocked(llmProvider.generateContentWithFallback).mockRejectedValueOnce(new Error("403 Forbidden"));
      const result = await classifyWithAI([dummyBuffer], "success", "TestSite");
      expect(result.aiVerdict).toBe("unclear");
      expect(result.matches).toBe(false);
      expect(result.signalAvailable).toBe(false);
    });

    it("handles invalid JSON response", async () => {
      vi.mocked(llmProvider.generateContentWithFallback).mockResolvedValueOnce({
        text: "I think it failed but I didn't return JSON",
        modelUsed: "gemini",
        durationMs: 100,
      });
      const result = await classifyWithAI([dummyBuffer], "success", "TestSite");
      expect(result.aiVerdict).toBe("unclear");
      expect(result.matches).toBe(false);
      expect(result.signalAvailable).toBe(false);
    });
  });

  describe("extractKeyFrames", () => {
    it("returns empty array if file does not exist (and is local)", async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      const frames = await extractKeyFrames("/path/to/missing.webm");
      expect(frames).toEqual([]);
    });

    it("extracts frames via adaptive scene detection successfully", async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.promises.mkdtemp).mockResolvedValue("/tmp/vv-frames-123");
       
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
      vi.mocked(fs.promises.readdir).mockResolvedValue(["adaptive-001.jpg", "adaptive-002.jpg"] as any);
      vi.mocked(fs.promises.readFile).mockResolvedValue(Buffer.from("img"));

      const mockSpawn = {
        on: vi.fn().mockImplementation((event, cb) => {
          if (event === "close") cb(0);
        }),
        kill: vi.fn(),
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() }
      };
       
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
      vi.mocked(cp.spawn).mockReturnValue(mockSpawn as any);

      const frames = await extractKeyFrames("http://remote.webm");
      expect(frames.length).toBe(2);
      expect(fs.promises.readdir).toHaveBeenCalledWith("/tmp/vv-frames-123");
      expect(fs.promises.rm).toHaveBeenCalledWith("/tmp/vv-frames-123", { recursive: true, force: true });
    });

    it("falls back to time-based extraction if adaptive yields 0 frames and uses ffprobe for duration", async () => {
      vi.mocked(fs.existsSync).mockImplementation((p: fs.PathLike) => 
        p.toString().includes("remote.webm") || 
        p.toString().includes("ffprobe") ||
        p.toString().includes("ffmpeg") ||
        p.toString().includes("frame-")
      );
      vi.mocked(fs.promises.mkdtemp).mockResolvedValue("/tmp/vv-frames-123");
      // Adaptive returns nothing
      vi.mocked(fs.promises.readdir).mockResolvedValueOnce([]);

      let spawnCallCount = 0;
      const mockSpawn = {
        on: vi.fn().mockImplementation((event, cb) => {
          if (event === "close") cb(0);
        }),
        kill: vi.fn(),
        stdout: { 
          on: vi.fn().mockImplementation((event, cb) => {
            if (event === "data" && spawnCallCount === 2) { // 2nd spawn is ffprobe
              cb(Buffer.from("12.5\n"));
            }
          })
        },
        stderr: { on: vi.fn() }
      };
      
      vi.mocked(cp.spawn).mockImplementation(() => {
        spawnCallCount++;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return mockSpawn as any;
      });

      // Mock readFile for the fallback frames
      vi.mocked(fs.promises.readFile).mockResolvedValue(Buffer.from("fallback-frame"));

      // Call extractKeyFrames
      const frames = await extractKeyFrames("http://remote.webm");
      expect(frames.length).toBeGreaterThan(0);
      expect(frames[0]).toEqual(Buffer.from("fallback-frame"));
    });

    it("falls back to time-based extraction and uses ffmpeg output if ffprobe fails", async () => {
      vi.mocked(fs.existsSync).mockImplementation((p: fs.PathLike) => 
        p.toString().includes("remote.webm") ||
        p.toString().includes("ffmpeg") ||
        p.toString().includes("frame-")
      );
      vi.mocked(fs.promises.mkdtemp).mockResolvedValue("/tmp/vv-frames-123");
      vi.mocked(fs.promises.readdir).mockResolvedValueOnce([]);

      let spawnCallCount = 0;
      const mockSpawn = {
        on: vi.fn().mockImplementation((event, cb) => {
          if (event === "close") cb(0);
        }),
        kill: vi.fn(),
        stdout: { on: vi.fn() },
        stderr: { 
          on: vi.fn().mockImplementation((event, cb) => {
            if (event === "data" && spawnCallCount === 2) { // ffmpeg duration output
              cb(Buffer.from("  Duration: 00:01:23.45, start: 0.0\n"));
            }
          })
        }
      };
      
      vi.mocked(cp.spawn).mockImplementation(() => {
        spawnCallCount++;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return mockSpawn as any;
      });

      vi.mocked(fs.promises.readFile).mockResolvedValue(Buffer.from("fallback-frame"));

      const frames = await extractKeyFrames("http://remote.webm");
      expect(frames.length).toBeGreaterThan(0);
    });
  });

  describe("verifySiteRecording", () => {
    it("returns unclear if frames extraction fails (0 frames)", async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      const res = await verifySiteRecording("/missing.webm", "success", "SiteA");
      expect(res.aiVerdict).toBe("unclear");
      expect(res.matches).toBe(false);
      expect(res.signalAvailable).toBe(false);
    });
  });

  describe("processVerificationJob", () => {
    it("processes all sites and returns a map", async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false); // will cause 0 frames -> unclear
      const job = {
        email: "test@example.com",
        rowIndex: 0,
        sites: [
          { name: "SiteA", engineOutcome: "success", videoPath: "/missing.webm" }
        ]
      };
      const res = await processVerificationJob(job);
      expect(res.size).toBe(1);
      expect(res.get("SiteA")!.aiVerdict).toBe("unclear");
      expect(res.get("SiteA")!.matches).toBe(false);
      expect(res.get("SiteA")!.signalAvailable).toBe(false);
    });
  });
});
