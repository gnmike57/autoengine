import { describe, it, expect, vi, beforeEach } from "vitest";
import { validateProxyIP, validateProxyPool } from "../../src/proxy/proxy-validator.js";
import { ProxyEntry } from "../../backends/index.js";

// Mock the dependencies
vi.mock("node-fetch", () => ({
  default: vi.fn()
}));

vi.mock("https-proxy-agent", () => ({
  HttpsProxyAgent: vi.fn()
}));

vi.mock("socks-proxy-agent", () => ({
  SocksProxyAgent: vi.fn()
}));

// Import mocked node-fetch to set up mock implementations
import fetch from "node-fetch";

describe("proxy-validator", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const httpProxy: ProxyEntry = {
    protocol: "http",
    server: "http://1.2.3.4:8080"
  };

  const socksProxy: ProxyEntry = {
    protocol: "socks5",
    server: "socks5://5.6.7.8:1080",
    username: "user1",
    password: "password1"
  };

  describe("validateProxyIP", () => {
    it("should return valid true and ip when fetch succeeds", async () => {
      // Mock fetch resolving with a successful response
       
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        // eslint-disable-next-line @typescript-eslint/require-await
        text: async () => " 1.2.3.4 "
      } as any);

      const result = await validateProxyIP(httpProxy);
      
      expect(result).toEqual({
        valid: true,
        ip: "1.2.3.4"
      });
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it("should return valid false and error when fetch returns non-ok status", async () => {
       
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: false,
        status: 403,
        statusText: "Forbidden"
      } as any);

      const result = await validateProxyIP(httpProxy);
      
      expect(result).toEqual({
        valid: false,
        error: "HTTP 403 Forbidden"
      });
    });

    it("should return valid false and error when fetch throws an error", async () => {
      vi.mocked(fetch).mockRejectedValueOnce(new Error("Connection timeout"));

      const result = await validateProxyIP(socksProxy);
      
      expect(result).toEqual({
        valid: false,
        error: "Connection timeout"
      });
    });

    it("should handle error without message property gracefully", async () => {
      vi.mocked(fetch).mockRejectedValueOnce("String error");

      const result = await validateProxyIP(socksProxy);
      
      expect(result).toEqual({
        valid: false,
        error: "String error"
      });
    });
  });

  describe("validateProxyPool", () => {
    it("should return an empty array if the pool is empty", async () => {
      const result = await validateProxyPool([]);
      expect(result).toEqual([]);
    });

    it("should return only valid proxies from the pool", async () => {
      // First proxy succeeds, second fails
      vi.mocked(fetch)
         
        .mockResolvedValueOnce({
          ok: true,
          // eslint-disable-next-line @typescript-eslint/require-await
          text: async () => "1.2.3.4"
        } as any)
        .mockRejectedValueOnce(new Error("Failed"));

      const pool = [httpProxy, socksProxy];
      
      const result = await validateProxyPool(pool);
      
      expect(result).toHaveLength(1);
      expect(result[0]).toBe(httpProxy);
    });
  });
});
