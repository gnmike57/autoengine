# Autonomous Decision-Making Upgrades for Hermes

This plan implements a strict execution boundary for AI-generated code, a durable rollback mechanism for experimental AI changes, and safeguards against infinite self-repair loops when reacting to DOM anomalies.

## User Review Required

> [!IMPORTANT]
> The sandbox uses Node.js `vm`, which prevents AST syntax errors and blocks `child_process`/`fs` module resolution, but it is not a perfect security sandbox against explicitly malicious actors. However, since the AI (Hermes) is generating the scripts locally, this effectively neutralizes hallucinations and destructive command execution (e.g. `rm -rf`). Is this acceptable for your threat model?

## Proposed Changes

---

### Database Schema Updates

#### [MODIFY] [database.ts](file:///Volumes/Macintosh_HD/Users/user294545/Downloads/autojoe/automation-engine-main/src/core/database.ts)
- Add a new table `ops_revisions` to the `initDB()` schema to track state changes and rollbacks durably:
```sql
CREATE TABLE IF NOT EXISTS ops_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  revision_type TEXT NOT NULL, -- 'timing' or 'skill'
  target_id TEXT NOT NULL,
  previous_state TEXT NOT NULL,
  new_state TEXT NOT NULL,
  applied_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  status TEXT DEFAULT 'active' -- 'active' or 'rolled_back'
);
```
- Add utility functions `insertRevision`, `getLastActiveRevision`, and `markRevisionRolledBack`.

---

### Sandboxed Validation & Automatic Rollback

#### [MODIFY] [ops-orchestrator.ts](file:///Volumes/Macintosh_HD/Users/user294545/Downloads/autojoe/automation-engine-main/src/hermes/ops-orchestrator.ts)
- Import `vm` from `node:vm`.
- Refactor `executeSkill` to run AI-generated scripts via `vm.runInNewContext(script, sandboxContext, { timeout: 5000 })` instead of `exec()`.
- Inject a restricted sandbox context containing only safe APIs (`console`, `fetch`, etc.).
- Update `postBatchAnalysis` to save `DynamicTimings` state to `ops_revisions` before reducing timing constants.
- Modify `evaluateTriggers` to monitor the `AnomalyDetector` for `batch_success_rate` drops. If success rate drops >10% over the last batch, trigger an automatic rollback:
  - Query `getLastActiveRevision`.
  - Restore `DynamicTimings` from `previous_state` (if timing change) or disable the OpsSkill (if skill change).
  - Mark the revision as `rolled_back`.

---

### Self-Repair Loop Prevention

#### [MODIFY] [hermes-observer.ts](file:///Volumes/Macintosh_HD/Users/user294545/Downloads/autojoe/automation-engine-main/src/hermes/hermes-observer.ts)
- Introduce a global cooldown mechanism `globalRepairCooldownUntil` (e.g., 1 hour) that halts self-repair if recently active.
- Track a history of failed repair attempts per anomaly type: `anomalyRepairHistory: Map<string, { attempts: number, lastAttemptAt: number, failedSuggestions: string[] }>`.
- In `suggestCorrection()`:
  - If a specific anomaly type has failed >2 times in the last 24 hours, halt self-repair and escalate via logging.
  - If global cooldown is active, skip repair.
  - Inject the history of previous failed suggestions directly into the LLM prompt, forcing it to generate a radically different approach (up to 5 recursive attempts).

---

## Verification Plan

### Automated Tests
- Run `npm run typecheck` to ensure no typing breaks introduced in `ops-orchestrator.ts`, `hermes-observer.ts`, or `database.ts`.

### Manual Verification
- Simulate a failing `batch_success_rate` anomaly in the orchestrator and verify that the database fetches the latest revision and successfully rolls back `DynamicTimings`.
- Trigger an AI OpsSkill containing `require('fs')` and verify that the `vm` sandbox instantly catches it and throws a strict validation error.
- Trigger consecutive DOM anomalies and verify the "radically different approach" prompt is sent, and the 1-hour global cooldown is enforced after application.
