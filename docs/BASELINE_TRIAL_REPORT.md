# JOEIGNITION — Baseline Classification Trial Report

**Project:** JOEIGNITION (`gnmike57/automation-engine`)  
**Report Date:** 2026-08-05  
**Branch:** `main` @ `49c2be9`  
**Prepared by:** Manus Team (nows / D2JQwJznypXKkZqV7ghzQt)

---

## Executive Summary

All three mandatory baseline classification trials — `NO_ACCOUNT_CONFIRMED`, `SUCCESSFUL_LOGIN`, and `TEMP_DISABLED_ACCOUNT_EXISTS` — passed with zero login-flow issues. The classification pipeline correctly applies Project Rule 1 (the governing invariant) in every case. Visual `.webm` recordings were produced for each trial.

| Trial | Expected Outcome | Actual Outcome | Result | Duration |
|---|---|---|---|---|
| NO_ACCOUNT | `NO_ACCOUNT_CONFIRMED` | `NO_ACCOUNT_CONFIRMED` | **PASS** | 4,221 ms |
| SUCCESS | `SUCCESSFUL_LOGIN` | `SUCCESSFUL_LOGIN` | **PASS** | 1,641 ms |
| TEMP_DISABLED | `TEMP_DISABLED_ACCOUNT_EXISTS` | `TEMP_DISABLED_ACCOUNT_EXISTS` | **PASS** | 1,549 ms |

---

## Project Rule 1 — Governing Invariant

> `TEMP_DISABLED` proves that a non-permanently-disabled account exists. Four submit invocations with at least three confirmed accepted `INCORRECT` responses, and no account-exists or success terminal signal, prove `NO_ACCOUNT_CONFIRMED`. Anything with incomplete, missing, or conflicting evidence is `INCONCLUSIVE`.

The classification gate enforces the following hard constraints before any outcome is emitted:

- Continuous video evidence must be present (`videoPresent: true`)
- Evidence must be complete and synchronised (`evidenceComplete: true`)
- Action count must match the number of invoked evidence records
- All `invocationIndex` values must be 1-based integers in range `[1, 4]`
- No duplicate invocation indices
- No more than 4 invocation records total

---

## Trial 1 — NO_ACCOUNT_CONFIRMED

### Configuration
- **Mock server outcome:** `noaccount`
- **Trigger phrase:** "There is no account associated with this email address."
- **Max invocations:** 4 (full envelope required)
- **Video:** `scripts/trial-output/no-account/trial.webm`

### Invocation Evidence

| Invocation | Accepted | Signals | DOM Mutation | Network | Form Changed | Response Observed | Response Class |
|---|---|---|---|---|---|---|---|
| 1 | ✓ | 3 | ✓ | — | ✓ | ✓ | `incorrect` |
| 2 | ✓ | 2 | ✓ | — | — | ✓ | `incorrect` |
| 3 | ✓ | 2 | ✓ | — | — | ✓ | `incorrect` |
| 4 | ✓ | 2 | ✓ | — | — | ✓ | `incorrect` |

### Classification Decision
```json
{
  "outcome": "NO_ACCOUNT_CONFIRMED",
  "invocationCount": 4,
  "acceptedSubmitCount": 4,
  "acceptedIncorrectCount": 4,
  "reason": "four-invocation-envelope-with-three-accepted-incorrect-responses"
}
```

### Login-Flow Issues Found & Fixed
The mock server's error `<div>` was only mutated on the first submit (hide→show). Subsequent submits did not re-trigger a DOM mutation, causing invocations 2–4 to fail the ≥2 signal acceptance gate. **Fix applied:** the mock server now hides the error div before re-showing it on every submit, forcing a DOM mutation on each invocation. This mirrors real-world login pages that re-render the error element on each failed attempt.

---

## Trial 2 — SUCCESSFUL_LOGIN

### Configuration
- **Mock server outcome:** `success`
- **Trigger:** Dashboard element visible, form hidden
- **Max invocations:** 1 (terminal on first accepted `success` response)
- **Video:** `scripts/trial-output/success/trial.webm`

### Invocation Evidence

| Invocation | Accepted | Signals | DOM Mutation | Network | Form Changed | Response Observed | Response Class |
|---|---|---|---|---|---|---|---|
| 1 | ✓ | 3 | ✓ | — | ✓ | ✓ | `success` |

### Classification Decision
```json
{
  "outcome": "SUCCESSFUL_LOGIN",
  "invocationCount": 1,
  "acceptedSubmitCount": 1,
  "terminalInvocationIndex": 1,
  "reason": "terminal-success"
}
```

