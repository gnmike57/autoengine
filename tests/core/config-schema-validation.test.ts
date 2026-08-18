/**
 * Config Schema Validation Tests
 *
 * Validates that framework configuration objects produced by the
 * config module conform to expected shapes, bounds, and constraints.
 * Catches schema drift when new fields are added or removed.
 */
import { describe, it, expect } from "vitest";
import {
  getCamoufoxConfig,
  getCloakBrowserConfig,
  getZendriverConfig,
  getSpiderConfig,
  getFrameworkConfig,
  type FrameworkConfig,
  type FrameworkName,
} from "../../src/core/framework-config.js";

const DUMMY_HW = {
  cores: 8,
  memory: 16,
  gpu: { vendor: "NVIDIA", renderer: "GeForce RTX 3060" },
};

const SEED = 42;

function assertValidFrameworkConfig(config: FrameworkConfig, expectedName: FrameworkName) {
  // Name
  expect(config.name).toBe(expectedName);

  // Canvas noise
  expect(typeof config.canvas.enabled).toBe("boolean");
  expect(typeof config.canvas.magnitude).toBe("number");

  // Audio noise
  expect(typeof config.audio.enabled).toBe("boolean");
  if (config.audio.enabled) {
    expect(config.audio.delta).toBeGreaterThanOrEqual(0);
    expect(config.audio.delta).toBeLessThanOrEqual(1);
  }

  // WebGL rotation
  expect(typeof config.webgl.enabled).toBe("boolean");
  expect(Array.isArray(config.webgl.pool)).toBe(true);

  // Connection emulation
  expect(typeof config.connection.enabled).toBe("boolean");
  if (config.connection.enabled) {
    expect(["wifi", "cellular", "ethernet"]).toContain(config.connection.type);
  }

  // CDP commands
  expect(Array.isArray(config.cdpCommands)).toBe(true);
  for (const cmd of config.cdpCommands) {
    expect(typeof cmd.method).toBe("string");
    expect(typeof cmd.params).toBe("object");
  }

  // Launch args
  expect(Array.isArray(config.launchArgs)).toBe(true);
  for (const arg of config.launchArgs) {
    expect(typeof arg).toBe("string");
  }

  // WASM support
  expect(typeof config.wasmSupport).toBe("boolean");
}

describe("framework-config schema validation", () => {
  describe("getCamoufoxConfig", () => {
    it("returns a valid FrameworkConfig for camoufox", () => {
      const config = getCamoufoxConfig(DUMMY_HW, SEED);
      assertValidFrameworkConfig(config, "camoufox");
    });
  });

  describe("getCloakBrowserConfig", () => {
    it("returns a valid FrameworkConfig for cloakbrowser", () => {
      const config = getCloakBrowserConfig(DUMMY_HW, SEED);
      assertValidFrameworkConfig(config, "cloakbrowser");
    });
  });

  describe("getZendriverConfig", () => {
    it("returns a valid FrameworkConfig for zendriver", () => {
      const config = getZendriverConfig(DUMMY_HW, SEED);
      assertValidFrameworkConfig(config, "zendriver");
    });
  });

  describe("getSpiderConfig", () => {
    it("returns a valid FrameworkConfig for spider", () => {
      const config = getSpiderConfig(DUMMY_HW, SEED);
      assertValidFrameworkConfig(config, "spider");
    });
  });

  describe("getFrameworkConfig dispatcher", () => {
    const frameworks: FrameworkName[] = ["camoufox", "cloakbrowser", "zendriver", "spider"];

    for (const name of frameworks) {
      it(`dispatches correctly for "${name}"`, () => {
        const config = getFrameworkConfig(name, DUMMY_HW, SEED);
        assertValidFrameworkConfig(config, name);
      });
    }

    it("canvas magnitude is ≤ 0.5 (safe upper bound)", () => {
      for (const name of frameworks) {
        const config = getFrameworkConfig(name, DUMMY_HW, SEED);
        if (config.canvas.enabled) {
          expect(config.canvas.magnitude).toBeLessThanOrEqual(0.5);
        }
      }
    });

    it("audio delta is ≤ 0.5 when audio is enabled", () => {
      for (const name of frameworks) {
        const config = getFrameworkConfig(name, DUMMY_HW, SEED);
        if (config.audio.enabled && !isNaN(config.audio.delta)) {
          expect(config.audio.delta).toBeLessThanOrEqual(0.5);
        }
      }
    });
  });

  describe("hardware integration", () => {
    it("WebGL pool is a non-empty array when webgl is enabled", () => {
      const config = getCloakBrowserConfig(DUMMY_HW, SEED);
      if (config.webgl.enabled) {
        expect(config.webgl.pool.length).toBeGreaterThan(0);
        for (const entry of config.webgl.pool) {
          expect(typeof entry.vendor).toBe("string");
          expect(typeof entry.renderer).toBe("string");
        }
      }
    });
  });

  describe("connection emulation bounds", () => {
    it("rttMs is reasonable (0-500ms)", () => {
      for (const name of ["cloakbrowser", "zendriver", "spider"] as FrameworkName[]) {
        const config = getFrameworkConfig(name, DUMMY_HW, SEED);
        if (config.connection.enabled) {
          expect(config.connection.rttMs).toBeGreaterThanOrEqual(0);
          expect(config.connection.rttMs).toBeLessThanOrEqual(500);
        }
      }
    });

    it("downlinkMbps is positive and reasonable", () => {
      for (const name of ["cloakbrowser", "zendriver", "spider"] as FrameworkName[]) {
        const config = getFrameworkConfig(name, DUMMY_HW, SEED);
        if (config.connection.enabled) {
          expect(config.connection.downlinkMbps).toBeGreaterThan(0);
          expect(config.connection.downlinkMbps).toBeLessThanOrEqual(100);
        }
      }
    });
  });
});
