---
name: automation-video-coverage
trigger: on_demand
version: 1.0.0
created: 2026-08-05
project: JOEIGNITION (nows / D2JQwJznypXKkZqV7ghzQt)
---

# Automation Video Coverage Skill

## Purpose
Governs the recording, classification, and archival of video evidence for every automation session. Ensures every outcome class (`NO_ACCOUNT`, `SUCCESS`, `TEMP_DISABLED`, `PERM_DISABLED`, `2FA`, `INCORRECT`, `BLOCKED`) has at least one recorded synthetic baseline trial in `tests/vision/fixtures/`.

## Baseline Coverage Matrix

| Outcome Class | Fixture File | Status |
|---|---|---|
| `NO_ACCOUNT` | `tests/vision/fixtures/no-account-baseline.webm` | ⬜ PENDING |
| `SUCCESS` | `tests/vision/fixtures/success-baseline.webm` | ⬜ PENDING |
| `TEMP_DISABLED` | `tests/vision/fixtures/temp-disabled-baseline.webm` | ⬜ PENDING |
| `PERM_DISABLED` | `tests/vision/fixtures/perm-disabled-baseline.webm` | ⬜ PENDING |
| `2FA` | `tests/vision/fixtures/2fa-baseline.webm` | ⬜ PENDING |
| `INCORRECT` | `tests/vision/fixtures/incorrect-baseline.webm` | ⬜ PENDING |
| `BLOCKED` | `tests/vision/fixtures/blocked-baseline.webm` | ⬜ PENDING |

## Recording Protocol
1. Each baseline is a synthetic Playwright recording against a local mock server (`tests/mocks/login-server.ts`).
2. The mock server returns deterministic HTML payloads matching each classification trigger in `LOGIN_TRIGGER_RULES`.
3. Recordings are stored as `.webm` files at ≤ 30fps, max 30s duration.
4. Each fixture is accompanied by a `.json` sidecar with: `{ outcome, domTrigger, httpStatus, recordedAt, engineVersion }`.

## Governance Contract
- No new outcome class may be added to `src/targets/login-flow.ts` without a corresponding fixture.
- The `tests/vision/ground-truth.test.ts` suite must have a non-skipped test for each fixture.
- CI gate: `npx vitest run tests/vision/` must pass before any merge to `main`.

## Usage
```bash
# Record a new baseline (requires local mock server)
npx tsx scripts/record-baseline.ts --outcome=noaccount --output=tests/vision/fixtures/no-account-baseline.webm

# Run ground-truth suite
npx vitest run tests/vision/
```

## Related Files
- `src/services/video-verifier.ts` — AI classification of recorded video
- `src/services/video-extraction.ts` — Key-frame extraction from .webm
- `src/intelligence/vision-lock.ts` — Visual verification lock (OpenRouter nemotron-nano)
- `tests/vision/ground-truth.test.ts` — The ground-truth test suite
- `docs/4-CLASSIFICATION_GATE.md` — Classification vocabulary and lifecycle rules
