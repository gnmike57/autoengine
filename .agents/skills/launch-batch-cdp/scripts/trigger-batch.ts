import { chromium } from 'playwright-core';

async function trigger() {
  console.log("Connecting to Chrome on port 9224...");
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9224');
  const context = browser.contexts()[0];
  const page = context.pages().find(p => p.url().match(/127\.0\.0\.1:\d+/));
  
  if (!page) {
    console.error("Could not find the dashboard page. Available pages:", context.pages().map(p => p.url()));
    process.exit(1);
  }

  console.log("Found dashboard page:", page.url());

  // Use page.evaluate to bypass any visibility issues or collapsed accordions
  await page.evaluate(() => {
    // 1. Set backend to stealth-headed (Camoufox Headed)
    const backend = document.querySelector('#backendSelect') as HTMLSelectElement;
    if (backend) {
      backend.value = 'stealth-headed';
      backend.dispatchEvent(new Event('change'));
    }

    // 2. Set concurrency to 4
    const conc = document.querySelector('#advConcurrency') as HTMLInputElement;
    if (conc) {
      conc.value = '4';
      conc.dispatchEvent(new Event('change'));
    }

    // 3. Ensure Auto Optimize is checked
    const autoOpt = document.querySelector('#advAutoOptimize') as HTMLInputElement;
    if (autoOpt && !autoOpt.checked) {
      autoOpt.click();
    }
    
    console.log("Applied batch settings");
  });

  // Wait for WebSocket data to sync
  await page.waitForTimeout(2000);

  // Switch to credentials tab
  await page.locator('#nav-credentials').click({ force: true });
  await page.waitForTimeout(1000);

  // Click the Master Select All checkbox
  const check = page.locator('#credMasterCheck');
  if (await check.count() > 0) {
    await check.click({ force: true });
  }

  // Switch back to live view
  await page.locator('#nav-liveview').click({ force: true });
  await page.waitForTimeout(500);

  console.log("Settings applied. Starting batch...");
  
  // 4. Click start (force just in case)
  await page.locator('#btnStart').click({ force: true });

  console.log("Batch started successfully via CDP.");
  await browser.close();
}

trigger().catch(console.error);
