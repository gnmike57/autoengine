/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-misused-promises*/
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from "events";
import { type Page } from "playwright-core";
import sharp from "sharp";
import { Timings } from "../core/timings.js";
import { createLogger } from "../core/logger.js";
import type { GcsUploader } from "./gcs-uploader.js";

const defaultLog = createLogger("ScreenshotService");
const DEFAULT_MODAL_PADDING = 30;
const DEFAULT_MODAL_SELECTORS = [
  '[data-testid="login-modal"]',
  '[role="dialog"]:has(input[type="password"])',
  'form:has(input[type="password"])',
  'main:has(input[type="password"])',
];

export interface ClipBox { x: number; y: number; width: number; height: number }
interface PixelComponent { x1: number; y1: number; x2: number; y2: number; area: number }

function clampClip(
  box: ClipBox,
  viewport: { width: number; height: number },
  padding: number,
): ClipBox {
  const left = Math.max(0, Math.floor(box.x - padding));
  const top = Math.max(0, Math.floor(box.y - padding));
  const right = Math.min(viewport.width, Math.ceil(box.x + box.width + padding));
  const bottom = Math.min(viewport.height, Math.ceil(box.y + box.height + padding));
  return { x: left, y: top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
}

function isNeutralWhitePixel(data: Buffer, offset: number): boolean {
  const r = data[offset];
  const g = data[offset + 1];
  const b = data[offset + 2];
  const a = data[offset + 3];
  if (a! < 220 || r! < 225 || g! < 225 || b! < 225) return false;
  // @ts-expect-error noUncheckedIndexedAccess
  return Math.max(r!, g!, b) - Math.min(r!, g!, b) <= 45;
}

function floodComponent(mask: Uint8Array, visited: Uint8Array, width: number, start: number): PixelComponent {
  const queue = [start];
  visited[start] = 1;
  let x1 = width, y1 = Math.floor(start / width), x2 = 0, y2 = 0, area = 0;

  for (let i = 0; i < queue.length; i++) {
    const p = queue[i];
    const x = p! % width;
    const y = Math.floor(p! / width);
    area++;
    x1 = Math.min(x1, x); y1 = Math.min(y1, y); x2 = Math.max(x2, x); y2 = Math.max(y2, y);

    const neighbors = [x > 0 ? p! - 1 : -1, x < width - 1 ? p! + 1 : -1, p! - width, p! + width];
    for (const n of neighbors) {
      if (n < 0 || n >= mask.length || visited[n] || !mask[n]) continue;
      visited[n] = 1;
      queue.push(n);
    }
  }
  return { x1, y1, x2, y2, area };
}

function chooseModalComponent(components: PixelComponent[], width: number, height: number): PixelComponent | null {
  const minArea = Math.max(500, Math.floor(width * height * 0.01));
  const cx = width / 2;
  const cy = height / 2;
  const candidates = components.filter((c) => {
    const w = c.x2 - c.x1 + 1;
    const h = c.y2 - c.y1 + 1;
    return c.area >= minArea && w >= width * 0.12 && w <= width * 0.95 && h >= height * 0.15 && h <= height * 0.98;
  });
  candidates.sort((a, b) => {
    const aw = a.x2 - a.x1 + 1, ah = a.y2 - a.y1 + 1;
    const bw = b.x2 - b.x1 + 1, bh = b.y2 - b.y1 + 1;
    const ad = Math.hypot((a.x1 + aw / 2) - cx, (a.y1 + ah / 2) - cy);
    const bd = Math.hypot((b.x1 + bw / 2) - cx, (b.y1 + bh / 2) - cy);
    return b.area - a.area || ad - bd;
  });
  return candidates[0] ?? null;
}

function detectWhiteModalCrop(data: Buffer, width: number, height: number, padding: number): ClipBox | null {
  // Guard against massive pixel buffers at 4K / retina viewports under high concurrency
  if (width <= 0 || height <= 0 || width > 2560 || height > 1600 || width * height > 3_000_000) {
    return null;
  }
  const mask = new Uint8Array(width * height);
  const visited = new Uint8Array(width * height);
  for (let p = 0; p < width * height; p++) {
    if (isNeutralWhitePixel(data, p * 4)) mask[p] = 1;
  }

  const components: PixelComponent[] = [];
  for (let p = 0; p < mask.length; p++) {
    if (mask[p] && !visited[p]) components.push(floodComponent(mask, visited, width, p));
  }
  const c = chooseModalComponent(components, width, height);
  if (!c) return null;
  return clampClip({ x: c.x1, y: c.y1, width: c.x2 - c.x1 + 1, height: c.y2 - c.y1 + 1 }, { width, height }, padding);
}

function sanitizePathSegment(value: string | undefined, fallback: string): string {
  const cleaned = String(value || "")
    .replace(/[\\/]+/g, "_")
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^\.+$/, "")
    .slice(0, 96);
  return cleaned || fallback;
}

