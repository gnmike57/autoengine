# Automation Flow

This document details the step-by-step choreography executed against target websites, primarily orchestrated in `src/targets/login-flow.ts`. The flow is explicitly separated into the initial attempt and subsequent fast-loop retries to accurately reflect the chronological timeline of a single session.

## Phase 1: The First Run (Attempt #1)

### 1. Pre-Flight Evasion
Before navigating to the target URL, the engine configures the execution environment to bypass WAFs (Web Application Firewalls):
- **navigator.webdriver**: The #1 bot detection signal is overridden. On JS-injected backends, `Object.defineProperty` is used to force it to `undefined`. On Zendriver, this is handled via CDP.
- **Headers & CDP Metadata**: Client hints, platforms, and brand arrays are spoofed to match the generated `UserAgent` profile exactly.

### 2. Early Human-like Clicks
Once the DOM begins initializing:
- **Remember Me**: 100% of the time, the engine clicks the "Remember Me" checkbox the very exact second it hits the DOM using an early native initialization hook, even before the page has finished loading.
- **Show Password**: It clicks the "Show Password" eye-icon to simulate human trust behavior.

### 3. Mandatory CMP (Cookie) Dismissal
The engine executes a strict **Cascade Dismissal** synchronously to kill cookie banners before they can steal focus:
1. **Native API**: Tries calling `window.CookieInformation.submitAllCategories()` directly.
2. **UI Click**: If the API fails, attempts a physical click on known consent selectors (e.g., `.coi-banner__accept`).
3. **CSS Hide**: If all else fails, forcefully hides the banner via `display: none !important` to ensure it doesn't block underlying DOM interaction.
- *Background:* An **Async Cookie Watcher** is launched concurrently (running for up to 15s) to silently click any late-arriving banners without blocking the script.

### 4. Background Proof-of-Work (PoW)
The Wicketkeeper background task starts generating its mathematical token concurrently.

### 5. Input Emulation Protocol (Credential Fill)
Directly assigning `element.value = "..."` is strictly banned. The bot clicks directly on the "E-mail" text box to focus the form, then:
- **Primary:** Attempts to fill **both** the Email and Password simultaneously using AI Vision Coordinates or Autofill-style native React injection, bypassing typing speeds and mimicking a password manager.
- **Fallback:** If that fails, it falls back to typing them individually, triggering the DOM healer if the selectors have drifted, using synthetic `TrustedEvent` constructs (`input`, `change`, `keydown`) to sync state.
- **Zero-Trust Fallback:** If all DOM interaction fails, a final raw coordinate pixel click + keyboard typing is used based on the Vision markdown.

### 6. Pre-Submit Security Gates
- **Cookie Gate:** Pauses up to 3 seconds if the Async Cookie Watcher hasn't finished yet.
- **Wicketkeeper Gate:** Pauses execution until the background PoW token is ready (max 35s).

### 7. The Submit Protocol (Enter Key)
- Submits the form by dispatching a native physical `Enter` keypress while focused inside the password field.
- **Generative Decoys & Blur:** While waiting for the submit response, non-blocking generative decoy movements are fired, along with a click in the "dead space" (bottom right of the viewport) to force React/Vue to blur the form and sync state.
- **Fallback:** If the "Enter" key fails to register a submission (or fails the mutation/network checks), the script waits for the submit button to become interactive and fires a **Triple-Click** on it.

---

## Phase 2: Outcome Evaluation

### 8. The Decision Gate (Network & DOM)
The engine races the Network API response against DOM mutations. Once the submit occurs, the engine evaluates the API response payloads and checks for cashier validation:
- If the result is **Success, 2FA, Permanently Disabled, or Blocked (e.g., "Identity Verification")**, the session ends entirely and the context is destroyed.
- If the result is **Incorrect Password**, the context is preserved, the browser remains open, and the system transitions into the Fast-Loop Sequence.

---

## Phase 3: The Fast-Loop Sequence (Attempts #2, #3, and #4)

When the previous attempt fails due to an incorrect password, the engine loops back for the next credential pair (`attemptIdx > 0`).

### 9. Skip Redundant Setup & Re-Inject Password
- **Email Skipped:** Because the email address is already present and persists in the DOM from Attempt #1, the engine skips re-typing it to save time and mimic a human retry. The "Remember Me" click, email textbox focus, and cookie cascades are bypassed.
- **Password Cleared:** The script immediately highlights and clears the old password, injecting the *new* password for this attempt (via Vision coordinates or individual typing).
- **Wicketkeeper Gate:** A quick check ensures the Wicketkeeper token is still valid/ready.

### 10. Fast-Loop Submission (Single Click)
- **Generative Decoys & Blur:** Just like Attempt #1, generative decoy movements and a dead space click are fired to force form blur and mimic human micro-movements.
- **Button Readiness:** The script waits for the submit button to become fully interactive and visible.
- **Submit:** Unlike Attempt #1 (which strictly tests the "Enter" key), attempts #2+ execute a randomized **Single Click** on the Submit button via precise bounding-box coordinates.

### 11. Loop Repeats
This fast-loop cycle repeats until either the account succeeds or all 4 attempts are exhausted (resulting in a `no_account` classification).
