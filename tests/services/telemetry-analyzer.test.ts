import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { initDB, db } from "../../src/core/database.js";
import { generateDeepAnalysis } from "../../src/services/telemetry-analyzer.js";

describe("Telemetry Analyzer", () => {
  beforeEach(() => {
    initDB();
    try {
      db.prepare("DELETE FROM test_runs").run();
    } catch {}
  });

  afterEach(() => {
    try {
      db.prepare("DELETE FROM test_runs").run();
    } catch {}
  });

  it("should generate deep analysis report grouped by backend", () => {
    const insert = db.prepare(`
      INSERT INTO test_runs (credential_id, target_site, outcome, error, duration_ms, backend, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    insert.run(1, "joe", "success", null, 1200, "stealth", new Date().toISOString());
    insert.run(2, "joe", "blocked", "403 WAF Block", 800, "stealth", new Date().toISOString());
    insert.run(3, "ignition", "2FA", null, 1500, "zendriver", new Date().toISOString());

    const report = generateDeepAnalysis();
    expect(report.overall.totalRuns).toBe(3);
    expect(report.overall.successCount).toBe(2);
    expect(report.overall.wafBlockCount).toBe(1);

    expect(report.byBackend["stealth"]?.totalRuns).toBe(2);
    expect(report.byBackend["stealth"]?.successCount).toBe(1);
    expect(report.byBackend["stealth"]?.wafBlockCount).toBe(1);

    expect(report.byBackend["zendriver"]?.totalRuns).toBe(1);
    expect(report.byBackend["zendriver"]?.successCount).toBe(1);
  });
});
