#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0
"""
clean-test-data.py — Delete locally accumulated test artefacts.

The developer's "fresh slate" button for ever-growing test data. Touches
nothing tracked in git: committed fixtures, test programs, and source
files are left alone.

Targets (all gitignored, all local-only):

  traces/perf/                Chrome trace exports written by ONWARD_PERF_TRACE=1
  traces/test-logs/           Per-runner autotest stdout/stderr
  traces/screenshots/         Ad-hoc capture output (if any)
  traces/profile/             CPU / sampling profile dumps (if any)
  test/full-regression-results/   Per-run summary + per-runner logs from
                                  test/autotest/run-full-regression.py
  test/autotest/results/      Renderer-side autotest scratch output

Preserved:
  traces/.gitkeep             keeps the directory on fresh clones
  Anything tracked in git (committed fixtures, runners, source code)

Cross-platform: relies on stdlib only; works on macOS, Linux, Windows.

Usage:
  python3 scripts/clean-test-data.py             # plan, confirm once, delete
  python3 scripts/clean-test-data.py --yes       # skip confirmation prompt
  python3 scripts/clean-test-data.py --dry-run   # only print the plan
  python3 scripts/clean-test-data.py --traces            # traces/ only
  python3 scripts/clean-test-data.py --regression        # regression results only
  python3 scripts/clean-test-data.py --autotest-results  # autotest scratch only

Multiple category flags can be combined; if none are given, every category
is included.
"""

from __future__ import annotations

import argparse
import os
import shutil
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import List, Set

REPO = Path(__file__).resolve().parent.parent
os.chdir(REPO)


@dataclass
class Target:
    label: str
    category: str
    base: Path
    preserve: Set[str]  # entry names to keep verbatim (e.g. {".gitkeep"})


# `.gitkeep` is universally preserved so every target directory survives
# a wipe — the orchestrator and runners rely on the directory existing.
_KEEP = {".gitkeep"}

TARGETS: List[Target] = [
    Target("traces/perf",                  "traces",           REPO / "traces" / "perf",                  _KEEP),
    Target("traces/test-logs",             "traces",           REPO / "traces" / "test-logs",             _KEEP),
    Target("traces/screenshots",           "traces",           REPO / "traces" / "screenshots",           _KEEP),
    Target("traces/profile",               "traces",           REPO / "traces" / "profile",               _KEEP),
    Target("test/full-regression-results", "regression",       REPO / "test" / "full-regression-results", _KEEP),
    Target("test/autotest/results",        "autotest-results", REPO / "test" / "autotest" / "results",    _KEEP),
]

ALL_CATEGORIES = {"traces", "regression", "autotest-results"}


# ---------------------------------------------------------------------------
# Sizing helpers
# ---------------------------------------------------------------------------

def human_size(n: int) -> str:
    size: float = float(n)
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if size < 1024:
            return f"{size:.1f} {unit}" if unit != "B" else f"{int(size)} B"
        size /= 1024
    return f"{size:.1f} PB"


def path_size_files(p: Path) -> tuple[int, int]:
    if p.is_file() and not p.is_symlink():
        try:
            return p.stat().st_size, 1
        except OSError:
            return 0, 0
    if p.is_dir() and not p.is_symlink():
        total = 0
        count = 0
        for child in p.rglob("*"):
            if child.is_file() and not child.is_symlink():
                try:
                    total += child.stat().st_size
                    count += 1
                except OSError:
                    pass
        return total, count
    return 0, 0


# ---------------------------------------------------------------------------
# Plan
# ---------------------------------------------------------------------------

@dataclass
class TargetPlan:
    target: Target
    items: List[Path]
    bytes_total: int
    files_total: int


def collect_plan(categories: Set[str]) -> List[TargetPlan]:
    plan: List[TargetPlan] = []
    for tgt in TARGETS:
        if tgt.category not in categories:
            continue
        if not tgt.base.exists():
            continue
        items: List[Path] = []
        bytes_total = 0
        files_total = 0
        try:
            children = sorted(tgt.base.iterdir())
        except OSError:
            children = []
        for child in children:
            if child.name in tgt.preserve:
                continue
            items.append(child)
            b, c = path_size_files(child)
            bytes_total += b
            files_total += c
        if items:
            plan.append(TargetPlan(tgt, items, bytes_total, files_total))
    return plan


def print_plan(plan: List[TargetPlan], dry_run: bool) -> None:
    if not plan:
        print("Nothing to clean — all targets are already empty.")
        return
    grand_bytes = sum(p.bytes_total for p in plan)
    grand_files = sum(p.files_total for p in plan)
    header = "DRY-RUN — would delete" if dry_run else "Cleanup plan — will delete"
    print(f"{header} {grand_files} file(s), {human_size(grand_bytes)} total:\n")
    for tp in plan:
        entries = "entry" if len(tp.items) == 1 else "entries"
        print(f"  {tp.target.label}/  ({len(tp.items)} {entries}, {tp.files_total} file(s), {human_size(tp.bytes_total)})")
        # Show up to 5 leaf items per category so the plan stays readable.
        for it in tp.items[:5]:
            kind = "dir " if it.is_dir() else "file"
            b, _ = path_size_files(it)
            print(f"    - {kind} {it.relative_to(REPO).as_posix()}  ({human_size(b)})")
        if len(tp.items) > 5:
            print(f"    ... and {len(tp.items) - 5} more")
        print()


def execute_plan(plan: List[TargetPlan]) -> tuple[int, int]:
    total_files = 0
    total_bytes = 0
    failures: List[str] = []
    for tp in plan:
        for it in tp.items:
            try:
                if it.is_dir() and not it.is_symlink():
                    shutil.rmtree(str(it))
                else:
                    it.unlink()
            except OSError as e:
                failures.append(f"{it.relative_to(REPO).as_posix()}: {e}")
                continue
        total_files += tp.files_total
        total_bytes += tp.bytes_total
    if failures:
        print("\nWARNINGS:", file=sys.stderr)
        for f in failures:
            print(f"  could not remove {f}", file=sys.stderr)
    return total_files, total_bytes


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--dry-run", "-n", action="store_true",
                        help="Print the plan and exit; delete nothing.")
    parser.add_argument("--yes", "-y", action="store_true",
                        help="Skip the interactive confirmation prompt.")
    parser.add_argument("--traces", action="store_true",
                        help="Clean only traces/ artefacts.")
    parser.add_argument("--regression", action="store_true",
                        help="Clean only test/full-regression-results/.")
    parser.add_argument("--autotest-results", action="store_true",
                        help="Clean only test/autotest/results/.")
    args = parser.parse_args()

    selected: Set[str] = set()
    if args.traces:
        selected.add("traces")
    if args.regression:
        selected.add("regression")
    if args.autotest_results:
        selected.add("autotest-results")
    if not selected:
        selected = set(ALL_CATEGORIES)

    plan = collect_plan(selected)
    print_plan(plan, args.dry_run)

    if not plan or args.dry_run:
        return 0

    if not args.yes:
        try:
            reply = input("Proceed? [y/N] ").strip().lower()
        except (EOFError, KeyboardInterrupt):
            print()
            reply = ""
        if reply not in ("y", "yes"):
            print("Aborted.")
            return 1

    files, bytes_ = execute_plan(plan)
    print(f"\nDeleted {files} file(s), reclaimed {human_size(bytes_)}.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
