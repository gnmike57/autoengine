import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSession } from "../../backends/index.js";
import {
  MullvadSessionAdapter,
  type MullvadAdapterDependencies,
} from "../../src/proxy/mullvad-session-adapter.js";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mullvad-adapter-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function dependencies(overrides: Partial<MullvadAdapterDependencies> = {}): MullvadAdapterDependencies {
  return {
    probeProxy: vi.fn().mockResolvedValue("exit-proof"),
    reservePort: vi.fn().mockResolvedValue(41080),
    launchWireproxy: vi.fn().mockResolvedValue({
      assertAlive: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
    }),
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.MULLVAD_WG_CONFIG_DIR;
  delete process.env.MULLVAD_RELAY_SOCKS_HOSTS;
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("MullvadSessionAdapter", () => {
  it("fails closed when disabled", async () => {
    const adapter = new MullvadSessionAdapter({ mode: "disabled", dependencies: dependencies() });
    await expect(adapter.acquire("session-a")).rejects.toThrow("mullvad-session-adapter-disabled");
  });

  it("rejects shared OS-tunnel SOCKS mode without explicit opt-in", async () => {
    const adapter = new MullvadSessionAdapter({ mode: "os-socks", dependencies: dependencies() });
    await expect(adapter.acquire("owned-session")).rejects.toThrow(
      "mullvad-os-socks-shared-tunnel-requires-opt-in",
    );
  });

  it("leases a deterministic explicitly shared Mullvad in-tunnel SOCKS endpoint and proves the route", async () => {
    const deps = dependencies();
    const adapter = new MullvadSessionAdapter({
      mode: "os-socks",
      allowSharedOsTunnel: true,
      relaySocksHosts: ["au1-wg.socks5.relays.mullvad.net", "au2-wg.socks5.relays.mullvad.net"],
      dependencies: deps,
    });
    const first = await adapter.acquire("owned-session");
    const second = await adapter.acquire("owned-session");
    expect(first.proxy).toEqual(second.proxy);
    expect(first.proxy.server).toMatch(/^socks5:\/\/au[12]-wg\.socks5\.relays\.mullvad\.net:1080$/);
    expect(first.exitProof).toBe("exit-proof");
    expect(first.isolation).toBe("shared-os-tunnel");
    expect(deps.probeProxy).toHaveBeenCalledWith(first.proxy);
    expect(() => first.assertHealthy()).not.toThrow();
    await first.close();
    expect(() => first.assertHealthy()).toThrow("mullvad-lease-closed");
    await first.close();
    await second.close();
  });

  it("leases one private WireGuard config to one local SOCKS process and releases it idempotently", async () => {
    const root = temporaryDirectory();
    const configDirectory = path.join(root, "configs");
    const stateDirectory = path.join(root, "state");
    fs.mkdirSync(configDirectory, { mode: 0o700 });
    const config = path.join(configDirectory, "au-syd.conf");
    fs.writeFileSync(config, "[Interface]\nPrivateKey = redacted-test-fixture\n", { mode: 0o600 });
    const close = vi.fn().mockResolvedValue(undefined);
    const assertAlive = vi.fn();
    const deps = dependencies({ launchWireproxy: vi.fn().mockResolvedValue({ assertAlive, close }) });
    const adapter = new MullvadSessionAdapter({
      mode: "wireproxy",
      wgConfigDir: configDirectory,
      stateDir: stateDirectory,
      dependencies: deps,
    });

    const lease = await adapter.acquire("session-one");
    expect(lease.mode).toBe("wireproxy");
    expect(lease.isolation).toBe("dedicated-wireguard-config");
    expect(lease.proxy).toEqual({ server: "socks5://127.0.0.1:41080", protocol: "socks5" });
    expect(lease.configId).toMatch(/^[a-f0-9]{16}$/);
    expect(fs.existsSync(path.join(stateDirectory, `${lease.configId}.lock`))).toBe(true);
    expect(deps.launchWireproxy).toHaveBeenCalledWith(expect.objectContaining({
      sourceConfig: config,
      bindHost: "127.0.0.1",
      bindPort: 41080,
    }));
    expect(assertAlive).toHaveBeenCalledTimes(1);
    expect(() => lease.assertHealthy()).not.toThrow();

    await lease.close();
    await lease.close();
    expect(close).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(path.join(stateDirectory, `${lease.configId}.lock`))).toBe(false);
  });

  it("does not allocate one WireGuard config to two live sessions", async () => {
    const root = temporaryDirectory();
    const configDirectory = path.join(root, "configs");
    fs.mkdirSync(configDirectory, { mode: 0o700 });
    fs.writeFileSync(path.join(configDirectory, "only.conf"), "[Interface]\nPrivateKey = test\n", { mode: 0o600 });
    const adapter = new MullvadSessionAdapter({
      mode: "wireproxy",
      wgConfigDir: configDirectory,
      stateDir: path.join(root, "state"),
      dependencies: dependencies(),
    });
    const first = await adapter.acquire("first");
    await expect(adapter.acquire("second")).rejects.toThrow("mullvad-wg-config-pool-exhausted");
    await first.close();
    await expect(adapter.acquire("second")).resolves.toMatchObject({ mode: "wireproxy" });
  });

  it("reclaims a stale dead-process config lock before allocating the lease", async () => {
    const root = temporaryDirectory();
    const configDirectory = path.join(root, "configs");
    const stateDirectory = path.join(root, "state");
    fs.mkdirSync(configDirectory, { mode: 0o700 });
    fs.mkdirSync(stateDirectory, { mode: 0o700 });
    fs.writeFileSync(path.join(configDirectory, "stale.conf"), "[Interface]\nPrivateKey = test\n", { mode: 0o600 });
    const configId = crypto.createHash("sha256").update("stale.conf").digest("hex").slice(0, 16);
    fs.writeFileSync(path.join(stateDirectory, `${configId}.lock`), `${JSON.stringify({ pid: 2_147_483_647 })}\n`, { mode: 0o600 });
    const adapter = new MullvadSessionAdapter({
      mode: "wireproxy",
      wgConfigDir: configDirectory,
      stateDir: stateDirectory,
      dependencies: dependencies(),
    });
    const lease = await adapter.acquire("replacement");
    expect(lease.configId).toBe(configId);
    await lease.close();
  });

  it("surfaces a wireproxy failure that occurs after startup", async () => {
    const root = temporaryDirectory();
    const configDirectory = path.join(root, "configs");
    fs.mkdirSync(configDirectory, { mode: 0o700 });
    fs.writeFileSync(path.join(configDirectory, "health.conf"), "[Interface]\nPrivateKey = test\n", { mode: 0o600 });
    let checks = 0;
    const assertAlive = vi.fn(() => {
      checks += 1;
      if (checks > 1) throw new Error("wireproxy-exited-after-ready:1:none");
    });
    const adapter = new MullvadSessionAdapter({
      mode: "wireproxy",
      wgConfigDir: configDirectory,
      stateDir: path.join(root, "state"),
      dependencies: dependencies({
        launchWireproxy: vi.fn().mockResolvedValue({
          assertAlive,
          close: vi.fn().mockResolvedValue(undefined),
        }),
      }),
    });
    const lease = await adapter.acquire("session");
    expect(() => lease.assertHealthy()).toThrow("wireproxy-exited-after-ready:1:none");
    await lease.close();
  });

  it("rejects group- or world-readable WireGuard configurations", async () => {
    const root = temporaryDirectory();
    const configDirectory = path.join(root, "configs");
    fs.mkdirSync(configDirectory, { mode: 0o700 });
    const unsafeConfig = path.join(configDirectory, "unsafe.conf");
    fs.writeFileSync(unsafeConfig, "[Interface]\nPrivateKey = test\n", { mode: 0o644 });
    fs.chmodSync(unsafeConfig, 0o644);
    const adapter = new MullvadSessionAdapter({
      mode: "wireproxy",
      wgConfigDir: configDirectory,
      stateDir: path.join(root, "state"),
      dependencies: dependencies(),
    });
    await expect(adapter.acquire("session")).rejects.toThrow("mullvad-config-permissions-must-be-0600");
  });

  it("releases the process, runtime directory, and config lock when route proof fails", async () => {
    const root = temporaryDirectory();
    const configDirectory = path.join(root, "configs");
    const stateDirectory = path.join(root, "state");
    fs.mkdirSync(configDirectory, { mode: 0o700 });
    fs.writeFileSync(path.join(configDirectory, "probe-fail.conf"), "[Interface]\nPrivateKey = test\n", { mode: 0o600 });
    const close = vi.fn().mockResolvedValue(undefined);
    const adapter = new MullvadSessionAdapter({
      mode: "wireproxy",
      wgConfigDir: configDirectory,
      stateDir: stateDirectory,
      dependencies: dependencies({
        launchWireproxy: vi.fn().mockResolvedValue({ assertAlive: vi.fn(), close }),
        probeProxy: vi.fn().mockRejectedValue(new Error("route-not-mullvad")),
      }),
    });
    await expect(adapter.acquire("session")).rejects.toThrow("route-not-mullvad");
    expect(close).toHaveBeenCalledTimes(1);
    expect(fs.readdirSync(stateDirectory)).toEqual([]);
  });
});

describe("canonical session factory Mullvad preflight", () => {
  it("rejects Mullvad plus an explicit proxy before any browser launch", async () => {
    await expect(createSession({
      backend: "cloak-headless",
      mullvadSessionMode: "os-socks",
      proxy: { server: "socks5://127.0.0.1:9999", protocol: "socks5" },
      requireProxy: true,
    })).rejects.toThrow("mullvad-session-conflicts-with-explicit-proxy");
  });

  it("rejects wireproxy mode with no private config directory before browser launch", async () => {
    await expect(createSession({
      backend: "cloak-headless",
      mullvadSessionMode: "wireproxy",
      requireProxy: true,
    })).rejects.toThrow("mullvad-wg-config-dir-required");
  });
});
