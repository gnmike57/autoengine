import fetch from "node-fetch";
import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";
import { type ProxyEntry } from "../../backends/index.js";
import { createLogger } from "../core/logger.js";
import { proxyEntryKey } from "./proxy-score-tracker.js";

const log = createLogger("proxy-validator");

export interface ProxyValidationResult {
  valid: boolean;
  ip?: string;
  error?: string;
}

/**
 * Validates a single proxy by making a fast request to api.ipify.org
 * Returns the detected IP if successful, or an error message if failed.
 */
export async function validateProxyIP(proxy: ProxyEntry, timeoutMs = 8000): Promise<ProxyValidationResult> {
  const url = "https://api.ipify.org?format=text";
  let agent: SocksProxyAgent | HttpsProxyAgent<string>;

  try {
    const serverHost = proxy.server.includes("://") ? proxy.server.split("://")[1] : proxy.server;
    const proxyUrlString = proxy.username && proxy.password
      ? `${proxy.protocol}://${proxy.username}:${proxy.password}@${serverHost}`
      : proxy.server;

    if (proxy.protocol === "socks5") {
      agent = new SocksProxyAgent(proxyUrlString);
    } else {
      agent = new HttpsProxyAgent(proxyUrlString);
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    const res = await fetch(url, {
      agent,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!res.ok) {
      return { valid: false, error: `HTTP ${res.status} ${res.statusText}` };
    }

    const ip = (await res.text()).trim();
    return { valid: true, ip };
  } catch (err: unknown) {
    return { valid: false, error: (err instanceof Error ? err.message : String(err)) || String(err) };
  }
}

/**
 * Validates an entire pool of proxies concurrently in chunks of 50.
 * Returns only the proxies that are verified as working.
 */
export async function validateProxyPool(pool: ProxyEntry[], timeoutMs = 8000): Promise<ProxyEntry[]> {
  if (pool.length === 0) return [];

  log.info(`Validating ${pool.length} proxies in chunks of 50...`);

  const validProxies: ProxyEntry[] = [];
  const chunkSize = 50;

  for (let i = 0; i < pool.length; i += chunkSize) {
    const chunk = pool.slice(i, i + chunkSize);

    const promises = chunk.map(async (proxy) => {
      const res = await validateProxyIP(proxy, timeoutMs);
      const key = proxyEntryKey(proxy);
      if (res.valid) {
        log.debug(`[OK] Proxy ${key} -> IP: ${res.ip}`);
        return proxy;
      } else {
        log.warn(`[FAIL] Proxy ${key} -> ${res.error}`);
        return null;
      }
    });

    const results = await Promise.all(promises);
    validProxies.push(...results.filter((p): p is ProxyEntry => p !== null));
  }

  log.info(`Proxy validation complete: ${validProxies.length}/${pool.length} proxies are healthy.`);
  return validProxies;
}