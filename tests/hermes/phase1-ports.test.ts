/**
 * Unit tests for Phase 1 ported Hermes modules.
 *
 * Tests: anomaly-detector, triage, telemetry, reports, learning-db
 * (screenshot-diff is tested separately since it requires sharp + image files)
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
// === Anomaly Detector ===
import { AnomalyDetector } from "../../src/hermes/anomaly-detector.js";

describe("AnomalyDetector", () => {
  let detector: AnomalyDetector;

  beforeEach(() => {
    detector = new AnomalyDetector(2.0);
  });

  it("returns null with fewer than 5 data points", () => {
    for (let i = 0; i < 4; i++) {
      expect(detector.check("metric_a", 10)).toBeNull();
    }
  });

  it("returns null for values within normal range", () => {
    // Feed consistent values
    for (let i = 0; i < 10; i++) {
      detector.check("metric_a", 100 + (i % 3));
    }
    // Value near the mean should not trigger
    expect(detector.check("metric_a", 101)).toBeNull();
  });

  it("returns an alert for a large deviation", () => {
    // Build up baseline of consistent values
    for (let i = 0; i < 20; i++) {
      detector.check("metric_a", 100);
    }
    // Huge outlier
    const alert = detector.check("metric_a", 999);
    expect(alert).not.toBeNull();
    expect(alert!.metricName).toBe("metric_a");
    expect(alert!.value).toBe(999);
    expect(alert!.deviationSigma).toBeGreaterThan(2);
    expect(alert!.timestamp).toBeTruthy();
  });

  it("getStats returns correct structure", () => {
    detector.record("cpu", 50);
    detector.record("cpu", 60);
    const stats = detector.getStats("cpu");
    expect(stats).not.toBeNull();
    expect(stats!.count).toBe(2);
    expect(stats!.last5).toHaveLength(2);
  });

  it("getStats returns null for unknown metric", () => {
    expect(detector.getStats("unknown")).toBeNull();
  });

  it("reset clears all data", () => {
    detector.record("a", 1);
    detector.reset();
    expect(detector.getStats("a")).toBeNull();
  });
});

// === Triage ===
import { classifyFailure, getRemediation, clusterErrors, type TriageCategory } from "../../src/hermes/triage.js";

describe("Triage", () => {
  it("classifies infrastructure failures", () => {
    expect(classifyFailure({ data: { outcome: "error", error: "ECONNREFUSED" } })).toBe("infrastructure");
    expect(classifyFailure({ data: { outcome: "error", error: "proxy timeout" } })).toBe("infrastructure");
    expect(classifyFailure({ data: { outcome: "blocked", message: "502 Bad Gateway" } })).toBe("infrastructure");
  });

  it("classifies site change failures", () => {
    expect(classifyFailure({ data: { outcome: "error", error: "element not found" } })).toBe("site_change");
    expect(classifyFailure({ data: { outcome: "N/A", message: "timeout waiting for selector" } })).toBe("site_change");
  });

  it("classifies credential invalid", () => {
    expect(classifyFailure({ data: { outcome: "noaccount" } })).toBe("credential_invalid");
    expect(classifyFailure({ data: { outcome: "disabled" } })).toBe("credential_invalid");
  });

  it("classifies rate limiting", () => {
    expect(classifyFailure({ data: { outcome: "blocked", error: "rate limit exceeded" } })).toBe("rate_limited");
    expect(classifyFailure({ data: { outcome: "error", error: "429 Too Many Requests" } })).toBe("rate_limited");
    expect(classifyFailure({ data: { outcome: "captcha detected" } })).toBe("rate_limited");
  });

  it("returns unknown for unrecognized failures", () => {
    expect(classifyFailure({ data: { outcome: "something_weird" } })).toBe("unknown");
    expect(classifyFailure({})).toBe("unknown");
  });

  it("getRemediation returns a non-empty string for all categories", () => {
    const categories: TriageCategory[] = [
      "infrastructure", "site_change", "credential_invalid", "rate_limited", "unknown"
    ];
    for (const cat of categories) {
      expect(getRemediation(cat).length).toBeGreaterThan(10);
    }
  });

  it("clusterErrors groups similar strings", () => {
    const errors = [
      "element not found on login page",
      "element not found on login form",
      "proxy timeout ECONNREFUSED",
      "proxy connection refused ETIMEDOUT",
    ];
    const clusters = clusterErrors(errors);
    // Should have fewer clusters than original errors
    expect(clusters.size).toBeLessThanOrEqual(errors.length);
    expect(clusters.size).toBeGreaterThanOrEqual(2); // at least 2 distinct groups
  });
});

// === Telemetry ===
import { parseRowUpdate, trackRequest, resetTracking } from "../../src/hermes/telemetry.js";

describe("Telemetry", () => {
  afterEach(() => resetTracking());

  it("parseRowUpdate extracts failure type from outcome", () => {
    const t = parseRowUpdate({ data: { outcome: "blocked-captcha" } });
    expect(t.failureType).toBe("blocked");
  });

  it("parseRowUpdate handles N/A", () => {
    const t = parseRowUpdate({ data: { outcome: "N/A" } });
    expect(t.failureType).toBe("not-available");
  });

  it("parseRowUpdate extracts screenshot paths", () => {
    const t = parseRowUpdate({
      data: { outcome: "error", screenshots: ["/a.png", "/b.png"] },
    });
    expect(t.screenshotPaths).toEqual(["/a.png", "/b.png"]);
  });

  it("parseRowUpdate handles single screenshot", () => {
    const t = parseRowUpdate({ data: { outcome: "error", screenshot: "/solo.png" } });
    expect(t.screenshotPaths).toEqual(["/solo.png"]);
  });

  it("parseRowUpdate carries recent outcomes", () => {
    const t = parseRowUpdate(
      { data: { outcome: "blocked" } },
      ["success", "blocked", "N/A"]
    );
    expect(t.lastNOutcomes).toEqual(["success", "blocked", "N/A"]);
  });

  it("trackRequest returns null under threshold", () => {
    for (let i = 0; i < 49; i++) {
      expect(trackRequest("example.com")).toBeNull();
    }
  });

  it("trackRequest returns RATE_LIMIT_WARNING over threshold", () => {
    for (let i = 0; i < 51; i++) {
      trackRequest("flood.com");
    }
    expect(trackRequest("flood.com")).toBe("RATE_LIMIT_WARNING");
  });
});

// === Reports ===
import { generateRunSummary } from "../../src/hermes/reports.js";

describe("Reports", () => {
  it("generates a valid summary from events", () => {
    const events = [
      { data: { outcome: "success", email: "a@test.com", creditsSpent: 0.5 } },
      { data: { outcome: "success", email: "b@test.com", creditsSpent: 0.5 } },
      { data: { outcome: "blocked", email: "c@test.com", creditsSpent: 0.3, error: "proxy timeout" } },
      { data: { outcome: "noaccount", email: "d@test.com", creditsSpent: 0.1 } },
    ];

    const summary = generateRunSummary(events);

    expect(summary.total).toBe(4);
    expect(summary.successCount).toBe(2);
    expect(summary.uniqueCredentials).toBe(4);
    expect(summary.successRate).toBe(50);
    expect(summary.totalCredits).toBeCloseTo(1.4, 1);
    expect(summary.markdown).toContain("# Hermes Run Summary");
    expect(summary.markdown).toContain("50.0%");
    expect(summary.recommendedActions.length).toBeGreaterThan(0);
  });

  it("handles empty events list", () => {
    const summary = generateRunSummary([]);
    expect(summary.total).toBe(0);
    expect(summary.successRate).toBe(0);
    expect(summary.markdown).toContain("# Hermes Run Summary");
  });

  it("generates recommended actions for low success rate", () => {
    const events = [
      { data: { outcome: "blocked" } },
      { data: { outcome: "blocked" } },
      { data: { outcome: "error" } },
    ];
    const summary = generateRunSummary(events);
    expect(summary.recommendedActions.some(a => a.includes("50%"))).toBe(true);
  });
});

// === Learning DB ===
import {
  recordHealing,
  getEffectiveFixes,
  getIneffectiveFixes,
  getAllRecords,
  getStats,
} from "../../src/hermes/learning-db.js";

describe("LearningDB", () => {
  // These tests use the real SQLite DB at hermes/hermes-learning.db
  // We insert with unique symptoms to avoid contaminating other tests

  const uniqueSymptom = `test_symptom_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  it("records a healing action and retrieves it", () => {
    const id = recordHealing({
      symptom: uniqueSymptom,
      fix: "Updated selector to #new-btn",
      file: "engine.ts",
      successRateBefore: 30,
      successRateAfter: 85,
    });
    expect(id).toBeGreaterThan(0);

    const effective = getEffectiveFixes(uniqueSymptom);
    expect(effective.length).toBeGreaterThanOrEqual(1);
    expect(effective[0]!.fix_applied).toBe("Updated selector to #new-btn");
    expect(effective[0]!.effective).toBe(true);
  });

  it("records an ineffective fix", () => {
    const symptom2 = `${uniqueSymptom}_bad`;
    recordHealing({
      symptom: symptom2,
      fix: "Random timing change",
      file: "engine.ts",
      successRateBefore: 50,
      successRateAfter: 20,
      effective: false,
    });
    const ineffective = getIneffectiveFixes(symptom2);
    expect(ineffective.length).toBeGreaterThanOrEqual(1);
    expect(ineffective[0]!.effective).toBe(false);
  });

  it("getAllRecords returns records", () => {
    const records = getAllRecords(5);
    expect(Array.isArray(records)).toBe(true);
  });

  it("getStats returns summary", () => {
    const stats = getStats();
    expect(stats.total).toBeGreaterThanOrEqual(0);
    expect(typeof stats.effective).toBe("number");
    expect(typeof stats.ineffective).toBe("number");
  });
});
