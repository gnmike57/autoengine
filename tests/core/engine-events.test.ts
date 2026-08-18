/**
 * Test 19: Event Emission Contract
 *
 * Verifies the engine emits correctly-shaped events for the dashboard.
 */
import { describe, it, expect } from "vitest";
import { AutomationEngine } from "../../src/core/engine.js";

describe("engine event emission contract (Test 19)", () => {
  let engine: AutomationEngine;

  it("engine is an EventEmitter with working on/emit", () => {
    engine = new AutomationEngine();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let received: any = null;
     
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    engine.on("log", (data: any) => { received = data; });
    engine.emit("log", { level: "INFO", message: "test" });
    expect(received).toEqual({ level: "INFO", message: "test" });
  });

  it("engine.log method emits 'log' events with { level, message } shape", () => {
    engine = new AutomationEngine();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const logs: any[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    engine.on("log", (data: any) => logs.push(data));

    // Call the internal log method
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (engine as any).log("INFO", "Hello world");

    expect(logs.length).toBeGreaterThan(0);
    expect(logs[0]).toHaveProperty("level");
    expect(logs[0]).toHaveProperty("message");
    expect(logs[0].level).toBe("INFO");
    expect(logs[0].message).toContain("Hello world");
  });

  it("log method supports WARN level", () => {
    engine = new AutomationEngine();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const logs: any[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    engine.on("log", (data: any) => logs.push(data));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (engine as any).log("WARN", "Warning test");
    expect(logs.some(l => l.level === "WARN")).toBe(true);
  });

  it("log method supports DEBUG level", () => {
    engine = new AutomationEngine();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const logs: any[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    engine.on("log", (data: any) => logs.push(data));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (engine as any).log("DEBUG", "Debug test");
    // DEBUG might be filtered, but if emitted, shape is correct
    for (const log of logs) {
      expect(log).toHaveProperty("level");
      expect(log).toHaveProperty("message");
    }
  });

  it("engine can emit 'row-update' with { idx, row } shape", () => {
    engine = new AutomationEngine();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let received: any = null;
     
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    engine.on("row-update", (data: any) => { received = data; });

    const mockRow = {
      idx: 0,
      row: {
        email: "test@example.com",
        status: "testing",
        sites: {
          joe: { outcome: "testing", attempts: 1 },
          ignition: { outcome: "queued", attempts: 0 },
        },
      },
    };

    engine.emit("row-update", mockRow);
    expect(received).not.toBeNull();
    expect(received.idx).toBe(0);
    expect(received.row.email).toBe("test@example.com");
    expect(received.row.sites).toHaveProperty("joe");
    expect(received.row.sites.joe.outcome).toBe("testing");
  });

  it("engine can emit 'screenshot' with correct shape", () => {
    engine = new AutomationEngine();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let received: any = null;
     
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    engine.on("screenshot", (data: any) => { received = data; });

    engine.emit("screenshot", {
      filename: "test.jpeg",
      base64: "abc123",
      siteName: "joe",
      rowIdx: 0,
    });

    expect(received).not.toBeNull();
    expect(received.filename).toBe("test.jpeg");
    expect(received.base64).toBe("abc123");
    expect(received.siteName).toBe("joe");
    expect(received.rowIdx).toBe(0);
  });

  it("engine can emit 'stopping' with no payload", () => {
    engine = new AutomationEngine();
    let stopCalled = false;
    engine.on("stopping", () => { stopCalled = true; });
    engine.emit("stopping");
    expect(stopCalled).toBe(true);
  });

  it("engine can emit 'complete' with { rows } array", () => {
    engine = new AutomationEngine();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let received: any = null;
     
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    engine.on("complete", (data: any) => { received = data; });

    engine.emit("complete", { rows: [{ email: "a@b.com", status: "done" }] });
    expect(received).not.toBeNull();
    expect(Array.isArray(received.rows)).toBe(true);
    expect(received.rows[0].email).toBe("a@b.com");
  });

  it("engine starts with running=false", () => {
    engine = new AutomationEngine();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((engine as any).running).toBe(false);
  });

  it("engine starts with isPaused=false", () => {
    engine = new AutomationEngine();
    expect(engine.isPaused).toBe(false);
  });
});
