---
trigger: always_on
---

# 6. THE AUTOMATION GATE — PROJECT RULE 1

> `TEMP_DISABLED` proves an account exists. Four invocations with at least three confirmed accepted `incorrect` responses and no account-exists or success terminal prove `NO_ACCOUNT_CONFIRMED`. Missing or conflicting evidence is `INCONCLUSIVE`.

Implement the main automation pipeline exactly as follows.

## Navigation and Form Access

Apply the configured header, CDP, platform, brand, locale, timezone, and `navigator.webdriver` profile before navigation. Dismiss CookieInformation banners before credential entry using the strict cascade: native API, visible UI click, then CSS hide. The form must be interactable before any submit invocation.

## One Action Per Envelope Invocation

Enumerate submit methods from `REGISTERED_SUBMIT_VARIATIONS`. Evidence runs select a primary variation and rotate through `getOrderedSubmitRoute()` deterministically. Each envelope invocation executes exactly one physical submit variation. Never hide multiple clicks, keypresses, or JavaScript submissions inside one invocation. Stop after four invocation records or an early terminal signal.

## 4 Login Attempts Invariant (ABSOLUTE)

This rule overrides ALL other rules: **Exactly 4 physical login attempts MUST occur** before ever moving on to the next credential or next target site, *unless* a hard terminal result (Success, TempDisabled, PermDisabled, 2FA/Challenge) is explicitly detected.
- If a timeout occurs (e.g., `Choreography timeout`) or credentials fail to fill (`Email OK: false, Password OK: false`), the attempt DOES NOT COUNT. The engine must retry or brute-force repair until 4 valid attempts are executed.
- A "success" classification from an empty form submission is a false positive and must be blocked.
- Skipping attempts and moving on prematurely is STRICTLY PROHIBITED.

Arm DOM, network, navigation, form-state, Playwright trace, CDP, coordinate, video, and AI evidence collection before the physical action. A click or keypress is only an invocation. It is accepted only when at least two independent post-action signals are present from DOM mutation, network activity, form-state change, and observed response timing/content.

## Response Classification Priority

Classify response content before generic status-code success:

1. Body contains `temporarily`, `locked`, or `too many` → `TEMP_DISABLED_ACCOUNT_EXISTS`; stop immediately.
2. Body contains `permanently` or `been disabled` → `PERM_DISABLED_ACCOUNT_EXISTS`; stop immediately.
3. HTTP 428 or body contains `mfa_required` → challenge/2FA; stop and retain as `INCONCLUSIVE` unless a separately approved account-exists terminal applies.
4. Body contains `incorrect`, `not found`, or `no account` → per-invocation `incorrect` evidence. These phrases never directly produce `NO_ACCOUNT_CONFIRMED`.
5. HTTP 429 → rate-limited; stop as `INCONCLUSIVE`.
6. HTML payload or HTTP 403 → blocked; stop as `INCONCLUSIVE`.
7. HTTP 0/500+ or body contains `captcha` → crash/challenge; stop as `INCONCLUSIVE`.
8. Authenticated navigation plus cashier/session verification → `SUCCESSFUL_LOGIN`; stop immediately.
9. Any unresolved or conflicting response → `unknown`; final outcome remains `INCONCLUSIVE`.

The DOM success phrase `welcome!` may be used as one signal, but success still requires authenticated session/cashier confirmation and synchronized evidence.

## Final Account Decision

| Evidence sequence | Required outcome |
|---|---|
| Accepted submit produces temporary-disable signal | `TEMP_DISABLED_ACCOUNT_EXISTS` |
| Accepted submit produces explicit permanent-disable signal | `PERM_DISABLED_ACCOUNT_EXISTS` |
| Authenticated login is verified | `SUCCESSFUL_LOGIN` |
| Exactly four invocations, at least three accepted, every accepted response `incorrect`, no terminal conflict | `NO_ACCOUNT_CONFIRMED` |
| Any missing video, incomplete evidence, fewer than three accepted submits, challenge, rate limit, or conflict | `INCONCLUSIVE` |

`ACCOUNT_EXISTS_BAD_PASSWORD` is not a separate state. Never classify `NO_ACCOUNT_CONFIRMED` from a single response phrase, a click counter, unchanged error text, `actionCount=0`, or a dry run.

## Cashier and Evidence Gate

On apparent success, verify the configured cashier/deposit/account endpoint. Redirect back to login means success is not confirmed. Every PASS requires continuous video and synchronized DOM, coordinate, network, Playwright, CDP, and redacted AI artifacts under the same run and attempt IDs. An omitted backend or submit variation remains in the matrix denominator as missing/blocked and cannot disappear from aggregate statistics.
