import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  DetectionFeedbackLoop,
  DETECTION_VECTORS,
  _resetFeedbackLoop,
  getFeedbackLoop,
} from "../../src/stealth/detection-feedback.js";

const TEST_DB = path.join(import.meta.dirname ?? ".", "__test_detection_blacklist.json");

function cleanup() {
  try { fs.unlinkSync(TEST_DB); } catch { /* ignore */ }
  _resetFeedbackLoop();
}

describe("DetectionFeedbackLoop", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it("starts with empty blacklist", () => {
    const loop = new DetectionFeedbackLoop({ dbPath: TEST_DB });
    expect(loop.size).toBe(0);
  });

  it("records a detection and blacklists the vector", () => {
    const loop = new DetectionFeedbackLoop({ dbPath: TEST_DB });
    loop.recordDetection({
      vector: DETECTION_VECTORS.WEBDRIVER_DETECTED,
      reason: "navigator.webdriver was true",
    });
    expect(loop.isBlacklisted(DETECTION_VECTORS.WEBDRIVER_DETECTED)).toBe(true);
    expect(loop.size).toBe(1);
  });

  it("increments hitCount on repeat detection", () => {
    const loop = new DetectionFeedbackLoop({ dbPath: TEST_DB });
    loop.recordDetection({ vector: "test_vec", reason: "r1" });
    loop.recordDetection({ vector: "test_vec", reason: "r2" });
    const entries = loop.snapshot();
    expect(entries[0]!.hitCount).toBe(2);
  });

  it("respects target-specific blacklisting", () => {
    const loop = new DetectionFeedbackLoop({ dbPath: TEST_DB });
    loop.recordDetection({
      vector: DETECTION_VECTORS.RECAPTCHA_HIGH_RISK,
      reason: "score < 0.3",
      target: "ignitioncasino.ooo",
    });

    expect(loop.isBlacklisted(DETECTION_VECTORS.RECAPTCHA_HIGH_RISK, "ignitioncasino.ooo")).toBe(true);
    // Different target should NOT match
    expect(loop.isBlacklisted(DETECTION_VECTORS.RECAPTCHA_HIGH_RISK, "other.com")).toBe(false);
  });

  it("getVectorsToAvoid returns set of blacklisted vector names", () => {
    const loop = new DetectionFeedbackLoop({ dbPath: TEST_DB });
    loop.recordDetection({ vector: "vec_a", reason: "r" });
    loop.recordDetection({ vector: "vec_b", reason: "r" });
    const avoid = loop.getVectorsToAvoid();
    expect(avoid.has("vec_a")).toBe(true);
    expect(avoid.has("vec_b")).toBe(true);
    expect(avoid.has("vec_c")).toBe(false);
  });

  it("clearVector removes a specific vector", () => {
    const loop = new DetectionFeedbackLoop({ dbPath: TEST_DB });
    loop.recordDetection({ vector: "v1", reason: "r" });
    loop.recordDetection({ vector: "v2", reason: "r" });
    loop.clearVector("v1");
    expect(loop.isBlacklisted("v1")).toBe(false);
    expect(loop.isBlacklisted("v2")).toBe(true);
  });

  it("clearAll removes all entries", () => {
    const loop = new DetectionFeedbackLoop({ dbPath: TEST_DB });
    loop.recordDetection({ vector: "v1", reason: "r" });
    loop.recordDetection({ vector: "v2", reason: "r" });
    loop.clearAll();
    expect(loop.size).toBe(0);
  });

  it("entries expire after TTL", () => {
    const loop = new DetectionFeedbackLoop({ dbPath: TEST_DB, ttlHours: 24 });
    // Record with timestamp far in the past (expired)
    loop.recordDetection({
      vector: "old_vec",
      reason: "old",
      timestamp: Date.now() - 25 * 60 * 60 * 1000, // 25 hours ago
    });
    expect(loop.isBlacklisted("old_vec")).toBe(false);
  });

  it("persists to disk and reloads", () => {
    const loop1 = new DetectionFeedbackLoop({ dbPath: TEST_DB });
    loop1.recordDetection({ vector: "persist_vec", reason: "test" });
    loop1.flush(); // Force immediate persist (bypasses debounce)

    const loop2 = new DetectionFeedbackLoop({ dbPath: TEST_DB });
    expect(loop2.isBlacklisted("persist_vec")).toBe(true);
  });

  it("singleton factory works", () => {
    _resetFeedbackLoop();
    const a = getFeedbackLoop({ dbPath: TEST_DB });
    const b = getFeedbackLoop();
    expect(a).toBe(b);
  });

  it("DETECTION_VECTORS contains expected keys", () => {
    expect(DETECTION_VECTORS.WEBDRIVER_DETECTED).toBe("webdriver_detected");
    expect(DETECTION_VECTORS.RECAPTCHA_HIGH_RISK).toBe("recaptcha_high_risk");
    expect(DETECTION_VECTORS.CANVAS_NOISE_DETECTED).toBe("canvas_noise_detected");
  });
});
