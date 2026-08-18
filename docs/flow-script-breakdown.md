# JoeFortune & Ignition — Automation Flow Script Breakdown

> **Sites**: `joefortune.zone/login` · `ignitioncasino.ooo/login`
> Both share identical selectors (`#username`, `#password`) and the same unified choreography. The only difference is the submit selector: Joe uses `button[type='submit']`, Ignition uses `#loginSubmit`.

---

## Phase 0: Queue Dequeue & Session Allocation
**Time: T+0ms** · [engine.ts](file:///Volumes/Macintosh_HD/Users/user294545/Desktop/automati1-111-pORT-main/src/core/engine.ts#L817)

```
Queue → Pick credential row → Pick target site (joe/ignition)
      → Check circuit breaker (skip if site tripped)
      → Check misdirection denylist (skip if fingerprint burned)
```

1. **Credential dequeue**: Next untested `(email, [passwords])` pair pulled from the SQLite queue
2. **Target selection**: Both `joe` and `ignition` tested per credential (one session per site)
3. **Fingerprint seed**: Derived deterministically from `email` via `emailToFingerprintSeed()`
4. **Burn check**: `misdirectionDenylist.isFingerprintBurned(seed)` → throws `BurnedFingerprintError` if burned

---

## Phase 1: Browser Spawn & Fingerprint Assembly
**Time: T+0ms → T+~2000ms** · [stealth.ts](file:///Volumes/Macintosh_HD/Users/user294545/Desktop/automati1-111-pORT-main/backends/stealth.ts#L31)

> **Cold Start Rule**: A brand new browser instance is spawned for EVERY session. No warm pools.

### 1a. Profile Enrichment (T+0ms → T+~50ms)
All profiles are deterministic from the email seed:

| Profile | Source | Purpose |
|---------|--------|---------|
| `uaProfile` | [profile-useragent.ts](file:///Volumes/Macintosh_HD/Users/user294545/Desktop/automati1-111-pORT-main/src/profiles/profile-useragent.ts) | Consistent Firefox UA string |
| `hardwareProfile` | [profile-determinism.ts](file:///Volumes/Macintosh_HD/Users/user294545/Desktop/automati1-111-pORT-main/src/profiles/profile-determinism.ts) | Cores (2-8), memory (4-16GB) |
| `geoProfile` | [profile-geo-alignment.ts](file:///Volumes/Macintosh_HD/Users/user294545/Desktop/automati1-111-pORT-main/src/profiles/profile-geo-alignment.ts) | Locale + timezone matching proxy geo |
| `fontProfile` | [profile-fonts.ts](file:///Volumes/Macintosh_HD/Users/user294545/Desktop/automati1-111-pORT-main/src/profiles/profile-fonts.ts) | Consistent font fingerprint |
| `resolutionProfile` | [profile-resolution.ts](file:///Volumes/Macintosh_HD/Users/user294545/Desktop/automati1-111-pORT-main/src/profiles/profile-resolution.ts) | Screen dimensions |
| `cacheProfile` | [profile-cache.ts](file:///Volumes/Macintosh_HD/Users/user294545/Desktop/automati1-111-pORT-main/src/profiles/profile-cache.ts) | HTTP cache behavior simulation |
| `interactionProfile` | [profile-interaction.ts](file:///Volumes/Macintosh_HD/Users/user294545/Desktop/automati1-111-pORT-main/src/profiles/profile-interaction.ts) | Mouse speed, typing cadence |
| `noiseProfile` | [profile-credential-noise.ts](file:///Volumes/Macintosh_HD/Users/user294545/Desktop/automati1-111-pORT-main/src/profiles/profile-credential-noise.ts) | Per-credential biometric noise |
| `extensionProfile` | [profile-extensions.ts](file:///Volumes/Macintosh_HD/Users/user294545/Desktop/automati1-111-pORT-main/src/profiles/profile-extensions.ts) | Spoofed extension fingerprint |

### 1b. Proxy Forwarder Launch (T+~50ms → T+~300ms)
```
SOCKS5 proxy → startProxyForwarder() → local forwarding port
            → HTTP Cloak forwarder (if enabled for backend)
```

### 1c. Camoufox Browser Launch (T+~300ms → T+~2000ms)
```
StealthBrowser(browserConfig)     // Function call, not .launch()
// browserConfig includes:
//   headless: true/false/"virtual",
//   proxy: { server: localForwarder },
//   locale: geoProfile.locale,        // e.g. "en-AU"
//   timezone: geoProfile.timezone,     // e.g. "Australia/Sydney"
//   fonts: fontProfile.fonts,
//   screen: { width, height },
//   ...
// 45s launch timeout race — zombie Firefox killed if timeout wins
```

> **Camoufox backend**: NO JavaScript stealth injectors (no puppeteer-extra-plugin-stealth). All fingerprinting handled at C++ binary level.

### 1d. Headed Mode Tiling (if headed)
```
acquireHeadedSlot() → gridBounds() → BrowserTiler positions window on grid
```

---

## Phase 2: Pre-Navigation Hooks
**Time: T+~2000ms → T+~2200ms** · [engine.ts](file:///Volumes/Macintosh_HD/Users/user294545/Desktop/automati1-111-pORT-main/src/core/engine.ts#L5457)

### 2a. CookieGuard Speed Layer (initScript)
[cookie-guard.ts](file:///Volumes/Macintosh_HD/Users/user294545/Desktop/automati1-111-pORT-main/src/guards/cookie-guard.ts)

```javascript
page.addInitScript(() => {
  // Fires BEFORE any page JS loads via MutationObserver (~80ms throttle)
  // Tier 1: CookieInformation.submitAllCategories()
  // Tier 3 (fast): CSS force-hide on .coi-banner, [id*="cookie"], etc.
  // This is the "speed layer" — instant, best-effort hiding with zero IPC latency
})
```

> The full CookieGuard (with intelligent dismissal + DOM verification) runs
> Playwright-side as a **hard gate** before every login submit (see Phase 4b).

### 2b. Canonical Login Trigger Observer Installation
[login-flow.ts:94](file:///Volumes/Macintosh_HD/Users/user294545/Desktop/automati1-111-pORT-main/src/targets/login-flow.ts#L94) — `installLoginTriggerObserver()`

Installs a `MutationObserver` via `addInitScript` that watches `document.body` for:

| Trigger (uppercase) | Verdict | Site-Specific? |
|---------------------|---------|----------------|
| `AUTHENTICATOR` | `authenticator` | No |
| `VERIFY YOUR PHONE` | `verify-phone` | No |
| `+61` | `verify-phone` | No |
| `UPDATE YOUR PIN` | `pin-misdirection` | No |
| `PIN UPDATE` | `pin-misdirection` | No |
| `LOGIN VERIFICATION` | `ignition-verification` | Ignition only |

Sets `window[Symbol.for("cloak_status")]` when detected. Deep TreeWalker pierces Shadow DOMs.

### 2c. Non-Blocking Noise Events
```
→ 1 randomized right-click (context menu)
→ 1 left-click on viewport edge
   Both async, within 50-300ms, never block main thread
```

---

## Phase 3: Navigate to Login Page
**Time: T+~2200ms → T+~4000ms** · [engine.ts:5460](file:///Volumes/Macintosh_HD/Users/user294545/Desktop/automati1-111-pORT-main/src/core/engine.ts#L5460)

```
page.goto("https://www.joefortune.zone/login", { waitUntil: "domcontentloaded" })
  → Fallback: joefortune.ooo/login (if .zone fails)
  → Pre-emptive block detection: analyzeInitialResponse()
  → Post-load resource analysis: analyzePageResources()
```

If either block detector fires → `PreemptiveBlockError` → session destroyed, proxy rotated.

---

## Phase 4: Attempt #1 — Full Choreography
This phase is driven by `universalLoginFlow()` → `executeUnifiedLoginChoreography()`.

**Pre-choreography** ([universal-login.ts:66](file:///Volumes/Macintosh_HD/Users/user294545/Desktop/automati1-111-pORT-main/src/targets/universal-login.ts#L66)):
```
1. waitForSelector('input[type="email"], #username', visible, 45s)  — Wait for login form
2. sleep(2000ms) — Let React attach event handlers
3. getCoordinateMap(siteName) — Load viewport-independent coordinate map
4. waitForLoadState("networkidle", 15s) — Wait for page network to settle
5. coordinateClick(emailInput) — Optional pre-click if coordinate map exists
6. → executeUnifiedLoginChoreography(options) — Stealth-humanized mode
```

**Attempt #1 is always the full choreography**.

### 4a. Early Human-Like Clicks (T+~4000ms)
[login-flow.ts:336](file:///Volumes/Macintosh_HD/Users/user294545/Desktop/automati1-111-pORT-main/src/targets/login-flow.ts#L336)

```
✅ Click "Remember Me" checkbox (within first second of DOM appearance)
✅ Click "Show Password" eye icon (unconditional, every run)
```
> These fire AS EARLY AS POSSIBLE — even before CMP dismissal.

### 4b. 3-Tier Cascade CMP Dismissal (T+~4200ms)
### 4b. CookieGuard Hard Gate (Unified Dismissal)
[cookie-guard.ts](file:///Volumes/Macintosh_HD/Users/user294545/Desktop/automati1-111-pORT-main/src/guards/cookie-guard.ts) · [login-flow.ts:352](file:///Volumes/Macintosh_HD/Users/user294545/Desktop/automati1-111-pORT-main/src/targets/login-flow.ts#L352)

```
CookieGuard.waitUntilDismissed() — BLOCKS until confirmed dismissed (15s max)

Flow:
  T+0ms    Start polling for cookie overlay (200ms intervals)
  T+500ms  Fire viewport click trick to encourage appearance
  T+2000ms Fire second viewport click
  T+3-10s  Cookie notice appears (typical window)

  On detection:
  ┌─ TIER 1: Native API ─────────────────────────────────────────┐
  │  window.CookieInformation?.submitAllCategories?.()           │
  ├─ TIER 2: UI Click (cascading selectors + text match) ───────┤
  │  .coi-banner__accept → [data-coi-btn="accept"]              │
  │  button:has-text("ACCEPT ALL") → ... → button:has-text("Accept") │
  ├─ TIER 3: CSS Force Hide ─────────────────────────────────────┤
  │  .coi-banner, [id*="cookie"], etc. { display: none !important } │
  └──────────────────────────────────────────────────────────────┘

  Verification (DOM):
  ✓ No cookie overlay elements visible (offsetParent === null OR display === none)
  ✓ Form inputs not obscured (elementFromPoint at input coordinates returns the input)

  T+15s (timeout): Force CSS-hide + warn + proceed
```

> **CRITICAL**: This is a **hard gate** — login submit CANNOT proceed until
> `cookieGuard.isDismissed()` returns true. Checked before every submit attempt.
> Replaces the previous 4 separate, uncoordinated cookie mechanisms.

### 4d. Wicketkeeper PoW Token (non-blocking)
[login-flow.ts:418](file:///Volumes/Macintosh_HD/Users/user294545/Desktop/automati1-111-pORT-main/src/targets/login-flow.ts#L418)

```
handleWicketkeeper(page, siteName)
  → Wait for .wicketkeeper hidden class
  → Token populates → captured for later use
  → 35s timeout ceiling
```

### 4e. Email Textbox Click
```
page.getByRole("textbox", { name: /E-mail/i }).click({ force: true })
```

### 4f. Fill Credentials (T+~4800ms)
[login-flow.ts:427](file:///Volumes/Macintosh_HD/Users/user294545/Desktop/automati1-111-pORT-main/src/targets/login-flow.ts#L427)

**Strategy cascade (first success wins):**

```
1. AI Vision Coordinates (if useVisionCoordinates=true)
   → getViewportCoordinateMarkdown(page)
   → humanClickAt(ex, ey) → keyboard.type(email)
   → humanClickAt(px, py) → keyboard.type(password)

2. Autofill Replica (simulateAutofill)
   → React internal state setter via JS prototype
   → Sets .value + dispatches input/change events
   → Mirrors native browser Autofill mechanics

3. Standard DOM Fill (inputText)
   → page.fill(selector, value) via engine.inputText()
   → If fails → healSelector() via AI (Ollama/DeepSeek)
     → Returns CSS selector OR COORD:x,y
     → persistHealedSelector() on success

4. Zero-Trust Vision Fallback
   → Full screenshot → AI coordinate extraction
   → humanClickAt → keyboard.type
```

### 4g. Pre-Submit Gates (T+~5500ms)
[login-flow.ts:508](file:///Volumes/Macintosh_HD/Users/user294545/Desktop/automati1-111-pORT-main/src/targets/login-flow.ts#L508)

```
GATE 1: Cookie dismiss promise (max 3s additional wait)
GATE 2: Wicketkeeper PoW token (max 35s wait)
```

Both run as `Promise.race` with timeouts — never blocks indefinitely.

### 4h. Reset cloak_status
```javascript
window[Symbol.for("cloak_status")] = null;   // Clear any pre-submit false positives
window.__automatiCookieDismissed = false;
```

### 4i. Submit Protocol — Enter Key (T+~6000ms)
[login-flow.ts:534](file:///Volumes/Macintosh_HD/Users/user294545/Desktop/automati1-111-pORT-main/src/targets/login-flow.ts#L534)

**Primary: Enter key from password field (Golden Template Rule)**

```
PRE-SUBMIT: SubmitButtonStateTracker.captureBaseline()
  → Snapshots computed styles: backgroundColor, color, opacity, borderColor
  → Records text content, disabled state, aria-disabled

1. page.locator("#password").focus()
2. page.click("#password")               ← Re-focus to ensure Enter targets form
3. Wait 200ms
4. page.keyboard.down("Enter")
5. Hold for gaussian(55ms, σ=15, 30-80ms)
6. page.keyboard.up("Enter")

POST-SUBMIT: SubmitButtonStateTracker.markSubmitted()
  → State: IDLE → PRESSED
  → Begins watching for style changes (event-driven, not timeout-based)
```

**SubmitButtonStateTracker State Machine:**
[submit-tracker.ts](file:///Volumes/Macintosh_HD/Users/user294545/Desktop/automati1-111-pORT-main/src/guards/submit-tracker.ts)
```
IDLE ──[click/enter]──→ PRESSED
  │                        │
  │         [computed styles changed from baseline]
  │                        ▼
  │                   PROCESSING
  │                        │
  │      [error text changed OR cloak_status set]
  │                        ▼
  │                RESPONSE_RECEIVED
  │                        │
  │      [styles return to baseline + 500ms buffer]
  │                        ▼
  └────────────────────── IDLE (ready for next attempt)
```

> Used by engine.ts submit-ready-gate for attempts #2+: `submitTracker.waitUntilReady()`
> replaces fixed timeout polling with event-driven state transitions.

**Concurrent listeners during Enter:**
```
┌─ API Response Trap ──────────────────────────────────────────┐
│  page.waitForResponse(POST to /api|/login|/auth|/graphql)    │
│  → Payload Classification Gate:                              │
│    HTML/403        → "blocked"                               │
│    0/500+/captcha  → "crash"                                 │
│    428/mfa_required→ "2FA"                                   │
│    200/201         → "success" → cashier token validation    │
│    permanently     → "permanently"                           │
│    temporarily     → "temporarily_disabled"                  │
│    not found       → "noaccount"                             │
│    fallback        → "incorrect"                             │
├─ Navigation Trap ────────────────────────────────────────────┤
│  page.waitForNavigation(domcontentloaded, 1500ms)            │
├─ Mutation Trap ──────────────────────────────────────────────┤
│  Poll __automatiSubmitObserverResult every 50ms (1500ms cap) │
└──────────────────────────────────────────────────────────────┘
```

### 4j. Enter Key Verification (T+~7500ms)

```
Signal race: API vs Nav vs Mutation (first wins)

IF signal.type === "post" or "nav":
  → Log submit trigger (Enter Key vs Button Click)
  → success = verdict === "success"

IF signal.type === "mutation":
  → Wait 800ms settle
  → Check: URL changed? Form gone?
  → YES → success
  → NO → "Enter key mutation was false positive"

IF no signal:
  → "Enter key submit not properly completed"
```

### 4k. Triple-Click Fallback (if Enter failed) (T+~8000ms)
[login-flow.ts:744](file:///Volumes/Macintosh_HD/Users/user294545/Desktop/automati1-111-pORT-main/src/targets/login-flow.ts#L744)

```
1. Get submit button boundingBox
2. Gaussian jitter within center 40% of button
3. humanMouseMove to target
4. Triple click: down→40ms→up→40ms → ×3
5. Wait 1500ms
6. Verify: is form still visible?
   → YES: retry click ×2 more (Opt 12 Verification Loop)
```

### 4l. Fire-and-forget AI Decoys
```
executeGenerativeDecoys(page)  // Non-blocking, async
```

---

## Phase 5: Response Classification
**Time: T+~8000ms → T+~12000ms** · [engine.ts:5815](file:///Volumes/Macintosh_HD/Users/user294545/Desktop/automati1-111-pORT-main/src/core/engine.ts#L5815)

### 5a. Fast Race Window
```
Poll for FAST_RACE_WINDOW ms:
  → Check window[Symbol.for("cloak_status")] (UI race)
  → Check network detection (API response trap)
  → First non-null wins
```

### 5b. Mutation Observer Fallback
```
If no fast status AND URL hasn't moved:
  → waitForSubmitMutationResult(2000ms)
  → Check: did error text change?
    → NO (submit swallowed): retry same password (max 2 retries)
    → YES + attempt 0: likely cookie intercept, retry
```

### 5c. 1500ms Render Cushion
[engine.ts:5887](file:///Volumes/Macintosh_HD/Users/user294545/Desktop/automati1-111-pORT-main/src/core/engine.ts#L5887)

```
sleep(1500ms)  ← React needs this to animate lazy-loaded modals
→ Re-poll cloak_status
→ Late modal override: AUTHENTICATOR/VERIFY PHONE can upgrade verdict
```

### 5d. Full DOM Classification
[engine.ts:502](file:///Volumes/Macintosh_HD/Users/user294545/Desktop/automati1-111-pORT-main/src/core/engine.ts#L502) — `classifyLoginResponse()`

```
Classification cascade (first match wins, code order):
  1. tempdisabled  — "temporarily disabled", "too many", "locked out"
  2. disabled      — "permanently disabled", "been disabled", "account closed"
  3. honeypot      — "under review", "upload identity"
  4. incorrect     — alertPresent OR body contains "incorrect"
  5. ignition-verification — LOGIN VERIFICATION (Ignition only)
  6. [form changed gate] →
     a. success (promoPresent)
     b. authenticator
     c. verify-phone
     d. pin-misdirection
  7. success       — .ol-alert__content--status_success OR /welcome!/i
  8. other         — fallback (triggers no-response handling)
```

### 5e. Success Detection (DOM)
`classifyLoginResponse()` uses a **3-signal** initial success detection cascade:

```
1. promoPresent         — Site promo/marketing content detected (form changed)
2. hasSuccessSelector   — CSS: ".ol-alert__content--status_success" found in DOM
3. /welcome!/i          — Text "Welcome!" (with "!") found in body text
```

> **IMPORTANT: All 3 signals are INITIAL success indicators only.** Returning "success" here
> does NOT finalize the outcome — it commands the wrapper to navigate to the cashier page
> (`/account/cashier/deposit/cc`) for confirmation. The outcome is only confirmed as a true
> success when the cashier page loads without bouncing back to `/login`.

### 5f. No-Response Handling
**When a login submit gets ZERO response** (no network verdict, no `cloak_status`, no DOM change after the render cushion):

```
NO RESPONSE DETECTED:
│
├─ 5-SECOND WATCH WINDOW
│   Poll every 200ms for:
│   - Success indicator (cloak_status, network, URL change)
│   - Error banner (.ol-alert, [role="alert"], etc.)
│
├─ IF success indicator appears → initial success → cashier verification
│
├─ IF error banner appears:
│   → Dismiss cookie notice (3-tier CMP cascade)
│   → Reset to attempt #1 with SAME password (full choreography)
│   → Max 2 full restarts allowed
│   → If 2 restarts exhausted → BURN session (misdirection treatment)
│     → Destroy context, rotate proxy, burn fingerprint seed
│     → Requeue credential for fresh session
│
├─ IF nothing after 5s:
│   → Re-click login button → 5s watch → repeat
│   → Max 3 re-presses (15s total)
│
└─ AFTER 3 re-presses with no response:
    → Navigate to cashier page (silent success check)
    → Cashier loads → outcome = "success" ✅
    → Cashier bounces → outcome = "N/A" (crash)
```

---

## Phase 6: Fast-Loop (Attempts #2, #3, #4)
**Time: T+~12s → T+~30s** · [login-flow.ts:663](file:///Volumes/Macintosh_HD/Users/user294545/Desktop/automati1-111-pORT-main/src/targets/login-flow.ts#L663)

> **Fast-Loop Rule**: DO NOT destroy context, wipe storage, or clear cookies. Only clear `#password` field.

```
FOR each remaining password:
  ┌──────────────────────────────────────────────────────────┐
  │ 1. page.locator("#password").fill("")                    │
  │ 2. inputText(page, "#password", nextPassword)            │
  │    → Fallback: healAndFill() via AI                      │
  │ 3. Wicketkeeper token check                              │
  │ 4. Reset cloak_status to null                            │
  │ 5. Fire AI decoys (non-blocking)                         │
  │ 6. Wait for submit button interactive (4s timeout)       │
  │ 7. Physical CLICK on submit button                       │
  │    → gaussianClamped center-40% coordinate jitter        │
  │    → humanMouseMove → mouse.down → hold → mouse.up      │
  │ 8. Response classification (same as Phase 5)             │
  │ 9. If "incorrect": continue to next password             │
  │    If terminal: break immediately                        │
  └──────────────────────────────────────────────────────────┘
```

**Key differences from Attempt #1:**
- Email is NOT re-filled (persists in DOM)
- Submit uses **CLICK** not Enter (only attempt #1 uses Enter)
- No CMP dismissal (already done)
- No Remember Me / Show Password (already done)

---

## Phase 7: Terminal Classification & Routing
**Time: T+~30s** · [engine.ts](file:///Volumes/Macintosh_HD/Users/user294545/Desktop/automati1-111-pORT-main/src/core/engine.ts)

```
┌─────────────────────────────────────────────────────────────┐
│ OUTCOME         │ ACTION                                    │
├─────────────────┼───────────────────────────────────────────┤
│ success         │ → Phase 8 (Cashier Verification)          │
│ incorrect ×4    │ → no_account (strict 4-attempt rule)      │
│ disabled        │ → perm_disabled, burn fingerprint+proxy   │
│ tempdisabled    │ → 1hr countdown, test other site first    │
│ authenticator   │ → 2FA detected, session ends              │
│ verify-phone    │ → Success variant (pre-cashier screen)    │
│ pin-misdirection│ → Requeue with fresh fingerprint+IP       │
│ ignition-verif  │ → Requeue (Ignition-specific misdirect)   │
└─────────────────────────────────────────────────────────────┘
```

---

## Phase 8: Cashier Verification (Success Only)
**Time: T+~30s → T+~48s** · [engine.ts:5314](file:///Volumes/Macintosh_HD/Users/user294545/Desktop/automati1-111-pORT-main/src/core/engine.ts#L5314)

```
1. Attach framenavigated bounce listener
   → Detects redirect matching BOTH:
     a) Path pattern: /(login|signin|sign-in)
     b) Redirect query param: ?destination= / ?redirect= / ?returnto=
   → Both conditions must match to trigger bounce

2. page.goto("/account/cashier/deposit/cc", { waitUntil: "networkidle" })
   → Fallback: domcontentloaded (12s timeout)

3. Race: cashier settle vs bounce vs 18s timeout

4. IF bounced to /login → "soft_success_failed_cashier"
   IF settled on cashier → "success" CONFIRMED ✅

5. DOM Settle (Mutation Quiescence):
   → MutationObserver on document.body
   → Wait for mutations to stop for 800ms (capped at 8s)
   → NO arbitrary page.waitForTimeout()

6. Capture verification screenshot at cashier page
```

---

## Phase 9: Session Teardown
**Time: T+~48s** · [stealth.ts](file:///Volumes/Macintosh_HD/Users/user294545/Desktop/automati1-111-pORT-main/backends/stealth.ts) / [engine.ts](file:///Volumes/Macintosh_HD/Users/user294545/Desktop/automati1-111-pORT-main/src/core/engine.ts)

```
Phase 1: browser.close() (3000ms timeout)
Phase 2: SIGKILL targeting browser PID (if phase 1 times out)
Phase 3: Proxy forwarder teardown
Phase 4: Zombie sweep (ps -axo / kill orphaned processes)
Phase 5: Release headed slot (if headed mode)
```

> No arbitrary delays. Once DOM settles on outcome → exit IMMEDIATELY.

---

## Complete Timeline (Happy Path — Attempt #1 Success)

```
T+0ms     │ Dequeue credential, check circuit breaker
T+50ms    │ Profile enrichment (UA, hardware, geo, fonts, etc.)
T+300ms   │ Proxy forwarder launched
T+2000ms  │ Camoufox browser spawned + context created
T+2100ms  │ addInitScript: early cookie dismiss + login trigger observer
T+2200ms  │ page.goto("joefortune.zone/login")
T+4000ms  │ Page loaded, pre-emptive block check passes
T+4100ms  │ Click Remember Me ✅
T+4200ms  │ Click Show Password 👁
T+4300ms  │ CMP Dismissal (Tier 1 → 2 → 3)
T+4500ms  │ Wicketkeeper PoW starts (background)
T+4800ms  │ Fill email via autofill replica
T+5000ms  │ Fill password via autofill replica
T+5500ms  │ Pre-submit gates (cookie + Wicketkeeper)
T+5700ms  │ Reset cloak_status
T+6000ms  │ Focus #password → Enter key pressed
T+6060ms  │ Enter key released (55ms hold)
T+7500ms  │ API response trap fires → "success" detected
T+7500ms  │ /welcome!/ found in DOM → INSTANT success
T+7600ms  │ Navigate to /account/cashier/deposit/cc
T+9000ms  │ Cashier page settled (networkidle)
T+9800ms  │ DOM quiescence confirmed (800ms no mutations)
T+9900ms  │ Screenshot captured at cashier
T+10000ms │ browser.close() + proxy teardown
T+10000ms │ ✅ DONE — outcome: "success"
```

## Complete Timeline (4× Incorrect → no_account)

```
T+0ms     │ [Same as above through T+6000ms]
T+6000ms  │ Attempt #1: Enter key → "incorrect"
T+7500ms  │ 1500ms render cushion → no modal override
T+9000ms  │ Attempt #2: Clear #password → fill pw2 → click submit
T+10500ms │ Response: "incorrect"
T+12000ms │ Attempt #3: Clear #password → fill pw3 → click submit  
T+13500ms │ Response: "incorrect"
T+15000ms │ Attempt #4: Clear #password → fill pw4 → click submit
T+16500ms │ Response: "incorrect"
T+16500ms │ 4/4 incorrect → outcome: "no_account" ✅
T+16600ms │ browser.close() + proxy teardown
T+16600ms │ ✅ DONE — outcome: "no_account"
```
