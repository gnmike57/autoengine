import fs from "node:fs";
import * as path from "path";
import { profileMetrics } from "../profiles/profile-metrics.js";

const DEFAULT_STATIC_CACHE_DIR = path.join(process.cwd(), ".cloak-static-cache");

export const SAFE_CACHE_PATHS: string[] = [
  // 49: Static Asset Caching Across Sessions
  // Make extra sure no. 49 literally only contains the untraceable svg or image files!
  // All binary Chrome caches (JS/CSS) are removed to prevent fingerprinting.
];

export const UNSAFE_PROFILE_PATHS = [
  path.join("Default", "Cookies"),
  path.join("Default", "Cookies-journal"),
  path.join("Default", "Local Storage"),
  path.join("Default", "Session Storage"),
  path.join("Default", "IndexedDB"),
  path.join("Default", "Service Worker"),
  path.join("Default", "Network"),
  path.join("Default", "Login Data"),
  path.join("Default", "Web Data"),
  path.join("Default", "History"),
  path.join("Default", "Top Sites"),
  path.join("Default", "Preferences"),
  "Cookies",
  "Local State",
];

export interface ProfileSanitizationResult {
  removed: string[];
  errors: { path: string; message: string }[];
}

/**
 * Remove every UNSAFE_PROFILE_PATHS entry under `profileDir`. Idempotent —
 * missing entries are treated as already-clean. Surfaces per-path errors
 * rather than throwing so callers running this from finally blocks aren't
 * derailed by a single locked file.
 */
export async function sanitizeProfileDirectory(profileDir: string): Promise<ProfileSanitizationResult> {
  const result: ProfileSanitizationResult = { removed: [], errors: [] };
  for (const rel of UNSAFE_PROFILE_PATHS) {
    const target = path.join(profileDir, rel);
    try {
      const st = await fs.promises.stat(target).catch(() => null);
      if (!st) continue; // Doesn't exist
      await fs.promises.rm(target, { recursive: true, force: true });
      result.removed.push(rel);
    } catch (e: unknown) {
      result.errors.push({ path: rel, message: e instanceof Error ? e.message : String(e) });
    }
  }
  if (result.removed.length > 0) profileMetrics.recordCacheSanitized();
  return result;
}

export function getStaticCacheDir(seed?: number | string): string {
  const base = process.env.CLOAK_STATIC_CACHE_DIR || DEFAULT_STATIC_CACHE_DIR;
  if (seed == null) return base;
  return path.join(base, "seeds", String(seed));
}

/**
 * Scope for a targeted static-cache wipe. The engine narrows wipes to the
 * specific proxy or fingerprint-seed namespace that produced a misdirection
 * burn, so the rest of the cache keeps serving warm assets to unrelated
 * credentials. Either field (or both) may be supplied; an empty scope means
 * "no targeted wipe" and the caller falls back to a whole-root wipe.
 */
export interface StaticCacheScope {
  proxyKey?: string;
  fingerprintSeed?: number;
}

/**
 * Best-effort wipe of per-scope static-cache directories. Returns the list of
 * namespace identifiers actually removed (so callers can log them). Missing
 * directories are silently skipped; errors on individual namespaces are
 * suppressed so a single permission glitch can't take down the run.
 */
export async function wipeStaticCacheNamespaces(scope: StaticCacheScope): Promise<{ wiped: string[] }> {
  const wiped: string[] = [];
  const base = getStaticCacheDir();
  const candidates: Array<{ label: string; dir: string }> = [];
  if (typeof scope.fingerprintSeed === "number") {
    candidates.push({ label: `seed:${scope.fingerprintSeed}`, dir: getStaticCacheDir(scope.fingerprintSeed) });
  }
  if (scope.proxyKey) {
    const safeKey = scope.proxyKey.replace(/[^A-Za-z0-9_.-]+/g, "_");
    candidates.push({ label: `proxy:${scope.proxyKey}`, dir: path.join(base, "proxies", safeKey) });
  }
  for (const { label, dir } of candidates) {
    try {
      if (fs.existsSync(dir)) {
        await fs.promises.rm(dir, { recursive: true, force: true });
        wiped.push(label);
      }
    } catch {
      // Swallow per-namespace errors — the caller logs the aggregated result.
    }
  }
  return { wiped };
}

export function isStaticCacheEnabled(): boolean {
  return (process.env.CLOAK_STATIC_CACHE || "true").toLowerCase() !== "false";
}

export async function sanitizeStaticCacheProfile(profileDir = getStaticCacheDir()): Promise<void> {
  await sanitizeProfileDirectory(profileDir);
}

async function asyncExists(p: string): Promise<boolean> {
  try {
    await fs.promises.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function seedStaticAssetCache(userDataDir: string, seed?: number | string): Promise<boolean> {
  if (!isStaticCacheEnabled()) return false;

  const globalDir = getStaticCacheDir();
  const seedDir = getStaticCacheDir(seed);

  // If the per-seed cache doesn't exist but the global one does, initialize the per-seed cache
  if (seed != null && !(await asyncExists(seedDir)) && (await asyncExists(globalDir))) {
    await fs.promises.mkdir(seedDir, { recursive: true });
    for (const rel of SAFE_CACHE_PATHS) {
      const src = path.join(globalDir, rel);
      if (await asyncExists(src)) {
        const dest = path.join(seedDir, rel);
        await fs.promises.mkdir(path.dirname(dest), { recursive: true });
        await fs.promises.cp(src, dest, { recursive: true, force: false, errorOnExist: false });
      }
    }
  }

  const sourceDir = seed != null && (await asyncExists(seedDir)) ? seedDir : globalDir;
  if (!(await asyncExists(sourceDir))) return false;

  await sanitizeStaticCacheProfile(sourceDir);
  let copied = false;
  for (const rel of SAFE_CACHE_PATHS) {
    const src = path.join(sourceDir, rel);
    if (!(await asyncExists(src))) continue;
    const dest = path.join(userDataDir, rel);
    await fs.promises.mkdir(path.dirname(dest), { recursive: true });
    await fs.promises.cp(src, dest, { recursive: true, force: false, errorOnExist: false });
    copied = true;
  }
  if (copied) profileMetrics.recordCacheSeeded();
  return copied;
}