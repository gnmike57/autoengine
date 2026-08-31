/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/require-await */
import { type ScreenBounds } from "../profiles/viewport-resolver.js";
import { type Page } from "playwright";
import { ConfigStore } from "../core/config-store.js";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { windowManager } from "node-window-manager";
import { createLogger } from "../core/logger.js";

const log = createLogger("BrowserTiler");
/**
 * Universal Browser Tiler
 *
 * Manages slots and mathematically calculates screen bounds for headed browser windows.
 * Can be imported by any automation backend to ensure consistent window packing.
 */
let cachedMacScreen: { bounds: { x: number; y: number; width: number; height: number }; expiresAt: number } | null = null;

export class BrowserTiler {
  private totalWindows: number;
  private freeSlots: number[];
  private customGrid: {cols: number, rows: number} | null = null;
  private waiters: Array<(n: number) => void> = [];
  constructor(initialWindows: number = 1) {
    this.totalWindows = initialWindows;
    this.freeSlots = Array.from({ length: this.totalWindows }, (_, i) => i);
  }
  public getTotalWindows(): number {
    return this.totalWindows;
  }
  /**
   * Adjusts the total number of managed windows dynamically.
   * New slots are appended, while out-of-bounds slots are discarded.
   */
  public reconfigure(concurrency: number, customGrid?: {cols: number, rows: number}): void {
    if (customGrid) {
      this.customGrid = customGrid;
      concurrency = customGrid.cols * customGrid.rows;
    } else {
      this.customGrid = null;
    }
    if (concurrency > this.totalWindows) {
      for (let i = this.totalWindows; i < concurrency; i++) {
        if (!this.freeSlots.includes(i)) {
          this.freeSlots.push(i);
        }
      }
      this.totalWindows = concurrency;
      // Drain any waiters that can now be fulfilled by new freeSlots
      while (this.waiters.length > 0 && this.freeSlots.length > 0) {
        const nextWaiter = this.waiters.shift()!;
        const freeSlot = this.freeSlots.shift()!;
        nextWaiter(freeSlot);
      }
    } else if (concurrency < this.totalWindows) {
      this.totalWindows = concurrency;
      this.freeSlots = this.freeSlots.filter(slot => slot < this.totalWindows);
    }
  }
  /**
   * Acquires the next available slot number. Wait if none are available.
   */
  public async acquireSlot(): Promise<number> {
    if (this.freeSlots.length > 0) {
      return this.freeSlots.shift()!;
    }
    if (this.waiters.length > this.totalWindows * 3) {
      log.warn(`acquireSlot: high queue depth (${this.waiters.length} waiters for ${this.totalWindows} total windows) — possible slot leak`);
    }
    return new Promise<number>((resolve) => this.waiters.push(resolve));
  }
  /**
   * Releases a slot back into the available pool.
   */
  public releaseSlot(slot: number): void {
    if (this.waiters.length > 0) {
      const nextWaiter = this.waiters.shift()!;
      nextWaiter(slot);
    } else if (!this.freeSlots.includes(slot) && slot < this.totalWindows) {
      this.freeSlots.push(slot);
    }
  }
  /**
   * Calculates dynamic (x, y, width, height) to pack windows evenly based on the current pool size.
   */
  public async getBounds(slot: number): Promise<ScreenBounds & { zOrder?: string, _emulateDpr?: number, _emulateMobile?: boolean } | null> {
    const config = ConfigStore.load();
    if (config.tilingLayout === "os-native") {
      return null;
    }

    const monitors = windowManager.getMonitors();
    let screen = { x: 0, y: 0, width: 1920, height: 1080 };

    let windowsPerMonitor = this.totalWindows;
    let localSlot = slot;

    const validMonitors = (monitors || []).filter(m => {
      try {
        const b = m.getBounds();
        return b && typeof b.width === "number" && b.width > 100 && typeof b.height === "number" && b.height > 100;
      } catch {
        return false;
      }
    });

    if (validMonitors.length > 0) {
        // Distribute slots across multiple monitors
        windowsPerMonitor = Math.ceil(this.totalWindows / validMonitors.length);
        const monitorIndex = Math.min(Math.floor(slot / windowsPerMonitor), validMonitors.length - 1);
        localSlot = slot % windowsPerMonitor;
        const monitor = validMonitors[monitorIndex];
        if (monitor) {
            const rawScreen = monitor.getBounds();
            const TASKBAR_HEIGHT = process.platform === "win32" ? 48 : 0;
            screen = {
               x: rawScreen?.x ?? 0,
               y: rawScreen?.y ?? 0,
               width: rawScreen?.width ?? 1920,
               height: Math.max(10, (rawScreen?.height ?? 1080) - TASKBAR_HEIGHT)
            };
        }
    } else if (process.platform === 'darwin') {
        const now = Date.now();
        if (cachedMacScreen && now < cachedMacScreen.expiresAt) {
            screen = cachedMacScreen.bounds;
        } else {
            try {
                // Fallback for macOS accessibility block (cached for 60 seconds)
                const raw = execFileSync("system_profiler", ["SPDisplaysDataType"]).toString();
                const m = raw.match(/Resolution:\s*(\d+)\s*x\s*(\d+)/);
                if (m && m[1] && m[2]) {
                    const w = parseInt(m[1], 10);
                    const h = parseInt(m[2], 10);
                    // Handle retina display scaling
                    const logicalW = w > 2000 ? Math.round(w / 2) : w;
                    const logicalH = h > 1400 ? Math.round(h / 2) : h;
                    screen = { x: 0, y: 31, width: logicalW, height: logicalH - 31 }; // Account for 31px Apple menu bar
                    cachedMacScreen = { bounds: screen, expiresAt: now + 60000 };
                }
            } catch {}
        }
    }

    if (this.totalWindows <= 1) {
      return { x: screen.x, y: screen.y, width: screen.width, height: screen.height };
    }

    const TILE_GAP = 6;

    // cols and rows will be calculated based on grid mode below

    // "cascading" or "messy desk" layout mode
    if (config.tilingLayout === "cascading") {
       let baseWidth = Math.floor(screen.width * 0.7);
       let baseHeight = Math.floor(screen.height * 0.7);

       // 50/50 Aspect Ratio Spin for Portrait
       if (Math.random() > 0.5) {
           const temp = baseWidth;
           baseWidth = Math.min(screen.width * 0.9, baseHeight);
           baseHeight = Math.min(screen.height * 0.9, temp);
       }

       const offsetX = (localSlot * 40) % Math.max(1, screen.width - baseWidth);
       const offsetY = (localSlot * 40) % Math.max(1, screen.height - baseHeight);

       const fuzzW = Math.floor(Math.random() * 20);
       const fuzzH = Math.floor(Math.random() * 20);

       const x = screen.x + offsetX;
       const y = screen.y + offsetY;
       const width = baseWidth + fuzzW;
       const height = baseHeight + fuzzH;

       const zOrder = Math.random() > 0.5 ? "TOP" : "BOTTOM";
       return { x, y, width, height, zOrder };
    }

    // Improvement 2 & 4: Chaos Mode (Top 100 Viewport Snapping)
    if (config.tilingLayout === "chaos") {
        try {
            const topViewportsPath = path.join(process.cwd(), 'data', 'top-viewports.json');
            if (fs.existsSync(topViewportsPath)) {
                const viewports = JSON.parse(fs.readFileSync(topViewportsPath, 'utf8')) as Array<{width: number; height: number; isMobile?: boolean; dpr?: number}>;
                const randomVp = viewports[Math.floor(Math.random() * viewports.length)];
                if (!randomVp) throw new Error("No viewports found in top-viewports.json");

                // Allow random flipping of orientation for tablets, but phones usually stay portrait
                let width = randomVp.width;
                let height = randomVp.height;
                if (!randomVp.isMobile && Math.random() > 0.5) {
                    width = randomVp.height;
                    height = randomVp.width;
                }

                // Ensure it fits on screen
                width = Math.min(width, screen.width - 20);
                height = Math.min(height, screen.height - 20);

                const x = screen.x + Math.floor(Math.random() * Math.max(1, screen.width - width));
                const y = screen.y + Math.floor(Math.random() * Math.max(1, screen.height - height));
                const zOrder = Math.random() > 0.5 ? "TOP" : "BOTTOM";

                // We pass dpr and isMobile back for the dynamic CDP swapping
                return { x, y, width, height, zOrder, _emulateDpr: randomVp.dpr, _emulateMobile: randomVp.isMobile };
            }
        } catch(e) {
            log.error(`Failed to load top-viewports.json: ${e instanceof Error ? e.message : String(e)}`);
        }

        // Fallback chaos mode
        const MIN_WIDTH = 320;
        const MIN_HEIGHT = 240;
        const maxWidth = Math.max(MIN_WIDTH + 1, Math.floor(screen.width * 0.8));
        const maxHeight = Math.max(MIN_HEIGHT + 1, Math.floor(screen.height * 0.8));

        let width = Math.floor(Math.random() * (maxWidth - MIN_WIDTH)) + MIN_WIDTH;
        let height = Math.floor(Math.random() * (maxHeight - MIN_HEIGHT)) + MIN_HEIGHT;

        if (Math.random() > 0.5 && width > height) {
           const temp = width;
           width = height;
           height = temp;
        }

        const x = screen.x + Math.floor(Math.random() * Math.max(1, screen.width - width));
        const y = screen.y + Math.floor(Math.random() * Math.max(1, screen.height - height));

        const zOrder = Math.random() > 0.5 ? "TOP" : "BOTTOM";
        return { x, y, width, height, zOrder };
    }

    // Improvement 1: Golden Ratio (Fibonacci) Splitting
    if (config.tilingLayout === "fibonacci") {
        let remainingWidth = screen.width;
        let remainingHeight = screen.height;
        let x = screen.x;
        let y = screen.y;

        for (let i = 0; i < localSlot; i++) {
            if (i % 2 === 0) {
                const chunk = Math.floor(remainingWidth * 0.618);
                x += chunk;
                remainingWidth -= chunk;
            } else {
                const chunk = Math.floor(remainingHeight * 0.618);
                y += chunk;
                remainingHeight -= chunk;
            }
        }

        let width = (localSlot % 2 === 0) ? Math.floor(remainingWidth * 0.618) : remainingWidth;
        let height = (localSlot % 2 === 1) ? Math.floor(remainingHeight * 0.618) : remainingHeight;

        if (localSlot === windowsPerMonitor - 1) {
            width = remainingWidth;
            height = remainingHeight;
        }

        // Apply natural human fuzzing to the fibonacci blocks
        width += (Math.random() > 0.5 ? 1 : -1) * (Math.floor(Math.random() * 4) + 1);
        height += (Math.random() > 0.5 ? 1 : -1) * (Math.floor(Math.random() * 4) + 1);

        return { x, y, width, height };
    }

    // OS-Native "Snap Layout" Fuzzing
    if (config.tilingLayout === "snap") {
        const snapWidth = Math.floor(screen.width / 2);
        const isLeft = (localSlot % 2) === 0;

        // Exact snap math +/- 1px variance
        const fuzzW = (Math.random() > 0.5 ? 1 : -1);
        const fuzzH = (Math.random() > 0.5 ? 1 : -1);

        const width = snapWidth + fuzzW;
        const height = screen.height + fuzzH;
        const x = screen.x + (isLeft ? 0 : snapWidth) + (Math.random() > 0.5 ? 1 : -1);
        const y = screen.y + (Math.random() > 0.5 ? 1 : -1);
        return { x, y, width, height };
    }

    let cols: number;
    let rows: number;
    if (this.customGrid) {
      cols = this.customGrid.cols;
      rows = this.customGrid.rows;
    } else if (config.tilingLayout === "portrait-grid" || config.tilingLayout === "horizontal") {
      cols = windowsPerMonitor;
      rows = 1;
    } else if (config.tilingLayout === "vertical") {
      cols = 1;
      rows = windowsPerMonitor;
    } else {
      // "auto" mode: Aspect-Aware Smart Grid
      if (screen.width > screen.height) {
         if (windowsPerMonitor === 4) {
             rows = 1;
             cols = 4;
         } else {
             // Landscape monitor: Favor columns to push viewports into portrait ratio
             rows = Math.max(1, Math.floor(Math.sqrt(windowsPerMonitor)));
             cols = Math.ceil(windowsPerMonitor / rows);
         }
      } else {
         // Portrait monitor: Favor rows
         cols = Math.max(1, Math.floor(Math.sqrt(windowsPerMonitor)));
         rows = Math.ceil(windowsPerMonitor / cols);
      }
    }

    const cellW = Math.floor(screen.width / cols);
    const cellH = Math.floor(screen.height / rows);

    const col = localSlot % cols;
    const row = Math.floor(localSlot / cols);

    const xBase = screen.x + col * cellW + TILE_GAP;
    const yBase = screen.y + row * cellH + TILE_GAP;
    const widthBase = Math.max(320, cellW - TILE_GAP * 2);
    const heightBase = Math.max(240, cellH - TILE_GAP * 2);

    // Humanized Dynamic Viewports: Micro-fuzzing (1 to 4 pixels)
    const fuzzW = Math.floor(Math.random() * 4) + 1;
    const fuzzH = Math.floor(Math.random() * 4) + 1;

    const offsetX = Math.floor(Math.random() * 4) + 1;
    const offsetY = Math.floor(Math.random() * 4) + 1;

    let width = widthBase - fuzzW;
    let height = heightBase - fuzzH;
    let x = xBase + offsetX;
    let y = yBase + offsetY;

    // Feature 3: Inner Viewport Minimum Constraints
    // Lowered to 320x240 to support true Portrait mode side-by-side!
    const MIN_WIDTH = 320;
    const MIN_HEIGHT = 240;

    if (width < MIN_WIDTH) {
       width = MIN_WIDTH;
       // Diagonal Z-Stacking Overlap Logic: Offset by slot index so top-left is always visible
       x = Math.max(screen.x, Math.min(screen.x + screen.width - width, x + (localSlot * 20)));
    }
    if (height < MIN_HEIGHT) {
       height = MIN_HEIGHT;
       y = Math.max(screen.y, Math.min(screen.y + screen.height - height, y + (localSlot * 20)));
    }

    return { x, y, width, height };
  }

