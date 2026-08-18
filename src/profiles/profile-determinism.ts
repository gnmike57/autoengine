/**
 * Hardware Profile Determinism
 * Maps credential email domains to consistent hardware specs (CPU cores, memory, GPU).
 * Same email always gets same hardware profile — reduces bot detection flags.
 *
 * Presets are split by OS so the GPU vendor/renderer string is plausible for
 * the advertised navigator.platform. macOS has not shipped NVIDIA GPUs since
 * 2012, and never RTX — emitting "NVIDIA GeForce RTX 4060 Ti" on a macOS UA
 * is an instant bot-detection flag for any ANGLE-aware fingerprint vendor.
 */

import { emailDomainHash } from "../core/crypto-utils.js";

export interface HardwareProfile {
  cores: number;
  memory: number;
  gpu: {
    vendor: string;
    renderer: string;
  };
}

/** Windows GPU pool — NVIDIA RTX, AMD Radeon, Intel UHD/Arc are all common. */
const HARDWARE_PRESETS_WINDOWS: HardwareProfile[] = [
  { cores: 4, memory: 8, gpu: { vendor: "Intel", renderer: "UHD Graphics 630" } },
  { cores: 8, memory: 16, gpu: { vendor: "Intel", renderer: "UHD Graphics 750" } },
  { cores: 8, memory: 16, gpu: { vendor: "NVIDIA", renderer: "GeForce GTX 1650" } },
  { cores: 8, memory: 16, gpu: { vendor: "Intel", renderer: "Iris Pro Graphics 580" } },
  { cores: 12, memory: 32, gpu: { vendor: "AMD", renderer: "Radeon RX 6600" } },
  { cores: 12, memory: 32, gpu: { vendor: "NVIDIA", renderer: "GeForce RTX 3060" } },
  { cores: 16, memory: 32, gpu: { vendor: "Intel", renderer: "Arc A770" } },
  { cores: 16, memory: 32, gpu: { vendor: "NVIDIA", renderer: "GeForce RTX 4060 Ti" } },
];

/** macOS GPU pool — Apple Silicon SoCs and the Intel-era Iris / AMD Radeon
 *  Pro options that ship on real Mac hardware. Strictly no NVIDIA. */
const HARDWARE_PRESETS_MACOS: HardwareProfile[] = [
  { cores: 8, memory: 8, gpu: { vendor: "Apple", renderer: "Apple M1" } },
  { cores: 8, memory: 16, gpu: { vendor: "Apple", renderer: "Apple M2" } },
  { cores: 10, memory: 16, gpu: { vendor: "Apple", renderer: "Apple M2 Pro" } },
  { cores: 12, memory: 32, gpu: { vendor: "Apple", renderer: "Apple M3 Pro" } },
  { cores: 16, memory: 32, gpu: { vendor: "Apple", renderer: "Apple M3 Max" } },
  { cores: 4, memory: 8, gpu: { vendor: "Intel", renderer: "Intel Iris Plus Graphics 645" } },
  { cores: 8, memory: 16, gpu: { vendor: "Intel", renderer: "Intel UHD Graphics 630" } },
  { cores: 8, memory: 16, gpu: { vendor: "AMD", renderer: "AMD Radeon Pro 5300M" } },
];

/** Linux GPU pool — Open source drivers usually expose Mesa Intel or AMD. */
const HARDWARE_PRESETS_LINUX: HardwareProfile[] = [
  { cores: 4, memory: 8, gpu: { vendor: "Intel", renderer: "Mesa Intel(R) UHD Graphics 620 (KBL GT2)" } },
  { cores: 8, memory: 16, gpu: { vendor: "AMD", renderer: "AMD Radeon Graphics (RENOIR, DRM 3.42.0, 5.15.0-89-generic, LLVM 12.0.0)" } },
  { cores: 12, memory: 32, gpu: { vendor: "AMD", renderer: "AMD Radeon RX 6700 XT (navy_flounder, LLVM 15.0.7, DRM 3.49, 6.2.0-37-generic)" } },
  { cores: 16, memory: 32, gpu: { vendor: "Intel", renderer: "Mesa Intel(R) Arc(tm) A770 Graphics (DG2)" } },
];

/** Android GPU pool — Adreno, Mali, Xclipse (Exynos). */
const HARDWARE_PRESETS_ANDROID: HardwareProfile[] = [
  { cores: 8, memory: 8, gpu: { vendor: "Qualcomm", renderer: "Adreno (TM) 730" } },
  { cores: 8, memory: 12, gpu: { vendor: "Qualcomm", renderer: "Adreno (TM) 740" } },
  { cores: 8, memory: 8, gpu: { vendor: "ARM", renderer: "Mali-G710" } },
  { cores: 8, memory: 12, gpu: { vendor: "Samsung", renderer: "Xclipse 920" } },
];

/** Legacy combined pool — retained for callers that have not yet plumbed
 *  the host OS through. Equivalent to the original 8-entry list so the
 *  pre-OS-aware tests / domain-hash mapping stay stable. */
