/* eslint-disable @typescript-eslint/no-unused-vars */
/**
 * Proxy URL Parsing Fuzzing Tests
 *
 * Feeds malformed, edge-case, and adversarial proxy URL strings through
 * the proxy validation pipeline to find URL-parsing bugs, crashes, and
 * silent failures.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("node-fetch", () => ({
  default: vi.fn().mockRejectedValue(new Error("network disabled in tests")),
}));

import { validateProxyIP, type ProxyValidationResult } from "../../src/proxy/proxy-validator.js";
import { type ProxyEntry } from "../../backends/index.js";

function makeProxy(overrides: Partial<ProxyEntry> = {}): ProxyEntry {
  return {
    server: "http://1.2.3.4:8080",
    protocol: "http",
    username: "",
    password: "",
    region: "US",
    ...overrides,
  } as ProxyEntry;
}

describe("proxy URL parsing fuzzing", () => {
  describe("well-formed URLs", () => {
    it("handles standard HTTP proxy", async () => {
      const result = await validateProxyIP(makeProxy({
        server: "http://1.2.3.4:8080",
        protocol: "http",
      }));
      // Will fail because we mocked fetch, but should NOT crash
      expect(result.valid).toBe(false);
      expect(result.error).toBeDefined();
    });

    it("handles SOCKS5 proxy", async () => {
      const result = await validateProxyIP(makeProxy({
        server: "socks5://5.6.7.8:1080",
        protocol: "socks5",
      }));
      expect(result.valid).toBe(false); // fetch is mocked
    });

    it("handles proxy with credentials", async () => {
      const result = await validateProxyIP(makeProxy({
        server: "http://1.2.3.4:8080",
        protocol: "http",
        username: "user",
        password: "pass",
      }));
      expect(result.valid).toBe(false);
    });
  });

  describe("edge-case URLs — must not crash", () => {
    it("handles empty server string", async () => {
      const result = await validateProxyIP(makeProxy({ server: "" }));
      expect(result.valid).toBe(false);
    });

    it("handles server with no port", async () => {
      const result = await validateProxyIP(makeProxy({ server: "http://1.2.3.4" }));
      expect(result.valid).toBe(false);
    });

    it("handles server with trailing slash", async () => {
      const result = await validateProxyIP(makeProxy({ server: "http://1.2.3.4:8080/" }));
      expect(result.valid).toBe(false);
    });

    it("handles server with path", async () => {
      const result = await validateProxyIP(makeProxy({ server: "http://1.2.3.4:8080/proxy" }));
      expect(result.valid).toBe(false);
    });

    it("handles IPv6 address", async () => {
      const result = await validateProxyIP(makeProxy({ server: "http://[::1]:8080" }));
      expect(result.valid).toBe(false);
    });

    it("handles hostname instead of IP", async () => {
      const result = await validateProxyIP(makeProxy({ server: "http://proxy.example.com:8080" }));
      expect(result.valid).toBe(false);
    });
  });

  describe("adversarial inputs — must not crash or hang", () => {
    it("handles password with @ symbol", async () => {
      const result = await validateProxyIP(makeProxy({
        server: "http://1.2.3.4:8080",
        protocol: "http",
        username: "user",
        password: "p@ss",
      }));
      expect(result.valid).toBe(false);
    });

    it("handles password with special chars", async () => {
      const result = await validateProxyIP(makeProxy({
        server: "http://1.2.3.4:8080",
        protocol: "http",
        username: "user",
        password: "p@ss:w0rd#$%^&*()",
      }));
      expect(result.valid).toBe(false);
    });

    it("handles unicode in username", async () => {
      const result = await validateProxyIP(makeProxy({
        server: "http://1.2.3.4:8080",
        protocol: "http",
        username: "üser",
        password: "pass",
      }));
      expect(result.valid).toBe(false);
    });

    it("handles very long server string", async () => {
      const longServer = "http://" + "a".repeat(1000) + ":8080";
      const result = await validateProxyIP(makeProxy({ server: longServer }));
      expect(result.valid).toBe(false);
    });

    it("handles null-byte in server", async () => {
      const result = await validateProxyIP(makeProxy({ server: "http://1.2.3.4\x00:8080" }));
      expect(result.valid).toBe(false);
    });

    it("handles server with only protocol", async () => {
      const result = await validateProxyIP(makeProxy({ server: "http://" }));
      expect(result.valid).toBe(false);
    });

    it("handles double-protocol prefix", async () => {
      const result = await validateProxyIP(makeProxy({ server: "http://http://1.2.3.4:8080" }));
      expect(result.valid).toBe(false);
    });
  });

  describe("timeout behavior", () => {
    it("respects very short timeout without hanging", async () => {
      const result = await validateProxyIP(
        makeProxy({ server: "http://1.2.3.4:8080" }),
        1, // 1ms timeout
      );
      expect(result.valid).toBe(false);
    });
  });
});
