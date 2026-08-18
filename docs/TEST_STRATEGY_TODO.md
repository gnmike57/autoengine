# Testing & Bug-Finding Strategy — Long-Term TODO

> **Last updated:** 2026-06-29
>
> Tracks all **16 testing categories** from the exhaustive breakdown for this web automation codebase.
> Each sub-item is marked with completion status and links to the implementing test file.

---

## Legend
- `[x]` — Completed and verified green
- `[/]` — Partially done
- `[ ]` — Not started

---

## 1. Unit Testing (pre-existing)

> Already the strongest layer. 80+ test files covering core logic.

- [x] Pure function tests — `gaussian-rng.test.ts`, `crypto-utils.test.ts`, `timings.test.ts`
- [x] Configuration validation — `config-store.test.ts`, `engine-config.test.ts`, `env-utils.test.ts`
- [x] Classification logic — `engine.test.ts`, `classification-gate.test.ts` (42 tests)
- [x] Serialization round-trips — `session-telemetry.test.ts`, `database.test.ts`
- [x] Edge-case boundary tests — `email-denylist.test.ts`, `misdirection-denylist.test.ts`, `dynamic-limit.test.ts`
- **Status:** ✅ Comprehensive — 80+ files, 1000+ tests pre-existing

---

## 2. Integration Testing

- [x] Database read/write round-trips — `database.test.ts`, `db-internals.test.ts`, `db-backup.test.ts`, `db-promotion.test.ts`
- [x] IPC message contract tests — `tests/server/ipc-contracts.test.ts` (14 tests, row-update/screenshot/review-now)
- [x] HTTP endpoint tests — `tests/server/audit-fp-integration.test.ts` (5 tests, real Express round-trip)
- [x] File-system integration — `config-store.test.ts`, `csv-import.test.ts`, `rename-recordings.test.ts`
- [ ] Redis integration — Token farm cache/retrieve, queue drain behavior, TTL expiry
- **Status:** ✅ Strong — only Redis integration remains (requires live Redis instance)

---

## 3. End-to-End / Smoke Tests (Playwright)

- [x] Happy-path flow — existing Playwright specs in `tests/smoke.spec.ts`
- [ ] Cookie banner dismissal — verify 3-tier cascade (native API → UI click → CSS hide)
- [ ] 2FA detection — verify modal scanner identifies authenticator prompts
- [ ] Cashier bounce detection — verify `/cashier/deposit` redirect triggers `soft_success_failed_cashier`
- [ ] Session lifecycle — fast-loop persistence vs. toxic context destruction
- **Status:** 🔨 Partial — Playwright infrastructure exists, but only basic smoke specs. Deeper flow tests need a live target.

---

## 4. Snapshot / Golden-File Testing

- [x] Stealth script snapshots — `tests/stealth/stealth-snapshots.test.ts` (29 tests, all 11 get*SpoofScript functions)
- [x] Fingerprint profile snapshots — `tests/profiles/fingerprint-determinism.test.ts` (16 tests, getConsistentHardware idempotency)
- [x] CDP command snapshots — `tests/core/config-schema-validation.test.ts` (13 tests, all 4 backends)
- [ ] HTML classification snapshots — save known DOM fragments + expected classifications, re-run classifier
- **Status:** ✅ Strong — core snapshot coverage in place, HTML classification snapshots are a stretch goal.

---

## 5. Property-Based / Fuzzing Tests

- [x] Fingerprint determinism — `tests/profiles/fingerprint-determinism.test.ts` (100 emails × 100 calls each)
- [x] Seed-stability — `tests/stealth/stealth-snapshots.test.ts` (all scripts produce valid JS via `new Function()`)
- [x] Timing bounds — `tests/core/flaky-detection.test.ts` (gaussianClamped 1000 calls within [min,max])
- [ ] Input sanitization fuzzing — malformed emails, passwords with special chars, unicode, zero-width chars
- [x] Proxy URL parsing — `tests/proxy/proxy-url-fuzzing.test.ts` (17 tests, null bytes, unicode, IPv6, @-in-password)
- [x] Classification exhaustiveness — `tests/core/classification-gate.test.ts` (42 tests, every body pattern × priority)
- **Status:** ✅ Strong — 5/6 sub-items done. Only input sanitization fuzzing remains.

---

## 6. Contract / Schema Testing

