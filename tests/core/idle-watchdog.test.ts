import { describe, it, expect, vi, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { IdleWatchdog } from "../../src/core/idle-watchdog.js";

describe("IdleWatchdog", () => {
  let watchdog: IdleWatchdog;

  afterEach(() => {
    if (watchdog) watchdog.destroy();
  });

  it("should monitor activity and trigger onIdle when inactive beyond timeout", async () => {
    const emitter = new EventEmitter() as any;
    emitter.evaluate = vi.fn().mockResolvedValue(undefined);
    emitter.close = vi.fn().mockResolvedValue(undefined);
    emitter.context = () => ({ close: vi.fn().mockResolvedValue(undefined) });

    const onIdle = vi.fn();
    watchdog = new IdleWatchdog(emitter, onIdle, 50);

    // Wait 60ms and manually trigger check
    await new Promise((r) => setTimeout(r, 60));
    (watchdog as any).check();

    expect(onIdle).toHaveBeenCalled();
  });

  it("should reset timer when activity events occur", async () => {
    const emitter = new EventEmitter() as any;
    emitter.evaluate = vi.fn().mockResolvedValue(undefined);
    emitter.close = vi.fn().mockResolvedValue(undefined);
    emitter.context = () => ({ close: vi.fn().mockResolvedValue(undefined) });

    const onIdle = vi.fn();
    watchdog = new IdleWatchdog(emitter, onIdle, 100);

    // Ping at 50ms
    await new Promise((r) => setTimeout(r, 50));
    emitter.emit("request");

    // Ping at 100ms
    await new Promise((r) => setTimeout(r, 50));
    emitter.emit("response");

    (watchdog as any).check();

    expect(onIdle).not.toHaveBeenCalled();
    watchdog.destroy();
  });
});
