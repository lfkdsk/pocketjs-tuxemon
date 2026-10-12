#!/usr/bin/env python3
"""Generate the offline Tuxemon journal measurement oracle.

The pinned monster YAML files only need three top-level scalar fields here, so
this script deliberately has no PyYAML dependency. Values are rounded by the
same Python operations used by journal_info.py and formula.py.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SOURCE = Path(os.environ.get("TUXEMON_SRC", ROOT / ".tuxemon-src"))
DEFAULT_OUTPUT = ROOT / "tests" / "fixtures" / "monster-measurements.json"
MONSTER_COUNT = 411
COEFF_FEET = 0.032808399
COEFF_POUNDS = 2.2046
INTEGER = re.compile(r"[+-]?\d+")


def scalar(value: str) -> int | float:
    value = value.split("#", 1)[0].strip()
    parsed: int | float = int(value) if INTEGER.fullmatch(value) else float(value)
    if not math.isfinite(parsed):
        raise ValueError(f"measurement must be finite: {value}")
    return parsed


def fields(path: Path) -> tuple[str, int | float, int | float]:
    values: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        if line[:1].isspace() or ":" not in line:
            continue
        key, value = line.split(":", 1)
        if key in {"slug", "height", "weight"}:
            values[key] = value.strip()
    missing = {"slug", "height", "weight"} - values.keys()
    if missing:
        raise ValueError(f"{path.name}: missing {', '.join(sorted(missing))}")
    return values["slug"], scalar(values["height"]), scalar(values["weight"])


def expected(height: int | float, weight: int | float) -> list[int | float]:
    metric_height = float(f"{height / 100:.1f}") if height >= 100 else round(height)
    metric_weight = float(f"{weight / 1000:.1f}") if weight >= 1000 else round(weight)
    return [
        height,
        weight,
        metric_height,
        round(height * COEFF_FEET),
        metric_weight,
        round(weight * COEFF_POUNDS),
    ]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--src", type=Path, default=DEFAULT_SOURCE)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args()

    monster_dir = args.src / "mods" / "tuxemon" / "db" / "monster"
    rows: dict[str, list[int | float]] = {}
    for path in sorted(monster_dir.glob("*.yaml")):
        slug, height, weight = fields(path)
        if slug in rows:
            raise ValueError(f"duplicate monster slug: {slug}")
        rows[slug] = expected(height, weight)
    if len(rows) != MONSTER_COUNT:
        raise ValueError(f"expected {MONSTER_COUNT} monsters, found {len(rows)} in {monster_dir}")

    args.out.parent.mkdir(parents=True, exist_ok=True)
    lines = ["{"]
    entries = sorted(rows.items())
    for index, (slug, row) in enumerate(entries):
        comma = "," if index + 1 < len(entries) else ""
        lines.append(
            f"  {json.dumps(slug)}: {json.dumps(row, separators=(',', ':'))}{comma}"
        )
    lines.append("}")
    args.out.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"wrote {len(rows)} monster measurements to {args.out}")


if __name__ == "__main__":
    main()
