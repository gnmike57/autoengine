/**
 * Persistent denylist for fingerprint seeds and proxy sticky-sessions that
 * have been burned by site-side misdirection — i.e. an UPDATE YOUR PIN /
 * PIN UPDATE screen on joe or ignition, or a repeat Ignition LOGIN VERIFICATION
 * popup in a single credential session. Once a seed or proxy key is burned
 * it must never be reused: the site has correlated the fingerprint with
 * that identity / sticky exit, and any subsequent attempt is silently
 * misdirected to manufacture a false-positive.
 *
 * Burns are keyed by the unique sticky-session identifier (`server#username`)
 * so a burn on one entry does not quarantine the rest of a residential pool
 * whose 200 entries share the same gateway host:port. Burns survive across
 * runs via a sidecar JSON file.
 */
import fs from "node:fs";
import { createLogger } from "./logger.js";

const log = createLogger("misdirection-denylist");

export interface MisdirectionStatEntry {
  trigger: string;
  url: string;
  email?: string;
  userAgent?: string;
  resolution?: string;
  timestamp: string;
  /** Client-Hints alignment status — were sec-ch-ua headers injected for this session? */
  clientHintsAligned?: boolean;
  /** Declared OS for font metric spoofing (windows | macos) */
  fontMetricOs?: string;
  /** Whether AudioContext obfuscation was active */
  audioSpoofActive?: boolean;
  /** The fingerprint seed used for font/audio noise generation */
  stealthSeed?: number;
  /** Chrome major version from the UA profile */
  chromeMajor?: number;
  /** OS declared in the UA (windows | macos) */
  declaredOs?: string;
  /** Sec-CH-UA-Platform value that was sent */
  chPlatform?: string;
  /** Backend used for this session (spider-local | cloak-headless | cloak-headed) */
  backend?: string;
}

export interface MisdirectionBurnInput {
  /** Unique sticky-session key, e.g. `server#username`. */
  proxyKey?: string;
  fingerprintSeed?: number;
  reason?: string;
  statEntry?: MisdirectionStatEntry;
}

interface DenylistJSON {
  /** Sticky-session keys (`server#username`). Legacy files keyed by bare
   *  server are accepted on load and effectively become orphans — no live
   *  proxyKey will ever match a bare-server entry. */
  proxies?: string[];
  seeds?: number[];
  stats?: MisdirectionStatEntry[];
}

export class MisdirectionDenylist {
  private proxies = new Set<string>();
  private seeds = new Set<number>();
  private stats: MisdirectionStatEntry[] = [];

  /** Burn the provided fingerprint seed and/or proxy key. Idempotent. */
  burn(input: MisdirectionBurnInput): { burnedProxy: boolean; burnedSeed: boolean } {
    let burnedProxy = false;
    let burnedSeed = false;
    if (input.proxyKey && !this.proxies.has(input.proxyKey)) {
      this.proxies.add(input.proxyKey);
      burnedProxy = true;
    }
    if (typeof input.fingerprintSeed === "number" && !this.seeds.has(input.fingerprintSeed)) {
      this.seeds.add(input.fingerprintSeed);
      burnedSeed = true;
    }
    if (input.statEntry) {
      this.stats.push(input.statEntry);
      if (this.stats.length > 5000) this.stats.shift();
    }
    return { burnedProxy, burnedSeed };
  }

  isProxyBurned(proxyKey: string | undefined): boolean {
    return !!proxyKey && this.proxies.has(proxyKey);
  }

  isFingerprintBurned(seed: number | undefined): boolean {
    return typeof seed === "number" && this.seeds.has(seed);
  }

  getBurnedProxies(): string[] {
    return Array.from(this.proxies);
  }

  getBurnedSeeds(): number[] {
    return Array.from(this.seeds);
  }

  size(): { proxies: number; seeds: number } {
    return { proxies: this.proxies.size, seeds: this.seeds.size };
  }

  /** Best-effort write of the denylist to a sidecar JSON file (async to avoid blocking). */
  async save(filePath: string): Promise<void> {
    const data: DenylistJSON = {
      proxies: Array.from(this.proxies),
      seeds: Array.from(this.seeds),
      stats: this.stats,
    };
    const tmpPath = `${filePath}.tmp`;
    try {
      await fs.promises.writeFile(tmpPath, JSON.stringify(data, null, 2));
      await fs.promises.rename(tmpPath, filePath);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      log.warn(`Failed to save to ${filePath}: ${msg}`);
    }
  }

  /** Best-effort load from a sidecar JSON file. No-op if absent. */
  load(filePath: string): void {
    if (!fs.existsSync(filePath)) return;
    try {
      const raw = fs.readFileSync(filePath, "utf-8");
      const data = JSON.parse(raw) as DenylistJSON;
      this.proxies.clear();
      this.seeds.clear();
      if (Array.isArray(data.proxies)) {
        for (const p of data.proxies) if (typeof p === "string") this.proxies.add(p);
      }
      if (Array.isArray(data.seeds)) {
        for (const s of data.seeds) if (typeof s === "number" && Number.isFinite(s)) this.seeds.add(s);
      }
      if (Array.isArray(data.stats)) {
        this.stats = data.stats;
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      log.warn(`Failed to load ${filePath}: ${msg}`);
    }
  }
}

/** Module-singleton denylist. Engine loads/persists it across runs. */
export const misdirectionDenylist = new MisdirectionDenylist();

/**
 * Thrown by createSession when the email's deterministic fingerprint seed has
 * been denylisted by a prior misdirection event. Distinct error class so the
 * engine's row loop can short-circuit the proxy-retry loop instead of
 * thrashing through every candidate.
 */
export class BurnedFingerprintError extends Error {
  readonly seed?: number;
  constructor(seed?: number) {
    super(`Fingerprint seed ${seed ?? 'unknown'} is denylisted (prior misdirection)`);
    this.name = "BurnedFingerprintError";
    this.seed = seed;
  }
}
