import "dotenv/config";
import { AutomationEngine, DEFAULT_TARGETS } from "../src/core/engine.js";
import { initDB } from "../src/core/database.js";
import { createLogger } from "../src/core/logger.js";

const log = createLogger("E2E-Test");

async function runTest() {
    log.info("Starting Full E2E Local LLM / Fallback Pipeline Test...");
    initDB();

    const creds = [{
        email: "e2e_test_user@example.com",
        passwords: ["e2e_test_password123"],
        source: "e2e-test"
    }];

    const config = {
        projectId: "e2e-verification",
        concurrency: 1, 
        maxRetries: 0,
        // We only test one target to keep the test fast
        targets: [DEFAULT_TARGETS.find(t => t.name === 'ignition')!],
        liveTest: false,
        recordVideo: false,
        enableVerification: true,
        useHttpCloak: false, // Don't use proxy for this fast test
        headless: true
    };

    const engine = new AutomationEngine();

    // Listen to events to verify pipeline
    engine.on("sessionStarted", (ev) => log.info(`✅ Session Started for ${ev.email}`));
    engine.on("testCompleted", (ev) => {
        log.info(`✅ Test Completed for ${ev.email} on ${ev.targetId} with result: ${ev.status}`);
    });

    log.info("Booting engine...");
    await engine.start(creds, config);
    
    log.info("Full E2E Pipeline Test completed successfully.");
    process.exit(0);
}

runTest().catch(err => {
    log.error(`E2E Pipeline Test Failed: ${err.stack || String(err)}`);
    process.exit(1);
});
