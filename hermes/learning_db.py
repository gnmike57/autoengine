"""#12 — Hermes Learning Database

SQLite-backed database that records every healing action, tracks
effectiveness, and lets the agent query which fixes historically
worked (or failed) for a given symptom.
"""
from __future__ import annotations

import datetime
import os
import sqlite3
from dataclasses import dataclass
from pathlib import Path

DB_PATH = Path(__file__).parent / "hermes-learning.db"

_CREATE_TABLE = """
CREATE TABLE IF NOT EXISTS healing_actions (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp           TEXT    NOT NULL,
    symptom             TEXT    NOT NULL,
    fix_applied         TEXT    NOT NULL,
    file_modified       TEXT    NOT NULL DEFAULT '',
    success_rate_before REAL    NOT NULL DEFAULT 0.0,
    success_rate_after  REAL    NOT NULL DEFAULT 0.0,
    effective           BOOLEAN NOT NULL DEFAULT 0
);
"""

_INSERT = """
INSERT INTO healing_actions (timestamp, symptom, fix_applied, file_modified,
                             success_rate_before, success_rate_after, effective)
VALUES (?, ?, ?, ?, ?, ?, ?);
"""


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    conn.execute(_CREATE_TABLE)
    conn.commit()
    return conn


@dataclass
class HealingRecord:
    id: int
    timestamp: str
    symptom: str
    fix_applied: str
    file_modified: str
    success_rate_before: float
    success_rate_after: float
    effective: bool


def record_healing(
    symptom: str,
    fix: str,
    file: str,
    *,
    success_rate_before: float = 0.0,
    success_rate_after: float = 0.0,
    effective: bool | None = None,
) -> int:
    """Persist a healing action.  Returns the row id."""
    if effective is None:
        effective = success_rate_after > success_rate_before
    now = datetime.datetime.now(datetime.timezone.utc).isoformat()
    conn = _connect()
    try:
        cur = conn.execute(_INSERT, (now, symptom, fix, file,
                                     success_rate_before, success_rate_after,
                                     int(effective)))
        conn.commit()
        return cur.lastrowid  # type: ignore[return-value]
    finally:
        conn.close()


def get_effective_fixes(symptom: str) -> list[HealingRecord]:
    """Return fixes that historically improved the success rate for *symptom*."""
    conn = _connect()
    try:
        rows = conn.execute(
            "SELECT * FROM healing_actions WHERE symptom = ? AND effective = 1 ORDER BY timestamp DESC",
            (symptom,),
        ).fetchall()
        return [HealingRecord(**dict(r)) for r in rows]
    finally:
        conn.close()


def get_ineffective_fixes(symptom: str) -> list[HealingRecord]:
    """Return fixes that did NOT help for *symptom*."""
    conn = _connect()
    try:
        rows = conn.execute(
            "SELECT * FROM healing_actions WHERE symptom = ? AND effective = 0 ORDER BY timestamp DESC",
            (symptom,),
        ).fetchall()
        return [HealingRecord(**dict(r)) for r in rows]
    finally:
        conn.close()


def get_all_records(limit: int = 100) -> list[HealingRecord]:
    """Return the most recent healing records."""
    conn = _connect()
    try:
        rows = conn.execute(
            "SELECT * FROM healing_actions ORDER BY timestamp DESC LIMIT ?",
            (limit,),
        ).fetchall()
        return [HealingRecord(**dict(r)) for r in rows]
    finally:
        conn.close()
