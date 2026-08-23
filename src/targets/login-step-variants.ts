import crypto from "node:crypto";
import type { Locator, Page } from "playwright-core";

export type LoginDiscoveryVariant =
  | "configured_css"
  | "role_label_discovery"
  | "aria_snapshot_discovery";

export type LoginEntryVariant = "input_text" | "press_sequentially_entry";

export type LoginAcceptanceVariant = "current_tracker" | "request_response_dom_acceptance";

export interface LoginSelectors {
  username: string;
  password: string;
  submit: string;
}

export interface SelectorDiscoveryProvenance {
  variant: LoginDiscoveryVariant;
  usernameSource: string;
  passwordSource: string;
  submitSource: string;
  ariaSnapshot?: string;
  ariaSnapshotSha256?: string;
  durationMs: number;
}

export interface ResolvedLoginSelectors extends LoginSelectors {
  provenance: SelectorDiscoveryProvenance;
}

async function visible(locator: Locator, timeout = 800): Promise<boolean> {
  return locator.first().isVisible({ timeout }).catch(() => false);
}

async function materializeLocator(
  locator: Locator,
  marker: string,
): Promise<string | null> {
  const candidate = locator.first();
  if (!(await visible(candidate))) return null;
  await candidate.evaluate((element, value) => {
    element.setAttribute("data-automati-discovery", value);
  }, marker);
  return `[data-automati-discovery="${marker}"]`;
}

async function isSelectorVisible(page: Page, sel: string, timeout = 2500): Promise<boolean> {
  if (await visible(page.locator(sel), timeout)) return true;
  if (!sel.startsWith('pierce/') && !sel.startsWith('xpath=') && !sel.startsWith('text=')) {
    return visible(page.locator(`pierce/${sel}`), timeout);
  }
  return false;
}

async function configuredSelectorsVisible(page: Page, selectors: LoginSelectors): Promise<boolean> {
  const [username, password, submit] = await Promise.all([
    isSelectorVisible(page, selectors.username, 2500),
    isSelectorVisible(page, selectors.password, 2500),
    isSelectorVisible(page, selectors.submit, 2500),
  ]);
  return username && password && submit;
}

async function findFirstVisible(page: Page, candidates: readonly string[]): Promise<string | null> {
  for (const selector of candidates) {
    if (await isSelectorVisible(page, selector, 1000)) return selector;
  }
  return null;
}

async function resolveCssFallback(page: Page, configured: LoginSelectors): Promise<ResolvedLoginSelectors> {
  const startedAt = Date.now();
  if (await configuredSelectorsVisible(page, configured)) {
    return {
      ...configured,
      provenance: {
        variant: "configured_css",
        usernameSource: "configured-css",
        passwordSource: "configured-css",
        submitSource: "configured-css",
        durationMs: Date.now() - startedAt,
      },
    };
  }

  const username = await findFirstVisible(page, [
    'input[type="email"]', 'input[name="email"]', 'input[name="username"]',
    'input[autocomplete="email"]', 'input[autocomplete="username"]',
    'input[placeholder*="mail" i]', 'input[placeholder*="user" i]', 'input[type="text"]',
  ]);
  const password = await findFirstVisible(page, ['input[type="password"]', 'input[name="password"]']);
  const submit = await findFirstVisible(page, [
    'button[type="submit"]', 'input[type="submit"]',
    'button:has-text("Log In")', 'button:has-text("Login")',
    'button:has-text("Sign In")', 'button:has-text("Continue")',
  ]);
  if (!username || !password || !submit) {
    throw new Error(`configured/CSS discovery failed: username=${Boolean(username)} password=${Boolean(password)} submit=${Boolean(submit)}`);
  }
  return {
    username,
    password,
    submit,
    provenance: {
      variant: "configured_css",
      usernameSource: username === configured.username ? "configured-css" : "css-fallback",
      passwordSource: password === configured.password ? "configured-css" : "css-fallback",
      submitSource: submit === configured.submit ? "configured-css" : "css-fallback",
      durationMs: Date.now() - startedAt,
    },
  };
}

