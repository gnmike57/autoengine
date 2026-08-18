import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("socks-proxy-agent", () => ({
  SocksProxyAgent: vi.fn(function MockSocksProxyAgent(this: { url?: string }, url: string) {
    this.url = url;
  }),
}));

vi.mock("https-proxy-agent", () => ({
  HttpsProxyAgent: vi.fn(function MockHttpsProxyAgent(this: { url?: string }, url: string) {
    this.url = url;
  }),
}));

import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";
import { createOpenRouterProxyAgent } from "../../src/intelligence/llm-provider.js";

describe("OpenRouter proxy transport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.OPENROUTER_PROXY_URL;
    delete process.env.OPENROUTER_REQUIRE_PROXY;
  });

  afterEach(() => {
    delete process.env.OPENROUTER_PROXY_URL;
    delete process.env.OPENROUTER_REQUIRE_PROXY;
  });

  it("uses a SOCKS agent for socks5 URLs", () => {
    const url = "socks5://user:password@127.0.0.1:1080";
    const agent = createOpenRouterProxyAgent(url);
    expect(agent).toBeDefined();
    expect(SocksProxyAgent).toHaveBeenCalledWith(url);
    expect(HttpsProxyAgent).not.toHaveBeenCalled();
  });

  it("uses an HTTPS proxy agent for HTTP and HTTPS proxy URLs", () => {
    const httpUrl = "http://user:password@127.0.0.1:8080";
    const httpsUrl = "https://user:password@127.0.0.1:8443";
    expect(createOpenRouterProxyAgent(httpUrl)).toBeDefined();
    expect(createOpenRouterProxyAgent(httpsUrl)).toBeDefined();
    expect(HttpsProxyAgent).toHaveBeenNthCalledWith(1, httpUrl);
    expect(HttpsProxyAgent).toHaveBeenNthCalledWith(2, httpsUrl);
    expect(SocksProxyAgent).not.toHaveBeenCalled();
  });

  it("allows no proxy only when fail-closed mode is not enabled", () => {
    expect(createOpenRouterProxyAgent("")).toBeUndefined();
  });

  it("fails closed when a proxy is required but missing", () => {
    process.env.OPENROUTER_REQUIRE_PROXY = "true";
    expect(() => createOpenRouterProxyAgent("")).toThrow(/proxy is required/i);
  });

  it("rejects unsupported proxy protocols", () => {
    expect(() => createOpenRouterProxyAgent("ftp://127.0.0.1:21")).toThrow(/unsupported/i);
  });
});
