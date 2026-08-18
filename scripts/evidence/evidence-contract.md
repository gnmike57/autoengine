# Automation Evidence Contract

## Identity and Denominator

Each planned matrix cell has one stable `cell_id` derived from `site`, `backend`, `variation`, and `repetition`. Each physical execution has a unique `run_id`. Each submit invocation has a unique `attempt_id` and an integer `invocation_index` from 1 through 4.

The matrix is immutable after execution begins. A cell may become `PASS`, `FAIL`, `BLOCKED`, `MISSING`, or `INCONCLUSIVE`, but it must never be removed from the denominator.

## Matrix CSV

Required columns are:

| Column | Contract |
|---|---|
| `cell_id` | Stable unique identifier generated before execution. |
| `site` | Source-registry site identifier. |
| `backend` | Source-registry backend identifier. |
| `variation` | Registered submit variation identifier. |
| `repetition` | Positive integer. |
| `status` | `PLANNED`, `RUNNING`, `PASS`, `FAIL`, `BLOCKED`, `MISSING`, or `INCONCLUSIVE`. |
| `run_id` | Unique non-secret execution identifier. |
| `outcome` | Recomputed canonical outcome. |
| `accepted_submit_count` | Number of accepted invocation records. |
| `action_count` | Number of physical submit actions. |
| `duration_ms` | Total cell execution duration. |
| `evidence_dir` | Relative or absolute artifact directory. |
| `failure_class` | Stable failure taxonomy when not PASS. |

## Invocation JSONL

Write one JSON object per invocation. Required fields are:

```json
{
  "cell_id": "stable-cell-id",
  "run_id": "run-id",
  "attempt_id": "run-id-attempt-1",
  "invocation_index": 1,
  "variation": "native_enter",
  "invoked": true,
  "accepted": true,
  "acceptance_signal_count": 3,
  "acceptance_signals": ["dom_mutation", "network_activity", "response_observed"],
  "response_class": "incorrect",
  "response_latency_ms": 412
}
```

The exported event must not contain plaintext email addresses, passwords, cookies, authorization headers, API keys, session tokens, or raw response bodies.

## Evidence Manifest

Every PASS cell must contain `evidence-manifest.json`:

```json
{
  "cell_id": "stable-cell-id",
  "run_id": "run-id",
  "dry_run": false,
  "action_count": 4,
  "started_at": "2026-08-03T00:00:00.000Z",
  "ended_at": "2026-08-03T00:00:08.000Z",
  "artifacts": {
    "video": {"path": "session.webm", "sha256": "..."},
    "dom": {"path": "dom.jsonl", "sha256": "..."},
    "coordinates": {"path": "coordinates.jsonl", "sha256": "..."},
    "network": {"path": "network.jsonl", "sha256": "..."},
    "playwright": {"path": "trace.zip", "sha256": "..."},
    "cdp": {"path": "cdp.jsonl", "sha256": "..."},
    "ai": {"path": "ai-verdict.json", "sha256": "..."}
  }
}
```

Artifact paths are resolved relative to the evidence directory unless absolute. Every artifact must be nonempty and its SHA-256 must match. The video must be playable and have positive duration when `ffprobe` is available.

## Canonical Recompute Rules

| Condition | Outcome |
|---|---|
| Accepted `temp_disabled` terminal | `TEMP_DISABLED_ACCOUNT_EXISTS` |
| Accepted `perm_disabled` terminal | `PERM_DISABLED_ACCOUNT_EXISTS` |
| Accepted verified `success` terminal | `SUCCESSFUL_LOGIN` |
| Exactly four invocation records, four physical actions, at least three accepted `incorrect` responses, no terminal conflict | `NO_ACCOUNT_CONFIRMED` |
| Anything else | `INCONCLUSIVE` |

A physical action is accepted only when at least two independent signals are present from DOM mutation, network activity, form-state change, and observed response. No accepted invocation may occur after a terminal signal.

## Artifact Naming

Use only non-secret identifiers:

```text
{evidence_root}/{cell_id}/{run_id}/
  evidence-manifest.json
  session.webm
  trace.zip
  dom.jsonl
  coordinates.jsonl
  network.jsonl
  cdp.jsonl
  ai-verdict.json
```

## Required Verification Outputs

The verifier writes `verification-report.json` and `EVIDENCE_INDEX.md`. A global PASS requires every planned cell to be accounted for, every PASS cell to reproduce from raw events, all required artifact channels and hashes to validate, and all redaction checks to pass.
