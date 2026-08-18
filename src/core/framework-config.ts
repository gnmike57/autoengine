/**
 * Framework-Specific Optimization Configuration
 *
 * Centralises anti-detection configuration for each browser automation
 * framework: Camoufox, CloakBrowser, Zendriver, and Spider.rs.
 *
 * Each framework has unique APIs for noise injection, fingerprint
 * spoofing, and evasion — this module normalises them into a unified
 * config that the engine can apply at session launch time.
 */

import { type HardwareProfile } from "../profiles/profile-determinism.js";

// ── Types ────────────────────────────────────────────────────────────────────

export type FrameworkName = "camoufox" | "cloakbrowser" | "zendriver" | "spider" | "stealth";

export interface CanvasNoiseConfig {
  enabled: boolean;
  /** Noise magnitude (0.0–1.0). >0.2 triggers false positives on low-end GPUs. */
  magnitude: number;
}

export interface AudioNoiseConfig {
  enabled: boolean;
  /** Delta applied to AudioContext output (0.01–0.1). */
  delta: number;
}

export interface WebGLRotationConfig {
  /** Rotate WebGL vendor/renderer strings. */
  enabled: boolean;
  /** Rotation interval in minutes (0 = per-session). */
  intervalMinutes: number;
  /** Vendor/renderer pairs to cycle through. */
  pool: Array<{ vendor: string; renderer: string }>;
}

export interface ConnectionEmulationConfig {
  enabled: boolean;
  type: "wifi" | "cellular" | "ethernet";
  rttMs: number;
  downlinkMbps: number;
}

export interface FrameworkConfig {
  name: FrameworkName;
  canvas: CanvasNoiseConfig;
  audio: AudioNoiseConfig;
  webgl: WebGLRotationConfig;
  connection: ConnectionEmulationConfig;
  /** Extra CDP commands to send at launch. */
  cdpCommands: Array<{ method: string; params: Record<string, unknown> }>;
  /** Extra browser launch args. */
  launchArgs: string[];
  /** Whether to enable WASM support. */
  wasmSupport: boolean;
  /** GitHub URL for auto-pulling noise profiles (e.g. daijro/camoufox). */
  autoProfilePull?: string;
  /** URL for skill pipeline sync (e.g. aiming-lab/AutoResearchClaw). */
  skillPipelineUrl?: string;
  /** URL for vector-indexed research DB. */
  vectorDbUrl?: string;
}

// ── WebGL pools per vendor affinity ──────────────────────────────────────────

const NVIDIA_RENDERERS = [
  "ANGLE (NVIDIA, NVIDIA GeForce GTX 1650 Direct3D11 vs_5_0 ps_5_0, D3D11)",
  "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)",
  "ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 Ti Direct3D11 vs_5_0 ps_5_0, D3D11)",
];

const INTEL_RENDERERS = [
  "ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)",
  "ANGLE (Intel, Intel(R) UHD Graphics 750 Direct3D11 vs_5_0 ps_5_0, D3D11)",
  "ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)",
];

const AMD_RENDERERS = [
  "ANGLE (AMD, AMD Radeon RX 6600 Direct3D11 vs_5_0 ps_5_0, D3D11)",
  "ANGLE (AMD, AMD Radeon(TM) Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)",
];

// ── Framework config builders ────────────────────────────────────────────────

/**
 * Camoufox configuration — Firefox-based, uses canvas/audio noise natively.
 * Aggressive canvas noise (>0.2) triggers false positives on low-end GPUs,
 * so we dynamically adjust based on the hardware profile's GPU vendor.
 */
