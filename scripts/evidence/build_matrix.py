#!/usr/bin/env python3
"""Build deterministic login-step evidence matrices with stable cell identifiers."""
from __future__ import annotations

import argparse
import csv
import hashlib
import itertools
import json
from pathlib import Path
from typing import Any

CANONICAL_SUBMIT_VARIATIONS = [
    "enter_in_password",
    "click",
    "click_offset",
    "locator_click",
    "locator_click_actionable",
    "locator_click_position",
    "locator_press_enter",
    "locator_press_space",
    "button_enter",
    "tab_enter",
    "tab_space",
    "dispatch_click",
    "request_submit",
    "js_submit",
    "cdp_mouse_click",
    "cdp_key_enter",
]
CANONICAL_DISCOVERY_VARIATIONS = [
    "configured_css",
    "role_label_discovery",
    "aria_snapshot_discovery",
]
CANONICAL_ENTRY_VARIATIONS = ["input_text", "press_sequentially_entry"]
CANONICAL_ACCEPTANCE_VARIATIONS = ["current_tracker", "request_response_dom_acceptance"]
CONTROL_SUBMIT = "locator_click_actionable"
CONTROL_DISCOVERY = "configured_css"
CONTROL_ENTRY = "input_text"
CONTROL_ACCEPTANCE = "request_response_dom_acceptance"

FIELDNAMES = [
    "cell_id", "site", "backend", "comparison_layer", "variation",
    "discovery_variant", "entry_variant", "submit_variation", "acceptance_variant",
    "repetition", "status", "run_id", "outcome", "accepted_submit_count",
    "action_count", "duration_ms", "evidence_dir", "failure_class",
]


def parse_csv_list(raw: str | None) -> list[str]:
    if not raw:
        return []
    return [part.strip() for part in raw.split(",") if part.strip()]


def load_config(path: Path | None) -> dict[str, Any]:
    if path is None:
        return {}
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise SystemExit("config must be a JSON object")
    return data


def clean_values(name: str, values: list[Any]) -> list[str]:
    cleaned: list[str] = []
    seen: set[str] = set()
    for raw in values:
        value = str(raw).strip()
        if not value:
            continue
        if value in seen:
            raise SystemExit(f"duplicate {name}: {value}")
        seen.add(value)
        cleaned.append(value)
    if not cleaned:
        raise SystemExit(f"at least one {name} is required")
    return cleaned


def validate_subset(name: str, values: list[str], allowed: list[str]) -> None:
    unknown = sorted(set(values) - set(allowed))
    if unknown:
        raise SystemExit(f"unknown {name}: {','.join(unknown)}")


def make_cell_id(
    site: str,
    backend: str,
    layer: str,
    discovery: str,
    entry: str,
    submit: str,
    acceptance: str,
    repetition: int,
) -> str:
    material = "\x1f".join([
        site, backend, layer, discovery, entry, submit, acceptance, str(repetition),
    ]).encode()
    return hashlib.sha256(material).hexdigest()[:20]


def one_factor_specs(
    discoveries: list[str],
    entries: list[str],
    submits: list[str],
    acceptances: list[str],
) -> list[tuple[str, str, str, str, str, str]]:
    specs: list[tuple[str, str, str, str, str, str]] = []
    specs.extend(("submit", submit, CONTROL_DISCOVERY, CONTROL_ENTRY, submit, CONTROL_ACCEPTANCE) for submit in submits)
    specs.extend(("discovery", discovery, discovery, CONTROL_ENTRY, CONTROL_SUBMIT, CONTROL_ACCEPTANCE) for discovery in discoveries)
    specs.extend(("entry", entry, CONTROL_DISCOVERY, entry, CONTROL_SUBMIT, CONTROL_ACCEPTANCE) for entry in entries)
    specs.extend(("acceptance", acceptance, CONTROL_DISCOVERY, CONTROL_ENTRY, CONTROL_SUBMIT, acceptance) for acceptance in acceptances)
    return specs


