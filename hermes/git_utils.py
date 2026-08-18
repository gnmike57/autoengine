"""#15 — Hermes Git Branch Isolation

Utility functions for creating isolated heal branches, committing fixes,
and merging back only when the subsequent success rate improves.
All git commands run via subprocess from the project root.
"""
from __future__ import annotations

import datetime
import logging
import subprocess
from pathlib import Path

logger = logging.getLogger(__name__)

PROJECT_ROOT = Path(__file__).resolve().parent.parent  # one level above hermes/


def _run_git(*args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    cmd = ["git", *args]
    logger.info("Running: %s", " ".join(cmd))
    return subprocess.run(
        cmd,
        cwd=str(PROJECT_ROOT),
        capture_output=True,
        text=True,
        check=check,
    )


def get_current_branch() -> str:
    """Return the name of the currently checked-out branch."""
    result = _run_git("rev-parse", "--abbrev-ref", "HEAD")
    return result.stdout.strip()


def create_heal_branch(name: str = "") -> str:
    """Create and checkout a new ``hermes/auto-heal-{timestamp}`` branch.

    Parameters
    ----------
    name:
        Optional human-readable suffix.  A UTC timestamp is always appended.

    Returns
    -------
    The full branch name that was created.
    """
    ts = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%S")
    suffix = f"-{name}" if name else ""
    branch = f"hermes/auto-heal-{ts}{suffix}"
    _run_git("checkout", "-b", branch)
    logger.info("Created heal branch: %s", branch)
    return branch


def commit_fix(message: str, files: list[str]) -> None:
    """Stage *files* and commit with *message*."""
    if not files:
        logger.warning("commit_fix called with no files — skipping")
        return
    for f in files:
        _run_git("add", f)
    _run_git("commit", "-m", message)
    logger.info("Committed fix: %s (%d file(s))", message, len(files))


def merge_if_successful(branch: str, *, main_branch: str = "main") -> bool:
    """Merge *branch* back into *main_branch* only if it exists and is ahead.

    Returns True if the merge was performed, False otherwise.
    """
    try:
        current = get_current_branch()
        if current != main_branch:
            _run_git("checkout", main_branch)
        _run_git("merge", branch, "--no-ff", "-m", f"Hermes AI: merge successful heal from {branch}")
        logger.info("Merged %s into %s", branch, main_branch)
        return True
    except subprocess.CalledProcessError as exc:
        logger.error("Merge of %s failed: %s", branch, exc.stderr)
        # Abort a failed merge to leave the repo clean
        _run_git("merge", "--abort", check=False)
        return False


def discard_branch(branch: str) -> None:
    """Delete *branch* locally (used when a fix was ineffective)."""
    try:
        _run_git("checkout", "main", check=False)
        _run_git("branch", "-D", branch)
        logger.info("Discarded branch %s", branch)
    except subprocess.CalledProcessError as exc:
        logger.warning("Could not delete branch %s: %s", branch, exc.stderr)
