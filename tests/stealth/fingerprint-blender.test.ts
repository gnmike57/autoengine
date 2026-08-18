import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  FingerprintBlender,
  _resetBlender,
  getBlender,
  type SuccessfulProfile,
} from "../../src/stealth/fingerprint-blender.js";

const TEST_DB = path.join(import.meta.dirname ?? ".", "__test_successful_fps.json");

function cleanup() {
  try { fs.unlinkSync(TEST_DB); } catch { /* ignore */ }
  _resetBlender();
}

function makeProfile(email: string): SuccessfulProfile {
  return {
    email,
    timestamp: new Date().toISOString(),
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    ua: {
      userAgent: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36`,
      chromeMajor: 136,
      chromeVersion: "136.0.6778.100",
      os: "windows",
      windowsVersion: "10.0",
      windowsLabel: "Windows 10",
      platformVersion: "10.0.0",
      architecture: "x86",
      uaFullVersionList: [],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    hardware: {
      cores: 8,
      memory: 16,
      gpu: { vendor: "Intel", renderer: "UHD Graphics 750" },
    },
    geo: { countryCode: "AU", timezone: "Australia/Sydney", locale: "en-AU" },
    seed: 42000,
    backend: "cloak-headless",
  };
}

describe("FingerprintBlender", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it("starts with zero profiles", () => {
    const blender = new FingerprintBlender({ dbPath: TEST_DB });
    expect(blender.size).toBe(0);
  });

  it("records a successful profile", () => {
    const blender = new FingerprintBlender({ dbPath: TEST_DB });
    blender.recordSuccess(makeProfile("a@test.com"));
    expect(blender.size).toBe(1);
  });

  it("returns undefined when not enough profiles to blend", () => {
    const blender = new FingerprintBlender({ dbPath: TEST_DB, sourceCount: 3 });
    blender.recordSuccess(makeProfile("a@test.com"));
    blender.recordSuccess(makeProfile("b@test.com"));
    expect(blender.blend("seed")).toBeUndefined();
  });

  it("blends when enough profiles are available", () => {
    const blender = new FingerprintBlender({ dbPath: TEST_DB, sourceCount: 3 });
    blender.recordSuccess(makeProfile("a@test.com"));
    blender.recordSuccess(makeProfile("b@test.com"));
    blender.recordSuccess(makeProfile("c@test.com"));

    const result = blender.blend("test-seed");
    expect(result).toBeDefined();
    expect(result!.ua).toBeDefined();
    expect(result!.hardware).toBeDefined();
    expect(result!.geo).toBeDefined();
    expect(result!.sources).toHaveLength(3);
  });

  it("blend is deterministic for same seed", () => {
    const blender = new FingerprintBlender({ dbPath: TEST_DB, sourceCount: 3 });
    for (let i = 0; i < 5; i++) blender.recordSuccess(makeProfile(`user${i}@test.com`));

    const r1 = blender.blend("same-seed");
    const r2 = blender.blend("same-seed");
    expect(r1!.sources).toEqual(r2!.sources);
  });

  it("clear removes all stored profiles", () => {
    const blender = new FingerprintBlender({ dbPath: TEST_DB });
    blender.recordSuccess(makeProfile("a@test.com"));
    blender.clear();
    expect(blender.size).toBe(0);
  });

  it("persists to disk and reloads", () => {
    const b1 = new FingerprintBlender({ dbPath: TEST_DB });
    b1.recordSuccess(makeProfile("persist@test.com"));

    const b2 = new FingerprintBlender({ dbPath: TEST_DB });
    expect(b2.size).toBe(1);
  });

  it("getAll returns a copy of stored profiles", () => {
    const blender = new FingerprintBlender({ dbPath: TEST_DB });
    blender.recordSuccess(makeProfile("a@test.com"));
    const all = blender.getAll();
    expect(all).toHaveLength(1);
    expect(all[0]!.email).toBe("a@test.com");
  });

  it("singleton factory works", () => {
    _resetBlender();
    const a = getBlender({ dbPath: TEST_DB });
    const b = getBlender();
    expect(a).toBe(b);
  });
});
