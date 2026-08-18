import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";

vi.mock("node:fs", () => {
  const mockFs = {
    existsSync: vi.fn(),
    promises: {
      rm: vi.fn(),
      readFile: vi.fn(),
      writeFile: vi.fn(),
      rename: vi.fn()
    }
  };
  return {
    ...mockFs,
    default: mockFs
  };
});

describe("hard-reset", () => {
  let originalArgv: string[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let originalEnv: any;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    
    originalArgv = [...process.argv];
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    process.argv = originalArgv;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it("executes dry run successfully", async () => {
    process.argv = ["node", "hard-reset.ts", "--dry"];
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.promises.readFile).mockResolvedValue(JSON.stringify({
      rows: [
        {
          status: "testing",
          sites: {
            joefortune: { outcome: "N/A", error: "misdirection: UPDATE YOUR PIN" }
          }
        }
      ]
    }));

    // Dynamic import runs the main function
    await import("../../src/services/hard-reset.js?dry=" + Date.now());
    
    // Allow promises to resolve
    await new Promise(r => setTimeout(r, 50));
    
    expect(fs.promises.rm).not.toHaveBeenCalled();
    expect(fs.promises.writeFile).not.toHaveBeenCalled();
  });

  it("executes force reset and modifies progress.json", async () => {
    process.argv = ["node", "hard-reset.ts", "--force"];
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.promises.readFile).mockResolvedValue(JSON.stringify({
      rows: [
        {
          status: "failed",
          sites: {
            joefortune: { outcome: "N/A", error: "misdirection: UPDATE YOUR PIN" }
          }
        }
      ]
    }));

    await import("../../src/services/hard-reset.js?force=" + Date.now());
    
    await new Promise(r => setTimeout(r, 50));
    
    // Verify directory removal
    expect(fs.promises.rm).toHaveBeenCalled();
    
    // Verify progress.json write
    expect(fs.promises.writeFile).toHaveBeenCalled();
    const writeArgs = vi.mocked(fs.promises.writeFile).mock.calls[0];
    expect(writeArgs![0]).toBe("progress.json.tmp");
    
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const writtenData = JSON.parse(writeArgs![1] as string);
    expect(writtenData.rows[0].status).toBe("queued");
    expect(writtenData.rows[0].sites.joefortune.outcome).toBe("queued");
    expect(writtenData.rows[0].sites.joefortune.error).toBeUndefined();
    
    expect(fs.promises.rename).toHaveBeenCalledWith("progress.json.tmp", "progress.json");
  });

  it("skips invalid json and missing fields", async () => {
    process.argv = ["node", "hard-reset.ts", "--force"];
    
    // Test 1: Invalid JSON
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.promises.readFile).mockResolvedValue("not-json");
    await import("../../src/services/hard-reset.js?invalid1=" + Date.now());
    await new Promise(r => setTimeout(r, 20));
    expect(fs.promises.writeFile).not.toHaveBeenCalled();

    // Test 2: Valid JSON but no rows
    vi.mocked(fs.promises.readFile).mockResolvedValue(JSON.stringify({ other: true }));
    await import("../../src/services/hard-reset.js?invalid2=" + Date.now());
    await new Promise(r => setTimeout(r, 20));
    expect(fs.promises.writeFile).not.toHaveBeenCalled();
  });
});
