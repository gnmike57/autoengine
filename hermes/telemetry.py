"""#11 — Structured Failure Telemetry Feed

Provides a typed dataclass for parsing raw websocket row-update events
into structured failure telemetry records before enqueueing.
"""
from __future__ import annotations

import datetime
from dataclasses import dataclass, field


@dataclass
class FailureTelemetry:
    """Structured representation of a single failure event from the dashboard."""
    failure_type: str = ""
    consecutive_count: int = 0
    last_n_outcomes: list[str] = field(default_factory=list)
    screenshot_paths: list[str] = field(default_factory=list)
    recording_path: str = ""
    credits_spent: float = 0.0
    backend_used: str = ""
    proxy_region: str = ""
    timestamp: str = field(default_factory=lambda: datetime.datetime.now(datetime.timezone.utc).isoformat())


def parse_row_update(event: dict, recent_outcomes: list[str] | None = None) -> FailureTelemetry:
    """Convert a raw websocket row-update event into a FailureTelemetry record.

    Parameters
    ----------
    event:
        The raw JSON-decoded event from the websocket.  Expected to have
        a ``data`` key containing outcome/failure details.
    recent_outcomes:
        Optional sliding window of the last *N* outcomes so telemetry
        carries context.
    """
    data: dict = event.get("data", {})
    outcome: str = data.get("outcome", "")

    # Infer failure_type from outcome prefix
    match outcome.split("-")[0] if outcome else "":
        case "blocked":
            failure_type = "blocked"
        case "api":
            failure_type = "api-error"
        case "error":
            failure_type = "runtime-error"
        case "N/A":
            failure_type = "not-available"
        case _:
            failure_type = "unknown"

    # Collect screenshot paths from event data if present
    screenshots: list[str] = []
    if isinstance(data.get("screenshots"), list):
        screenshots = [str(p) for p in data["screenshots"]]
    elif data.get("screenshot"):
        screenshots = [str(data["screenshot"])]

    return FailureTelemetry(
        failure_type=failure_type,
        consecutive_count=data.get("consecutiveCount", 0),
        last_n_outcomes=list(recent_outcomes or []),
        screenshot_paths=screenshots,
        recording_path=str(data.get("recording", "")),
        credits_spent=float(data.get("creditsSpent", 0.0)),
        backend_used=str(data.get("backend", "")),
        proxy_region=str(data.get("proxyRegion", "")),
    )

import time
from collections import defaultdict

_domain_requests: dict[str, list[float]] = defaultdict(list)

def track_request(domain: str) -> str | None:
    """
    Track requests per target domain.
    If a domain gets > 50 requests in a minute, return 'RATE_LIMIT_WARNING'.
    """
    now = time.time()
    timestamps = _domain_requests[domain]
    
    # Keep only timestamps within the last 60 seconds
    timestamps = [t for t in timestamps if now - t <= 60.0]
    timestamps.append(now)
    _domain_requests[domain] = timestamps
    
    if len(timestamps) > 50:
        return "RATE_LIMIT_WARNING"
        
    return None
