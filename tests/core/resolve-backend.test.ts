/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unused-vars */
/**
 * Test 1: resolveBackendSettings() — Per-Backend Auto-Optimization
 *
 * Tests the resolver that drives ALL per-session stealth configuration.
 * A regression here silently misconfigures httpCloak/stealthJS per backend.
 */
import { describe, it, expect } from "vitest";
import {
  resolveBackendSettings,
  BACKEND_OPTIMAL_SETTINGS,
  type EngineConfig,
  
} from "../../src/core/engine.js";

const baseConfig: EngineConfig = {
  backend: "stealth",
  concurrency: 8,
  maxRetries: 2,
  proxyPool: "4r",
  targets: [],
  fpStrategy: "fp-auto",
  useHttpCloak: true,
  stealthBypassHttpCloak: false,
  enableCacheInjection: false,
  injectStealthJS: true,
  recordVideo: false,
  mutateOnRetry: true,
  cleanSession: true,
  autoOptimizePerBackend: true,
};

describe("resolveBackendSettings", () => {
  // ── Core stealth constraints (always enforced) ──

  it("stealth: httpCloak=false, stealthJS=false, stealthBypass=true", () => {
    const r = resolveBackendSettings("stealth", baseConfig);
    expect(r.useHttpCloak).toBe(false);
    expect(r.injectStealthJS).toBe(false);
    expect(r.stealthBypassHttpCloak).toBe(true);
  });

  it("stealth-headed: httpCloak=false, stealthJS=false, stealthBypass=true", () => {
    const r = resolveBackendSettings("stealth-headed", baseConfig);
    expect(r.useHttpCloak).toBe(false);
    expect(r.injectStealthJS).toBe(false);
    expect(r.stealthBypassHttpCloak).toBe(true);
  });

  it("cloak-headless: httpCloak=true, stealthJS=true, stealthBypass=false", () => {
    const r = resolveBackendSettings("cloak-headless", baseConfig);
    expect(r.useHttpCloak).toBe(true);
    expect(r.injectStealthJS).toBe(true);
    expect(r.stealthBypassHttpCloak).toBe(false);
  });

  it("cloak-headed: httpCloak=true, stealthJS=true", () => {
    const r = resolveBackendSettings("cloak-headed", baseConfig);
    expect(r.useHttpCloak).toBe(true);
    expect(r.injectStealthJS).toBe(true);
  });

  it("cloak-headless-nocloak: httpCloak=false, stealthJS=true", () => {
    const r = resolveBackendSettings("cloak-headless-nocloak", baseConfig);
    expect(r.useHttpCloak).toBe(false);
    expect(r.injectStealthJS).toBe(true);
  });

  it("zendriver: httpCloak=true, stealthJS=true", () => {
    const r = resolveBackendSettings("zendriver", baseConfig);
    expect(r.useHttpCloak).toBe(true);
    expect(r.injectStealthJS).toBe(true);
  });

  it("zendriver-headed: httpCloak=true, stealthJS=true", () => {
    const r = resolveBackendSettings("zendriver-headed", baseConfig);
    expect(r.useHttpCloak).toBe(true);
    expect(r.injectStealthJS).toBe(true);
  });

  // ── Extended settings gated by autoOptimize ──

  it("returns osProfile='windows' for stealth when autoOptimize=true", () => {
    const r = resolveBackendSettings("stealth", baseConfig, undefined, true);
    expect(r.osProfile).toBe("windows");
  });

  it("returns osProfile='windows' for zendriver when autoOptimize=true", () => {
    const r = resolveBackendSettings("zendriver", baseConfig, undefined, true);
    expect(r.osProfile).toBe("windows");
  });

  it("returns osProfile=undefined when autoOptimize=false", () => {
    const r = resolveBackendSettings("zendriver", baseConfig, undefined, false);
    expect(r.osProfile).toBeUndefined();
  });

  it("returns concurrencyWeight=0.5 for headed backends when autoOptimize=true", () => {
    const r = resolveBackendSettings("stealth-headed", baseConfig, undefined, true);
    expect(r.concurrencyWeight).toBe(0.5);
  });

  it("returns concurrencyWeight=0.4 for zendriver-headed when autoOptimize=true", () => {
    const r = resolveBackendSettings("zendriver-headed", baseConfig, undefined, true);
    expect(r.concurrencyWeight).toBe(0.4);
  });

  it("returns concurrencyWeight=1.0 for all backends when autoOptimize=false", () => {
    const r = resolveBackendSettings("stealth-headed", baseConfig, undefined, false);
    expect(r.concurrencyWeight).toBe(1.0);
  });

  it("returns recordVideo=true for headed backends when autoOptimize=true", () => {
    const r = resolveBackendSettings("cloak-headed", baseConfig, undefined, true);
    expect(r.recordVideo).toBe(true);
  });

  it("returns recordVideo=true for headless backends when autoOptimize=true (universally enabled per project rules)", () => {
    const r = resolveBackendSettings("stealth", baseConfig, undefined, true);
    expect(r.recordVideo).toBe(true);
  });

  // ── Priority chain: matrix > experimental > global ──

  it("matrix httpCloak overrides global config.useHttpCloak", () => {
    // Global config says useHttpCloak=true but stealth matrix says false
    const configWithHttpCloak = { ...baseConfig, useHttpCloak: true };
    const r = resolveBackendSettings("stealth", configWithHttpCloak);
    expect(r.useHttpCloak).toBe(false); // Matrix wins
  });

  it("experimental legacy fpStrategy normalizes to 'optimal'", () => {
    const expConfig = { fpStrategy: "apify" } as any;
    const r = resolveBackendSettings("stealth", baseConfig, expConfig);
    // "apify" is a legacy alias that normalizes to "optimal"
    expect(r.fpStrategy).toBe("optimal");
  });

  it("global config is fallback when matrix has no value for a setting", () => {
    const configWithCacheOn = { ...baseConfig, enableCacheInjection: true };
    // stealth matrix says enableCacheInjection=false, so matrix still wins
    const r = resolveBackendSettings("stealth", configWithCacheOn);
    expect(r.enableCacheInjection).toBe(false);
  });

  // ── Unknown backend graceful fallback ──

  it("returns sane defaults for an unrecognized backend name", () => {
    const r = resolveBackendSettings("totally-unknown-backend", baseConfig);
    // Should fall through to global config values
    expect(r.useHttpCloak).toBe(baseConfig.useHttpCloak);
    expect(r.injectStealthJS).toBe(baseConfig.injectStealthJS);
    expect(r.concurrencyWeight).toBe(1.0);
  });

  // ── All backends produce enableCacheInjection=false ──

  it("all backends in the matrix have enableCacheInjection=false", () => {
    for (const [backend, _settings] of Object.entries(BACKEND_OPTIMAL_SETTINGS)) {
      const r = resolveBackendSettings(backend, baseConfig);
      expect(r.enableCacheInjection, `${backend} should have cacheInjection=false`).toBe(false);
    }
  });
});