def build_specs(
    mode: str,
    discoveries: list[str],
    entries: list[str],
    submits: list[str],
    acceptances: list[str],
) -> list[tuple[str, str, str, str, str, str]]:
    if mode == "submit":
        return [("submit", submit, CONTROL_DISCOVERY, CONTROL_ENTRY, submit, CONTROL_ACCEPTANCE) for submit in submits]
    if mode == "one-factor":
        return one_factor_specs(discoveries, entries, submits, acceptances)
    if mode == "cartesian":
        return [
            ("cartesian", f"{discovery}|{entry}|{submit}|{acceptance}", discovery, entry, submit, acceptance)
            for discovery, entry, submit, acceptance in itertools.product(discoveries, entries, submits, acceptances)
        ]
    raise SystemExit(f"unknown comparison mode: {mode}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path)
    parser.add_argument("--sites")
    parser.add_argument("--backends")
    parser.add_argument("--variations", help="submit variations; retained for compatibility")
    parser.add_argument("--discoveries")
    parser.add_argument("--entries")
    parser.add_argument("--acceptances")
    parser.add_argument("--comparison-mode", choices=["submit", "one-factor", "cartesian"])
    parser.add_argument("--repetitions", type=int)
    parser.add_argument("--output", type=Path, default=Path("variation-backend-matrix.csv"))
    args = parser.parse_args()

    config = load_config(args.config)
    sites = clean_values("site", parse_csv_list(args.sites) or list(config.get("sites", [])))
    backends = clean_values("backend", parse_csv_list(args.backends) or list(config.get("backends", [])))
    submits = clean_values("submit variation", parse_csv_list(args.variations) or list(config.get("variations", CANONICAL_SUBMIT_VARIATIONS)))
    discoveries = clean_values("discovery variation", parse_csv_list(args.discoveries) or list(config.get("discoveries", CANONICAL_DISCOVERY_VARIATIONS)))
    entries = clean_values("entry variation", parse_csv_list(args.entries) or list(config.get("entries", CANONICAL_ENTRY_VARIATIONS)))
    acceptances = clean_values("acceptance variation", parse_csv_list(args.acceptances) or list(config.get("acceptances", CANONICAL_ACCEPTANCE_VARIATIONS)))
    validate_subset("submit variation", submits, CANONICAL_SUBMIT_VARIATIONS)
    validate_subset("discovery variation", discoveries, CANONICAL_DISCOVERY_VARIATIONS)
    validate_subset("entry variation", entries, CANONICAL_ENTRY_VARIATIONS)
    validate_subset("acceptance variation", acceptances, CANONICAL_ACCEPTANCE_VARIATIONS)

    mode = args.comparison_mode or str(config.get("comparison_mode", "submit"))
    repetitions = args.repetitions if args.repetitions is not None else int(config.get("repetitions", 1))
    if repetitions < 1:
        raise SystemExit("repetitions must be >= 1")

    specs = build_specs(mode, discoveries, entries, submits, acceptances)
    rows: list[dict[str, Any]] = []
    for site, backend, spec, repetition in itertools.product(sites, backends, specs, range(1, repetitions + 1)):
        layer, variation, discovery, entry, submit, acceptance = spec
        rows.append({
            "cell_id": make_cell_id(site, backend, layer, discovery, entry, submit, acceptance, repetition),
            "site": site,
            "backend": backend,
            "comparison_layer": layer,
            "variation": variation,
            "discovery_variant": discovery,
            "entry_variant": entry,
            "submit_variation": submit,
            "acceptance_variant": acceptance,
            "repetition": repetition,
            "status": "PLANNED",
            "run_id": "",
            "outcome": "",
            "accepted_submit_count": "",
            "action_count": "",
            "duration_ms": "",
            "evidence_dir": "",
            "failure_class": "",
        })

    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=FIELDNAMES)
        writer.writeheader()
        writer.writerows(rows)

    expected = len(sites) * len(backends) * len(specs) * repetitions
    if len(rows) != expected or len({row["cell_id"] for row in rows}) != expected:
        raise SystemExit("matrix cardinality or cell-id uniqueness check failed")
    print(json.dumps({
        "output": str(args.output.resolve()),
        "cells": expected,
        "sites": len(sites),
        "backends": len(backends),
        "comparison_mode": mode,
        "comparison_specs": len(specs),
        "submit_variations": len(submits),
        "discovery_variations": len(discoveries),
        "entry_variations": len(entries),
        "acceptance_variations": len(acceptances),
        "repetitions": repetitions,
    }, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