  // Global lock to prevent concurrent PowerShell resize hooks from deadlocking Camoufox during launch

  /**
   * Enforces the OS window bounds natively.
   * @param backendName - The backend identifier (e.g., "stealth", "cloak-headed").
   *   Used to skip Chromium-only CDP commands and JS fingerprint overrides
   *   that conflict with Camoufox's C++ engine-level management (Rule 39).
   */
  public async enforceWindowBounds(page: Page, bounds: ScreenBounds & { zOrder?: string, _emulateDpr?: number, _emulateMobile?: boolean } | null, _browserPid?: number, backendName?: string): Promise<void> {
    let timer: NodeJS.Timeout;
    return Promise.race([
      this._enforceWindowBounds(page, bounds, _browserPid, backendName),
      new Promise<void>((_, rej) => { timer = setTimeout(() => rej(new Error("BrowserTiler bounds enforcement timed out")), 10000); })
    ]).finally(() => clearTimeout(timer)).catch(e => {
      log.warn(`[BrowserTiler] Bounds enforcement failed or timed out: ${e instanceof Error ? e.message : String(e)}`);
    });
  }

  private async _enforceWindowBounds(page: Page, bounds: ScreenBounds & { zOrder?: string, _emulateDpr?: number, _emulateMobile?: boolean } | null, _browserPid?: number, backendName?: string): Promise<void> {
    if (!bounds) return;

    const isStealth = backendName?.startsWith("stealth") ?? false;

    // 1. Enforce Window Position via pure Dynamic E2E architecture
    if (isStealth) {
      // Camoufox uses our injected WebExtension bridge via window.postMessage.
      // NOTE: During the initial boot sequence in stealth.ts, the WebExtension
      // already enforces the bounds on startup! We dispatch it here again just to be safe.
      try {
        await page.evaluate((b) => {
          window.postMessage({ type: "NATIVE_RESIZE", bounds: b }, "*");
        }, bounds);
        log.info(`Dispatched WebExtension resize for Camoufox -> ${bounds.width}x${bounds.height} @ (${bounds.x},${bounds.y})`);
      } catch (err) {
        log.warn(`Dynamic WebExtension resize failed for Camoufox: ${String(err)}`);
      }
    } else {
      // Chromium uses CDP
      try {
        const client = await page.context().newCDPSession(page);
        const { windowId } = await client.send('Browser.getWindowForTarget');
        await client.send('Browser.setWindowBounds', {
          windowId,
          bounds: {
            left: Math.floor(bounds.x),
            top: Math.floor(bounds.y),
            width: Math.floor(bounds.width),
            height: Math.floor(bounds.height),
            windowState: 'normal'
          }
        });
        await client.detach().catch(() => {});
        log.info(`Dispatched CDP resize for Chromium -> ${bounds.width}x${bounds.height} @ (${bounds.x},${bounds.y})`);
      } catch (e: any) {
        log.warn(`CDP bounds fallback failed: ${e.message}`);
      }
    }

    // 2. Post-tiling viewport enhancements (Chromium-only)
    // These CDP + addInitScript overrides are SKIPPED for stealth (Camoufox)
    // because Camoufox manages window.screen, outerWidth, outerHeight at the
    // C++ engine level. Layering JS overrides creates Frankenstein profiles.
    if (!isStealth) {
      try {
        if (page.context) {
           const context = page.context();
           const cdp = await context.newCDPSession(page).catch(() => null);
           if (cdp) {
             // Anti-Breakage CSS, Orientation Change, Scrollbar Randomization & Screen Property Fuzzing
             await page.addInitScript((injectedBounds: ScreenBounds & { _emulateMobile?: boolean } | null) => {
               const style = document.createElement('style');
               const scrollbarWidth = Math.floor(Math.random() * 8) + 8; // 8px to 16px

               style.innerHTML = `
                   body, html { min-width: 100vw !important; max-width: 100vw !important; overflow-x: hidden !important; }
                   ::-webkit-scrollbar { width: ${scrollbarWidth}px !important; }
               `;
               document.addEventListener('DOMContentLoaded', () => document.head.appendChild(style));

               let lastWidth = window.innerWidth;
               window.addEventListener('resize', () => {
                  if ((lastWidth < window.innerHeight && window.innerWidth > window.innerHeight) ||
                      (lastWidth > window.innerHeight && window.innerWidth < window.innerHeight)) {
                      window.dispatchEvent(new Event('orientationchange'));
                  }
                  lastWidth = window.innerWidth;
               });

               if (injectedBounds && injectedBounds._emulateMobile) {
                   const fuzzedScreen = {
                       width: injectedBounds.width,
                       height: injectedBounds.height,
                       availWidth: injectedBounds.width,
                       availHeight: injectedBounds.height,
                       colorDepth: 24,
                       pixelDepth: 24,
                       orientation: { type: injectedBounds.width > injectedBounds.height ? "landscape-primary" : "portrait-primary", angle: 0 }
                   };

                   Object.defineProperty(window, 'screen', {
                       get: () => fuzzedScreen
                   });

                   Object.defineProperty(window, 'outerWidth', { get: () => window.innerWidth });
                   Object.defineProperty(window, 'outerHeight', { get: () => window.innerHeight });
               }
             }, bounds).catch(() => {});

             if (bounds._emulateMobile) {
                 log.info(`Explicit mobile emulation requested for bounds ${bounds.width}px. Enabling Touch & UA.`);
                 await cdp.send('Emulation.setDeviceMetricsOverride', {
                     width: 0,
                     height: 0,
                     deviceScaleFactor: bounds._emulateDpr || 2.5,
                     mobile: true
                 }).catch(() => {});

                 await cdp.send('Emulation.setTouchEmulationEnabled', {
                     enabled: true,
                     maxTouchPoints: 5
                 }).catch(() => {});

                 await cdp.send('Network.setUserAgentOverride', {
                     userAgent: 'Mozilla/5.0 (Linux; Android 13; Pixel 7 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Mobile Safari/537.36',
                     platform: 'Android'
                 }).catch(() => {});
             }
           }
        }
      } catch (e) {
        log.debug(`Failed to inject CDP Viewport Emulation: ${String(e)}`);
      }
    }
  }

