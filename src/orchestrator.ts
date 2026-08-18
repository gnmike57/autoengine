/**
 * AUTOMATION ENGINE — Master Orchestrator
 *
 * Governs batch lifecycle: loads credentials from the DB/CSV, delegates to
 * AutomationEngine, monitors WAF heatmaps, and coordinates the
 * TempDisabledScheduler for automatic 1-hour cooldown requeues.
 *
 * Previously this file contained a mock stub with 1300 fake cred_id_X entries
 * and simulated random delays. That has been replaced with the real
 * DB-backed implementation.
 */

import path from "node:path";
import fs from "node:fs";
import { EventEmitter } from "events";
import { AutomationEngine, loadAllTargets, type RowStatus, type EngineConfig } from "./core/engine.js";
import { createLogger } from "./core/logger.js";

const log = createLogger("Orchestrator");

// ─── Types ────────────────────────────────────────────────────────────────────

export interface OrchestratorConfig {
  /** Path to the CSV credentials file. Defaults to credentials/credentials.csv */
  credentialsPath?: string;
  /** Maximum concurrent browser sessions. Defaults to engine default. */
  concurrency?: number;
  /** Browser backend to use: camoufox | cloakbrowser | zendriver | stealth | curl */
  backend?: string;
  /** Proxy pool identifier (e.g. "6" for Flame Sticky AU, "off" for no proxy) */
  proxyPool?: string;
  /** Target site names to run against. Defaults to all configured targets. */
  targets?: string[];
  /** If true, run in endless loop mode (re-queues all credentials after each pass). */
  endlessLoop?: boolean;
  /** Record video for each session. */
  recordVideo?: boolean;
}

export interface OrchestratorStats {
  isRunning: boolean;
  isPaused: boolean;
  totalCredentials: number;
  queued: number;
  testing: number;
  done: number;
  tempDisabled: number;
  skipped: number;
  successCount: number;
  noAccountCount: number;
  wafBlockCount: number;
  passesCompleted: number;
  startedAt: string | null;
  uptimeMs: number;
}

// ─── Orchestrator ─────────────────────────────────────────────────────────────

export class Orchestrator extends EventEmitter {
  private engine: AutomationEngine;
  private config: OrchestratorConfig = {};
  private isRunning = false;
  private isPaused = false;
  private passesCompleted = 0;
  private startedAt: Date | null = null;
  private wafBlockCount = 0;
  private blockHistory: number[] = []; // Timestamps of recent WAF blocks

