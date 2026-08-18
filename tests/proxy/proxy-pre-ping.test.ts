import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  pingTargetUrl,
  pingViaBackendStack,
  preValidatePool,
  preValidateProxy
} from "../../src/proxy/proxy-pre-ping.js";
import fetch from "node-fetch";
import net from "node:net";

vi.mock("node-fetch");
vi.mock("node:net");

vi.mock("../../backends/httpcloak-forwarder.js", () => ({
  startHttpCloakForwarder: vi.fn()
}));
vi.mock("../../src/proxy/proxy-forwarder.js", () => ({
  startProxyForwarder: vi.fn()
}));

describe("proxy-pre-ping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "debug").mockImplementation(() => {});
  });

  describe("pingTargetUrl", () => {
     
     
    const proxy = { server: "http://proxy:8080" } as never;

    it("returns reachable if fetch succeeds with 200", async () => {
       
       
      vi.mocked(fetch).mockResolvedValue({ status: 200, statusText: "OK" } as never);
       
      const res = await pingTargetUrl(proxy, "http://target.com", "target");
      expect(res.reachable).toBe(true);
      expect(res.statusCode).toBe(200);
    });

    it("returns reachable for 302", async () => {
       
       
      vi.mocked(fetch).mockResolvedValue({ status: 302, statusText: "Found" } as never);
       
      const res = await pingTargetUrl(proxy, "http://target.com", "target");
      expect(res.reachable).toBe(true);
    });

    it("returns reachable for 503", async () => {
       
       
      vi.mocked(fetch).mockResolvedValue({ status: 503, statusText: "Service Unavailable" } as never);
       
      const res = await pingTargetUrl(proxy, "http://target.com", "target");
      expect(res.reachable).toBe(true);
    });

    it("returns unreachable for 500", async () => {
       
       
      vi.mocked(fetch).mockResolvedValue({ status: 500, statusText: "Server Error" } as never);
       
      const res = await pingTargetUrl(proxy, "http://target.com", "target");
      expect(res.reachable).toBe(false);
      expect(res.error).toBe("HTTP 500 Server Error");
    });

    it("returns unreachable on throw", async () => {
      vi.mocked(fetch).mockRejectedValue(new Error("Network Error"));
       
      const res = await pingTargetUrl(proxy, "http://target.com", "target");
      expect(res.reachable).toBe(false);
      expect(res.error).toContain("Network Error");
    });
  });

  describe("pingViaBackendStack", () => {
     
     
    const proxy = { server: "http://proxy" } as never;

    it("bypasses for spider backend", async () => {
       
      const res = await pingViaBackendStack(proxy, "http://target.com", "spider");
      expect(res.reachable).toBe(true);
      expect(res.forwarderType).toBe("direct");
    });

    it("uses proxy-forwarder for stealth backend and succeeds", async () => {
      const { startProxyForwarder } = await import("../../src/proxy/proxy-forwarder.js");
      const forwarderMock = {
        serverUrl: "http://127.0.0.1:9090",
        close: vi.fn().mockResolvedValue(undefined)
      };
      vi.mocked(startProxyForwarder).mockResolvedValue(forwarderMock);

      // Mock net.connect
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const socketMock: any = {
        write: vi.fn(),
        on: vi.fn((event, cb) => {
          if (event === "data") {
            setTimeout(() => cb(Buffer.from("HTTP/1.1 200 OK\r\n\r\n")), 10);
          }
        }),
        destroy: vi.fn()
      };
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
      vi.mocked(net.connect).mockReturnValue(socketMock);

       
      const res = await pingViaBackendStack(proxy, "http://target.com", "stealth-chrome");
      
      expect(res.forwarderType).toBe("proxy-forwarder");
      expect(res.reachable).toBe(true);
      expect(startProxyForwarder).toHaveBeenCalled();
      expect(forwarderMock.close).toHaveBeenCalled();
    });

    it("handles connection failure", async () => {
      const { startHttpCloakForwarder } = await import("../../backends/httpcloak-forwarder.js");
      const forwarderMock = {
        serverUrl: "http://127.0.0.1:9091",
        close: vi.fn().mockResolvedValue(undefined)
      };
      vi.mocked(startHttpCloakForwarder).mockResolvedValue(forwarderMock);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const socketMock: any = {
        write: vi.fn(),
        on: vi.fn((event, cb) => {
          if (event === "error") {
            setTimeout(() => cb(new Error("Socket closed")), 10);
          }
        }),
        destroy: vi.fn()
      };
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
      vi.mocked(net.connect).mockReturnValue(socketMock);

       
      const res = await pingViaBackendStack(proxy, "http://target.com", "cloak-headless");
      
      expect(res.forwarderType).toBe("httpcloak");
      expect(res.reachable).toBe(false);
      expect(res.error).toContain("Socket error");
    });
  });

  describe("preValidatePool", () => {
     
     
    const proxy1 = { server: "http://proxy1" } as never;
     
     
    const proxy2 = { server: "http://proxy2" } as never;
     
     
    const target = { name: "target1", url: "http://target1.com" } as never;

    it("returns empty array for empty pool", async () => {
       
      const res = await preValidatePool([], [target]);
      expect(res).toEqual([]);
    });

    it("validates pool correctly", async () => {
       
       
      vi.mocked(fetch).mockResolvedValue({ status: 200, statusText: "OK" } as never);
      
       
       
      const res = await preValidatePool([proxy1, proxy2], [target]);
      expect(res).toHaveLength(2);
      expect(res[0]!.allTargetsReachable).toBe(true);
      expect(res[1]!.allTargetsReachable).toBe(true);
    });

    it("runs layer2 if enabled", async () => {
       
       
      vi.mocked(fetch).mockResolvedValue({ status: 200, statusText: "OK" } as never);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const socketMock: any = {
        write: vi.fn(),
        on: vi.fn((event, cb) => {
          if (event === "data") {
            setTimeout(() => cb(Buffer.from("HTTP/1.1 200 OK\r\n\r\n")), 1);
          }
        }),
        destroy: vi.fn()
      };
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
      vi.mocked(net.connect).mockReturnValue(socketMock);

      const { startHttpCloakForwarder } = await import("../../backends/httpcloak-forwarder.js");
      vi.mocked(startHttpCloakForwarder).mockResolvedValue({
        serverUrl: "http://127.0.0.1:9091",
        close: vi.fn().mockResolvedValue(undefined)
      });

       
       
      const res = await preValidatePool([proxy1], [target], { enableBackendPing: true });
      expect(res[0]!.layer2Result).toBeDefined();
      expect(res[0]!.layer2Result?.reachable).toBe(true);
      expect(res[0]!.allTargetsReachable).toBe(true);
    });
  });

  describe("preValidateProxy", () => {
     
     
    const proxy = { server: "http://proxy" } as never;
     
     
    const target = { name: "target1", url: "http://target1.com" } as never;

    it("returns reachable if all targets succeed", async () => {
       
       
      vi.mocked(fetch).mockResolvedValue({ status: 200, statusText: "OK" } as never);
       
       
      const res = await preValidateProxy(proxy, [target], "cloak-headless");
      expect(res.reachable).toBe(true);
      expect(res.checkedTargets).toBe(1);
    });

    it("returns unreachable if a target fails", async () => {
       
       
      vi.mocked(fetch).mockResolvedValue({ status: 500, statusText: "Error" } as never);
       
       
      const res = await preValidateProxy(proxy, [target], "cloak-headless");
      expect(res.reachable).toBe(false);
      expect(res.failedTarget).toBe("target1");
    });
  });
});