function safeJoinUnder(baseDir: string, relativePath: string): string {
  const base = path.resolve(baseDir);
  const target = path.resolve(base, relativePath);
  if (target !== base && !target.startsWith(base + path.sep)) {
    throw new Error("Screenshot path escaped base directory");
  }
  return target;
}

export interface ScreenshotServiceOpts {
  baseDir: string;
  defaultFormat: "jpeg" | "png";
  defaultQuality: number;
  retentionMs: number;
  cleanupIntervalMs: number;
  emitBase64?: boolean;
  queueMax?: number;
  /** Prefer modal-only screenshots with a thin branded-background margin. */
  modalCrop?: boolean;
  modalPadding?: number;
  modalSelectors?: string[];
  /** Local Sharp fallback when DOM/modal selectors fail. */
  pixelCropFallback?: boolean;
  logger?: (level: string, msg: string) => void;
}

export interface ScreenshotCaptureCtx {
  label: string;
  email?: string;
  target?: string;
  subdir?: string;
  fullPage?: boolean;
  configAcronym?: string;
  backend?: string;
  proxyPool?: string;
  inputMode?: string;
  concurrency?: number;
  bypass?: boolean;
  cloak?: boolean;
}

export interface ScreenshotEvent {
  label: string;
  relativePath: string;
  sizeBytes: number;
  timestamp: string;
  target?: string;
  email?: string;
  base64?: string;
  gcsUrl?: string;
  backend?: string;
  configAcronym?: string;
  proxyPool?: string;
  inputMode?: string;
  concurrency?: number;
  bypass?: boolean;
  cloak?: boolean;
}

export interface ScreenshotErrorEvent {
  label: string;
  error: string;
  stack?: string;
}

export class ScreenshotService extends EventEmitter {
  private opts: ScreenshotServiceOpts;
  private cleanupTimer: NodeJS.Timeout | null = null;
  // In-flight disk writes. Bounded by queueMax — any capture that arrives
  // while the count is at/above the cap is dropped before any I/O happens
  // and a "queue-pressure" event ({ current, max }) is emitted as a fire-
  // and-forget signal for dashboards / observability.
  private pendingCount = 0;
  private queueMax: number;
  // In-flight write promises tracked for flush(). Each entry is removed in
  // its own .finally() so the set stays bounded by pendingCount.
  private pendingWrites: Set<Promise<void>> = new Set();
  // Optional GCS uploader — set via setGcsUploader() after construction
  private _gcsUploader: GcsUploader | null = null;

  private get modalCropEnabled(): boolean {
    return this.opts.modalCrop ?? true;
  }

  constructor(opts: ScreenshotServiceOpts) {
    super();
    this.opts = opts;
    this.queueMax = opts.queueMax ?? Timings.SCREENSHOT_QUEUE_MAX;
    if (!fs.existsSync(this.opts.baseDir)) {
      fs.mkdirSync(this.opts.baseDir, { recursive: true });
    }
  }

  /** Attach a GCS uploader for cloud screenshot storage. */
  setGcsUploader(uploader: GcsUploader | null): void {
    this._gcsUploader = uploader;
    if (uploader?.isReady) {
      this.log("INFO", "GCS uploader attached — screenshots will be uploaded to cloud");
    }
  }

  private log(level: string, msg: string) {
    if (this.opts.logger) { this.opts.logger(level, msg); return; }
    const lvl = level.toLowerCase();
    if (lvl === "warn") defaultLog.warn(msg);
    else if (lvl === "error") defaultLog.error(msg);
    else if (lvl === "debug") defaultLog.debug(msg);
    else defaultLog.info(msg);
  }

