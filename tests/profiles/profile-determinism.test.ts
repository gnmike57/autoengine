/**
 * Tests for Hardware Profile Determinism
 */

import { describe, it, expect } from "vitest";
import {
  getConsistentHardware,
  getConsistentHardwareWithLog,
  getHardwareArgs,
  getNavigatorOverrides,
  type HardwareProfile,
} from "../../src/profiles/profile-determinism.js";

describe("profile-determinism", () => {
  it("returns consistent hardware for same email", () => {
    const hw1 = getConsistentHardware("test@example.com");
    const hw2 = getConsistentHardware("test@example.com");
    expect(hw1).toEqual(hw2);
  });

  it("returns different hardware for different email domains", () => {
    const hw1 = getConsistentHardware("user@gmail.com");
    const hw2 = getConsistentHardware("user@yahoo.com");
    expect(hw1).not.toEqual(hw2);
  });

  it("is case-insensitive", () => {
    const hw1 = getConsistentHardware("Test@Example.COM");
    const hw2 = getConsistentHardware("test@example.com");
    expect(hw1).toEqual(hw2);
  });

  it("ignores whitespace", () => {
    const hw1 = getConsistentHardware("  test@example.com  ");
    const hw2 = getConsistentHardware("test@example.com");
    expect(hw1).toEqual(hw2);
  });

  it("returns valid hardware profile structure", () => {
    const hw = getConsistentHardware("test@example.com");
    expect(hw).toHaveProperty("cores");
    expect(hw).toHaveProperty("memory");
    expect(hw).toHaveProperty("gpu");
    expect(hw.gpu).toHaveProperty("vendor");
    expect(hw.gpu).toHaveProperty("renderer");
  });

  it("returns valid cores and memory values", () => {
    const hw = getConsistentHardware("test@example.com");
    expect(hw.cores).toBeGreaterThanOrEqual(4);
    expect(hw.cores).toBeLessThanOrEqual(16);
    expect(hw.memory).toBeGreaterThanOrEqual(8);
    expect(hw.memory).toBeLessThanOrEqual(32);
  });

  it("logs hardware profile when logFn provided", () => {
    const logs: string[] = [];
    getConsistentHardwareWithLog("test@example.com", (msg) => logs.push(msg));
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("Hardware determinism");
  });

  it("logs hardware profile when os and logFn provided", () => {
    const logs: string[] = [];
    getConsistentHardwareWithLog("test@example.com", "macos", (msg) => logs.push(msg));
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("Hardware determinism");
  });

  it("generates valid hardware args", () => {
    const hw = getConsistentHardware("test@example.com");
    const args = getHardwareArgs(hw);
    expect(args).toBeInstanceOf(Array);
    expect(args.length).toBeGreaterThan(0);
    expect(args[0]).toMatch(/^--use-angle/);
  });

  it("generates correct args for NVIDIA hardware", () => {
    const hw: HardwareProfile = {
      cores: 8,
      memory: 16,
      gpu: { vendor: "NVIDIA", renderer: "GeForce GTX 1650" },
    };
    expect(getHardwareArgs(hw)[0]).toBe("--use-angle=opengl");
  });

  it("generates correct args for AMD hardware", () => {
    const hw: HardwareProfile = {
      cores: 12,
      memory: 32,
      gpu: { vendor: "AMD", renderer: "Radeon RX 6600" },
    };
    expect(getHardwareArgs(hw)[0]).toBe("--use-angle=vulkan");
  });

  it("generates correct args for Intel hardware", () => {
    const hw: HardwareProfile = {
      cores: 4,
      memory: 8,
      gpu: { vendor: "Intel", renderer: "UHD Graphics 630" },
    };
    expect(getHardwareArgs(hw)[0]).toBe("--use-angle=d3d11");
  });

  it("generates correct args for Apple hardware", () => {
    const hw: HardwareProfile = {
      cores: 8, memory: 8,
      gpu: { vendor: "Apple", renderer: "Apple M1" },
    };
    expect(getHardwareArgs(hw)[0]).toBe("--use-angle=metal");
  });

  it("generates correct args for Android hardware", () => {
    const hw: HardwareProfile = {
      cores: 8, memory: 8,
      gpu: { vendor: "Qualcomm", renderer: "Adreno" },
    };
    expect(getHardwareArgs(hw)[0]).toBe("--use-angle=opengl");
  });

  it("generates navigator overrides with correct values", () => {
    const hw = getConsistentHardware("test@example.com");
    const nav = getNavigatorOverrides(hw);
    expect(nav.hardwareConcurrency).toBe(hw.cores);
    expect(nav.deviceMemory).toBe(hw.memory);
  });

  it("distributes emails across multiple presets", () => {
    const emails = Array.from({ length: 100 }, (_, i) => `user${i}@domain${i}.com`);
    const profiles = emails.map((e) => getConsistentHardware(e));
    const unique = new Set(profiles.map((p) => JSON.stringify(p)));
    expect(unique.size).toBeGreaterThan(4);
  });

  describe("OS-aware GPU alignment", () => {
    // 200 distinct domains so the modulo-keyed pool selection has every chance
    // of producing a renderer that violates the OS constraint if the OS arg
    // were being ignored.
    const SAMPLE = Array.from({ length: 200 }, (_, i) => `user${i}@dom${i}.test`);

    it("macOS pool never returns an NVIDIA renderer", () => {
      const offenders = SAMPLE
        .map((e) => getConsistentHardware(e, "macos"))
        .filter((hw) => hw.gpu.vendor === "NVIDIA" || /RTX|GeForce/i.test(hw.gpu.renderer));
      expect(offenders).toEqual([]);
    });

    it("macOS pool only emits Apple / Intel / AMD vendors", () => {
      const allowed = new Set(["Apple", "Intel", "AMD"]);
      for (const e of SAMPLE) {
        const hw = getConsistentHardware(e, "macos");
        expect(allowed.has(hw.gpu.vendor)).toBe(true);
      }
    });

    it("Windows pool can return NVIDIA and matches the legacy combined pool", () => {
      const winVendors = new Set(SAMPLE.map((e) => getConsistentHardware(e, "windows").gpu.vendor));
      // Windows preset list is the same 8-entry table used before the split,
      // so every legacy vendor still appears for a large enough sample.
      expect(winVendors.has("NVIDIA")).toBe(true);
      expect(winVendors.has("Intel")).toBe(true);
      expect(winVendors.has("AMD")).toBe(true);
    });

    it("falls back to the Windows pool when os is omitted (backward compat)", () => {
      const a = getConsistentHardware("user@example.com");
      const b = getConsistentHardware("user@example.com", "windows");
      expect(a).toEqual(b);
    });

    it("same email yields different hardware when the OS differs", () => {
      // The OS-keyed split is the whole point: a credential running with a
      // macOS UA must NOT inherit its Windows-pool RTX renderer.
      const win = getConsistentHardware("collision@example.com", "windows");
      const mac = getConsistentHardware("collision@example.com", "macos");
      expect(win).not.toEqual(mac);
    });
  });
});

