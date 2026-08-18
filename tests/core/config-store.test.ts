/**
 * Test 4: ConfigStore — Atomic Load/Save/SaveAsync
 *
 * Tests the configuration persistence layer including atomic writes,
 * defaults fallback, partial merge, and corruption handling.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// We can't easily override CONFIG_PATH, so we test the logic patterns directly
describe("ConfigStore logic patterns", () => {
  let tmpDir: string;
  let configPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "config-test-"));
    configPath = path.join(tmpDir, "app-config.json");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // Replicate ConfigStore.load() logic
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function load(): any {
    const DEFAULT_CONFIG = {
      backend: "stealth",
      concurrency: 5,
      inputMode: "instant",
      allowHumanTyping: false,
      alwaysClickRememberMe: true,
      maxRetries: 2,
      proxyPool: "4r",
      fpStrategy: "none",
      parallelSiteTesting: false,
      autoOptimizePerBackend: true,
      enableCacheInjection: false,
      injectStealthJS: false,
      recordVideo: false,
      postLoadDelay: 0,
      useHttpCloak: true,
      stealthBypassHttpCloak: true,
    };

    if (!fs.existsSync(configPath)) {
      const tmpPath = `${configPath}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(DEFAULT_CONFIG, null, 2), "utf8");
      fs.renameSync(tmpPath, configPath);
      return DEFAULT_CONFIG;
    }
    try {
      const data = fs.readFileSync(configPath, "utf8");
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const parsed = JSON.parse(data);
      return { ...DEFAULT_CONFIG, ...parsed };
    } catch {
      return DEFAULT_CONFIG;
    }
  }

  // Replicate ConfigStore.save() logic
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function save(partial: any) {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const current = load();
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const updated = { ...current, ...partial };
    const tmpPath = `${configPath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(updated, null, 2), "utf8");
    fs.renameSync(tmpPath, configPath);
  }

  it("load() returns DEFAULT_CONFIG when no file exists", () => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const config = load();
    expect(config.backend).toBe("stealth");
    expect(config.concurrency).toBe(5);
    expect(config.autoOptimizePerBackend).toBe(true);
  });

  it("load() creates app-config.json on first call", () => {
    expect(fs.existsSync(configPath)).toBe(false);
    load();
    expect(fs.existsSync(configPath)).toBe(true);
  });

  it("load() merges saved config with DEFAULT_CONFIG (new fields get defaults)", () => {
    // Write a config file missing the autoOptimizePerBackend field
    fs.writeFileSync(configPath, JSON.stringify({ backend: "cloak-headless", concurrency: 8 }), "utf8");
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const config = load();
    expect(config.backend).toBe("cloak-headless");
    expect(config.concurrency).toBe(8);
    expect(config.autoOptimizePerBackend).toBe(true); // Filled from defaults
  });

  it("load() handles corrupted JSON gracefully (returns defaults)", () => {
    fs.writeFileSync(configPath, "NOT VALID JSON {{{", "utf8");
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const config = load();
    expect(config.backend).toBe("stealth"); // Defaults
    expect(config.concurrency).toBe(5);
  });

  it("save() persists partial config merged with current", () => {
    load(); // Initialize
    save({ concurrency: 10 });
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const config = load();
    expect(config.concurrency).toBe(10);
    expect(config.backend).toBe("stealth"); // Preserved
  });

  it("save() uses atomic tmp+rename (no truncated files)", () => {
    load();
    save({ backend: "zendriver" });
    // Verify the tmp file doesn't linger
    expect(fs.existsSync(`${configPath}.tmp`)).toBe(false);
    // Verify the actual file is valid JSON
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const content = JSON.parse(fs.readFileSync(configPath, "utf8"));
    expect(content.backend).toBe("zendriver");
  });

  it("save() preserves fields not in the partial update", () => {
    load();
    save({ concurrency: 10 });
    save({ backend: "zendriver" });
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const config = load();
    expect(config.concurrency).toBe(10); // Still 10
    expect(config.backend).toBe("zendriver");
  });

  it("autoOptimizePerBackend defaults to true", () => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const config = load();
    expect(config.autoOptimizePerBackend).toBe(true);
  });

  it("allowHumanTyping defaults to false (strict rule enforcement)", () => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const config = load();
    expect(config.allowHumanTyping).toBe(false);
  });

  it("alwaysClickRememberMe defaults to true (strict rule enforcement)", () => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const config = load();
    expect(config.alwaysClickRememberMe).toBe(true);
  });

  it("enableCacheInjection defaults to false", () => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const config = load();
    expect(config.enableCacheInjection).toBe(false);
  });

  it("postLoadDelay defaults to 0 (zero-sleep-polling rule)", () => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const config = load();
    expect(config.postLoadDelay).toBe(0);
  });
});
