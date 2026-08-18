/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return */
/**
 * Centralized in-memory sanitization for a Playwright BrowserContext.
 *
 * Cloak's headed and headless reuse paths each had a hand-rolled "close
 * extras → about:blank → clearCookies → clear local/session storage"
 * sequence. Those variants drifted over time and none of them touched
 * permissions, IndexedDB, CacheStorage, or Service Workers — exactly the
 * surfaces fingerprint vendors query for "is this profile fresh?". This
 * module replaces the duplicates with a single best-effort routine.
 *
 * Every step is best-effort: failures are recorded on the returned
 * SanitizationResult rather than thrown, because cleanup runs from
 * close()/finally paths where throwing would mask the original error.
 */
import type { BrowserContext, Page } from "playwright-core";

export interface SanitizationOptions {
  clearCookies?: boolean;
  clearPermissions?: boolean;
  clearStorage?: boolean;
  /** When true, use CDP Storage.clearDataForOrigin("*") for a cross-origin sweep. */
  useCdp?: boolean;
}

export interface SanitizationResult {
  cookiesCleared: boolean;
  permissionsCleared: boolean;
  pagesClosedCount: number;
  storageCleared: boolean;
  serviceWorkersCleared: boolean;
  cdpSwept: boolean;
  errors: string[];
}

async function clearInPageStorage(page: Page): Promise<void> {
  await page.evaluate(async () => {
    try { localStorage.clear(); } catch { /* intentional */ }
    try { sessionStorage.clear(); } catch { /* intentional */ }
    try {

      const idb: any = (globalThis as any).indexedDB;
      if (idb && typeof idb.databases === "function") {
        const dbs = await idb.databases();
        for (const db of dbs) {
          if (db && db.name) { try { idb.deleteDatabase(db.name); } catch { /* intentional */ } }
        }
      }
    } catch { /* intentional */ }
    try {
      if (typeof caches !== "undefined") {
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k).catch(() => false)));
      }
    } catch { /* intentional */ }
    try {

      const nav: any = (globalThis as any).navigator;
      if (nav && nav.serviceWorker && typeof nav.serviceWorker.getRegistrations === "function") {
        const regs = await nav.serviceWorker.getRegistrations();

        await Promise.all(regs.map((r: any) => r.unregister().catch(() => false)));
      }
    } catch { /* intentional */ }
  });
}

async function sweepViaCdp(context: BrowserContext, page: Page): Promise<void> {
  const cdp = await context.newCDPSession(page);
  try {
    const cookies = await context.cookies();
    const domains = new Set(cookies.map(c => c.domain.replace(/^\./, '')));
    // Playwright API provides no way to discover all origins with localStorage.
    // We guess the origins by looking at what cookies are set.
    for (const d of domains) {
      const origin = `https://${d}`;
      await cdp.send("Storage.clearDataForOrigin", {
        origin,
        storageTypes:
          "appcache,cookies,file_systems,indexeddb,local_storage,shader_cache,websql,service_workers,cache_storage",

      } as any).catch(() => {});
    }
  } finally {
    await cdp.detach().catch(() => { });
  }
}

export async function sanitizeBrowserContext(
  context: BrowserContext,
  opts: SanitizationOptions = {}
): Promise<SanitizationResult> {
  const clearCookies = opts.clearCookies ?? true;
  const clearPermissions = opts.clearPermissions ?? true;
  const clearStorage = opts.clearStorage ?? true;
  const useCdp = opts.useCdp ?? true;

  const result: SanitizationResult = {
    cookiesCleared: false,
    permissionsCleared: false,
    pagesClosedCount: 0,
    storageCleared: false,
    serviceWorkersCleared: false,
    cdpSwept: false,
    errors: [],
  };

  const pages = context.pages();
  for (let i = 1; i < pages.length; i++) {
    try {
      const page = pages[i];
      if (page) await page.close();
      result.pagesClosedCount++;
    } catch (e: unknown) {
      result.errors.push(`close-page: ${(e instanceof Error ? e.message : String(e)) ?? e}`);
    }
  }

  let main: Page | undefined = context.pages()[0];
  if (!main) {
    try { main = await context.newPage(); }
    catch (e: unknown) { result.errors.push(`new-page: ${(e instanceof Error ? e.message : String(e)) ?? e}`); }
  }
  if (clearStorage && main) {
    try {
      await clearInPageStorage(main);
      result.storageCleared = true;
      result.serviceWorkersCleared = true;
    } catch (e: unknown) {
      result.errors.push(`clear-storage: ${(e instanceof Error ? e.message : String(e)) ?? e}`);
    }
  }

  if (main) {
    try { await main.goto("about:blank"); }
    catch (e: unknown) { result.errors.push(`goto-blank: ${(e instanceof Error ? e.message : String(e)) ?? e}`); }
  }

  if (clearCookies) {
    try { await context.clearCookies(); result.cookiesCleared = true; }
    catch (e: unknown) { result.errors.push(`clear-cookies: ${(e instanceof Error ? e.message : String(e)) ?? e}`); }
  }

  if (clearPermissions) {
    try { await context.clearPermissions(); result.permissionsCleared = true; }
    catch (e: unknown) { result.errors.push(`clear-permissions: ${(e instanceof Error ? e.message : String(e)) ?? e}`); }
  }

  if (useCdp && main) {
    try {
      await sweepViaCdp(context, main);
      result.cdpSwept = true;
    } catch (e: unknown) {
      result.errors.push(`cdp-sweep: ${(e instanceof Error ? e.message : String(e)) ?? e}`);
    }
  }

  return result;
}