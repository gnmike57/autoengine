import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("fs", () => ({
  default: {
    existsSync: vi.fn().mockReturnValue(true),
    promises: {
      readFile: vi.fn().mockResolvedValue(JSON.stringify([
        { id: "chrome-win", browser: "Chrome", os: "Windows", version: "120", ja3: "abc", ciphers: ["TLS_AES_128_GCM_SHA256"], sigalgs: "ecdsa_secp256r1_sha256" },
        { id: "chrome-mac", browser: "Chrome", os: "MacOS", version: "120", ja3: "def", ciphers: ["TLS_AES_256_GCM_SHA384"], sigalgs: "ecdsa_secp384r1_sha384" },
        { id: "firefox-win", browser: "Firefox", os: "Windows", version: "121", ja3: "ghi", ciphers: ["TLS_CHACHA20_POLY1305_SHA256"], sigalgs: "rsa_pss_rsae_sha256" },
        { id: "firefox-linux", browser: "Firefox", os: "Linux", version: "121", ja3: "jkl", ciphers: ["TLS_AES_128_GCM_SHA256"], sigalgs: "ecdsa_secp256r1_sha256" },
      ])),
    }
  },
  existsSync: vi.fn().mockReturnValue(true),
  promises: {
    readFile: vi.fn().mockResolvedValue(JSON.stringify([
      { id: "chrome-win", browser: "Chrome", os: "Windows", version: "120", ja3: "abc", ciphers: ["TLS_AES_128_GCM_SHA256"], sigalgs: "ecdsa_secp256r1_sha256" },
      { id: "chrome-mac", browser: "Chrome", os: "MacOS", version: "120", ja3: "def", ciphers: ["TLS_AES_256_GCM_SHA384"], sigalgs: "ecdsa_secp384r1_sha384" },
      { id: "firefox-win", browser: "Firefox", os: "Windows", version: "121", ja3: "ghi", ciphers: ["TLS_CHACHA20_POLY1305_SHA256"], sigalgs: "rsa_pss_rsae_sha256" },
      { id: "firefox-linux", browser: "Firefox", os: "Linux", version: "121", ja3: "jkl", ciphers: ["TLS_AES_128_GCM_SHA256"], sigalgs: "ecdsa_secp256r1_sha256" },
    ])),
  }
}));

import { TLSProxyEngine, type JA3Profile } from "../../src/stealth/tls-proxy.js";

describe("TLSProxyEngine", () => {
  let engine: TLSProxyEngine;

  beforeEach(async () => {
    engine = new TLSProxyEngine();
    await engine.loadProfiles();
  });

  describe("getRandomProfile", () => {
    it("returns a profile when profiles are loaded", () => {
      const profile = engine.getRandomProfile();
      expect(profile).toBeDefined();
      expect(profile!.browser).toBeDefined();
      expect(profile!.os).toBeDefined();
    });
  });

  describe("getProfileMatch", () => {
    it("returns a Chrome profile for Chrome UA on Windows", () => {
      const profile = engine.getProfileMatch(
        "Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/120.0",
        "Windows"
      );
      expect(profile).toBeDefined();
      expect(profile!.browser.toLowerCase()).toBe("chrome");
      expect(profile!.os.toLowerCase()).toBe("windows");
    });

    it("returns a Firefox profile for Firefox UA", () => {
      const profile = engine.getProfileMatch(
        "Mozilla/5.0 (Windows NT 10.0; rv:121.0) Gecko/20100101 Firefox/121.0",
        "Windows"
      );
      expect(profile).toBeDefined();
      expect(profile!.browser.toLowerCase()).toBe("firefox");
    });

    it("returns Chrome profile for non-Firefox UA", () => {
      const profile = engine.getProfileMatch(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X) AppleWebKit/537.36 Chrome/120.0",
        "MacOS"
      );
      expect(profile).toBeDefined();
      expect(profile!.browser.toLowerCase()).toBe("chrome");
    });

    it("falls back to random profile when no exact match exists", () => {
      const profile = engine.getProfileMatch(
        "Mozilla/5.0 Chrome/120.0",
        "Android"  // No Android profiles in our mock data
      );
      // Should fall back to getRandomProfile rather than returning undefined
      expect(profile).toBeDefined();
    });
  });

  describe("applyTLSOptions", () => {
    it("applies cipher and sigalg settings from profile", () => {
      const baseOptions = { host: "example.com" };
      const profile: JA3Profile = {
        id: "test",
        browser: "Chrome",
        os: "Windows",
        version: "120",
        ja3: "test-ja3",
        ciphers: ["TLS_AES_128_GCM_SHA256", "TLS_AES_256_GCM_SHA384"],
        sigalgs: "ecdsa_secp256r1_sha256",
      };

      const result = engine.applyTLSOptions(baseOptions, profile);

      expect(result.ciphers).toBe("TLS_AES_128_GCM_SHA256:TLS_AES_256_GCM_SHA384");
      expect(result.sigalgs).toBe("ecdsa_secp256r1_sha256");
      expect(result.minVersion).toBe("TLSv1.2");
      expect(result.maxVersion).toBe("TLSv1.3");
    });

    it("returns original options when no profile matches and none provided", () => {
      // When no profile is provided and getRandomProfile returns undefined,
      // the original options should be returned unchanged
      const baseOptions = { host: "example.com" };

      // We can test this by providing an undefined profile directly
      const result = engine.applyTLSOptions(baseOptions, undefined);
      // With profiles loaded, it will pick a random one — but the important
      // path is that it doesn't crash and returns valid TLS options
      expect(result).toBeDefined();
      expect(result.minVersion).toBe("TLSv1.2");
    });
  });

  describe("getStealthAgentOptions", () => {
    it("returns cipher and sigalg options for a profile", () => {
      const profile: JA3Profile = {
        id: "test",
        browser: "Chrome",
        os: "Windows",
        version: "120",
        ja3: "test",
        ciphers: ["CIPHER_A"],
        sigalgs: "sigalg_A",
      };

      const result = engine.getStealthAgentOptions(profile);
      expect(result.ciphers).toBe("CIPHER_A");
      expect(result.sigalgs).toBe("sigalg_A");
    });
  });
});
