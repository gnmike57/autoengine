import { describe, it, expect } from "vitest";
import { Timings, DynamicTimings } from "../../src/core/timings.js";

describe("timings", () => {
  it("exports Timings and DynamicTimings", () => {
    expect(Timings).toBeDefined();
    expect(DynamicTimings).toBeDefined();
    expect(typeof Timings.GOTO_TIMEOUT).toBe("number");
    expect(Timings.GOTO_TIMEOUT).toBe(30000);
  });

  it("DynamicTimings starts matching Timings", () => {
    for (const key of Object.keys(Timings)) {
      const k = key as keyof typeof Timings;
      expect(DynamicTimings[k]).toBe(Timings[k]);
    }
  });

  it("DynamicTimings can be mutated", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (DynamicTimings as any).GOTO_TIMEOUT = 9999;
    expect(DynamicTimings.GOTO_TIMEOUT).toBe(9999);
    // Restore
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (DynamicTimings as any).GOTO_TIMEOUT = Timings.GOTO_TIMEOUT;
  });
});
