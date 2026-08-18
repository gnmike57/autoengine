"""#13 — Hermes Screenshot Diff Analysis

Compares a reference screenshot to a current screenshot using PIL/Pillow.
Computes pixel-level structural similarity, perceptual hash distance,
and dominant-colour shift.
"""
from __future__ import annotations

import logging
import math
from pathlib import Path

try:
    from PIL import Image
except ImportError:  # graceful degradation
    Image = None  # type: ignore[assignment,misc]

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _load_image(path: str) -> "Image.Image":
    if Image is None:
        raise RuntimeError("Pillow is not installed — run `pip install Pillow`")
    return Image.open(path).convert("RGB")


def _pixel_diff_percentage(img_a: "Image.Image", img_b: "Image.Image") -> float:
    """Return the percentage of pixels that differ (threshold > 30 per channel)."""
    a_pixels = list(img_a.getdata())
    b_pixels = list(img_b.getdata())
    if len(a_pixels) != len(b_pixels):
        return 100.0
    threshold = 30
    diff_count = sum(
        1 for pa, pb in zip(a_pixels, b_pixels)
        if any(abs(ca - cb) > threshold for ca, cb in zip(pa, pb))
    )
    return (diff_count / len(a_pixels)) * 100.0


def _average_hash(img: "Image.Image", size: int = 8) -> int:
    """Compute a simple average perceptual hash."""
    resized = img.resize((size, size), Image.LANCZOS)
    grey = resized.convert("L")
    pixels = list(grey.getdata())
    avg = sum(pixels) / len(pixels)
    bits = 0
    for px in pixels:
        bits = (bits << 1) | (1 if px >= avg else 0)
    return bits


def _hamming_distance(h1: int, h2: int) -> int:
    return bin(h1 ^ h2).count("1")


def _dominant_color(img: "Image.Image") -> tuple[float, float, float]:
    """Return the average colour as a simple dominant colour proxy."""
    pixels = list(img.getdata())
    n = len(pixels)
    r = sum(p[0] for p in pixels) / n
    g = sum(p[1] for p in pixels) / n
    b = sum(p[2] for p in pixels) / n
    return (r, g, b)


def _color_distance(c1: tuple[float, float, float], c2: tuple[float, float, float]) -> float:
    return math.sqrt(sum((a - b) ** 2 for a, b in zip(c1, c2)))


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def compare_screenshots(reference_path: str, current_path: str) -> dict:
    """Compare two screenshots and return a structured diff result.

    Returns
    -------
    dict with keys:
        similarity   — 0-100 float (100 = identical)
        hash_distance — integer Hamming distance of perceptual hashes
        color_shift  — Euclidean distance of dominant colours (0 = same)
        is_anomalous — True if diff exceeds safe thresholds
    """
    ref = _load_image(reference_path)
    cur = _load_image(current_path)

    # Resize to same dimensions for fair comparison
    target_size = (min(ref.width, cur.width), min(ref.height, cur.height))
    ref = ref.resize(target_size, Image.LANCZOS)
    cur = cur.resize(target_size, Image.LANCZOS)

    diff_pct = _pixel_diff_percentage(ref, cur)
    similarity = max(0.0, 100.0 - diff_pct)

    ref_hash = _average_hash(ref)
    cur_hash = _average_hash(cur)
    hash_dist = _hamming_distance(ref_hash, cur_hash)

    ref_color = _dominant_color(ref)
    cur_color = _dominant_color(cur)
    color_shift = _color_distance(ref_color, cur_color)

    is_anomalous = diff_pct > 20.0

    result = {
        "similarity": round(similarity, 2),
        "hash_distance": hash_dist,
        "color_shift": round(color_shift, 2),
        "is_anomalous": is_anomalous,
    }
    logger.info("Screenshot diff result: %s", result)
    return result
