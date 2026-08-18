import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import crypto from 'crypto';

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error("Usage: npx tsx src/utils/isolated-test-runner.ts <path-to-test-file>");
  process.exit(1);
}

const targetTestFile = args[0]!;
const resolvedTarget = path.resolve(process.cwd(), targetTestFile);

if (!fs.existsSync(resolvedTarget)) {
  console.error(`Target test file not found: ${resolvedTarget}`);
  process.exit(1);
}

const runId = crypto.randomBytes(4).toString('hex');
const timestamp = Date.now();

// 1. Snapshot the config
const tempConfigName = `.temp-config.${timestamp}-${runId}.json`;
const tempConfigPath = path.join(process.cwd(), tempConfigName);
const baseConfigPath = path.join(process.cwd(), 'app-config.json');

if (fs.existsSync(baseConfigPath)) {
  fs.copyFileSync(baseConfigPath, tempConfigPath);
} else {
  fs.writeFileSync(tempConfigPath, "{}", 'utf8');
}

// 2. Snapshot the .env file
const tempEnvName = `.temp-env.${timestamp}-${runId}`;
const tempEnvPath = path.join(process.cwd(), tempEnvName);
const baseEnvPath = path.join(process.cwd(), '.env');

if (fs.existsSync(baseEnvPath)) {
  fs.copyFileSync(baseEnvPath, tempEnvPath);
} else {
  fs.writeFileSync(tempEnvPath, "", 'utf8');
}

// 3. Snapshot the test script itself in its original directory
const targetDir = path.dirname(resolvedTarget);
const targetExt = path.extname(resolvedTarget);
const targetBase = path.basename(resolvedTarget, targetExt);
const tempTestName = `.temp-${targetBase}.${timestamp}-${runId}${targetExt}`;
const tempTestPath = path.join(targetDir, tempTestName);

fs.copyFileSync(resolvedTarget, tempTestPath);

console.log(`[IsolatedRunner] Spawned isolated test run: ${runId}`);
console.log(`[IsolatedRunner] Config snapshot: ${tempConfigName}`);
console.log(`[IsolatedRunner] Env snapshot: ${tempEnvName}`);
console.log(`[IsolatedRunner] Script snapshot: ${tempTestName}`);

// We spawn the temporary test script
// DOTENV_CONFIG_PATH is native to dotenv to override the default .env lookup
const child = spawn("npx", ["tsx", tempTestPath], {
  stdio: "inherit",
  env: {
    ...process.env,
    AUTOMATI_CONFIG_PATH: tempConfigPath,
    DOTENV_CONFIG_PATH: tempEnvPath,
  }
});

let cleanedUp = false;
const cleanup = () => {
  if (cleanedUp) return;
  cleanedUp = true;
  try {
    if (fs.existsSync(tempConfigPath)) {
      fs.unlinkSync(tempConfigPath);
      console.log(`[IsolatedRunner] Cleaned up config: ${tempConfigName}`);
    }
  } catch { /* ignore cleanup errors */ }
  try {
    if (fs.existsSync(tempEnvPath)) {
      fs.unlinkSync(tempEnvPath);
      console.log(`[IsolatedRunner] Cleaned up env: ${tempEnvName}`);
    }
  } catch { /* ignore cleanup errors */ }
  try {
    if (fs.existsSync(tempTestPath)) {
      fs.unlinkSync(tempTestPath);
      console.log(`[IsolatedRunner] Cleaned up script: ${tempTestName}`);
    }
  } catch { /* ignore cleanup errors */ }
};

child.on('exit', (code) => {
  cleanup();
  process.exit(code ?? 0);
});

process.on('SIGINT', () => {
  child.kill('SIGINT');
  cleanup();
  process.exit(1);
});

process.on('SIGTERM', () => {
  child.kill('SIGTERM');
  cleanup();
  process.exit(1);
});
