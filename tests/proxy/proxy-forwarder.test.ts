import { describe, it, expect } from "vitest";
import { startProxyForwarder } from "../../src/proxy/proxy-forwarder.js";
import * as net from "net";



describe("Proxy Forwarder", () => {
  it("rejects invalid upstream servers", async () => {
    await expect(startProxyForwarder({ server: "" })).rejects.toThrow("proxy forwarder requires upstream.server");
     
     
    await expect(startProxyForwarder({ server: "not-a-url" })).rejects.toThrow("invalid upstream proxy URL");
    await expect(startProxyForwarder({ server: "ftp://proxy.com" })).rejects.toThrow("proxy forwarder only supports http and socks5");
  });

  it("handles basic http proxy forwarding", async () => {
    // Create a dummy HTTP proxy server to act as upstream
    const dummyUpstream = net.createServer((socket) => {
      socket.on("data", (data) => {
        if (data.toString().includes("CONNECT test.com:443")) {
          socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        }
      });
    });
    
    await new Promise<void>(resolve => dummyUpstream.listen(0, "127.0.0.1", resolve));
    const port = (dummyUpstream.address() as net.AddressInfo).port;
    
    const forwarder = await startProxyForwarder({ server: `http://127.0.0.1:${port}`, username: "usr", password: "pwd" });
    expect(forwarder.serverUrl.startsWith("http://127.0.0.1:")).toBe(true);

    // Test a fake CONNECT request
    const fwdPort = new URL(forwarder.serverUrl).port;
    const client = net.connect(Number(fwdPort), "127.0.0.1");
    client.write("CONNECT test.com:443 HTTP/1.1\r\nHost: test.com:443\r\n\r\n");

    const response = await new Promise<string>((resolve) => {
      client.on("data", (data) => resolve(data.toString()));
    });
    
    expect(response).toContain("HTTP/1.1 200 Connection Established");
    
    client.destroy();
    await forwarder.close();
    await new Promise<void>(resolve => dummyUpstream.close(() => resolve()));
  });
  it("handles standard http proxy GET forwarding", async () => {
    const dummyUpstream = net.createServer((socket) => {
      socket.on("data", (data) => {
        if (data.toString().includes("GET")) {
          socket.write("HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nHello");
          socket.end();
        }
      });
    });
    
    await new Promise<void>(resolve => dummyUpstream.listen(0, "127.0.0.1", resolve));
    const port = (dummyUpstream.address() as net.AddressInfo).port;
    
    const forwarder = await startProxyForwarder({ server: `http://127.0.0.1:${port}`, username: "usr", password: "pwd" });
    const fwdPort = new URL(forwarder.serverUrl).port;
    
    const client = net.connect(Number(fwdPort), "127.0.0.1");
    client.write("GET http://example.com/ HTTP/1.1\r\nHost: example.com\r\n\r\n");

    const response = await new Promise<string>((resolve) => {
      let res = "";
      client.on("data", (data) => {
        res += data.toString();
        if (res.includes("Hello")) resolve(res);
      });
      client.on("error", () => resolve(res));
    });
    
    expect(response).toContain("HTTP/1.1 200 OK");
    expect(response).toContain("Hello");
    
    client.destroy();
    await forwarder.close();
    await new Promise<void>(resolve => dummyUpstream.close(() => resolve()));
  });

  it("handles non-200 CONNECT proxy errors gracefully", async () => {
    const dummyUpstream = net.createServer((socket) => {
      socket.on("data", (data) => {
        if (data.toString().includes("CONNECT")) {
          socket.write("HTTP/1.1 407 Proxy Auth Required\r\n\r\n");
          socket.end();
        }
      });
    });
    
    await new Promise<void>(resolve => dummyUpstream.listen(0, "127.0.0.1", resolve));
    const port = (dummyUpstream.address() as net.AddressInfo).port;
    
    const forwarder = await startProxyForwarder({ server: `http://127.0.0.1:${port}` });
    const fwdPort = new URL(forwarder.serverUrl).port;
    
    const client = net.connect(Number(fwdPort), "127.0.0.1");
    client.write("CONNECT test.com:443 HTTP/1.1\r\nHost: test.com:443\r\n\r\n");

    const response = await new Promise<string>((resolve) => {
      let res = "";
      client.on("data", (data) => res += data.toString());
      client.on("end", () => resolve(res));
    });
    
    expect(response).toContain("HTTP/1.1 407 Proxy Auth Required");
    
    client.destroy();
    await forwarder.close();
    await new Promise<void>(resolve => dummyUpstream.close(() => resolve()));
  });
});