export function getCamoufoxConfig(
  hardware: HardwareProfile,
  seed: number,
): FrameworkConfig {
  // Lower canvas noise for integrated GPUs to avoid false positives
  const isIntegrated = hardware.gpu.vendor === "Intel" || hardware.gpu.vendor === "Apple";
  const canvasNoise = isIntegrated ? 0.15 : 0.3;
  const audioDelta = 0.03 + (seed % 5) * 0.01; // 0.03–0.07

  return {
    name: "camoufox",
    canvas: { enabled: true, magnitude: canvasNoise },
    audio: { enabled: true, delta: audioDelta },
    webgl: {
      enabled: false, // Camoufox handles WebGL internally
      intervalMinutes: 0,
      pool: [],
    },
    connection: {
      enabled: true,
      type: "wifi",
      rttMs: 80 + (seed % 80),   // 80–160ms
      downlinkMbps: 10 + (seed % 40), // 10–50 Mbps
    },
    cdpCommands: [],
    launchArgs: [
      "--no-remote",
    ],
    wasmSupport: true,
    // Camoufox fingerprinting is handled at C++ engine level via BrowserForge
    autoProfilePull: "https://github.com/daijro/camoufox",
  };
}

/**
 * CloakBrowser configuration — Chromium-based with built-in fingerprint
 * randomisation. WebGL vendor/renderer are rotated hourly across the
 * NVIDIA → Intel → AMD pool.
 */
