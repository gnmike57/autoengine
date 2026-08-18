
import "dotenv/config";
import { AutomationEngine, DEFAULT_TARGETS } from "../src/core/engine.js";
import { initDB } from "../src/core/database.js";
initDB();
const config = JSON.parse(process.env.ENGINE_CONFIG ?? "{}");
const creds = JSON.parse(process.env.TEST_CREDS ?? "[]");

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