  async capture(page: Page, ctx: ScreenshotCaptureCtx): Promise<{ path: string; relativePath: string; sizeBytes: number; durationMs: number; cropBox?: ClipBox; hash?: string } | null> {
    const startTime = Date.now();
    try {
      const { buffer: buf, cropBox } = await this.captureBuffer(page, ctx);
      return this._saveBuffer(buf, ctx, startTime, cropBox);
    } catch (err: unknown) {
      this.log("WARN", `Screenshot capture failed for "${ctx.label}": ${err instanceof Error ? err.message : String(err)}`);
      this.emit("screenshot-error", { label: ctx.label, error: (err instanceof Error ? err.message : String(err)), stack: err instanceof Error ? err.stack : undefined });
      return null;
    }
  }

  async captureFromBuffer(rawBuffer: Buffer, ctx: ScreenshotCaptureCtx): Promise<{ path: string; relativePath: string; sizeBytes: number; durationMs: number; cropBox?: ClipBox; hash?: string } | null> {
    const startTime = Date.now();
    try {
      let buf = rawBuffer;
      let cropBox: ClipBox | undefined;
      // Apply Tier 2 cropping if enabled, otherwise save raw
      if (!ctx.fullPage && this.modalCropEnabled && (this.opts.pixelCropFallback ?? true)) {
        const cropped = await this.cropWhiteModalFromBuffer(rawBuffer).catch((e: any) => {
          this.log("DEBUG", `Pixel modal crop skipped for "${ctx.label}": ${e?.message || e}`);
          return null;
        });
        if (cropped && cropped.buffer.length > 0) {
          buf = await this.normalizeSize(cropped.buffer).catch(() => cropped.buffer);
          cropBox = cropped.cropBox;
        }
      }
      return this._saveBuffer(buf, ctx, startTime, cropBox);
    } catch (err: unknown) {
      this.log("WARN", `Screenshot captureFromBuffer failed for "${ctx.label}": ${err instanceof Error ? err.message : String(err)}`);
      this.emit("screenshot-error", { label: ctx.label, error: (err instanceof Error ? err.message : String(err)), stack: err instanceof Error ? err.stack : undefined });
      return null;
    }
  }

  private _saveBuffer(buf: Buffer, ctx: ScreenshotCaptureCtx, startTime: number, cropBox?: ClipBox) {
    const captureDuration = Date.now() - startTime;
    const emailSlug = sanitizePathSegment(ctx.email?.trim().toLowerCase(), "nocred").slice(0, 64);
    const now = new Date();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    const hh = String(now.getHours()).padStart(2, '0');
    const min = String(now.getMinutes()).padStart(2, '0');
    const sec = String(now.getSeconds()).padStart(2, '0');
    const tsShort = `${mm}${dd}_${hh}${min}${sec}`;

    const safeLabel = sanitizePathSegment(ctx.label, "capture");
    const target = sanitizePathSegment(ctx.target, "n_a");
    const configStr = ctx.configAcronym ? `__${ctx.configAcronym}` : "";
    const backendStr = ctx.backend ? `__${ctx.backend}` : "";
    const fileName = `${emailSlug}${configStr}${backendStr}__${target}__${safeLabel}__${tsShort}__${crypto.randomUUID()}.${this.opts.defaultFormat}`;
    const safeSubdir = ctx.subdir ? sanitizePathSegment(ctx.subdir, "") : "";
    const relativePath = safeSubdir ? path.join(safeSubdir, fileName) : fileName;
    const fullPath = safeJoinUnder(this.opts.baseDir, relativePath);

    this.enqueueWriteAndEmit(buf, ctx, fullPath, relativePath);

    const hashSum = crypto.createHash('sha256');
    hashSum.update(buf);
    const hash = hashSum.digest('hex');

    return {
      path: fullPath,
      relativePath,
      sizeBytes: buf.length,
      durationMs: captureDuration,
      cropBox: cropBox || undefined,
      hash,
    };
  }

