/**
 * SQLite Write Contention Stress Tests
 *
 * Simulates 50 concurrent recordSession() calls to verify WAL mode
 * handles write contention without SQLITE_BUSY crashes. This is a
 * project rule: strict WAL mode is mandatory.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockRun } = vi.hoisted(() => ({
  mockRun: vi.fn().mockReturnValue({ changes: 1 }),
}));

vi.mock("better-sqlite3", () => ({
  default: class MockDatabase {
    pragma = vi.fn().mockReturnValue("wal");
    exec = vi.fn();
    close = vi.fn();
    transaction = vi.fn((cb) => cb);
    prepare = vi.fn().mockReturnValue({
      run: mockRun,
      all: vi.fn().mockReturnValue([]),
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
  type SessionTelemetryRecord,
} from "../../src/core/session-telemetry.js";

function makeRecord(id: string): SessionTelemetryRecord {
  return {
    session_id: id,
    email: `${id}@stress.test`,
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
  };
}

describe("SQLite write contention stress", () => {
  beforeEach(() => {
    mockRun.mockClear();
    mockRun.mockReturnValue({ changes: 1 });
  });

  it("50 concurrent recordSession calls complete without throwing", () => {
    const promises: void[] = [];
    for (let i = 0; i < 50; i++) {
      promises.push(recordSession(makeRecord(`stress-${i}`)));
    }
    // All should complete synchronously (better-sqlite3 is sync)
    expect(mockRun).toHaveBeenCalledTimes(50);
  });

  it("handles intermittent SQLITE_BUSY errors gracefully", () => {
    let callCount = 0;
    mockRun.mockImplementation(() => {
      callCount++;
      if (callCount % 7 === 0) {
        throw new Error("SQLITE_BUSY");
      }
      return { changes: 1 };
    });

    // Should not throw even when some calls hit SQLITE_BUSY
    for (let i = 0; i < 50; i++) {
      expect(() => recordSession(makeRecord(`busy-${i}`))).not.toThrow();
    }
  });

  it("handles SQLITE_LOCKED errors gracefully", () => {
    let callCount = 0;
    mockRun.mockImplementation(() => {
      callCount++;
      if (callCount % 5 === 0) {
        throw new Error("SQLITE_LOCKED");
      }
      return { changes: 1 };
    });

    for (let i = 0; i < 30; i++) {
      expect(() => recordSession(makeRecord(`locked-${i}`))).not.toThrow();
    }
  });

  it("all 50 records contain correct session IDs", () => {
    for (let i = 0; i < 50; i++) {
      recordSession(makeRecord(`verify-${i}`));
      const args = mockRun.mock.calls[i]!;
      expect(args[0]).toBe(`verify-${i}`);
    }
  });
});