- [x] IPC message schema — `tests/server/ipc-contracts.test.ts` (14 tests, both directions)
- [x] API response schemas — `tests/server/audit-fp-integration.test.ts` (response shape validation)
- [x] Config schema — `tests/core/config-schema-validation.test.ts` (13 tests, all 4 framework backends)
- [ ] WebSocket/SSE message schema — validate every SSE broadcast payload against a TypeScript interface
- [ ] Database schema migration — verify CREATE TABLE / ALTER TABLE on fresh DB
- **Status:** ✅ Strong — 3/5 sub-items done.

---

## 7. Mutation Testing

- [x] Stryker config created — `stryker.config.mjs` targeting `engine.ts`, `login-flow.ts`, `profile-determinism.ts`
- [ ] **Run Stryker** — `npm i -D @stryker-mutator/core @stryker-mutator/vitest-runner && npx stryker run`
- [ ] Manual kill-mutation — flip `<` to `>` in block-rate threshold → verify test fails
- **Status:** ⚙️ Config only — needs dependency install + execution pass.

---

## 8. Static Analysis & Linting

- [x] TypeScript strict mode — `npm run typecheck` (noEmit)
- [ ] `as any` audit — `grep -rn "as any" src/` to find remaining unsafe casts
- [ ] ESLint rules — `no-explicit-any`, `no-floating-promises`, `@typescript-eslint/no-unsafe-assignment`
- [x] Qodana — `.github/workflows/qodana_code_quality.yml` exists
- [ ] Dead code detection — `ts-prune` or `knip` to find unexported/unused functions
- [ ] Circular dependency detection — `madge --circular` to find import cycles
- **Status:** 🔨 Partial — typecheck + Qodana in CI, but no eslint config or dead code tooling.

---

## 9. Security-Specific Testing

- [ ] Credential leak scanning — `gitleaks` / `trufflehog` on the repo
- [ ] Dependency vulnerability scanning — `npm audit`, Snyk, or Dependabot
- [x] Supply-chain verification — all GitHub Actions SHA-pinned in `ci.yml`, `fingerprint-rotation.yml`, `qodana_code_quality.yml`
- [ ] Input injection — verify user strings can't escape into shell commands, SQL, or JS eval
- [x] Endpoint auth testing — `/audit-fp` localhost guard verified in `audit-fp-integration.test.ts`
- [x] WAL mode enforcement — `sqlite-contention.test.ts` verifies WAL mode behavior
- **Status:** 🔨 Partial — 3/6 done. Needs gitleaks, npm audit, input injection tests.

---

## 10. Performance / Load Testing

- [x] Concurrency stress testing — `backend-concurrency.test.ts`, `auto-throttle.test.ts`
- [ ] Memory leak detection — long session loop with `process.memoryUsage()` sampling
- [x] Zombie process detection — `tests/services/zombie-detection.test.ts` (4 tests)
- [x] SQLite write contention — `tests/core/sqlite-contention.test.ts` (4 tests, 50 concurrent writes)
- [ ] Proxy pool exhaustion — drain pool to 0 → verify graceful degradation
- **Status:** ✅ Strong — 3/5 sub-items done.

---

## 11. Resilience / Chaos Testing

- [ ] Network failure injection — kill proxy mid-request → verify 30s watchdog fires
- [ ] DNS resolution failure — non-resolving domain → verify timeout + classification
- [ ] Malformed HTTP responses — truncated/garbage → verify classification gate handles them
- [ ] DB corruption simulation — corrupt credentials.sqlite → verify startup recovery
- [ ] Process crash recovery — kill Hermes child → verify parent restarts
- [ ] OOM simulation — constrain heap → verify graceful degradation
- **Status:** ⬜ Not started — requires controlled test harness with network/process mocking.

---

## 12. Visual / Screenshot Regression

- [x] Flow screenshot diffing — pixel-buffer level canvas noise diffing in `tests/stealth/visual-regression.test.ts` (16 tests)
  - [x] Same seed → identical pixel buffers (100 seeds verified)
  - [x] Different seeds → ≥80% unique fingerprints
  - [x] Noise bounds ≤ 2 per channel, alpha untouched
  - [x] Script-to-math consistency verified
- [x] Fingerprint visual verification — different emails → different canvas pixel output
- [x] Audio context spoof determinism — 50 seeds verified
- [ ] UI dashboard regression — snapshot rendered dashboard state (deferred: needs live dashboard)
- **Status:** ✅ Done (pixel-buffer level) — only UI dashboard snapshot deferred.

---

## 13. Behavioral / Telemetry-Driven Testing

