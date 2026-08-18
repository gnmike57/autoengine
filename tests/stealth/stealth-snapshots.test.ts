/**
 * Stealth Script Snapshot Tests
 *
 * Captures the output of every get*SpoofScript() function for a fixed
 * seed and verifies it produces valid JavaScript that doesn't change
 * across releases. Catches silent drift in injected fingerprint code.
 */
import { describe, it, expect } from "vitest";
import {
  getClientHintsAlignmentScript,
  getFontMetricSpoofScript,
  getAudioContextSpoofScript,
  getWebdriverOverrideScript,
  getAutofillSimulationScript,
  getTimezoneAlignmentScript,
  getWebGLSpoofScript,
  getCanvasSpoofScript,
  getHardwareSpoofScript,
  getPluginsSpoofScript,
  getWebRTCSpoofScript,
} from "../../src/stealth/stealth-scripts.js";

const FIXED_SEED = 42;
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
const FIXED_HINTS = {
  os: "windows" as const,
  architecture: "x64",
  chromeMajor: 120,
  chromeVersion: "120.0.6099.216",
  platformVersion: "10.0.0",
// eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;

describe("stealth-scripts (snapshot stability)", () => {
  describe("output stability — same seed always produces same script", () => {
    it("getClientHintsAlignmentScript is stable", () => {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
      const first = getClientHintsAlignmentScript(FIXED_HINTS);
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
      const second = getClientHintsAlignmentScript(FIXED_HINTS);
      expect(first).toBe(second);
    });

    it("getFontMetricSpoofScript is stable for same (os, seed)", () => {
      const first = getFontMetricSpoofScript("windows", FIXED_SEED);
      const second = getFontMetricSpoofScript("windows", FIXED_SEED);
      expect(first).toBe(second);
    });

    it("getAudioContextSpoofScript is stable for same seed", () => {
      const first = getAudioContextSpoofScript(FIXED_SEED);
      const second = getAudioContextSpoofScript(FIXED_SEED);
      expect(first).toBe(second);
    });

    it("getWebdriverOverrideScript is stable (no args)", () => {
      const first = getWebdriverOverrideScript();
      const second = getWebdriverOverrideScript();
      expect(first).toBe(second);
    });

    it("getAutofillSimulationScript is stable (no args)", () => {
      const first = getAutofillSimulationScript();
      const second = getAutofillSimulationScript();
      expect(first).toBe(second);
    });

    it("getTimezoneAlignmentScript is stable for same timezone", () => {
      const first = getTimezoneAlignmentScript("America/New_York");
      const second = getTimezoneAlignmentScript("America/New_York");
      expect(first).toBe(second);
    });

    it("getWebGLSpoofScript is stable for same (vendor, renderer)", () => {
      const first = getWebGLSpoofScript("NVIDIA", "GeForce RTX 3060");
      const second = getWebGLSpoofScript("NVIDIA", "GeForce RTX 3060");
      expect(first).toBe(second);
    });

    it("getCanvasSpoofScript is stable for same seed", () => {
      const first = getCanvasSpoofScript(FIXED_SEED);
      const second = getCanvasSpoofScript(FIXED_SEED);
      expect(first).toBe(second);
    });

    it("getHardwareSpoofScript is stable for same seed", () => {
      const first = getHardwareSpoofScript(FIXED_SEED);
      const second = getHardwareSpoofScript(FIXED_SEED);
      expect(first).toBe(second);
    });

    it("getPluginsSpoofScript is stable", () => {
      const first = getPluginsSpoofScript();
      const second = getPluginsSpoofScript();
      expect(first).toBe(second);
    });

    it("getWebRTCSpoofScript is stable", () => {
      const first = getWebRTCSpoofScript();
      const second = getWebRTCSpoofScript();
      expect(first).toBe(second);
    });
  });

  describe("output validity — all scripts produce parseable JavaScript", () => {
    it("getClientHintsAlignmentScript produces valid JS", () => {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
      const script = getClientHintsAlignmentScript(FIXED_HINTS);
      expect(() => new Function(script)).not.toThrow();
    });

    it("getFontMetricSpoofScript produces valid JS", () => {
      const script = getFontMetricSpoofScript("windows", FIXED_SEED);
      expect(() => new Function(script)).not.toThrow();
    });

    it("getAudioContextSpoofScript produces valid JS", () => {
      const script = getAudioContextSpoofScript(FIXED_SEED);
      expect(() => new Function(script)).not.toThrow();
    });

    it("getWebdriverOverrideScript produces valid JS", () => {
      const script = getWebdriverOverrideScript();
      expect(() => new Function(script)).not.toThrow();
    });

    it("getAutofillSimulationScript produces valid JS", () => {
      const script = getAutofillSimulationScript();
      expect(() => new Function(script)).not.toThrow();
    });

    it("getWebGLSpoofScript produces valid JS", () => {
      const script = getWebGLSpoofScript("Intel", "UHD Graphics 630");
      expect(() => new Function(script)).not.toThrow();
    });

    it("getCanvasSpoofScript produces valid JS", () => {
      const script = getCanvasSpoofScript(FIXED_SEED);
      expect(() => new Function(script)).not.toThrow();
    });

    it("getHardwareSpoofScript produces valid JS", () => {
      const script = getHardwareSpoofScript(FIXED_SEED);
      expect(() => new Function(script)).not.toThrow();
    });

    it("getPluginsSpoofScript produces valid JS", () => {
      const script = getPluginsSpoofScript();
      expect(() => new Function(script)).not.toThrow();
    });

    it("getWebRTCSpoofScript produces valid JS", () => {
      const script = getWebRTCSpoofScript();
      expect(() => new Function(script)).not.toThrow();
    });
  });

  describe("differentiation — different seeds produce different scripts", () => {
    it("different seeds yield different font metric scripts", () => {
      const a = getFontMetricSpoofScript("windows", 1);
      const b = getFontMetricSpoofScript("windows", 2);
      expect(a).not.toBe(b);
    });

    it("different seeds yield different audio context scripts", () => {
      const a = getAudioContextSpoofScript(1);
      const b = getAudioContextSpoofScript(2);
      expect(a).not.toBe(b);
    });

    it("different seeds yield different canvas scripts", () => {
      const a = getCanvasSpoofScript(1);
      const b = getCanvasSpoofScript(2);
      expect(a).not.toBe(b);
    });

    it("different vendors yield different WebGL scripts", () => {
      const a = getWebGLSpoofScript("Intel", "UHD 630");
      const b = getWebGLSpoofScript("NVIDIA", "RTX 3060");
      expect(a).not.toBe(b);
    });
  });

  describe("content correctness", () => {
    it("webdriver override contains 'webdriver' property override", () => {
      const script = getWebdriverOverrideScript();
      expect(script).toContain("webdriver");
    });

    it("client hints contain expected chrome version", () => {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
      const script = getClientHintsAlignmentScript(FIXED_HINTS);
      expect(script).toContain("120");
    });

    it("hardware spoof contains hardwareConcurrency override", () => {
      const script = getHardwareSpoofScript(FIXED_SEED);
      expect(script).toContain("hardwareConcurrency");
    });

    it("WebRTC spoof contains RTCPeerConnection override", () => {
      const script = getWebRTCSpoofScript();
      expect(script).toContain("RTCPeerConnection");
    });
  });
});
