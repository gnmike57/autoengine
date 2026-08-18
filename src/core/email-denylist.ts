/**
 * Persistent per-site denylist for credential emails that must never be re-run on a specific site.
 * Population sources:
 *   1. Operator seeds (manually edited JSON files).
 *   2. Auto-burns from the engine when a site returns PermDisabled.
 */
import * as fs from "fs";
import { createLogger } from "./logger.js";

const log = createLogger("email-denylist");

interface DenylistJSON {
  emails?: string[];
}

function normalize(email: string): string {
  return email.trim().toLowerCase();
}

export class EmailDenylist {
  // Map of siteName -> Set of emails
  private lists = new Map<string, Set<string>>();
  private dirty = new Map<string, boolean>();

  private getSet(site: string): Set<string> {
    if (!this.lists.has(site)) {
      this.lists.set(site, new Set());
      this.dirty.set(site, false);
    }
    return this.lists.get(site)!;
  }

  add(email: string, site: string, reason?: string): boolean {
    const key = normalize(email);
    if (!key) return false;
    const set = this.getSet(site);
    if (set.has(key)) return false;
    set.add(key);
    this.dirty.set(site, true);
    if (reason) {
      log.info(`[${site}] +${key} (${reason})`);
    }
    return true;
  }

  has(email: string | undefined | null, site: string): boolean {
    if (!email) return false;
    return this.getSet(site).has(normalize(email));
  }

  getAll(site: string): string[] {
    return Array.from(this.getSet(site)).sort();
  }

  size(site: string): number {
    return this.getSet(site).size;
  }

  async saveAll(): Promise<void> {
    for (const [site, isDirty] of this.dirty.entries()) {
      if (isDirty) {
        await this.saveSite(site);
      }
    }
  }

  private async saveSite(site: string): Promise<void> {
    const filePath = `email-denylist-${site}.json`;
    try {
      const data: DenylistJSON = { emails: this.getAll(site) };
      const json = JSON.stringify(data, null, 2);
      const tmp = `${filePath}.tmp`;
      try {
        await fs.promises.writeFile(tmp, json);
        await fs.promises.rename(tmp, filePath);
      } catch {
        await fs.promises.writeFile(filePath, json);
        try { await fs.promises.unlink(tmp); } catch { /* intentional */ }
      }
      this.dirty.set(site, false);
    } catch (e: unknown) {
      log.warn(`Failed to save to ${filePath}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  loadSite(site: string): void {
    const filePath = `email-denylist-${site}.json`;
    if (!fs.existsSync(filePath)) return;
    try {
      const raw = fs.readFileSync(filePath, "utf-8");
      const data = JSON.parse(raw) as DenylistJSON;
      const set = this.getSet(site);
      set.clear();
      if (Array.isArray(data.emails)) {
        for (const e of data.emails) {
          if (typeof e === "string") {
            const key = normalize(e);
            if (key) set.add(key);
          }
        }
      }
      this.dirty.set(site, false); // Just loaded, not dirty
      log.info(`[${site}] Loaded ${set.size} denylisted emails from ${filePath}`);
    } catch (e: unknown) {
      log.warn(`Failed to load ${filePath}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  loadAll(sites: string[]): void {
    for (const site of sites) {
      this.loadSite(site);
    }
  }
}

export const emailDenylist = new EmailDenylist();