- [ ] Outcome distribution analysis — query session_telemetry for anomalous outcome spikes
- [ ] Timing corridor validation — run getTimingCorrelation(), verify ranges haven't drifted
- [ ] Counterfactual audit — run findCounterfactual() on recent failures
- [ ] A/B cohort comparison — compare block rates between backends
- **Status:** ⬜ Not started — requires production telemetry data.

---

## 14. Configuration Drift Detection

- [x] Config schema validation — `tests/core/config-schema-validation.test.ts` (13 tests, all 4 backends)
- [ ] Profile staleness checks — verify rotation-ledger.json timestamp < 3 hours old
- [ ] Dependency drift — `npm outdated` automated check
- [ ] UA pool freshness — verify user-agent pools contain current browser versions
- **Status:** 🔨 Partial — 1/4 done.

---

## 15. Flaky Test Detection

- [x] Vitest repeat stress — `tests/core/flaky-detection.test.ts` (40 tests, shuffled ordering via `vitest.flaky.config.ts`)
  - [x] All spoof scripts verified stable
  - [x] Fingerprint, classifier, trigger detection verified stable
  - [x] gaussianClamped bounds invariant (1000 calls)
  - [x] Timing determinism (Date.now monotonicity, Promise.all ordering, concurrent lookups)
- [x] Seed-fixed reproducibility — all randomness-dependent functions tested
- [x] CI integration — 3-pass shuffled execution in `.github/workflows/ci.yml`
- [ ] CI flake tracking — per-test pass/fail rate tracking across CI runs (needs external tool like Datadog/TestDino)
- **Scripts:** `npm run test:flaky` → `npx vitest run --config vitest.flaky.config.ts`
- **Status:** ✅ Done — only external CI tracking tooling deferred.

---

## 16. Code Coverage Analysis

- [x] Line + branch coverage — `npm run test:coverage` (V8 provider, thresholds in `vitest.config.ts`)
  - [x] Lines: ≥30%, Functions: ≥35%, Branches: ≥22%, Statements: ≥30% (baseline thresholds set)
- [x] Coverage CI gate — coverage report uploaded as artifact in `ci.yml`
- [ ] Coverage gap analysis — sort uncovered files by importance (login-flow.ts, engine.ts, stealth-scripts.ts)
- [ ] Condition coverage — verify both branches of every if/else and switch case exercised
- [ ] Dead path detection — 0% coverage paths are either dead code or critical gaps
- **Status:** 🔨 Partial — infrastructure in place, but ratcheting and gap analysis not yet formalized.

---

## Summary

| # | Category | Status | Evidence |
|---|----------|--------|----------|
| 1 | Unit Testing | ✅ Complete | 80+ files, 1000+ tests pre-existing |
| 2 | Integration Testing | ✅ Strong | DB, IPC, HTTP, FS done; Redis deferred |
| 3 | E2E / Smoke (Playwright) | 🔨 Partial | Basic smoke only |
| 4 | Snapshot / Golden-File | ✅ Strong | Stealth, FP, CDP snapshots done |
| 5 | Property-Based / Fuzzing | ✅ Strong | 5/6 sub-items done |
| 6 | Contract / Schema | ✅ Strong | 3/5 sub-items done |
| 7 | Mutation Testing | ⚙️ Config only | Stryker config created, not yet run |
| 8 | Static Analysis & Linting | 🔨 Partial | Typecheck + Qodana; no ESLint |
| 9 | Security-Specific | 🔨 Partial | 3/6 done |
| 10 | Performance / Load | ✅ Strong | 3/5 done |
| 11 | Resilience / Chaos | ⬜ Not started | Needs mock harness |
| 12 | Visual / Screenshot | ✅ Done | 16 tests (pixel-buffer) |
| 13 | Behavioral / Telemetry | ⬜ Not started | Needs production data |
| 14 | Configuration Drift | 🔨 Partial | 1/4 done |
| 15 | Flaky Test Detection | ✅ Done | 40 tests + CI integration |
| 16 | Code Coverage Analysis | 🔨 Partial | Infrastructure in place |

### Priority Next Steps
1. **#11 Resilience/Chaos** — highest-impact gap (network failure, DB corruption, process crash)
2. **#7 Mutation Testing** — install Stryker + run it on the classifier
3. **#9 Security** — add `npm audit` and `gitleaks` to CI
4. **#8 Static Analysis** — add ESLint config with strict TS rules
5. **#14 Config Drift** — add rotation-ledger staleness + UA pool freshness checks
