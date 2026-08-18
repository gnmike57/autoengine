const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.on('console', msg => console.log('PAGE LOG:', msg.text()));
  page.on('pageerror', err => console.log('PAGE ERROR:', err.message));
  
  await page.goto('http://127.0.0.1:3011', { waitUntil: 'domcontentloaded' });
  
  // Wait for the Dashboard nav tab to be visible
  await page.waitForSelector('.nav-tab:has-text("Dashboard")');
  
  // Click the Dashboard tab
  console.log("Clicking Dashboard tab...");
  await page.click('.nav-tab:has-text("Dashboard")');
  
  // Wait a moment and check if #tab-dashboard has class 'active'
  await page.waitForTimeout(1000);
  
  const isDashboardActive = await page.evaluate(() => {
    return document.getElementById('tab-dashboard').classList.contains('active');
  });
  console.log("Is Dashboard active?", isDashboardActive);
  
  // Also check what is currently active
  const activeTabs = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('.view.active')).map(v => v.id);
  });
  await page.waitForTimeout(500);
  console.log("Clicking Credentials tab...");
  await page.click('.nav-tab:has-text("Credentials")');
  await page.waitForTimeout(1000);
  
  const isCredentialsActive = await page.evaluate(() => {
    return document.getElementById('tab-credentials').classList.contains('active');
  });
  console.log("Is Credentials active?", isCredentialsActive);
  
  const activeTabsAfter = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('.view.active')).map(v => v.id);
  });
  console.log("Currently active views:", activeTabsAfter);
  
  await browser.close();
})();
