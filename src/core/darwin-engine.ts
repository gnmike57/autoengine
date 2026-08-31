import fs from "node:fs";
import path from "node:path";
import { createLogger } from "./logger.js";

const log = createLogger("DarwinEngine");

export interface DarwinBackendStats {
  backend: string;
  proxyPool?: string;
  totalAttempts: number;
  decisive: number;
  successes: number;
  blocks: number;
  fails: number;
  consecutiveFails: number;
  consecutiveBlocks: number;
  errors: Record<string, number>;
  totalDurationMs: number;
  avgDurationMs: number;
  eliminated: boolean;
  eliminationReason?: string;
  compositeScore: number;
}

export interface DarwinScorecard {
  timestamp: string;
  totalEvaluated: number;
  activeCount: number;
  eliminatedCount: number;
  rankedBackends: DarwinBackendStats[];
  winner?: {
    backend: string;
    score: number;
    decisiveRate: number;
    blockRate: number;
    avgDurationMs: number;
    confidence: number;
  };
}

export interface DarwinDiagnosticReport {
  mode: "darwin";
  timestamp: string;
  totalBackendsTested: number;
  totalAttempts: number;
  totalDurationMs: number;
  eliminationThreshold: number;
  activeBackends: string[];
  eliminatedBackends: Array<{ backend: string; reason: string; stats: DarwinBackendStats }>;
  scorecard: DarwinScorecard;
  optimalBackend?: string;
  recommendations: string[];
}

export const DARWIN_BACKENDS: readonly string[] = [
  "stealth",
  "stealth-headed",
  "cloak-headless",
  "cloak-headed",
  "cloak-headless-nocloak",
  "cloak-headed-nocloak",
  "zendriver",
  "zendriver-headed",
] as const;

export class DarwinEngine {
  private candidates: Map<string, DarwinBackendStats> = new Map();
  private eliminationThreshold: number;
  private minEvaluationsForWinner: number;
  private reportDir: string;
  private stateFile: string;

  constructor(options?: {
    candidateBackends?: string[];
    eliminationThreshold?: number;
    minEvaluationsForWinner?: number;
    reportDir?: string;
    proxyPool?: string;
    stateFile?: string;
    persistState?: boolean;
  }) {
    const list = options?.candidateBackends ?? DARWIN_BACKENDS;
    this.eliminationThreshold = options?.eliminationThreshold ?? 3;
    this.minEvaluationsForWinner = options?.minEvaluationsForWinner ?? 2;
    this.reportDir = options?.reportDir ?? path.join(process.cwd(), "reports", "darwin");
    this.stateFile = options?.stateFile ?? path.join(process.cwd(), "learning", "darwin-state.json");

    for (const b of list) {
      // Strictly filter out spider backends
      if (b.startsWith("spider")) continue;
      this.candidates.set(b, {
        backend: b,
        proxyPool: options?.proxyPool,
        totalAttempts: 0,
        decisive: 0,
        successes: 0,
        blocks: 0,
        fails: 0,
        consecutiveFails: 0,
        consecutiveBlocks: 0,
        errors: {},
        totalDurationMs: 0,
        avgDurationMs: 0,
        eliminated: false,
        compositeScore: 100,
      });
    }

    if (options?.persistState !== false) {
      this.loadState();
    }

    log.info(`[DarwinEngine] Initialized with ${this.candidates.size} candidate backends (Spider excluded). Elimination threshold: ${this.eliminationThreshold}`);
  }

  public getCandidateList(): string[] {
    return Array.from(this.candidates.keys());
  }

  public getActiveCandidates(): string[] {
    return Array.from(this.candidates.values())
      .filter((c) => !c.eliminated)
      .map((c) => c.backend);
  }

  public getNextCandidate(currentIdx = 0): string | null {
    const active = this.getActiveCandidates();
    if (active.length === 0) return null;
    const chosen = active[currentIdx % active.length];
    return chosen ?? active[0] ?? null;
  }

