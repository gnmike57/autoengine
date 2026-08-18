import fs from 'fs';
import path from 'path';
import { createSession, type SessionOpts, gridBounds } from '../../backends/index.js';
import { ConfigStore } from '../core/config-store.js';
import { chromium } from 'playwright-core';

const args = process.argv.slice(2);
const targetLayout = args[0] || 'auto';

const backends = ['cloak-headed', 'stealth-headed', 'zendriver-headed'];

interface WindowBounds {
  backend: string;
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
  screenshotBase64: string;
}

const colors: Record<string, string> = {
  'cloak-headed': '#3b82f6', // Blue
  'stealth-headed': '#f97316', // Orange
  'zendriver-headed': '#ef4444' // Red
};

async function runTestForWindowCount(windowCount: number, reportDir: string) {
  console.log(`\n=== Tiling Optimizer ===\nLayout: ${targetLayout}\nWindows: ${windowCount}\n`);

  const currentConfig = ConfigStore.load();
  currentConfig.tilingLayout = targetLayout;
  currentConfig.concurrency = windowCount;
  ConfigStore.save(currentConfig);

  const sessions: any[] = [];
  const boundsResult: WindowBounds[] = [];

  for (let i = 0; i < windowCount; i++) {
    const backend = backends[i % backends.length] as any;
    const opts: SessionOpts = { backend, headless: false };

    console.log(`[Slot ${i}] Launching ${backend}...`);
    try {
      const session = await createSession(opts);
      sessions.push({ session, backend });

      await session.page.goto('about:blank');

      const color = colors[backend]!;
      await session.page.evaluate(({ backend, color, i }) => {
        document.body.style.backgroundColor = color;
        document.body.style.margin = '0';
        document.body.style.display = 'flex';
        document.body.style.justifyContent = 'center';
        document.body.style.alignItems = 'center';
        document.body.style.height = '100vh';
        document.body.style.overflow = 'hidden';
        document.body.style.color = 'white';
        document.body.style.fontFamily = 'system-ui, sans-serif';
        document.body.style.fontSize = '4rem';
        document.body.style.fontWeight = 'bold';
        document.body.style.textShadow = '2px 2px 4px rgba(0,0,0,0.5)';
        document.body.innerHTML = `<div style="text-align:center">${backend}<br><span style="font-size:2rem">Slot ${i}</span></div>`;
      }, { backend, color, i });

      // Wait 3 seconds for window manager to fully snap the window
      await session.page.waitForTimeout(3000);

      // TARGET BOUNDS: Use gridBounds directly instead of relying on the physical window size.
      // This bypasses macOS Camoufox's strict minimum size enforcement which overlaps tiles visually.
      const targetScreenBounds = await gridBounds(i);

      // Capture screenshot of just this browser's page viewport
      const buffer = await session.page.screenshot({ type: 'png' });
      const base64 = buffer.toString('base64');

      boundsResult.push({
        backend,
        x: targetScreenBounds.x,
        y: targetScreenBounds.y,
        width: targetScreenBounds.width,
        height: targetScreenBounds.height,
        color,
        screenshotBase64: base64
      });

      console.log(`[Slot ${i}] Bounds: x=${targetScreenBounds.x} y=${targetScreenBounds.y} w=${targetScreenBounds.width} h=${targetScreenBounds.height}`);

      // Small delay to prevent OOM or shared process crash during massive concurrency (N=5+)
      await new Promise(r => setTimeout(r, 2000));
    } catch (e: any) {
      console.error(`[Slot ${i}] Failed to launch ${backend}: ${e.message}`);
    }
  }

  // ── Stitching Desktop Screenshot (Bypass Admin Rights) ──
  const desktopWidth = 1920;
  const desktopHeight = 1080;

  const html = `
    <html>
      <head>
        <style>
          body { margin: 0; background: url('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=') repeat; /* MacOS-ish dark gray */ background-color: #1a1a1a; width: ${desktopWidth}px; height: ${desktopHeight}px; position: relative; overflow: hidden; }
          .window-frame {
             position: absolute;
             box-shadow: 0 10px 30px rgba(0,0,0,0.7);
             border-radius: 8px;
             overflow: hidden;
             background: #fff;
             /* Simulate macOS title bar */
             border: 1px solid rgba(255,255,255,0.1);
          }
          .title-bar {
             height: 28px;
             background: #333;
             display: flex;
             align-items: center;
             padding: 0 10px;
          }
          .traffic-lights {
             display: flex; gap: 6px;
          }
          .traffic-lights div {
             width: 12px; height: 12px; border-radius: 50%;
          }
          .close { background: #ff5f56; }
          .min { background: #ffbd2e; }
          .max { background: #27c93f; }
          .content {
             width: 100%; height: calc(100% - 28px);
             background-size: cover;
             background-position: center;
          }
        </style>
      </head>
      <body>
        <!-- Top Menu Bar -->
        <div style="width: 100%; height: 24px; background: rgba(0,0,0,0.8); position: absolute; top: 0; left: 0; z-index: 9999;"></div>

        ${boundsResult.map(b => `
          <div class="window-frame" style="left: ${b.x}px; top: ${b.y}px; width: ${b.width}px; height: ${b.height}px;">
             <div class="title-bar">
                <div class="traffic-lights">
                   <div class="close"></div><div class="min"></div><div class="max"></div>
                </div>
             </div>
             <div class="content" style="background-image: url('data:image/png;base64,${b.screenshotBase64}');"></div>
          </div>
        `).join('')}
      </body>
    </html>
  `;

  // Render the assembled HTML to a true PNG image
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: desktopWidth, height: desktopHeight } });
  await page.setContent(html);

  const screenshotName = `desktop-${targetLayout}-${windowCount}.png`;
  const screenshotPath = path.join(reportDir, screenshotName);
  await page.screenshot({ path: screenshotPath });
  await browser.close();

  // Save raw bounds data for ML evaluation
  fs.writeFileSync(path.join(reportDir, `bounds-${targetLayout}-${windowCount}.json`), JSON.stringify(boundsResult, null, 2), 'utf8');

  console.log(`\n✅ Stitched Desktop Screenshot generated at: ${screenshotPath}`);

  for (const s of sessions) {
    try { await s.session.close(); } catch { /* session already closed */ }
  }
}

async function run() {
  const reportDir = path.join(process.cwd(), 'reports', 'tiling-optimizations');
  fs.mkdirSync(reportDir, { recursive: true });

  for (let windows = 2; windows <= 8; windows++) {
    try {
      await runTestForWindowCount(windows, reportDir);
    } catch (e: any) {
      console.error(`Failed to run tiling test for ${windows} windows: ${e.message}`);
    }
  }

  process.exit(0);
}

run().catch(console.error);
