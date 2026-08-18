import { chromium } from 'playwright';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  
  try {
    console.log("Navigating to dashboard...");
    await page.goto('http://127.0.0.1:3011', { waitUntil: 'networkidle' });
    
    console.log("Switching to settings tab...");
    await page.evaluate(() => { if (typeof window.switchTab === 'function') window.switchTab('settings'); });
    await page.waitForTimeout(1000);
    
    console.log("Applying backend settings...");
    // Backend: stealth-headed
    await page.selectOption('#backendSelect', 'stealth-headed');
    
    // Concurrency: 4
    await page.fill('#advConcurrency', '4');
    await page.dispatchEvent('#advConcurrency', 'change');
    
    // Record Video: OFF
    const isRecordOn = await page.$eval('#advRecordVideo', el => el.checked);
    if (isRecordOn) {
      await page.click('label[for="advRecordVideo"] .cyber-slider', { force: true }).catch(() => page.click('#advRecordVideo', { force: true }));
    }
    
    // Auto Optimize: ON
    const isAutoOn = await page.$eval('#advAutoOptimize', el => el.checked);
    if (!isAutoOn) {
      await page.click('label[for="advAutoOptimize"] .cyber-slider', { force: true }).catch(() => page.click('#advAutoOptimize', { force: true }));
    }
    
    await page.waitForTimeout(1000);
    
    console.log("Clicking LAUNCH...");
    await page.click('#btnStart');
    
    console.log("Batch initiated successfully.");
    await page.waitForTimeout(2000); // give it time to register
  } catch (err) {
    console.error("Error during automation:", err);
  } finally {
    await browser.close();
  }
})();
