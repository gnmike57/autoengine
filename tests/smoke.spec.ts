import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const dashboardHtml = readFileSync(
  resolve(__dirname, "..", "public", "index.html"),
  "utf8",
);

test.describe("smoke", () => {
  test("renders the page title", async ({ page }) => {
    await page.setContent(dashboardHtml, { waitUntil: "domcontentloaded" });
    await expect(page).toHaveTitle(/Command Centre/i);
  });
});
