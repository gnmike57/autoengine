import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";

vi.mock("node:fs", () => {
  const mockFs = {
    existsSync: vi.fn(),
    promises: {
      readFile: vi.fn(),
      readdir: vi.fn(),
      rename: vi.fn()
    }
  };
  return {
    ...mockFs,
    default: mockFs
  };
});

describe("rename-recordings", () => {
  let originalArgv: string[];
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    vi.clearAllMocks();
    originalArgv = process.argv;
    originalEnv = process.env;
    
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    
    process.env.CLOAK_RECORDING_DIR = "test-recordings";
  });

  afterEach(() => {
    process.argv = originalArgv;
    process.env = originalEnv;
  });

  it("handles missing recordings dir", async () => {
    process.argv = ["node", "rename-recordings.ts"];
    vi.mocked(fs.existsSync).mockImplementation((path) => {
      if (path.toString().includes("test-recordings")) return false;
      return false;
    });

    await import("../../src/services/rename-recordings.js?invalid1=" + Date.now());
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("recordings dir not found"));
  });

  it("dry-run plans renames successfully", async () => {
    process.argv = ["node", "rename-recordings.ts"];
    vi.mocked(fs.existsSync).mockImplementation((path) => {
      if (path.toString().includes("test-recordings")) return true;
      if (path.toString().includes("progress.json")) return true;
      return false;
    });

    vi.mocked(fs.promises.readFile).mockResolvedValue(JSON.stringify({
      rows: [
        { sessionId: "s1", email: "test@example.com" },
        { sessionId: "s2", email: "nocred-user@test.com" }
      ]
    }));

    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    vi.mocked(fs.promises.readdir).mockResolvedValue([
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      "s1.webm" as any, // needs rename
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      "test_example_com__s1.webm" as any, // already ok
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      "s3.webm" as any, // orphan
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      "not-webm.txt" as any // ignore
    ]);

    await import("../../src/services/rename-recordings.js?invalid2=" + Date.now());
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("DRY-RUN"));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("1 rename(s), 1 already-ok, 1 orphan(s)"));
  });

  it("apply executes renames successfully", async () => {
    process.argv = ["node", "rename-recordings.ts", "--apply"];
    vi.mocked(fs.existsSync).mockImplementation((p) => {
      const pathStr = p.toString();
      if (pathStr.endsWith("test-recordings")) return true;
      if (pathStr.endsWith("progress.json")) return true;
      if (pathStr.includes("test_example.com__s2.webm")) return true;
      return false;
    });

    vi.mocked(fs.promises.readFile).mockResolvedValue(JSON.stringify({
      rows: [
        { sessionId: "s1", email: "test@example.com" },
        { sessionId: "s2", email: "test@example.com" },
        { sessionId: "s4", email: "fail@example.com" }
      ]
    }));

    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    vi.mocked(fs.promises.readdir).mockResolvedValue([
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      "s1.webm" as any, // rename success
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      "s2.webm" as any, // skip collision
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      "s4.webm" as any  // rename fail
    ]);

    vi.mocked(fs.promises.rename).mockImplementation((_src, dest) => {
      if (dest.toString().includes("fail")) return Promise.reject(new Error("rename error"));
      return Promise.resolve();
    });

    await import("../../src/services/rename-recordings.js?invalid3=" + Date.now());
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("APPLY"));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("renamed=1 skipped=1 failed=1"));
  });
  
  it("handles malformed progress.json", async () => {
    process.argv = ["node", "rename-recordings.ts", "--apply"];
    vi.mocked(fs.existsSync).mockImplementation((path) => {
      if (path.toString().includes("test-recordings")) return true;
      if (path.toString().includes("progress.json")) return true;
      return false;
    });

    vi.mocked(fs.promises.readFile).mockResolvedValue("invalid json");
    vi.mocked(fs.promises.readdir).mockResolvedValue([]);

    await import("../../src/services/rename-recordings.js?invalid4=" + Date.now());
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("Failed to parse"));
  });
});
