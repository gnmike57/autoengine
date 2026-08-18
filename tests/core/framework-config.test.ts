import { describe, it, expect } from "vitest";
import {
  getFrameworkConfig,
  getCamoufoxConfig,
  getCloakBrowserConfig,
  getZendriverConfig,
  getSpiderConfig,
  getCurrentWebGLPair,
  getNetworkEmulationParams,
  type FrameworkName,
} from "../../src/core/framework-config.js";
import { type HardwareProfile } from "../../src/profiles/profile-determinism.js";

const INTEL_HW: HardwareProfile = {
  cores: 8,
  memory: 16,
  gpu: { vendor: "Intel", renderer: "UHD Graphics 750" },
};

const NVIDIA_HW: HardwareProfile = {
  cores: 12,
  memory: 32,
  gpu: { vendor: "NVIDIA", renderer: "GeForce RTX 3060" },
};

describe("framework-config", () => {
  describe("getCamoufoxConfig", () => {
    it("returns lower canvas noise for integrated GPU", () => {
      const config = getCamoufoxConfig(INTEL_HW, 42);
      expect(config.name).toBe("camoufox");
      expect(config.canvas.enabled).toBe(true);
      expect(config.canvas.magnitude).toBe(0.15);
    });

    it("returns higher canvas noise for discrete GPU", () => {
      const config = getCamoufoxConfig(NVIDIA_HW, 42);
      expect(config.canvas.magnitude).toBe(0.3);
    });

    it("disables WebGL rotation (handled internally)", () => {
      const config = getCamoufoxConfig(INTEL_HW, 42);
      expect(config.webgl.enabled).toBe(false);
    });
  });

  describe("getCloakBrowserConfig", () => {
    it("enables hourly WebGL rotation", () => {
      const config = getCloakBrowserConfig(NVIDIA_HW, 42);
      expect(config.name).toBe("cloakbrowser");
      expect(config.webgl.enabled).toBe(true);
      expect(config.webgl.intervalMinutes).toBe(60);
      expect(config.webgl.pool.length).toBeGreaterThan(0);
    });

    it("deduplicates WebGL pool entries", () => {
      const config = getCloakBrowserConfig(NVIDIA_HW, 42);
      const keys = config.webgl.pool.map(p => `${p.vendor}|${p.renderer}`);
      const unique = new Set(keys);
      expect(keys.length).toBe(unique.size);
    });
  });

  describe("getZendriverConfig", () => {
    it("includes CDP commands for webdriver and chrome.runtime patching", () => {
      const config = getZendriverConfig(INTEL_HW, 42);
      expect(config.name).toBe("zendriver");
      expect(config.cdpCommands.length).toBe(2);
      expect(config.cdpCommands[0]!.method).toBe("Page.addScriptToEvaluateOnNewDocument");
      expect(config.cdpCommands[1]!.method).toBe("Runtime.evaluate");
    });

    it("includes disable-blink-features launch arg", () => {
      const config = getZendriverConfig(INTEL_HW, 42);
      expect(config.launchArgs).toContain("--disable-blink-features=AutomationControlled");
    });
  });

  describe("getSpiderConfig", () => {
    it("enables WASM support", () => {
      const config = getSpiderConfig(INTEL_HW, 42);
      expect(config.name).toBe("spider");
      expect(config.wasmSupport).toBe(true);
    });

    it("disables canvas/audio (handled internally)", () => {
      const config = getSpiderConfig(INTEL_HW, 42);
      expect(config.canvas.enabled).toBe(false);
      expect(config.audio.enabled).toBe(false);
    });
  });

  describe("getFrameworkConfig", () => {
    it("resolves each framework name correctly", () => {
      const names: FrameworkName[] = ["camoufox", "cloakbrowser", "zendriver", "spider", "stealth"];
      for (const name of names) {
        const config = getFrameworkConfig(name, INTEL_HW, 42);
        expect(config).toBeDefined();
        expect(config.connection.enabled).toBe(true);
      }
    });

    it("stealth falls back to cloakbrowser config", () => {
      const stealth = getFrameworkConfig("stealth", INTEL_HW, 42);
      const cloak = getFrameworkConfig("cloakbrowser", INTEL_HW, 42);
      expect(stealth.canvas.magnitude).toBe(cloak.canvas.magnitude);
    });
  });

  describe("getCurrentWebGLPair", () => {
    it("returns undefined when WebGL rotation is disabled", () => {
      const config = getCamoufoxConfig(INTEL_HW, 42);
      expect(getCurrentWebGLPair(config, 42)).toBeUndefined();
    });

    it("returns a pair from the pool when enabled", () => {
      const config = getCloakBrowserConfig(NVIDIA_HW, 42);
      const pair = getCurrentWebGLPair(config, 42);
      expect(pair).toBeDefined();
      expect(pair!.vendor).toBeTruthy();
      expect(pair!.renderer).toBeTruthy();
    });
  });

  describe("getNetworkEmulationParams", () => {
    it("returns connection params when enabled", () => {
      const config = getCamoufoxConfig(INTEL_HW, 42);
      const params = getNetworkEmulationParams(config);
      expect(params).toBeDefined();
      expect(params!.offline).toBe(false);
      expect(params!.latency).toBeGreaterThan(0);
      expect(params!.downloadThroughput).toBeGreaterThan(0);
    });
  });
});
