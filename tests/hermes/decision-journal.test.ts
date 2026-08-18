import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  logDecision,
  getRecentDecisions,
  getDecisionsByType,
  getDecisionsInRange,
  getJournalStats,
  closeJournalDb,
  type LogDecisionOpts
} from "../../src/hermes/decision-journal.js";

describe("Hermes Decision Journal", () => {
  const testDir = path.join(process.cwd(), "hermes");
  const testDb = path.join(testDir, "hermes-learning.db");

  function cleanDb() {
    closeJournalDb();
    if (fs.existsSync(testDb)) {
      try {
        fs.unlinkSync(testDb);
      } catch {}
    }
  }

  beforeEach(() => {
    cleanDb();
  });

  afterEach(() => {
    cleanDb();
  });

  it("should record and retrieve decisions", () => {
    const opts: LogDecisionOpts = {
      type: "backend_swap",
      decision: "Switched from stealth to zendriver",
      rationale: "High CAPTCHA rate detected on stealth backend",
      preMetrics: { captchaRate: 0.8 },
      postMetrics: { captchaRate: 0.1 },
      auto: true
    };

    const id = logDecision(opts);
    expect(id).toBeGreaterThan(0);

    const recent = getRecentDecisions(10);
    expect(recent.length).toBeGreaterThanOrEqual(1);
    expect(recent[0]?.type).toBe("backend_swap");
    expect(recent[0]?.decision).toContain("Switched from stealth");
    expect(recent[0]?.preMetrics).toEqual({ captchaRate: 0.8 });
  });

  it("should query decisions by type", () => {
    logDecision({
      type: "concurrency_change",
      decision: "Scale concurrency to 2",
      rationale: "Rate limit avoidance"
    });

    logDecision({
      type: "backend_swap",
      decision: "Swap backend",
      rationale: "Testing"
    });

    const concurrencyDecisions = getDecisionsByType("concurrency_change");
    expect(concurrencyDecisions.length).toBe(1);
    expect(concurrencyDecisions[0]?.type).toBe("concurrency_change");
  });

  it("should query decisions by ISO range", () => {
    const now = new Date();
    const startIso = new Date(now.getTime() - 60000).toISOString();
    const endIso = new Date(now.getTime() + 60000).toISOString();

    logDecision({
      type: "timing_adjustment",
      decision: "Reduce delay to 100ms",
      rationale: "P95 was fast"
    });

    const inRange = getDecisionsInRange(startIso, endIso);
    expect(inRange.length).toBe(1);
  });

  it("should calculate summary statistics", () => {
    logDecision({ type: "proxy_rotation", decision: "Rotated proxy", rationale: "403 block" });
    logDecision({ type: "proxy_rotation", decision: "Rotated proxy 2", rationale: "403 block" });
    logDecision({ type: "batch_restart", decision: "Restarted batch", rationale: "Stall" });

    const stats = getJournalStats();
    expect(stats.total).toBe(3);
    expect(stats.last24h).toBe(3);
    expect(stats.byType.find(t => t.type === "proxy_rotation")?.count).toBe(2);
    expect(stats.byType.find(t => t.type === "batch_restart")?.count).toBe(1);
  });
});
