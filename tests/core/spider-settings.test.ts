/**
 * Unit tests for spider-settings.ts — numeric env clamp warnings.
 *
 * Focused on the contract that every numeric range-constrained env var
 * emits a warning (env var name, provided value, allowed bound/range,
 * clamped value) before returning the corrected value.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  loadSpiderSettings,
  mergeSpiderSettings,
  DEFAULT_SPIDER_SETTINGS,
  redactSpiderSettings,
  normalizeBackend,
} from "../../src/core/spider-settings.js";
import {
  loadProxyPool,
  proxyUrlWithCredentials,
  applyProxyProtocolOverride,
  forceSocks5,
  forceHttp,
  type ProxyEntry,
} from "../../backends/index.js";

const NUMERIC_ENV_KEYS = [
  "SPIDER_CLOUD_REQUEST_TIMEOUT",
  "SPIDER_CLOUD_MAX_CONCURRENCY",
  "SPIDER_CLOUD_KEEPALIVE_MS",
  "SPIDER_CLOUD_BACKOFF_MS",
  "SPIDER_CLOUD_MAX_STEALTH_LEVELS",
  "SPIDER_GATEWAY_POOL_SIZE",
  "SPIDER_CLOUD_STAGGER_MS",
  "SPIDER_CONFIRM_THRESHOLD",
] as const;

describe("loadSpiderSettings numeric clamp warnings", () => {
  let originalEnv: Record<string, string | undefined>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    originalEnv = Object.fromEntries(
      NUMERIC_ENV_KEYS.map((k) => [k, process.env[k]]),
    );
    for (const k of NUMERIC_ENV_KEYS) delete process.env[k];
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => { });
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(originalEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    warnSpy.mockRestore();
  });

  function warnedFor(key: string): string | undefined {
    for (const call of warnSpy.mock.calls) {
      // @ts-expect-error noUncheckedIndexedAccess
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const joined = call.map((a) => String(a)).join(" ");
      if (joined.includes(`${key}=`)) return joined;
    }
    return undefined;
  }

  it("warns and clamps SPIDER_CLOUD_REQUEST_TIMEOUT to the [5,255] range", () => {
    process.env.SPIDER_CLOUD_REQUEST_TIMEOUT = "1000";
    const s = loadSpiderSettings();
    expect(s.requestTimeoutSec).toBe(255);
    expect(warnedFor("SPIDER_CLOUD_REQUEST_TIMEOUT")).toMatch(
      /SPIDER_CLOUD_REQUEST_TIMEOUT=1000 out of range \[5,255\], clamping to 255/,
    );
  });

  it("warns and clamps SPIDER_CLOUD_MAX_CONCURRENCY to the [1,100] range", () => {
    process.env.SPIDER_CLOUD_MAX_CONCURRENCY = "0";
    const s = loadSpiderSettings();
    expect(s.maxConcurrency).toBe(1);
    expect(warnedFor("SPIDER_CLOUD_MAX_CONCURRENCY")).toMatch(
      /SPIDER_CLOUD_MAX_CONCURRENCY=0 out of range \[1,100\], clamping to 1/,
    );
  });

  it("warns and clamps SPIDER_CLOUD_KEEPALIVE_MS below minimum 0", () => {
    process.env.SPIDER_CLOUD_KEEPALIVE_MS = "-5";
    const s = loadSpiderSettings();
    expect(s.keepAliveMs).toBe(0);
    expect(warnedFor("SPIDER_CLOUD_KEEPALIVE_MS")).toMatch(
      /SPIDER_CLOUD_KEEPALIVE_MS=-5 below minimum 0, clamping to 0/,
    );
  });

  it("warns and clamps SPIDER_CLOUD_BACKOFF_MS below minimum 0", () => {
    process.env.SPIDER_CLOUD_BACKOFF_MS = "-1";
    const s = loadSpiderSettings();
    expect(s.cdpBackoffMs).toBe(0);
    expect(warnedFor("SPIDER_CLOUD_BACKOFF_MS")).toMatch(
      /SPIDER_CLOUD_BACKOFF_MS=-1 below minimum 0, clamping to 0/,
    );
  });

  it("warns and clamps SPIDER_CLOUD_MAX_STEALTH_LEVELS below minimum 0", () => {
    process.env.SPIDER_CLOUD_MAX_STEALTH_LEVELS = "-2";
    const s = loadSpiderSettings();
    expect(s.maxStealthLevels).toBe(0);
    expect(warnedFor("SPIDER_CLOUD_MAX_STEALTH_LEVELS")).toMatch(
      /SPIDER_CLOUD_MAX_STEALTH_LEVELS=-2 below minimum 0, clamping to 0/,
    );
  });

  it("warns and clamps SPIDER_GATEWAY_POOL_SIZE below minimum 1", () => {
    process.env.SPIDER_GATEWAY_POOL_SIZE = "0";
    const s = loadSpiderSettings();
    expect(s.gatewayPoolSize).toBe(1);
    expect(warnedFor("SPIDER_GATEWAY_POOL_SIZE")).toMatch(
      /SPIDER_GATEWAY_POOL_SIZE=0 below minimum 1, clamping to 1/,
    );
  });

  it("warns and clamps SPIDER_CLOUD_STAGGER_MS below minimum 0", () => {
    process.env.SPIDER_CLOUD_STAGGER_MS = "-10";
    const s = loadSpiderSettings();
    expect(s.staggerMs).toBe(0);
    expect(warnedFor("SPIDER_CLOUD_STAGGER_MS")).toMatch(
      /SPIDER_CLOUD_STAGGER_MS=-10 below minimum 0, clamping to 0/,
    );
  });

  it("warns and clamps SPIDER_CONFIRM_THRESHOLD below minimum 0", () => {
    process.env.SPIDER_CONFIRM_THRESHOLD = "-100";
    const s = loadSpiderSettings();
    expect(s.confirmRowsConcurrencyThreshold).toBe(0);
    expect(warnedFor("SPIDER_CONFIRM_THRESHOLD")).toMatch(
      /SPIDER_CONFIRM_THRESHOLD=-100 below minimum 0, clamping to 0/,
    );
  });

  it("does not warn when in-range values are provided", () => {
    process.env.SPIDER_CLOUD_REQUEST_TIMEOUT = "60";
    process.env.SPIDER_CLOUD_MAX_CONCURRENCY = "10";
    process.env.SPIDER_CLOUD_KEEPALIVE_MS = "1000";
    process.env.SPIDER_CLOUD_BACKOFF_MS = "500";
    process.env.SPIDER_CLOUD_MAX_STEALTH_LEVELS = "2";
    process.env.SPIDER_GATEWAY_POOL_SIZE = "50";
    process.env.SPIDER_CLOUD_STAGGER_MS = "100";
    process.env.SPIDER_CONFIRM_THRESHOLD = "200";
    loadSpiderSettings();
    for (const k of NUMERIC_ENV_KEYS) {
      expect(warnedFor(k)).toBeUndefined();
    }
  });
});

describe("mergeSpiderSettings AU hard-lock", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => { });
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  function warnedFor(needle: string): string | undefined {
    for (const call of warnSpy.mock.calls) {
      // @ts-expect-error noUncheckedIndexedAccess
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const joined = call.map((a) => String(a)).join(" ");
      if (joined.includes(needle)) return joined;
    }
    return undefined;
  }

  it("passes through patch fields and leaves AU defaults intact when patch omits country/locale", () => {
    const merged = mergeSpiderSettings(DEFAULT_SPIDER_SETTINGS, { maxConcurrency: 7 });
    expect(merged.maxConcurrency).toBe(7);
    expect(merged.country).toBe("AU");
    expect(merged.locale).toBe("en-AU");
    expect(merged.cityWeights).toBe(DEFAULT_SPIDER_SETTINGS.cityWeights);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("accepts explicit AU/en-AU in the patch without warning", () => {
    const merged = mergeSpiderSettings(DEFAULT_SPIDER_SETTINGS, {
      country: "AU",
      locale: "en-AU",
    });
    expect(merged.country).toBe("AU");
    expect(merged.locale).toBe("en-AU");
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("warns and forces back to AU when patch.country is non-AU", () => {
    const merged = mergeSpiderSettings(DEFAULT_SPIDER_SETTINGS, {
      country: "US" as unknown as "AU",
    });
    expect(merged.country).toBe("AU");
    expect(warnedFor('country="US"')).toMatch(
      /Non-AU override ignored \(merge\): country="US" — forcing "AU"/,
    );
  });

  it("warns and forces back to en-AU when patch.locale is non-AU", () => {
    const merged = mergeSpiderSettings(DEFAULT_SPIDER_SETTINGS, {
      locale: "en-US" as unknown as "en-AU",
    });
    expect(merged.locale).toBe("en-AU");
    expect(warnedFor('locale="en-US"')).toMatch(
      /Non-AU override ignored \(merge\): locale="en-US" — forcing "en-AU"/,
    );
  });

  it("always preserves the base cityWeights mirror across merge", () => {
    const merged = mergeSpiderSettings(DEFAULT_SPIDER_SETTINGS, {
      country: "FR" as unknown as "AU",
      locale: "fr-FR" as unknown as "en-AU",
    });
    expect(merged.cityWeights).toBe(DEFAULT_SPIDER_SETTINGS.cityWeights);
    expect(merged.country).toBe("AU");
    expect(merged.locale).toBe("en-AU");
  });
});

describe("loadSpiderSettings proxyProtocol / forceProxyProtocol", () => {
  const KEYS = ["SPIDER_PROXY_PROTOCOL", "SPIDER_FORCE_PROXY_PROTOCOL"] as const;
  let original: Record<string, string | undefined>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    original = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
    for (const k of KEYS) delete process.env[k];
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => { });
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(original)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    warnSpy.mockRestore();
  });

  it("defaults to http / false when neither env var is set", () => {
    const s = loadSpiderSettings();
    expect(s.proxyProtocol).toBe("http");
    expect(s.forceProxyProtocol).toBe(false);
    expect(DEFAULT_SPIDER_SETTINGS.proxyProtocol).toBe("http");
    expect(DEFAULT_SPIDER_SETTINGS.forceProxyProtocol).toBe(false);
  });

  it("honours SPIDER_PROXY_PROTOCOL=socks5", () => {
    process.env.SPIDER_PROXY_PROTOCOL = "socks5";
    expect(loadSpiderSettings().proxyProtocol).toBe("socks5");
  });

  it("honours SPIDER_PROXY_PROTOCOL=https (case-insensitive)", () => {
    process.env.SPIDER_PROXY_PROTOCOL = "HTTPS";
    expect(loadSpiderSettings().proxyProtocol).toBe("https");
  });

  it("warns and falls back to http when SPIDER_PROXY_PROTOCOL is invalid", () => {
    process.env.SPIDER_PROXY_PROTOCOL = "ftp";
    expect(loadSpiderSettings().proxyProtocol).toBe("http");
    // @ts-expect-error noUncheckedIndexedAccess
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const joined = warnSpy.mock.calls.map((c) => c.map(String).join(" ")).join("\n");
    expect(joined).toMatch(/SPIDER_PROXY_PROTOCOL="ftp"/);
  });

  it("honours SPIDER_FORCE_PROXY_PROTOCOL=true", () => {
    process.env.SPIDER_FORCE_PROXY_PROTOCOL = "true";
    expect(loadSpiderSettings().forceProxyProtocol).toBe(true);
  });
});

describe("loadProxyPool parsing", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "spider-proxies-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writePool(lines: string[]): string {
    const p = path.join(tmpDir, "pool.txt");
    fs.writeFileSync(p, lines.join("\n"), "utf-8");
    return p;
  }

  it("parses socks5:// colon-delimited LiveProxies-style lines", () => {
    const file = writePool([
      "socks5://mp.evomi.com:3002:jfrdep:secret_country-AU_session-ABC123_lifetime-45",
    ]);
    const pool = loadProxyPool(file, "TEST_PROXY_FILE");
    expect(pool).toHaveLength(1);
    expect(pool[0]).toMatchObject({
      server: "socks5://mp.evomi.com:3002",
      username: "jfrdep",
      password: "secret_country-AU_session-ABC123_lifetime-45",
      protocol: "socks5",
    });
  });

  it("parses bare colon-delimited host:port:user:pass lines as http by default", () => {
    const file = writePool(["proxy.example.com:8080:user:pa:ss:word"]);
    const pool = loadProxyPool(file, "TEST_PROXY_FILE");
    expect(pool).toHaveLength(1);
    expect(pool[0]).toMatchObject({
      server: "http://proxy.example.com:8080",
      username: "user",
      password: "pa:ss:word",
      protocol: "http",
    });
  });

  it("parses URL form with embedded credentials", () => {
    const file = writePool(["http://user:p%40ss@proxy.example.com:8080"]);
    const pool = loadProxyPool(file, "TEST_PROXY_FILE");
    expect(pool).toHaveLength(1);
    expect(pool[0]).toMatchObject({
      server: "http://proxy.example.com:8080",
      username: "user",
      password: "p@ss",
      protocol: "http",
    });
  });

  it("skips blank lines and malformed entries", () => {
    const file = writePool([
      "",
      "   ",
      "not-a-proxy",
      "socks5://mp.evomi.com:3002:user:pw",
    ]);
    const pool = loadProxyPool(file, "TEST_PROXY_FILE");
    expect(pool).toHaveLength(1);
    // @ts-expect-error noUncheckedIndexedAccess
    expect(pool[0].protocol).toBe("socks5");
  });

  it("returns an empty array when the file path is empty", () => {
    expect(loadProxyPool("", "TEST_PROXY_FILE")).toEqual([]);
  });

  it("parses https:// colon-delimited entries", () => {
    const file = writePool(["https://proxy.example.com:8443:user:secret"]);
    const pool = loadProxyPool(file, "TEST_PROXY_FILE");
    expect(pool[0]).toMatchObject({
      server: "https://proxy.example.com:8443",
      username: "user",
      password: "secret",
      protocol: "https",
    });
  });

  it("parses socks5:// URL form with embedded credentials", () => {
    const file = writePool(["socks5://u:p%23w@gateway.example.com:1080"]);
    const pool = loadProxyPool(file, "TEST_PROXY_FILE");
    expect(pool[0]).toMatchObject({
      server: "socks5://gateway.example.com:1080",
      username: "u",
      password: "p#w",
      protocol: "socks5",
    });
  });

  it("parses https:// URL form with embedded credentials", () => {
    const file = writePool(["https://u:p@proxy.example.com:8443"]);
    const pool = loadProxyPool(file, "TEST_PROXY_FILE");
    expect(pool[0]).toMatchObject({
      server: "https://proxy.example.com:8443",
      username: "u",
      password: "p",
      protocol: "https",
    });
  });

  it("treats scheme prefix case-insensitively on colon-delimited lines", () => {
    const file = writePool([
      "SOCKS5://host.example.com:1080:u:p",
      "HTTPS://host.example.com:8443:u:p",
    ]);
    const pool = loadProxyPool(file, "TEST_PROXY_FILE");
    expect(pool.map((e) => e.protocol)).toEqual(["socks5", "https"]);
  });

  it("preserves order and per-line schemes across a mixed-protocol pool", () => {
    const file = writePool([
      "socks5://host.example.com:1080:u:s1",
      "https://host.example.com:8443:u:s2",
      "host.example.com:8080:u:s3",
      "http://host.example.com:80:u:s4",
    ]);
    const pool = loadProxyPool(file, "TEST_PROXY_FILE");
    expect(pool).toHaveLength(4);
    expect(pool.map((e) => e.protocol)).toEqual(["socks5", "https", "http", "http"]);
    expect(pool.map((e) => e.server)).toEqual([
      "socks5://host.example.com:1080",
      "https://host.example.com:8443",
      "http://host.example.com:8080",
      "http://host.example.com:80",
    ]);
  });
});

describe("proxyUrlWithCredentials", () => {
  const httpEntry: ProxyEntry = {
    server: "http://gateway.example.com:8080",
    username: "alice",
    password: "p@ss/1",
    protocol: "http",
  };
  const socksEntry: ProxyEntry = {
    server: "socks5://gateway.example.com:1080",
    username: "alice",
    password: "p@ss/1",
    protocol: "socks5",
  };
  const anonHttp: ProxyEntry = {
    server: "http://anonymous.example.com:8080",
    protocol: "http",
  };

  it("returns the server as-is when no creds and no override", () => {
    expect(proxyUrlWithCredentials(anonHttp)).toBe("http://anonymous.example.com:8080");
  });

  it("embeds creds with percent-encoding when no override", () => {
    const url = proxyUrlWithCredentials(httpEntry);
    expect(url).toBe("http://alice:p%40ss%2F1@gateway.example.com:8080");
  });

  it("rewrites scheme without touching creds when only override is supplied (anon)", () => {
    expect(proxyUrlWithCredentials(anonHttp, "socks5")).toBe("socks5://anonymous.example.com:8080");
  });

  it("rewrites scheme and embeds creds when both are needed", () => {
    const url = proxyUrlWithCredentials(httpEntry, "socks5");
    expect(url).toBe("socks5://alice:p%40ss%2F1@gateway.example.com:8080");
  });

  it("is a no-op when override matches the entry's existing protocol", () => {
    expect(proxyUrlWithCredentials(socksEntry, "socks5")).toBe(
      "socks5://alice:p%40ss%2F1@gateway.example.com:1080",
    );
  });

  it("rewrites socks5 → https when forceProxyProtocol points the fleet at https", () => {
    expect(proxyUrlWithCredentials(socksEntry, "https")).toBe(
      "https://alice:p%40ss%2F1@gateway.example.com:1080",
    );
  });

  it("falls back to the raw server when the URL is unparseable", () => {
    const broken: ProxyEntry = { server: "not a url", username: "u", password: "p" };
    expect(proxyUrlWithCredentials(broken, "socks5")).toBe("not a url");
  });
});

describe("forceSocks5 / forceHttp", () => {
  it("forces proxy protocol to SOCKS5", () => {
    const p = forceSocks5({ server: "http://gateway:8080", protocol: "http" });
    expect(p.protocol).toBe("socks5");
    expect(p.server).toBe("socks5://gateway:8080");
  });

  it("forces proxy protocol to HTTP", () => {
    const p = forceHttp({ server: "socks5://gateway:8080", protocol: "socks5" });
    expect(p.protocol).toBe("http");
    expect(p.server).toBe("http://gateway:8080");
  });
});

describe("applyProxyProtocolOverride (session propagation to Playwright)", () => {
  const sourceHttp: ProxyEntry = {
    server: "http://gateway.example.com:8080",
    username: "u",
    password: "p",
    protocol: "http",
  };

  it("returns the entry unchanged when no override is requested", () => {
    expect(applyProxyProtocolOverride(sourceHttp)).toBe(sourceHttp);
  });

  it("returns the entry unchanged when override matches the existing protocol", () => {
    expect(applyProxyProtocolOverride(sourceHttp, "http")).toBe(sourceHttp);
  });

  it("rewrites the server scheme to socks5 when forcing SOCKS5", () => {
    const out = applyProxyProtocolOverride(sourceHttp, "socks5");
    expect(out.server).toBe("socks5://gateway.example.com:8080");
    expect(out.protocol).toBe("socks5");
    expect(out.username).toBe("u");
    expect(out.password).toBe("p");
  });

  it("rewrites the server scheme to https when forcing HTTPS", () => {
    const out = applyProxyProtocolOverride(sourceHttp, "https");
    expect(out.server).toBe("https://gateway.example.com:8080");
    expect(out.protocol).toBe("https");
  });

  it("returns a fresh entry rather than mutating the input", () => {
    const out = applyProxyProtocolOverride(sourceHttp, "socks5");
    expect(out).not.toBe(sourceHttp);
    expect(sourceHttp.server).toBe("http://gateway.example.com:8080");
    expect(sourceHttp.protocol).toBe("http");
  });

  it("propagates correctly end-to-end: SDK proxyUrl and Playwright server agree", () => {
    // This mirrors what createSpiderLocalSession does when
    // forceProxyProtocol is on: the SDK side calls proxyUrlWithCredentials
    // with the override, the Playwright side passes the rewritten entry
    // to launchPersistentContext. Both must end up on the same scheme.
    const override = "socks5" as const;
    const sdkUrl = proxyUrlWithCredentials(sourceHttp, override);
    const playwrightProxy = applyProxyProtocolOverride(sourceHttp, override);
    expect(sdkUrl.startsWith("socks5://")).toBe(true);
    expect(playwrightProxy.server.startsWith("socks5://")).toBe(true);
  });
});

describe("loadSpiderSettings proxyProtocol / forceProxyProtocol (extra coverage)", () => {
  const KEYS = ["SPIDER_PROXY_PROTOCOL", "SPIDER_FORCE_PROXY_PROTOCOL"] as const;
  let original: Record<string, string | undefined>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    original = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
    for (const k of KEYS) delete process.env[k];
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => { });
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(original)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    warnSpy.mockRestore();
  });

  it("accepts SPIDER_PROXY_PROTOCOL=http explicitly without warning", () => {
    process.env.SPIDER_PROXY_PROTOCOL = "http";
    expect(loadSpiderSettings().proxyProtocol).toBe("http");
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("accepts SPIDER_PROXY_PROTOCOL=https explicitly", () => {
    process.env.SPIDER_PROXY_PROTOCOL = "https";
    expect(loadSpiderSettings().proxyProtocol).toBe("https");
  });

  it("treats SPIDER_FORCE_PROXY_PROTOCOL=false as false", () => {
    process.env.SPIDER_FORCE_PROXY_PROTOCOL = "false";
    expect(loadSpiderSettings().forceProxyProtocol).toBe(false);
  });

  it("treats SPIDER_FORCE_PROXY_PROTOCOL=1 as true", () => {
    process.env.SPIDER_FORCE_PROXY_PROTOCOL = "1";
    expect(loadSpiderSettings().forceProxyProtocol).toBe(true);
  });

  it("preserves proxyProtocol / forceProxyProtocol across mergeSpiderSettings", () => {
    const merged = mergeSpiderSettings(DEFAULT_SPIDER_SETTINGS, {
      proxyProtocol: "socks5",
      forceProxyProtocol: true,
    });
    expect(merged.proxyProtocol).toBe("socks5");
    expect(merged.forceProxyProtocol).toBe(true);
    // AU lock is independent and still enforced
    expect(merged.country).toBe("AU");
  });
});

describe("normalizeBackend", () => {
  it("returns spider-cloud for empty or undefined input", () => {
    expect(normalizeBackend(undefined)).toBe("spider-cloud");
    expect(normalizeBackend("")).toBe("spider-cloud");
    expect(normalizeBackend("  ")).toBe("spider-cloud");
  });

  it("maps cloak aliases to cloak-headed", () => {
    expect(normalizeBackend("cloak")).toBe("cloak-headed");
    expect(normalizeBackend("cloak-headed")).toBe("cloak-headed");
  });

  it("maps cloak-headless correctly", () => {
    expect(normalizeBackend("cloak-headless")).toBe("cloak-headless");
  });

  it("maps spider aliases to spider-cloud", () => {
    expect(normalizeBackend("spider")).toBe("spider-cloud");
    expect(normalizeBackend("spider-cloud")).toBe("spider-cloud");
  });

  it("maps other exact backends correctly", () => {
    expect(normalizeBackend("spider-local")).toBe("spider-local");
    expect(normalizeBackend("stealth")).toBe("stealth");
    expect(normalizeBackend("camofox")).toBe("stealth"); // typo alias

    expect(normalizeBackend("curl-api")).toBe("curl-api");
    expect(normalizeBackend("zendriver")).toBe("zendriver");
    expect(normalizeBackend("experimental")).toBe("experimental");
    expect(normalizeBackend("experimental-elimination")).toBe("experimental-elimination");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(normalizeBackend("golden-benchmark")).toBe("golden-benchmark" as any);
  });

  it("falls back to spider-cloud with warning for unknown backends", () => {
    // Suppress console.warn for this test
    const origWarn = console.warn;
    console.warn = () => {};
    expect(normalizeBackend("unknown-backend")).toBe("spider-cloud");
    console.warn = origWarn;
  });
});

describe("redactSpiderSettings", () => {
  it("redacts apiKey and localApiKey but keeps localEndpoint", () => {
    const s = { ...DEFAULT_SPIDER_SETTINGS, apiKey: "secret1", localApiKey: "secret2", localEndpoint: "http://localhost:8080" };
    const redacted = redactSpiderSettings(s);
    expect(redacted.apiKey).toBe("***");
    expect(redacted.localApiKey).toBe("***");
    expect(redacted.localEndpoint).toBe("http://localhost:8080");
  });

  it("does not add keys if they were undefined", () => {
    const s = { ...DEFAULT_SPIDER_SETTINGS };
    const redacted = redactSpiderSettings(s);
    expect(redacted.apiKey).toBeUndefined();
    expect(redacted.localApiKey).toBeUndefined();
  });
});

describe("AU hard-lock", () => {
  it("warns and forces AU when non-AU env vars are provided", () => {
    // Suppress console.warn for this test
    const origWarn = console.warn;
    console.warn = () => {};
    vi.stubEnv("SPIDER_CLOUD_COUNTRY", "US");
    vi.stubEnv("SPIDER_CLOUD_LOCALE", "en-US");
    const s = loadSpiderSettings();
    expect(s.country).toBe("AU");
    expect(s.locale).toBe("en-AU");
    vi.unstubAllEnvs();
    console.warn = origWarn;
  });
});
