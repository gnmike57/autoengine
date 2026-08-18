import { execSync } from 'child_process';

import { createSession, type SessionOpts } from '../../backends/index.js';
import { ConfigStore } from '../core/config-store.js';

const windowCount = 4;
const backends = ['cloak-headed', 'stealth-headed', 'zendriver-headed', 'cloak-headed'];

async function run() {
  console.log(`\n=== Tiling Physical Test ===\nWindows: ${windowCount}\n`);

  const currentConfig = ConfigStore.load();
  currentConfig.tilingLayout = 'auto';
  currentConfig.concurrency = windowCount;
  ConfigStore.save(currentConfig);

  const sessions: any[] = [];

  for (let i = 0; i < windowCount; i++) {
    const backend = backends[i] as any;
    const opts: SessionOpts = { backend, headless: false };

    console.log(`[Slot ${i}] Launching ${backend}...`);
    try {
      const session = await createSession(opts);
      sessions.push({ session, backend });
      await session.page.goto('about:blank');
      await session.page.waitForTimeout(3000);

      const bounds = await session.page.evaluate(() => ({
        x: window.screenX,
        y: window.screenY,
        width: window.outerWidth,
        height: window.outerHeight,
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight
      }));

      console.log(`[Slot ${i} - ${backend}] PHYSICAL BOUNDS: x=${bounds.x} y=${bounds.y} outerW=${bounds.width} outerH=${bounds.height} innerW=${bounds.innerWidth} innerH=${bounds.innerHeight}`);

      await new Promise(r => setTimeout(r, 2000));
    } catch (e: any) {
      console.error(`[Slot ${i}] Failed to launch ${backends[i]}: ${e.message}`);
    }
  }

  for (const s of sessions) {
    try { await s.session.close(); } catch { /* session already closed */ }
  }

  console.log("Sweeping all remaining browser processes...");
  try {
    execSync('pkill -9 -f "camoufox" || true');
    execSync('pkill -9 -f "playwright" || true');
    execSync('pkill -9 -f "firefox" || true');
    execSync('pkill -9 -f "Chromium" || true');
  } catch { /* ignore sweep errors */ }

  process.exit(0);
}

run().catch(console.error);
