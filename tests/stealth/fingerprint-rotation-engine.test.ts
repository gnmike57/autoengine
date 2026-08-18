import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  FingerprintRotationEngine,
  _resetRotationEngine,
  getRotationEngine,
} from "../../src/stealth/fingerprint-rotation-engine.js";

const TEST_LEDGER = path.join(import.meta.dirname ?? ".", "__test_rotation_ledger.json");

function cleanup() {
  try { fs.unlinkSync(TEST_LEDGER); } catch { /* ignore */ }
  _resetRotationEngine();
}

describe("FingerprintRotationEngine", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it("starts at rotation 0 for new credentials", () => {
    const engine = new FingerprintRotationEngine({ ledgerPath: TEST_LEDGER });
    expect(engine.getRotation("test@example.com")).toBe(0);
  });

  it("increments rotation after sessionsPerRotation sessions", () => {
    const engine = new FingerprintRotationEngine({
      ledgerPath: TEST_LEDGER,
      sessionsPerRotation: 3,
    });

    expect(engine.recordSession("a@b.com")).toBe(0); // session 1
    expect(engine.recordSession("a@b.com")).toBe(0); // session 2
    expect(engine.recordSession("a@b.com")).toBe(1); // session 3 → rotates
    expect(engine.recordSession("a@b.com")).toBe(1); // session 4 (new cycle)
  });

  it("tracks separate rotation per credential", () => {
    const engine = new FingerprintRotationEngine({
      ledgerPath: TEST_LEDGER,
      sessionsPerRotation: 2,
    });

    engine.recordSession("a@test.com");
    engine.recordSession("a@test.com"); // rotates to 1
    engine.recordSession("b@test.com"); // still at 0

    expect(engine.getRotation("a@test.com")).toBe(1);
    expect(engine.getRotation("b@test.com")).toBe(0);
  });

  it("forceRotation sets a specific rotation value", () => {
    const engine = new FingerprintRotationEngine({ ledgerPath: TEST_LEDGER });
    engine.forceRotation("c@d.com", 5);
    expect(engine.getRotation("c@d.com")).toBe(5);
  });

  it("resetRotation returns credential to rotation 0", () => {
    const engine = new FingerprintRotationEngine({
      ledgerPath: TEST_LEDGER,
      sessionsPerRotation: 1,
    });

    engine.recordSession("e@f.com"); // rotates to 1
    expect(engine.getRotation("e@f.com")).toBe(1);
    engine.resetRotation("e@f.com");
    expect(engine.getRotation("e@f.com")).toBe(0);
  });

  it("persists ledger to disk and reloads", () => {
    const engine1 = new FingerprintRotationEngine({
      ledgerPath: TEST_LEDGER,
      sessionsPerRotation: 1,
    });
    engine1.recordSession("persist@test.com");
    expect(engine1.getRotation("persist@test.com")).toBe(1);
    engine1.flush(); // Force immediate persist (bypasses debounce)

    // Create new engine from same file
    const engine2 = new FingerprintRotationEngine({ ledgerPath: TEST_LEDGER });
    expect(engine2.getRotation("persist@test.com")).toBe(1);
  });

  it("buildRotatedProfile returns a complete profile bundle", () => {
    const engine = new FingerprintRotationEngine({ ledgerPath: TEST_LEDGER });
    const profile = engine.buildRotatedProfile("test@example.com");

    expect(profile.email).toBe("test@example.com");
    expect(profile.rotation).toBe(0);
    expect(profile.seed).toBeGreaterThan(0);
    expect(profile.ua).toBeDefined();
    expect(profile.ua.chromeMajor).toBeGreaterThan(0);
    expect(profile.hardware).toBeDefined();
    expect(profile.hardware.cores).toBeGreaterThan(0);
    expect(profile.geo).toBeDefined();
    expect(profile.resolution).toBeDefined();
    expect(profile.fonts).toBeDefined();
    expect(profile.cache).toBeDefined();
  });

  it("snapshot returns all tracked credentials", () => {
    const engine = new FingerprintRotationEngine({ ledgerPath: TEST_LEDGER });
    engine.recordSession("x@y.com");
    engine.recordSession("z@w.com");
    const snap = engine.snapshot();
    expect(snap).toHaveLength(2);
    expect(snap.map(e => e.email)).toContain("x@y.com");
    expect(snap.map(e => e.email)).toContain("z@w.com");
  });

  it("getEntry returns undefined for unknown email", () => {
    const engine = new FingerprintRotationEngine({ ledgerPath: TEST_LEDGER });
    expect(engine.getEntry("unknown@nowhere.com")).toBeUndefined();
  });

  it("singleton factory works and can be reset", () => {
    _resetRotationEngine();
    const a = getRotationEngine({ ledgerPath: TEST_LEDGER });
    const b = getRotationEngine();
    expect(a).toBe(b);
    _resetRotationEngine();
    const c = getRotationEngine({ ledgerPath: TEST_LEDGER });
    expect(c).not.toBe(a);
  });

  it("is case-insensitive and trims whitespace", () => {
    const engine = new FingerprintRotationEngine({
      ledgerPath: TEST_LEDGER,
      sessionsPerRotation: 1,
    });
    engine.recordSession("  Test@Example.COM  ");
    expect(engine.getRotation("test@example.com")).toBe(1);
  });
});
