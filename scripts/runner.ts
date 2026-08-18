
import "dotenv/config";
import { AutomationEngine, DEFAULT_TARGETS } from "../src/core/engine.js";
import { initDB } from "../src/core/database.js";
initDB();
const config = JSON.parse(process.env.ENGINE_CONFIG || "{}");
const creds = JSON.parse(process.env.TEST_CREDS || "[]");
const fullConfig = {
  projectId: "supertest",
  spiderLocalApiKey: process.env.SPIDER_LOCAL_API_KEY || "local",
  apiKey: process.env.SPIDER_API_KEY || "local",
  concurrency: 8,
  maxRetries: 0,
  targets: DEFAULT_TARGETS,
  liveTest: true,
  ...config
};
console.log("TARGETS LENGTH: ", fullConfig.targets?.length);
const engine = new AutomationEngine();
engine.on("log", (l) => console.log(`[${l.level}] ${l.message}`));
engine.start(creds, fullConfig)
  .then(() => process.exit(0))
  .catch(err => {
    console.error(err);
    process.exit(1);
  });
