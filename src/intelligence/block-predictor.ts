/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { type Page, type Response } from "playwright-core";
import fs from "fs";
import path from "path";
import { createLogger } from "../core/logger.js";
import { getHermesObserver } from "../hermes/hermes-observer.js";

const log = createLogger("block-predictor");
const BASELINES_PATH = path.join(process.cwd(), "data", "block-baselines.json");

export interface BlockPrediction {
  isLikelyBlocked: boolean;
  confidence: number;
  reason: string;
  vectors: {
    ttfb_anomaly: boolean;
    challenge_headers: string[];
    resource_count_anomaly: boolean;
    body_size_anomaly: boolean;
  };
}

interface SiteBaseline {
  ttfb_mean: number;
  ttfb_std: number;
  resource_count_mean: number;
  body_size_mean: number;
  samples: number;
}

let baselines: Record<string, SiteBaseline> = {};
try {
  if (fs.existsSync(BASELINES_PATH)) {
    baselines = JSON.parse(fs.readFileSync(BASELINES_PATH, "utf-8"));
  }
} catch (e) {
  log.warn(`Failed to load baselines: ${String(e)}`);
}

function saveBaselines() {
  try {
    fs.mkdirSync(path.dirname(BASELINES_PATH), { recursive: true });
    fs.writeFileSync(BASELINES_PATH, JSON.stringify(baselines, null, 2));
  } catch { /* intentional */ }
}

const WAF_HEADERS = [
  "cf-mitigated",
  "x-datadome-cid",
  "server: ddos-guard",
  "x-amzn-waf-action",
];

export async function analyzeInitialResponse(response: Response, siteName: string): Promise<BlockPrediction> {
  const result: BlockPrediction = {
    isLikelyBlocked: false,
    confidence: 0,
    reason: "",
    vectors: {
      ttfb_anomaly: false,
      challenge_headers: [],
      resource_count_anomaly: false,
      body_size_anomaly: false,
    }
  };

  try {
    // 1. Header checks
    const headers = response.headers();
    for (const h of WAF_HEADERS) {
      if (h.includes(':')) {
        const parts = h.split(':').map(s => s.trim().toLowerCase());
        const k = parts[0];
        const v = parts[1];
        if (k && v && headers[k]?.toLowerCase().includes(v)) result.vectors.challenge_headers.push(h);
      } else {
        if (headers[h]) result.vectors.challenge_headers.push(h);
      }
    }

    // Cloudflare specific combo
    if (headers["cf-ray"] && headers["cf-chl-bypass"]) {
      result.vectors.challenge_headers.push("cf-chl-bypass");
    }

    if (result.vectors.challenge_headers.length > 0) {
      result.isLikelyBlocked = true;
      result.confidence += 0.8;
      result.reason = `WAF Headers: ${result.vectors.challenge_headers.join(",")}`;
    }

    // 2. Body size checks
    let bodySize = 0;
    try {
      const body = await response.body();
      bodySize = body.length;
    } catch { /* stream might be consumed */ }

    const baseline = baselines[siteName];
    if (baseline && bodySize > 0) {
      if (bodySize < baseline.body_size_mean * 0.2) {
        result.vectors.body_size_anomaly = true;
        result.isLikelyBlocked = true;
        result.confidence += 0.4;
        result.reason += (result.reason ? " | " : "") + `Tiny body (${Math.round(bodySize/1024)}KB)`;
      }
    } else if (bodySize > 0 && bodySize < 15000 && headers["content-type"]?.includes("text/html")) {
      // Generic heuristic: HTML < 15KB is usually a JS challenge loader
      result.vectors.body_size_anomaly = true;
      result.confidence += 0.3;
    }

    // TTFB
    const timing = response.request().timing();
    if (timing && timing.responseStart > 0) {
      const ttfb = timing.responseStart;
      if (baseline) {
        if (ttfb < 30 || ttfb > baseline.ttfb_mean + (baseline.ttfb_std * 3)) {
          result.vectors.ttfb_anomaly = true;
          result.confidence += 0.2;
        }
      } else if (ttfb < 30 || ttfb > 1000) {
        result.vectors.ttfb_anomaly = true;
        result.confidence += 0.1;
      }
    }

    result.confidence = Math.min(1.0, result.confidence);

    // Report high-confidence blocks to Observer for learning
    if (result.isLikelyBlocked && result.confidence >= 0.5) {
      try { getHermesObserver().reportAnomaly("block_predicted", { siteName, confidence: result.confidence, reason: result.reason, vectors: result.vectors }); } catch { /* non-blocking */ }
    }
  } catch (e) {
    log.debug(`analyzeInitialResponse error: ${String(e)}`);
  }

  return result;
}

export async function analyzePageResources(page: Page, siteName: string): Promise<BlockPrediction> {
  const result: BlockPrediction = {
    isLikelyBlocked: false,
    confidence: 0,
    reason: "",
    vectors: {
      ttfb_anomaly: false,
      challenge_headers: [],
      resource_count_anomaly: false,
      body_size_anomaly: false,
    }
  };

  try {
    const resources = await page.evaluate(() => performance.getEntriesByType("resource").length);
    const baseline = baselines[siteName];

    if (baseline) {
      if (resources < baseline.resource_count_mean * 0.3) {
        result.vectors.resource_count_anomaly = true;
        result.isLikelyBlocked = true;
        result.confidence += 0.6;
        result.reason = `Resource anomaly: ${resources} (expected ~${baseline.resource_count_mean})`;
      }
    } else if (resources < 10) {
      // Generic heuristic
      result.vectors.resource_count_anomaly = true;
      result.confidence += 0.4;
    }

    result.confidence = Math.min(1.0, result.confidence);
  } catch (e) {
    log.debug(`analyzePageResources error: ${String(e)}`);
  }

  return result;
}

export function recordBaselineSuccess(siteName: string, ttfb: number, resources: number, bodySize: number) {
  if (!baselines[siteName]) {
    baselines[siteName] = { ttfb_mean: ttfb, ttfb_std: 0, resource_count_mean: resources, body_size_mean: bodySize, samples: 1 };
    return;
  }
  const b = baselines[siteName];
  b.samples++;
  // Welford's online algorithm
  const delta = ttfb - b.ttfb_mean;
  b.ttfb_mean += delta / b.samples;
  const delta2 = ttfb - b.ttfb_mean;
  b.ttfb_std = Math.sqrt(((b.ttfb_std ** 2 * (b.samples - 1)) + delta * delta2) / b.samples);

  b.resource_count_mean = b.resource_count_mean + ((resources - b.resource_count_mean) / b.samples);
  b.body_size_mean = b.body_size_mean + ((bodySize - b.body_size_mean) / b.samples);

  if (b.samples % 10 === 0) saveBaselines();
}
