import "dotenv/config";
import { DEFAULT_TARGETS } from "../src/core/engine.js";
import { initDB, getUntestedCredentials, db } from "../src/core/database.js";
import { createLogger } from "../src/core/logger.js";
import { spawn } from "child_process";
import * as path from "path";
import * as fs from "fs";

const log = createLogger("LiveAutoImprover");

const TEST_SCRIPT = `
import "dotenv/config";
import { AutomationEngine, DEFAULT_TARGETS } from "../src/core/engine.js";
import { initDB } from "../src/core/database.js";
initDB();
const config = JSON.parse(process.env.ENGINE_CONFIG);
const creds = JSON.parse(process.env.TEST_CREDS);

// Targets are unfiltered
const targets = DEFAULT_TARGETS;

const fullConfig = {
  projectId: "live-supertest",
  concurrency: 12, 
  maxRetries: 0,
  targets: targets,
  liveTest: false,
  recordVideo: true,
  enableVerification: true,
  ...config
};

const engine = new AutomationEngine();
engine.start(creds, fullConfig)
  .then(() => process.exit(0))
  .catch(err => {
    console.error(err);
    process.exit(1);
  });
`;

const backends = ["spider-local", "spider-local-headed", "cloak-headless", "cloak-headed", "stealth", "stealth-headed", "zendriver", "zendriver-headed", "curl-api"];
const fpStrategies = ["fp-auto", "fp-fb-optimized"];
const booleans = [true, false];
const requestModes = ["stealth-max", "fast", undefined];

function randomChoice<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

function mutateConfig(config: any): any {
  const next = { ...config };
  const keys = ["backend", "fpStrategy", "enableCacheInjection", "requestMode", "rotateOnFingerprint"];
  const toMutate = randomChoice(keys);
  
  if (toMutate === "backend") next.backend = randomChoice(backends);
  if (toMutate === "fpStrategy") next.fpStrategy = randomChoice(fpStrategies);
  if (toMutate === "enableCacheInjection") next.enableCacheInjection = randomChoice(booleans);
  if (toMutate === "requestMode") next.requestMode = randomChoice(requestModes);
  if (toMutate === "rotateOnFingerprint") next.rotateOnFingerprint = randomChoice(booleans);
  
  return next;
}

// Track historical failures for backends to permanently eliminate them
const backendFailures: Record<string, number> = {};
const ELIMINATION_THRESHOLD = 50; // If a backend gets 50 N/As or Misdirections across batches, kill it

async function runAutoLoop() {
  initDB();
  const runnerPath = path.join(process.cwd(), "scripts/live-runner.ts");
  fs.writeFileSync(runnerPath, TEST_SCRIPT);

  let bestConfig: any = {
    backend: "spider-local",
    fpStrategy: "fp-auto",
    enableCacheInjection: false,
    recordVideo: true,
    enableVerification: true,
    rotateOnFingerprint: false
  };

  let bestScore = -9999;
  const BATCH_SIZE = 12;
  
  log.info("Starting endless live auto-improving supersetting loop...");

  let loopCount = 0;
  while (true) {
    loopCount++;
    const targetNames = DEFAULT_TARGETS.filter((t: any) => t.selectors?.username).map((t: any) => t.name);
    // Fetch REAL UNTESTED credentials
    const creds = getUntestedCredentials(targetNames);
    
    if (creds.length === 0) {
      log.info("All 1000+ credentials have been tested! Auto-loop complete.");
      break;
    }

    const chunk = creds.slice(0, Math.min(BATCH_SIZE, creds.length));
    
    const isValidation = Math.random() < 0.2 && loopCount > 1;
    const currentConfig = isValidation ? { ...bestConfig } : mutateConfig(bestConfig);
    
    // Check if the chosen backend has been eliminated
    if ((backendFailures[currentConfig.backend] ?? 0) >= ELIMINATION_THRESHOLD) {
      log.warn(`Backend ${currentConfig.backend} is ELIMINATED. Forcing mutation.`);
      currentConfig.backend = randomChoice(backends.filter(b => (backendFailures[b] || 0) < ELIMINATION_THRESHOLD)) || "spider-local";
    }
    
    log.info(`\n[Loop ${loopCount}] Testing Configuration (Score to beat: ${bestScore === -9999 ? 'N/A' : bestScore.toFixed(2)})`);
    log.info(`Type: ${isValidation ? 'VALIDATION of best' : 'MUTATION exploring'}`);
    log.info(`Config: ${JSON.stringify(currentConfig)}`);
    log.info(`Credentials (${chunk.length}): ${chunk.map((c: any) => c.email).join(', ')}`);
    
    await new Promise<void>((resolve) => {
      const p = spawn("npx", ["tsx", "scripts/live-runner.ts"], {
        env: {
          ...process.env,
          ENGINE_CONFIG: JSON.stringify(currentConfig),
          TEST_CREDS: JSON.stringify(chunk),
        },
        stdio: "inherit"
      });
      p.on("close", () => resolve());
    });
    
    let successes = 0;
    let misdirections = 0;
    let nas = 0;
    let aisVerified = 0;

    for (const cred of chunk) {
      const stmt = db.prepare("SELECT tr.outcome, tr.ai_verification_status FROM test_runs tr JOIN credentials c ON tr.credential_id = c.id WHERE c.email = ? ORDER BY tr.id DESC LIMIT 1");
      const row: any = stmt.get(cred.email);
      if (row) {
        const outcome = row.outcome;
        const aiStatus = row.ai_verification_status;
        
        if (outcome === "success" || outcome === "noaccount" || outcome === "2FA") successes++;
        else if (outcome === "tempdisabled" || outcome === "permdisabled" || outcome === "honeypot") misdirections++;
        else if (outcome === "N/A" || outcome === "timeout") nas++;
        
        if (aiStatus === "verified") aisVerified++;
      }
    }
    
    // Penalize backend for N/As and Misdirections to naturally eliminate it
    if (!backendFailures[currentConfig.backend]) backendFailures[currentConfig.backend] = 0;
    backendFailures[currentConfig.backend] = (backendFailures[currentConfig.backend] ?? 0) + misdirections + nas;
    if ((backendFailures[currentConfig.backend] ?? 0) >= ELIMINATION_THRESHOLD) {
       log.warn(`🚨 NATURAL SELECTION: Backend '${currentConfig.backend}' has reached failure threshold and is now PERMANENTLY ELIMINATED from mutation pool.`);
    }

    const score = (successes * 10) - (misdirections * 15) - (nas * 5) + (aisVerified * 2);
    log.info(`Results -> Clean: ${successes}, Misdirections/Blocks: ${misdirections}, N/As: ${nas}, AI Verified: ${aisVerified}`);
    log.info(`Calculated Score: ${score}`);

    if (score >= bestScore) {
      log.info(`✅ Configuration accepted! Maintained or improved score.`);
      bestScore = score;
      bestConfig = currentConfig;
    } else {
      log.info(`❌ Configuration worse than previous best. Discarding mutation.`);
    }

    log.info(`Current Optimal Config: ${JSON.stringify(bestConfig)} with score ${bestScore}`);
    
    await new Promise(r => setTimeout(r, 2000));
  }
}

runAutoLoop().catch(err => {
  log.error("Fatal error", err);
  process.exit(1);
});
