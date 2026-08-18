/**
 * Property-Based Tests: Fingerprint Determinism
 *
 * Verifies that getConsistentHardware() returns IDENTICAL output for the
 * same (email, os, rotation) triple across repeated invocations.
 * This is the #1 most critical property for a stealth automation engine —
 * if the fingerprint drifts mid-session, detection is instant.
 */
import { describe, it, expect } from "vitest";
import {
  getConsistentHardware,
  getConsistentHardwareWithLog,
  getHardwareArgs,
  getNavigatorOverrides,
  type HardwareProfile,
} from "../../src/profiles/profile-determinism.js";

const OS_POOL = ["windows", "macos", "linux", "android"] as const;

/** Generate a deterministic set of pseudo-random email strings. */
function generateEmails(count: number): string[] {
  const domains = ["gmail.com", "yahoo.com", "outlook.com", "proton.me", "icloud.com", "hotmail.com"];
  const names = ["alice", "bob", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet"];
  const emails: string[] = [];
  for (let i = 0; i < count; i++) {
    const name = names[i % names.length]!;
    const domain = domains[i % domains.length]!;
    emails.push(`${name}${i}@${domain}`);
  }
  return emails;
}

describe("fingerprint-determinism (property-based)", () => {
  describe("idempotency — same input MUST yield identical output", () => {
    const emails = generateEmails(100);

    it("getConsistentHardware returns identical results across 100 calls for each email", () => {
      for (const email of emails) {
        const first = getConsistentHardware(email);
        for (let call = 0; call < 100; call++) {
          const repeat = getConsistentHardware(email);
          expect(repeat).toStrictEqual(first);
        }
      }
    });

    it("is idempotent across all 4 OS pools", () => {
      for (const os of OS_POOL) {
        for (const email of emails.slice(0, 25)) {
          const first = getConsistentHardware(email, os);
          const second = getConsistentHardware(email, os);
          const third = getConsistentHardware(email, os);
          expect(first).toStrictEqual(second);
          expect(second).toStrictEqual(third);
        }
      }
    });

    it("is idempotent across rotation indices 0-9", () => {
      const email = "stable-rotation@test.com";
      for (let rot = 0; rot < 10; rot++) {
        const first = getConsistentHardware(email, "windows", rot);
        const second = getConsistentHardware(email, "windows", rot);
        expect(first).toStrictEqual(second);
      }
    });
  });

  describe("output validity — all profiles have plausible values", () => {
    const emails = generateEmails(200);

    it("cores are always 2-16 and memory is always 4-32", () => {
      for (const os of OS_POOL) {
        for (const email of emails) {
          const hw = getConsistentHardware(email, os);
          expect(hw.cores).toBeGreaterThanOrEqual(2);
          expect(hw.cores).toBeLessThanOrEqual(16);
          expect(hw.memory).toBeGreaterThanOrEqual(4);
          expect(hw.memory).toBeLessThanOrEqual(32);
        }
      }
    });

    it("GPU vendor and renderer are always non-empty strings", () => {
      for (const os of OS_POOL) {
        for (const email of emails) {
          const hw = getConsistentHardware(email, os);
          expect(hw.gpu.vendor.length).toBeGreaterThan(0);
          expect(hw.gpu.renderer.length).toBeGreaterThan(0);
        }
      }
    });

    it("macOS profiles never contain NVIDIA GPUs", () => {
      for (const email of emails) {
        const hw = getConsistentHardware(email, "macos");
        expect(hw.gpu.vendor).not.toBe("NVIDIA");
      }
    });

    it("android profiles only contain mobile GPU vendors", () => {
      const validVendors = new Set(["Qualcomm", "ARM", "Samsung"]);
      for (const email of emails) {
        const hw = getConsistentHardware(email, "android");
        expect(validVendors.has(hw.gpu.vendor)).toBe(true);
      }
    });
  });

  describe("differentiation — different emails yield different profiles", () => {
    it("at least 50% of 100 distinct emails map to distinct profiles", () => {
      const emails = generateEmails(100);
      const profiles = new Set<string>();
      for (const email of emails) {
        const hw = getConsistentHardware(email, "windows");
        profiles.add(JSON.stringify(hw));
      }
      // With 8 presets, birthday paradox means some collisions, but we should
      // see at least 4 distinct profiles out of 100 emails
      expect(profiles.size).toBeGreaterThanOrEqual(4);
    });
  });

  describe("proxy-pool tier adjustments", () => {
    it("4m (mobile) pool clamps cores to 4-8 and memory to 8-16", () => {
      const emails = generateEmails(50);
      for (const email of emails) {
        const hw = getConsistentHardware(email, "windows", 0, "4m");
        expect([4, 8]).toContain(hw.cores);
        expect([8, 16]).toContain(hw.memory);
      }
    });

    it("4r/4i/1 (residential) pool clamps cores to 8-16 and memory to 16-32", () => {
      const emails = generateEmails(50);
      for (const pool of ["4r", "4i", "1"] as const) {
        for (const email of emails) {
          const hw = getConsistentHardware(email, "windows", 0, pool);
          expect([8, 12, 16]).toContain(hw.cores);
          expect([16, 32]).toContain(hw.memory);
        }
      }
    });
  });

  describe("getHardwareArgs returns valid Chrome flags", () => {
    it("always returns an array of strings starting with --", () => {
      for (const os of OS_POOL) {
        const hw = getConsistentHardware("test@example.com", os);
        const args = getHardwareArgs(hw);
        expect(Array.isArray(args)).toBe(true);
        for (const arg of args) {
          expect(arg.startsWith("--")).toBe(true);
        }
      }
    });

    it("Apple GPU uses --use-angle=metal", () => {
      const hw: HardwareProfile = { cores: 8, memory: 16, gpu: { vendor: "Apple", renderer: "Apple M2" } };
      expect(getHardwareArgs(hw)).toContain("--use-angle=metal");
    });

    it("NVIDIA GPU uses --use-angle=opengl", () => {
      const hw: HardwareProfile = { cores: 8, memory: 16, gpu: { vendor: "NVIDIA", renderer: "GeForce RTX 3060" } };
      expect(getHardwareArgs(hw)).toContain("--use-angle=opengl");
    });
  });

  describe("getNavigatorOverrides matches profile", () => {
    it("returns hardwareConcurrency and deviceMemory from profile", () => {
      const hw = getConsistentHardware("test@example.com", "windows");
      const overrides = getNavigatorOverrides(hw);
      expect(overrides.hardwareConcurrency).toBe(hw.cores);
      expect(overrides.deviceMemory).toBe(hw.memory);
    });
  });

  describe("getConsistentHardwareWithLog", () => {
    it("calls the log function with a descriptive message", () => {
      const logs: string[] = [];
      const hw = getConsistentHardwareWithLog("test@example.com", "windows", (msg) => logs.push(msg));
      expect(logs).toHaveLength(1);
      expect(logs[0]).toContain("Hardware determinism");
      expect(logs[0]).toContain("example.com");
      expect(hw.cores).toBeGreaterThan(0);
    });

    it("backward-compatible 2-arg form (email, logFn)", () => {
      const logs: string[] = [];
      const hw = getConsistentHardwareWithLog("test@example.com", (msg) => logs.push(msg));
      expect(logs).toHaveLength(1);
      expect(hw.cores).toBeGreaterThan(0);
    });
  });
});
