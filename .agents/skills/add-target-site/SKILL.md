---
name: add-target-site
description: Provides the strict architectural checklist and template for integrating a new credential target site into the engine. Activate this skill when the user asks you to "add a new site", "integrate a new casino", or "build a new login flow".
---

# Target Site Integration Guide

When adding a new target site to the automation engine, you **MUST** follow these strict rules to ensure WAF compliance and integration with the fast-loop persistence model.

## 1. Directory Structure
All targets live in `src/targets/`.
If you are adding a site named `mycasino`, create `src/targets/mycasino.ts`.

## 2. Mandatory Lifecycle Hooks
Your target file must export a `run` function with this signature:
```typescript
export async function run(page: Page, cred: CredentialRow, contextOptions: RunContextOptions): Promise<void>;
```

## 3. Strict CMP Cascade
You MUST execute the 3-tier CMP cascade *before* doing anything else on the page:
1. Native API (e.g. `CookieInformation.submitAllCategories()`)
2. Fallback Click (`page.locator('button:has-text("ACCEPT")').click()`)
3. CSS Hide (overlay `.style.setProperty('display', 'none', 'important')`)

## 4. Early Remember Me
You MUST attempt to click the "Remember Me" and "Show Password" icons as soon as they appear in the DOM.

## 5. Input Emulation
- Primary Credentials: Use native `page.fill()` (this bypasses React input lag).
- DO NOT use `page.type()` or raw human emulation for the main username/password.

## 6. Success/Failure Classification
You must throw the exact strings expected by the Payload Classification Gate (see Rule 6: Pipeline Protocol):
- Throw `new Error("Success - Welcome!")` only if you confirm DOM success.
- Throw `new Error("incorrect")` for standard failures.
- Throw `new Error("temporarily disabled")` or `new Error("permanently disabled")` for bans.
