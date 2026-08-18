import { describe, it, expect, vi } from "vitest";
import { sanitizeBrowserContext } from "../../src/stealth/context-sanitizer.js";

/**
 * Build a minimal BrowserContext stub that satisfies the subset of the
 * Playwright API sanitizeBrowserContext touches. Each test composes its own
 * stub so failure modes can be injected independently.
 */
function buildStubContext(opts: {
  pageCount?: number;
  clearCookiesThrows?: boolean;
  clearPermissionsThrows?: boolean;
  evaluateThrows?: boolean;
  cdpSendThrows?: boolean;
  cdpThrows?: boolean;
  closeThrows?: boolean;
  newPageThrows?: boolean;
  gotoThrows?: boolean;
} = {}) {
  // eslint-disable-next-line @typescript-eslint/require-await
  const evaluateMock = vi.fn().mockImplementation(async () => {
    if (opts.evaluateThrows) throw new Error("eval-boom");
  });
  // eslint-disable-next-line @typescript-eslint/require-await
  const gotoMock = vi.fn().mockImplementation(async () => {
    if (opts.gotoThrows) throw new Error("goto-boom");
  });
  // eslint-disable-next-line @typescript-eslint/require-await
  const closeMock = vi.fn().mockImplementation(async () => {
    if (opts.closeThrows) throw new Error("close-boom");
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pages: any[] = [];
  const total = opts.pageCount ?? 1;
  for (let i = 0; i < total; i++) {
    pages.push({ evaluate: evaluateMock, goto: gotoMock, close: closeMock });
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  const sendMock = vi.fn().mockImplementation(async () => {
    if (opts.cdpSendThrows) throw new Error("cdp-send-boom");
  });
  const detachMock = vi.fn().mockResolvedValue(undefined);
  // eslint-disable-next-line @typescript-eslint/require-await
  const newCDPSessionMock = vi.fn().mockImplementation(async () => {
    if (opts.cdpThrows) throw new Error("cdp-attach-boom");
    return { send: sendMock, detach: detachMock };
  });
  // eslint-disable-next-line @typescript-eslint/require-await
  const newPageMock = vi.fn().mockImplementation(async () => {
    if (opts.newPageThrows) throw new Error("new-page-boom");
    const p = { evaluate: evaluateMock, goto: gotoMock, close: closeMock };
    pages.push(p);
    return p;
  });
  // eslint-disable-next-line @typescript-eslint/require-await
  const clearCookiesMock = vi.fn().mockImplementation(async () => {
    if (opts.clearCookiesThrows) throw new Error("ck-boom");
  });
  // eslint-disable-next-line @typescript-eslint/require-await
  const clearPermissionsMock = vi.fn().mockImplementation(async () => {
    if (opts.clearPermissionsThrows) throw new Error("perm-boom");
  });
  const cookiesMock = vi.fn().mockResolvedValue([{ domain: "example.com" }]);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ctx: any = {
    pages: () => pages,
    newPage: newPageMock,
    newCDPSession: newCDPSessionMock,
    clearCookies: clearCookiesMock,
    clearPermissions: clearPermissionsMock,
    cookies: cookiesMock,
  };
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  return { ctx, evaluateMock, gotoMock, closeMock, sendMock, detachMock,
    newCDPSessionMock, newPageMock, clearCookiesMock, clearPermissionsMock, cookiesMock };
}

describe("sanitizeBrowserContext", () => {
  it("runs the full happy-path sequence on a single-page context", async () => {
    const s = buildStubContext({ pageCount: 1 });
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    const result = await sanitizeBrowserContext(s.ctx);

    expect(result.errors).toEqual([]);
    expect(result.pagesClosedCount).toBe(0);
    expect(result.cookiesCleared).toBe(true);
    expect(result.permissionsCleared).toBe(true);
    expect(result.storageCleared).toBe(true);
    expect(result.serviceWorkersCleared).toBe(true);
    expect(result.cdpSwept).toBe(true);

    expect(s.gotoMock).toHaveBeenCalledWith("about:blank");
    expect(s.clearCookiesMock).toHaveBeenCalledTimes(1);
    expect(s.clearPermissionsMock).toHaveBeenCalledTimes(1);
    expect(s.evaluateMock).toHaveBeenCalledTimes(1);
    expect(s.sendMock).toHaveBeenCalledWith("Storage.clearDataForOrigin", expect.objectContaining({
      origin: "https://example.com",
    }));
    expect(s.detachMock).toHaveBeenCalledTimes(1);
  });

  it("closes extra pages and reports the count", async () => {
    const s = buildStubContext({ pageCount: 4 });
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    const result = await sanitizeBrowserContext(s.ctx);
    expect(result.pagesClosedCount).toBe(3);
    expect(s.closeMock).toHaveBeenCalledTimes(3);
    expect(result.errors).toEqual([]);
  });

  it("records per-page close errors but continues", async () => {
    const s = buildStubContext({ pageCount: 3, closeThrows: true });
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    const result = await sanitizeBrowserContext(s.ctx);
    expect(result.pagesClosedCount).toBe(0);
    expect(result.errors.filter((e) => e.startsWith("close-page:")).length).toBe(2);
    // remaining steps still ran
    expect(result.cookiesCleared).toBe(true);
    expect(result.cdpSwept).toBe(true);
  });

  it("opens a fresh page when the context has none", async () => {
    const s = buildStubContext({ pageCount: 0 });
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    const result = await sanitizeBrowserContext(s.ctx);
    expect(s.newPageMock).toHaveBeenCalledTimes(1);
    expect(result.storageCleared).toBe(true);
  });

  it("records new-page failure when context has no pages", async () => {
    const s = buildStubContext({ pageCount: 0, newPageThrows: true });
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    const result = await sanitizeBrowserContext(s.ctx);
    expect(result.errors.some((e) => e.startsWith("new-page:"))).toBe(true);
  });

  it("records goto-blank failure", async () => {
    const s = buildStubContext({ pageCount: 1, gotoThrows: true });
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    const result = await sanitizeBrowserContext(s.ctx);
    expect(result.errors.some((e) => e.startsWith("goto-blank:"))).toBe(true);
  });

  it("records clearCookies/clearPermissions failures without throwing", async () => {
    const s = buildStubContext({ clearCookiesThrows: true, clearPermissionsThrows: true });
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    const result = await sanitizeBrowserContext(s.ctx);
    expect(result.cookiesCleared).toBe(false);
    expect(result.permissionsCleared).toBe(false);
    expect(result.errors.some((e) => e.startsWith("clear-cookies:"))).toBe(true);
    expect(result.errors.some((e) => e.startsWith("clear-permissions:"))).toBe(true);
  });

  it("records storage-eval failure", async () => {
    const s = buildStubContext({ evaluateThrows: true });
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    const result = await sanitizeBrowserContext(s.ctx);
    expect(result.storageCleared).toBe(false);
    expect(result.serviceWorkersCleared).toBe(false);
    expect(result.errors.some((e) => e.startsWith("clear-storage:"))).toBe(true);
  });

  it("records CDP attach failure", async () => {
    const s = buildStubContext({ cdpThrows: true });
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    const result = await sanitizeBrowserContext(s.ctx);
    expect(result.cdpSwept).toBe(false);
    expect(result.errors.some((e) => e.startsWith("cdp-sweep:"))).toBe(true);
  });

  it("records CDP send failure and still detaches", async () => {
    const s = buildStubContext({ cdpSendThrows: true });
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    const result = await sanitizeBrowserContext(s.ctx);
    expect(result.cdpSwept).toBe(true);
    // Error is swallowed by loop catch now, so no error is bubbled up
    expect(s.detachMock).toHaveBeenCalledTimes(1);
  });

  it("honors opts to skip individual steps", async () => {
    const s = buildStubContext();
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    const result = await sanitizeBrowserContext(s.ctx, {
      clearCookies: false, clearPermissions: false, clearStorage: false, useCdp: false,
    });
    expect(s.clearCookiesMock).not.toHaveBeenCalled();
    expect(s.clearPermissionsMock).not.toHaveBeenCalled();
    expect(s.evaluateMock).not.toHaveBeenCalled();
    expect(s.newCDPSessionMock).not.toHaveBeenCalled();
    expect(result.errors).toEqual([]);
  });
});
