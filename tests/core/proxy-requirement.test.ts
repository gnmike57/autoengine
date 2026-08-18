import { describe, expect, it } from "vitest";
import {
  createSession,
  isSessionProxyBound,
  resolveProxyRequirement,
} from "../../backends/index.js";

describe("fail-closed proxy session contract", () => {
  it("requires a proxy whenever a numbered pool is configured", () => {
    expect(resolveProxyRequirement({ backend: "cloak-headless", proxyPool: "6" })).toEqual({
      required: true,
      managedByBackend: false,
      pool: "6",
    });
  });

  it("allows an intentionally disabled pool only when requireProxy is not forced", () => {
    expect(resolveProxyRequirement({ backend: "cloak-headless", proxyPool: "off" })).toEqual({
      required: false,
      managedByBackend: false,
      pool: "off",
    });
  });

  it("recognizes Spider-managed residential proxy mode", () => {
    expect(resolveProxyRequirement({ backend: "spider-cloud", proxyPool: "4r" })).toEqual({
      required: true,
      managedByBackend: true,
      pool: "4r",
    });
  });

  it("rejects direct or incomplete local-session proxy evidence", () => {
    const requirement = { required: true, managedByBackend: false, pool: "6" };
    expect(isSessionProxyBound({ proxyUsed: "DIRECT" }, requirement)).toBe(false);
    expect(isSessionProxyBound({ proxyUsed: "socks5://proxy.invalid:1080" }, requirement)).toBe(false);
    expect(isSessionProxyBound({ proxyKey: "proxy#session" }, requirement)).toBe(false);
    expect(isSessionProxyBound({ proxyUsed: "socks5://proxy.invalid:1080", proxyKey: "proxy#session" }, requirement)).toBe(true);
  });

  it("accepts only the explicit Spider-managed marker for a managed pool", () => {
    const requirement = { required: true, managedByBackend: true, pool: "4r" };
    expect(isSessionProxyBound({ proxyUsed: "spider-managed" }, requirement)).toBe(true);
    expect(isSessionProxyBound({ proxyUsed: "DIRECT" }, requirement)).toBe(false);
  });

  it("fails before browser launch when a forced proxy pool is disabled", async () => {
    await expect(createSession({
      backend: "cloak-headless",
      proxyPool: "off",
      requireProxy: true,
    })).rejects.toThrow("proxy-required-but-pool-disabled");
  });

  it("fails before browser launch when a required numbered pool has no usable entry", async () => {
    await expect(createSession({
      backend: "cloak-headless",
      proxyPool: "missing-proxy-requirement-test",
      requireProxy: true,
    })).rejects.toThrow("proxy-required-no-usable-entry:missing-proxy-requirement-test");
  });
});
