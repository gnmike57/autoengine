import { spawn } from 'child_process';

console.log(`\n======================================================`);
console.log(`🤖 [GoldenBaseline] Starting Golden Joe Baseline Check (Single Run)`);
console.log(`======================================================\n`);

const child = spawn('npx', ['tsx', 'tests/live/run-flow-debug.ts'], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: {
        ...process.env,
        HEADLESS_GOLDEN: '1',
        RECORD_VIDEO: '1',
        ENABLE_PLAYWRIGHT_TRACING: '1',
    }
});

child.on('error', (err) => {
    console.log(`\n❌ [GoldenBaseline] Failed to start: ${err.message}\n`);
});

child.on('close', (code) => {
    if (code === 0) {
        console.log(`\n✅ [GoldenBaseline] Baseline check passed successfully!\n`);
    } else {
        console.log(`\n❌ [GoldenBaseline] Baseline check failed with code ${code}.\n`);
    }
});

// Prevent architectural leaks (orphaned processes)
process.on('exit', () => child.kill());
process.on('SIGINT', () => { child.kill(); process.exit(1); });
process.on('SIGTERM', () => { child.kill(); process.exit(1); });
