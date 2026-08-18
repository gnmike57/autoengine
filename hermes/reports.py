"""#20 — Hermes Summary Reports

Generates a Markdown summary report from a list of event dicts.
Reports include credential counts, outcome breakdowns, credit
consumption, top failure reasons, and recommended next actions.
Saved to ``hermes/reports/`` with timestamped filenames.
"""
from __future__ import annotations

import datetime
import logging
from collections import Counter
from pathlib import Path

logger = logging.getLogger(__name__)

REPORTS_DIR = Path(__file__).parent / "reports"


def _ensure_reports_dir() -> Path:
    REPORTS_DIR.mkdir(parents=True, exist_ok=True)
    return REPORTS_DIR


def generate_run_summary(events: list[dict]) -> str:
    """Produce a Markdown report summarising *events*.

    Parameters
    ----------
    events:
        List of raw websocket event dicts.  Each is expected to have a
        ``data`` key with at least ``outcome`` and optionally
        ``creditsSpent``, ``credential``, ``error`` fields.

    Returns
    -------
    The Markdown report as a string.  The report is also written to
    ``hermes/reports/report-{timestamp}.md``.
    """
    total = len(events)
    outcomes: Counter[str] = Counter()
    failure_reasons: Counter[str] = Counter()
    credentials_seen: set[str] = set()
    total_credits = 0.0

    for ev in events:
        data = ev.get("data", {})
        outcome = str(data.get("outcome", "unknown"))
        outcomes[outcome] += 1

        cred = data.get("credential") or data.get("email") or data.get("username")
        if cred:
            credentials_seen.add(str(cred))

        total_credits += float(data.get("creditsSpent", 0.0))

        if outcome not in ("success", "requeue"):
            reason = data.get("error") or data.get("message") or outcome
            failure_reasons[str(reason)] += 1

    success_count = outcomes.get("success", 0)
    fail_count = sum(c for o, c in outcomes.items() if o not in ("success", "requeue"))
    requeue_count = outcomes.get("requeue", 0)
    success_rate = (success_count / total * 100) if total else 0.0

    top_failures = failure_reasons.most_common(5)

    # Build recommended actions
    actions: list[str] = []
    if success_rate < 50:
        actions.append("⚠️  Success rate below 50% — investigate top failure reasons urgently.")
    if any("selector" in r.lower() or "dom" in r.lower() for r, _ in top_failures):
        actions.append("🔧  DOM/selector failures detected — review engine.ts locators against latest page screenshots.")
    if any("proxy" in r.lower() or "tunnel" in r.lower() for r, _ in top_failures):
        actions.append("🌐  Infrastructure failures detected — rotate proxy endpoints or check tunnel health.")
    if any("rate" in r.lower() or "429" in r for r, _ in top_failures):
        actions.append("🐢  Rate-limiting detected — reduce concurrency and add back-off delays.")
    if requeue_count > total * 0.3:
        actions.append("🔁  High requeue rate — check if credential classification is correct.")
    if not actions:
        actions.append("✅  Run looks healthy. Continue monitoring.")

    # Assemble Markdown
    now = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
    lines = [
        f"# Hermes Run Summary — {now}",
        "",
        "## Overview",
        f"| Metric | Value |",
        f"|--------|-------|",
        f"| Total events | {total} |",
        f"| Unique credentials | {len(credentials_seen)} |",
        f"| Success | {success_count} |",
        f"| Failed | {fail_count} |",
        f"| Requeued | {requeue_count} |",
        f"| Success rate | {success_rate:.1f}% |",
        f"| Credits consumed | {total_credits:.2f} |",
        "",
        "## Outcome Breakdown",
    ]
    for outcome, count in outcomes.most_common():
        lines.append(f"- **{outcome}**: {count}")

    lines += ["", "## Top 5 Failure Reasons"]
    if top_failures:
        for i, (reason, count) in enumerate(top_failures, 1):
            lines.append(f"{i}. `{reason}` — {count} occurrence(s)")
    else:
        lines.append("_No failures recorded._")

    lines += ["", "## Recommended Actions"]
    for a in actions:
        lines.append(f"- {a}")

    report = "\n".join(lines) + "\n"

    # Persist to disk
    _ensure_reports_dir()
    ts = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%S")
    report_path = REPORTS_DIR / f"report-{ts}.md"
    report_path.write_text(report, encoding="utf-8")
    logger.info("Saved run summary to %s", report_path)

    return report
