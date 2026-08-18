import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as readline from "readline";
import * as cloakbrowser from "cloakbrowser";
import * as staticCache from "../../src/stealth/static-cache.js";

vi.mock("fs", () => {
  return {
    rmSync: vi.fn(),
    mkdirSync: vi.fn(),
    existsSync: vi.fn(),
    createReadStream: vi.fn(),
  };
});

vi.mock("readline", () => {
  return {
    createInterface: vi.fn(),
  };
});

vi.mock("cloakbrowser", () => {
  return {
    launchPersistentContext: vi.fn(),
  };
});

vi.mock("../../src/stealth/static-cache.js", () => {
  return {
    getStaticCacheDir: vi.fn().mockReturnValue("/mock/dir"),
    sanitizeStaticCacheProfile: vi.fn(),
  };
});

describe("warm-static-cache", () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.resetModules();
  });

  it("warms static cache using proxy from env var", async () => {
    process.env.AU_PROXY_URL = "http://user:pass@127.0.0.1:8080";
    
    const mockPage = {
      goto: vi.fn().mockResolvedValue(null),
      waitForLoadState: vi.fn().mockResolvedValue(null),
      evaluate: vi.fn().mockResolvedValue(null),
      context: () => ({
        clearCookies: vi.fn().mockResolvedValue(null),
      })
    };
    
    const mockContext = {
      pages: () => [mockPage],
      close: vi.fn().mockResolvedValue(null),
    };

     
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    vi.mocked(cloakbrowser.launchPersistentContext).mockResolvedValue(mockContext as any);

    await import("../../src/services/warm-static-cache.js?invalid1=" + Date.now());

    expect(fs.rmSync).toHaveBeenCalledWith("/mock/dir", { recursive: true, force: true });
    expect(fs.mkdirSync).toHaveBeenCalledWith("/mock/dir", { recursive: true });
    expect(cloakbrowser.launchPersistentContext).toHaveBeenCalledWith(expect.objectContaining({
      proxy: { server: "http://127.0.0.1:8080", username: "user", password: "pass" },
      userDataDir: "/mock/dir",
    }));
    expect(mockPage.goto).toHaveBeenCalled();
    expect(staticCache.sanitizeStaticCacheProfile).toHaveBeenCalledWith("/mock/dir");
  });

  it("handles errors gracefully", async () => {
    process.env.AU_PROXY_URL = "socks5://127.0.0.1:1080";
    
    const mockPage = {
      goto: vi.fn().mockRejectedValue(new Error("goto error")),
      waitForLoadState: vi.fn().mockRejectedValue(new Error("wait error")),
      evaluate: vi.fn().mockRejectedValue(new Error("eval error")),
      context: () => ({
        clearCookies: vi.fn().mockRejectedValue(new Error("clear error")),
      })
    };
    
    const mockContext = {
      pages: () => [],
      newPage: vi.fn().mockResolvedValue(mockPage),
      close: vi.fn().mockRejectedValue(new Error("close error")),
    };

     
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    vi.mocked(cloakbrowser.launchPersistentContext).mockResolvedValue(mockContext as any);

    await import("../../src/services/warm-static-cache.js?invalid2=" + Date.now());

    expect(cloakbrowser.launchPersistentContext).toHaveBeenCalled();
    expect(mockContext.newPage).toHaveBeenCalled();
    expect(mockPage.goto).toHaveBeenCalled();
    expect(staticCache.sanitizeStaticCacheProfile).toHaveBeenCalledWith("/mock/dir");
  });

  it("reads proxy from file", async () => {
    delete process.env.AU_PROXY_URL;
    process.env.AU_PROXY_FILE = "proxies.txt";
    
    vi.mocked(fs.existsSync).mockReturnValue(true);
    const mockStream = { on: vi.fn() };
     
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    vi.mocked(fs.createReadStream).mockReturnValue(mockStream as any);
    
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    vi.mocked(readline.createInterface).mockReturnValue({
      // eslint-disable-next-line @typescript-eslint/require-await
      [Symbol.asyncIterator]: async function* () {
        yield "192.168.1.1:80:user:pass";
      },
      close: vi.fn()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    const mockPage = {
      goto: vi.fn().mockResolvedValue(null),
      waitForLoadState: vi.fn().mockResolvedValue(null),
      evaluate: vi.fn().mockResolvedValue(null),
      context: () => ({
        clearCookies: vi.fn().mockResolvedValue(null),
      })
    };
    
    const mockContext = {
      pages: () => [mockPage],
      close: vi.fn().mockResolvedValue(null),
    };

     
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    vi.mocked(cloakbrowser.launchPersistentContext).mockResolvedValue(mockContext as any);

    await import("../../src/services/warm-static-cache.js?invalid3=" + Date.now());

    expect(cloakbrowser.launchPersistentContext).toHaveBeenCalledWith(expect.objectContaining({
      proxy: { server: "http://192.168.1.1:80", username: "user", password: "pass" }
    }));
  });
});
