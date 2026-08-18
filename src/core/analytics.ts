import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from './logger.js';

const log = createLogger('analytics');

export interface BenchmarkMetrics {
  backend: string;
  totalTime: number;
  status: string;
  winner: boolean;
  proxyBurnRate: number; // 0-1
  honeypotTriggerRate: number; // 0-1
  avgDomLatencyMs: number;
  sites: Record<string, { time: number; status: string }>;
}

export interface BenchmarkReport {
  timestamp: string;
  durationMs: number;
  winner: string | null;
  metrics: BenchmarkMetrics[];
}

export class AnalyticsAggregator {
  private static async getReportsDirAsync(): Promise<string> {
    const dir = path.join(process.cwd(), 'reports', 'benchmarks');
    await fs.promises.mkdir(dir, { recursive: true });
    return dir;
  }

  public static async saveBenchmarkReport(report: BenchmarkReport): Promise<string> {
    try {
      const dir = await this.getReportsDirAsync();
      const filename = `benchmark-${new Date(report.timestamp).getTime()}.json`;
      const filepath = path.join(dir, filename);

      await fs.promises.writeFile(filepath, JSON.stringify(report, null, 2), 'utf8');
      log.info(`📊 Saved benchmark analytics report to ${filepath}`);
      return filepath;
    } catch (err) {
      log.error(`Failed to save benchmark report: ${err instanceof Error ? err.message : String(err)}`);
      return '';
    }
  }
}
