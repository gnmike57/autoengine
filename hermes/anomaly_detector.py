"""#18 — Hermes Anomaly Detection

Rolling-statistics anomaly detector.  Tracks mean and standard deviation
for named metrics and fires an alert when a new value deviates by more
than 2 standard deviations from the rolling mean.
"""
from __future__ import annotations

import datetime
import logging
import math
from dataclasses import dataclass, field

logger = logging.getLogger(__name__)


@dataclass
class AnomalyAlert:
    """Returned by ``AnomalyDetector.check`` when a value is anomalous."""
    metric_name: str
    value: float
    mean: float
    stddev: float
    deviation_sigma: float
    timestamp: str = field(
        default_factory=lambda: datetime.datetime.now(datetime.timezone.utc).isoformat()
    )

    def __str__(self) -> str:
        return (
            f"ANOMALY [{self.metric_name}]: value={self.value:.3f}, "
            f"mean={self.mean:.3f}, stddev={self.stddev:.3f}, "
            f"deviation={self.deviation_sigma:.1f}σ"
        )


@dataclass
class _RollingStat:
    """Welford's online algorithm for mean + variance."""
    count: int = 0
    mean: float = 0.0
    m2: float = 0.0
    window: list[float] = field(default_factory=list)
    max_window: int = 200

    def update(self, value: float) -> None:
        self.window.append(value)
        if len(self.window) > self.max_window:
            self.window.pop(0)
        self.count += 1
        delta = value - self.mean
        self.mean += delta / self.count
        delta2 = value - self.mean
        self.m2 += delta * delta2

    @property
    def variance(self) -> float:
        return self.m2 / self.count if self.count >= 2 else 0.0

    @property
    def stddev(self) -> float:
        return math.sqrt(self.variance)


class AnomalyDetector:
    """Tracks rolling statistics and alerts on >2σ deviations.

    Recommended metrics to track:
        - ``session_duration``
        - ``credits_per_credential``
        - ``success_rate_per_hour``
    """

    def __init__(self, sigma_threshold: float = 2.0) -> None:
        self._stats: dict[str, _RollingStat] = {}
        self.sigma_threshold = sigma_threshold

    def _ensure(self, metric_name: str) -> _RollingStat:
        if metric_name not in self._stats:
            self._stats[metric_name] = _RollingStat()
        return self._stats[metric_name]

    def record(self, metric_name: str, value: float) -> None:
        """Record a new value for *metric_name* (updates rolling stats)."""
        self._ensure(metric_name).update(value)

    def check(self, metric_name: str, value: float) -> AnomalyAlert | None:
        """Record *value* and return an ``AnomalyAlert`` if it is anomalous.

        A value is anomalous when it deviates by more than
        ``self.sigma_threshold`` standard deviations from the rolling mean.
        Returns ``None`` when the value is within normal range or when
        there are too few data points (< 5) to judge.
        """
        stat = self._ensure(metric_name)
        stat.update(value)

        if stat.count < 5:
            return None  # not enough data

        if stat.stddev == 0:
            return None  # no variance — all values identical

        deviation = abs(value - stat.mean) / stat.stddev
        if deviation > self.sigma_threshold:
            alert = AnomalyAlert(
                metric_name=metric_name,
                value=value,
                mean=stat.mean,
                stddev=stat.stddev,
                deviation_sigma=round(deviation, 2),
            )
            logger.warning("%s", alert)
            return alert
        return None

    def get_stats(self, metric_name: str) -> dict:
        """Return current rolling stats for a metric."""
        stat = self._stats.get(metric_name)
        if not stat:
            return {}
        return {
            "count": stat.count,
            "mean": round(stat.mean, 4),
            "stddev": round(stat.stddev, 4),
            "last_5": stat.window[-5:],
        }
