import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import * as path from "path";
import { wipeStaticCacheNamespaces, getStaticCacheDir, sanitizeProfileDirectory, seedStaticAssetCache, UNSAFE_PROFILE_PATHS, SAFE_CACHE_PATHS } from "../../src/stealth/static-cache.js";

vi.mock("node:fs", () => ({
  default: {
    existsSync: vi.fn(),
    rmSync: vi.fn(),
    mkdirSync: vi.fn(),
    cpSync: vi.fn(),
    promises: { rm: vi.fn(), stat: vi.fn(), access: vi.fn(), mkdir: vi.fn(), cp: vi.fn() },
  },
  existsSync: vi.fn(),
  rmSync: vi.fn(),
  mkdirSync: vi.fn(),
  cpSync: vi.fn(),
  promises: { rm: vi.fn(), stat: vi.fn(), access: vi.fn(), mkdir: vi.fn(), cp: vi.fn() },
}));

// eslint-disable-next-line @typescript-eslint/require-await
describe("wipeStaticCacheNamespaces", async () => {
  const baseDir = getStaticCacheDir();

  // eslint-disable-next-line @typescript-eslint/require-await
  beforeEach(async () => {
    vi.clearAllMocks();
  });

  it("wipes by fingerprintSeed", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    const scope = { fingerprintSeed: 12345 };
    const { wiped } = await wipeStaticCacheNamespaces(scope);

    expect(wiped).toContain("seed:12345");
    expect(fs.promises.rm).toHaveBeenCalledWith(
      expect.stringContaining(path.join("seeds", "12345")),
      { recursive: true, force: true }
    );
  });

  it("wipes by proxyKey", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    const scope = { proxyKey: "http://test:user@pass" };
    const { wiped } = await wipeStaticCacheNamespaces(scope);

    expect(wiped).toContain("proxy:http://test:user@pass");
    const safeKey = "http://test:user@pass".replace(/[^A-Za-z0-9_.-]+/g, "_");
    expect(fs.promises.rm).toHaveBeenCalledWith(
      path.join(baseDir, "proxies", safeKey),
      { recursive: true, force: true }
    );
  });

  it("wipes both fingerprintSeed and proxyKey if provided", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    const scope = { proxyKey: "testproxy", fingerprintSeed: 999 };
    const { wiped } = await wipeStaticCacheNamespaces(scope);

    expect(wiped).toHaveLength(2);
    expect(wiped).toContain("seed:999");
    expect(wiped).toContain("proxy:testproxy");
    expect(fs.promises.rm).toHaveBeenCalledTimes(2);
  });

  it("skips directories that do not exist", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const scope = { proxyKey: "testproxy", fingerprintSeed: 999 };
    const { wiped } = await wipeStaticCacheNamespaces(scope);

    expect(wiped).toHaveLength(0);
    expect(fs.promises.rm).not.toHaveBeenCalled();
  });

  it("swallows errors and continues", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    // eslint-disable-next-line @typescript-eslint/require-await
    vi.mocked(fs.promises.rm).mockImplementationOnce(async () => {
      throw new Error("EPERM");
    });
    
    const scope = { proxyKey: "testproxy", fingerprintSeed: 999 };
    // The first one (seed) throws, but the second one (proxy) should still be processed
    const { wiped } = await wipeStaticCacheNamespaces(scope);

    expect(wiped).toHaveLength(1);
    expect(wiped).toContain("proxy:testproxy");
    expect(fs.promises.rm).toHaveBeenCalledTimes(2);
  });
});

