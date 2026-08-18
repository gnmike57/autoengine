import { test, expect } from '@playwright/test';
import { createSession } from '../../backends/index.js';

test.describe('Visual Regression Baseline - Login Modals', () => {
  test.setTimeout(120000);

  test('Joe Fortune Login Modal Baseline', async () => {
    const session = await createSession({ backend: 'cloak-headless', headless: true, cleanSession: true });
    try {
      const page = session.page;
      
      // Retry block for transient navigation failures
      let navSuccess = false;
      for (let i = 0; i < 2; i++) {
        try {
          await page.goto('https://www.joefortune.zone', { waitUntil: 'domcontentloaded', timeout: 30000 });
          navSuccess = true;
          break;
        } catch {
          console.warn(`[visual] Navigation failed (attempt ${i + 1}/2) - retrying...`);
        }
      }
      expect(navSuccess).toBe(true);

      const loginBtn = page.locator('header').locator('text="Login"').first();
      
      // Wait for login button if it's there (avoid immediate check before DOM is fully settled)
      try {
        await loginBtn.waitFor({ state: 'visible', timeout: 15000 });
        await loginBtn.click();
      } catch {
        // Modal might already be open or button is missing
      }

      const loginForm = page.locator('form').filter({ has: page.locator('input[type="password"]') }).first();
      // Ensure the modal has actually loaded completely
      await loginForm.waitFor({ state: 'visible', timeout: 20000 });
      await expect(loginForm).toBeVisible();

      await expect(loginForm).toHaveScreenshot('joe-fortune-login-modal.png', {
        maxDiffPixelRatio: 0.05
      });
    } finally {
      await session.close();
    }
  });

  test('Ignition Casino Login Modal Baseline', async () => {
    const session = await createSession({ backend: 'cloak-headless', headless: true, cleanSession: true });
    try {
      const page = session.page;
      
      let navSuccess = false;
      for (let i = 0; i < 2; i++) {
        try {
          await page.goto('https://www.ignitioncasino.eu', { waitUntil: 'domcontentloaded', timeout: 30000 });
          navSuccess = true;
          break;
        } catch {
          console.warn(`[visual] Navigation failed (attempt ${i + 1}/2) - retrying...`);
        }
      }
      expect(navSuccess).toBe(true);

      const loginBtn = page.locator('header').locator('text="Login"').first();
      try {
        await loginBtn.waitFor({ state: 'visible', timeout: 15000 });
        await loginBtn.click();
      } catch {
        // Modal might already be open or button is missing
      }

      const loginForm = page.locator('form').filter({ has: page.locator('input[type="password"]') }).first();
      await loginForm.waitFor({ state: 'visible', timeout: 20000 });
      await expect(loginForm).toBeVisible();

      await expect(loginForm).toHaveScreenshot('ignition-login-modal.png', {
        maxDiffPixelRatio: 0.05
      });
    } finally {
      await session.close();
    }
  });
});
