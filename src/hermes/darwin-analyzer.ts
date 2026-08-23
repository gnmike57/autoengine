import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { createLogger } from "../core/logger.js";
import { DarwinDiagnosticReport, DarwinScorecard } from "../core/darwin-engine.js";

const log = createLogger("HermesDarwinAnalyzer");

export interface HermesDarwinMemory {
  lastUpdated: string;
  optimalBackend: string;
  optimalScore: number;
  decisiveRate: number;
  sampleSize: number;
  backendRankings: Array<{
    backend: string;
    score: number;
    decisiveRate: number;
    blockRate: number;
    avgLatencyMs: number;
    status: "optimal" | "viable" | "eliminated";
  }>;
  historicalRuns: Array<{
    timestamp: string;
    winner: string;
    score: number;
    totalAttempts: number;
  }>;
}

export class HermesDarwinAnalyzer {
  private db: Database.Database | null = null;
  private memoryPath: string;
  private learningDir: string;

  constructor(repoRoot = process.cwd()) {
    this.learningDir = path.join(repoRoot, "learning");
    this.memoryPath = path.join(this.learningDir, "hermes-memory.json");
    this.initDb(repoRoot);
  }

  private initDb(repoRoot: string): void {
    try {
      const dbPath = path.join(repoRoot, "data", "credentials.sqlite");
      if (fs.existsSync(dbPath)) {
        this.db = new Database(dbPath);
        this.db.pragma("journal_mode = WAL");
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS darwin_insights (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp TEXT NOT NULL,
            optimal_backend TEXT NOT NULL,
            score INTEGER NOT NULL,
            decisive_rate REAL NOT NULL,
            block_rate REAL NOT NULL,
            avg_latency_ms INTEGER NOT NULL,
            sample_size INTEGER NOT NULL,
            report_json TEXT NOT NULL
          );
        `);
      }
    } catch (err) {
      log.warn(`[HermesDarwinAnalyzer] Failed to initialize SQLite darwin_insights table: ${String(err)}`);
    }
  }

  public learnFromDarwinReport(report: DarwinDiagnosticReport): {
    optimalBackend: string | null;
    recommendation: string;
    scorecard: DarwinScorecard;
  } {
    const scorecard = report.scorecard;
    const winner = scorecard.winner ?? (scorecard.rankedBackends.length > 0 ? {
      backend: scorecard.rankedBackends[0]!.backend,
      score: scorecard.rankedBackends[0]!.compositeScore,
      decisiveRate: scorecard.rankedBackends[0]!.totalAttempts > 0
        ? Math.round((scorecard.rankedBackends[0]!.decisive / scorecard.rankedBackends[0]!.totalAttempts) * 100)
        : 0,
      blockRate: scorecard.rankedBackends[0]!.totalAttempts > 0
        ? Math.round((scorecard.rankedBackends[0]!.blocks / scorecard.rankedBackends[0]!.totalAttempts) * 100)
        : 0,
      avgDurationMs: scorecard.rankedBackends[0]!.avgDurationMs,
      confidence: Math.min(100, Math.round((scorecard.rankedBackends[0]!.totalAttempts / 5) * 100)),
    } : undefined);

    if (!winner) {
      log.warn("[HermesDarwinAnalyzer] No viable backend emerged from Darwin report");
      return {
        optimalBackend: null,
        recommendation: "All backends eliminated or insufficient data. Re-test with clean proxies.",
        scorecard,
      };
    }

    log.info(`🦎 [Hermes Learning] Discovered optimal backend from Darwin evaluation: ${winner.backend} (Score: ${winner.score}, Decisive: ${winner.decisiveRate}%, Confidence: ${winner.confidence}%)`);

    // 1. Persist to SQLite
    if (this.db) {
      try {
        const stmt = this.db.prepare(`
          INSERT INTO darwin_insights (timestamp, optimal_backend, score, decisive_rate, block_rate, avg_latency_ms, sample_size, report_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);
        stmt.run(
          report.timestamp,
          winner.backend,
          winner.score,
          winner.decisiveRate,
          winner.blockRate,
          winner.avgDurationMs,
          report.totalAttempts,
          JSON.stringify(report)
        );
      } catch (err) {
        log.warn(`[HermesDarwinAnalyzer] Failed to insert into darwin_insights: ${String(err)}`);
      }
    }

    // 2. Persist to hermes-memory.json
    try {
      if (!fs.existsSync(this.learningDir)) {
        fs.mkdirSync(this.learningDir, { recursive: true });
      }

      let memory: any = {};
      if (fs.existsSync(this.memoryPath)) {
        try {
          memory = JSON.parse(fs.readFileSync(this.memoryPath, "utf8"));
        } catch {}
      }

      memory.darwinOptimization = {
        lastUpdated: report.timestamp,
        optimalBackend: winner.backend,
        optimalScore: winner.score,
        decisiveRate: winner.decisiveRate,
        sampleSize: report.totalAttempts,
        backendRankings: scorecard.rankedBackends.map((b) => ({
          backend: b.backend,
          score: b.compositeScore,
          decisiveRate: b.totalAttempts > 0 ? Math.round((b.decisive / b.totalAttempts) * 100) : 0,
          blockRate: b.totalAttempts > 0 ? Math.round((b.blocks / b.totalAttempts) * 100) : 0,
          avgLatencyMs: b.avgDurationMs,
          status: b.eliminated ? "eliminated" : (b.backend === winner.backend ? "optimal" : "viable"),
        })),
      };

      if (!Array.isArray(memory.darwinHistoricalWinners)) {
        memory.darwinHistoricalWinners = [];
      }
      memory.darwinHistoricalWinners.push({
        timestamp: report.timestamp,
        winner: winner.backend,
        score: winner.score,
        totalAttempts: report.totalAttempts,
      });

      fs.writeFileSync(this.memoryPath, JSON.stringify(memory, null, 2), "utf8");
      log.info(`[HermesDarwinAnalyzer] Updated Hermes memory with optimal backend: ${winner.backend}`);
    } catch (err) {
      log.warn(`[HermesDarwinAnalyzer] Failed to update hermes-memory.json: ${String(err)}`);
    }

    return {
      optimalBackend: winner.backend,
      recommendation: `Lock active batch engine to ${winner.backend} (highest resilience score: ${winner.score}).`,
      scorecard,
    };
  }

  public getLearnedOptimalBackend(): string | null {
    try {
      if (fs.existsSync(this.memoryPath)) {
        const memory = JSON.parse(fs.readFileSync(this.memoryPath, "utf8"));
        if (memory?.darwinOptimization?.optimalBackend) {
          return memory.darwinOptimization.optimalBackend;
        }
      }
    } catch {}
    return null;
  }
}

export const hermesDarwinAnalyzer = new HermesDarwinAnalyzer();
