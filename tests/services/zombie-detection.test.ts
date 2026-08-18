/**
 * Zombie Process Detection Tests
 *
 * Validates the process-cleaner module's ability to find and classify
 * orphan browser processes. Tests the parsing, filtering, and kill logic
 * without actually spawning real browsers.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as os from "os";

const { mockExec } = vi.hoisted(() => ({
  mockExec: vi.fn(),
}));

vi.mock("child_process", () => ({
  exec: mockExec,
  execSync: vi.fn().mockReturnValue(""),
}));

import { findOurOrphans, killOurOrphans } from "../../src/services/process-cleaner.js";

describe("process-cleaner (zombie detection)", () => {
  beforeEach(() => {
    mockExec.mockReset();
  });

  describe("findOurOrphans", () => {
    it("returns empty array when no browser processes exist", async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockExec.mockImplementation((_cmd: string, cb: any) => {
        cb(null, { stdout: "", stderr: "" });
      });
      const result = await findOurOrphans({ minEtimeSec: 0 });
      expect(result).toEqual([]);
    });

    it("filters out non-browser processes", async () => {
      // Simulate ps output with non-browser processes
      const psOutput = os.platform() === "win32"
        ? "" // WMI format would be different
        : "1234   00:05 /usr/bin/node server.js\n5678   00:10 /usr/bin/python app.py";

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockExec.mockImplementation((_cmd: string, cb: any) => {
        cb(null, { stdout: psOutput, stderr: "" });
      });

      const result = await findOurOrphans({ minEtimeSec: 0 });
      expect(result).toEqual([]);
    });

    it("handles exec errors gracefully", async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockExec.mockImplementation((_cmd: string, cb: any) => {
        cb(new Error("Command not found"), { stdout: "", stderr: "" });
      });

      const result = await findOurOrphans({ minEtimeSec: 0 });
      expect(result).toEqual([]);
    });
  });

  describe("killOurOrphans", () => {
    it("returns zeros when no orphans found", async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockExec.mockImplementation((_cmd: string, cb: any) => {
        cb(null, { stdout: "", stderr: "" });
      });

      const result = await killOurOrphans({ timeoutMs: 1000, minEtimeSec: 0 });
      expect(result.killed).toBe(0);
      expect(result.survived).toBe(0);
    });
  });
});
