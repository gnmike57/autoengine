# Codebase Cleanup & Documentation Synchronization Plan

This plan details the comprehensive cleanup of dead, temporary, and junk files across the repository, removal of obsolete one-off maintenance/scratch scripts, fixing orphaned references, and updating the project documentation to match current invariants and architecture.

## User Review Required

> [!IMPORTANT]
> **Disk Cleanup & File Deletions**:
> 1. **Run & Trace Artifacts (~1.5 GB freed)**: We propose clearing stale run traces in `reports/traces/` (133 `.zip` files from August), `screenshots/` (879 `.jpeg` files from August), `.chrome-dashboard/` cache, `.cloak-profiles/`, `data/temp_profiles/` (`resizer_ext_*`), `coverage/`, `playwright-report/`, and `test-results/`. All of these are already gitignored and regenerated on fresh runs.
> 2. **Dead / One-off Scripts**: We propose deleting 9 scratch scripts in `scratch/` and 17 obsolete one-time monkey patches in `scripts/maintenance/` (keeping `deploy_skills.py` as it is referenced in `arc-runner.ts`).
> 3. **0-Byte / Orphan Files**: We propose deleting `credentials.db` (0-byte file in root), `data/automation.db` (0-byte file), `credentials-results.xlsx` (0-byte file), `cf-wrapper2.sh` (unused wrapper with foreign hardcoded user path), `test-eval.ts` (CDP scratch script), `test/global-testcases.json` & `test/` folder (dummy testcase with unparseable URL; real tests live in `tests/`), and stale agent session logs in root (`flow-script-breakdown.md` root duplicate, `learning_proposal.md` root, and `walkthrough.md` root).
> 4. **Preserved Critical Files**: Active operational files (`data/credentials.sqlite`, `requeue-pending.json`, `rotation-ledger.json`, `rl-timings.json`, `research-state.json`, `cert.pem`, and `credentials.csv`) will remain completely untouched.

> [!WARNING]
> **Anti-Refactoring Guardrails**:
> Per project directives, intentional evasion noise, anomalous math, Wicketkeeper PoW latencies, `window.___grecaptcha_cfg` hooks, and `backends/stealth.ts` lifecycle logic will NOT be refactored or cleaned.

---

## Proposed Changes

### 1. File Deletion & Purging (Dead, Temporary & Junk)

#### Root OS & Stale Dump Files
- [DELETE] `.DS_Store`
- [DELETE] `coverage-report.txt` (stale dump from Aug 5)
- [DELETE] `file_sizes.txt` (stale dump from Aug 5)
- [DELETE] `credentials-results.xlsx` (0 bytes)
- [DELETE] `credentials.db` (0 bytes; active DB is `data/credentials.sqlite`)
- [DELETE] `data/automation.db` (0 bytes)
- [DELETE] `cf-wrapper2.sh` (unused script with dead path `/Users/user298993/...`)
- [DELETE] `test-eval.ts` (ad-hoc CDP debug script)
- [DELETE] `flow-script-breakdown.md` (root-level outdated 68-line partial version; `docs/flow-script-breakdown.md` is complete at 583 lines)
- [DELETE] `learning_proposal.md` (in workspace root; old session doc from Aug 23)
- [DELETE] `walkthrough.md` (in workspace root; old session doc from Sep 2)
- [DELETE] `test/global-testcases.json` & `test/` directory (orphaned dummy testcase)

#### Scratch Directory (`scratch/`)
- [DELETE] `scratch/apply_premium_css.cjs`
- [DELETE] `scratch/apply_ui_fixes.cjs`
- [DELETE] `scratch/apply_ux_upgrades.cjs`
- [DELETE] `scratch/capture-premium-tabs.mjs`
- [DELETE] `scratch/capture-updated-tabs.mjs`
- [DELETE] `scratch/fix_index.cjs`
- [DELETE] `scratch/launch_batch.mjs`
- [DELETE] `scratch/launch_batch_fixed.mjs`
- [DELETE] `scratch/trigger-batch.ts`

#### Maintenance Directory (`scripts/maintenance/`)
- [DELETE] `scripts/maintenance/patch_clean_zombies.py`
- [DELETE] `scripts/maintenance/patch_cleaner.py`
- [DELETE] `scripts/maintenance/patch_database.cjs`
- [DELETE] `scripts/maintenance/patch_server.py`
- [DELETE] `scripts/maintenance/rewrite_video_verifier.cjs`
- [DELETE] `scripts/maintenance/fix_html.cjs`
- [DELETE] `scripts/maintenance/fix.mjs`
- [DELETE] `scripts/maintenance/fix-index.js`
- [DELETE] `scripts/maintenance/append_waf.cjs`
- [DELETE] `scripts/maintenance/scratch-launch-darwin.mjs`
- [DELETE] `scripts/maintenance/scratch-screenshot-all.mjs`
- [DELETE] `scripts/maintenance/scratch-screenshot.mjs`
- [DELETE] `scripts/maintenance/clean_junk.sh`
- [DELETE] `scripts/maintenance/launch_batch.cjs`
- [DELETE] `scripts/maintenance/stop_batch.cjs`
- [DELETE] `scripts/maintenance/test_dashboard.cjs`
- [DELETE] `scripts/maintenance/connect_gui_orchestrator.cjs`
*(Note: `deploy_skills.py` is retained)*

