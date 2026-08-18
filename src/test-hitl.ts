import HermesOrchestrator from './hermes/hermes-review.js';
import { createLogger } from './core/logger.js';

const log = createLogger('Test');

async function runTest() {
    log.info("Starting HITL Test...");
    const hermes = new HermesOrchestrator();

    // Simulate 5 chronic failures to trigger the pause and HITL webhook
    for (let i = 0; i < 5; i++) {
        log.info(`Simulating failure ${i + 1}...`);
        hermes.learnFromFailure('test@example.com', 'ign', 'cloudflare_block');
    }

    // Let Node's event loop naturally keep the process alive while the LLM request is pending.
    log.info("Test complete. Waiting for background LLM processes to drain...");
}

runTest().catch(console.error);
