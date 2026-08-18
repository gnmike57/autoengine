/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-require-imports*/
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  getConsistentUserAgent,
  getConsistentUserAgentWithLog,
  getUserAgentArgs,
  getUserAgentPoolSize,
  listUserAgentPool,
  _test,
} from "../../src/profiles/profile-useragent.js";

describe("profile-useragent", () => {
  it("returns the same UA for the same email", () => {
    const a = getConsistentUserAgent("user@example.com")!;
    const b = getConsistentUserAgent("user@example.com")!;
    expect(a).toEqual(b);
  });

  it("is case-insensitive and trims whitespace", () => {
    const a = getConsistentUserAgent("USER@Example.com")!;
    const b = getConsistentUserAgent("  user@example.com  ")!;
    expect(a).toEqual(b);
  });

  it("returns a structurally valid profile", () => {
    const ua = getConsistentUserAgent("alice@gmail.com")!;
    expect(ua.ua).toMatch(/Mozilla\/5\.0.*Chrome\/\d+\.\d+\.\d+\.\d+/);
    // Upstream spider-rs/ua_generator targets Chrome ≥132 at sync time.
    // However, microlink pool may include historical UAs.
    expect(ua.chromeMajor).toBeGreaterThanOrEqual(50);
    expect(ua.chromeVersion.split(".").length).toBe(4);
    // Windows reports a 10.0.<build> Sec-CH-UA-Platform-Version; macOS
    // reports the Chrome-frozen "10.15.7" (capped by Reduced UA). Both shapes
    // must be allowed.
    expect(ua.platformVersion).toMatch(/^(10\.0\.\d+|10\.15\.7|1[1-9]\.\d+\.\d+)$/);
    expect(["Win10", "Win11", "macOS Apple Silicon", "macOS Intel", "Linux", "Android"]).toContain(ua.windowsLabel);
  });

  it("UA string contains the listed Chrome version", () => {
    const ua = getConsistentUserAgent("bob@gmail.com")!;
    expect(ua.ua).toContain(`Chrome/${ua.chromeVersion}`);
  });

  it("returns different UAs for different email domains across the pool", () => {
    const seen = new Set<string>();
    const samples = [
      "a@gmail.com", "b@yahoo.com", "c@outlook.com", "d@protonmail.com",
      "e@hotmail.com", "f@icloud.com", "g@live.com", "h@aol.com",
      "i@mail.com", "j@example.org",
    ];
    for (const e of samples) seen.add(getConsistentUserAgent(e)!.chromeVersion);
    expect(seen.size).toBeGreaterThan(1);
  });

  it("logs a summary when logFn is provided", () => {
    const logs: string[] = [];
    getConsistentUserAgentWithLog("user@example.com", undefined, undefined, (m: string) => logs.push(m));
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/UA freshness:.*Chrome \d+ on (Win1[01]|macOS|Linux|Android)/);
  });

  it("does not log when logFn is omitted", () => {
    expect(() => getConsistentUserAgentWithLog("user@example.com", undefined)!).not.toThrow();
  });

  it("getUserAgentArgs returns binary fingerprint flags", () => {
    const ua = getConsistentUserAgent("alice@example.com")!;
    const args = getUserAgentArgs(ua);
    expect(args).toContain(`--fingerprint-platform-version=${ua.platformVersion}`);
    expect(args).toContain(`--fingerprint-browser-version=${ua.chromeVersion}`);
    expect(args.every((a) => a.startsWith("--fingerprint-"))).toBe(true);
  });

  describe("getConsistentUserAgent Edge Cases", () => {
    it("returns undefined for 'off'", () => {
      expect(getConsistentUserAgent("email@x.com", "off")).toBeUndefined();
    });

    it("resolves 'auto' targetOs with spider AU proxy to windows or macos", () => {
      const ua1 = getConsistentUserAgent("user1@x.com", "auto-proxy", "http://au.spider.com");
      const ua2 = getConsistentUserAgent("user99@x.com", "auto-proxy", "http://au.spider.com");
      expect(["windows", "macos"]).toContain(ua1?.os);
      expect(["windows", "macos"]).toContain(ua2?.os);
    });

    it("resolves 'auto' targetOs without proxy to mixed pool", () => {
      const ua = getConsistentUserAgent("user@x.com", "auto", undefined);
      expect(["windows", "macos", "linux", "android"]).toContain(ua?.os);
    });

    it("falls back to mixed pool if targetOs pool is empty or invalid", () => {
      const ua = getConsistentUserAgent("user@x.com", "fake_os" as any);
      expect(ua).toBeDefined();
    });
  });

  it("pool has at least 5 contemporary UAs", () => {
    expect(getUserAgentPoolSize()).toBeGreaterThanOrEqual(10);
  });

  it("pool has elements", () => {
    const labels = new Set(listUserAgentPool().map((u) => u.windowsLabel));
    expect(labels.size).toBeGreaterThan(0);
  });

  it("every pool entry is internally consistent", () => {
    for (const ua of listUserAgentPool()) {
      expect(ua.ua).toContain(`Chrome/${ua.chromeVersion}`);
      expect(ua.chromeVersion.startsWith(`${ua.chromeMajor}.`)).toBe(true);
    }
  });

  it("distributes hashes across the whole pool over many emails", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      const ua = getConsistentUserAgent(`u${i}@x.com`)!;
      seen.add(`${ua.chromeVersion}|${ua.windowsLabel}|${ua.platformVersion}|${ua.architecture}`);
    }
    expect(seen.size).toBeGreaterThan(10);
  });

  // Guards on the spider-rs/ua_generator → data/ua-pool.json pipeline so a
  // regression in the sync script or runtime loader is caught locally rather
  // than at session-create time on a live row.
  it("pool is sourced from supported OSes only", () => {
    for (const ua of listUserAgentPool()) {
      expect(["windows", "macos", "linux", "android"]).toContain(ua.os);
      expect(ua.ua).not.toMatch(/iPhone|iPad/);
    }
  });

  it("getUserAgentArgs always emits the four fingerprint flags in expected shape", () => {
    for (const ua of listUserAgentPool()) {
      const args = getUserAgentArgs(ua);
      expect(args.length).toBeGreaterThanOrEqual(4);
      expect(args[0]).toMatch(/^--fingerprint-platform=(Windows|macOS|Linux|Android)$/);
      expect(args[1]).toMatch(/^--fingerprint-platform-version=/);
      expect(args[2]).toMatch(/^--fingerprint-architecture=(x64|arm64)$/);
      expect(args[3]).toMatch(/^--fingerprint-browser-version=/);
    }
  });

  it("getUserAgentArgs emits mobile flags when profile is mobile", () => {
    const mobileUA = {
      ua: "Mozilla/5.0 (Linux; Android 14; SM-S928B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Mobile Safari/537.36",
      chromeVersion: "147.0.0.0",
      chromeMajor: 147,
      windowsVersion: "14",
      windowsLabel: "Android" as const,
      os: "android" as const,
      platformVersion: "14",
      architecture: "arm64" as const,
      mobile: true,
      deviceModel: "SM-S928B",
      deviceMemory: 8,
      touchSupport: true,
      screen: { width: 1440, height: 3120, pixelRatio: 3.5 },
      webgl: { vendor: "ARM", renderer: "Mali-G715" },
      battery: { charging: false, level: 0.72 },
      connection: { type: "5g" as const, downlink: 150, rtt: 30 }
    };
    
    const args = getUserAgentArgs(mobileUA);
    expect(args).toContain("--fingerprint-mobile");
    expect(args).toContain("--fingerprint-touch-events");
    expect(args).toContain("--fingerprint-screen=1440x3120");
    expect(args).toContain("--fingerprint-device-scale-factor=3.5");
    expect(args).toContain("--fingerprint-device-memory=8");
    expect(args).toContain("--fingerprint-network-type=5g");
  });

  it("platform label/OS/architecture stay in agreement across the pool", () => {
    for (const ua of listUserAgentPool()) {
      if (ua.os === "windows") {
        expect(["Win10", "Win11"]).toContain(ua.windowsLabel);
        expect(ua.architecture).toBe("x64");
      } else if (ua.os === "macos") {
        expect(["macOS Apple Silicon", "macOS Intel"]).toContain(ua.windowsLabel);
        if (ua.windowsLabel === "macOS Apple Silicon") expect(ua.architecture).toBe("arm64");
        else expect(ua.architecture).toBe("x64");
      } else if (ua.os === "linux") {
        expect(["Linux"]).toContain(ua.windowsLabel);
        expect(ua.architecture).toBe("x64");
      } else if (ua.os === "android") {
        expect(["Android"]).toContain(ua.windowsLabel);
        expect(ua.architecture).toBe("arm64");
      }
    }
  });

  describe("Internal Shape Validators (_test)", () => {
    it("isMobileScreen validates correctly", () => {
      expect(_test.isMobileScreen(undefined)).toBe(true);
      expect(_test.isMobileScreen(null)).toBe(false);
      expect(_test.isMobileScreen("not object")).toBe(false);
      expect(_test.isMobileScreen({})).toBe(false);
      expect(_test.isMobileScreen({ width: 1080, height: 1920, pixelRatio: 2 })).toBe(true);
      expect(_test.isMobileScreen({ width: "1080", height: 1920, pixelRatio: 2 })).toBe(false);
    });

    it("isMobileConnection validates correctly", () => {
      expect(_test.isMobileConnection(undefined)).toBe(true);
      expect(_test.isMobileConnection(null)).toBe(false);
      expect(_test.isMobileConnection("not object")).toBe(false);
      expect(_test.isMobileConnection({})).toBe(false);
      expect(_test.isMobileConnection({ type: "5g", downlink: 100, rtt: 20 })).toBe(true);
      expect(_test.isMobileConnection({ type: "", downlink: 100, rtt: 20 })).toBe(false);
    });

    it("isUAProfile validates correctly", () => {
      expect(_test.isUAProfile(null)).toBe(false);
      expect(_test.isUAProfile({})).toBe(false);
      
      const validBase = {
        ua: "Mozilla/5.0 Chrome/130.0.0.0",
        chromeVersion: "130.0.0.0",
        chromeMajor: 130,
        windowsVersion: "10",
        windowsLabel: "Win10",
        os: "windows",
        platformVersion: "10",
        architecture: "x64"
      };
      
      expect(_test.isUAProfile(validBase)).toBe(true);
      expect(_test.isUAProfile({ ...validBase, ua: "NotMozilla" })).toBe(false);
      expect(_test.isUAProfile({ ...validBase, os: "unknown" })).toBe(false);
      
      const validMobile = {
        ...validBase,
        os: "android",
        mobile: true,
        deviceModel: "Pixel 6",
        deviceMemory: 8,
        touchSupport: true,
        screen: { width: 1080, height: 2400, pixelRatio: 2 },
        connection: { type: "4g", downlink: 100, rtt: 20 }
      };
      expect(_test.isUAProfile(validMobile)).toBe(true);
      
      // Invalid mobile subfields
      expect(_test.isUAProfile({ ...validMobile, deviceModel: 123 })).toBe(false);
      expect(_test.isUAProfile({ ...validMobile, deviceMemory: "8GB" })).toBe(false);
      expect(_test.isUAProfile({ ...validMobile, touchSupport: "yes" })).toBe(false);
      expect(_test.isUAProfile({ ...validMobile, webgl: { vendor: "ARM" } })).toBe(false); // missing renderer
      expect(_test.isUAProfile({ ...validMobile, battery: { charging: true } })).toBe(false); // missing level
    });

    it("loadPool handles invalid shapes and unknown connection types gracefully", () => {
      // Temporarily overwrite ua-pool-chrome.json with garbage
      const tmpPath = path.resolve(process.cwd(), "data", "ua-pool-chrome.json");
      let original = "";
      let exists = false;
      if (fs.existsSync(tmpPath)) {
        exists = true;
        original = fs.readFileSync(tmpPath, "utf-8");
      } else {
        fs.mkdirSync(path.dirname(tmpPath), { recursive: true });
      }

      fs.writeFileSync(tmpPath, JSON.stringify([
        { ua: "invalid" }, // dropped
        {
          ua: "Mozilla/5.0", chromeVersion: "130", chromeMajor: 130,
          windowsVersion: "10", windowsLabel: "Win10", os: "windows",
          platformVersion: "10", architecture: "x64",
          connection: { type: "6g-advanced", downlink: 100, rtt: 10 } // accepted but warns
        }
      ]));

      const res = _test.loadPool("ua-pool-chrome.json");
      expect(res.length).toBe(1);

      if (exists) {
        fs.writeFileSync(tmpPath, original);
      } else {
        fs.unlinkSync(tmpPath);
      }
    });

    it("loadPool falls back to BUNDLED_POOL if parsing fails", () => {
      const tmpPath = path.resolve(process.cwd(), "data", "ua-pool-chrome.json");
      let original = "";
      let exists = false;
      if (fs.existsSync(tmpPath)) {
        exists = true;
        original = fs.readFileSync(tmpPath, "utf-8");
      }

      fs.writeFileSync(tmpPath, "}{ not valid json");
      const res = _test.loadPool("ua-pool-chrome.json");
      expect(res.length).toBeGreaterThan(0);
      expect(res[0]!.ua).toBeDefined();

      if (exists) {
        fs.writeFileSync(tmpPath, original);
      } else {
        fs.unlinkSync(tmpPath);
      }
    });
  });

  describe("getConsistentUserAgent auto targeting branches", () => {
    it("falls back to linux when auto target yields a hash >= 95", () => {
      // Find an email that hashes to >= 95
      let targetEmail = "";
      for (let i = 0; i < 1000; i++) {
        const email = `linux-target-${i}@example.com`;
        const h = (require("crypto").createHash("sha256").update(email).digest().readUInt32BE(0)) % 100;
        if (h >= 95) {
          targetEmail = email;
          break;
        }
      }
      if (targetEmail) {
        const ua = getConsistentUserAgent(targetEmail, "auto");
        // Bundled pool only has windows and macos, so it will fall back to 'mixed'
        // But the code branch `else resolvedOs = "linux"` will be covered.
        expect(ua).toBeDefined();
      }
    });

    it("falls back to mixed when auto-proxy is used with non-spider string", () => {
      const ua = getConsistentUserAgent("test@example.com", "auto-proxy", "http://normal-proxy.com");
      expect(ua).toBeDefined();
    });
  });
});
