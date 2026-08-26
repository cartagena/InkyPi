#!/usr/bin/env python3
"""Compare pytest-benchmark JSON output against a stored baseline.

Exit 0 if all benchmarks are within the allowed regression threshold.
Exit 1 if any benchmark regressed beyond the threshold.

Usage:
    python scripts/benchmark_compare.py \
        --baseline tests/benchmarks/baseline.json \
        --current  /tmp/bench-current.json \
        [--threshold 15] [--noise-multiplier 3]

The threshold is a percentage (default 15, i.e. +15% regression).
It can also be set via the BENCHMARK_THRESHOLD_PCT environment variable.

Some benchmarks (e.g. font/image rendering) have much higher inherent
run-to-run variance than others on shared CI runners, even with no code
change at all. A single flat threshold either false-positives on those
noisy benchmarks or is too loose to catch real regressions in stable ones.
Instead, each benchmark's effective threshold is widened based on its own
baseline coefficient of variation (stddev / mean, as already recorded in
the baseline JSON): effective = max(threshold_pct, noise_multiplier *
baseline_cv_pct). Benchmarks with low baseline variance keep the tight
global threshold; noisy ones get proportionally more slack.
"""

from __future__ import annotations

import argparse
import json
import os
import sys


def load_benchmarks(path: str) -> dict[str, dict[str, float]]:
    """Return {test_name: {median, mean, stddev}} (seconds) from a pytest-benchmark JSON file."""
    with open(path) as f:
        data = json.load(f)
    result = {}
    for b in data["benchmarks"]:
        stats = b["stats"]
        result[b["name"]] = {
            "median": stats["median"],
            "mean": stats.get("mean", stats["median"]),
            "stddev": stats.get("stddev", 0.0),
        }
    return result


def compare(
    baseline: dict[str, dict[str, float]],
    current: dict[str, dict[str, float]],
    threshold_pct: float,
    noise_multiplier: float,
) -> list[str]:
    """Return a list of failure messages for benchmarks that regressed."""
    failures: list[str] = []
    for name, base in sorted(baseline.items()):
        cur = current.get(name)
        if cur is None:
            label = f"  FAIL  {name}: missing in current run (present in baseline)"
            print(label)
            failures.append(label)
            continue
        base_val = base["median"]
        if base_val == 0:
            continue
        cur_val = cur["median"]
        change_pct = ((cur_val - base_val) / base_val) * 100

        base_mean = base["mean"] or base_val
        noise_pct = (base["stddev"] / base_mean) * 100 if base_mean else 0.0
        effective_threshold = max(threshold_pct, noise_multiplier * noise_pct)

        status = "PASS" if change_pct <= effective_threshold else "FAIL"
        suffix = (
            f" [widened to +{effective_threshold:.0f}% for {noise_pct:.0f}% baseline noise]"
            if effective_threshold > threshold_pct
            else ""
        )
        label = f"  {status}  {name}: {base_val*1e6:.1f}us -> {cur_val*1e6:.1f}us ({change_pct:+.1f}%){suffix}"
        print(label)
        if status == "FAIL":
            failures.append(label)

    # Check for new benchmarks (informational only, not a failure)
    new_benchmarks = set(current) - set(baseline)
    for name in sorted(new_benchmarks):
        print(f"  NEW   {name}: {current[name]['median']*1e6:.1f}us (no baseline)")

    return failures


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "--baseline",
        default="tests/benchmarks/baseline.json",
        help="Path to the stored baseline JSON (default: tests/benchmarks/baseline.json)",
    )
    parser.add_argument(
        "--current",
        required=True,
        help="Path to the current benchmark JSON output",
    )
    parser.add_argument(
        "--threshold",
        type=float,
        default=None,
        help="Regression threshold percentage (default: 15, or BENCHMARK_THRESHOLD_PCT env var)",
    )
    parser.add_argument(
        "--noise-multiplier",
        type=float,
        default=None,
        help=(
            "Multiplier applied to a benchmark's baseline coefficient of "
            "variation to widen its threshold (default: 3, or "
            "BENCHMARK_NOISE_MULTIPLIER env var)"
        ),
    )
    args = parser.parse_args()

    threshold = args.threshold
    if threshold is None:
        threshold = float(os.environ.get("BENCHMARK_THRESHOLD_PCT", "15"))

    noise_multiplier = args.noise_multiplier
    if noise_multiplier is None:
        noise_multiplier = float(os.environ.get("BENCHMARK_NOISE_MULTIPLIER", "3"))

    print(f"Benchmark regression gate (threshold: +{threshold:.0f}%)")
    print(f"  Baseline: {args.baseline}")
    print(f"  Current:  {args.current}")
    print()

    baseline = load_benchmarks(args.baseline)
    current = load_benchmarks(args.current)

    if not baseline:
        print("ERROR: No benchmarks found in baseline file")
        return 1

    failures = compare(baseline, current, threshold, noise_multiplier)

    print()
    if failures:
        print(
            f"FAILED: {len(failures)} benchmark(s) exceeded their regression threshold"
        )
        return 1

    print("PASSED: All benchmarks within threshold")
    return 0


if __name__ == "__main__":
    sys.exit(main())
