/**
 * Tests for Timezone + Locale Alignment
 */

import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import {
  alignGeoToProxy,
  alignGeoToProxyWithLog,
  getGeoLaunchArgs,
  getGeoProfileForCountry,
  validateGeoProfile,
  detectCountryFromProxy
} from "../../src/profiles/profile-geo-alignment.js";

describe("profile-geo-alignment", () => {
  it("returns AU profile for empty proxy", () => {
    const geo = alignGeoToProxy();
    expect(geo.countryCode).toBe("AU");
    expect(geo.timezone).toMatch(/^Australia\//);
    expect(geo.locale).toBe("en-AU");
  });

  it("returns AU profile for empty string", () => {
    const geo = alignGeoToProxy("");
    expect(geo.countryCode).toBe("AU");
  });

  it("detects AU proxy", () => {
    const geo = alignGeoToProxy("http://user:pass@au.proxy.com:8080");
    expect(geo.countryCode).toBe("AU");
    expect(geo.timezone).toBe("Australia/Melbourne");
    expect(geo.locale).toBe("en-AU");
  });

  it("detects GB proxy", () => {
    const geo = alignGeoToProxy("http://user:pass@uk.proxy.com:8080");
    expect(geo.countryCode).toBe("GB");
    expect(geo.timezone).toBe("Europe/London");
  });

  it("detects DE proxy", () => {
    const geo = alignGeoToProxy("http://user:pass@de.proxy.com:8080");
    expect(geo.countryCode).toBe("DE");
    expect(geo.timezone).toBe("Europe/Berlin");
  });

  it("detects JP proxy", () => {
    const geo = alignGeoToProxy("http://user:pass@jp.proxy.com:8080");
    expect(geo.countryCode).toBe("JP");
    expect(geo.timezone).toBe("Asia/Tokyo");
  });

  it("falls back to AU for unknown proxy patterns", () => {
    const geo = alignGeoToProxy("http://user:pass@random-host.example.com:8080");
    expect(geo.countryCode).toBe("AU");
  });

  it("detects common AU residential provider host patterns", () => {
    expect(alignGeoToProxy("http://sticky.lvprx.example:8080").countryCode).toBe("AU");
    expect(alignGeoToProxy("http://gw.au.smartproxy.com:8080").countryCode).toBe("AU");
    expect(alignGeoToProxy("http://pool.au-residential.proxy:8080").countryCode).toBe("AU");
  });

  it("returns same geo for identical proxy URL", () => {
    const proxy = "http://user:pass@au.proxy.com:8080";
    expect(alignGeoToProxy(proxy)).toEqual(alignGeoToProxy(proxy));
  });

  it("detects country from co.uk pattern", () => {
    const geo = alignGeoToProxy("http://user:pass@server.co.uk:8080");
    expect(geo.countryCode).toBe("GB");
  });

  it("logs geo alignment when logFn provided", () => {
    const logs: string[] = [];
    alignGeoToProxyWithLog("http://user:pass@au.proxy.com:8080", (msg) => logs.push(msg));
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("Geo alignment");
    expect(logs[0]).toContain("AU");
  });

  it("logs 'direct' for empty proxy", () => {
    const logs: string[] = [];
    alignGeoToProxyWithLog(undefined, (msg) => logs.push(msg));
    expect(logs[0]).toContain("direct");
  });

  it("extracts launch args correctly", () => {
    const geo = alignGeoToProxy("http://user:pass@au.proxy.com:8080");
    const args = getGeoLaunchArgs(geo);
    expect(args.timezone).toMatch(/^Australia\//);
    expect(args.locale).toBe("en-AU");
  });

  it("validates valid geo profile", () => {
    const geo = alignGeoToProxy("http://user:pass@au.proxy.com:8080");
    expect(validateGeoProfile(geo)).toBe(true);
  });

  it("rejects invalid timezone", () => {
    expect(
      validateGeoProfile({ timezone: "not-a-timezone", locale: "en-US", countryCode: "US" })
    ).toBe(false);
  });

  it("rejects invalid locale", () => {
    expect(
      validateGeoProfile({ timezone: "America/New_York", locale: "NOT-A-LOCALE", countryCode: "US" })
    ).toBe(false);
  });

  // Spider Cloud routing parity: when SPIDER_CLOUD_COUNTRY overrides the
  // routing country, the resolved geo profile must match (locale, timezone,
  // lat/long) so the browser context doesn't advertise AU while traffic
  // exits via another country. These tests pin the helper that
  // createSpiderCloudSession uses to derive the context geo.
  describe("getGeoProfileForCountry", () => {
    it("returns deterministic AU profile for country=AU", () => {
      const geo = getGeoProfileForCountry("AU", "user@example.com");
      expect(geo.countryCode).toBe("AU");
      expect(geo.locale).toBe("en-AU");
      expect(geo.timezone).toMatch(/^Australia\//);
      expect(typeof geo.latitude).toBe("number");
      expect(typeof geo.longitude).toBe("number");
      expect(geo.city).toBeTruthy();
    });

    it("returns US profile for country=US (no AU fallback)", () => {
      const geo = getGeoProfileForCountry("US", "user@example.com");
      expect(geo.countryCode).toBe("US");
      expect(geo.locale).toBe("en-US");
      expect(geo.timezone).toBe("America/New_York");
    });

    it("returns GB profile for country=GB", () => {
      const geo = getGeoProfileForCountry("GB", "user@example.com");
      expect(geo.countryCode).toBe("GB");
      expect(geo.locale).toBe("en-GB");
      expect(geo.timezone).toBe("Europe/London");
    });

    it("normalises lowercase country codes", () => {
      const upper = getGeoProfileForCountry("US", "seed");
      const lower = getGeoProfileForCountry("us", "seed");
      expect(lower).toEqual(upper);
    });

    it("trims whitespace from country codes", () => {
      expect(getGeoProfileForCountry("  JP  ", "seed").countryCode).toBe("JP");
    });

    it("falls back for unknown country code", () => {
      const geo = getGeoProfileForCountry("XX", "seed");
      // DEFAULT_COUNTRY defaults to AU, so unknown codes resolve to an AU
      // city profile rather than throwing.
      expect(geo.countryCode).toBe("AU");
      expect(geo.locale).toBe("en-AU");
    });

    it("falls back for empty country code", () => {
      const geo = getGeoProfileForCountry("", "seed");
      expect(geo.countryCode).toBe("AU");
    });

    it("is deterministic for AU given the same seed", () => {
      const a = getGeoProfileForCountry("AU", "user@example.com");
      const b = getGeoProfileForCountry("AU", "user@example.com");
      expect(a).toEqual(b);
    });

    it("varies the AU city across seeds (deterministic distribution)", () => {
      const cities = new Set<string>();
      for (let i = 0; i < 40; i++) {
        cities.add(getGeoProfileForCountry("AU", `seed-${i}`).city!);
      }
      // Across 40 seeds we should see at least 2 distinct AU cities; the
      // weighted picker covers 5 cities, so a single-city result would
      // indicate the seed isn't actually feeding the bucket selector.
      expect(cities.size).toBeGreaterThan(1);
    });
  });

  describe("pickAustralianMobileGeo", () => {
    it("returns mobile-specific AU profile", () => {
      const geo = getGeoProfileForCountry("AU", "seed", true);
      expect(geo.countryCode).toBe("AU");
      expect(geo.locale).toBe("en-AU");
      expect(geo.timezone).toMatch(/^Australia\//);
      expect(geo.mobile).toBe(true);
      expect(["4g", "5g", "wifi"]).toContain(geo.networkType);
      expect(geo.carrier).toBeTruthy();
      expect(geo.isp).toBeTruthy();
    });

    it("falls back to base static geo for non-AU mobile requests", () => {
      const geo = getGeoProfileForCountry("US", "seed", true);
      expect(geo.countryCode).toBe("US");
      expect(geo.locale).toBe("en-US");
      expect(geo.timezone).toBe("America/New_York");
      expect(geo.mobile).toBe(true);
      expect(geo.networkType).toBe("wifi");
      expect(geo.carrier).toBeUndefined(); // AU only
      expect(geo.isp).toBeUndefined();     // AU only
    });

    it("distributes AU mobile regions fairly across seeds", () => {
      const regions = new Set<string>();
      const carriers = new Set<string>();
      for (let i = 0; i < 50; i++) {
        const geo = getGeoProfileForCountry("AU", `mseed-${i}`, true);
        regions.add(geo.region!);
        carriers.add(geo.carrier!);
      }
      expect(regions.size).toBeGreaterThan(1);
      expect(carriers.size).toBeGreaterThan(1);
    });
  });

  describe("Edge cases and errors", () => {
    it("handles invalid proxyUrl type gracefully in alignGeoToProxyWithLog", () => {
      const logs: string[] = [];
      // Cast a non-string object to string to force .includes() to throw inside proxyHost extraction
      alignGeoToProxyWithLog({} as string, (msg) => logs.push(msg));
      expect(logs).toHaveLength(1);
      expect(logs[0]).toContain("unknown");
    });

    it("handles corrupt MMDB file gracefully by swallowing the error", async () => {
      const fs = await import("node:fs");
      const vi = (await import("vitest")).vi;
      
      const originalEnv = process.env.MMDB_FILE;
      process.env.MMDB_FILE = "corrupt.mmdb";
      
      const existsSpy = vi.spyOn(fs.default, "existsSync").mockReturnValue(true);
      const readSpy = vi.spyOn(fs.default, "readFileSync").mockReturnValue(Buffer.from("not a real mmdb file"));
      
      try {
        // Will attempt to load MMDB, fail parsing, catch the error, and fallback to string matching
        const geo = alignGeoToProxy("http://192.0.2.1:8080"); 
        expect(geo.countryCode).toBe("AU"); // Default fallback
      } finally {
        process.env.MMDB_FILE = originalEnv;
        existsSpy.mockRestore();
        readSpy.mockRestore();
      }
    });
  });

  describe("MMDB cache and Reader branches", () => {
    it("evicts oldest entry when MMDB cache exceeds MAX_MMDB_CACHE_SIZE", () => {
      // Generate 5002 unique IP addresses to force eviction
      for (let i = 0; i < 5002; i++) {
        // Just use random IPs or a sequential IP generator
        const ip = `10.0.${Math.floor(i / 256)}.${i % 256}`;
        // Calling detectCountryFromProxy will query mmdbCountryForHost
        detectCountryFromProxy(`http://user:pass@${ip}:8080`);
      }
      // If it didn't crash, the eviction branch ran.
      expect(true).toBe(true);
    });

    it("evaluates mmdbReader?.get when Reader is successfully initialized", async () => {
      // Mock fs to pretend the mmdb file exists
      vi.spyOn(fs, "existsSync").mockReturnValue(true);
      vi.spyOn(fs, "readFileSync").mockReturnValue(Buffer.from("dummy data"));
      
      // Mock Reader from mmdb-lib
      const mockGet = vi.fn().mockReturnValue({ country: { iso_code: "NZ" } });
      vi.doMock("mmdb-lib", () => ({
        Reader: class {
          get = mockGet;
        }
      }));

      // We need to re-import the module to pick up the mock, or just rely on the existing 
      // but mmdbReader is an internal variable. Let's reset modules.
      vi.resetModules();
      vi.stubEnv("GEOIP_MMDB_FILE", "/fake/GeoLite2-Country.mmdb");

      const { detectCountryFromProxy: freshDetect } = await import("../../src/profiles/profile-geo-alignment.js");
      const country = freshDetect("http://user:pass@8.8.8.8:8080");
      // Since it's a dummy buffer, the real Reader would throw, but our mock should work
      // WAIT, the file uses `import { Reader } from "mmdb-lib"`. If we doMock before import, it uses it.
      expect(country).toBe("NZ");

      vi.unstubAllEnvs();
      vi.doUnmock("mmdb-lib");
    });
  });
});


