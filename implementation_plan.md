# Goal: Analyze and Eradicate Brittle Code Patterns

Following an extensive system audit (`npm run audit:all`) and manual codebase review against the Project Rules, I have identified several latent forms of "brittle code" that will cause failures on modern, highly-encapsulated target sites.

## User Review Required

> [!WARNING]  
> **Global Shadow DOM Piercing Enforcement**  
> We are replacing standard `document.body.innerText` checks with a deep `TreeWalker` recursive text extractor to guarantee error messages inside Web Components are not missed. This will slightly increase evaluation execution time by ~10-20ms per check. 
> Please confirm if this performance trade-off is acceptable for the classification resilience gained.

## Open Questions

> [!NOTE]  
> **Hardcoded Sleeps in Utilities**  
> I noticed `page.waitForTimeout` is still used in utility/test scripts like `record-baseline.ts`, `codegen-exporter.ts`, and various `scratch/` files. Should I aggressively strip them from these secondary files as well and replace them with event-driven logic, or should we only focus the purge strictly on the core automation engine lifecycle (`src/targets/*`, `src/core/*`, `src/stealth/*`)?

## Proposed Changes

---

### Shadow DOM Text Extraction

Currently, `login-flow.ts`, `submit-tracker.ts`, and `dom-classifier.ts` rely heavily on `document.body.textContent` or `document.body.innerText` to extract page text for `incorrect`, `TEMP_DISABLED`, and `PERM_DISABLED` classification. This is **brittle** and completely blind to text rendered inside Web Components (`#shadow-root`).

#### [NEW] [shadow-piercer.ts](file:///Volumes/Macintosh_HD/Users/user294545/Downloads/autojoe/automation-engine-main/src/utils/shadow-piercer.ts)
Create a centralized utility that injects a client-side recursive `TreeWalker` that walks all nodes, specifically piercing `.shadowRoot` properties to accumulate a unified plaintext string of the entire rendered DOM structure, modal-agnostic.

#### [MODIFY] [login-flow.ts](file:///Volumes/Macintosh_HD/Users/user294545/Downloads/autojoe/automation-engine-main/src/targets/login-flow.ts)
- Replace all instances of `(document.body.textContent || "").toLowerCase()` with calls to the new shadow-piercing text extractor.
- Apply to both the pre-submit and post-submit mutation evaluation loops.

#### [MODIFY] [submit-tracker.ts](file:///Volumes/Macintosh_HD/Users/user294545/Downloads/autojoe/automation-engine-main/src/guards/submit-tracker.ts)
- Update error text extraction (`document.body.textContent`) to use the resilient shadow piercer.

#### [MODIFY] [dom-classifier.ts](file:///Volumes/Macintosh_HD/Users/user294545/Downloads/autojoe/automation-engine-main/src/intelligence/dom-classifier.ts)
- Update `bodyText` variable population to use the deep piercer.

---

### Brittle Playwright Locators

The engine sometimes uses raw `page.locator(selector)` without guaranteeing the selector traverses shadow boundaries. Rule 3 and the `shadow-dom-piercing` skill mandate resilience here.

#### [MODIFY] [cookie-guard.ts](file:///Volumes/Macintosh_HD/Users/user294545/Downloads/autojoe/automation-engine-main/src/guards/cookie-guard.ts)
- Pre-pend `pierce/` to Playwright CSS locators when searching for CMP buttons (`.coi-banner__accept`, etc.) to natively bypass shadow roots if the CMP uses a Web Component.

#### [MODIFY] [login-step-variants.ts](file:///Volumes/Macintosh_HD/Users/user294545/Downloads/autojoe/automation-engine-main/src/targets/login-step-variants.ts)
- Adjust `visible(page.locator(selectors.username), 2500)` checks to ensure they pierce the shadow DOM, likely by utilizing `evaluateHandle` with our custom `findElementDeep` logic instead of trusting the standard locator visibility checks on modern nested sites.

---

### Enforce 30-Second Deadlock Watchdogs

Rule 2 explicitly demands that every background async task must be wrapped in a 30-second mutation watchdog to prevent deadlocks.

#### [MODIFY] [engine.ts](file:///Volumes/Macintosh_HD/Users/user294545/Downloads/autojoe/automation-engine-main/src/core/engine.ts)
- Audit async loops (e.g. waiting for elements or waiting for specific state transitions).
- Wrap them in `Promise.race([ task, new Promise((_, r) => setTimeout(() => r(new Error('watchdog-timeout')), 30000)) ])`.
- Enforce the instant force-close teardown on watchdog failure.

## Verification Plan

### Automated Tests
- Run `npm run typecheck` to ensure type safety.
- Run `npm run audit:all` to ensure no invariants were accidentally broken during refactoring.
- Run `npx vitest run` to ensure unit tests covering locators and timeouts still pass.

### Manual Verification
- Deploy to a test target and confirm that error classification still successfully captures the text and classifies it as `INCONCLUSIVE` or `NO_ACCOUNT_CONFIRMED` correctly without hanging.
