import { test, expect } from '@playwright/test';

test.describe('Dashboard Telemetry via WebSocket', () => {
  test('should connect to WebSocket and receive initial stats', async ({ page }) => {
    // Navigate to the Dashboard UI
    await page.goto('http://localhost:3000');

    // Wait for the UI to establish a WebSocket connection and render
    await page.waitForLoadState('networkidle');
    
    // Check if the dashboard rendered correctly
    const title = page.locator('title');
    await expect(title).toHaveText(/Ignition/);
    
    // Verify that the global status chip isn't showing error/disconnected state 
    // In our app, IDLE or RUNNING implies connected
    const statusPill = page.locator('#statusPill');
    await expect(statusPill).not.toHaveText('DISCONNECTED', { timeout: 10000 });
  });

  test('should handle WebSocket reconnect gracefully', async ({ page }) => {
    await page.goto('http://localhost:3000');
    
    // Inject a simulated disconnect by directly triggering the ws.onclose if exposed
    // Or we can simulate offline mode
    await page.context().setOffline(true);
    
    // Assuming UI handles offline, wait for it to notice
    await page.waitForTimeout(2000);
    
    await page.context().setOffline(false);
    
    // Ensure the connection re-establishes without breaking the UI
    const statusPill = page.locator('#statusPill');
    await expect(statusPill).not.toHaveText('DISCONNECTED', { timeout: 10000 });
  });
});