describe("sanitizeProfileDirectory", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("removes unsafe paths from the profile directory", async () => {
    // eslint-disable-next-line @typescript-eslint/require-await
    vi.mocked(fs.promises.stat).mockImplementation(async (target: fs.PathLike) => {
      const targetStr = target.toString();
      if (targetStr.includes("Cookies") || targetStr.includes("History")) return {} as fs.Stats;
      throw new Error("ENOENT");
    });

    const result = await sanitizeProfileDirectory("/tmp/profile");
    
    expect(result.removed.length).toBeGreaterThan(0);
    expect(fs.promises.rm).toHaveBeenCalled();
    expect(fs.promises.rm).toHaveBeenCalledWith(expect.stringContaining("Cookies"), expect.anything());
  });

  it("surfaces errors gracefully without throwing", async () => {
    vi.mocked(fs.promises.stat).mockResolvedValue({} as fs.Stats);
    // eslint-disable-next-line @typescript-eslint/require-await
    vi.mocked(fs.promises.rm).mockImplementation(async () => {
      throw new Error("EACCES: permission denied");
    });

    const result = await sanitizeProfileDirectory("/tmp/profile");
    
    expect(result.removed).toHaveLength(0);
    expect(result.errors).toHaveLength(UNSAFE_PROFILE_PATHS.length);
    expect(result.errors[0]!.message).toContain("EACCES");
  });
});

describe("seedStaticAssetCache", () => {
  const dummyRelPath = path.join("dummy", "asset.png");

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CLOAK_STATIC_CACHE = "true";
    SAFE_CACHE_PATHS.push(dummyRelPath);
  });

  afterEach(() => {
    while (SAFE_CACHE_PATHS.length > 0) SAFE_CACHE_PATHS.pop();
  });

  it("returns false if static cache is disabled", async () => {
    process.env.CLOAK_STATIC_CACHE = "false";
    const result = await seedStaticAssetCache("/tmp/user-data", 123);
    expect(result).toBe(false);
  });

  it("returns false if global dir does not exist and seed dir does not exist", async () => {
    vi.mocked(fs.promises.access).mockRejectedValue(new Error("ENOENT"));
    const result = await seedStaticAssetCache("/tmp/user-data", 123);
    expect(result).toBe(false);
  });

  it("initializes seed cache from global cache if seed cache is missing", async () => {
    // Return true only for globalDir and its children, not for seedDir.
    // eslint-disable-next-line @typescript-eslint/require-await
    vi.mocked(fs.promises.access).mockImplementation(async (target: fs.PathLike) => {
      const p = target.toString();
      if (p.includes("seeds")) throw new Error("ENOENT"); // seedDir doesn't exist
      return; // globalDir exists
    });

    // Mock sanitizeProfileDirectory via stat failing so it just skips
    vi.mocked(fs.promises.stat).mockRejectedValue(new Error("ENOENT"));

    const result = await seedStaticAssetCache("/tmp/user-data", 123);
    
    // It should create the seed dir and copy the global asset to seed asset
    expect(fs.promises.mkdir).toHaveBeenCalledWith(expect.stringContaining("123"), { recursive: true });
    expect(fs.promises.cp).toHaveBeenCalledWith(
      expect.stringContaining(dummyRelPath),
      expect.stringContaining(dummyRelPath),
      expect.anything()
    );
    // Since seed dir didn't exist at check time, it falls back to globalDir as sourceDir
    // And it copies to userDataDir
    expect(result).toBe(true);
  });

  it("uses existing seed cache if present and copies assets to user data dir", async () => {
    // Everything exists
    vi.mocked(fs.promises.access).mockResolvedValue(undefined);
    vi.mocked(fs.promises.stat).mockRejectedValue(new Error("ENOENT")); // skip sanitize

    const result = await seedStaticAssetCache("/tmp/user-data", 456);
    
    expect(result).toBe(true);
    // It shouldn't need to create the seed dir since it exists
    const mkdirCalls = vi.mocked(fs.promises.mkdir).mock.calls;
    // The only mkdir should be for the destination dirname
    expect(mkdirCalls.every(call => !call[0].toString().endsWith("456"))).toBe(true);
    // It copies the asset to user-data
    expect(fs.promises.cp).toHaveBeenCalledWith(
      expect.stringContaining(dummyRelPath),
      expect.stringContaining(dummyRelPath),
      expect.anything()
    );
  });

  it("returns false if no assets are actually found to copy", async () => {
    // Both directories exist, but the assets do not
    // eslint-disable-next-line @typescript-eslint/require-await
    vi.mocked(fs.promises.access).mockImplementation(async (target: fs.PathLike) => {
      const p = target.toString();
      if (p.includes(dummyRelPath)) throw new Error("ENOENT");
      return;
    });

    const result = await seedStaticAssetCache("/tmp/user-data", 123);
    expect(result).toBe(false);
  });
});
