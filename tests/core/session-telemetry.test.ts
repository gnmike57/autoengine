import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { initDB, db } from "../../src/core/database.js";
import {
  recordSession,
  findCounterfactual,
  getTimingCorrelation,
  getRecentTelemetry,
  getTelemetryByOutcome,
  getCurrentBlockRate,
  type SessionTelemetryRecord
} from "../../src/core/session-telemetry.js";

describe("Session Telemetry Engine", () => {
  beforeEach(() => {
    initDB();
    try {
      db.prepare("DELETE FROM session_telemetry").run();
    } catch {}
  });

  afterEach(() => {
    try {
      db.prepare("DELETE FROM session_telemetry").run();
    } catch {}
  });

  it("should record and retrieve session telemetry", () => {
    const record: SessionTelemetryRecord = {
      session_id: "sess-1",
      email: "test@example.com",
      target_site: "joe",
      backend: "stealth",
      proxy_key: "proxy-abc",
      proxy_region: "AU",
      fingerprint_seed: 12345,
      ua_hash: "ua-hash-1",
      timing_vector: {
        pre_fill_ms: 100,
        keystroke_cadence_ms: 50,
        post_submit_wait_ms: 200,
        cookie_dismiss_ms: 150,
        total_flow_ms: 1200
      },
      network_metrics: {
        ttfb_ms: 80,
        resource_count: 25,
        response_size_bytes: 50000,
        challenge_headers_detected: false,
        status_code: 200
      },
      dom_metrics: {
        transition_count: 2,
        classification_latency_ms: 120,
        mutation_events: 15,
        classifier_source: "dom_classifier"
      },
      hermes_interventions: 0,
      outcome: "success",
      block_rate_at_time: 0.05,
      attempt_index: 0
    };

    recordSession(record);

    const recent = getRecentTelemetry("joe", 10);
    expect(recent.length).toBe(1);
    expect(recent[0]?.session_id).toBe("sess-1");
    expect(recent[0]?.outcome).toBe("success");

    const successes = getTelemetryByOutcome("joe", "success");
    expect(successes.length).toBe(1);

    const blockRate = getCurrentBlockRate("joe", 10);
    expect(blockRate).toBe(0);
  });

  it("should find counterfactual comparison between failure and nearest success", () => {
    // Record a success session
    recordSession({
      session_id: "succ-1",
      email: "good@example.com",
      target_site: "joe",
      backend: "stealth",
      proxy_key: "proxy-fast",
      proxy_region: "AU",
      fingerprint_seed: 100,
      ua_hash: "ua-1",
      timing_vector: { pre_fill_ms: 100, keystroke_cadence_ms: 50, post_submit_wait_ms: 200, cookie_dismiss_ms: 100, total_flow_ms: 1000 },
      network_metrics: { ttfb_ms: 50, resource_count: 20, response_size_bytes: 40000, challenge_headers_detected: false, status_code: 200 },
      dom_metrics: { transition_count: 2, classification_latency_ms: 100, mutation_events: 10, classifier_source: "dom_classifier" },
      hermes_interventions: 0,
      outcome: "success",
      block_rate_at_time: 0.0,
      attempt_index: 0
    });

    // Record a failed session
    const failedRecord: SessionTelemetryRecord = {
      session_id: "fail-1",
      email: "bad@example.com",
      target_site: "joe",
      backend: "stealth",
      proxy_key: "proxy-slow",
      proxy_region: "US", // Divergent region
      fingerprint_seed: 200,
      ua_hash: "ua-2",
      timing_vector: { pre_fill_ms: 800, keystroke_cadence_ms: 500, post_submit_wait_ms: 2000, cookie_dismiss_ms: 1000, total_flow_ms: 6000 },
      network_metrics: { ttfb_ms: 900, resource_count: 20, response_size_bytes: 40000, challenge_headers_detected: true, status_code: 403 },
      dom_metrics: { transition_count: 1, classification_latency_ms: 500, mutation_events: 2, classifier_source: "timeout" },
      hermes_interventions: 1,
      outcome: "blocked",
      block_rate_at_time: 0.5,
      attempt_index: 0
    };
    recordSession(failedRecord);

    const cf = findCounterfactual(failedRecord);
    expect(cf).not.toBeNull();
    expect(cf?.nearest_success.session_id).toBe("succ-1");
    expect(cf?.diverging_variable).toBeDefined();
  });

  it("should compute timing correlation", () => {
    const correlation = getTimingCorrelation("joe", "pre_fill_ms");
    expect(correlation).toBeDefined();
    if (correlation) {
      expect(correlation.dimension).toBe("pre_fill_ms");
    }
  });
});
