import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as child_process from "child_process";
import { findOurOrphans, killOurOrphans, cleanPreviousZombies, startPeriodicZombieReaper, stopPeriodicZombieReaper } from "../../src/services/process-cleaner.js";

vi.mock("child_process", () => ({
  exec: vi.fn(),
  execSync: vi.fn()
}));

vi.mock("os", () => ({
  platform: vi.fn(() => "win32"),
  tmpdir: vi.fn(() => "c:\\temp")
}));

vi.mock("../../src/services/logger.js", () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  }))
}));

describe("process-cleaner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-11T12:00:00Z"));
  });

  afterEach(() => {
    stopPeriodicZombieReaper();
    vi.useRealTimers();
  });

  describe("findOurOrphans", () => {
    it("should return empty array if exec fails (Windows)", async () => {
       
       
       
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (child_process.exec as any).mockImplementation((_cmd: any, _opts: any, cb: any) => {
        cb(new Error("Command failed"), { stdout: "" });
      });
      // Fallback uses tasklist
      const result = await findOurOrphans();
      expect(result).toEqual([]);
    });

    it("should parse powershell output correctly (Windows)", async () => {
      const csvOutput = `"ProcessId","CommandLine","CreationDate"\r\n"1234","chrome.exe --user-data-dir=""c:\\temp\\cloak-profiles\\123""","6/10/2026 5:00:00 PM"\r\n`;
       
       
       
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (child_process.exec as any).mockImplementation((cmd: any, _opts: any, cb: any) => {
        if (cmd.includes("powershell")) {
          cb!(null, { stdout: csvOutput });
        } else {
          cb(new Error(""), { stdout: "" });
        }
      });
      
      const result = await findOurOrphans();
      expect(result).toHaveLength(1);
      expect(result[0]!.pid).toBe(1234);
    });
  });

  describe("killOurOrphans", () => {
    it("should return early if no orphans found", async () => {
       
       
       
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (child_process.exec as any).mockImplementation((_cmd: any, _opts: any, cb: any) => cb!(null, { stdout: "" }));
      const result = await killOurOrphans();
      expect(result).toEqual({ killed: 0, survived: 0, dryRun: 0 });
    });

    it("should dryRun successfully", async () => {
      const csvOutput = `"ProcessId","CommandLine","CreationDate"\r\n"1234","chrome.exe --user-data-dir=""c:\\temp\\cloak-profiles\\123""","6/10/2026 5:00:00 PM"\r\n`;
       
       
       
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (child_process.exec as any).mockImplementation((cmd: any, _opts: any, cb: any) => {
        if (cmd.includes("powershell")) {
          cb!(null, { stdout: csvOutput });
        } else {
          cb(new Error(""), { stdout: "" });
        }
      });

      const result = await killOurOrphans({ dryRun: true });
      expect(result).toEqual({ killed: 0, survived: 0, dryRun: 1 });
    });
  });

  describe("cleanPreviousZombies", () => {
    it("should execute kill flow if orphans found", async () => {
      const csvOutput = `"ProcessId","CommandLine","CreationDate"\r\n"1234","chrome.exe --user-data-dir=""c:\\temp\\cloak-profiles\\123""","6/10/2026 5:00:00 PM"\r\n`;
       
       
       
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (child_process.exec as any).mockImplementation((cmd: any, _opts: any, cb: any) => {
        if (cmd.includes("powershell")) {
          cb!(null, { stdout: csvOutput });
        } else {
          cb(new Error(""), { stdout: "" });
        }
      });
       
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (child_process.execSync as any).mockImplementation((_cmd: any) => {
        return "";
      });

      await cleanPreviousZombies();
      expect(child_process.execSync).toHaveBeenCalledWith(expect.stringContaining("taskkill /F /T /PID 1234"), expect.anything());
    });
  });

  describe("startPeriodicZombieReaper / stopPeriodicZombieReaper", () => {
    it("should start and stop interval without throwing", () => {
      startPeriodicZombieReaper(1000, 30);
      expect(vi.getTimerCount()).toBe(1);

      stopPeriodicZombieReaper();
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});
