import { chromium } from 'playwright';

const tabs = ['liveview', 'dashboard', 'credentials', 'results', 'settings', 'terminal', 'analytics', 'tempdisabled', 'hermes'];

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();
  
  try {
    console.log("Navigating to http://127.0.0.1:3011...");
    await page.goto('http://127.0.0.1:3011', { waitUntil: 'networkidle' });
    await page.waitForTimeout(2000);
    
    for (const tab of tabs) {
      console.log(`Switching to ${tab}...`);
      await page.evaluate((tabName) => {
        if (typeof window.switchTab === 'function') {
          window.switchTab(tabName);
        }
      }, tab);
      
      await page.waitForTimeout(1000);
      const outputPath = `/Users/user294545/.gemini/antigravity/brain/088c5fad-06c5-4dcd-b91f-8dafdae80402/tab_${tab}.png`;
      await page.screenshot({ path: outputPath });
      console.log(`Saved screenshot for ${tab}`);
    }
  } catch (err) {
    console.error("Error:", err);
  } finally {
    await browser.close();
  }
})();
