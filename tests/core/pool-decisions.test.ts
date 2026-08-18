import { describe, it, expect, beforeEach } from "vitest";
import { evaluateReuse, QuarantineSet } from "../../src/core/pool-decisions.js";
import { profileMetrics } from "../../src/profiles/profile-metrics.js";

const compat = (key: string) => ({ enabled: true, profileKey: key });

describe("evaluateReuse", () => {
  it("allows reuse when proxy, cache and quarantine all match", () => {
    const res = evaluateReuse({
      existingProxyKey: "p1",
      requestedProxyKey: "p1",
      existingCacheInjectionState: compat("c1"),
      requestedCacheInjectionState: compat("c1"),
    });
    expect(res).toEqual({ allowed: true, reasons: [] });
  });

  it("denies and lists reasons in canonical order: quarantined → proxyKey → cacheInjection → recordVideo", () => {
    const res = evaluateReuse({
      existingProxyKey: "old",
      requestedProxyKey: "new",
      existingCacheInjectionState: compat("a"),
      requestedCacheInjectionState: compat("b"),
      quarantined: true,
      recordVideoMismatch: true,
    });
    expect(res.allowed).toBe(false);
    expect(res.reasons).toEqual(["quarantined", "proxyKey", "cacheInjection", "recordVideo"]);
  });

  it("flags proxyKey on mismatch only", () => {
    const res = evaluateReuse({
      existingProxyKey: "p1",
      requestedProxyKey: "p2",
      existingCacheInjectionState: compat("c"),
      requestedCacheInjectionState: compat("c"),
    });
    expect(res.allowed).toBe(false);
    expect(res.reasons).toEqual(["proxyKey"]);
  });

  it("treats undefined↔undefined proxy keys as a match", () => {
    const res = evaluateReuse({
      existingProxyKey: undefined,
      requestedProxyKey: undefined,
      existingCacheInjectionState: compat("c"),
      requestedCacheInjectionState: compat("c"),
    });
    expect(res.allowed).toBe(true);
  });

  it("flags cacheInjection when existing state is missing entirely", () => {
    const res = evaluateReuse({
      existingProxyKey: "p",
      requestedProxyKey: "p",
      existingCacheInjectionState: undefined,
      requestedCacheInjectionState: compat("c"),
    });
    expect(res.allowed).toBe(false);
    expect(res.reasons).toEqual(["cacheInjection"]);
  });

  it("flags cacheInjection when profileKey differs", () => {
    const res = evaluateReuse({
      existingProxyKey: "p",
      requestedProxyKey: "p",
      existingCacheInjectionState: compat("c1"),
      requestedCacheInjectionState: compat("c2"),
    });
    expect(res.reasons).toEqual(["cacheInjection"]);
  });

  it("flags cacheInjection when enabled flag differs", () => {
    const res = evaluateReuse({
      existingProxyKey: "p",
      requestedProxyKey: "p",
      existingCacheInjectionState: { enabled: false },
      requestedCacheInjectionState: { enabled: true, profileKey: "c" },
    });
    expect(res.reasons).toEqual(["cacheInjection"]);
  });

  it("ignores recordVideoMismatch by default (omitted == false)", () => {
    const res = evaluateReuse({
      existingProxyKey: "p",
      requestedProxyKey: "p",
      existingCacheInjectionState: compat("c"),
      requestedCacheInjectionState: compat("c"),
    });
    expect(res.reasons).toEqual([]);
  });
});

describe("QuarantineSet", () => {
  beforeEach(() => profileMetrics.reset());

  it("starts empty", () => {
    const q = new QuarantineSet<string>();
    expect(q.size()).toBe(0);
    expect(q.has("k")).toBe(false);
  });

  it("add() inserts and records a single quarantine metric", () => {
    const q = new QuarantineSet<string>();
    expect(q.add("k1")).toBe(true);
    expect(q.has("k1")).toBe(true);
    expect(profileMetrics.snapshot().quarantined).toBe(1);
  });

  it("add() is idempotent for the metric counter", () => {
    const q = new QuarantineSet<string>();
    q.add("k");
    expect(q.add("k")).toBe(false);
    expect(q.add("k")).toBe(false);
    expect(profileMetrics.snapshot().quarantined).toBe(1);
  });

  it("clear() removes the key and is idempotent", () => {
    const q = new QuarantineSet<string>();
    q.add("k");
    q.clear("k");
    expect(q.has("k")).toBe(false);
    q.clear("k"); // no throw
    q.clear("never-added"); // no throw
  });

  it("re-adding after clear() records a new quarantine metric", () => {
    const q = new QuarantineSet<string>();
    q.add("k");
    q.clear("k");
    expect(q.add("k")).toBe(true);
    expect(profileMetrics.snapshot().quarantined).toBe(2);
  });

  it("recordSanitizeResult with 0 errors records sanitizedOk and does not quarantine", () => {
    const q = new QuarantineSet<number>();
    expect(q.recordSanitizeResult(1, 0)).toBe(false);
    expect(q.has(1)).toBe(false);
    const s = profileMetrics.snapshot();
    expect(s.sanitizedOk).toBe(1);
    expect(s.sanitizedWithErrors).toBe(0);
    expect(s.quarantined).toBe(0);
  });

  it("recordSanitizeResult with errors records sanitizedWithErrors and quarantines", () => {
    const q = new QuarantineSet<number>();
    expect(q.recordSanitizeResult(7, 3)).toBe(true);
    expect(q.has(7)).toBe(true);
    const s = profileMetrics.snapshot();
    expect(s.sanitizedOk).toBe(0);
    expect(s.sanitizedWithErrors).toBe(1);
    expect(s.quarantined).toBe(1);
  });

  it("recordSanitizeResult is idempotent for an already-quarantined key", () => {
    const q = new QuarantineSet<number>();
    q.recordSanitizeResult(1, 2);
    q.recordSanitizeResult(1, 2); // already quarantined
    const s = profileMetrics.snapshot();
    expect(s.sanitizedWithErrors).toBe(2);
    expect(s.quarantined).toBe(1);
  });
});