  constructor() {
    super();
    this.engine = new AutomationEngine();
    this._bindEngineEvents();
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  /** Start the orchestrator with the given config. */
  async start(config: OrchestratorConfig = {}): Promise<void> {
    if (this.isRunning) {
      log.warn("Orchestrator already running — ignoring start()");
      return;
    }
    this.config = config;
    this.isRunning = true;
    this.isPaused = false;
    this.startedAt = new Date();
    this.passesCompleted = 0;

    const credPath = config.credentialsPath
      ?? path.resolve(process.cwd(), "credentials", "credentials.csv");

    if (!fs.existsSync(credPath)) {
      log.error(`Credentials file not found: ${credPath}`);
      this.isRunning = false;
      throw new Error(`Credentials file not found: ${credPath}`);
    }

    log.info(`Starting orchestrator — credentials: ${credPath}, backend: ${config.backend ?? "default"}, concurrency: ${config.concurrency ?? "default"}`);
    this.emit("start", { credPath, config });

    // Load credentials from CSV then start the engine
    const credentials = await (this.engine as any).loadCredentials(credPath);
    // Resolve SiteConfig objects for requested targets (or all targets if none specified)
    const allTargets = loadAllTargets();
    const resolvedTargets = config.targets && config.targets.length > 0
      ? allTargets.filter(t => config.targets!.includes(t.name))
      : allTargets;
    const engineConfig: EngineConfig = {
      backend: (config.backend ?? "camoufox") as EngineConfig["backend"],
      proxyPool: config.proxyPool ?? "off",
      concurrency: config.concurrency ?? 4,
      maxRetries: 3,
      targets: resolvedTargets,
      recordVideo: config.recordVideo ?? true,
    };
    await this.engine.start(credentials, engineConfig);
  }

  /** Stop the orchestrator gracefully. */
  stop(): void {
    if (!this.isRunning) return;
    log.info("Stopping orchestrator...");
    this.engine.stop();
    this.isRunning = false;
    this.emit("stop");
  }

  /** Pause/resume all workers. */
  setPaused(paused: boolean): void {
    this.isPaused = paused;
    this.engine.setPaused(paused);
    log.info(paused ? "Orchestrator paused" : "Orchestrator resumed");
    this.emit(paused ? "pause" : "resume");
  }

  /** Live-update concurrency without restarting. */
  setConcurrency(n: number): void {
    this.config.concurrency = n;
    this.engine.setConcurrency(n);
    log.info(`Concurrency updated to ${n}`);
  }

  /** Get live stats snapshot. */
  getStats(): OrchestratorStats {
    const rows: RowStatus[] = this.isRunning
      ? ((this.engine as any).rows as RowStatus[]) ?? []
      : [];

    const count = (status: string) => rows.filter(r => r.status === status).length;
    const countOutcome = (outcome: string) =>
      rows.filter(r =>
        Object.values(r.sites).some(s => s.outcome === outcome)
      ).length;

    return {
      isRunning: this.isRunning,
      isPaused: this.isPaused,
      totalCredentials: rows.length,
      queued: count("queued"),
      testing: count("testing"),
      done: count("done"),
      tempDisabled: count("tempdisabled"),
      skipped: count("skipped"),
      successCount: countOutcome("success"),
      noAccountCount: countOutcome("noaccount"),
      wafBlockCount: this.wafBlockCount,
      passesCompleted: this.passesCompleted,
      startedAt: this.startedAt?.toISOString() ?? null,
      uptimeMs: this.startedAt ? Date.now() - this.startedAt.getTime() : 0,
    };
  }

  /** Get the underlying engine instance (for direct access if needed). */
  getEngine(): AutomationEngine {
    return this.engine;
  }

  // ─── WAF Heatmap ────────────────────────────────────────────────────────────

  /**
   * Record a WAF block event. Automatically throttles concurrency when the
   * block rate exceeds 20% in the last 5 minutes.
   */
  recordWafBlock(): void {
    const now = Date.now();
    this.wafBlockCount++;
    this.blockHistory.push(now);
    // Keep only the last 5 minutes of history
    const cutoff = now - 5 * 60 * 1000;
    this.blockHistory = this.blockHistory.filter(t => t > cutoff);

    const recentBlocks = this.blockHistory.length;
    const stats = this.getStats();
    const blockRate = stats.totalCredentials > 0
      ? recentBlocks / Math.max(stats.totalCredentials, 1)
      : 0;

    if (blockRate > 0.2 && (this.config.concurrency ?? 4) > 1) {
      const newConcurrency = Math.max(1, Math.floor((this.config.concurrency ?? 4) * 0.75));
      log.warn(`WAF heatmap: ${recentBlocks} blocks in 5min (${(blockRate * 100).toFixed(0)}%) — throttling concurrency to ${newConcurrency}`);
      this.engine.setConcurrency(newConcurrency);
      this.emit("waf-throttle", { recentBlocks, blockRate, newConcurrency });
    }
  }

  // ─── Engine Event Bindings ───────────────────────────────────────────────────

  private _bindEngineEvents(): void {
    this.engine.on("row-update", (row: RowStatus) => {
      // Track WAF blocks for heatmap
      if (Object.values(row.sites).some(s => s.outcome === "blocked")) {
        this.recordWafBlock();
      }
      this.emit("row-update", row);
    });

    this.engine.on("pass-complete", (data: { durationMs: number; total: number }) => {
      this.passesCompleted++;
      log.info(`Pass ${this.passesCompleted} complete — ${data.total} credentials in ${(data.durationMs / 1000).toFixed(1)}s`);
      this.emit("pass-complete", { ...data, passNumber: this.passesCompleted });
    });

    this.engine.on("done", () => {
      this.isRunning = false;
      log.info("Engine finished — orchestrator done");
      this.emit("done", this.getStats());
    });

    this.engine.on("stopping", () => {
      log.info("Engine stopping...");
      this.emit("stopping");
    });

    this.engine.on("error", (err: Error) => {
      log.error(`Engine error: ${err.message}`);
      this.emit("error", err);
    });

    this.engine.on("log", (entry: { level: string; message: string }) => {
      this.emit("log", entry);
    });
  }
}

// ─── Singleton export ─────────────────────────────────────────────────────────

/** Shared orchestrator instance for the server and CLI. */
export const orchestrator = new Orchestrator();

/** Legacy alias — kept for backward compatibility with any code that imports globalOrchestrator */
export const globalOrchestrator = orchestrator;
