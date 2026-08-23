/**
 * Hermes Watchdog — Phase 5
 *
 * Internal watchdog timer that monitors:
 *   - Hermes heartbeat (30s interval → if missing 90s, force restart)
 *   - Memory usage (>1.5GB warn, >2GB graceful restart)
 *   - Credential progress stall detection
 *   - Zombie process sweeping
 *
 * Designed to be started by server.ts as a lightweight monitoring layer.
 */

import fs from "node:fs";
import path from "node:path";
import { createLogger } from "../core/logger.js";
import { getHermesObserver } from "./hermes-observer.js";
import { OpsOrchestrator } from "./ops-orchestrator.js";

const log = createLogger("Watchdog");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WatchdogConfig {
  /** Heartbeat check interval in ms (default: 30000) */
  heartbeatIntervalMs?: number;
  /** Max time without heartbeat before force restart (default: 90000) */
  heartbeatTimeoutMs?: number;
  /** Memory warning threshold in MB (default: 1500) */
  memoryWarnMB?: number;
  /** Memory restart threshold in MB (default: 2000) */
  memoryRestartMB?: number;
  /** Stall detection timeout in ms (default: 300000 = 5min) */
  stallTimeoutMs?: number;
  /** Callback when a restart is needed */
  onRestart?: (reason: string) => void;
  /** Callback when a warning is emitted */
  onWarn?: (message: string) => void;
  /** Function that returns whether the engine is running */
  isEngineRunning?: () => boolean;
  /** Function that returns the last outcome timestamp */
  getLastOutcomeTimestamp?: () => number;
  /** Function that returns the number of active sessions */
  getActiveSessions?: () => number;
  /** Function that returns whether Hermes is alive */
  isHermesAlive?: () => boolean;
}

export interface WatchdogStatus {
  running: boolean;
  lastHeartbeatCheck: number;
  lastMemoryCheck: number;
  memoryMB: number;
  hermesAlive: boolean;
  stallDetected: boolean;
  checksPerformed: number;
}

// ---------------------------------------------------------------------------
// Watchdog
// ---------------------------------------------------------------------------

export class Watchdog {
  private readonly config: Required<WatchdogConfig>;
  private interval: ReturnType<typeof setInterval> | null = null;
  private lastHermesHeartbeat = Date.now();
  private checksPerformed = 0;
  private lastMemoryCheck = Date.now();
  private lastHeartbeatCheck = Date.now();
  private stallDetected = false;
  private opsOrchestrator: OpsOrchestrator;
  private lastLogAnalysisTime = 0;

  constructor(config: WatchdogConfig = {}) {
    this.config = {
      heartbeatIntervalMs: config.heartbeatIntervalMs ?? 30000,
      heartbeatTimeoutMs: config.heartbeatTimeoutMs ?? 90000,
      memoryWarnMB: config.memoryWarnMB ?? 1500,
      memoryRestartMB: config.memoryRestartMB ?? 2000,
      stallTimeoutMs: config.stallTimeoutMs ?? 300000,
      onRestart: config.onRestart ?? ((reason) => {
        log.error(`[Watchdog] Graceful drain requested: ${reason} — triggering DRAIN state and waiting up to 60s`);
        
        let timeWaited = 0;
        const drainTimeoutMs = 60000;
        
        const drainInterval = setInterval(() => {
          timeWaited += 5000;
          const active = this.getActiveSessions ? this.getActiveSessions() : 0;
          
          if (active === 0 || timeWaited >= drainTimeoutMs) {
            clearInterval(drainInterval);
            log.warn(`[Watchdog] Drain complete (Active: ${active}, Time: ${timeWaited}ms). Sweeping zombies...`);
            
            try {
              const { killOurOrphans } = require("../services/process-cleaner.js");
              killOurOrphans();
            } catch (e) {
              log.error(`[Watchdog] Failed to clean zombies during drain: ${e}`);
            }
            
            log.error(`[Watchdog] Exiting cleanly for PM2 restart.`);
            setImmediate(() => process.exit(0));
          } else {
            log.info(`[Watchdog] Draining... ${active} sessions remain. Waited ${timeWaited/1000}s`);
          }
        }, 5000);
      }),
      onWarn: config.onWarn ?? ((msg) => log.warn(msg)),
      isEngineRunning: config.isEngineRunning ?? (() => false),
      getLastOutcomeTimestamp: config.getLastOutcomeTimestamp ?? (() => Date.now()),
      getActiveSessions: config.getActiveSessions ?? (() => 0),
      isHermesAlive: config.isHermesAlive ?? (() => true),
    };
    this.opsOrchestrator = new OpsOrchestrator();
  }

  /**
   * Start the watchdog monitoring loop.
   */
  start(): void {
    if (this.interval) return; // Already running

    log.info(
      `[Watchdog] Starting — heartbeat every ${this.config.heartbeatIntervalMs}ms, ` +
      `timeout ${this.config.heartbeatTimeoutMs}ms, memory limit ${this.config.memoryRestartMB}MB`
    );

    this.lastHermesHeartbeat = Date.now();

    this.interval = setInterval(() => {
      this.tick();
    }, this.config.heartbeatIntervalMs);
    this.interval.unref(); // Don't prevent process exit
  }

