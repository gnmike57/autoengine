import { chromium } from 'playwright';

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();
  
  try {
    console.log("Navigating to http://127.0.0.1:3011...");
    await page.goto('http://127.0.0.1:3011', { waitUntil: 'networkidle' });
    
    // Switch to settings tab
    await page.evaluate(() => {
      if (typeof window.switchTab === 'function') {
        window.switchTab('settings');
      }
    });
    
    // Wait for the UI to populate with the websocket init data
    await page.waitForTimeout(3000);
    
    // Source 2: Verify DOM Elements directly
    const proxyOptionsHTML = await page.$eval('#advProxyPool', el => el.innerHTML);
    console.log("DOM VERIFICATION (Proxy Pool HTML):", proxyOptionsHTML.trim());
    
    const recordVideoChecked = await page.$eval('#advRecordVideo', el => el.checked);
    console.log("DOM VERIFICATION (Record Video):", recordVideoChecked);

    const tracingChecked = await page.$eval('#advEnableTracing', el => el.checked);
    console.log("DOM VERIFICATION (Enable Tracing):", tracingChecked);

    // Source 1: Visual Screenshot
    const outputPath = '/Users/user294545/.gemini/antigravity/brain/088c5fad-06c5-4dcd-b91f-8dafdae80402/dashboard_settings_verify.png';
    const settingsPanel = page.locator('#tab-settings');
    await settingsPanel.screenshot({ path: outputPath });
    
    console.log("Screenshot successfully saved to: " + outputPath);
  } catch (err) {
    console.error("Error taking screenshot:", err);
  } finally {
    await browser.close();
  }
})();
