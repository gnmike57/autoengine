import "dotenv/config";
import { exec } from "child_process";

// Run: tsx test-golden-benchmark.ts

const backends = ["cloak-headed", "stealth-headed", "cloak-headed-nocloak", "zendriver-headed"];
const timings: Record<string, { start: number; end: number | null; duration: number | null; outcome: string }> = {};

async function runBenchmarkForBackend(backend: string, index: number): Promise<void> {
  timings[backend] = { start: Date.now(), end: null, duration: null, outcome: "pending" };
  
  return new Promise((resolve) => {
    // We pass FORCE_BACKEND to override app-config.json
    // We pass SCREEN_INDEX to position the headed windows in a tiled grid
    const cmd = `set FORCE_BACKEND=${backend} && set SCREEN_INDEX=${index} && npx tsx tests/live/run-flow-debug.ts`;
    const child = exec(cmd, { stdio: 'pipe' } as any);
    
    let fullOutput = "";

    child.stdout?.on('data', (data) => {
      const chunk = data.toString();
      fullOutput += chunk;
      // Optionally print real-time output if you want to watch the progress:
      // process.stdout.write(`[${backend}] ${chunk}`);
    });

    child.stderr?.on('data', (data) => {
      fullOutput += data.toString();
    });

    child.on('error', (err) => {
      timings[backend]!.outcome = `FAILED (Spawn error: ${err.message})`;
      resolve();
    });

    child.on('close', (code) => {
      const end = Date.now();
      const duration = (end - timings[backend]!.start) / 1000;
      timings[backend]!.end = end;
      timings[backend]!.duration = duration;

      // Extract the outcome from the Golden Joe Review output
      const match = fullOutput.match(/Golden Joe Review (PASSED|FAILED) — ([a-z-]+) \(([\d.]+)s\)/);
      if (match) {
        timings[backend]!.outcome = `${match[1]} (${match[2]})`;
        // Use the internal engine duration if available as it doesn't count boot time
        timings[backend]!.duration = parseFloat(match[3] || "0"); 
      } else {
        timings[backend]!.outcome = code === 0 ? "PASSED (unknown)" : "FAILED";
      }

      resolve();
    });
  });
}

async function main() {
  console.log("==========================================================");
  console.log("🏆 GOLDEN BENCHMARK: CONCURRENT BACKEND RACE 🏆");
  console.log("==========================================================");
  console.log(`Starting ${backends.length} backends concurrently...`);

  const promises = backends.map((backend, index) => runBenchmarkForBackend(backend, index));
  
  const startTime = Date.now();
  await Promise.all(promises);
  const totalDuration = (Date.now() - startTime) / 1000;

  console.log("\n==========================================================");
  console.log("🏆 BENCHMARK RESULTS 🏆");
  console.log("==========================================================");
  
  // Sort by duration ascending
  const sorted = backends.sort((a, b) => (timings[a]!.duration || 999) - (timings[b]!.duration || 999));
  
  sorted.forEach((backend, i) => {
    const t = timings[backend]!;
    const rank = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `${i+1}.`;
    console.log(`${rank} ${backend.padEnd(16)} | Time: ${t.duration?.toFixed(2).padStart(5)}s | Outcome: ${t.outcome}`);
  });
  
  console.log("==========================================================");
  console.log(`Total concurrent wall-clock time: ${totalDuration.toFixed(2)}s`);
  console.log("==========================================================");
}

main().catch(console.error);
