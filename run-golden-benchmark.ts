import { AutomationEngine, type EngineConfig, DEFAULT_TARGETS } from './src/core/engine.js';
import { ConfigStore } from './src/core/config-store.js';
import * as fs from 'fs';
import * as path from 'path';

// Golden credentials are injected at runtime and must never be committed.
const GOLDEN_CREDS = {
  joe: process.env.GOLDEN_CRED_JOE ?? "",
  ignition: process.env.GOLDEN_CRED_IGNITION ?? "",
};

async function run() {
  if (!GOLDEN_CREDS.joe || !GOLDEN_CREDS.ignition) {
    throw new Error("Set GOLDEN_CRED_JOE and GOLDEN_CRED_IGNITION in the private runtime environment before running the benchmark.");
  }
  const appConfig = ConfigStore.load();
  
  // Cast config to EngineConfig to satisfy strict typings.
  const config = {
    ...appConfig,
    targets: DEFAULT_TARGETS,
    backend: 'golden-benchmark',
    concurrency: appConfig.concurrency ?? 4,
    maxRetries: 0,
    liveTest: true
  } as EngineConfig;
  
  const backendsToTest = [
    'stealth-headed', 
    'cloak-headed', 
    'cloak-headed-nocloak', 
    'zendriver-headed'
  ];

  const engine = new AutomationEngine();

  // Handle standard logs
  engine.on("log", (msg) => {
    // Only print INFO and higher to avoid spamming the CLI
    if (msg.level === "INFO" || msg.level === "WARN" || msg.level === "ERR") {
      process.stdout.write(`\n[${msg.level}] ${msg.message}`);
    }
  });

  // Track the latest leaderboard state
  let lastLeaderboard: any[] = [];
  
  engine.on("benchmark-update", (data) => {
    lastLeaderboard = data.leaderboard;
  });
  
  console.log("🚀 Starting 4-Window Golden Benchmark Suite...");
  
  try {
    // Run the benchmark suite
    await engine.runGoldenBenchmarkSuite(GOLDEN_CREDS, config, backendsToTest);
    
    console.log("\n\n🏆 === GOLDEN BENCHMARK COMPLETE === 🏆\n");
    console.table(lastLeaderboard);
    
    // Determine winner
    const winner = lastLeaderboard.find(b => b.winner);
    if (winner) {
      console.log(`\n👑 OVERALL WINNER: ${winner.backend} 👑\n`);
    } else {
      console.log(`\n❌ NO WINNER. All backends failed the benchmark.\n`);
    }

    // Save results for the Web UI Dashboard
    const dataDir = path.join(process.cwd(), 'data');
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    
    const statsPayload = {
      timestamp: Date.now(),
      winner: winner ? winner.backend : null,
      leaderboard: lastLeaderboard
    };
    
    fs.writeFileSync(path.join(dataDir, 'latest-golden-benchmark.json'), JSON.stringify(statsPayload, null, 2));
    console.log("💾 Saved benchmark stats to data/latest-golden-benchmark.json for the Web UI.");
    
    // Graceful exit
    setTimeout(() => process.exit(0), 1000);

  } catch (err) {
    console.error("\n❌ Fatal error during benchmark:", err);
    process.exit(1);
  }
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
