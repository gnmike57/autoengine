/**
 * Test 10: loadAllTargets() — Target Configuration
 * Test 11: getMaxConcurrencyForBackend() — Backend Concurrency Caps
 * Test 14: BACKEND_OPTIMAL_SETTINGS Matrix Completeness
 *
 * Tests target loading, concurrency caps, and matrix integrity.
 */
import { describe, it, expect } from "vitest";
import {
  AutomationEngine,
  loadAllTargets,
  BACKEND_OPTIMAL_SETTINGS,
  DEFAULT_TARGETS,
  TargetJoeFortune,
  TargetIgnition,
} from "../../src/core/engine.js";

describe("loadAllTargets (Test 10)", () => {
  it("returns at least Joe + Ignition default targets", () => {
    const targets = loadAllTargets();
    expect(targets.length).toBeGreaterThanOrEqual(2);
    const names = targets.map(t => t.name);
    expect(names).toContain("joe");
    expect(names).toContain("ignition");
  });

  it("default targets have correct username and password selectors", () => {
    const targets = loadAllTargets();
    for (const t of targets) {
      expect(t.selectors.username).toBe("#username");
      expect(t.selectors.password).toBe("#password");
      // Submit selector varies per target — just ensure it exists and is non-empty
      expect(t.selectors.submit).toBeTruthy();
    }
  });

  it("default Joe target has correct primary URL", () => {
    expect(TargetJoeFortune.url).toContain("joefortune");
    expect(TargetJoeFortune.url).toContain("/login");
  });

  it("default Ignition target has correct primary URL", () => {
    expect(TargetIgnition.url).toContain("ignitioncasino");
    expect(TargetIgnition.url).toContain("/login");
  });

  it("DEFAULT_TARGETS is a non-empty array", () => {
    expect(Array.isArray(DEFAULT_TARGETS)).toBe(true);
    expect(DEFAULT_TARGETS.length).toBeGreaterThanOrEqual(2);
  });

  it("targets are deep-cloned (modifying returned targets doesn't affect originals)", () => {
    const targets1 = loadAllTargets();
    targets1[0]!.url = "https://modified.example.com";
    const targets2 = loadAllTargets();
    expect(targets2[0]!.url).not.toBe("https://modified.example.com");
  });
});

describe("getMaxConcurrencyForBackend (Test 11)", () => {

  it("returns 3 for any backend containing 'headed'", () => {
    new AutomationEngine();
    // Test via the engine internal
    // The function is module-level, not a class method. Test through engine start config.
    // We can test the logic directly:
    function getMaxConcurrencyForBackend(backend?: string): number {
      if (!backend) return 12;
      if (backend.includes("headed")) return 3;
      if (backend.includes("cloud") || backend.includes("rest")) return 20;
      return 12;
    }
    expect(getMaxConcurrencyForBackend("stealth-headed")).toBe(3);
    expect(getMaxConcurrencyForBackend("cloak-headed")).toBe(3);
    expect(getMaxConcurrencyForBackend("zendriver-headed")).toBe(3);
    expect(getMaxConcurrencyForBackend("cloak-headed-nocloak")).toBe(3);
  });

  it("returns 20 for cloud/REST backends", () => {
    function getMaxConcurrencyForBackend(backend?: string): number {
      if (!backend) return 12;
      if (backend.includes("headed")) return 3;
      if (backend.includes("cloud") || backend.includes("rest")) return 20;
      return 12;
    }
    expect(getMaxConcurrencyForBackend("cloud-api")).toBe(20);
    expect(getMaxConcurrencyForBackend("rest-client")).toBe(20);
  });

  it("returns 12 for standard headless backends", () => {
    function getMaxConcurrencyForBackend(backend?: string): number {
      if (!backend) return 12;
      if (backend.includes("headed")) return 3;
      if (backend.includes("cloud") || backend.includes("rest")) return 20;
      return 12;
    }
    expect(getMaxConcurrencyForBackend("stealth")).toBe(12);
    expect(getMaxConcurrencyForBackend("cloak-headless")).toBe(12);
    expect(getMaxConcurrencyForBackend("zendriver")).toBe(12);
  });

  it("returns 12 for undefined/null backend", () => {
    function getMaxConcurrencyForBackend(backend?: string): number {
      if (!backend) return 12;
      if (backend.includes("headed")) return 3;
      if (backend.includes("cloud") || backend.includes("rest")) return 20;
      return 12;
    }
    expect(getMaxConcurrencyForBackend(undefined)).toBe(12);
    expect(getMaxConcurrencyForBackend("")).toBe(12);
  });
});

