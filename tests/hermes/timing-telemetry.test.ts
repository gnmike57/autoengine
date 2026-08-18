import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  TimingRecorder,
  readAllRecords,
  computePhaseStats,
  readRecentRecords,
  type TimingRecord
} from "../../src/hermes/timing-telemetry.js";

describe("Timing Telemetry", () => {
  const telemetryFile = path.join(process.cwd(), "data", "timing-telemetry.jsonl");
  let originalData: string | null = null;

  beforeEach(() => {
    if (fs.existsSync(telemetryFile)) {
      originalData = fs.readFileSync(telemetryFile, "utf-8");
      fs.unlinkSync(telemetryFile);
    }
  });

  afterEach(() => {
    if (originalData !== null) {
      fs.writeFileSync(telemetryFile, originalData, "utf-8");
    } else if (fs.existsSync(telemetryFile)) {
      fs.unlinkSync(telemetryFile);
    }
  });

  it("should record phases and finalize timing record", async () => {
    const recorder = new TimingRecorder("test-sess-1", "user@test.com", "joe", "stealth", 0);

    recorder.markPhaseStart("cookieDismiss");
    await new Promise((r) => setTimeout(r, 10));
    const dur = recorder.markPhaseEnd("cookieDismiss");
    expect(dur).toBeGreaterThanOrEqual(5);

    recorder.setAttemptIdx(1);
    const rec = recorder.finalize("NO_ACCOUNT_CONFIRMED", false);

    expect(rec.sessionId).toBe("test-sess-1");
    expect(rec.attemptIdx).toBe(1);
    expect(rec.phases.cookieDismissMs).toBeGreaterThanOrEqual(5);
    expect(rec.phases.totalE2EMs).toBeDefined();

    const all = readAllRecords();
    expect(all.length).toBe(1);
    expect(all[0]?.sessionId).toBe("test-sess-1");
  });

  it("should compute phase statistics correctly", () => {
    const records: TimingRecord[] = [
      {
        sessionId: "s1",
        email: "e1",
        site: "joe",
        backend: "stealth",
        attemptIdx: 0,
        timestamp: new Date().toISOString(),
        phases: { submitMs: 100 },
        verdict: "SUCCESS",
        success: true
      },
      {
        sessionId: "s2",
        email: "e2",
        site: "joe",
        backend: "stealth",
        attemptIdx: 0,
        timestamp: new Date().toISOString(),
        phases: { submitMs: 200 },
        verdict: "SUCCESS",
        success: true
      },
      {
        sessionId: "s3",
        email: "e3",
        site: "joe",
        backend: "stealth",
        attemptIdx: 0,
        timestamp: new Date().toISOString(),
        phases: { submitMs: 300 },
        verdict: "SUCCESS",
        success: true
      }
    ];

    const stats = computePhaseStats(records, "submitMs");
    expect(stats).not.toBeNull();
    expect(stats?.count).toBe(3);
    expect(stats?.min).toBe(100);
    expect(stats?.max).toBe(300);
    expect(stats?.mean).toBe(200);
    expect(stats?.p50).toBe(200);
  });

  it("should filter recent records by hour threshold", () => {
    const oldTimestamp = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const recentTimestamp = new Date().toISOString();

    const oldRecord = JSON.stringify({
      sessionId: "old",
      email: "o",
      site: "j",
      backend: "b",
      attemptIdx: 0,
      timestamp: oldTimestamp,
      phases: {},
      verdict: "V",
      success: true
    });

    const newRecord = JSON.stringify({
      sessionId: "new",
      email: "n",
      site: "j",
      backend: "b",
      attemptIdx: 0,
      timestamp: recentTimestamp,
      phases: {},
      verdict: "V",
      success: true
    });

    fs.mkdirSync(path.dirname(telemetryFile), { recursive: true });
    fs.writeFileSync(telemetryFile, `${oldRecord}\n${newRecord}\n`);

    const recent = readRecentRecords(24);
    expect(recent.length).toBe(1);
    expect(recent[0]?.sessionId).toBe("new");
  });
});
