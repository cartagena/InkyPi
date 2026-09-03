"""Unit tests for homeboard.cache — SPEC.md §4.4 fail-soft caching."""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from homeboard import cache


class TestAtomicWriteJson:
    def test_writes_and_reads_back(self, tmp_path: Path) -> None:
        path = str(tmp_path / "sub" / "data.json")
        cache.atomic_write_json(path, {"a": 1})
        assert cache.read_json_or_none(path) == {"a": 1}

    def test_creates_parent_directories(self, tmp_path: Path) -> None:
        path = str(tmp_path / "a" / "b" / "c" / "data.json")
        cache.atomic_write_json(path, {"x": True})
        assert os.path.isfile(path)

    def test_leaves_no_tempfile_behind_on_success(self, tmp_path: Path) -> None:
        path = str(tmp_path / "data.json")
        cache.atomic_write_json(path, {"a": 1})
        leftovers = [p for p in os.listdir(tmp_path) if p.startswith(".hbcache_")]
        assert leftovers == []

    def test_failure_mid_write_does_not_corrupt_existing_file(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        path = str(tmp_path / "data.json")
        cache.atomic_write_json(path, {"a": 1})

        def _boom(*args: object, **kwargs: object) -> None:
            raise OSError("simulated crash")

        monkeypatch.setattr(os, "replace", _boom)
        with pytest.raises(OSError):
            cache.atomic_write_json(path, {"a": 2})

        # The original file must survive a failed write attempt.
        assert cache.read_json_or_none(path) == {"a": 1}
        leftovers = [p for p in os.listdir(tmp_path) if p.startswith(".hbcache_")]
        assert leftovers == []


class TestReadJsonOrNone:
    def test_missing_file_returns_none(self, tmp_path: Path) -> None:
        assert cache.read_json_or_none(str(tmp_path / "missing.json")) is None

    def test_corrupt_file_returns_none(self, tmp_path: Path) -> None:
        path = tmp_path / "corrupt.json"
        path.write_text("{not valid json", encoding="utf-8")
        assert cache.read_json_or_none(str(path)) is None


class TestCachedFetch:
    def test_success_writes_cache_and_returns_fresh(self, tmp_path: Path) -> None:
        result = cache.cached_fetch(str(tmp_path), "weekends", lambda: {"n": 1})
        assert result.fresh is True
        assert result.stale is False
        assert result.empty is False
        assert result.payload == {"n": 1}
        assert result.synced_at is not None

    def test_transient_failure_with_existing_cache_serves_stale(
        self, tmp_path: Path
    ) -> None:
        cache.cached_fetch(str(tmp_path), "trips", lambda: {"n": 1})

        def _flaky() -> dict[str, int]:
            raise TimeoutError("network blip")

        result = cache.cached_fetch(str(tmp_path), "trips", _flaky)
        assert result.fresh is False
        assert result.stale is True
        assert result.empty is False
        assert result.payload == {"n": 1}

    def test_transient_failure_with_no_cache_is_empty(self, tmp_path: Path) -> None:
        def _flaky() -> dict[str, int]:
            raise TimeoutError("network blip")

        result = cache.cached_fetch(str(tmp_path), "home_maintenance", _flaky)
        assert result.fresh is False
        assert result.stale is False
        assert result.empty is True
        assert result.payload is None

    def test_config_error_is_never_caught_and_never_cached(
        self, tmp_path: Path
    ) -> None:
        def _misconfigured() -> None:
            raise RuntimeError("missing sheet_id")

        with pytest.raises(RuntimeError, match="missing sheet_id"):
            cache.cached_fetch(str(tmp_path), "home_maintenance", _misconfigured)

        # A config error must not leave a stale/empty cache entry behind.
        assert (
            cache.read_json_or_none(
                os.path.join(str(tmp_path), "home_maintenance.json")
            )
            is None
        )

    def test_custom_config_errors_tuple_is_respected(self, tmp_path: Path) -> None:
        class _MissingCredential(Exception):
            pass

        def _misconfigured() -> None:
            raise _MissingCredential("no service account json")

        with pytest.raises(_MissingCredential):
            cache.cached_fetch(
                str(tmp_path),
                "board",
                _misconfigured,
                config_errors=(_MissingCredential,),
            )

    def test_second_success_overwrites_first(self, tmp_path: Path) -> None:
        cache.cached_fetch(str(tmp_path), "board", lambda: {"n": 1})
        result = cache.cached_fetch(str(tmp_path), "board", lambda: {"n": 2})
        assert result.payload == {"n": 2}
