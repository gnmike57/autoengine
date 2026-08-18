/**
 * proxy-pre-ping.ts
 *
 * Two-layer proxy pre-validation system that tests reachability against the
 * actual target URLs (not just api.ipify.org) and optionally verifies the
 * complete proxy forwarder stack each backend will use.
 *
 * Layer 1 — Target URL reachability (HTTP HEAD through proxy)
 * Layer 2 — Backend stack validation (httpCloak / basic TCP forwarder probe)
 *
 * Complies with:
 *  Rule 1  (strict-zero-sleep-polling) — no arbitrary waits
 *  Rule 33 (strict-camoufox-no-httpcloak) — stealth backends bypass httpCloak
 *  Rule 44 (strict-httpcloak-error-handling) — error handlers on forwarders
 *  Rule 49 (strict-structured-logging) — uses createLogger
 */

import fetch from "node-fetch";
import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";
import * as net from "node:net";
import { type ProxyEntry } from "../../backends/index.js";
import { createLogger } from "../core/logger.js";
import { proxyEntryKey } from "./proxy-score-tracker.js";
import { startProxyForwarder, type ProxyForwarder } from "./proxy-forwarder.js";
import type { SiteConfig } from "../targets/index.js";

const log = createLogger("proxy-pre-ping");

// ─── Result Types ──────────────────────────────────────────────────────────────

export interface PingResult {
  reachable: boolean;
  targetName: string;
  targetUrl: string;
  statusCode?: number;
  latencyMs: number;
  error?: string;
}

export interface BackendPingResult {
  reachable: boolean;
  targetUrl: string;
  latencyMs: number;
  forwarderType: "httpcloak" | "proxy-forwarder" | "direct";
  error?: string;
}

export interface ProxyPingReport {
  proxy: ProxyEntry;
  proxyKey: string;
  layer1Results: PingResult[];
  layer2Result?: BackendPingResult;
  allTargetsReachable: boolean;
  avgLatencyMs: number;
  testedAt: number;
}

export interface PrePingOptions {
  timeoutMs?: number;
  enableBackendPing?: boolean;
  backend?: string;
  /** When true, accept a proxy if it reaches at least one target (vs all). */
  requireAllTargets?: boolean;
}

export interface SingleProxyPingResult {
  reachable: boolean;
  failedTarget?: string;
  error?: string;
  latencyMs: number;
  checkedTargets: number;
  layer2Ok?: boolean;
}

// ─── Layer 1: Target URL Reachability ──────────────────────────────────────────

/**
 * Send an HTTP HEAD request to the target URL through the proxy.
 * Accepts 2xx and 3xx as reachable (login pages often redirect).
 * Does NOT render the page — pure TCP+TLS+HTTP reachability check.
 */
