/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument*/
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { BrowserTiler, disableBookmarksBar } from "../../src/services/browser-tiler.js";
import { ConfigStore } from "../../src/core/config-store.js";
import { windowManager } from "node-window-manager";
import fs from "node:fs";

vi.mock("../../src/core/config-store.js", () => ({
  ConfigStore: {
    load: vi.fn(),
  }
}));

vi.mock("node-window-manager", () => ({
  windowManager: {
    getMonitors: vi.fn(),
    getWindows: vi.fn(),
  }
}));

vi.mock("node:fs", () => {
  return {
    default: {
      existsSync: vi.fn(),
      readFileSync: vi.fn(),
      writeFileSync: vi.fn(),
      mkdirSync: vi.fn()
    }
  };
});

vi.mock("node:child_process", () => {
  return {
    execFileSync: vi.fn(),
    spawn: vi.fn()
  };
});

describe("browser-tiler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(ConfigStore.load).mockReturnValue({ tilingLayout: "auto" } as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("BrowserTiler class", () => {
    it("initializes with totalWindows", () => {
      const tiler = new BrowserTiler(5);
      expect(tiler.getTotalWindows()).toBe(5);
    });

    it("acquires and releases slots correctly", async () => {
      const tiler = new BrowserTiler(2);
      const s1 = await tiler.acquireSlot();
      const s2 = await tiler.acquireSlot();
      
      expect(s1).toBe(0);
      expect(s2).toBe(1);

      // Next acquire should wait
      const s3Promise = tiler.acquireSlot();
      let resolved = false;
      // eslint-disable-next-line @typescript-eslint/no-floating-promises
      s3Promise.then(() => { resolved = true; });
      
      // Wait a tick
      await new Promise(r => setTimeout(r, 0));
      expect(resolved).toBe(false);

      tiler.releaseSlot(s1);
      
      const s3 = await s3Promise;
      expect(s3).toBe(0); // Gets the released slot
      expect(resolved).toBe(true);
    });

    it("reconfigures total windows up and down", () => {
      const tiler = new BrowserTiler(2);
      tiler.reconfigure(4);
      expect(tiler.getTotalWindows()).toBe(4);
      
      tiler.reconfigure(1);
      expect(tiler.getTotalWindows()).toBe(1);
    });

    it("returns null for os-native layout", async () => {
      vi.mocked(ConfigStore.load).mockReturnValue({ tilingLayout: "os-native" } as any);
      const tiler = new BrowserTiler(1);
      const bounds = await tiler.getBounds(0);
      expect(bounds).toBeNull();
    });

    it("calculates grid correctly for auto layout", async () => {
      vi.mocked(ConfigStore.load).mockReturnValue({ tilingLayout: "auto" } as any);
      vi.mocked(windowManager.getMonitors).mockReturnValue([
        { getBounds: () => ({ x: 0, y: 0, width: 1920, height: 1080 }) }
      ] as any);

      const tiler = new BrowserTiler(4); // 2x2 grid
      const bounds0 = await tiler.getBounds(0);
      expect(bounds0).not.toBeNull();
      // For 4 windows, auto layout forces 1x4 grid
      expect(bounds0!.width).toBeGreaterThan(300);
      expect(bounds0!.width).toBeLessThan(600);
      expect(bounds0!.height).toBeGreaterThan(900);
      expect(bounds0!.height).toBeLessThan(1100);
    });
  });

  describe("disableBookmarksBar", () => {
    it("creates dir and writes to Preferences if none exists", () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      
      disableBookmarksBar("/mock/user/data");
      
      expect(fs.mkdirSync).toHaveBeenCalled();
      expect(fs.writeFileSync).toHaveBeenCalled();
      const writtenContent = vi.mocked(fs.writeFileSync).mock.calls[0]![1] as string;
      expect(JSON.parse(writtenContent).bookmark_bar.show_on_all_tabs).toBe(false);
    });

    it("updates existing Preferences", () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ some: "data" }));
      
      disableBookmarksBar("/mock/user/data");
      
      const writtenContent = vi.mocked(fs.writeFileSync).mock.calls[0]![1] as string;
      const parsed = JSON.parse(writtenContent);
      expect(parsed.some).toBe("data");
      expect(parsed.bookmark_bar.show_on_all_tabs).toBe(false);
    });
  });
});
