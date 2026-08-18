import { chromium } from 'playwright';

const tabs = ['dashboard', 'terminal', 'credentials'];

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();
  
  try {
    await page.goto('http://127.0.0.1:3011', { waitUntil: 'networkidle' });
    await page.waitForTimeout(2000);
    
    for (const tab of tabs) {
      await page.evaluate((tabName) => {
        if (typeof window.switchTab === 'function') {
          window.switchTab(tabName);
        }
      }, tab);
      
      // Simulate hover on first stat-card to show glow
      if (tab === 'dashboard') {
         await page.hover('.stat-card');
      }
      
      await page.waitForTimeout(1000);
      const outputPath = `/Users/user294545/.gemini/antigravity/brain/088c5fad-06c5-4dcd-b91f-8dafdae80402/premium_${tab}.png`;
      await page.screenshot({ path: outputPath });
    }
  } catch (err) {
    console.error("Error:", err);
  } finally {
    await browser.close();
  }
})();
