"""Tests for scripts/benchmark_compare.py's regression gate."""

import json
from pathlib import Path
from typing import Any

from scripts.benchmark_compare import compare, load_benchmarks


def _bench_json(tmp_path: Path, name: str, benchmarks: list[dict[str, Any]]) -> str:
    path = tmp_path / name
    path.write_text(json.dumps({"benchmarks": benchmarks}))
    return str(path)


def _stat(
    name: str, median: float, mean: float | None = None, stddev: float = 0.0
) -> dict[str, Any]:
    return {
        "name": name,
        "stats": {
            "median": median,
            "mean": mean if mean is not None else median,
            "stddev": stddev,
        },
    }


def test_load_benchmarks_reads_median_mean_stddev(tmp_path: Path) -> None:
    path = _bench_json(
        tmp_path, "b.json", [_stat("test_a", median=1.0, mean=1.1, stddev=0.2)]
    )
    result = load_benchmarks(path)
    assert result == {"test_a": {"median": 1.0, "mean": 1.1, "stddev": 0.2}}


def test_load_benchmarks_defaults_missing_mean_and_stddev(tmp_path: Path) -> None:
    path = tmp_path / "b.json"
    path.write_text(
        json.dumps({"benchmarks": [{"name": "test_a", "stats": {"median": 1.0}}]})
    )
    result = load_benchmarks(str(path))
    assert result == {"test_a": {"median": 1.0, "mean": 1.0, "stddev": 0.0}}


def test_stable_benchmark_uses_global_threshold() -> None:
    # Low baseline noise (CV ~0.5%): a +20% jump must fail even though
    # noise_multiplier=3 would only buy it ~1.5% of slack.
    baseline = {"test_a": {"median": 1.0, "mean": 1.0, "stddev": 0.005}}
    current = {"test_a": {"median": 1.2, "mean": 1.2, "stddev": 0.005}}
    failures = compare(baseline, current, threshold_pct=15, noise_multiplier=3)
    assert len(failures) == 1


def test_noisy_benchmark_gets_widened_threshold() -> None:
    # High baseline noise (CV=16%, matching test_bench_clock_render in
    # practice): a +15.2% change must PASS because 3x16%=48% > 15.2%.
    baseline = {
        "test_clock": {"median": 4506.7e-6, "mean": 4461.1e-6, "stddev": 712.3e-6}
    }
    current = {"test_clock": {"median": 5193.0e-6, "mean": 5193.0e-6, "stddev": 0.0}}
    failures = compare(baseline, current, threshold_pct=15, noise_multiplier=3)
    assert failures == []


def test_noisy_benchmark_still_fails_beyond_widened_threshold() -> None:
    # Same noisy benchmark, but a regression big enough to exceed even the
    # widened 48% threshold must still fail.
    baseline = {
        "test_clock": {"median": 4506.7e-6, "mean": 4461.1e-6, "stddev": 712.3e-6}
    }
    current = {
        "test_clock": {"median": 4506.7e-6 * 2, "mean": 4506.7e-6 * 2, "stddev": 0.0}
    }
    failures = compare(baseline, current, threshold_pct=15, noise_multiplier=3)
    assert len(failures) == 1


def test_missing_benchmark_in_current_fails() -> None:
    baseline = {"test_a": {"median": 1.0, "mean": 1.0, "stddev": 0.0}}
    failures = compare(baseline, {}, threshold_pct=15, noise_multiplier=3)
    assert len(failures) == 1
    assert "missing in current run" in failures[0]


def test_zero_baseline_median_is_skipped() -> None:
    baseline = {"test_a": {"median": 0.0, "mean": 0.0, "stddev": 0.0}}
    current = {"test_a": {"median": 1.0, "mean": 1.0, "stddev": 0.0}}
    failures = compare(baseline, current, threshold_pct=15, noise_multiplier=3)
    assert failures == []


def test_new_benchmark_not_in_baseline_is_informational_only() -> None:
    baseline = {"test_a": {"median": 1.0, "mean": 1.0, "stddev": 0.0}}
    current = {
        "test_a": {"median": 1.0, "mean": 1.0, "stddev": 0.0},
        "test_new": {"median": 2.0, "mean": 2.0, "stddev": 0.0},
    }
    failures = compare(baseline, current, threshold_pct=15, noise_multiplier=3)
    assert failures == []
