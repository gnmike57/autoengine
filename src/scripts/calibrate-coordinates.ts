import { chromium, type Page } from "playwright-core";
import { saveCoordinateMap, type SiteCoordinateMap } from "../intelligence/coordinate-mapper.js";
import "dotenv/config";

const TARGET_URLS = {
  joe: "https://www.joefortune.zone/login",
  ignition: "https://www.ignitioncasino.ooo/login",
};

async function getCenterPercentage(page: Page, selector: string): Promise<{ vw: number; vh: number } | null> {
  try {
    const loc = page.locator(selector).first();
    await loc.waitFor({ state: "visible", timeout: 10000 });
    const box = await loc.boundingBox();
    const vp = page.viewportSize();
    if (!box || !vp) return null;

    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;

    return {
      vw: cx / vp.width,
      vh: cy / vp.height,
    };
  } catch (err) {
    console.error(`Failed to get coordinates for selector: ${selector}`, err);
    return null;
  }
}

async function runCalibration(siteName: "joe" | "ignition") {
  console.log(`Starting calibration for ${siteName}...`);
  const browser = await chromium.launch({ headless: false }); // Need headed to accurately measure viewport rendering
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();

  await page.goto(TARGET_URLS[siteName], { waitUntil: "domcontentloaded" });
  console.log(`Waiting for page to render (using deterministic locators)...`);

  const map: SiteCoordinateMap = {};

  const emailSel = 'input[type="email"], input[name*="email"], input#email, #username';
  const passSel = 'input[type="password"], input[name*="pass"], input#password';
  const submitSel = 'button[type="submit"], button:has-text("Login"), button:has-text("Log In"), button:has-text("Sign In"), .login-btn';
  const acceptSel = '.coi-banner__accept, [data-coi-btn="accept"], button:has-text("ACCEPT ALL")';
  const rememberSel = 'input[type="checkbox"][id*="remember"], input[type="checkbox"][name*="remember"]';

  const emailCoord = await getCenterPercentage(page, emailSel);
  if (emailCoord) map.emailInput = emailCoord;

  const passCoord = await getCenterPercentage(page, passSel);
  if (passCoord) map.passwordInput = passCoord;

  const submitCoord = await getCenterPercentage(page, submitSel);
  if (submitCoord) map.submitButton = submitCoord;

  // Try to click banners for remember me
  const acceptBtn = page.locator(acceptSel).first();
  if (await acceptBtn.isVisible().catch(() => false)) {
    map.cookieBannerAccept = await getCenterPercentage(page, acceptSel) || undefined;
    await acceptBtn.click().catch(() => {});
  }

  const rememberCoord = await getCenterPercentage(page, rememberSel);
  if (rememberCoord) map.rememberMeCheckbox = rememberCoord;

  saveCoordinateMap(siteName, map);

  console.log(`Calibration complete for ${siteName}. Map saved.`);
  console.dir(map, { depth: null });

  await browser.close();
}

async function main() {
  await runCalibration("joe");
  await runCalibration("ignition");
  console.log("All calibrations complete.");
}

main().catch(console.error);
