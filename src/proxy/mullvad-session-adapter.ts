import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import fetch from "node-fetch";
import { SocksProxyAgent } from "socks-proxy-agent";

export type MullvadSessionMode = "disabled" | "os-socks" | "wireproxy";

export interface SessionProxyEntry {
  server: string;
  protocol: "socks5";
}

export interface MullvadSessionLease {
  id: string;
  mode: Exclude<MullvadSessionMode, "disabled">;
  isolation: "shared-os-tunnel" | "dedicated-wireguard-config";
  proxy: SessionProxyEntry;
  configId?: string;
  exitProof: string;
  assertHealthy: () => void;
  close: () => Promise<void>;
}

export interface ManagedWireproxy {
  assertAlive: () => void;
  close: () => Promise<void>;
}

export interface MullvadAdapterDependencies {
  probeProxy: (proxy: SessionProxyEntry) => Promise<string>;
  reservePort: (host: string) => Promise<number>;
  launchWireproxy: (input: {
    binary: string;
    sourceConfig: string;
    bindHost: string;
    bindPort: number;
    runtimeDir: string;
    startupTimeoutMs: number;
  }) => Promise<ManagedWireproxy>;
}

export interface MullvadSessionAdapterOptions {
  mode: MullvadSessionMode;
  wgConfigDir?: string;
  wireproxyBinary?: string;
  relaySocksHosts?: string[];
  bindHost?: string;
  stateDir?: string;
  startupTimeoutMs?: number;
  allowSharedOsTunnel?: boolean;
  dependencies?: Partial<MullvadAdapterDependencies>;
}

const DEFAULT_RELAY_SOCKS_HOSTS = ["10.64.0.1"];
const DEFAULT_PROBE_URL = "https://am.i.mullvad.net/connected";

function sanitizedId(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function assertPrivateFile(file: string): void {
  const stat = fs.statSync(file);
  if (!stat.isFile()) throw new Error("mullvad-config-not-file");
  if ((stat.mode & 0o077) !== 0) throw new Error("mullvad-config-permissions-must-be-0600");
}

async function defaultProbeProxy(proxy: SessionProxyEntry): Promise<string> {
  const agent = new SocksProxyAgent(proxy.server);
  const response = await fetch(DEFAULT_PROBE_URL, {
    agent,
    redirect: "follow",
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await response.text()).trim();
  if (!response.ok || !/mullvad/i.test(body) || /not connected/i.test(body)) {
    throw new Error(`mullvad-route-proof-failed:${response.status}`);
  }
  return sanitizedId(body);
}

function defaultReservePort(host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function waitForPort(host: string, port: number, timeoutMs: number, child: ChildProcess): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (child.exitCode !== null) {
        reject(new Error(`wireproxy-exited-before-ready:${child.exitCode}`));
        return;
      }
      const socket = net.createConnection({ host, port });
      socket.once("connect", () => {
        socket.destroy();
        resolve();
      });
      socket.once("error", () => {
        socket.destroy();
        if (Date.now() - started >= timeoutMs) reject(new Error("wireproxy-startup-timeout"));
        else setTimeout(poll, 100);
      });
    };
    poll();
  });
}

