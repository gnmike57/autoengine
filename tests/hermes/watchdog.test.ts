                                                                                                                                                                                                                                                                                                           import { describe, it, expect, vi, afterEach } from "vitest";
import { Watchdog } from "../../src/hermes/watchdog.js";

describe("Hermes Watchdog", () => {
  let watchdog: Watchdog;

  afterEach(() => {
    if (watchdog) watchdog.stop();
  });

  it("should initialize with default configuration and report status", () => {
    watchdog = new Watchdog();
    const status = watchdog.getStatus();

    expect(status.running).toBe(false);
    expect(status.hermesAlive).toBe(true);
    expect(status.stallDetected).toBe(false);
    expect(status.checksPerformed).toBe(0);
  });

  it("should start and stop timer loop cleanly", () => {
    watchdog = new Watchdog({ heartbeatIntervalMs: 50 });
    watchdog.start();

    const statusRunning = watchdog.getStatus();
    expect(statusRunning.running).toBe(true);

    watchdog.stop();
    const statusStopped = watchdog.getStatus();
    expect(statusStopped.running).toBe(false);
  });

  it("should trigger stall detection when engine is active but no outcomes occur", () => {
    const onWarn = vi.fn();
    const onRestart = vi.fn();

    watchdog = new Watchdog({
      stallTimeoutMs: 100,
      isEngineRunning: () => true,
      getActiveSessions: () => 2,
      getLastOutcomeTimestamp: () => Date.now() - 500,
      onWarn,
      onRestart
    });

    // Manually invoke tick via any cast
    (watchdog as any).tick();

    const status = watchdog.getStatus();
    expect(status.stallDetected).toBe(true);
    expect(onWarn).toHaveBeenCalled();
  });
});
