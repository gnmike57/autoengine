import { LocalProxy, availablePresets } from "httpcloak";
import { ForwardProxyEntry, ProxyForwarder } from "../src/proxy/proxy-forwarder.js";
import { createLogger } from "../src/core/logger.js";

const log = createLogger("httpcloak");

/**
 * Local unauthenticated HTTP forward proxy powered by httpcloak.
 * 
 * Replaces the raw TCP proxy-forwarder to provide advanced TLS (JA3),
 * HTTP/2, and TCP/IP fingerprinting while avoiding Chromium's proxy-auth bugs.
 */
export function startHttpCloakForwarder(
  upstream: ForwardProxyEntry,
  clientProfile: string = "chrome-latest"
): Promise<ProxyForwarder> {
  
  let upstreamProxyUrl = "";
  if (upstream && upstream.server) {
    try {
      const u = new URL(upstream.server);
      if (upstream.username) {
        u.username = decodeURIComponent(upstream.username);
        if (upstream.password) {
          u.password = decodeURIComponent(upstream.password);
        }
      }
      upstreamProxyUrl = u.toString();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`invalid upstream proxy URL for httpcloak: ${message}`, { cause: err });
    }
  }

  // Determine preset from clientProfile.
  let preset = "chrome-latest"; // fallback
  const presetsObj = availablePresets();
  const presets = Object.keys(presetsObj);
  
  if (clientProfile === "chrome") preset = "chrome-latest";
  else if (clientProfile === "firefox") preset = "firefox-latest";
  else if (clientProfile === "edge") preset = "edge-latest";
  else if (clientProfile === "safari") preset = "safari-18";
  else if (clientProfile.startsWith("chrome-")) {
    if (presets.includes(clientProfile)) {
      preset = clientProfile;
    } else {
      // Fallback to closest available chrome version or chrome-latest
      const match = clientProfile.match(/chrome-(\d+)/);
      if (match && match[1]) {
        const major = parseInt(match[1], 10);
        const possible = `chrome-${major}`;
        preset = presets.includes(possible) ? possible : "chrome-latest";
      } else {
        preset = "chrome-latest";
      }
    }
  }

  // Spawn the httpcloak LocalProxy.
  // We use tlsOnly: true so that httpcloak applies the TLS/HTTP2 transport fingerprint
  // but leaves the Playwright-generated HTTP headers (User-Agent, Sec-Ch-Ua, etc.) intact.
  const proxy = new LocalProxy({
    preset: preset,
    tcpProxy: upstreamProxyUrl || undefined,
    tlsOnly: true,
  });

  // Attach error handler to prevent unhandled 'error' events from crashing the process
  const proxyObj = proxy as unknown as { on?: (event: string, handler: (err: Error) => void) => void };
  if (typeof proxyObj.on === 'function') {
    proxyObj.on('error', (err: Error) => {
      log.warn(`httpCloak proxy error: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  return Promise.resolve({
    serverUrl: proxy.proxyUrl,
    close: () => {
      proxy.close();
      return Promise.resolve();
    },
  });
}
