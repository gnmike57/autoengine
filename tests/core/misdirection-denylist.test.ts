/**
 * Tests for MisdirectionDenylist.
 *
 * Verifies that burns are keyed by the unique sticky-session identifier
 * (`server#username`) rather than the bare gateway host:port, so a burn on
 * one sticky session does not quarantine every entry sharing the gateway.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { MisdirectionDenylist } from "../../src/core/misdirection-denylist.js";

describe("MisdirectionDenylist", () => {
  let tmpDir: string;
  let dl: MisdirectionDenylist;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "misdirection-denylist-test-"));
    dl = new MisdirectionDenylist();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("burns a proxyKey and reports it as burned", () => {
    const r = dl.burn({ proxyKey: "http://gw:8080#sticky-a" });
    expect(r.burnedProxy).toBe(true);
    expect(r.burnedSeed).toBe(false);
    expect(dl.isProxyBurned("http://gw:8080#sticky-a")).toBe(true);
  });

  it("burns a fingerprint seed and reports it as burned", () => {
    const r = dl.burn({ fingerprintSeed: 12345 });
    expect(r.burnedSeed).toBe(true);
    expect(dl.isFingerprintBurned(12345)).toBe(true);
  });

  it("scopes burns to the sticky-session key, not the gateway host:port", () => {
    // Two sticky sessions sharing the same gateway — burning one must leave
    // the other usable. This is the entire reason for the proxyKey switch.
    dl.burn({ proxyKey: "http://gw:8080#sticky-a" });
    expect(dl.isProxyBurned("http://gw:8080#sticky-a")).toBe(true);
    expect(dl.isProxyBurned("http://gw:8080#sticky-b")).toBe(false);
    expect(dl.isProxyBurned("http://gw:8080#sticky-c")).toBe(false);
  });

  it("burn is idempotent — second burn on the same key returns burnedProxy=false", () => {
    expect(dl.burn({ proxyKey: "http://gw:8080#sticky-a" }).burnedProxy).toBe(true);
    expect(dl.burn({ proxyKey: "http://gw:8080#sticky-a" }).burnedProxy).toBe(false);
  });

  it("ignores empty / undefined proxyKey", () => {
    expect(dl.burn({}).burnedProxy).toBe(false);
    expect(dl.burn({ proxyKey: "" }).burnedProxy).toBe(false);
    expect(dl.isProxyBurned(undefined)).toBe(false);
    expect(dl.isProxyBurned("")).toBe(false);
  });

  it("getBurnedProxies returns the stored sticky-session keys", () => {
    dl.burn({ proxyKey: "http://gw:8080#a" });
    dl.burn({ proxyKey: "http://gw:8080#b" });
    expect(new Set(dl.getBurnedProxies())).toEqual(new Set([
      "http://gw:8080#a",
      "http://gw:8080#b",
    ]));
  });

  it("save/load round-trips burned keys and seeds", async () => {
    const file = path.join(tmpDir, "misdirection-denylist.json");
    dl.burn({ proxyKey: "http://gw:8080#sticky-a", fingerprintSeed: 7 });
    dl.burn({ proxyKey: "http://gw:9090#sticky-z" });
    await dl.save(file);

    const fresh = new MisdirectionDenylist();
    fresh.load(file);
    expect(fresh.isProxyBurned("http://gw:8080#sticky-a")).toBe(true);
    expect(fresh.isProxyBurned("http://gw:9090#sticky-z")).toBe(true);
    // Cousin sticky session on a burned gateway is NOT poisoned.
    expect(fresh.isProxyBurned("http://gw:8080#sticky-b")).toBe(false);
    expect(fresh.isFingerprintBurned(7)).toBe(true);
  });

  it("load is a no-op when the sidecar file does not exist", () => {
    dl.load(path.join(tmpDir, "nope.json"));
    expect(dl.size()).toEqual({ proxies: 0, seeds: 0 });
  });

  it("size reflects both proxy and seed counts", () => {
    dl.burn({ proxyKey: "p#1" });
    dl.burn({ proxyKey: "p#2" });
    dl.burn({ fingerprintSeed: 1 });
    expect(dl.size()).toEqual({ proxies: 2, seeds: 1 });
  });
});