  /**
   * Three-tier capture pipeline with a mandatory full-page final fallback so
   * a cropping miss can never produce a 0-byte file or skip the visual
   * record entirely.
   *
   *   Tier 1 — Playwright DOM-based modal clip (`input[type="password"]`
   *            ancestor card, or one of `modalSelectors`). If a valid clip
   *            is produced AND `page.screenshot` returns a non-empty buffer,
   *            this is the preferred output.
   *   Tier 2 — Sharp pixel-level pass over a viewport screenshot. Identifies
   *            the dominant neutral-white modal component and crops to it.
   *            Only consumed if Tier 1 yielded no clip / no buffer.
   *   Tier 3 — Mandatory `fullPage: true` capture. Runs whenever Tier 1 and
   *            Tier 2 both fail to yield a usable buffer, guaranteeing a
   *            non-empty visual record regardless of cropping miss.
   *
   * `ctx.fullPage = true` short-circuits to Tier 3 directly. The Tier 3
   * call is also re-issued if any earlier-tier buffer comes back 0-byte,
   * which Playwright should not produce but is defended against here.
   */
  private async captureBuffer(page: Page, ctx: ScreenshotCaptureCtx): Promise<{ buffer: Buffer; cropBox?: ClipBox }> {
    const screenshotOpts = {
      type: this.opts.defaultFormat,
      quality: this.opts.defaultFormat === "jpeg" ? this.opts.defaultQuality : undefined,
    } as const;

    // Explicit full-page request — bypass both cropping tiers.
    if (ctx.fullPage) {
      return { buffer: await this.captureFullPage(page, screenshotOpts, ctx.label) };
    }

    // Tier 1: DOM-based modal clip.
    if (this.modalCropEnabled) {
      const clip = await this.findModalClip(page).catch(() => null);
      if (clip) {
        const buf = await page.screenshot({ ...screenshotOpts, clip, animations: "disabled", caret: "hide" }).catch((e: any) => {
          this.log("DEBUG", `DOM-clip screenshot failed for "${ctx.label}": ${e?.message || e}`);
          return null;
        });
        if (buf && buf.length > 0) {
          const normalized = await this.normalizeSize(buf).catch(() => buf);
          return { buffer: normalized, cropBox: clip };
        }
      }
    }

    // Tier 2: Sharp pixel-level crop on a viewport screenshot.
    if (this.modalCropEnabled && (this.opts.pixelCropFallback ?? true)) {
      const viewport = await page.screenshot({ ...screenshotOpts, fullPage: false }).catch((e: any) => {
        this.log("DEBUG", `Viewport screenshot failed for "${ctx.label}": ${e?.message || e}`);
        return null;
      });
      if (viewport && viewport.length > 0) {
        const cropped = await this.cropWhiteModalFromBuffer(viewport).catch((e: any) => {
          this.log("DEBUG", `Pixel modal crop skipped for "${ctx.label}": ${e?.message || e}`);
          return null;
        });
        if (cropped && cropped.buffer.length > 0) {
          const normalized = await this.normalizeSize(cropped.buffer).catch(() => cropped.buffer);
          return { buffer: normalized, cropBox: cropped.cropBox };
        }
        this.log("DEBUG", `DOM + pixel crops both missed for "${ctx.label}" — falling back to full-page capture`);
      }
    }

    // Tier 3: mandatory full-page fallback.
    return { buffer: await this.captureFullPage(page, screenshotOpts, ctx.label) };
  }

  /**
   * Normalize a cropped screenshot to consistent dimensions so every
   * screenshot in the evidence trail has identical width × height regardless
   * of which cropping tier produced it.
   *
   * Strategy:
   *   1. Read the source dimensions.
   *   2. Pick the closest standard canvas (landscape 720×540 or portrait
   *      480×640) based on the source aspect ratio.
   *   3. Resize with `fit: 'contain'` so the crop is scaled to fit inside
   *      the canvas without distortion, then pad the remaining area with
   *      a dark background that matches the site's dark theme.
   */
  private async normalizeSize(buf: Buffer): Promise<Buffer> {
    const meta = await sharp(buf).metadata();
    const srcW = meta.width ?? 0;
    const srcH = meta.height ?? 0;
    if (srcW === 0 || srcH === 0) return buf;

    // Choose canvas based on aspect ratio
    const isPortrait = srcH > srcW * 1.15;
    const targetW = isPortrait ? 480 : 720;
    const targetH = isPortrait ? 640 : 540;

    // Skip if already at (or very close to) target size
    if (Math.abs(srcW - targetW) <= 4 && Math.abs(srcH - targetH) <= 4) return buf;

    const pipeline = sharp(buf).resize(targetW, targetH, {
      fit: "contain",
      background: { r: 26, g: 26, b: 46, alpha: 1 }, // #1a1a2e — dark theme
    });

    return this.opts.defaultFormat === "png"
      ? await pipeline.png().toBuffer()
      : await pipeline.jpeg({ quality: this.opts.defaultQuality, mozjpeg: true }).toBuffer();
  }

