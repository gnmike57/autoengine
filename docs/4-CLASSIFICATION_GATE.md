# The Classification Gate

This document explains how the Automation Engine categorizes the outcome of a credential injection and manages the session lifecycle accordingly.

## 1. Single Source of Truth

The engine relies on a strict dictionary of string triggers defined centrally in `src/targets/login-flow.ts` as `LOGIN_TRIGGER_RULES`. Raw string literals for classification are completely banned from local parsing blocks; the engine strictly imports `detectLoginTrigger()` to interpret DOM contents.

### The Vocabulary
- `blocked`: HTML payload rejected or HTTP 403.
- `crash`: HTTP 0 or HTTP 500+.
- `2FA`: HTTP 428 or "mfa_required" strings. The credential is mathematically valid, but a second factor is blocking the login.
- `success`: HTTP 200/201 and valid post-login DOM.
- `permdisabled`: "permanently" / "been disabled". The account is dead.
- `tempdisabled`: "temporarily" / "locked" / "too many attempts". The account is locked but may recover.
- `noaccount`: "not found" / "no account". The credential does not exist.
- `incorrect`: Fallback for all other credential failures.

## 2. Session Lifecycle & Context Management

The outcome of the classification strictly dictates the lifecycle of the browser context.

### Fast-Loop Persistence (Standard Failures)
For standard, expected failures like "incorrect password" on attempt 2 of 4:
- The Playwright/Camoufox context is **NOT** destroyed.
- **Cookies and local storage are purposefully retained** across attempts to preserve behavioral trust metrics.
- The `#password` field is cleared.
- The next password from the batch is injected using Autofill replication, and `Enter` is dispatched.

### Cookie Interception Detection
If a red error banner suddenly mutates onto the screen during the very first attempt (`attemptIdx === 0`), the engine categorizes this as a cookie banner interception. Instead of burning the credential attempt as "incorrect", it gracefully intercepts the failure, logs it, and immediately retries the identical password on the exact same context.

### Toxic Context Destruction (Anomalies)
If the engine encounters a WAF block (403), a Honeypot detection, a `success`, or `2FA`, the current browser context is considered permanently "poisoned" by the target.

1. **Destroy Context**: The Playwright context is instantly torn down.
2. **Rotate Proxy**: The active proxy worker is forced to rotate its IP.
3. **Concurrency Hysteresis**: The specific proxy worker responsible for the anomaly is throttled down to 1 active slot (via `backends/index.ts` tracking score) to prevent cascade banning.
4. **Zombie Sweep**: The `process-cleaner` is invoked immediately to wipe any orphaned binaries.

## 3. Cashier Token Validation

Some targets return a false `success` on the front-end login API but silently fail the backend JWT/Cookie generation required for downstream cashier operations.

- **Rule**: On every `success`, the engine performs a background `fetch()` to `/cashier/deposit`.
- **Validation**: If the application responds with an HTTP Redirect (301/302) back to `/login` or `/signin`, the server has silently rejected the token.
- **Downgrade**: The outcome is immediately downgraded from `success` to `soft_success_failed_cashier`.
- **Ratchet Rule**: Classifications can only move forward. A hard cashier-verified success can never be demoted due to late network noise.
