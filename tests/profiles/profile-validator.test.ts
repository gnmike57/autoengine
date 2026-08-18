import { describe, it, expect, beforeEach } from "vitest";
import { validateProfileBundle } from "../../src/profiles/profile-validator.js";
import { getConsistentUserAgent } from "../../src/profiles/profile-useragent.js";
import { getConsistentHardware } from "../../src/profiles/profile-determinism.js";
import { getCacheProfile } from "../../src/profiles/profile-cache.js";
import { getConsistentResolution } from "../../src/profiles/profile-resolution.js";
import { getFontProfile } from "../../src/profiles/profile-fonts.js";
import { alignGeoToProxy } from "../../src/profiles/profile-geo-alignment.js";
import { profileMetrics } from "../../src/profiles/profile-metrics.js";

const EMAIL = "user@example.com";

function fullBundle(email = EMAIL) {
  const ua = getConsistentUserAgent(email)!;
  return {
    email,
    ua,
    hardware: getConsistentHardware(email, ua.os),
    cache: getCacheProfile(email, ua.chromeMajor),
    resolution: getConsistentResolution(email),
    fonts: getFontProfile(email),
  };
}

describe("validateProfileBundle", () => {
  beforeEach(() => profileMetrics.reset());

  it("passes for an internally consistent bundle", () => {
    const res = validateProfileBundle(fullBundle());
    expect(res.ok).toBe(true);
    expect(res.errors).toEqual([]);
    expect(res.warnings).toEqual([]);
    expect(profileMetrics.snapshot().validationFailed).toBe(0);
  });

  it("errors and short-circuits when email is missing", () => {
    const res = validateProfileBundle({ email: "" });
    expect(res.ok).toBe(false);
    expect(res.errors).toContain("email: missing");
    expect(profileMetrics.snapshot().validationFailed).toBe(1);
  });

  it("errors and short-circuits when email is whitespace-only", () => {
    const res = validateProfileBundle({ email: "   " });
    expect(res.ok).toBe(false);
    expect(res.errors).toContain("email: missing");
  });

  it("warns (only) when optional fields are absent", () => {
    const res = validateProfileBundle({ email: EMAIL });
    expect(res.ok).toBe(true);
    expect(res.errors).toEqual([]);
    expect(res.warnings).toEqual(expect.arrayContaining([
      "ua: missing", "cache: missing", "hardware: missing", "resolution: missing",
    ]));
  });

  it("detects UA drift vs. the deterministic profile", () => {
    const b = fullBundle();
    b.ua = { ...b.ua, chromeMajor: b.ua.chromeMajor + 1 };
    // keep cache.chromeMajor aligned so we isolate the UA-drift error
    b.cache = { ...b.cache, chromeMajor: b.ua.chromeMajor };
    const res = validateProfileBundle(b);
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.startsWith("ua: drift"))).toBe(true);
    expect(profileMetrics.snapshot().validationFailed).toBe(1);
  });

  it("detects hardware drift", () => {
    const b = fullBundle();
    b.hardware = { ...b.hardware, cores: b.hardware.cores + 4 };
    const res = validateProfileBundle(b);
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.startsWith("hardware: drift"))).toBe(true);
  });

  it("detects resolution drift and invalid dimensions", () => {
    const b = fullBundle();
    b.resolution = { ...b.resolution, width: -1, height: -1 };
    const res = validateProfileBundle(b);
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.startsWith("resolution: drift"))).toBe(true);
    expect(res.errors.some((e) => e.startsWith("resolution: invalid"))).toBe(true);
  });

  it("detects cache clientId drift", () => {
    const b = fullBundle();
    b.cache = { ...b.cache, clientId: "00000000-0000-4000-a000-000000000000" };
    const res = validateProfileBundle(b);
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.startsWith("cache: clientId drift"))).toBe(true);
  });

  it("flags cross-field UA.chromeMajor ≠ cache.chromeMajor", () => {
    const b = fullBundle();
    // Pin cache chromeMajor away from UA's; recompute cache fields so the
    // intra-field cache check (clientId/lastVisitDaysAgo) still passes.
    const drifted = b.ua.chromeMajor + 5;
    b.cache = getCacheProfile(EMAIL, drifted);
    const res = validateProfileBundle(b);
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.startsWith("cross: UA.chromeMajor"))).toBe(true);
  });

  it("passes the geo cross-check when geo matches proxy", () => {
    const proxy = "http://us.example.com:8080";
    const expected = alignGeoToProxy(proxy);
    const res = validateProfileBundle({ email: EMAIL, geo: expected, proxy });
    expect(res.errors.filter((e) => e.startsWith("cross: geo"))).toEqual([]);
  });

  it("flags geo cross-check when geo countryCode disagrees with proxy", () => {
    const proxy = "http://us.example.com:8080";
    const wrong = alignGeoToProxy("http://de.example.com:8080");
    const res = validateProfileBundle({ email: EMAIL, geo: wrong, proxy });
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.startsWith("cross: geo.countryCode"))).toBe(true);
  });

  it("detects font drift", () => {
    const b = fullBundle();
    const wrongName = b.fonts.name === "minimal" ? "heavy-user" : "minimal";
    b.fonts = { ...b.fonts, name: wrongName };
    const res = validateProfileBundle(b);
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.startsWith("fonts: drift"))).toBe(true);
  });
});
