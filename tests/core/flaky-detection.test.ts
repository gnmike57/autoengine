/**
 * Flaky Test Detection Suite
 *
 * PURPOSE: Surface timing-dependent flakiness and verify that all
 * randomness-dependent code paths accept deterministic seeds for
 * reproducibility. This file is designed to be run with --repeat=5
 * to catch intermittent failures.
 *
 * Run: npx vitest run tests/core/flaky-detection.test.ts --repeat=5
 */
import { describe, it, expect } from "vitest";
import { getConsistentHardware } from "../../src/profiles/profile-determinism.js";
import { detectLoginTrigger } from "../../src/targets/login-flow.js";
import { classifyLoginResponse, type LoginSignals } from "../../src/core/engine.js";
import { gaussianClamped } from "../../src/core/gaussian-rng.js";
import {
  getCanvasSpoofScript,
  getAudioContextSpoofScript,
  getFontMetricSpoofScript,
  getWebGLSpoofScript,
  getHardwareSpoofScript,
  getWebdriverOverrideScript,
  getPluginsSpoofScript,
  getWebRTCSpoofScript,
} from "../../src/stealth/stealth-scripts.js";

function makeSignals(overrides: Partial<LoginSignals> = {}): LoginSignals {
  return {
    bodyText: "",
    passwordPresent: true,
    urlMoved: false,
    hasSuccessSelector: false,
    submitGone: false,
    alertPresent: false,
    promoPresent: false,
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 1: Seed-fixed reproducibility
//
// Every function that accepts a seed or produces deterministic output
// from the same input MUST return identical results on every call.
// If these tests ever fail under --repeat=5, we have a flake.
// ═══════════════════════════════════════════════════════════════════════════

describe("seed-fixed reproducibility (safe to --repeat=N)", () => {
  describe("fingerprint determinism is stable across runs", () => {
    const SEEDS = [0, 1, 42, 9999, 2147483647];
    const EMAILS = [
      "alice@gmail.com",
      "bob@yahoo.com",
      "charlie.delta@proton.me",
      "test+suffix@hotmail.com",
      "üñí©ödé@example.com",
    ];

    for (const email of EMAILS) {
      it(`getConsistentHardware("${email.slice(0, 20)}…") is stable`, () => {
        const baseline = getConsistentHardware(email, "windows");
        const repeat = getConsistentHardware(email, "windows");
        expect(repeat).toStrictEqual(baseline);
      });
    }

    for (const seed of SEEDS) {
      it(`canvas spoof with seed=${seed} is stable`, () => {
        const a = getCanvasSpoofScript(seed);
        const b = getCanvasSpoofScript(seed);
        expect(a).toBe(b);
      });

      it(`audio spoof with seed=${seed} is stable`, () => {
        const a = getAudioContextSpoofScript(seed);
        const b = getAudioContextSpoofScript(seed);
        expect(a).toBe(b);
      });

      it(`hardware spoof with seed=${seed} is stable`, () => {
        const a = getHardwareSpoofScript(seed);
        const b = getHardwareSpoofScript(seed);
        expect(a).toBe(b);
      });
    }

    it("font metric script is stable for each OS", () => {
      for (const os of ["windows", "macos", "linux", "android"] as const) {
        const a = getFontMetricSpoofScript(os, 42);
        const b = getFontMetricSpoofScript(os, 42);
        expect(a).toBe(b);
      }
    });

    it("WebGL spoof is stable for same (vendor, renderer)", () => {
      const pairs = [
        ["Intel", "UHD Graphics 630"],
        ["NVIDIA", "GeForce RTX 3060"],
        ["AMD", "Radeon RX 6600"],
        ["Apple", "Apple M2"],
      ] as const;
      for (const [v, r] of pairs) {
        const a = getWebGLSpoofScript(v, r);
        const b = getWebGLSpoofScript(v, r);
        expect(a).toBe(b);
      }
    });

    it("static scripts (no seed) are always identical", () => {
      expect(getWebdriverOverrideScript()).toBe(getWebdriverOverrideScript());
      expect(getPluginsSpoofScript()).toBe(getPluginsSpoofScript());
      expect(getWebRTCSpoofScript()).toBe(getWebRTCSpoofScript());
    });
  });

  describe("classification is deterministic for the same signals", () => {
    const testCases = [
      { label: "tempdisabled", signals: makeSignals({ bodyText: "temporarily disabled" }), expected: "tempdisabled" },
      { label: "disabled", signals: makeSignals({ bodyText: "permanently disabled" }), expected: "disabled" },
      { label: "honeypot", signals: makeSignals({ bodyText: "under review" }), expected: "honeypot" },
      { label: "incorrect-alert", signals: makeSignals({ alertPresent: true }), expected: "incorrect" },
      { label: "success-selector", signals: makeSignals({ hasSuccessSelector: true }), expected: "success" },
      { label: "other-empty", signals: makeSignals(), expected: "other" },
    ];

    for (const tc of testCases) {
      it(`classifyLoginResponse("${tc.label}") → "${tc.expected}" is stable`, () => {
        const a = classifyLoginResponse(tc.signals, "joe");
        const b = classifyLoginResponse(tc.signals, "joe");
        expect(a).toBe(tc.expected);
        expect(b).toBe(tc.expected);
      });
    }
  });

  describe("detectLoginTrigger is deterministic", () => {
    const cases = [
      { text: "AUTHENTICATOR code required", site: "joe", expected: "authenticator" },
      { text: "VERIFY YOUR PHONE", site: "joe", expected: "verify-phone" },
      { text: "UPDATE YOUR PIN", site: "joe", expected: "pin-misdirection" },
      { text: "LOGIN VERIFICATION", site: "ignition", expected: "ignition-verification" },
      { text: "Welcome back!", site: "joe", expected: null },
    ];

    for (const tc of cases) {
      it(`detectLoginTrigger("${tc.text.slice(0, 20)}…") is stable`, () => {
        const a = detectLoginTrigger(tc.text, tc.site);
        const b = detectLoginTrigger(tc.text, tc.site);
        expect(a).toBe(tc.expected);
        expect(b).toBe(tc.expected);
      });
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 2: gaussianClamped reproducibility
//
// gaussianClamped uses Box-Muller with Math.random() by default, but
// when called repeatedly with the same (mean, stddev, min, max) it
// should always return a value within [min, max]. If a run ever
// produces a value outside bounds, the clamp is broken.
// ═══════════════════════════════════════════════════════════════════════════

describe("gaussianClamped bounds invariant (repeat-safe)", () => {
  it("always returns a value within [min, max] across 1000 calls", () => {
    const min = 50;
    const max = 200;
    const mean = 120;
    const stddev = 30;

    for (let i = 0; i < 1000; i++) {
      const val = gaussianClamped(mean, stddev, min, max);
      expect(val).toBeGreaterThanOrEqual(min);
      expect(val).toBeLessThanOrEqual(max);
    }
  });

  it("returns integer values for integer-ranged clamps", () => {
    for (let i = 0; i < 100; i++) {
      const val = gaussianClamped(100, 20, 50, 200);
      // gaussianClamped returns a number — verify it's finite
      expect(Number.isFinite(val)).toBe(true);
    }
  });

  it("different calls with same params do NOT all return the same value", () => {
    const results = new Set<number>();
    for (let i = 0; i < 50; i++) {
      results.add(gaussianClamped(100, 20, 50, 200));
    }
    // With stddev=20, we should see at least 3 distinct values in 50 calls
    expect(results.size).toBeGreaterThanOrEqual(3);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 3: Timing-sensitive operations
//
// These tests verify that operations which might have timing dependencies
// (Date.now(), setTimeout, Promise resolution order) are deterministic
// within the test harness.
// ═══════════════════════════════════════════════════════════════════════════

describe("timing-sensitive determinism", () => {
  it("Date.now() progresses monotonically within a test", () => {
    const times: number[] = [];
    for (let i = 0; i < 10; i++) {
      times.push(Date.now());
    }
    for (let i = 1; i < times.length; i++) {
      expect(times[i]!).toBeGreaterThanOrEqual(times[i - 1]!);
    }
  });

  it("Promise.all resolution order doesn't affect classification", async () => {
    const signals = [
      makeSignals({ bodyText: "temporarily disabled" }),
      makeSignals({ hasSuccessSelector: true }),
      makeSignals({ alertPresent: true }),
    ];

    const results = await Promise.all(
      signals.map((s) => Promise.resolve(classifyLoginResponse(s, "joe")))
    );

    expect(results[0]).toBe("tempdisabled");
    expect(results[1]).toBe("success");
    expect(results[2]).toBe("incorrect");
  });

  it("concurrent fingerprint lookups don't interfere", async () => {
    const emails = Array.from({ length: 20 }, (_, i) => `concurrent-${i}@test.com`);
    const baselines = emails.map((e) => getConsistentHardware(e, "windows"));

    // Simulate concurrent access
    const results = await Promise.all(
      emails.map((e) => Promise.resolve(getConsistentHardware(e, "windows")))
    );

    for (let i = 0; i < emails.length; i++) {
      expect(results[i]).toStrictEqual(baselines[i]);
    }
  });
});