const HARDWARE_PRESETS: HardwareProfile[] = HARDWARE_PRESETS_WINDOWS;

/**
 * Get the consistent hardware profile for a given email. When `os` is provided
 * the result is picked from the matching OS pool, guaranteeing a plausible
 * (UA, GPU) pair. Without `os` we fall back to the Windows pool for backward
 * compatibility with call sites that haven't been migrated.
 */
export function getConsistentHardware(
  email: string,
  os?: "windows" | "macos" | "linux" | "android",
  rotation: number = 0,
  proxyPool?: string
): HardwareProfile {
  const hash = emailDomainHash(email, rotation);
  let pool = HARDWARE_PRESETS;
  if (os === "macos") pool = HARDWARE_PRESETS_MACOS;
  else if (os === "linux") pool = HARDWARE_PRESETS_LINUX;
  else if (os === "android") pool = HARDWARE_PRESETS_ANDROID;

  const index = hash % pool.length;
  // @ts-expect-error noUncheckedIndexedAccess
  const baseProfile: HardwareProfile = { ...pool[index] };

  // Stage 8.2: Deterministic Hardware Sync based on IP Tier (Clamped to plausible ranges)
  const minCores = Math.min(...pool.map(p => p.cores));
  const maxCores = Math.max(...pool.map(p => p.cores));
  const minMemory = Math.min(...pool.map(p => p.memory));
  const maxMemory = Math.max(...pool.map(p => p.memory));

  if (proxyPool === "4m") {
    // Mobile IP: ideally 4-8 cores, 4-8 GB RAM
    const pairs = [{ cores: 4, memory: 8 }, { cores: 8, memory: 8 }, { cores: 8, memory: 16 }];
    const pair = pairs[hash % pairs.length]!;
    baseProfile.cores = Math.max(minCores, Math.min(maxCores, pair.cores));
    baseProfile.memory = Math.max(minMemory, Math.min(maxMemory, pair.memory));
  } else if (proxyPool === "4r" || proxyPool === "4i" || proxyPool === "1") {
    // Residential/ISP Desktop IP: ideally 8-16 cores, 16-32 GB RAM
    const pairs = [{ cores: 8, memory: 16 }, { cores: 12, memory: 32 }, { cores: 16, memory: 32 }];
    const pair = pairs[hash % pairs.length]!;
    baseProfile.cores = Math.max(minCores, Math.min(maxCores, pair.cores));
    baseProfile.memory = Math.max(minMemory, Math.min(maxMemory, pair.memory));
  }

  return baseProfile;
}

/**
 * Get the consistent hardware profile by email with logging.
 */
export function getConsistentHardwareWithLog(
  email: string,
  logFnOrOs?: ((msg: string) => void) | "windows" | "macos" | "linux" | "android",
  maybeLogFn?: (msg: string) => void,
  rotation: number = 0,
): HardwareProfile {
  // Backward-compatible 2-arg form: `(email, logFn)`. New 3-arg form passes
  // `(email, os, logFn)` so callers that know the UA can align the pool.
  let os: "windows" | "macos" | "linux" | "android" | undefined;
  let logFn: ((msg: string) => void) | undefined;
  if (typeof logFnOrOs === "function") {
    logFn = logFnOrOs;
  } else {
    os = logFnOrOs;
    logFn = maybeLogFn;
  }
  const hw = getConsistentHardware(email, os, rotation);
  const mut = rotation > 0 ? ` (mut${rotation})` : "";
  const msg = `Hardware determinism${mut}: ${email.split("@")[1] || email} → ${hw.cores}c/${hw.memory}GB ${hw.gpu.vendor} ${hw.gpu.renderer}`;
  if (logFn) logFn(msg);
  return hw;
}

/**
 * Extract CLI args for hardware profile (GPU vendor/renderer).
 * These get added to CloakBrowser launch args.
 */
export function getHardwareArgs(profile: HardwareProfile): string[] {
  const args: string[] = [];
  if (profile.gpu.vendor === "Apple") {
    args.push("--use-angle=metal");
  } else if (profile.gpu.vendor === "Qualcomm" || profile.gpu.vendor === "ARM" || profile.gpu.vendor === "Samsung") {
    args.push("--use-angle=opengl"); // Android typically uses OpenGL/EGL
  } else if (profile.gpu.vendor === "NVIDIA") {
    args.push("--use-angle=opengl");
  } else if (profile.gpu.vendor === "AMD") {
    args.push("--use-angle=vulkan");
  } else {
    // Intel defaults to d3d11 (if host supports it) or opengl
    args.push("--use-angle=d3d11");
  }
  return args;
}

/**
 * Extract navigator.hardwareConcurrency and navigator.deviceMemory spoofs.
 */
export function getNavigatorOverrides(profile: HardwareProfile) {
  return {
    hardwareConcurrency: profile.cores,
    deviceMemory: profile.memory,
  };
}