async function defaultLaunchWireproxy(input: {
  binary: string;
  sourceConfig: string;
  bindHost: string;
  bindPort: number;
  runtimeDir: string;
  startupTimeoutMs: number;
}): Promise<ManagedWireproxy> {
  fs.mkdirSync(input.runtimeDir, { recursive: true, mode: 0o700 });
  const runtimeConfig = path.join(input.runtimeDir, "wireproxy.conf");
  fs.copyFileSync(input.sourceConfig, runtimeConfig, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(runtimeConfig, 0o600);
  fs.appendFileSync(runtimeConfig, `\n\n[Socks5]\nBindAddress = ${input.bindHost}:${input.bindPort}\n`, { encoding: "utf8" });

  const child = spawn(input.binary, ["-c", runtimeConfig], {
    stdio: ["ignore", "ignore", "ignore"],
    env: { PATH: process.env.PATH ?? "" },
    detached: false,
  });
  let closing = false;
  let unexpectedExit: string | undefined;
  child.once("exit", (code, signal) => {
    if (!closing) unexpectedExit = `wireproxy-exited-after-ready:${code ?? "null"}:${signal ?? "none"}`;
  });
  try {
    await waitForPort(input.bindHost, input.bindPort, input.startupTimeoutMs, child);
  } catch (error) {
    closing = true;
    child.kill("SIGKILL");
    fs.rmSync(runtimeConfig, { force: true });
    throw error;
  }

  let closed = false;
  return {
    assertAlive: () => {
      if (unexpectedExit) throw new Error(unexpectedExit);
      if (child.exitCode !== null) throw new Error(`wireproxy-not-running:${child.exitCode}`);
    },
    close: async () => {
      if (closed) return;
      closed = true;
      closing = true;
      if (child.exitCode === null) {
        child.kill("SIGTERM");
        await Promise.race([
          new Promise<void>((resolve) => child.once("exit", () => resolve())),
          new Promise<void>((resolve) => setTimeout(resolve, 3000)),
        ]);
        if (child.exitCode === null) child.kill("SIGKILL");
      }
      fs.rmSync(runtimeConfig, { force: true });
    },
  };
}

function parseMode(value: string | undefined): MullvadSessionMode {
  const normalized = (value ?? "disabled").trim().toLowerCase();
  if (["", "disabled", "off", "none"].includes(normalized)) return "disabled";
  if (["os-socks", "os_socks", "socks"].includes(normalized)) return "os-socks";
  if (["wireproxy", "wg-config", "wg_config"].includes(normalized)) return "wireproxy";
  throw new Error(`unsupported-mullvad-session-mode:${normalized}`);
}

export class MullvadSessionAdapter {
  readonly mode: MullvadSessionMode;
  private readonly options: Required<Pick<MullvadSessionAdapterOptions, "bindHost" | "stateDir" | "startupTimeoutMs" | "wireproxyBinary">> & MullvadSessionAdapterOptions;
  private readonly dependencies: MullvadAdapterDependencies;

  constructor(options: MullvadSessionAdapterOptions) {
    this.mode = options.mode;
    this.options = {
      ...options,
      bindHost: options.bindHost ?? "127.0.0.1",
      stateDir: options.stateDir ?? path.join(os.homedir(), ".automation-engine", "mullvad-leases"),
      startupTimeoutMs: options.startupTimeoutMs ?? 20_000,
      wireproxyBinary: options.wireproxyBinary ?? "wireproxy",
    };
    this.dependencies = {
      probeProxy: options.dependencies?.probeProxy ?? defaultProbeProxy,
      reservePort: options.dependencies?.reservePort ?? defaultReservePort,
      launchWireproxy: options.dependencies?.launchWireproxy ?? defaultLaunchWireproxy,
    };
  }

  static fromEnvironment(modeOverride?: string): MullvadSessionAdapter {
    const relaySocksHosts = (process.env.MULLVAD_RELAY_SOCKS_HOSTS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    return new MullvadSessionAdapter({
      mode: parseMode(modeOverride ?? process.env.MULLVAD_SESSION_MODE),
      wgConfigDir: process.env.MULLVAD_WG_CONFIG_DIR,
      wireproxyBinary: process.env.MULLVAD_WIREPROXY_BIN,
      relaySocksHosts,
      stateDir: process.env.MULLVAD_LEASE_STATE_DIR,
      allowSharedOsTunnel: process.env.MULLVAD_ALLOW_SHARED_OS_TUNNEL === "1",
    });
  }

  async acquire(sessionKey: string): Promise<MullvadSessionLease> {
    if (this.mode === "disabled") throw new Error("mullvad-session-adapter-disabled");
    return this.mode === "os-socks"
      ? this.acquireOsSocks(sessionKey)
      : this.acquireWireproxy(sessionKey);
  }

  private async acquireOsSocks(sessionKey: string): Promise<MullvadSessionLease> {
    if (!this.options.allowSharedOsTunnel) {
      throw new Error("mullvad-os-socks-shared-tunnel-requires-opt-in");
    }
    const hosts = this.options.relaySocksHosts && this.options.relaySocksHosts.length > 0
      ? this.options.relaySocksHosts
      : DEFAULT_RELAY_SOCKS_HOSTS;
    const index = Number.parseInt(sanitizedId(sessionKey).slice(0, 8), 16) % hosts.length;
    const host = hosts[index]!;
    const proxy: SessionProxyEntry = { server: `socks5://${host}:1080`, protocol: "socks5" };
    const exitProof = await this.dependencies.probeProxy(proxy);
    let closed = false;
    return {
      id: `mullvad-os-socks-${sanitizedId(`${sessionKey}:${host}`)}`,
      mode: "os-socks",
      isolation: "shared-os-tunnel",
      proxy,
      exitProof,
      assertHealthy: () => { if (closed) throw new Error("mullvad-lease-closed"); },
      close: async () => { closed = true; },
    };
  }

  private async acquireWireproxy(sessionKey: string): Promise<MullvadSessionLease> {
    const configDir = this.options.wgConfigDir;
    if (!configDir) throw new Error("mullvad-wg-config-dir-required");
    const files = fs.readdirSync(configDir)
      .filter((name) => name.endsWith(".conf"))
      .sort()
      .map((name) => path.join(configDir, name));
    if (files.length === 0) throw new Error("mullvad-wg-config-pool-empty");

    fs.mkdirSync(this.options.stateDir, { recursive: true, mode: 0o700 });
    const start = Number.parseInt(sanitizedId(sessionKey).slice(0, 8), 16) % files.length;
    let sourceConfig: string | undefined;
    let configId = "";
    let lockPath = "";
    for (let offset = 0; offset < files.length; offset += 1) {
      const candidate = files[(start + offset) % files.length]!;
      assertPrivateFile(candidate);
      const candidateId = sanitizedId(path.basename(candidate));
      const candidateLock = path.join(this.options.stateDir, `${candidateId}.lock`);
      for (let lockAttempt = 0; lockAttempt < 2; lockAttempt += 1) {
        try {
          const descriptor = fs.openSync(candidateLock, "wx", 0o600);
          fs.writeFileSync(descriptor, `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString(), session: sanitizedId(sessionKey) })}\n`, "utf8");
          fs.closeSync(descriptor);
          sourceConfig = candidate;
          configId = candidateId;
          lockPath = candidateLock;
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          let stale = false;
          try {
            const lock = JSON.parse(fs.readFileSync(candidateLock, "utf8")) as { pid?: number };
            if (!Number.isInteger(lock.pid) || Number(lock.pid) <= 0) stale = true;
            else {
              try { process.kill(Number(lock.pid), 0); }
              catch (probeError) { stale = (probeError as NodeJS.ErrnoException).code === "ESRCH"; }
            }
          } catch {
            const ageMs = Date.now() - fs.statSync(candidateLock).mtimeMs;
            stale = ageMs > this.options.startupTimeoutMs;
          }
          if (stale && lockAttempt === 0) {
            fs.rmSync(candidateLock, { force: true });
            continue;
          }
          break;
        }
      }
      if (sourceConfig) break;
    }
    if (!sourceConfig) throw new Error("mullvad-wg-config-pool-exhausted");

    const runtimeDir = path.join(this.options.stateDir, `session-${sanitizedId(sessionKey)}-${configId}`);
    let managed: ManagedWireproxy | undefined;
    try {
      const bindPort = await this.dependencies.reservePort(this.options.bindHost);
      managed = await this.dependencies.launchWireproxy({
        binary: this.options.wireproxyBinary,
        sourceConfig,
        bindHost: this.options.bindHost,
        bindPort,
        runtimeDir,
        startupTimeoutMs: this.options.startupTimeoutMs,
      });
      const proxy: SessionProxyEntry = { server: `socks5://${this.options.bindHost}:${bindPort}`, protocol: "socks5" };
      const exitProof = await this.dependencies.probeProxy(proxy);
      managed.assertAlive();
      let closed = false;
      return {
        id: `mullvad-wireproxy-${sanitizedId(`${sessionKey}:${configId}`)}`,
        mode: "wireproxy",
        isolation: "dedicated-wireguard-config",
        proxy,
        configId,
        exitProof,
        assertHealthy: () => {
          if (closed) throw new Error("mullvad-lease-closed");
          managed?.assertAlive();
        },
        close: async () => {
          if (closed) return;
          closed = true;
          await managed?.close();
          fs.rmSync(runtimeDir, { recursive: true, force: true });
          fs.rmSync(lockPath, { force: true });
        },
      };
    } catch (error) {
      await managed?.close().catch(() => {});
      fs.rmSync(runtimeDir, { recursive: true, force: true });
      fs.rmSync(lockPath, { force: true });
      throw error;
    }
  }
}
