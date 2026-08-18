import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { findOurOrphans, killOurOrphans } from "../../src/services/process-cleaner.js";

vi.mock("../../src/services/process-cleaner.js", () => ({
  findOurOrphans: vi.fn(),
  killOurOrphans: vi.fn(),
  installGlobalCleanupHandlers: vi.fn(),
}));

describe("clean-zombies", () => {
  let originalArgv: string[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let originalExitCode: any;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let originalExit: any;

  beforeEach(() => {
    originalArgv = process.argv;
    originalExitCode = process.exitCode;
    originalExit = process.exit;
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
     
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    vi.spyOn(process, "exit").mockImplementation((() => {}) as any);
  });

  afterEach(() => {
    process.argv = originalArgv;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    process.exitCode = originalExitCode;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    process.exit = originalExit;
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("handles dry run with orphans found", async () => {
    process.argv = ["node", "clean-zombies.ts", "--dry"];
    vi.mocked(findOurOrphans).mockResolvedValue([
      { pid: 123, cmd: "chrome.exe --user-data-dir=test", etimeSec: 10 }
    ]);

    await import("../../src/services/clean-zombies.js");
    // We need to wait for the microtasks to finish since main() is executed asynchronously on import
    await new Promise(r => setTimeout(r, 10));

    expect(findOurOrphans).toHaveBeenCalledWith({ minEtimeSec: 0 });
    expect(killOurOrphans).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith("[clean-zombies] --dry specified; not killing");
  });

  it("exits early if no orphans found", async () => {
    process.argv = ["node", "clean-zombies.ts"];
    vi.mocked(findOurOrphans).mockResolvedValue([]);

    // @ts-expect-error dynamic import with query param unsupported by TS
    await import("../../src/services/clean-zombies.js?no-orphans");
    await new Promise(r => setTimeout(r, 10));

    expect(findOurOrphans).toHaveBeenCalled();
    expect(killOurOrphans).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith("[clean-zombies] no orphan Chromium PIDs found");
  });

  it("kills orphans and sets exitCode if any survived", async () => {
    process.argv = ["node", "clean-zombies.ts"];
    vi.mocked(findOurOrphans).mockResolvedValue([
      { pid: 123, cmd: "long command " + "x".repeat(150), etimeSec: 10 }
    ]);
    vi.mocked(killOurOrphans).mockResolvedValue({ killed: 0, survived: 1, dryRun: 0 });

    // @ts-expect-error dynamic import with query param unsupported by TS
    await import("../../src/services/clean-zombies.js?kill-survived");
    await new Promise(r => setTimeout(r, 10));

    expect(killOurOrphans).toHaveBeenCalledWith({ timeoutMs: 5000, minEtimeSec: 0 });
    expect(process.exitCode).toBe(1);
  });
});