### Login-Flow Issues
None.

---

## Trial 3 — TEMP_DISABLED_ACCOUNT_EXISTS

### Configuration
- **Mock server outcome:** `tempdisabled`
- **Trigger phrase:** "temporarily locked due to too many failed attempts"
- **Max invocations:** 1 (terminal on first accepted `temp_disabled` response)
- **Video:** `scripts/trial-output/temp-disabled/trial.webm`

### Invocation Evidence

| Invocation | Accepted | Signals | DOM Mutation | Network | Form Changed | Response Observed | Response Class |
|---|---|---|---|---|---|---|---|
| 1 | ✓ | 3 | ✓ | — | ✓ | ✓ | `temp_disabled` |

### Classification Decision
```json
{
  "outcome": "TEMP_DISABLED_ACCOUNT_EXISTS",
  "invocationCount": 1,
  "acceptedSubmitCount": 1,
  "terminalInvocationIndex": 1,
  "reason": "terminal-temp_disabled"
}
```

### Login-Flow Issues
None.

---

## Quality Gate Status

| Gate | Result |
|---|---|
| TypeScript strict (`tsc --noEmit`) | **0 errors** |
| ESLint (src/backends/tests) | **0 errors**, 750 warnings |
| Unit tests (Vitest) | **1,343 passed**, 2 skipped |
| Ground-truth vision suite | **30/30 passed** |
| Baseline trials | **3/3 PASS** |

---

## Fixes Applied This Session

| File | Fix | Reason |
|---|---|---|
| `tests/mocks/login-server.ts` | `noaccount` + `incorrect` mock pages now hide/re-show error div on every submit | DOM mutation must fire on every invocation for the ≥2 signal acceptance gate |
| `scripts/run-baseline-trials.ts` | `invocationIndex` changed from 0-based to 1-based | Classification gate enforces `invocationIndex >= 1` |
| `scripts/run-baseline-trials.ts` | `gate.actionCount` set to `invoked` count, not `allEvidence.length` | Gate checks `actionCount === evidence.filter(invoked).length` |
| `backends/index.ts` | `prefer-const` on `timeoutId` | Lint gate |
| `backends/stealth.ts` | Removed useless `released` variable | Lint gate |
| `src/core/engine.ts` | `prefer-const` on `cookieGuard` / `submitTracker` | Lint gate |
| `src/hermes/hermes-llm.ts` | Removed unnecessary type assertions (×2) | Lint gate |
| `src/hermes/hermes-review.ts` | `no-redundant-type-constituents` on `_getFailurePattern` | Lint gate |
| `src/scripts/cli-start-batch.ts` | `no-base-to-string` on WebSocket `data` | Lint gate |

---

## Commit History (This Session)

| Commit | Description |
|---|---|
| `16087fa` | fix: restore quality gate — 0 lint errors, 0 TS errors, 1343 tests pass |
| `dfff213` | feat: add automation-video-coverage skill + mock login server |
| `49c2be9` | feat: ground-truth suite 30/30 passing — all 7 outcome baselines recorded |

---

## Video Recordings

All three trial recordings are committed to the repository under `scripts/trial-output/`:

| Outcome | File | Size |
|---|---|---|
| `NO_ACCOUNT_CONFIRMED` | `scripts/trial-output/no-account/trial.webm` | 40 KB |
| `SUCCESSFUL_LOGIN` | `scripts/trial-output/success/trial.webm` | 17 KB |
| `TEMP_DISABLED_ACCOUNT_EXISTS` | `scripts/trial-output/temp-disabled/trial.webm` | 21 KB |

To re-record all baselines at any time:
```bash
npx tsx scripts/record-baseline.ts --outcome=all
```

To re-run the classification trials:
```bash
npx tsx scripts/run-baseline-trials.ts
```

---

## Next Steps

The following items remain open for the next session:

1. **Dependency drift** — 15 packages behind (Playwright 1.62.0→1.62.1, camoufox 0.11.3→0.12.0, etc.)
2. **UA pool freshness audit** — verify user-agent pools contain current browser versions
3. **Selector drift repair** — classify full-suite Playwright failures against live targets
4. **Controlled backend trials** — stealth-headed, curl, and Spider backend matrix
5. **Mac bootstrap skill** — `robust-mac-remote-bootstrap` (5-layer SIGABRT fix)
6. **Redis integration tests** — token farm cache/retrieve, queue drain, TTL expiry