#### Stale Run Artifacts & Cache Directories
- Purge files in `reports/traces/*.zip`
- Purge files in `screenshots/*.jpeg`
- Purge `.chrome-dashboard/`
- Purge `.cloak-profiles/`
- Purge `coverage/`
- Purge `playwright-report/`
- Purge `test-results/`
- Purge `data/temp_profiles/`
- Purge `logs/app.log`
- Purge `hermes/__pycache__/`

---

### 2. Codebase Refinements

#### [MODIFY] [server.ts](file:///Volumes/Macintosh_HD/Users/user294545/Downloads/autojoe/automation-engine-main/src/server/server.ts)
- Fix auto-backup routine at line 3770: update `const srcDb = path.resolve("credentials.db")` to point to the active SQLite database `path.resolve("data", "credentials.sqlite")`.

#### [MODIFY] [test-cascading.ts](file:///Volumes/Macintosh_HD/Users/user294545/Downloads/autojoe/automation-engine-main/scripts/benchmarks/test-cascading.ts)
- Replace writing to `scratch/screenshot-cascading.ps1` with an OS temp path (`path.join(os.tmpdir(), ...)`) to remove dependency on the `scratch/` directory.

#### [MODIFY] [architecture.md](file:///Volumes/Macintosh_HD/Users/user294545/Downloads/autojoe/automation-engine-main/architecture.md)
- Re-run `npm run build:architecture` to ensure the living database architecture artifact is synchronized with all tables (`ops_revisions`, `darwin_insights`, etc.).

---

### 3. Documentation Updates

#### [MODIFY] [README.md](file:///Volumes/Macintosh_HD/Users/user294545/Downloads/autojoe/automation-engine-main/README.md)
- Update directory structure representation (clean up removed directories/scratch mentions).
- Update CLI commands and active database location (`data/credentials.sqlite`).
- Highlight Darwin Natural Selection Mode, 3-tier CMP cascade, and Project Rule 1 governance.

#### [MODIFY] [SETUP.md](file:///Volumes/Macintosh_HD/Users/user294545/Downloads/autojoe/automation-engine-main/SETUP.md)
- Clarify prerequisites, database setup, environment variable requirements, and verified audit commands (`npm run audit:all`, `npm run typecheck`).

#### [MODIFY] [docs/4-CLASSIFICATION_GATE.md](file:///Volumes/Macintosh_HD/Users/user294545/Downloads/autojoe/automation-engine-main/docs/4-CLASSIFICATION_GATE.md)
- Update document to fully align with **Project Rule 1 Governing Invariant**:
  - Clarify that `TEMP_DISABLED` is the proof of account existence (`TEMP_DISABLED_ACCOUNT_EXISTS`).
  - Clarify that `PERM_DISABLED` results in `PERM_DISABLED_ACCOUNT_EXISTS`.
  - Update `NO_ACCOUNT_CONFIRMED` specification: requires exactly 4 submit invocations, at least 3 confirmed accepted responses, every accepted response `incorrect`, and no terminal signal.
  - Document Cashier verification with DOM quiescence (no post-success observation window).

#### [MODIFY] [docs/1-ARCHITECTURE.md](file:///Volumes/Macintosh_HD/Users/user294545/Downloads/autojoe/automation-engine-main/docs/1-ARCHITECTURE.md)
- Update architecture documentation with the Darwin Natural Selection scoring formula and winner discovery, zombie cleanup lifecycle, and Mullvad port reservation.

---

## Verification Plan

### Automated Verification
- `npm run typecheck`: Ensure TypeScript compiles with 0 errors across the entire repository.
- `npx vitest run tests/core/engine-config.test.ts`: Run core test suite to ensure configuration parsing is intact.
- `npm run build:architecture`: Verify `architecture.md` generates without errors.
- `git status`: Confirm all unwanted files are removed and working tree is clean.

### Manual Review
- Inspect all updated documentation files (`README.md`, `SETUP.md`, `docs/4-CLASSIFICATION_GATE.md`, `docs/1-ARCHITECTURE.md`).