  /**
   * Stop the watchdog.
   */
  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
      log.info("[Watchdog] Stopped");
    }
  }

  /**
   * Called by Hermes daemon to signal it's alive.
   */
  receiveHeartbeat(): void {
    this.lastHermesHeartbeat = Date.now();
  }

  /**
   * Get current watchdog status.
   */
  getStatus(): WatchdogStatus {
    const memUsage = process.memoryUsage();
    return {
      running: this.interval !== null,
      lastHeartbeatCheck: this.lastHeartbeatCheck,
      lastMemoryCheck: this.lastMemoryCheck,
      memoryMB: Math.round(memUsage.rss / 1024 / 1024),
      hermesAlive: this.config.isHermesAlive(),
      stallDetected: this.stallDetected,
      checksPerformed: this.checksPerformed,
    };
  }

  // -----------------------------------------------------------------------
  // Private
  // -----------------------------------------------------------------------

  private tick(): void {
    this.checksPerformed++;

    this.checkHermesHeartbeat();
    this.checkMemory();
    this.checkStall();
    this.runLogAnalysis();
  }

  private runLogAnalysis(): void {
    const now = Date.now();
    // Run log analysis every 10 minutes
    if (now - this.lastLogAnalysisTime > 10 * 60 * 1000) {
       this.lastLogAnalysisTime = now;
       try {
         const logFile = path.join(process.cwd(), 'logs', 'automati-server-out.log');
         if (fs.existsSync(logFile)) {
            // Read last ~50k bytes roughly to avoid memory explosion
            const stats = fs.statSync(logFile);
            const readSize = Math.min(stats.size, 50000);
            const fd = fs.openSync(logFile, 'r');
            const buffer = Buffer.alloc(readSize);
            fs.readSync(fd, buffer, 0, readSize, Math.max(0, stats.size - readSize));
            fs.closeSync(fd);

            const logContent = buffer.toString('utf8');
            void this.opsOrchestrator.analyzeLogs(logContent).catch((e) => log.warn(`[Watchdog] Log analysis rejected: ${e}`));
         }
       } catch (e) {
         log.warn(`[Watchdog] Failed to trigger log analysis: ${String(e)}`);
       }
    }
  }

  private checkHermesHeartbeat(): void {
    this.lastHeartbeatCheck = Date.now();
    const isAlive = this.config.isHermesAlive();

    if (!isAlive) {
      const timeSinceLastHeartbeat = Date.now() - this.lastHermesHeartbeat;
      if (timeSinceLastHeartbeat > this.config.heartbeatTimeoutMs) {
        try { getHermesObserver().reportAnomaly("heartbeat_timeout", { timeSince: timeSinceLastHeartbeat }); } catch { /* non-blocking */ }
        this.config.onRestart(
          `Hermes heartbeat timeout (${Math.round(timeSinceLastHeartbeat / 1000)}s without response)`
        );
      } else {
        this.config.onWarn(
          `[Watchdog] Hermes not responding (${Math.round(timeSinceLastHeartbeat / 1000)}s ago)`
        );
      }
    } else {
      this.lastHermesHeartbeat = Date.now();
    }
  }

  private checkMemory(): void {
    this.lastMemoryCheck = Date.now();
    const memUsage = process.memoryUsage();
    const memMB = Math.round(memUsage.rss / 1024 / 1024);

    if (memMB > this.config.memoryRestartMB) {
      try { getHermesObserver().reportAnomaly("memory_critical", { memMB, threshold: this.config.memoryRestartMB }); } catch { /* non-blocking */ }
      this.config.onRestart(
        `Memory critical: ${memMB}MB > ${this.config.memoryRestartMB}MB threshold`
      );
    } else if (memMB > this.config.memoryWarnMB) {
      try { getHermesObserver().reportAnomaly("memory_warning", { memMB, threshold: this.config.memoryWarnMB }); } catch { /* non-blocking */ }
      this.config.onWarn(
        `[Watchdog] High memory usage: ${memMB}MB (Warn at ${this.config.memoryWarnMB}MB)`
      );
      // Attempt to trigger garbage collection
      if (global.gc) {
        try {
          global.gc();
          log.info("[Watchdog] Manual GC triggered");
        } catch {
          // Not available without --expose-gc flag
        }
      }
    }
  }

  private checkStall(): void {
    if (!this.config.isEngineRunning()) {
      this.stallDetected = false;
      return;
    }

    const activeSessions = this.config.getActiveSessions();
    if (activeSessions === 0) {
      // Engine running but no active sessions — check if this is a stall
      // (could also be between batches, which is normal)
      return;
    }

    const lastOutcome = this.config.getLastOutcomeTimestamp();
    const timeSinceOutcome = Date.now() - lastOutcome;

    if (timeSinceOutcome > this.config.stallTimeoutMs) {
      this.stallDetected = true;
      try { getHermesObserver().reportAnomaly("engine_stall", { activeSessions, timeSinceOutcome }); } catch { /* non-blocking */ }
      this.config.onWarn(
        `[Watchdog] Stall detected: ${activeSessions} active sessions but no outcome for ` +
        `${Math.round(timeSinceOutcome / 1000)}s`
      );
      // After 2x the timeout, escalate to restart
      if (timeSinceOutcome > this.config.stallTimeoutMs * 2) {
        this.config.onRestart(
          `Stall escalation: no outcomes for ${Math.round(timeSinceOutcome / 1000)}s`
        );
      }
    } else {
      this.stallDetected = false;
    }
  }
}
