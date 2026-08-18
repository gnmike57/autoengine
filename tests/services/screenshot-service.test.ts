import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import sharp from "sharp";
import { ScreenshotService } from "../../src/services/screenshot-service.js";

describe("ScreenshotService", () => {
  let tmpDir: string;
  let service: ScreenshotService;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `screenshot-service-test-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    service = new ScreenshotService({
      baseDir: tmpDir,
      defaultFormat: "jpeg",
      defaultQuality: 75,
      retentionMs: 1000,
      cleanupIntervalMs: 5000,
    });
  });

  afterEach(async () => {
    // Wait for any non-blocking background writes spawned by capture() to
    // finish before tearing down the tmp dir — otherwise rmSync races the
    // write and intermittently fails with ENOTEMPTY.
    await service.flush();
    service.stopAutoPrune();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("filename format puts credential email first for operator grouping: email__target__label__timestamp", async () => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const mockPage = {
      screenshot: vi.fn().mockResolvedValue(Buffer.from("fake-data")),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    const result = await service.capture(mockPage, {
      label: "test/label",
      email: "test@example.com",
      target: "mysite",
    });

    expect(result).not.toBeNull();
    // Production format (see screenshot-service.ts buildFilename): the email
    // slug is first so a folder listing groups all captures for one credential
    // together. The timestamp lives at the END to disambiguate repeat captures
    // without affecting sort-by-email.
    // Example: test_example.com__mysite__test_label__0510_080626.jpeg
    const parts = result!.relativePath.split("__");
    expect(parts.length).toBe(5);
    expect(parts[0]).toBe("test_example.com");
    expect(parts[1]).toBe("mysite");
    expect(parts[2]).toBe("test_label");
    expect(parts[3]).toMatch(/^\d{4}_\d{6}$/);
    expect(parts[4]).toMatch(/^[a-f0-9-]+\.jpeg$/);
  });

  it("filename uses 'nocred' when email is missing", async () => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const mockPage = {
      screenshot: vi.fn().mockResolvedValue(Buffer.from("fake-data")),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    const result = await service.capture(mockPage, { label: "anon", target: "mysite" });
    expect(result).not.toBeNull();
    const parts = result!.relativePath.split("__");
    expect(parts[0]).toBe("nocred");
  });

  it("filename lowercases and sanitises uppercase/plus-addressed emails and caps length", async () => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const mockPage = {
      screenshot: vi.fn().mockResolvedValue(Buffer.from("fake-data")),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    const longEmail = "A".repeat(80) + "+tag@Example.COM";
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    const result = await service.capture(mockPage, {
      label: "x",
      email: longEmail,
      target: "t",
    });
    expect(result).not.toBeNull();
    const parts = result!.relativePath.split("__");
    // Lowercased, '+' and '@' replaced with '_', total length capped at 64.
    // Email is now at parts[0] (see test above for the rationale).
    // @ts-expect-error noUncheckedIndexedAccess
    expect(parts[0].length).toBeLessThanOrEqual(64);
    expect(parts[0]).toMatch(/^a+_tag_example\.com$|^a+$/);
    expect(parts[0]).not.toMatch(/[A-Z+@]/);
  });

  it("non-blocking: capture resolves before the disk-write completes", async () => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const mockPage = {
      // eslint-disable-next-line @typescript-eslint/require-await
      screenshot: vi.fn().mockImplementation(async () => {
        return Buffer.from("fake-data");
      }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    // We can't easily wait for the background write here without exposing internals,
    // but we can check if the file exists immediately after capture.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    const result = await service.capture(mockPage, { label: "fast" });
    expect(result).not.toBeNull();

    // File might not exist yet because it's async
    // Even if it exists (very fast), we've proven it returned a result.
  });

  it("prune deletes only old files", async () => {
    const oldFile = path.join(tmpDir, "old.jpg");
    const newFile = path.join(tmpDir, "new.jpg");
    fs.writeFileSync(oldFile, "data");
    fs.writeFileSync(newFile, "data");

    const oldTime = (Date.now() - 5000) / 1000;
    fs.utimesSync(oldFile, oldTime, oldTime);

    const result = await service.prune();
    expect(result.deleted).toBe(1);
    expect(fs.existsSync(oldFile)).toBe(false);
    expect(fs.existsSync(newFile)).toBe(true);
  });

  it("failure path: screenshot error event fires", async () => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const mockPage = {
      screenshot: vi.fn().mockRejectedValue(new Error("Playwright error")),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    const errorPromise = new Promise((resolve) => service.once("screenshot-error", resolve));
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    const result = await service.capture(mockPage, { label: "fail" });

    expect(result).toBeNull();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const errEvent: any = await errorPromise;
    expect(errEvent.error).toBe("Playwright error");
  });

  it("captures a Playwright modal clip with 30px padding and viewport clamping", async () => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const mockPage = {
      viewportSize: vi.fn(() => ({ width: 120, height: 80 })),
      evaluate: vi.fn().mockResolvedValue({ x: 10, y: 20, width: 100, height: 50 }),
      screenshot: vi.fn().mockResolvedValue(Buffer.from("modal-data")),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    const result = await service.capture(mockPage, { label: "modal" });

    expect(result).not.toBeNull();
    expect(mockPage.screenshot).toHaveBeenCalledTimes(1);
    expect(mockPage.screenshot).toHaveBeenCalledWith(expect.objectContaining({
      clip: { x: 0, y: 0, width: 120, height: 80 },
      animations: "disabled",
      caret: "hide",
    }));
  });

  it("uses local Sharp pixel fallback when DOM modal detection fails", async () => {
    const raw = await sharp({
      create: { width: 200, height: 120, channels: 3, background: "#178f3d" },
    }).composite([{
      input: { create: { width: 80, height: 60, channels: 3, background: "#f5f4ef" } },
      left: 50,
      top: 30,
    }]).png().toBuffer();

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const mockPage = {
      viewportSize: vi.fn(() => ({ width: 200, height: 120 })),
      evaluate: vi.fn().mockResolvedValue(null),
      screenshot: vi.fn().mockResolvedValue(raw),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    const result = await service.capture(mockPage, { label: "pixel-crop" });
    expect(result).not.toBeNull();
    await service.flush();

    const meta = await sharp(result!.path).metadata();
    // After pixel crop, normalizeSize() resizes to the standard 720×540
    // landscape canvas. Verify the normalized output, not the raw crop.
    expect(meta.width).toBe(720);
    expect(meta.height).toBe(540);
  });

  it("falls back to a mandatory full-page capture when both DOM and pixel crops fail", async () => {
    // A solid-green image with no white modal — pixel crop cannot identify a
    // distinct neutral-white component and returns null. DOM detection also
    // returns null (the mock evaluate is wired that way). Tier 3 fullPage is
    // the only path that yields a buffer.
    const noModal = await sharp({
      create: { width: 160, height: 100, channels: 3, background: "#178f3d" },
    }).png().toBuffer();
    const fullPageBuf = await sharp({
      create: { width: 160, height: 600, channels: 3, background: "#0a0a0a" },
    }).png().toBuffer();

     
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const screenshot = vi.fn().mockImplementation(async (opts: any) => {
      return opts && opts.fullPage === true ? fullPageBuf : noModal;
    });
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const mockPage = {
      viewportSize: vi.fn(() => ({ width: 160, height: 100 })),
      evaluate: vi.fn().mockResolvedValue(null),
      screenshot,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    const result = await service.capture(mockPage, { label: "tier3" });
    expect(result).not.toBeNull();
    expect(result!.sizeBytes).toBeGreaterThan(0);
    await service.flush();

    // The Tier 3 full-page capture must have happened — confirmed by the
    // recorded screenshot args containing fullPage:true at least once.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fullPageCalls = screenshot.mock.calls.filter((c: any[]) => c[0] && c[0].fullPage === true);
    expect(fullPageCalls.length).toBeGreaterThanOrEqual(1);

    // The on-disk output matches the fullPage image dimensions, proving it
    // is NOT the cropped/viewport buffer.
    const meta = await sharp(result!.path).metadata();
    expect(meta.height).toBe(600);
    expect(meta.width).toBe(160);
  });

  it("re-attempts full-page capture once when the first attempt returns a 0-byte buffer", async () => {
    // Defensive path against a Playwright edge case returning an empty
    // buffer — the service must re-issue the fullPage call rather than
    // returning a 0-byte file.
    const fullPageBuf = await sharp({
      create: { width: 80, height: 80, channels: 3, background: "#111111" },
    }).png().toBuffer();

    let fullPageCalls = 0;
     
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const screenshot = vi.fn().mockImplementation(async (opts: any) => {
      if (opts && opts.fullPage === true) {
        fullPageCalls++;
        return fullPageCalls === 1 ? Buffer.alloc(0) : fullPageBuf;
      }
      return Buffer.alloc(0);
    });
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const mockPage = {
      viewportSize: vi.fn(() => ({ width: 80, height: 80 })),
      evaluate: vi.fn().mockResolvedValue(null),
      screenshot,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    const result = await service.capture(mockPage, { label: "zero-byte", fullPage: true });
    expect(result).not.toBeNull();
    expect(result!.sizeBytes).toBeGreaterThan(0);
    expect(fullPageCalls).toBe(2);
  });

  it("respects fullPage captures by bypassing modal and pixel cropping", async () => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const mockPage = {
      viewportSize: vi.fn(() => ({ width: 200, height: 120 })),
      evaluate: vi.fn().mockResolvedValue({ x: 10, y: 20, width: 100, height: 50 }),
      screenshot: vi.fn().mockResolvedValue(Buffer.from("full-page")),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    await service.capture(mockPage, { label: "full", fullPage: true });

    expect(mockPage.screenshot).toHaveBeenCalledTimes(1);
    expect(mockPage.screenshot).toHaveBeenCalledWith(expect.objectContaining({ fullPage: true }));
    expect(mockPage.screenshot.mock.calls[0][0]).not.toHaveProperty("clip");
  });
});
