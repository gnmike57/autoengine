import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createLogger, setLogLevel, getLogLevel, LogLevel } from "../../src/core/logger.js";

describe("logger", () => {
  let originalLevel: LogLevel;

  beforeEach(() => {
    // Save original log level to restore after each test
    originalLevel = getLogLevel();
    vi.spyOn(console, "debug").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    setLogLevel(originalLevel);
    vi.restoreAllMocks();
  });

  it("can set and get log level", () => {
    const prev = setLogLevel("debug");
    expect(prev).toBe(originalLevel);
    expect(getLogLevel()).toBe("debug");

    setLogLevel("silent");
    expect(getLogLevel()).toBe("silent");
  });

  it("logs with correct prefix and respects thresholds", () => {
    const log = createLogger("test");

    setLogLevel("info");

    log.debug("should be hidden");
    expect(console.debug).not.toHaveBeenCalled();

    log.info("should be visible");
    expect(console.log).toHaveBeenCalled();
    // Verify the prefix includes the tag and the message is in the args
    const logCall = vi.mocked(console.log).mock.calls[0];
    expect(logCall?.[0]).toContain("[test]");
    expect(logCall).toContain("should be visible");

    log.warn("warning!");
    expect(console.warn).toHaveBeenCalled();
    const warnCall = vi.mocked(console.warn).mock.calls[0];
    expect(warnCall?.[0]).toContain("[test]");
    expect(warnCall).toContain("warning!");

    log.error("error!");
    expect(console.error).toHaveBeenCalled();
    const errorCall = vi.mocked(console.error).mock.calls[0];
    expect(errorCall?.[0]).toContain("[test]");
    expect(errorCall).toContain("error!");
  });

  it("debug level allows debug logs", () => {
    const log = createLogger("test2");
    setLogLevel("debug");

    log.debug("visible debug");
    expect(console.debug).toHaveBeenCalled();
    const debugCall = vi.mocked(console.debug).mock.calls[0];
    expect(debugCall?.[0]).toContain("[test2]");
    expect(debugCall).toContain("visible debug");
  });

  it("silent level suppresses all logs", () => {
    const log = createLogger("silent_test");
    setLogLevel("silent");

    log.debug("hide me");
    log.info("hide me too");
    log.warn("hide warning");
    log.error("hide error");

    expect(console.debug).not.toHaveBeenCalled();
    expect(console.log).not.toHaveBeenCalled();
    expect(console.warn).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
  });

  describe("initialization", () => {
    it("reads LOG_LEVEL from env on load", async () => {
      vi.resetModules();
      process.env.LOG_LEVEL = "error";
      const { getLogLevel } = await import("../../src/core/logger.js");
      expect(getLogLevel()).toBe("error");
    });

    it("falls back to info if LOG_LEVEL is invalid", async () => {
      vi.resetModules();
      process.env.LOG_LEVEL = "invalid_level";
      const { getLogLevel } = await import("../../src/core/logger.js");
      expect(getLogLevel()).toBe("info");
    });

    it("falls back to info for invalid threshold caused by bad setLogLevel call", async () => {
      vi.resetModules();
      const { getLogLevel, setLogLevel } = await import("../../src/core/logger.js");
      // Force an invalid threshold by bypassing TS

      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
      setLogLevel("foo" as any);
      expect(getLogLevel()).toBe("info");

      // The subsequent setLogLevel call returns the previous (which is "info" fallback)
      const prev = setLogLevel("debug");
      expect(prev).toBe("info");
    });
  });
});