async function resolveRoleLabel(page: Page, configured: LoginSelectors): Promise<ResolvedLoginSelectors> {
  const startedAt = Date.now();
  const username = await materializeLocator(
    page.getByRole("textbox", { name: /e-?mail|email|user(?:name| name| id)|login/i }),
    "role-label-username",
  ) ?? await materializeLocator(
    page.getByLabel(/e-?mail|email|user(?:name| name| id)|login/i),
    "role-label-username",
  );
  const password = await materializeLocator(
    page.getByLabel(/password|passcode|pin/i),
    "role-label-password",
  ) ?? await materializeLocator(
    page.locator('input[type="password"]'),
    "role-label-password",
  );
  const submit = await materializeLocator(
    page.getByRole("button", { name: /log[ -]?in|sign[ -]?in|submit|continue/i }),
    "role-label-submit",
  ) ?? await materializeLocator(
    page.locator('input[type="submit"]'),
    "role-label-submit",
  );

  if (!username || !password || !submit) {
    const fallback = await resolveCssFallback(page, configured);
    return {
      ...fallback,
      provenance: {
        ...fallback.provenance,
        variant: "role_label_discovery",
        usernameSource: username ? "role-or-label" : `fallback:${fallback.provenance.usernameSource}`,
        passwordSource: password ? "role-or-label" : `fallback:${fallback.provenance.passwordSource}`,
        submitSource: submit ? "role-or-label" : `fallback:${fallback.provenance.submitSource}`,
        durationMs: Date.now() - startedAt,
      },
    };
  }

  return {
    username,
    password,
    submit,
    provenance: {
      variant: "role_label_discovery",
      usernameSource: "role-or-label",
      passwordSource: "role-or-label",
      submitSource: "role-or-label",
      durationMs: Date.now() - startedAt,
    },
  };
}

async function captureAriaSnapshot(page: Page): Promise<{ snapshot?: string; sha256?: string }> {
  try {
    const snapshot = (await page.locator("body").ariaSnapshot({ timeout: 3000 })).slice(0, 100_000);
    return {
      snapshot,
      sha256: crypto.createHash("sha256").update(snapshot).digest("hex"),
    };
  } catch {
    return {};
  }
}

export async function resolveLoginSelectors(
  page: Page,
  configured: LoginSelectors,
  variant: LoginDiscoveryVariant = "configured_css",
): Promise<ResolvedLoginSelectors> {
  if (variant === "configured_css") return resolveCssFallback(page, configured);
  if (variant === "role_label_discovery") return resolveRoleLabel(page, configured);

  const startedAt = Date.now();
  const aria = await captureAriaSnapshot(page);
  const resolved = await resolveRoleLabel(page, configured);
  return {
    ...resolved,
    provenance: {
      ...resolved.provenance,
      variant: "aria_snapshot_discovery",
      ariaSnapshot: aria.snapshot,
      ariaSnapshotSha256: aria.sha256,
      durationMs: Date.now() - startedAt,
    },
  };
}

export async function enterTextWithVariant(
  page: Page,
  selector: string,
  value: string,
  variant: LoginEntryVariant,
  fallback?: (page: Page, selector: string, value: string) => Promise<boolean>,
  delayMs = 20,
): Promise<boolean> {
  const tryFill = async (sel: string): Promise<boolean> => {
    try {
      const locator = page.locator(sel).first();
      if (await locator.isVisible({ timeout: 2000 }).catch(() => false)) {
        await locator.click({ force: true }).catch(() => {});
        await locator.fill(value);
        const val = await locator.inputValue().catch(() => "");
        return val === value;
      }
      return false;
    } catch (err) {
      console.warn(`[enterTextWithVariant] tryFill failed for "${sel}": ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  };

  if (typeof fallback === "function" && variant === "input_text") {
    const ok = await fallback(page, selector, value);
    if (ok) return true;
  }

  if (await tryFill(selector)) return true;

  // Fallback to type-based candidates
  const isPassword = selector.toLowerCase().includes("password");
  const candidates = isPassword
    ? ['input[type="password"]', 'input[name*="password" i]', '#password']
    : ['input[type="email"]', 'input[name*="email" i]', 'input[name*="user" i]', '#email', '#username', 'input[type="text"]'];

  for (const candidate of candidates) {
    if (candidate === selector) continue;
    if (await tryFill(candidate)) return true;
  }

  return false;
}
