/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/**
 * flow-screenshotter.ts
 *
 * Captures a step-by-step screenshot filmstrip of the login flow.
 * Each named flow step produces a WebP screenshot and metadata entry,
 * creating a visual audit trail that both humans and AI can review
 * to understand exactly what happened during each credential test.
 *
 * Storage layout:
 *   screenshots/flow-steps/{sessionId}/
 *     01-navigate-to-site.webp
 *     02-cookie-dismissed.webp
 *     ...
 *     flow-manifest.json
 *
 * Retention: configurable via MAX_SESSIONS (default 100).
 * Older session directories are pruned on startup.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Page } from "playwright-core";
import { createLogger } from "../core/logger.js";

const log = createLogger("FlowScreenshotter");

// ── Types ──────────────────────────────────────────────────────────────────

export interface FlowStepCapture {
  stepIndex: number;
  stepName: string;
  normalizedName: string;
  timestamp: string;
  imagePath: string;
  pageUrl: string;
  durationMs: number;
  error?: string;
}

export interface FlowManifest {
  sessionId: string;
  emailHash: string;
  site: string;
  backend: string;
  startedAt: string;
  completedAt?: string;
  outcome?: string;
  steps: FlowStepCapture[];
}

// ── Constants ──────────────────────────────────────────────────────────────

const FLOW_STEPS_DIR = path.join(process.cwd(), "screenshots", "flow-steps");
const MAX_SESSIONS = 100;
const SCREENSHOT_QUALITY = 65; // WebP quality — small but readable

// ── Helpers ────────────────────────────────────────────────────────────────

function normalizeName(stepName: string): string {
  return stepName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .substring(0, 60);
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// ── FlowScreenshotter ─────────────────────────────────────────────────────

export class FlowScreenshotter {
  private sessionDir: string = "";
  private manifest: FlowManifest | null = null;
  private stepCounter = 0;
  private enabled = false;

  /**
   * Begin a new flow-step capture session.
   * Call this once per credential test, before the first flow step.
   */
  start(sessionId: string, email: string, site: string, backend: string): void {
    this.enabled = true;
    this.stepCounter = 0;
    this.sessionDir = path.join(FLOW_STEPS_DIR, sessionId);
    ensureDir(this.sessionDir);

    const emailHash = crypto.createHash("sha256").update(email).digest("hex").slice(0, 20);
    this.manifest = {
      sessionId,
      emailHash,
      site,
      backend,
      startedAt: new Date().toISOString(),
      steps: [],
    };

    log.info(`Flow screenshot session started: ${sessionId} (${site}/email-${emailHash})`);
  }

  /**
   * Capture a screenshot for the current flow step.
   * Non-blocking — failures are logged but never thrown.
   */
  async capture(page: Page, stepName: string): Promise<FlowStepCapture | null> {
    if (!this.enabled || !this.manifest) return null;

    const t0 = Date.now();
    this.stepCounter++;
    const idx = this.stepCounter;
    const normalized = normalizeName(stepName);
    const filename = `${String(idx).padStart(2, "0")}-${normalized}.webp`;
    const filePath = path.join(this.sessionDir, filename);

    let pageUrl = "";
    try {
      pageUrl = page.url();
    } catch { /* page may be closed */ }

    const entry: FlowStepCapture = {
      stepIndex: idx,
      stepName,
      normalizedName: normalized,
      timestamp: new Date().toISOString(),
      imagePath: filename,
      pageUrl,
      durationMs: 0,
    };

    try {
      if (page.isClosed()) {
        entry.error = "page_closed";
        entry.durationMs = Date.now() - t0;
        this.manifest.steps.push(entry);
        return entry;
      }

      const buffer = await page.screenshot({
        type: "png",
        fullPage: false,
        timeout: 3000,
      });

      // Convert to WebP for smaller file size using sharp if available,
      // otherwise save as PNG
      try {
        const sharp = (await import("sharp")).default;
        const webpBuffer = await sharp(buffer)
          .webp({ quality: SCREENSHOT_QUALITY })
          .toBuffer();
        await fs.promises.writeFile(filePath, webpBuffer);
      } catch {
        // sharp unavailable — save as PNG with renamed extension
        const pngPath = filePath.replace(/\.webp$/, ".png");
        await fs.promises.writeFile(pngPath, buffer);
        entry.imagePath = filename.replace(/\.webp$/, ".png");
      }

      entry.durationMs = Date.now() - t0;
      this.manifest.steps.push(entry);

      log.debug(`Step ${idx}: ${stepName} → ${entry.imagePath} (${entry.durationMs}ms)`);
      return entry;
    } catch (e: unknown) {
      entry.error = (e instanceof Error ? e.message : String(e)) || String(e);
      entry.durationMs = Date.now() - t0;
      this.manifest.steps.push(entry);
      log.debug(`Step ${idx}: ${stepName} — screenshot failed: ${entry.error}`);
      return entry;
    }
  }

  /** Outside evidence mode, retain only diagnostically important outcomes.
   * Evidence mode always retains the complete planned denominator. */
  private static readonly RETAIN_OUTCOMES = new Set([
    "success", "tempdisabled", "permdisabled", "2FA", "noaccount", "inconclusive",
  ]);

  /**
   * Finalize the session: write the manifest and optionally set the outcome.
   * Sessions with uninteresting outcomes are deleted to save disk space.
   */
  finalize(outcome?: string): FlowManifest | null {
    if (!this.enabled || !this.manifest) return null;

    this.manifest.completedAt = new Date().toISOString();
    if (outcome) this.manifest.outcome = outcome;

    const evidenceMode = ["1", "true", "yes", "on"].includes((process.env.AUTOMATION_EVIDENCE_MODE || "").toLowerCase());
    const shouldRetain = evidenceMode || (outcome ? FlowScreenshotter.RETAIN_OUTCOMES.has(outcome) : false);

    if (shouldRetain) {
      try {
        const manifestPath = path.join(this.sessionDir, "flow-manifest.json");
        fs.writeFileSync(manifestPath, JSON.stringify(this.manifest, null, 2));
        log.info(`Flow manifest written: ${this.manifest.steps.length} steps, outcome=${outcome} → ${manifestPath}`);
      } catch (e: unknown) {
        log.warn(`Failed to write flow manifest: ${e instanceof Error ? e.message : String(e)}`);
      }
    } else {
      // Non-interesting outcome — delete the entire session directory
      try {
        if (this.sessionDir && fs.existsSync(this.sessionDir)) {
          fs.rmSync(this.sessionDir, { recursive: true, force: true });
          log.debug(`Deleted uninteresting flow session (outcome=${outcome})`);
        }
      } catch { /* best-effort cleanup */ }
    }

    const result = this.manifest;
    this.manifest = null;
    this.enabled = false;
    this.stepCounter = 0;
    return result;
  }

  /**
   * Check if flow screenshots are currently active.
   */
  get isActive(): boolean {
    return this.enabled && this.manifest !== null;
  }

  /**
   * Get the current step count.
   */
  get currentStep(): number {
    return this.stepCounter;
  }

  /**
   * Prune old flow-step session directories beyond MAX_SESSIONS.
   * Called once on startup to prevent unbounded growth.
   */
  static pruneOldSessions(maxSessions: number = MAX_SESSIONS): number {
    try {
      ensureDir(FLOW_STEPS_DIR);
      const dirs = fs.readdirSync(FLOW_STEPS_DIR, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => ({
          name: d.name,
          path: path.join(FLOW_STEPS_DIR, d.name),
          mtime: fs.statSync(path.join(FLOW_STEPS_DIR, d.name)).mtimeMs,
        }))
        .sort((a, b) => b.mtime - a.mtime); // newest first

      if (dirs.length <= maxSessions) return 0;

      const toDelete = dirs.slice(maxSessions);
      let deleted = 0;
      for (const dir of toDelete) {
        try {
          fs.rmSync(dir.path, { recursive: true, force: true });
          deleted++;
        } catch { /* best-effort */ }
      }

      if (deleted > 0) {
        log.info(`Pruned ${deleted} old flow-step session(s)`);
      }
      return deleted;
    } catch (e: unknown) {
      log.warn(`Failed to prune flow-step sessions: ${e instanceof Error ? e.message : String(e)}`);
      return 0;
    }
  }

  /**
   * Get a list of all available flow-step sessions with their manifests.
   */
  static listSessions(): Array<{ sessionId: string; manifest: FlowManifest | null }> {
    try {
      ensureDir(FLOW_STEPS_DIR);
      const dirs = fs.readdirSync(FLOW_STEPS_DIR, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .sort((a, b) => {
          const aTime = fs.statSync(path.join(FLOW_STEPS_DIR, a.name)).mtimeMs;
          const bTime = fs.statSync(path.join(FLOW_STEPS_DIR, b.name)).mtimeMs;
          return bTime - aTime; // newest first
        });

      return dirs.map(d => {
        const manifestPath = path.join(FLOW_STEPS_DIR, d.name, "flow-manifest.json");
        let manifest: FlowManifest | null = null;
        try {
          if (fs.existsSync(manifestPath)) {
            manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
          }
        } catch { /* corrupt manifest */ }
        return { sessionId: d.name, manifest };
      });
    } catch {
      return [];
    }
  }
}