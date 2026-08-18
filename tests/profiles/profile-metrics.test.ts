import { describe, it, expect, beforeEach } from "vitest";
import { profileMetrics } from "../../src/profiles/profile-metrics.js";

describe("profileMetrics", () => {
  beforeEach(() => {
    profileMetrics.reset();
  });

  it("starts at zero across all counters", () => {
    const s = profileMetrics.snapshot();
    expect(s.reuseAllowed).toBe(0);
    expect(s.reuseDenied).toBe(0);
    expect(s.reuseDeniedReasons).toEqual({});
    expect(s.cleanCreated).toBe(0);
    expect(s.sanitizedOk).toBe(0);
    expect(s.sanitizedWithErrors).toBe(0);
    expect(s.quarantined).toBe(0);
    expect(s.validationFailed).toBe(0);
    expect(s.cacheSeeded).toBe(0);
    expect(s.cacheSanitized).toBe(0);
  });

  it("increments simple counters", () => {
    profileMetrics.recordReuseAllowed();
    profileMetrics.recordReuseAllowed();
    profileMetrics.recordCleanCreated();
    profileMetrics.recordQuarantined();
    profileMetrics.recordValidationFailed();
    profileMetrics.recordCacheSeeded();
    profileMetrics.recordCacheSanitized();

    const s = profileMetrics.snapshot();
    expect(s.reuseAllowed).toBe(2);
    expect(s.cleanCreated).toBe(1);
    expect(s.quarantined).toBe(1);
    expect(s.validationFailed).toBe(1);
    expect(s.cacheSeeded).toBe(1);
    expect(s.cacheSanitized).toBe(1);
  });

  it("aggregates reuse-denied reasons across calls", () => {
    profileMetrics.recordReuseDenied(["proxyKey", "cacheInjection"]);
    profileMetrics.recordReuseDenied(["proxyKey"]);
    profileMetrics.recordReuseDenied(["sanitize-failed"]);

    const s = profileMetrics.snapshot();
    expect(s.reuseDenied).toBe(3);
    expect(s.reuseDeniedReasons).toEqual({
      proxyKey: 2,
      cacheInjection: 1,
      "sanitize-failed": 1,
    });
  });

  it("handles an empty reasons array on recordReuseDenied", () => {
    profileMetrics.recordReuseDenied([]);
    const s = profileMetrics.snapshot();
    expect(s.reuseDenied).toBe(1);
    expect(s.reuseDeniedReasons).toEqual({});
  });

  it("routes sanitized counts by errorCount", () => {
    profileMetrics.recordSanitized(0);
    profileMetrics.recordSanitized(0);
    profileMetrics.recordSanitized(3);
    const s = profileMetrics.snapshot();
    expect(s.sanitizedOk).toBe(2);
    expect(s.sanitizedWithErrors).toBe(1);
  });

  it("snapshot returns a defensive copy of reuseDeniedReasons", () => {
    profileMetrics.recordReuseDenied(["x"]);
    const s = profileMetrics.snapshot();
    s.reuseDeniedReasons["x"] = 999;
    s.reuseDeniedReasons["y"] = 5;
    const fresh = profileMetrics.snapshot();
    expect(fresh.reuseDeniedReasons).toEqual({ x: 1 });
  });

  it("reset() clears all counters and the reasons map", () => {
    profileMetrics.recordReuseAllowed();
    profileMetrics.recordReuseDenied(["proxyKey"]);
    profileMetrics.recordSanitized(2);
    profileMetrics.recordCacheSeeded();

    profileMetrics.reset();
    const s = profileMetrics.snapshot();
    expect(s.reuseAllowed).toBe(0);
    expect(s.reuseDenied).toBe(0);
    expect(s.reuseDeniedReasons).toEqual({});
    expect(s.sanitizedWithErrors).toBe(0);
    expect(s.cacheSeeded).toBe(0);
  });
});
