import { chromium } from 'playwright-core';
async function run() {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9224');
  const context = browser.contexts()[0];
  if (!context) { console.log("No context"); process.exit(1); }
  const page = context.pages().find(p => p.url().match(/127\.0\.0\.1:\d+/));
  if (!page) { console.log("No page"); process.exit(1); }
  
  const res = await page.evaluate(() => {
    return typeof (window as any).credBulkSelectAll;
  });
  console.log("credBulkSelectAll type:", res);
  
  await browser.close();
}
run();
