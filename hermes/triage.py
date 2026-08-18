"""#19 — Hermes Credential Triage

Classifies a failure event into one of five categories and maps each
to a remediation strategy string the agent can act on.
"""
from __future__ import annotations

import logging
import re

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Failure categories and their remediation strategies
# ---------------------------------------------------------------------------

REMEDIATION: dict[str, str] = {
    "infrastructure": (
        "Rotate proxy or tunnel endpoint. Check VPN status and retry with "
        "a different proxy_region. Verify that the backend service is reachable."
    ),
    "site_change": (
        "DOM structure has likely changed. Inspect the latest Markdown dump "
        "and screenshot, then update Playwright selectors in engine.ts."
    ),
    "credential_invalid": (
        "Credential is permanently invalid (disabled/noaccount). Mark as "
        "tested-bad and dequeue. Do NOT retry."
    ),
    "rate_limited": (
        "Too many attempts detected. Back off for 5-10 minutes, rotate IP, "
        "and reduce concurrency before retrying."
    ),
    "unknown": (
        "Failure could not be categorised. Collect screenshots and logs, "
        "escalate to the full diagnostic pipeline."
    ),
}

# ---------------------------------------------------------------------------
# Pattern sets (case-insensitive)
# ---------------------------------------------------------------------------

_INFRA_PATTERNS: list[re.Pattern[str]] = [
    re.compile(r"proxy", re.I),
    re.compile(r"tunnel", re.I),
    re.compile(r"ECONNREFUSED", re.I),
    re.compile(r"ETIMEDOUT", re.I),
    re.compile(r"socket hang up", re.I),
    re.compile(r"network\s*error", re.I),
    re.compile(r"ERR_CONNECTION", re.I),
    re.compile(r"502|503|504", re.I),
]

_SITE_CHANGE_PATTERNS: list[re.Pattern[str]] = [
    re.compile(r"selector", re.I),
    re.compile(r"locator", re.I),
    re.compile(r"DOM", re.I),
    re.compile(r"element not found", re.I),
    re.compile(r"timeout waiting", re.I),
    re.compile(r"page\s*changed", re.I),
    re.compile(r"unexpected\s*(modal|dialog|popup)", re.I),
]

_CRED_INVALID_PATTERNS: list[re.Pattern[str]] = [
    re.compile(r"noaccount", re.I),
    re.compile(r"disabled", re.I),
    re.compile(r"invalid.*credential", re.I),
    re.compile(r"account.*not.*found", re.I),
    re.compile(r"deactivated", re.I),
]

_RATE_LIMIT_PATTERNS: list[re.Pattern[str]] = [
    re.compile(r"rate.?limit", re.I),
    re.compile(r"too many (attempts|requests)", re.I),
    re.compile(r"429", re.I),
    re.compile(r"throttl", re.I),
    re.compile(r"captcha", re.I),
]


def _matches(text: str, patterns: list[re.Pattern[str]]) -> bool:
    return any(p.search(text) for p in patterns)


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def classify_failure(event: dict) -> str:
    """Classify *event* into a failure category.

    Parameters
    ----------
    event:
        Raw websocket event dict (expects ``data.outcome`` and optionally
        ``data.error`` or ``data.message`` fields).

    Returns
    -------
    One of: ``'infrastructure'``, ``'site_change'``, ``'credential_invalid'``,
    ``'rate_limited'``, ``'unknown'``.
    """
    data = event.get("data", {})
    outcome = str(data.get("outcome", ""))
    error = str(data.get("error", ""))
    message = str(data.get("message", ""))
    blob = f"{outcome} {error} {message}"

    if _matches(blob, _CRED_INVALID_PATTERNS):
        category = "credential_invalid"
    elif _matches(blob, _RATE_LIMIT_PATTERNS):
        category = "rate_limited"
    elif _matches(blob, _SITE_CHANGE_PATTERNS):
        category = "site_change"
    elif _matches(blob, _INFRA_PATTERNS):
        category = "infrastructure"
    else:
        category = "unknown"

    logger.info("Triage classified event as '%s' — outcome='%s'", category, outcome)
    return category


def get_remediation(category: str) -> str:
    """Return the remediation strategy string for *category*."""
    return REMEDIATION.get(category, REMEDIATION["unknown"])

def cluster_errors(errors: list[str]) -> dict:
    """Group similar error strings together based on word-overlap (Jaccard similarity)."""
    clusters: dict[str, list[str]] = {}
    
    def get_words(text: str) -> set[str]:
        return set(re.findall(r'\w+', text.lower()))
        
    for error in errors:
        words = get_words(error)
        matched_cluster = None
        
        for cluster_rep in clusters:
            rep_words = get_words(cluster_rep)
            union_len = len(words | rep_words)
            if union_len == 0:
                if len(words) == 0:
                    matched_cluster = cluster_rep
                    break
                continue
            
            jaccard = len(words & rep_words) / union_len
            if jaccard > 0.5:
                matched_cluster = cluster_rep
                break
                
        if matched_cluster is not None:
            clusters[matched_cluster].append(error)
        else:
            clusters[error] = [error]
            
    return clusters
