"""#17 — Hermes Timing Optimizer

Tracks timing parameters (e.g. page-load delays, retry intervals) alongside
success/failure outcomes.  Uses correlation analysis to suggest better values
and persists overrides to ``hermes/timing-overrides.json``.
"""
from __future__ import annotations

import json
import logging
import math
from dataclasses import dataclass, field
from pathlib import Path

logger = logging.getLogger(__name__)

OVERRIDES_PATH = Path(__file__).parent / "timing-overrides.json"


@dataclass
class _TimingSeries:
    values: list[float] = field(default_factory=list)
    outcomes: list[str] = field(default_factory=list)  # "success" | "fail"


class TimingOptimizer:
    """Collects timing/outcome pairs and suggests optimal values."""

    def __init__(self) -> None:
        self._series: dict[str, _TimingSeries] = {}

    # ------------------------------------------------------------------
    # Recording
    # ------------------------------------------------------------------

    def record(self, timing_name: str, value: float, outcome: str) -> None:
        """Record a single observation."""
        if timing_name not in self._series:
            self._series[timing_name] = _TimingSeries()
        s = self._series[timing_name]
        s.values.append(value)
        s.outcomes.append(outcome)

    # ------------------------------------------------------------------
    # Analysis
    # ------------------------------------------------------------------

    @staticmethod
    def _mean(xs: list[float]) -> float:
        return sum(xs) / len(xs) if xs else 0.0

    @staticmethod
    def _stddev(xs: list[float], mean: float) -> float:
        if len(xs) < 2:
            return 0.0
        return math.sqrt(sum((x - mean) ** 2 for x in xs) / (len(xs) - 1))

    @staticmethod
    def _pearson(xs: list[float], ys: list[float]) -> float:
        n = len(xs)
        if n < 3:
            return 0.0
        mx = sum(xs) / n
        my = sum(ys) / n
        num = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
        dx = math.sqrt(sum((x - mx) ** 2 for x in xs))
        dy = math.sqrt(sum((y - my) ** 2 for y in ys))
        if dx == 0 or dy == 0:
            return 0.0
        return num / (dx * dy)

    def suggest_adjustment(self, timing_name: str) -> float:
        """Return the suggested optimal value for *timing_name*.

        Strategy: compute the mean of values that produced successes.
        If there aren't enough data points, return the overall mean.
        """
        s = self._series.get(timing_name)
        if not s or not s.values:
            return 0.0

        success_vals = [v for v, o in zip(s.values, s.outcomes) if o == "success"]
        if success_vals:
            return round(self._mean(success_vals), 2)

        return round(self._mean(s.values), 2)

    def get_correlation(self, timing_name: str) -> float:
        """Return Pearson correlation between timing value and success (1/0)."""
        s = self._series.get(timing_name)
        if not s:
            return 0.0
        outcome_numeric = [1.0 if o == "success" else 0.0 for o in s.outcomes]
        return round(self._pearson(s.values, outcome_numeric), 4)

    # ------------------------------------------------------------------
    # Persistence
    # ------------------------------------------------------------------

    def apply_adjustment(self, timing_name: str, new_value: float) -> None:
        """Write the adjustment to ``timing-overrides.json``."""
        overrides: dict[str, float] = {}
        if OVERRIDES_PATH.exists():
            with open(OVERRIDES_PATH, "r") as fh:
                try:
                    overrides = json.load(fh)
                except json.JSONDecodeError:
                    overrides = {}
        overrides[timing_name] = new_value
        with open(OVERRIDES_PATH, "w") as fh:
            json.dump(overrides, fh, indent=2)
        logger.info("Applied timing override %s = %s", timing_name, new_value)

    @staticmethod
    def load_overrides() -> dict[str, float]:
        """Load current timing overrides from disk."""
        if OVERRIDES_PATH.exists():
            with open(OVERRIDES_PATH, "r") as fh:
                try:
                    return json.load(fh)
                except json.JSONDecodeError:
                    return {}
        return {}