  public recordOutcome(
    backend: string,
    outcome: string,
    durationMs: number,
    error?: string,
  ): { eliminated: boolean; eliminationReason?: string } {
    let stats = this.candidates.get(backend);
    if (!stats) {
      if (backend.startsWith("spider")) {
        log.warn(`[DarwinEngine] Spider backend ${backend} omitted from Darwin evaluation`);
        return { eliminated: true, eliminationReason: "Spider backends excluded from Darwin mode" };
      }
      stats = {
        backend,
        totalAttempts: 0,
        decisive: 0,
        successes: 0,
        blocks: 0,
        fails: 0,
        consecutiveFails: 0,
        consecutiveBlocks: 0,
        errors: {},
        totalDurationMs: 0,
        avgDurationMs: 0,
        eliminated: false,
        compositeScore: 100,
      };
      this.candidates.set(backend, stats);
    }

    stats.totalAttempts++;
    stats.totalDurationMs += durationMs;
    stats.avgDurationMs = Math.round(stats.totalDurationMs / stats.totalAttempts);

    if (error) {
      const errKey = error.slice(0, 100);
      stats.errors[errKey] = (stats.errors[errKey] || 0) + 1;
    }

    const norm = outcome.toLowerCase();
    const isDecisive = ["success", "incorrect", "2fa", "tempdisabled", "permdisabled", "noaccount"].includes(norm);
    const isBlock = norm === "blocked" || norm.includes("cloudflare") || norm.includes("waf") || (error && /403|cloudflare|captcha|waf|challenge/i.test(error));
    const isFail = !isDecisive && !isBlock;

    if (norm === "success") {
      stats.successes++;
    }

    if (isDecisive) {
      stats.decisive++;
      stats.consecutiveFails = 0;
      stats.consecutiveBlocks = 0;
    } else if (isBlock) {
      stats.blocks++;
      stats.consecutiveBlocks++;
      stats.consecutiveFails++;
    } else if (isFail) {
      stats.fails++;
      stats.consecutiveFails++;
    }

    // Check elimination
    let newlyEliminated = false;
    let reason = "";

    if (!stats.eliminated) {
      if (stats.blocks >= this.eliminationThreshold || stats.consecutiveBlocks >= 2) {
        newlyEliminated = true;
        reason = `WAF/Cloudflare blocks exceeded threshold (${stats.blocks}/${this.eliminationThreshold})`;
      } else if (stats.fails >= this.eliminationThreshold || stats.consecutiveFails >= this.eliminationThreshold) {
        newlyEliminated = true;
        reason = `Execution failures exceeded threshold (${stats.fails}/${this.eliminationThreshold})`;
      }

      if (newlyEliminated) {
        stats.eliminated = true;
        stats.eliminationReason = reason;
        log.warn(`🦎 [Darwin Natural Selection] ELIMINATED backend [${backend}]: ${reason}`);
      }
    }

    this.recomputeScores();
    void this.saveState();

    return {
      eliminated: stats.eliminated,
      eliminationReason: stats.eliminationReason,
    };
  }

  public recomputeScores(): void {
    for (const stats of this.candidates.values()) {
      if (stats.totalAttempts === 0) {
        stats.compositeScore = 100;
        continue;
      }

      if (stats.eliminated) {
        stats.compositeScore = 0;
        continue;
      }

      const decisiveRate = stats.decisive / stats.totalAttempts;
      const blockRate = stats.blocks / stats.totalAttempts;
      const failRate = stats.fails / stats.totalAttempts;
      const successRate = stats.successes / stats.totalAttempts;

      // Latency penalty factor (normalized 0..1 where 60s is 1.0)
      const latencyPenalty = Math.min(1.0, stats.avgDurationMs / 60000);

      // Composite Score: (0 to 1000)
      // + 500 * Decisive Rate
      // + 300 * Success Rate
      // - 400 * Block Rate
      // - 200 * Fail Rate
      // - 100 * Latency Penalty
      const rawScore =
        decisiveRate * 500 +
        successRate * 300 -
        blockRate * 400 -
        failRate * 200 -
        latencyPenalty * 100 +
        200; // Base offset

      stats.compositeScore = Math.max(1, Math.round(rawScore));
    }
  }

  public getScorecard(): DarwinScorecard {
    this.recomputeScores();
    const ranked = Array.from(this.candidates.values()).sort((a, b) => {
      if (a.eliminated && !b.eliminated) return 1;
      if (!a.eliminated && b.eliminated) return -1;
      return b.compositeScore - a.compositeScore;
    });

    const active = ranked.filter((r) => !r.eliminated);
    const top = active[0];

    let winner: DarwinScorecard["winner"] = undefined;
    if (top && top.totalAttempts >= this.minEvaluationsForWinner) {
      const decisiveRate = top.totalAttempts > 0 ? Math.round((top.decisive / top.totalAttempts) * 100) : 0;
      const blockRate = top.totalAttempts > 0 ? Math.round((top.blocks / top.totalAttempts) * 100) : 0;
      const confidence = Math.min(100, Math.round((top.totalAttempts / 5) * 100));

      winner = {
        backend: top.backend,
        score: top.compositeScore,
        decisiveRate,
        blockRate,
        avgDurationMs: top.avgDurationMs,
        confidence,
      };
    }

    return {
      timestamp: new Date().toISOString(),
      totalEvaluated: Array.from(this.candidates.values()).reduce((sum, c) => sum + c.totalAttempts, 0),
      activeCount: active.length,
      eliminatedCount: ranked.filter((r) => r.eliminated).length,
      rankedBackends: ranked,
      winner,
    };
  }

  public getOptimalBackend(): { backend: string; score: number; confidence: number; decisiveRate: number } | null {
    const scorecard = this.getScorecard();
    if (!scorecard.winner) {
      const topActive = scorecard.rankedBackends.find((b) => !b.eliminated);
      if (topActive) {
        return {
          backend: topActive.backend,
          score: topActive.compositeScore,
          confidence: Math.round((topActive.totalAttempts / 5) * 100),
          decisiveRate: topActive.totalAttempts > 0 ? Math.round((topActive.decisive / topActive.totalAttempts) * 100) : 0,
        };
      }
      return null;
    }

    return {
      backend: scorecard.winner.backend,
      score: scorecard.winner.score,
      confidence: scorecard.winner.confidence,
      decisiveRate: scorecard.winner.decisiveRate,
    };
  }

