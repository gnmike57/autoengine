/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unused-vars */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockRun, mockAll } = vi.hoisted(() => ({
  mockRun: vi.fn().mockReturnValue({ changes: 1 }),
  mockAll: vi.fn().mockReturnValue([]),
}));

vi.mock("better-sqlite3", () => ({
  default: class MockDatabase {
    pragma = vi.fn();
    exec = vi.fn();
    close = vi.fn();
    transaction = vi.fn((cb) => cb);
    prepare = vi.fn().mockReturnValue({
      run: mockRun,
      all: mockAll,
      get: vi.fn(),
    });
  },
}));

vi.mock("chokidar", () => ({
  default: {
    watch: vi.fn().mockReturnValue({
      on: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
    }),
  },
}));

import {
  recordSession,
  getRecentTelemetry,
  getCurrentBlockRate,
  getTimingCorrelation,
  type SessionTelemetryRecord,
  type TimingVector,
  type NetworkMetrics,
  type DomMetrics,
} from "../../src/core/session-telemetry.js";

function makeTelemetryRecord(overrides: Partial<SessionTelemetryRecord> = {}): SessionTelemetryRecord {
  return {
    session_id: "test-session-001",
    email: "test@example.com",
    target_site: "joe",
    backend: "stealth",
    proxy_key: "proxy-1",
    proxy_region: "US",
    fingerprint_seed: 42,
    ua_hash: "abc123",
    timing_vector: {
      pre_fill_ms: 500,
      keystroke_cadence_ms: 80,
      post_submit_wait_ms: 1200,
      cookie_dismiss_ms: 300,
      total_flow_ms: 4000,
    },
    network_metrics: {
      ttfb_ms: 250,
      resource_count: 45,
      response_size_bytes: 50000,
      challenge_headers_detected: false,
      status_code: 200,
    },
    dom_metrics: {
      transition_count: 3,
      classification_latency_ms: 150,
      mutation_events: 12,
      classifier_source: "dom_classifier",
    },
    hermes_interventions: 0,
    outcome: "success",
    block_rate_at_time: 0.05,
    attempt_index: 1,
    ...overrides,
  };
}

