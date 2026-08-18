/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { chromium  } from "playwright";
import fs from "fs";
import path from "path";

const DATA_DIR = path.join(process.cwd(), "data");
const CALIBRATION_FILE = path.join(DATA_DIR, "cookie-calibration.json");

interface CookieCalibrationData {
  site: string;
  selectorPath: string;
  coordinates: { x: number; y: number; width: number; height: number };
  timestamp: string;
}

async function runCalibration(url: string, siteName: string) {
  console.log(`[Calibrator] Booting to calibrate cookies for: ${siteName} (${url})`);
  const browser = await chromium.launch({ headless: false }); // Headful to allow user to see it if needed
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await page.goto(url, { waitUntil: "networkidle", timeout: 20000 }).catch(() => {
      console.log(`[Calibrator] networkidle timed out, but proceeding anyway...`);
    });

    console.log(`[Calibrator] Page loaded. Aggressively scanning for cookie notice for 30s...`);

    const result = await page.evaluate(`
      (async () => {
        function deepFindButton(regex) {
          const queue = [document.body];
          while (queue.length > 0) {
            const node = queue.shift();
            if (!node) continue;
            if (node.shadowRoot) queue.push(node.shadowRoot);
            if (node.nodeType === 1) {
              if (node.matches && node.matches('button, [role="button"], a.btn, [class*="close"], [class*="cookie"]')) {
                const text = (node.textContent || node.getAttribute('aria-label') || '').toLowerCase();
                if (regex.test(text)) return node;
              }
              const children = node.children || [];
              for (let i = 0; i < children.length; i++) queue.push(children[i]);
            } else if (node.nodeType === 11) {
              const children = node.children || [];
              for (let i = 0; i < children.length; i++) queue.push(children[i]);
            }
          }
          return null;
        }

        function getComposedPath(el) {
          const path = [];
          let current = el;
          while (current && current.nodeType !== Node.DOCUMENT_NODE) {
            if (current.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
              current = current.host;
              path.unshift(">>");
              continue;
            }
            let selector = current.tagName.toLowerCase();
            if (current.id) {
              selector += '#' + CSS.escape(current.id);
            } else if (current.className && typeof current.className === 'string') {
              const classes = current.className.trim().split(/\\s+/).filter(Boolean);
              if (classes.length > 0) {
                selector += '.' + CSS.escape(classes[0]);
              }
            }
            path.unshift(selector);
            current = current.parentNode;
          }
          return path.join(" ").replace(/\\s+>>\\s+/g, " >> ").replace(/\\s+/g, " ");
        }

        return new Promise((resolve) => {
          let ms = 0;
          const interval = setInterval(() => {
            const btn = deepFindButton(/accept all|agree|got it/i);
            if (btn) {
              clearInterval(interval);
              const rect = btn.getBoundingClientRect();
              resolve({
                selectorPath: getComposedPath(btn),
                coordinates: {
                  x: rect.left + rect.width / 2,
                  y: rect.top + rect.height / 2,
                  width: rect.width,
                  height: rect.height
                }
              });
            }
            ms += 500;
            if (ms > 30000) {
              clearInterval(interval);
              resolve(null);
            }
          }, 500);
        });
      })();
    `);

    if (result) {
      const res = result as any;
      console.log(`[Calibrator] ✅ Found Cookie Banner!`);
      console.log(`[Calibrator] Composed Selector: ${res.selectorPath}`);
      console.log(`[Calibrator] Exact Coordinates: X=${res.coordinates.x}, Y=${res.coordinates.y}`);

      if (!fs.existsSync(DATA_DIR)) await fs.promises.mkdir(DATA_DIR, { recursive: true });

      let registry: Record<string, CookieCalibrationData> = {};
      if (fs.existsSync(CALIBRATION_FILE)) {
        registry = JSON.parse(await fs.promises.readFile(CALIBRATION_FILE, 'utf-8'));
      }

      registry[siteName] = {
        site: siteName,
        selectorPath: res.selectorPath,
        coordinates: res.coordinates,
        timestamp: new Date().toISOString()
      };

      await fs.promises.writeFile(CALIBRATION_FILE, JSON.stringify(registry, null, 2));
      console.log(`[Calibrator] Successfully wrote calibration to ${CALIBRATION_FILE}`);
    } else {
      console.log(`[Calibrator] ❌ Failed to find cookie banner after 30 seconds.`);
    }
  } catch (e: unknown) {
    console.error(`[Calibrator] Error during calibration: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    await browser.close();
  }
}

export { runCalibration };

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  void runCalibration("https://www.joefortune.zone/login", "joefortune");
}