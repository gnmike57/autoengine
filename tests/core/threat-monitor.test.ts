import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { ThreatMonitor } from "../../src/core/threat-monitor.js";

describe("ThreatMonitor", () => {
  it("should monitor network requests, responses and evaluate threats", () => {
    const emitter = new EventEmitter() as any;
    emitter.viewportSize = () => ({ width: 1000, height: 800 });
    emitter.mouse = {
      move: vi.fn().mockResolvedValue(undefined),
      wheel: vi.fn().mockResolvedValue(undefined)
    };

    const mockEngine = {
      log: vi.fn()
    };

    const monitor = new ThreatMonitor(emitter, mockEngine);
    expect(monitor).toBeDefined();

    const mockReq = {
      url: () => "https://unknown-analytics-tracker.com/collect"
    };

    // Emit unapproved request
    emitter.emit("request", mockReq);
    expect(mockEngine.log).toHaveBeenCalledWith("WARN", expect.stringContaining("Unapproved domain contacted"));

    const mockRes = {
      request: () => mockReq
    };

    // Emit response
    emitter.emit("response", mockRes);
  });
});
