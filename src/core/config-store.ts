/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return */
import fs from 'fs';
import path from 'path';
import { createLogger } from './logger.js';

const log = createLogger('ConfigStore');

export interface AppConfig {
  backend: string;
  concurrency: number;
  inputMode: "instant" | "chrome-autofill";
  allowHumanTyping: boolean; // strict rule: must always be false
  alwaysClickRememberMe: boolean; // strict rule: must always be true
  maxRetries: number;
  proxyPool: string;
  fpStrategy: string;
  parallelSiteTesting: boolean;
  ignitionVerifBypass: boolean;
  rotateOnFingerprint: boolean;
  burnOnlyOnPermDisabled: boolean;
  mutateOnRetry: boolean;
  recycleSessionOnIncorrect: boolean;
  manualCaptchaMode: boolean;
  autoOptimizePerBackend: boolean;
  stealthProfile: string;
  enableCacheInjection: boolean;
  advEmulateMobile: boolean;
  injectStealthJS: boolean;
  recordVideo: boolean;
  enablePlaywrightTracing: boolean;
  postLoadDelay: number;
  enableVerification: boolean;
  useHttpCloak: boolean;
  stealthBypassHttpCloak: boolean;
  proxyRotateUrl: string;
  tilingLayout: string;
  macOSTilingEngine: "native-cdp" | "profile-injection" | "os-native";
  enableAgentObservation: boolean;
  goldenCredentials: { joe?: string; ignition?: string };
  spiderApiKey?: string;
}

const CONFIG_PATH = process.env.AUTOMATI_CONFIG_PATH
  ? path.resolve(process.cwd(), process.env.AUTOMATI_CONFIG_PATH)
  : path.join(process.cwd(), 'app-config.json');

const DEFAULT_CONFIG: AppConfig = {
  backend: "stealth",
  concurrency: 5,
  inputMode: "instant",
  allowHumanTyping: false,
  alwaysClickRememberMe: true,
  maxRetries: 2,
  proxyPool: "4r",
  fpStrategy: "none",  // Stealth (Camoufox) uses native C++ spoofing — no plugin needed
  parallelSiteTesting: false,
  ignitionVerifBypass: true,
  rotateOnFingerprint: false,
  burnOnlyOnPermDisabled: true,
  mutateOnRetry: true,
  recycleSessionOnIncorrect: false,
  manualCaptchaMode: false,
  autoOptimizePerBackend: true,
  stealthProfile: "autonomous",
  enableCacheInjection: false,
  advEmulateMobile: false,
  injectStealthJS: false,  // Stealth has native evasion — JS injection is for Cloak/Zendriver
  recordVideo: false,  // Stealth headless defaults to no video for max speed
  enablePlaywrightTracing: false,
  postLoadDelay: 0,   // strict-zero-sleep-polling rule
  enableVerification: true,
  useHttpCloak: true,  // HttpCloak enabled by default for stealth
  stealthBypassHttpCloak: true,
  proxyRotateUrl: "",
  tilingLayout: "horizontal",
  macOSTilingEngine: "native-cdp",
  enableAgentObservation: false,
  goldenCredentials: {
    joe: process.env.GOLDEN_CRED_JOE ?? "",
    ignition: process.env.GOLDEN_CRED_IGNITION ?? "",
  },
};

export class ConfigStore {
  static load(): AppConfig {
    if (!fs.existsSync(CONFIG_PATH)) {
      try {
        // Rule 30: Atomic write via tmp+rename so a crash mid-write
        // doesn't leave a truncated config file.
        const tmpPath = `${CONFIG_PATH}.tmp`;
        fs.writeFileSync(tmpPath, JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf8');
        fs.renameSync(tmpPath, CONFIG_PATH);
      } catch (err) {
        log.error(`Failed to write initial app-config.json: ${String(err)}`);
      }
      return DEFAULT_CONFIG;
    }
    try {
      const data = fs.readFileSync(CONFIG_PATH, 'utf8');
      const parsed = JSON.parse(data);
      return { ...DEFAULT_CONFIG, ...parsed };
    } catch (err) {
      log.warn(`Failed to read app-config.json, using defaults: ${String(err)}`);
      return DEFAULT_CONFIG;
    }
  }

  static save(config: Partial<AppConfig>) {
    const current = this.load();
    const updated = { ...current, ...config };
    try {
      // Rule 30: Atomic write via tmp+rename
      const tmpPath = `${CONFIG_PATH}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(updated, null, 2), 'utf8');
      fs.renameSync(tmpPath, CONFIG_PATH);
    } catch (err) {
      log.error(`Failed to write app-config.json: ${String(err)}`);
    }
  }

  static async saveAsync(config: Partial<AppConfig>) {
    const current = this.load(); // loading is fast enough, writing is the bottleneck
    const updated = { ...current, ...config };
    try {
      // Rule 30: Atomic write via tmp+rename
      const tmpPath = `${CONFIG_PATH}.tmp`;
      await fs.promises.writeFile(tmpPath, JSON.stringify(updated, null, 2), 'utf8');
      await fs.promises.rename(tmpPath, CONFIG_PATH);
    } catch (err) {
      log.error(`Failed to async write app-config.json: ${String(err)}`);
    }
  }
}
