# 🔒 GOLDEN TEMPLATE: Stealth/Camoufox Backend Automation Flow

> **STATUS: FROZEN — DO NOT MODIFY WITHOUT EXPLICIT USER APPROVAL**
>
> This file is the **immutable reference implementation** for all backend automation flows.
> It was locked after achieving **4/4 backend success on attempt 1** in the golden tile test.
> Every backend (cloak, spider-local, zendriver, stealth) MUST follow this exact pattern.

---

## 1. Session Lifecycle (stealth.ts)

The stealth backend is the **canonical reference** for session creation. All backends must implement these phases in order:

### Phase A: Identity Isolation
```
1. Generate unique fingerprint seed per session
2. Check misdirection denylist (reject burned fingerprints)
3. Enrich profiles: UA, hardware, noise, fonts, extensions, cache, interaction
4. Align geo to proxy (locale + timezone must match proxy's geo)
```

### Phase B: Network Routing
```
1. Load spider settings for protocol override
2. Start proxy forwarder (TCP tunnel for SOCKS5 auth)
3. Stealth bypasses httpCloak (Camoufox has native Firefox TLS)
4. Chromium backends use httpCloak for TLS masking
```

### Phase C: Browser Launch
```
1. Cold-start a NEW browser every session (strict identity isolation)
2. Configure headless/headed mode based on opts
3. Set viewport from grid bounds (headed) or realistic dims (headless)
4. Race launch against 45s timeout (kill zombie if timeout wins)
```

### Phase D: Context & Page Setup
```
1. Reuse existing default context if available
2. Reuse existing default page if available
3. Verify page is functional (document.readyState check)
4. Enforce window bounds via browser-tiler
5. Optional: enable tracing for recordings
6. Set CDP network latency emulation (10-30ms)
```

---

## 2. Login Flow (The Automation Gate — §6)

This is the **exact sequence** that achieved 4/4 success. DO NOT reorder, skip, or modify.

### Step 1: Navigation with Retry
```typescript
for (const url of [PRIMARY_URL, FALLBACK_1, FALLBACK_2]) {
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    break;
  } catch { /* try next */ }
}
```

### Step 2: DOM Settle Wait
```typescript
await new Promise(r => setTimeout(r, 3000));
```

### Step 3: Cascade CMP Dismissal (CRITICAL — MANDATORY FOR ALL BACKENDS)

This step was **proven critical** — stealth failed 100% without it. Cookie banners steal focus and intercept Enter keypresses.

```typescript
// Tier 1: Native JavaScript API
await page.evaluate(() => {
  try { (window as any).CookieInformation?.submitAllCategories?.(); } catch {}
}).catch(() => {});

// Tier 2: UI Click Fallback — try known selectors
for (const sel of [
  '.coi-banner__accept',
  '[data-coi-btn="accept"]',
  'button:has-text("ACCEPT ALL")',
  'button:has-text("Accept All")'
]) {
  try {
    const btn = page.locator(sel).first();
    if (await btn.isVisible({ timeout: 500 }).catch(() => false)) {
      await btn.click({ timeout: 2000 });
      break;
    }
  } catch {}
}

// Tier 3: CSS Hide Fallback
await page.evaluate(() => {
  for (const el of document.querySelectorAll(
    '.coi-banner, .coi-consent-banner, [id*="cookie"], [class*="cookie-banner"]'
  )) {
    (el as HTMLElement).style.setProperty('display', 'none', 'important');
  }
}).catch(() => {});

await new Promise(r => setTimeout(r, 500));
```

### Step 4: Credential Entry (Autofill Replica)
```typescript
const emailInput = page.locator('input[type="email"], input[name*="email"], input#email, #username').first();
await emailInput.waitFor({ state: "visible", timeout: 30000 });
await emailInput.fill(email);

const passInput = page.locator('input[type="password"], input[name*="pass"], input#password').first();
await passInput.waitFor({ state: "visible", timeout: 10000 });
await passInput.fill(password);
```

### Step 5: Re-focus Password Field
```typescript
// Ensures Enter targets the login form, not a stale banner
await passInput.click().catch(() => {});
await new Promise(r => setTimeout(r, 200));
```

### Step 6: Submit via Enter Key
```typescript
// Rule: DO NOT click Submit button. Always use Enter key.
await page.keyboard.press("Enter");
```

### Step 7: Success Detection (No Observation Window)

```typescript
// "welcome!" is the ONLY success signal.
// Case-insensitive. Exclamation mark REQUIRED.
// "Welcome" without "!" is NEVER success.
// Use: /welcome!/i
const hasSuccess = /welcome!/i.test(bodyText);
```

**Decision is INSTANT:** Once the DOM settles on either the cashier page or bounces back to login, the decision is made **without further delay**. No 30-second observation window. No arbitrary sleep after success detection.

---

## 3. Session Teardown

```
1. Release headed slot (if applicable)
2. Save tracing/recording (if enabled)
3. Graceful browser.close() bounded by 3000ms timeout
4. OS-level SIGKILL/taskkill as final guarantee
5. Close proxy forwarder
6. Log: "Session entirely eradicated from memory."
```

---

## 4. Rules That Apply to ALL Backends

| Rule | Description |
|------|-------------|
| **No JS Runtime Overrides on Camoufox** | Fingerprinting is native C++ level. No puppeteer-extra-plugin-stealth. |
| **Chromium backends use Apify injectors** | Use fingerprint-injector + httpCloak for TLS masking |
| **Enter, not Submit** | Always `keyboard.press("Enter")`, never click the Submit button |
| **CMP Dismissal is MANDATORY** | 3-tier cascade before every credential fill |
| **welcome! with !** | Only `/welcome!/i` is success. `welcome` alone is NEVER success |
| **No Observation Window** | DOM settles → decision instant → exit |
| **Cold Start Per Session** | New browser instance every time. No warm pools. |
| **Geo Alignment** | Locale + timezone MUST match proxy geo |
| **Zombie Sweep** | user-data-dirs in tracked folders. Kill orphans on teardown. |

---

## 5. File References

- **Stealth Backend**: `backends/stealth.ts` — the canonical session lifecycle
- **Login Flow**: `src/targets/login-flow.ts` — shared login orchestration
- **Golden Tile Test**: `tests/live/golden-tile-test.ts` — the test that validated this template
- **Project Rules**: `.agents/AGENTS.md` — immutable project rules
- **Automation Rules**: `.agents/automation.md` — detailed automation directives
