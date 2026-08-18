/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import tls from "tls";
import fs from "fs";
import path from "path";
import { createLogger } from "../core/logger.js";
import { fileURLToPath } from "url";

const log = createLogger("tls-proxy");

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface JA3Profile {
  id: string;
  browser: string;
  os: string;
  version: string;
  ja3: string;
  ciphers: string[];
  sigalgs: string;
}

export class TLSProxyEngine {
  private profiles: JA3Profile[] = [];
  private loadPromise: Promise<void> | null = null;

  constructor() {
    this.loadProfiles().catch((e) => {
      log.warn(`Failed to start loading JA3 profiles: ${String(e)}`);
    });
  }

  public async loadProfiles(): Promise<void> {
    if (this.loadPromise) return this.loadPromise;
    this.loadPromise = (async () => {
      try {
        const p = path.join(__dirname, "../../data/ja3-profiles.json");
        if (fs.existsSync(p)) {
          const data = await fs.promises.readFile(p, "utf-8");
          this.profiles = JSON.parse(data);
          log.info(`Loaded ${this.profiles.length} JA3 profiles for TLS evasion.`);
        }
      } catch (e) {
        log.warn(`Failed to load JA3 profiles: ${String(e)}`);
      }
    })();
    return this.loadPromise;
  }

  public getRandomProfile(): JA3Profile | undefined {
    if (this.profiles.length === 0) return undefined;
    return this.profiles[Math.floor(Math.random() * this.profiles.length)];
  }

  public getProfileMatch(ua: string, os: string): JA3Profile | undefined {
    if (this.profiles.length === 0) return undefined;
    const isFirefox = ua.toLowerCase().includes("firefox");
    const browserTarget = isFirefox ? "firefox" : "chrome";
    const osTarget = os.toLowerCase();

    const matching = this.profiles.filter(p =>
      p.browser.toLowerCase() === browserTarget &&
      p.os.toLowerCase() === osTarget
    );

    if (matching.length > 0) {
      return matching[Math.floor(Math.random() * matching.length)];
    }
    return this.getRandomProfile();
  }

  /**
   * Applies the selected JA3 profile to the TLS connection options.
   * Node.js allows specifying `ciphers` and `sigalgs` directly.
   */
  public applyTLSOptions(options: tls.ConnectionOptions, profile?: JA3Profile): tls.ConnectionOptions {
    const selected = profile || this.getRandomProfile();
    if (!selected) return options;

    return {
      ...options,
      ciphers: selected.ciphers.join(":"),
      sigalgs: selected.sigalgs,
      honorCipherOrder: true,
      minVersion: "TLSv1.2",
      maxVersion: "TLSv1.3",
    };
  }

  /**
   * Provides a custom TLS Agent options object configured with a stealth profile.
   * Can be injected into Apify/Playwright contexts if supported.
   */
  public getStealthAgentOptions(profile?: JA3Profile) {
    const selected = profile || this.getRandomProfile();
    if (!selected) return {};

    return {
      ciphers: selected.ciphers.join(":"),
      sigalgs: selected.sigalgs,
    };
  }
}

export const tlsProxyEngine = new TLSProxyEngine();
