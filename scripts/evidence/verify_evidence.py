#!/usr/bin/env python3
"""Fail-closed verifier for browser-automation matrix, events, and evidence artifacts."""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
import re
import shutil
import statistics
import subprocess
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

REQUIRED_SENSORS = ("video", "dom", "coordinates", "network", "playwright", "cdp", "ai")
TERMINAL_MAP = {
    "temp_disabled": "TEMP_DISABLED_ACCOUNT_EXISTS",
    "perm_disabled": "PERM_DISABLED_ACCOUNT_EXISTS",
    "success": "SUCCESSFUL_LOGIN",
}
VALID_STATUSES = {"PLANNED", "RUNNING", "PASS", "FAIL", "BLOCKED", "MISSING", "INCONCLUSIVE"}
EMAIL_RE = re.compile(r"(?i)\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b")
SECRET_RE = re.compile(r'(?i)"(?:password|passwd|token|cookie|authorization|api[_-]?key)"\s*:\s*"(?!\[REDACTED\]|REDACTED|<redacted>|\*\*\*)[^\"]+"')


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def percentile(values: list[float], fraction: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    index = max(0, math.ceil(fraction * len(ordered)) - 1)
    return ordered[index]


def ffprobe_duration(path: Path) -> float | None:
    ffprobe = shutil.which("ffprobe")
    if not ffprobe:
        return None
    result = subprocess.run(
        [ffprobe, "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", str(path)],
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )
    if result.returncode != 0:
        return -1.0
    try:
        return float(result.stdout.strip())
    except ValueError:
        return -1.0


def load_jsonl(path: Path) -> tuple[list[dict[str, Any]], list[str]]:
    events: list[dict[str, Any]] = []
    failures: list[str] = []
    for line_number, raw in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not raw.strip():
            continue
        try:
            value = json.loads(raw)
        except json.JSONDecodeError as exc:
            failures.append(f"events:{line_number}:invalid-json:{exc.msg}")
            continue
        if not isinstance(value, dict):
            failures.append(f"events:{line_number}:not-object")
            continue
        events.append(value)
    return events, failures


def recompute_outcome(events: list[dict[str, Any]], manifest: dict[str, Any]) -> tuple[str, str]:
    if manifest.get("dry_run") is True:
        return "INCONCLUSIVE", "dry-run-disallowed"
    if int(manifest.get("action_count", 0) or 0) <= 0:
        return "INCONCLUSIVE", "zero-or-invalid-action-count"
    invocation_indices = [event.get("invocation_index") for event in events]
    if any(not isinstance(index, int) or index < 1 or index > 4 for index in invocation_indices):
        return "INCONCLUSIVE", "invalid-invocation-index"
    if len(events) > 4:
        return "INCONCLUSIVE", "too-many-invocation-records"
    if len(set(invocation_indices)) != len(invocation_indices):
        return "INCONCLUSIVE", "duplicate-invocation-evidence"
    invoked_count = sum(event.get("invoked") is True for event in events)
    if invoked_count != int(manifest.get("action_count", 0) or 0):
        return "INCONCLUSIVE", "action-count-evidence-mismatch"

    accepted = [event for event in events if event.get("accepted") is True]
    terminals = [(event, TERMINAL_MAP[event.get("response_class")]) for event in accepted if event.get("response_class") in TERMINAL_MAP]
    terminal_types = {outcome for _, outcome in terminals}
    if len(terminal_types) > 1:
        return "INCONCLUSIVE", "conflicting-terminal-evidence"
    if terminals:
        first_event, first_outcome = sorted(terminals, key=lambda pair: pair[0]["invocation_index"])[0]
        if any(event["invocation_index"] > first_event["invocation_index"] for event in accepted):
            return "INCONCLUSIVE", "accepted-submit-after-terminal-signal"
        return first_outcome, f"terminal-{first_event.get('response_class')}"
    if any(event.get("response_class") in {"challenge", "rate_limited"} for event in accepted):
        return "INCONCLUSIVE", "challenge-or-rate-limit"
    if any(event.get("response_class") != "incorrect" for event in accepted):
        return "INCONCLUSIVE", "accepted-response-not-incorrect"
    accepted_incorrect = [event for event in accepted if event.get("response_class") == "incorrect"]
    if len(events) == 4 and len(set(invocation_indices)) == 4 and len(accepted_incorrect) >= 3:
        return "NO_ACCOUNT_CONFIRMED", "four-invocation-envelope-with-three-accepted-incorrect-responses"
    return "INCONCLUSIVE", "insufficient-confirmed-accepted-submits"


def artifact_path(root: Path, evidence_dir: Path, value: Any) -> Path | None:
    if isinstance(value, str):
        candidate = Path(value)
    elif isinstance(value, dict) and isinstance(value.get("path"), str):
        candidate = Path(value["path"])
    else:
        return None
    if candidate.is_absolute():
        return candidate
    local = evidence_dir / candidate
    return local if local.exists() else root / candidate


def verify_cell(row: dict[str, str], cell_events: list[dict[str, Any]], root: Path) -> dict[str, Any]:
    result: dict[str, Any] = {"cell_id": row["cell_id"], "status": row.get("status", ""), "failures": [], "warnings": []}
    status = row.get("status", "")
    if status not in VALID_STATUSES:
        result["failures"].append(f"invalid-status:{status}")
    if status != "PASS":
        failure = "unaccounted-cell" if status in {"PLANNED", "RUNNING", ""} else f"cell-status-{status.lower()}"
        result["failures"].append(failure)
        return result

    evidence_dir_raw = row.get("evidence_dir", "").strip()
    if not evidence_dir_raw:
        result["failures"].append("missing-evidence-dir")
        return result
    evidence_dir = Path(evidence_dir_raw)
    if not evidence_dir.is_absolute():
        evidence_dir = root / evidence_dir
    manifest_path = evidence_dir / "evidence-manifest.json"
    if not manifest_path.is_file():
        result["failures"].append("missing-evidence-manifest")
        return result
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as exc:
        result["failures"].append(f"invalid-evidence-manifest:{exc}")
        return result
    if not isinstance(manifest, dict):
        result["failures"].append("manifest-not-object")
        return result

    if manifest.get("cell_id") != row["cell_id"]:
        result["failures"].append("cell-id-mismatch")
    if not manifest.get("run_id") or manifest.get("run_id") != row.get("run_id"):
        result["failures"].append("run-id-mismatch")
    artifacts = manifest.get("artifacts")
    if not isinstance(artifacts, dict):
        result["failures"].append("missing-artifact-map")
        artifacts = {}

    resolved_artifacts: dict[str, str] = {}
    for sensor in REQUIRED_SENSORS:
        value = artifacts.get(sensor)
        path = artifact_path(root, evidence_dir, value)
        if path is None or not path.is_file() or path.stat().st_size <= 0:
            result["failures"].append(f"missing-or-empty-{sensor}-artifact")
            continue
        resolved_artifacts[sensor] = str(path)
        expected_hash = value.get("sha256") if isinstance(value, dict) else None
        if not isinstance(expected_hash, str) or sha256_file(path) != expected_hash.lower():
            result["failures"].append(f"invalid-{sensor}-sha256")

    video_path = Path(resolved_artifacts["video"]) if "video" in resolved_artifacts else None
    if video_path:
        duration = ffprobe_duration(video_path)
        if duration == -1.0 or duration == 0.0:
            result["failures"].append("unplayable-or-zero-duration-video")
        elif duration is None:
            result["warnings"].append("ffprobe-unavailable-video-duration-not-measured")
        else:
            result["video_duration_sec"] = duration

    manifest_text = json.dumps(manifest, sort_keys=True)
    if EMAIL_RE.search(manifest_text):
        result["failures"].append("raw-email-in-manifest")
    if SECRET_RE.search(manifest_text):
        result["failures"].append("secret-value-in-manifest")

    run_id = manifest.get("run_id")
    filtered_events = [event for event in cell_events if event.get("run_id") == run_id]
    if len(filtered_events) != len(cell_events):
        result["failures"].append("event-run-id-mismatch")
    if any(EMAIL_RE.search(json.dumps(event, sort_keys=True)) for event in filtered_events):
        result["failures"].append("raw-email-in-events")
    if any(SECRET_RE.search(json.dumps(event, sort_keys=True)) for event in filtered_events):
        result["failures"].append("secret-value-in-events")

    recomputed, reason = recompute_outcome(filtered_events, manifest)
    result["recomputed_outcome"] = recomputed
    result["reason"] = reason
    if recomputed != row.get("outcome"):
        result["failures"].append("outcome-recompute-mismatch")
    if int(row.get("action_count") or 0) != int(manifest.get("action_count", 0) or 0):
        result["failures"].append("matrix-manifest-action-count-mismatch")
    accepted_count = sum(event.get("accepted") is True for event in filtered_events)
    if int(row.get("accepted_submit_count") or 0) != accepted_count:
        result["failures"].append("accepted-submit-count-mismatch")
    result["verified"] = not result["failures"]
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--matrix", type=Path, required=True)
    parser.add_argument("--events", type=Path, required=True)
    parser.add_argument("--evidence-root", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, default=Path("evidence-verification"))
    args = parser.parse_args()

    args.output_dir.mkdir(parents=True, exist_ok=True)
    with args.matrix.open(encoding="utf-8", newline="") as handle:
        rows = list(csv.DictReader(handle))
    if not rows:
        raise SystemExit("matrix contains no cells")
    ids = [row.get("cell_id", "") for row in rows]
    global_failures: list[str] = []
    if not all(ids) or len(ids) != len(set(ids)):
        global_failures.append("missing-or-duplicate-matrix-cell-id")

    events, event_failures = load_jsonl(args.events)
    global_failures.extend(event_failures)
    events_by_cell: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for event in events:
        cell = event.get("cell_id")
        if not isinstance(cell, str) or not cell:
            global_failures.append("event-missing-cell-id")
        else:
            events_by_cell[cell].append(event)

    cell_results = [verify_cell(row, events_by_cell.get(row["cell_id"], []), args.evidence_root) for row in rows]
    matrix_ids = set(ids)
    orphan_event_cells = sorted(set(events_by_cell) - matrix_ids)
    if orphan_event_cells:
        global_failures.append("orphan-event-cells:" + ",".join(orphan_event_cells))

    status_counts = Counter(row.get("status", "MISSING") for row in rows)
    outcome_counts = Counter(row.get("outcome", "") or "UNSET" for row in rows)
    breakdown: dict[str, Counter[str]] = {}
    for dimension in ("site", "backend", "variation"):
        counter: Counter[str] = Counter()
        for row in rows:
            counter[f"{row.get(dimension, '')}:{row.get('status', '')}"] += 1
        breakdown[dimension] = counter
    latencies = [float(row["duration_ms"]) for row in rows if row.get("duration_ms") not in {None, ""}]
    accepted = sum(int(row.get("accepted_submit_count") or 0) for row in rows)
    actions = sum(int(row.get("action_count") or 0) for row in rows)
    failures = global_failures + [f"{result['cell_id']}:{failure}" for result in cell_results for failure in result["failures"]]

    summary = {
        "global_pass": not failures,
        "planned_cells": len(rows),
        "status_counts": dict(status_counts),
        "outcome_counts": dict(outcome_counts),
        "accepted_submit_ratio": (accepted / actions) if actions else None,
        "latency_ms": {
            "count": len(latencies),
            "mean": statistics.fmean(latencies) if latencies else None,
            "median": statistics.median(latencies) if latencies else None,
            "p95": percentile(latencies, 0.95),
            "min": min(latencies) if latencies else None,
            "max": max(latencies) if latencies else None,
        },
        "breakdown": {dimension: dict(counter) for dimension, counter in breakdown.items()},
        "failure_count": len(failures),
        "failures": failures,
        "cell_results": cell_results,
    }
    (args.output_dir / "verification-report.json").write_text(json.dumps(summary, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    markdown = [
        "# Evidence Verification Report",
        "",
        f"**Global result:** {'PASS' if summary['global_pass'] else 'FAIL'}",
        "",
        f"**Planned cells:** {len(rows)}  ",
        f"**Failures:** {len(failures)}  ",
        f"**Accepted-submit ratio:** {summary['accepted_submit_ratio'] if summary['accepted_submit_ratio'] is not None else 'N/A'}",
        "",
        "| Status | Count |",
        "|---|---:|",
    ]
    markdown.extend(f"| {status} | {count} |" for status, count in sorted(status_counts.items()))
    markdown.extend(["", "## Failures", ""])
    markdown.extend([f"- `{failure}`" for failure in failures] or ["No failures."])
    (args.output_dir / "EVIDENCE_INDEX.md").write_text("\n".join(markdown) + "\n", encoding="utf-8")
    print(json.dumps({"global_pass": summary["global_pass"], "cells": len(rows), "failures": len(failures), "output_dir": str(args.output_dir.resolve())}, sort_keys=True))
    return 0 if summary["global_pass"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