export async function pingTargetUrl(
  proxy: ProxyEntry,
  targetUrl: string,
  targetName: string,
  timeoutMs = 8000,
): Promise<PingResult> {
  const startMs = Date.now();
  let agent: SocksProxyAgent | HttpsProxyAgent<string>;

  try {
    const proxyUrlString = proxy.username && proxy.password
      ? `${proxy.protocol || "http"}://${proxy.username}:${proxy.password}@${proxy.server.split("://")[1]}`
      : proxy.server;

    if (proxy.protocol === "socks5") {
      agent = new SocksProxyAgent(proxyUrlString);
    } else {
      agent = new HttpsProxyAgent(proxyUrlString);
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    let res: any;
    try {
      res = await fetch(targetUrl, {
        method: "HEAD",
        agent,
        signal: controller.signal,
        redirect: "manual", // Don't follow redirects — we just want reachability
        headers: {
          // Minimal headers to avoid triggering WAF on HEAD
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
          "Accept": "text/html,application/xhtml+xml",
          "Connection": "close", // Prevent keep-alive socket exhaustion
        },
      });
    } finally {
      clearTimeout(timeoutId);
    }

    const latencyMs = Date.now() - startMs;

    // Accept 2xx, 3xx, and 403/405 (WAF may block HEAD but proxy path is live)
    const code = res.status;
    const isReachable = code < 500 || code === 503; // Even 503 means the proxy chain works

    return {
      reachable: isReachable,
      targetName,
      targetUrl,
      statusCode: code,
      latencyMs,
      error: isReachable ? undefined : `HTTP ${code} ${res.statusText}`,
    };
  } catch (err: unknown) {
    return {
      reachable: false,
      targetName,
      targetUrl,
      latencyMs: Date.now() - startMs,
      error: (err instanceof Error ? err.message : String(err)) || String(err),
    };
  }
}

// ─── Layer 2: Backend Stack Validation ─────────────────────────────────────────

/**
 * Resolve which forwarder type a backend uses.
 * Mirrors the logic in BACKEND_OPTIMAL_SETTINGS (engine.ts) and the
 * per-backend createSession paths in stealth.ts / cloak.ts.
 *
 * - stealth (camoufox): always basic proxy-forwarder (Rule 33: no httpCloak)
 * - cloak-* / zendriver-*: httpCloak when enabled (the default)
 * - spider / curl: no forwarder (cloud-managed)
 */
function resolveForwarderType(backendName: string): "httpcloak" | "proxy-forwarder" | "none" {
  if (!backendName) return "proxy-forwarder";
  const b = backendName.toLowerCase();
  if (b.startsWith("stealth")) return "proxy-forwarder"; // Rule 33: camoufox bypasses httpCloak
  if (b.startsWith("spider") || b === "curl-api") return "none";
  // cloak-*, zendriver-* default to httpCloak
  if (b.includes("nocloak")) return "proxy-forwarder";
  return "httpcloak";
}

/**
 * Resolve the httpCloak TLS profile based on backend browser engine.
 * - Firefox-based (stealth/camoufox): firefox-latest
 * - Chromium-based (cloak/zendriver): chrome-latest
 */
function resolveClientProfile(backendName: string): string {
  if (!backendName) return "chrome-latest";
  const b = backendName.toLowerCase();
  if (b.startsWith("stealth")) return "firefox-latest"; // Camoufox = Firefox
  return "chrome-latest"; // CloakBrowser, Zendriver = Chromium
}

/**
 * Test connectivity through the same proxy forwarder stack the backend would use.
 * Spins up the forwarder, sends an HTTP CONNECT through it to the target host,
 * then tears down the forwarder. No browser is launched.
 */
export async function pingViaBackendStack(
  proxy: ProxyEntry,
  targetUrl: string,
  backendName: string,
  timeoutMs = 8000,
): Promise<BackendPingResult> {
  const startMs = Date.now();
  const forwarderType = resolveForwarderType(backendName);

  if (forwarderType === "none") {
    // Spider/curl backends don't use local forwarders
    return {
      reachable: true,
      targetUrl,
      latencyMs: 0,
      forwarderType: "direct",
    };
  }

  let forwarder: ProxyForwarder | null = null;

  try {
    if (forwarderType === "httpcloak") {
      const { startHttpCloakForwarder } = await import("../../backends/httpcloak-forwarder.js");
      const profile = resolveClientProfile(backendName);
      forwarder = await startHttpCloakForwarder(proxy, profile);
    } else {
      forwarder = await startProxyForwarder(proxy, resolveClientProfile(backendName));
    }

    // Extract host:port from target URL for CONNECT probe
    const url = new URL(targetUrl);
    const host = url.hostname;
    const port = url.port ? parseInt(url.port, 10) : (url.protocol === "https:" ? 443 : 80);

    // Parse the forwarder's local address
    const forwarderUrl = new URL(forwarder.serverUrl);
    const fwdHost = forwarderUrl.hostname;
    const fwdPort = parseInt(forwarderUrl.port, 10);

    // Send HTTP CONNECT through the local forwarder to the target
    const connectResult = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
      const timer = setTimeout(() => {
        socket.destroy();
        resolve({ ok: false, error: `CONNECT timed out after ${timeoutMs}ms` });
      }, timeoutMs);

      const socket = net.connect(fwdPort, fwdHost, () => {
        socket.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`);
      });

      let buffered = "";
      socket.on("data", (chunk) => {
        buffered += chunk.toString("latin1");
        if (buffered.includes("\r\n\r\n")) {
          clearTimeout(timer);
          const ok = /^HTTP\/1\.[01] 200\b/i.test(buffered);
          socket.destroy();
          resolve({ ok, error: ok ? undefined : `CONNECT rejected: ${buffered.split("\r\n")[0]}` });
        }
      });

      socket.on("error", (err) => {
        clearTimeout(timer);
        socket.destroy();
        resolve({ ok: false, error: `Socket error: ${err instanceof Error ? err.message : String(err)}` });
      });

      socket.on("close", () => {
        clearTimeout(timer);
        if (!buffered.includes("\r\n\r\n")) {
          resolve({ ok: false, error: "Connection closed before CONNECT response" });
        }
      });
    });

    return {
      reachable: connectResult.ok,
      targetUrl,
      latencyMs: Date.now() - startMs,
      forwarderType,
      error: connectResult.error,
    };
  } catch (err: unknown) {
    return {
      reachable: false,
      targetUrl,
      latencyMs: Date.now() - startMs,
      forwarderType,
      error: (err instanceof Error ? err.message : String(err)) || String(err),
    };
  } finally {
    if (forwarder) {
      await forwarder.close().catch(() => {});
    }
  }
}

// ─── Pool-Level Validation ─────────────────────────────────────────────────────

/**
 * Validate an entire proxy pool against all target URLs.
 * Runs Layer 1 (HTTP HEAD) across all proxies × all targets in parallel.
 * Optionally runs Layer 2 (backend stack probe) for proxies that pass Layer 1.
 *
 * Returns a per-proxy report with reachability and latency data.
 */
export async function preValidatePool(
  pool: ProxyEntry[],
  targets: SiteConfig[],
  options: PrePingOptions = {},
): Promise<ProxyPingReport[]> {
  if (pool.length === 0) return [];
  const timeoutMs = options.timeoutMs ?? 8000;
  const enableBackendPing = options.enableBackendPing ?? false;
  const backendName = options.backend ?? "cloak-headless";
  const requireAll = options.requireAllTargets !== false; // default: require all

  log.info(`🏓 Pre-pinging ${pool.length} proxies × ${targets.length} targets (timeout=${timeoutMs}ms, backend=${backendName}, layer2=${enableBackendPing})...`);

  // Issue 18: Concurrency limiter — prevents FD exhaustion and upstream rate
  // limiting. With 200 proxies × 3 targets the old code fired 600+ parallel
  // HTTP requests. Cap at 20 proxies in flight (= up to 60 HTTP HEAD requests).
  const CONCURRENCY = 20;
  const reports: ProxyPingReport[] = [];
  let cursor = 0;

  const processProxy = async (proxy: ProxyEntry): Promise<ProxyPingReport> => {
    const key = proxyEntryKey(proxy);

    // Layer 1: HTTP HEAD to each target URL
    const layer1Results = await Promise.all(
      targets.map((t) => pingTargetUrl(proxy, t.url, t.name, timeoutMs)),
    );

    const reachableCount = layer1Results.filter((r) => r.reachable).length;
    const allReachable = requireAll
      ? reachableCount === targets.length
      : reachableCount > 0;
    const avgLatency = layer1Results.length > 0
      ? layer1Results.reduce((sum, r) => sum + r.latencyMs, 0) / layer1Results.length
      : 0;

    // Layer 2: Backend stack probe (only if Layer 1 passed)
    let layer2Result: BackendPingResult | undefined;
    if (enableBackendPing && allReachable && targets.length > 0) {
      // Probe through the backend forwarder to the first target
      layer2Result = await pingViaBackendStack(proxy, targets[0]!.url, backendName, timeoutMs);
      if (!layer2Result.reachable) {
        log.warn(`[${key}] Layer 2 FAIL (${layer2Result.forwarderType}): ${layer2Result.error}`);
      }
    }

    const finalReachable = allReachable && (!layer2Result || layer2Result.reachable);

    if (finalReachable) {
      log.debug(`[OK] ${key} — ${reachableCount}/${targets.length} targets, avg ${avgLatency.toFixed(0)}ms${layer2Result ? `, L2 ${layer2Result.latencyMs}ms` : ""}`);
    } else {
      const failedTargets = layer1Results.filter((r) => !r.reachable).map((r) => r.targetName);
      log.warn(`[FAIL] ${key} — failed targets: ${failedTargets.join(", ") || "L2"} | ${layer1Results.map((r) => `${r.targetName}=${r.reachable ? r.statusCode : r.error?.substring(0, 40)}`).join(", ")}`);
    }

    return {
      proxy,
      proxyKey: key,
      layer1Results,
      layer2Result,
      allTargetsReachable: finalReachable,
      avgLatencyMs: avgLatency,
      testedAt: Date.now(),
    };
  };

  // Semaphore-based concurrency control
  const workers: Promise<void>[] = [];
  for (let i = 0; i < Math.min(CONCURRENCY, pool.length); i++) {
    workers.push((async () => {
      while (true) {
        const idx = cursor++;
        if (idx >= pool.length) break;
        const report = await processProxy(pool[idx]!);
        reports.push(report);
      }
    })());
  }
  await Promise.all(workers);

  const healthyCount = reports.filter((r) => r.allTargetsReachable).length;
  log.info(`🏓 Pre-ping complete: ${healthyCount}/${pool.length} proxies passed all checks.`);

  return reports;
}

// ─── Single-Proxy Pre-Session Check ────────────────────────────────────────────

/**
 * Validate a single proxy against all targets before launching a browser session.
 * Called from createSession() in backends/index.ts — replaces the old validateProxyIP() call.
 *
 * Layer 1: HTTP HEAD to each target URL
 * Layer 2 (optional): CONNECT through the backend's proxy forwarder stack
 */
export async function preValidateProxy(
  proxy: ProxyEntry,
  targets: SiteConfig[],
  backendName: string,
  options: PrePingOptions = {},
): Promise<SingleProxyPingResult> {
  const timeoutMs = options.timeoutMs ?? 8000;
  const enableBackendPing = options.enableBackendPing ?? false;

  // Layer 1: HTTP HEAD to each target
  const pingResults = await Promise.all(
    targets.map((t) => pingTargetUrl(proxy, t.url, t.name, timeoutMs)),
  );

  const failedPing = pingResults.find((r) => !r.reachable);
  if (failedPing) {
    return {
      reachable: false,
      failedTarget: failedPing.targetName,
      error: `Target ${failedPing.targetName} unreachable: ${failedPing.error}`,
      latencyMs: pingResults.reduce((s, r) => s + r.latencyMs, 0),
      checkedTargets: targets.length,
    };
  }

  const totalLatency = pingResults.reduce((sum, r) => sum + r.latencyMs, 0);

  // Layer 2: Backend forwarder stack probe
  let layer2Ok: boolean | undefined;
  if (enableBackendPing && targets.length > 0) {
    const l2 = await pingViaBackendStack(proxy, targets[0]!.url, backendName, timeoutMs);
    layer2Ok = l2.reachable;
    if (!l2.reachable) {
      return {
        reachable: false,
        failedTarget: `${targets[0]!.name} (via ${l2.forwarderType})`,
        error: `Backend stack probe failed: ${l2.error}`,
        latencyMs: totalLatency + l2.latencyMs,
        checkedTargets: targets.length,
        layer2Ok: false,
      };
    }
  }

  return {
    reachable: true,
    latencyMs: totalLatency,
    checkedTargets: targets.length,
    layer2Ok,
  };
}