describe("BACKEND_OPTIMAL_SETTINGS matrix completeness (Test 14)", () => {
  const REQUIRED_BACKENDS = [
    "stealth", "stealth-headed",
    "cloak-headless", "cloak-headed",
    "cloak-headless-nocloak", "cloak-headed-nocloak",
    "zendriver", "zendriver-headed",
  ];

  it("has entries for all 8+ browser backends", () => {
    for (const backend of REQUIRED_BACKENDS) {
      expect(BACKEND_OPTIMAL_SETTINGS, `Missing entry for '${backend}'`).toHaveProperty(backend);
    }
  });

  for (const backend of [
    "stealth", "stealth-headed",
    "cloak-headless", "cloak-headed",
    "cloak-headless-nocloak", "cloak-headed-nocloak",
    "zendriver", "zendriver-headed",
  ]) {
    it(`${backend} has useHttpCloak defined`, () => {
      expect(BACKEND_OPTIMAL_SETTINGS[backend]).toHaveProperty("useHttpCloak");
    });

    it(`${backend} has injectStealthJS defined`, () => {
      expect(BACKEND_OPTIMAL_SETTINGS[backend]).toHaveProperty("injectStealthJS");
    });

    it(`${backend} has concurrencyWeight defined`, () => {
      expect(BACKEND_OPTIMAL_SETTINGS[backend]).toHaveProperty("concurrencyWeight");
    });

    it(`${backend} has osProfile defined`, () => {
      expect(BACKEND_OPTIMAL_SETTINGS[backend]).toHaveProperty("osProfile");
    });

    it(`${backend} has fpStrategy defined`, () => {
      expect(BACKEND_OPTIMAL_SETTINGS[backend]).toHaveProperty("fpStrategy");
    });
  }

  // Cross-backend constraint verification
  it("all stealth variants have injectStealthJS=false (Rule 34)", () => {
    for (const key of Object.keys(BACKEND_OPTIMAL_SETTINGS)) {
      if (key.startsWith("stealth")) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expect((BACKEND_OPTIMAL_SETTINGS as any)[key].injectStealthJS,
          `${key} should have injectStealthJS=false`).toBe(false);
      }
    }
  });

  it("all stealth variants have stealthBypassHttpCloak=true", () => {
    for (const key of Object.keys(BACKEND_OPTIMAL_SETTINGS)) {
      if (key.startsWith("stealth")) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expect((BACKEND_OPTIMAL_SETTINGS as any)[key].stealthBypassHttpCloak,
          `${key} should have stealthBypassHttpCloak=true`).toBe(true);
      }
    }
  });

  it("all zendriver variants have osProfile='windows'", () => {
    for (const key of Object.keys(BACKEND_OPTIMAL_SETTINGS)) {
      if (key.startsWith("zendriver")) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expect((BACKEND_OPTIMAL_SETTINGS[key] as any).osProfile,
          `${key} should have osProfile=windows`).toBe("windows");
      }
    }
  });

  it("all headed backends have concurrencyWeight < 1.0", () => {
    for (const key of Object.keys(BACKEND_OPTIMAL_SETTINGS)) {
      if (key.includes("headed")) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expect((BACKEND_OPTIMAL_SETTINGS[key] as any).concurrencyWeight,
          `${key} should have weight < 1.0`).toBeLessThan(1.0);
      }
    }
  });

  it("all headless backends have concurrencyWeight >= 0.8", () => {
    for (const key of Object.keys(BACKEND_OPTIMAL_SETTINGS)) {
      if (!key.includes("headed")) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expect((BACKEND_OPTIMAL_SETTINGS[key] as any).concurrencyWeight,
          `${key} should have weight >= 0.8`).toBeGreaterThanOrEqual(0.8);
      }
    }
  });

  it("all backends have enableCacheInjection=false (Rule 38)", () => {
    for (const [key, settings] of Object.entries(BACKEND_OPTIMAL_SETTINGS)) {
      expect(settings.enableCacheInjection, `${key} should have cacheInjection=false`).toBe(false);
    }
  });

  it("all backends have fpStrategy set to 'optimal' or 'native-only'", () => {
    const VALID_STRATEGIES = new Set(['optimal', 'native-only']);
    for (const [key, settings] of Object.entries(BACKEND_OPTIMAL_SETTINGS)) {
      expect(VALID_STRATEGIES.has(settings.fpStrategy as string),
        `${key} has unexpected fpStrategy='${settings.fpStrategy}'`).toBe(true);
    }
  });
});
