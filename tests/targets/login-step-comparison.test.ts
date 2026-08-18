import { describe, it, expect } from "vitest";
import { summarizeLoginStepComparisons, type LoginStepObservation } from "../../src/targets/login-step-comparison.js";

describe("Login Step Comparison", () => {
  it("should throw RangeError for invalid latency", () => {
    const observations: LoginStepObservation[] = [
      { layer: "submit", variant: "press_enter", runId: "r1", success: true, latencyMs: -10 }
    ];
    expect(() => summarizeLoginStepComparisons(observations)).toThrow(RangeError);
  });

  it("should summarize observations and compute median/p95 latency and acceptance rates", () => {
    const observations: LoginStepObservation[] = [
      { layer: "submit", variant: "press_enter", runId: "r1", success: true, latencyMs: 100, acceptedSubmit: true, evidenceSignalCount: 2, driftFixturePassed: true },
      { layer: "submit", variant: "press_enter", runId: "r2", success: true, latencyMs: 200, acceptedSubmit: true, evidenceSignalCount: 3, driftFixturePassed: true },
      { layer: "submit", variant: "press_enter", runId: "r3", success: false, latencyMs: 300, acceptedSubmit: false, evidenceSignalCount: 1, driftFixturePassed: false },
      { layer: "discovery", variant: "cookie_api", runId: "r4", success: true, latencyMs: 50 }
    ];

    const summaries = summarizeLoginStepComparisons(observations);
    expect(summaries.length).toBe(2);

    const submitSummary = summaries.find(s => s.variant === "press_enter");
    expect(submitSummary).toBeDefined();
    expect(submitSummary?.runs).toBe(3);
    expect(submitSummary?.successCount).toBe(2);
    expect(submitSummary?.medianLatencyMs).toBe(200);
    expect(submitSummary?.acceptedSubmitRate).toBeCloseTo(0.666667, 4);
    expect(submitSummary?.driftPassRate).toBeCloseTo(0.666667, 4);
  });
});
