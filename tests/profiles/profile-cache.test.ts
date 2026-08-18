import { describe, it, expect, vi } from "vitest";
import {
  getCacheProfile,
  getCacheProfileWithLog,
  getCacheInjectionScript,
} from "../../src/profiles/profile-cache.js";
import {
  isCacheInjectionStateCompatible,
  maybeAddCacheInjectionScript,
  resolveCacheInjectionState,
  shouldUseCleanLocalProfile,
} from "../../backends/index.js";

describe("profile-cache", () => {
  it("returns the same profile for the same email", () => {
    const a = getCacheProfile("user@example.com");
    const b = getCacheProfile("user@example.com");
    expect(a).toEqual(b);
  });

  it("is case-insensitive and trims whitespace", () => {
    const a = getCacheProfile("USER@Example.com");
    const b = getCacheProfile("  user@example.com  ");
    expect(a).toEqual(b);
  });

  it("lastVisitDaysAgo is in [1,180] with a long tail", () => {
    let tail = 0;
    for (let i = 0; i < 100; i++) {
      const p = getCacheProfile(`u${i}@x.com`);
      expect(p.lastVisitDaysAgo).toBeGreaterThanOrEqual(1);
      expect(p.lastVisitDaysAgo).toBeLessThanOrEqual(180);
      if (p.lastVisitDaysAgo > 30) tail++;
    }
    expect(tail).toBeGreaterThan(0);
  });

  it("clientId is a UUID-shaped string", () => {
    const p = getCacheProfile("alice@example.com");
    expect(p.clientId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("chromeMajor defaults to 136 and is overridable", () => {
    expect(getCacheProfile("a@b.com").chromeMajor).toBe(136);
    expect(getCacheProfile("a@b.com", 137).chromeMajor).toBe(137);
  });

  it("serviceWorkerHint is boolean and roughly 50/50 across samples", () => {
    let trues = 0;
    const N = 200;
    for (let i = 0; i < N; i++) if (getCacheProfile(`u${i}@x.com`).serviceWorkerHint) trues++;
    expect(trues).toBeGreaterThan(N * 0.3);
    expect(trues).toBeLessThan(N * 0.7);
  });

  it("logs a summary when logFn is provided", () => {
    const logs: string[] = [];
    getCacheProfileWithLog("user@example.com", undefined, (m) => logs.push(m));
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/Cache:.*last_visit \d+d ago/);
  });

  it("does not crash when logFn is omitted", () => {
    const p = getCacheProfileWithLog("nolog@example.com");
    expect(p.email).toBe("nolog@example.com");
  });

  it("handles negative timezone offsets correctly", () => {
    vi.stubEnv("DEFAULT_TIMEZONE", "America/Los_Angeles");
    const p = getCacheProfile("westcoast@example.com");
    expect(p.lastVisitIso).toContain("-");
    // e.g. "-07:00" or "-08:00" at the end of the ISO string
    expect(p.lastVisitIso).toMatch(/-\d{2}:\d{2}$/);
    vi.unstubAllEnvs();
  });

  it("injection script is anonymous — no per-credential breadcrumbs", () => {
    const p = getCacheProfile("alice@example.com");
    const script = getCacheInjectionScript(p);
    // Generic timezone seed remains (sites use it for functional stability).
    expect(script).toContain("setIfAbsent('user_timezone'");
    expect(script).toContain("localStorage.getItem(k) === null");
    // High-entropy identifiers must NOT leak into localStorage anymore — they
    // made sessions linkable across runs.
    expect(script).not.toContain("client_id");
    expect(script).not.toContain("last_visit");
    expect(script).not.toContain("browser_version");
  });

  it("injection script for two different emails produces identical localStorage writes", () => {
    // Anonymity guarantee: the body of the script (everything except the
    // generic timezone constant) is independent of the credential.
    const a = getCacheInjectionScript(getCacheProfile("alice@example.com"));
    const b = getCacheInjectionScript(getCacheProfile("bob@example.com"));
    expect(a).toBe(b);
  });

  it("injection script does not call caches.open — no per-profile service worker hint", () => {
    const withHintTrue = getCacheInjectionScript({ ...getCacheProfile("alice@example.com"), serviceWorkerHint: true });
    const withHintFalse = getCacheInjectionScript({ ...getCacheProfile("alice@example.com"), serviceWorkerHint: false });
    expect(withHintTrue).not.toContain("caches.open");
    expect(withHintFalse).not.toContain("caches.open");
  });

  it("getCacheInjectionScript always returns a non-empty string (gating is caller's responsibility)", () => {
    const p = getCacheProfile("toggle@example.com");
    const script = getCacheInjectionScript(p);
    expect(script.trim().length).toBeGreaterThan(0);
  });
});

describe("cache injection toggle — addInitScript gating", () => {
  it("calls addInitScript when enableCacheInjection is true", async () => {
    const ctx = { addInitScript: vi.fn().mockResolvedValue(undefined) };
    const profile = getCacheProfile("alice@example.com");

    const state = await maybeAddCacheInjectionScript(ctx, profile, true);

    expect(ctx.addInitScript).toHaveBeenCalledTimes(1);
    const firstCall = ctx.addInitScript.mock.calls[0];
    const injectedScript = firstCall ? (firstCall[0] as string) : "";
    // The anonymous script seeds a single generic timezone key — never a
    // per-credential identifier.
    expect(injectedScript).toContain("setIfAbsent('user_timezone'");
    expect(injectedScript).not.toContain(profile.clientId);
    expect(state).toEqual({ enabled: true });
  });

  it("does NOT call addInitScript when enableCacheInjection is false", async () => {
    const ctx = { addInitScript: vi.fn().mockResolvedValue(undefined) };
    const profile = getCacheProfile("alice@example.com");

    const state = await maybeAddCacheInjectionScript(ctx, profile, false);

    expect(ctx.addInitScript).not.toHaveBeenCalled();
    expect(state).toEqual({ enabled: false });
  });

  it("does NOT call addInitScript when cacheProfile is undefined (no email)", async () => {
    const ctx = { addInitScript: vi.fn().mockResolvedValue(undefined) };
    const profile: undefined = undefined;

    const state = await maybeAddCacheInjectionScript(ctx, profile, true);

    expect(ctx.addInitScript).not.toHaveBeenCalled();
    expect(state).toEqual({ enabled: false });
  });

  it("detects cache-injection state compatibility for pooled contexts", () => {
    const profile = getCacheProfile("pool@example.com");
    const enabledState = resolveCacheInjectionState(profile, true);
    const disabledState = resolveCacheInjectionState(profile, false);
    const otherProfileState = resolveCacheInjectionState(getCacheProfile("other@example.com"), true);

    expect(isCacheInjectionStateCompatible(enabledState, enabledState)).toBe(true);
    expect(isCacheInjectionStateCompatible(disabledState, enabledState)).toBe(false);
    // Now compatible: anonymous injection produces identical state for any
    // two enabled credentials, so pooled contexts can be reused freely.
    expect(isCacheInjectionStateCompatible(otherProfileState, enabledState)).toBe(true);
  });

  it("injected script is idempotent — setIfAbsent prevents double-write in pooled contexts", () => {
    const profile = getCacheProfile("pool@example.com");
    const script = getCacheInjectionScript(profile);
    // Verify the guard is present (regression safety)
    expect(script).toContain("localStorage.getItem(k) === null");
    expect(script).toContain("setIfAbsent");
  });

  it("uses fresh isolated local profiles by default so cache injection carries no prior session state", () => {
    vi.stubEnv("CLOAK_REUSE_PROFILES", "");
    expect(shouldUseCleanLocalProfile({})).toBe(true);
    expect(shouldUseCleanLocalProfile({ cleanSession: true })).toBe(true);
    expect(shouldUseCleanLocalProfile({ cleanSession: false })).toBe(false);

    vi.stubEnv("CLOAK_REUSE_PROFILES", "true");
    expect(shouldUseCleanLocalProfile({})).toBe(false);

    vi.unstubAllEnvs();
  });
});

