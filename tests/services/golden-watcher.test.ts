import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { spawn } from "node:child_process";

vi.mock("node:child_process", () => {
  return {
    spawn: vi.fn()
  };
});

describe("golden-watcher", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let onMock: any;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    vi.spyOn(console, "log").mockImplementation(() => {});

    onMock = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    vi.mocked(spawn).mockReturnValue({
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      on: onMock
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("spawns npx tsx run-flow-debug.ts", async () => {
    // import triggers the script execution
    await import("../../src/services/golden-watcher.js?t=" + Date.now());

    expect(spawn).toHaveBeenCalledTimes(1);
    const args = vi.mocked(spawn).mock.calls[0];
    expect(args![0]).toBe("npx");
    expect(args![1]).toEqual(["tsx", "tests/live/run-flow-debug.ts"]);
    expect(args![2]?.env?.HEADLESS_GOLDEN).toBe("1");
  });

  it("handles close and error events", async () => {
    await import("../../src/services/golden-watcher.js?t2=" + Date.now());

    expect(onMock).toHaveBeenCalledTimes(2); // 'error' and 'close'
    
    // Find the handlers
     
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const errorHandler = onMock.mock.calls.find((c: any) => c[0] === "error")[1];
     
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const closeHandler = onMock.mock.calls.find((c: any) => c[0] === "close")[1];

    // Trigger error
    errorHandler(new Error("Test Error"));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("Failed to start"));

    // Trigger close success
    closeHandler(0);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("Baseline check passed"));

    // Trigger close fail
    closeHandler(1);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("Baseline check failed with code 1"));
  });
});