  /**
   * Final-fallback full-page capture. Defends against the rare case where
   * Playwright returns a 0-byte buffer by re-issuing the screenshot once.
   * Any error propagates to `capture()` so the outer error path fires.
   */
  private async captureFullPage(
    page: Page,
    screenshotOpts: { type: "jpeg" | "png"; quality?: number },
    label: string,
  ): Promise<Buffer> {
    const buf = await page.screenshot({ ...screenshotOpts, fullPage: true });
    if (buf && buf.length > 0) return buf;
    this.log("WARN", `Full-page screenshot returned 0-byte buffer for "${label}" — re-attempting once`);
    return await page.screenshot({ ...screenshotOpts, fullPage: true });
  }

  private async findModalClip(page: Page): Promise<ClipBox | null> {
    const viewport = await this.getViewportSize(page);
    const padding = this.opts.modalPadding ?? DEFAULT_MODAL_PADDING;
    const box = await this.detectLoginModalBox(page) ?? await this.findSelectorBox(page);
    if (!box) return null;
    return clampClip(box, viewport, padding);
  }

  private async getViewportSize(page: Page): Promise<{ width: number; height: number }> {
    const viewport = page.viewportSize?.();
    if (viewport) return viewport;
    return await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
  }

  private async detectLoginModalBox(page: Page): Promise<ClipBox | null> {
    if (typeof (page as any).evaluate !== "function") return null;
    return await page.evaluate(() => {
      const password = document.querySelector<HTMLInputElement>('input[type="password"]');
      if (!password) return null;
      let best: Element = password.closest("form") ?? password;
      let node: Element | null = best;
      while (node && node !== document.body) {
        const r = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        const bg = style.backgroundColor;
        const radius = parseFloat(style.borderRadius || "0");
        const visibleBg = bg && bg !== "transparent" && bg !== "rgba(0, 0, 0, 0)";
        const looksLikeCard = r.width >= 240 && r.height >= 220 && visibleBg && radius >= 4;
        if (looksLikeCard) best = node;
        node = node.parentElement;
      }
      const r = best.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    });
  }

  private async findSelectorBox(page: Page): Promise<ClipBox | null> {
    if (typeof (page as any).locator !== "function") return null;
    for (const selector of this.opts.modalSelectors ?? DEFAULT_MODAL_SELECTORS) {
      try {
        const locator = page.locator(selector).first();
        await locator.waitFor({ state: "visible", timeout: 800 });
        const box = await locator.boundingBox();
        if (box && box.width >= 80 && box.height >= 80) return box;
      } catch { /* try next selector */ }
    }
    return null;
  }

  private async cropWhiteModalFromBuffer(buf: Buffer): Promise<{ buffer: Buffer; cropBox?: ClipBox } | null> {
    const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const crop = detectWhiteModalCrop(data, info.width, info.height, this.opts.modalPadding ?? DEFAULT_MODAL_PADDING);
    if (!crop) return null;
    const out = sharp(buf).extract({ left: crop.x, top: crop.y, width: crop.width, height: crop.height });
    const croppedBuf = this.opts.defaultFormat === "png"
      ? await out.png().toBuffer()
      : await out.jpeg({ quality: this.opts.defaultQuality, mozjpeg: true }).toBuffer();
    return { buffer: croppedBuf, cropBox: crop };
  }