  /**
   * Dynamically repositions an existing browser window without restarting it.
   * - Chromium uses internal CDP Browser.setWindowBounds.
   * - Camoufox uses our injected WebExtension bridge via window.postMessage.
   */
  public static async moveWindowDynamically(session: any, backend: string, bounds: ScreenBounds): Promise<void> {
    const isStealth = backend.startsWith("stealth");
    const page: Page = session.page;

    if (isStealth) {
      // Dispatch WebExtension message via content script hook
      try {
        await page.evaluate((b) => {
          window.postMessage({ type: "NATIVE_RESIZE", bounds: b }, "*");
        }, bounds);
        log.info(`Dispatched WebExtension resize for Camoufox -> ${bounds.width}x${bounds.height} @ (${bounds.x},${bounds.y})`);
      } catch (err) {
        log.warn(`Dynamic WebExtension resize failed for Camoufox: ${String(err)}`);
      }
    } else {
      // Use CDP for Chromium-based backends
      try {
        const client = await page.context().newCDPSession(page);
        const { windowId } = await client.send('Browser.getWindowForTarget');
        await client.send('Browser.setWindowBounds', {
          windowId,
          bounds: {
            left: Math.floor(bounds.x),
            top: Math.floor(bounds.y),
            width: Math.floor(bounds.width),
            height: Math.floor(bounds.height),
            windowState: 'normal'
          }
        });
        await client.detach().catch(() => {});
        log.info(`Dispatched CDP resize for Chromium -> ${bounds.width}x${bounds.height} @ (${bounds.x},${bounds.y})`);
      } catch (err) {
        log.warn(`Dynamic CDP resize failed for Chromium: ${String(err)}`);
      }
    }
  }
}
// Export a universal global instance
export const globalTiler = new BrowserTiler(1);

export function disableBookmarksBar(userDataDir: string): void {
  try {
    const defaultDir = path.join(userDataDir, "Default");
    if (!fs.existsSync(defaultDir)) fs.mkdirSync(defaultDir, { recursive: true });
    const prefsPath = path.join(defaultDir, "Preferences");
    let prefs: { bookmark_bar?: { show_on_all_tabs?: boolean }; [key: string]: unknown } = {};
    if (fs.existsSync(prefsPath)) {
      prefs = JSON.parse(fs.readFileSync(prefsPath, 'utf8')) as { bookmark_bar?: { show_on_all_tabs?: boolean }; [key: string]: unknown };
    }
    prefs.bookmark_bar = { show_on_all_tabs: false };
    fs.writeFileSync(prefsPath, JSON.stringify(prefs));
  } catch (e) {
    log.warn(`Failed to disable bookmarks bar via Preferences: ${e instanceof Error ? e.message : String(e)}`);
  }
}