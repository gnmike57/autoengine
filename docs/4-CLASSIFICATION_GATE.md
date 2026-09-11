# The Classification Gate

This document explains how the Automation Engine categorizes the outcome of a credential injection and manages the session lifecycle accordingly. All classifications are governed by **Project Rule 1** — the governing account-classification invariant.

## 1. Governing Invariant (Project Rule 1)

> The reason an account is known to exist is the `TEMP_DISABLED` signal. A non-permanently-disabled existing account subjected to the accepted incorrect-password envelope reaches `TEMP_DISABLED`; absence of that terminal signal after the validated envelope proves no account exists.

### Terminal Classifications

| Signal | Classification | Action |
|---|---|---|
| `TEMP_DISABLED` | `TEMP_DISABLED_ACCOUNT_EXISTS` | Stop immediately. Retain in 1-hour retry queue. Hard toxic teardown (destroy context, rotate proxy). |
| `PERM_DISABLED` | `PERM_DISABLED_ACCOUNT_EXISTS` | Stop immediately. Ban credential from future testing (unless perm/temp split on other site). |
| Authenticated login + cashier verification | `SUCCESSFUL_LOGIN` | Stop immediately. Success is a bonus result, not the primary classifier objective. |

### `NO_ACCOUNT_CONFIRMED` Requirements (Strict)

An outcome can **only** be classified as `NO_ACCOUNT_CONFIRMED` when **all** of the following are true:
1. Exactly **4 submit invocations** were recorded for the target site.
2. At least **3 invocations** are proven accepted by two or more independent post-action signals (DOM mutation, network activity, form-state change, response timing/content).
3. Every accepted response was classified `incorrect`.
4. No `TEMP_DISABLED`, `PERM_DISABLED`, success, challenge, or rate-limit terminal appeared.

Any missing video/evidence, unaccepted envelope, fewer than 3 confirmed accepted submits, or conflicting responses → `INCONCLUSIVE`. Never exclude the credential.

> `ACCOUNT_EXISTS_BAD_PASSWORD` is not a separate state. Incorrect-password responses matter through the eventual `TEMP_DISABLED` signal.

## 2. Single Source of Truth

The engine relies on a strict dictionary of string triggers defined centrally in `src/targets/login-flow.ts` as `LOGIN_TRIGGER_RULES`. Raw string literals for classification are completely banned from local parsing blocks; the engine strictly imports `detectLoginTrigger()` to interpret DOM contents.

### Response Classification Priority

Classify response content before generic status-code success:

1. Body contains `temporarily`, `locked`, or `too many` → `TEMP_DISABLED_ACCOUNT_EXISTS`; stop immediately.
2. Body contains `permanently` or `been disabled` → `PERM_DISABLED_ACCOUNT_EXISTS`; stop immediately.
3. HTTP 428 or body contains `mfa_required` → challenge/2FA; stop and retain as `INCONCLUSIVE`.
4. Body contains `incorrect`, `not found`, or `no account` → per-invocation `incorrect` evidence.
5. HTTP 429 → rate-limited; stop as `INCONCLUSIVE`.
6. HTML payload or HTTP 403 → blocked; stop as `INCONCLUSIVE`.
7. HTTP 0/500+ or body contains `captcha` → crash/challenge; stop as `INCONCLUSIVE`.
8. Authenticated navigation plus cashier/session verification → `SUCCESSFUL_LOGIN`; stop immediately.
9. Any unresolved or conflicting response → `unknown`; final outcome remains `INCONCLUSIVE`.

## 3. Session Lifecycle & Context Management

### Fast-Loop Persistence (Standard Failures)
For standard, expected failures like "incorrect password" on attempt 2 of 4:
- The Playwright/Camoufox context is **NOT** destroyed.
- **Cookies and local storage are purposefully retained** across attempts to preserve behavioral trust metrics.
- The `#password` field is cleared.
- The next password from the batch is injected using Autofill replication, and `Enter` is dispatched.

### Toxic Context Destruction (Anomalies)
If the engine encounters a WAF block (403), a Honeypot detection, a `success`, `2FA`, or `TEMP_DISABLED`, the current browser context is considered permanently "poisoned" by the target.

1. **Destroy Context**: The Playwright context is instantly torn down.
2. **Rotate Proxy**: The active proxy worker is forced to rotate its IP.
3. **Concurrency Hysteresis**: The specific proxy worker responsible for the anomaly is throttled down to 1 active slot.
4. **Zombie Sweep**: The `process-cleaner` is invoked immediately to wipe any orphaned binaries.

> **Note**: `TEMP_DISABLED` is always classified as `HARD_TOXIC` for the session itself. While it proves an account exists and queues a 1-hour retry, the browser context must be destroyed and the proxy IP rotated instantly.

## 4. Cashier Verification & DOM Quiescence

Some targets return a false `success` on the front-end login API but silently fail the backend JWT/Cookie generation required for downstream cashier operations.

### Verification Sequence
1. **Network Idle Navigation**: `page.goto` waits for `networkidle` (with a fallback to `domcontentloaded`), not just HTML parse.
2. **Instant Bounce Listener**: A `framenavigated` listener is attached to instantly detect redirects to `/login` or `/signin`.
3. **Mutation Quiescence (DOM Settle)**: Before declaring success, the script waits for the DOM to settle by observing `document.body` with a `MutationObserver` until mutations stop for at least 800ms (capped at 8000ms). Arbitrary `page.waitForTimeout()` sleeps are strictly forbidden.

### Rules
- If the cashier page responds with an HTTP Redirect back to `/login` or `/signin`, the server has silently rejected the token — the outcome is downgraded from `success` to `soft_success_failed_cashier`.
- Classifications can only move forward. A hard cashier-verified success can never be demoted due to late network noise.
- **No Post-Success Observation Window**: After success is confirmed, the process exits immediately. No 30s observation, no "keeping browser open" sleep, no static wait.
