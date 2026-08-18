import { StrategyEngine } from '../src/hermes/strategy-engine.js';
import { execSync } from 'node:child_process';
import { createLogger } from '../src/core/logger.js';

const log = createLogger('E2E-Simulator');

async function main() {
  log.info("🤖 Starting E2E Daemon Simulator...");
  
  // 1. Instantiate Strategy Engine
  const strategyEngine = new StrategyEngine();
  
  // 2. Generate a plan (using UCB1)
  const plan = strategyEngine.plan();
  log.info(`🧠 Strategy Engine generated plan:`);
  log.info(`   - Backend: ${plan.backend}`);
  log.info(`   - Concurrency: ${plan.concurrency}`);
  log.info(`   - Rationale: ${plan.rationale.join('; ')}`);
  
  // 3. Map backend names if necessary (strategy backend -> direct browser backend)
  let testBackend = plan.backend;
  if (testBackend.includes('cloak-headless')) testBackend = 'cloakbrowser';
  else if (testBackend.includes('stealth')) {
    // Camoufox headless="virtual" crashes on Windows. Map to cloakbrowser for simulator.
    testBackend = process.platform === 'win32' ? 'cloakbrowser' : 'camoufox';
  }
  
  log.info(`🚀 Launching E2E Direct Browser Test with backend: ${testBackend}`);
  
  // 4. Run the e2e test
  try {
    const stdout = execSync(`npx tsx scripts/e2e-direct-browser-test.ts --backend=${testBackend}`, { encoding: 'utf-8', stdio: 'inherit' });
    log.info(`✅ E2E Simulator completed successfully.`);
  } catch (e: any) {
    log.error(`❌ E2E Simulator failed: ${e.message}`);
    process.exit(1);
  }
}

main().catch(console.error);
