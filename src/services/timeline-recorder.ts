import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Page } from "playwright-core";
import { createLogger } from "../core/logger.js";

const log = createLogger("TimelineRecorder");

export interface TimelineFrame {
  offsetMs: number;
  timestamp: string;
  imagePath: string;
}

export interface TimelineManifest {
  sessionId: string;
  emailHash: string;
  backend: string;
  startedAt: string;
  frames: TimelineFrame[];
}

export class TimelineRecorder {
  private page: Page;
  private target: string;
  private backend: string;
  private intervalId: NodeJS.Timeout | null = null;
  private manifest: TimelineManifest;
  private startTime: number = 0;
  private sessionDir: string;
  private isCapturing: boolean = false;

  public get sessionId(): string {
    return this.manifest.sessionId;
  }

  constructor(page: Page, email: string, target: string, backend: string) {
    this.page = page;
    this.target = target;
    this.backend = backend;

    const emailHash = crypto.createHash("sha256").update(email).digest("hex").slice(0, 20);
    const dirName = `email-${emailHash}_${target}_${backend}`;
    this.sessionDir = path.join(process.cwd(), "screenshots", "timelines", dirName);

    if (fs.existsSync(this.sessionDir)) {
      // Clear out the old run to prevent disk bloat
      fs.rmSync(this.sessionDir, { recursive: true, force: true });
    }
    fs.mkdirSync(this.sessionDir, { recursive: true });

    this.manifest = {
      sessionId: dirName,
      emailHash,
      backend: this.backend,
      startedAt: new Date().toISOString(),
      frames: []
    };
  }

  start() {
    if (this.intervalId) return;
    this.startTime = Date.now();
    log.info(`[Timeline] Started 500ms recording for session ${this.manifest.sessionId}`);

    // Poll every 500ms
    this.intervalId = setInterval(async () => {
      if (this.isCapturing) return; // Skip if previous capture is still running to prevent backup
      if (this.page.isClosed()) {
        this.stop();
        return;
      }

      this.isCapturing = true;
      try {
        const offsetMs = Date.now() - this.startTime;
        const filename = `${offsetMs}ms.jpeg`;
        const filePath = path.join(this.sessionDir, filename);

        // Use very low quality to save disk space for rapid polling
        const buffer = await this.page.screenshot({
          type: "jpeg",
          quality: 20,
          scale: "css", // Don't capture retina resolution to save I/O
          timeout: 2000
        });

        await fs.promises.writeFile(filePath, buffer);

        this.manifest.frames.push({
          offsetMs,
          timestamp: new Date().toISOString(),
          imagePath: filename
        });
      } catch (e: any) {
        // If the page closes exactly as we request a screenshot, it will throw. Ignore it.
        if (!e.message?.includes("Target closed") && !e.message?.includes("Target page, context or browser has been closed")) {
           log.debug(`[Timeline] Frame capture failed: ${e.message}`);
        }
      } finally {
        this.isCapturing = false;
      }
    }, 500);
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;

      // Write manifest
      try {
        const manifestPath = path.join(this.sessionDir, "timeline-manifest.json");
        fs.writeFileSync(manifestPath, JSON.stringify(this.manifest, null, 2));
        log.info(`[Timeline] Saved manifest for ${this.manifest.sessionId} with ${this.manifest.frames.length} frames.`);
      } catch (e: any) {
        log.error(`[Timeline] Failed to save manifest: ${e.message}`);
      }
    }
  }
}