  private enqueueWriteAndEmit(buf: Buffer, ctx: ScreenshotCaptureCtx, fullPath: string, relativePath: string) {
    // Hard cap on concurrent in-flight writes. When saturated we drop the
    // new write entirely — no Promise allocation, no filesystem touch — and
    // emit "queue-pressure" so dashboards / observability can react. Previous
    // implementation only deleted the Promise reference, leaving the write
    // running to completion (unbounded queue in practice).
    if (this.pendingCount >= this.queueMax) {
      this.log("WARN", `Screenshot queue full (${this.pendingCount}/${this.queueMax}) — dropping new write`);
      this.emit("queue-pressure", { current: this.pendingCount, max: this.queueMax });
      return;
    }
    this.pendingCount++;

    const p = (async () => {
      try {
        const subDirPath = path.dirname(fullPath);
        if (!fs.existsSync(subDirPath)) {
          await fs.promises.mkdir(subDirPath, { recursive: true });
        }

        await fs.promises.writeFile(fullPath, buf);

        const event: ScreenshotEvent = {
          label: ctx.label,
          relativePath,
          sizeBytes: buf.length,
          timestamp: new Date().toISOString(),
          target: ctx.target,
          email: ctx.email,
          backend: ctx.backend,
          configAcronym: ctx.configAcronym,
          proxyPool: ctx.proxyPool,
          inputMode: ctx.inputMode,
          concurrency: ctx.concurrency,
          bypass: ctx.bypass,
          cloak: ctx.cloak,
        };

        if (this.opts.emitBase64) {
          event.base64 = buf.toString("base64");
        }

        this.emit("screenshot", event);

        // Async GCS upload (non-blocking — dashboard already has the screenshot via emit above)
        if (this._gcsUploader?.isReady) {
          this._gcsUploader.upload(fullPath, {
            email: ctx.email,
            label: ctx.label,
            target: ctx.target,
          }).then(result => {
            if (result) {
              this.emit("gcs-uploaded", {
                ...event,
                gcsUrl: result.publicUrl,
              });
            }
          }).catch(() => { /* logged by uploader */ });
        }
      } catch (err: unknown) {
        this.log("WARN", `Background screenshot write failed for "${ctx.label}": ${err instanceof Error ? err.message : String(err)}`);
        this.emit("screenshot-error", {
          label: ctx.label,
          error: (err instanceof Error ? err.message : String(err)),
          stack: (err instanceof Error ? err.stack : ''),
        });
      }
    })();

    this.pendingWrites.add(p);
      void p.finally(() => {
      this.pendingCount--;
      this.pendingWrites.delete(p);
    });
  }

  /** Resolves once all in-flight background writes have completed. Useful for
   *  graceful shutdown and for tests that need to clean their tmp dir without
   *  racing the non-blocking writes spawned by capture(). */
  async flush(): Promise<void> {
    while (this.pendingWrites.size > 0) {
      await Promise.allSettled(Array.from(this.pendingWrites));
    }
  }

  async prune(): Promise<{ deleted: number; existed: boolean }> {
    if (!fs.existsSync(this.opts.baseDir)) return { deleted: 0, existed: false };

    let deletedCount = 0;
    const now = Date.now();

    const scanDir = async (dir: string) => {
      const entries = await fs.promises.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await scanDir(fullPath);
          // Try to remove empty directory
          const children = await fs.promises.readdir(fullPath);
          if (children.length === 0) {
            await fs.promises.rmdir(fullPath).catch(() => { });
          }
        } else if (entry.isFile()) {
          const stats = await fs.promises.stat(fullPath);
          if (now - stats.mtimeMs > this.opts.retentionMs) {
            await fs.promises.unlink(fullPath).catch(() => { });
            deletedCount++;
          }
        }
      }
    };

    try {
      await scanDir(this.opts.baseDir);
      return { deleted: deletedCount, existed: true };
    } catch (err: unknown) {
      this.log("WARN", `Prune failed: ${err instanceof Error ? err.message : String(err)}`);
      return { deleted: deletedCount, existed: true };
    }
  }

  startAutoPrune(): void {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(async () => {
      const result = await this.prune();
      if (result.deleted > 0) {
        this.log("INFO", `Auto-prune: deleted ${result.deleted} screenshots`);
      }
    }, this.opts.cleanupIntervalMs);
  }

  stopAutoPrune(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }
}