describe("session-telemetry", () => {
  beforeEach(() => {
    mockRun.mockClear();
    mockAll.mockClear();
  });

  describe("recordSession", () => {
    it("calls the insert statement with all 15 parameters", () => {
      const record = makeTelemetryRecord();
      recordSession(record);

      expect(mockRun).toHaveBeenCalledTimes(1);
      const args = mockRun.mock.calls[0]!;
      expect(args).toHaveLength(15);
      expect(args[0]).toBe("test-session-001");
      expect(args[1]).toBe("test@example.com");
      expect(args[2]).toBe("joe");
      expect(args[3]).toBe("stealth");
    });

    it("serializes timing_vector, network_metrics, dom_metrics as JSON strings", () => {
      const record = makeTelemetryRecord();
      recordSession(record);

      const args = mockRun.mock.calls[0]!;
      // timing_vector is arg 8, network_metrics is arg 9, dom_metrics is arg 10
      expect(() => JSON.parse(args[8])).not.toThrow();
      expect(() => JSON.parse(args[9])).not.toThrow();
      expect(() => JSON.parse(args[10])).not.toThrow();
    });

    it("handles null fingerprint_seed without crashing", () => {
      const record = makeTelemetryRecord({ fingerprint_seed: null });
      expect(() => recordSession(record)).not.toThrow();
      const args = mockRun.mock.calls[0]!;
      expect(args[6]).toBeNull();
    });

    it("defaults missing optional fields to safe values", () => {
      const record = makeTelemetryRecord({
        proxy_key: "",
        proxy_region: "",
        ua_hash: "",
        hermes_interventions: 0,
        block_rate_at_time: 0,
        attempt_index: 0,
      });
      expect(() => recordSession(record)).not.toThrow();
    });

    it("swallows database errors and does not throw", () => {
      mockRun.mockImplementationOnce(() => {
        throw new Error("SQLITE_BUSY");
      });
      expect(() => recordSession(makeTelemetryRecord())).not.toThrow();
    });
  });

  describe("getRecentTelemetry", () => {
    it("returns empty array when no rows exist", () => {
      mockAll.mockReturnValueOnce([]);
      const result = getRecentTelemetry("joe", 50);
      expect(result).toEqual([]);
    });

    it("deserializes JSON columns from rows", () => {
      mockAll.mockReturnValueOnce([
        {
          session_id: "s1",
          email: "a@b.com",
          target_site: "joe",
          backend: "stealth",
          proxy_key: "p1",
          proxy_region: "US",
          fingerprint_seed: 42,
          ua_hash: "h1",
          timing_vector: JSON.stringify({ pre_fill_ms: 100, keystroke_cadence_ms: 80, post_submit_wait_ms: 1000, cookie_dismiss_ms: 200, total_flow_ms: 3000 }),
          network_metrics: JSON.stringify({ ttfb_ms: 200, resource_count: 30, response_size_bytes: 40000, challenge_headers_detected: false, status_code: 200 }),
          dom_metrics: JSON.stringify({ transition_count: 2, classification_latency_ms: 100, mutation_events: 8, classifier_source: "dom_classifier" }),
          hermes_interventions: 0,
          outcome: "success",
          block_rate_at_time: 0.02,
          attempt_index: 1,
          timestamp: "2026-06-28T12:00:00Z",
        },
      ]);

      const result = getRecentTelemetry("joe", 50);
      expect(result).toHaveLength(1);
      expect(result[0]!.session_id).toBe("s1");
      expect(result[0]!.timing_vector.pre_fill_ms).toBe(100);
      expect(result[0]!.network_metrics.ttfb_ms).toBe(200);
    });

    it("swallows errors and returns empty array", () => {
      mockAll.mockImplementationOnce(() => {
        throw new Error("DB locked");
      });
      const result = getRecentTelemetry("joe");
      expect(result).toEqual([]);
    });
  });

  describe("getCurrentBlockRate", () => {
    it("returns 0 when no rows", () => {
      mockAll.mockReturnValueOnce([]);
      expect(getCurrentBlockRate("joe")).toBe(0);
    });

    it("correctly computes block rate", () => {
      mockAll.mockReturnValueOnce([
        { outcome: "blocked" },
        { outcome: "success" },
        { outcome: "honeypot" },
        { outcome: "success" },
        { outcome: "N/A" },
      ]);
      // 3 blocked outcomes out of 5 = 0.6
      expect(getCurrentBlockRate("joe", 10)).toBe(0.6);
    });

    it("treats non-block outcomes as zero block rate", () => {
      mockAll.mockReturnValueOnce([
        { outcome: "success" },
        { outcome: "2FA" },
        { outcome: "incorrect" },
      ]);
      expect(getCurrentBlockRate("joe", 10)).toBe(0);
    });
  });

  describe("getTimingCorrelation", () => {
    it("returns null when fewer than 10 rows", () => {
      mockAll.mockReturnValueOnce(
        Array.from({ length: 5 }, (_, i) => ({
          outcome: "success",
          timing_vector: JSON.stringify({ pre_fill_ms: 500 + i * 10, keystroke_cadence_ms: 80, post_submit_wait_ms: 1000, cookie_dismiss_ms: 200, total_flow_ms: 3000 }),
        }))
      );
      expect(getTimingCorrelation("joe", "pre_fill_ms")).toBeNull();
    });

    it("returns correlation result with sufficient data", () => {
      const rows = Array.from({ length: 20 }, (_, i) => ({
        outcome: i % 3 === 0 ? "blocked" : "success",
        timing_vector: JSON.stringify({
          pre_fill_ms: 300 + i * 50,
          keystroke_cadence_ms: 80,
          post_submit_wait_ms: 1000,
          cookie_dismiss_ms: 200,
          total_flow_ms: 3000,
        }),
      }));
      mockAll.mockReturnValueOnce(rows);

      const result = getTimingCorrelation("joe", "pre_fill_ms");
      expect(result).not.toBeNull();
      expect(result!.dimension).toBe("pre_fill_ms");
      expect(result!.sample_size).toBeGreaterThanOrEqual(10);
      expect(typeof result!.correlation_coefficient).toBe("number");
      expect(result!.optimal_range.min).toBeLessThanOrEqual(result!.optimal_range.max);
    });
  });
});
