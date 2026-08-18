import { chromium } from 'playwright';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  
  try {
    console.log("Navigating to dashboard...");
    await page.goto('http://127.0.0.1:3011', { waitUntil: 'domcontentloaded' });
    
    console.log("Applying backend settings via JS evaluation...");
    await page.evaluate(() => {
        // Switch to settings
        if (typeof window.switchTab === 'function') window.switchTab('settings');
        
        // Backend: stealth-headed
        const backendSel = document.getElementById('backendSelect');
        if (backendSel) {
            backendSel.value = 'stealth-headed';
            backendSel.dispatchEvent(new Event('change'));
        }
        
        // Concurrency: 4
        const concInp = document.getElementById('advConcurrency');
        if (concInp) {
            concInp.value = '4';
            concInp.dispatchEvent(new Event('change'));
        }
        
        // Record Video: OFF
        const recVid = document.getElementById('advRecordVideo');
        if (recVid && recVid.checked) {
            recVid.checked = false;
            recVid.dispatchEvent(new Event('change'));
        }
        
        // Auto Optimize: ON
        const autoOpt = document.getElementById('advAutoOptimize');
        if (autoOpt && !autoOpt.checked) {
            autoOpt.checked = true;
            autoOpt.dispatchEvent(new Event('change'));
        }
    });
    
    await page.waitForTimeout(1500);
    
    console.log("Clicking LAUNCH...");
    await page.evaluate(() => {
        const btn = document.getElementById('btnStart');
        if (btn && !btn.disabled) {
            btn.click();
        } else {
            console.log("Start button is disabled or not found.");
        }
    });
    
    console.log("Batch initiated successfully.");
    await page.waitForTimeout(3000); // give it time to register the launch and websocket messages
  } catch (err) {
    console.error("Error during automation:", err);
  } finally {
    await browser.close();
  }
})();