  public generateDiagnosticReport(): DarwinDiagnosticReport {
    const scorecard = this.getScorecard();
    const totalAttempts = Array.from(this.candidates.values()).reduce((sum, c) => sum + c.totalAttempts, 0);
    const totalDurationMs = Array.from(this.candidates.values()).reduce((sum, c) => sum + c.totalDurationMs, 0);

    const eliminated = Array.from(this.candidates.values())
      .filter((c) => c.eliminated)
      .map((c) => ({
        backend: c.backend,
        reason: c.eliminationReason || "Unknown elimination criteria",
        stats: c,
      }));

    const recommendations: string[] = [];
    if (scorecard.winner) {
      recommendations.push(`Primary Recommendation: Lock active engine to optimal backend '${scorecard.winner.backend}' (Score: ${scorecard.winner.score}, Decisive: ${scorecard.winner.decisiveRate}%).`);
    } else if (scorecard.activeCount === 0) {
      recommendations.push("Critical: All Darwin backends were eliminated. Proxy pool rotation and TLS parameter refresh recommended.");
    } else {
      recommendations.push(`Continue evaluation: ${scorecard.activeCount} backends remaining in active pool.`);
    }

    return {
      mode: "darwin",
      timestamp: new Date().toISOString(),
      totalBackendsTested: this.candidates.size,
      totalAttempts,
      totalDurationMs,
      eliminationThreshold: this.eliminationThreshold,
      activeBackends: this.getActiveCandidates(),
      eliminatedBackends: eliminated,
      scorecard,
      optimalBackend: scorecard.winner?.backend,
      recommendations,
    };
  }

  public async saveDiagnosticReport(customDir?: string): Promise<string> {
    const targetDir = customDir ?? this.reportDir;
    await fs.promises.mkdir(targetDir, { recursive: true }).catch(() => {});
    const report = this.generateDiagnosticReport();
    const filename = `darwin-report-${Date.now()}.json`;
    const fullPath = path.join(targetDir, filename);
    await fs.promises.writeFile(fullPath, JSON.stringify(report, null, 2), "utf8");
    log.info(`[DarwinEngine] Diagnostic report saved to: ${fullPath}`);
    return fullPath;
  }

  private saveStateTimer: NodeJS.Timeout | null = null;

  /** Persist candidate stats to learning/darwin-state.json */
  public async saveState(customPath?: string): Promise<void> {
    if (this.saveStateTimer) clearTimeout(this.saveStateTimer);
    
    return new Promise((resolve) => {
      this.saveStateTimer = setTimeout(async () => {
        const p = customPath ?? this.stateFile;
        try {
          const dir = path.dirname(p);
          await fs.promises.mkdir(dir, { recursive: true }).catch(() => {});
          const candidatesArray = Array.from(this.candidates.values());
          const payload = {
            timestamp: new Date().toISOString(),
            eliminationThreshold: this.eliminationThreshold,
            candidates: candidatesArray,
          };
          
          const tmpPath = p + '.tmp';
          await fs.promises.writeFile(tmpPath, JSON.stringify(payload, null, 2), "utf8");
          await fs.promises.rename(tmpPath, p);
        } catch (err) {
          log.warn(`[DarwinEngine] Failed to save state to ${p}: ${err instanceof Error ? err.message : String(err)}`);
        }
        resolve();
      }, 500); // 500ms debounce
    });
  }

  /** Restore candidate stats from learning/darwin-state.json */
  public loadState(customPath?: string): boolean {
    const p = customPath ?? this.stateFile;
    try {
      if (!fs.existsSync(p)) return false;
      const raw = fs.readFileSync(p, "utf8");
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed.candidates)) {
        for (const c of parsed.candidates) {
          if (c && typeof c.backend === "string" && this.candidates.has(c.backend)) {
            this.candidates.set(c.backend, {
              ...this.candidates.get(c.backend)!,
              ...c,
            });
          }
        }
        log.info(`[DarwinEngine] Restored state from ${p} (${parsed.candidates.length} candidates loaded)`);
        return true;
      }
    } catch (err) {
      log.warn(`[DarwinEngine] Failed to load state from ${p}: ${err instanceof Error ? err.message : String(err)}`);
    }
    return false;
  }

  /** Un-eliminate or reset a specific candidate backend */
  public resetCandidate(backend: string): boolean {
    const stats = this.candidates.get(backend);
    if (!stats) return false;
    stats.eliminated = false;
    stats.eliminationReason = undefined;
    stats.blocks = 0;
    stats.fails = 0;
    stats.consecutiveBlocks = 0;
    stats.consecutiveFails = 0;
    this.recomputeScores();
    void this.saveState();
    log.info(`[DarwinEngine] Reset candidate backend [${backend}]`);
    return true;
  }
}