export function getCloakBrowserConfig(
  hardware: HardwareProfile,
  seed: number,
): FrameworkConfig {
  // Build WebGL rotation pool based on hardware vendor affinity
  const vendorPools: Record<string, Array<{ vendor: string; renderer: string }>> = {
    NVIDIA: NVIDIA_RENDERERS.map(r => ({ vendor: "Google Inc. (NVIDIA)", renderer: r })),
    Intel: INTEL_RENDERERS.map(r => ({ vendor: "Google Inc. (Intel)", renderer: r })),
    AMD: AMD_RENDERERS.map(r => ({ vendor: "Google Inc. (AMD)", renderer: r })),
  };

  // Start with the hardware's own vendor pool, then mix in others
  const primaryPool = vendorPools[hardware.gpu.vendor] || vendorPools["Intel"]!;
  const allPools = [
    ...primaryPool,
    ...(vendorPools["NVIDIA"] || []),
    ...(vendorPools["Intel"] || []),
    ...(vendorPools["AMD"] || []),
  ];
  // Deduplicate
  const seen = new Set<string>();
  const uniquePool = allPools.filter(p => {
    const key = `${p.vendor}|${p.renderer}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return {
    name: "cloakbrowser",
    canvas: { enabled: true, magnitude: 0.2 },
    audio: { enabled: true, delta: 0.05 },
    webgl: {
      enabled: true,
      intervalMinutes: 60, // Rotate hourly
      pool: uniquePool,
    },
    connection: {
      enabled: true,
      type: "wifi",
      rttMs: 100 + (seed % 60),
      downlinkMbps: 15 + (seed % 35),
    },
    cdpCommands: [],
    launchArgs: [
      `--use-angle=${hardware.gpu.vendor === "NVIDIA" ? "opengl" : hardware.gpu.vendor === "AMD" ? "vulkan" : "d3d11"}`,
    ],
    wasmSupport: true,
    // AutoResearchClaw integration for automated skill generation
    skillPipelineUrl: "https://github.com/aiming-lab/AutoResearchClaw",
  };
}

/**
 * Zendriver configuration — undetected-chromedriver wrapper. Must patch
 * navigator.webdriver and chrome.runtime via CDP at launch.
 */
export function getZendriverConfig(
  hardware: HardwareProfile,
  seed: number,
): FrameworkConfig {
  // Generate a per-seed pseudo-random extension ID for chrome.runtime
  // Real browsers with extensions have a non-undefined runtime.id
  const runtimeId = "a" + ((seed * 2654435761) >>> 0).toString(36).slice(0, 8);

  return {
    name: "zendriver",
    canvas: { enabled: true, magnitude: 0.25 },
    audio: { enabled: true, delta: 0.05 },
    webgl: {
      enabled: true,
      intervalMinutes: 0, // Per-session only
      pool: [{ vendor: `Google Inc. (${hardware.gpu.vendor})`, renderer: hardware.gpu.renderer }],
    },
    connection: {
      enabled: true,
      type: "wifi",
      rttMs: 120 + (seed % 40),
      downlinkMbps: 20 + (seed % 30),
    },
    cdpCommands: [
      // Remove webdriver flag
      {
        method: "Page.addScriptToEvaluateOnNewDocument",
        params: {
          source: `Object.defineProperty(navigator, 'webdriver', { get: () => false });`,
        },
      },
      // Emulate chrome.runtime with per-seed extension ID
      {
        method: "Runtime.evaluate",
        params: {
          expression: `if (!window.chrome) window.chrome = {}; if (!window.chrome.runtime) window.chrome.runtime = { id: '${runtimeId}' };`,
        },
      },
    ],
    launchArgs: [
      "--disable-blink-features=AutomationControlled",
      "--no-first-run",
      "--no-default-browser-check",
    ],
    wasmSupport: true,
  };
}

/**
 * Spider.rs configuration — Rust-based crawler with headless mode.
 * Requires explicit WASM support and connection emulation.
 */
export function getSpiderConfig(
  hardware: HardwareProfile,
  seed: number,
): FrameworkConfig {
  return {
    name: "spider",
    canvas: { enabled: false, magnitude: 0 }, // Spider handles internally
    audio: { enabled: false, delta: 0 },
    webgl: {
      enabled: false,
      intervalMinutes: 0,
      pool: [],
    },
    connection: {
      enabled: true,
      type: "wifi",
      rttMs: 120,
      downlinkMbps: 25 + (seed % 25),
    },
    cdpCommands: [],
    launchArgs: [
      "--headless=false", // Spider requires non-headless for reCAPTCHA
    ],
    wasmSupport: true,
    // Vector-indexed research DB for automated anti-detection research
    vectorDbUrl: "https://github.com/aiming-lab/AutoResearchClaw",
  };
}

// ── Unified config resolver ──────────────────────────────────────────────────

/**
 * Get the framework-specific configuration for a given framework name,
 * hardware profile, and credential seed.
 */
export function getFrameworkConfig(
  framework: FrameworkName,
  hardware: HardwareProfile,
  seed: number,
): FrameworkConfig {
  switch (framework) {
    case "camoufox": return getCamoufoxConfig(hardware, seed);
    case "cloakbrowser": return getCloakBrowserConfig(hardware, seed);
    case "zendriver": return getZendriverConfig(hardware, seed);
    case "spider": return getSpiderConfig(hardware, seed);
    case "stealth": return getCloakBrowserConfig(hardware, seed); // Stealth uses CloakBrowser base
    default: return getCloakBrowserConfig(hardware, seed);
  }
}

/**
 * Select the current WebGL vendor/renderer from the rotation pool based
 * on the current time and rotation interval.
 */
export function getCurrentWebGLPair(
  config: FrameworkConfig,
  seed: number,
): { vendor: string; renderer: string } | undefined {
  if (!config.webgl.enabled || config.webgl.pool.length === 0) return undefined;

  if (config.webgl.intervalMinutes <= 0) {
    // Per-session: use seed to pick
    const idx = seed % config.webgl.pool.length;
    return config.webgl.pool[idx];
  }

  // Time-based rotation
  const minutesSinceEpoch = Math.floor(Date.now() / (1000 * 60));
  const slot = Math.floor(minutesSinceEpoch / config.webgl.intervalMinutes);
  const idx = (slot + seed) % config.webgl.pool.length;
  return config.webgl.pool[idx];
}

/**
 * Generate the connection emulation Network.emulateNetworkConditions params.
 */
export function getNetworkEmulationParams(config: FrameworkConfig): Record<string, unknown> | undefined {
  if (!config.connection.enabled) return undefined;
  return {
    offline: false,
    latency: config.connection.rttMs,
    downloadThroughput: (config.connection.downlinkMbps * 1024 * 1024) / 8,
    uploadThroughput: (config.connection.downlinkMbps * 512 * 1024) / 8, // Upload ~half of download
    connectionType: config.connection.type,
  };
}
