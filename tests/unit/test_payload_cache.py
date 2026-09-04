"""Unit tests for utils.payload_cache — SPEC.md §4.4 fail-soft caching."""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from utils import payload_cache


class TestAtomicWriteJson:
    def test_writes_and_reads_back(self, tmp_path: Path) -> None:
        path = str(tmp_path / "sub" / "data.json")
        payload_cache.atomic_write_json(path, {"a": 1})
        assert payload_cache.read_json_or_none(path) == {"a": 1}

    def test_creates_parent_directories(self, tmp_path: Path) -> None:
        path = str(tmp_path / "a" / "b" / "c" / "data.json")
        payload_cache.atomic_write_json(path, {"x": True})
        assert os.path.isfile(path)

    def test_leaves_no_tempfile_behind_on_success(self, tmp_path: Path) -> None:
        path = str(tmp_path / "data.json")
        payload_cache.atomic_write_json(path, {"a": 1})
        leftovers = [p for p in os.listdir(tmp_path) if p.startswith(".plugincache_")]
        assert leftovers == []

    def test_failure_mid_write_does_not_corrupt_existing_file(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        path = str(tmp_path / "data.json")
        payload_cache.atomic_write_json(path, {"a": 1})

        def _boom(*args: object, **kwargs: object) -> None:
            raise OSError("simulated crash")

        monkeypatch.setattr(os, "replace", _boom)
        with pytest.raises(OSError):
            payload_cache.atomic_write_json(path, {"a": 2})

        assert payload_cache.read_json_or_none(path) == {"a": 1}
        leftovers = [p for p in os.listdir(tmp_path) if p.startswith(".plugincache_")]
        assert leftovers == []


class TestReadJsonOrNone:
    def test_missing_file_returns_none(self, tmp_path: Path) -> None:
        assert payload_cache.read_json_or_none(str(tmp_path / "missing.json")) is None

    def test_corrupt_file_returns_none(self, tmp_path: Path) -> None:
        path = tmp_path / "corrupt.json"
        path.write_text("{not valid json", encoding="utf-8")
        assert payload_cache.read_json_or_none(str(path)) is None


class TestCacheFilePath:
    def test_same_plugin_id_and_cache_key_is_stable(self, tmp_path: Path) -> None:
        a = payload_cache._cache_file_path(str(tmp_path), "trips", "sheet-a")
        b = payload_cache._cache_file_path(str(tmp_path), "trips", "sheet-a")
        assert a == b

    def test_different_cache_keys_do_not_collide(self, tmp_path: Path) -> None:
        a = payload_cache._cache_file_path(str(tmp_path), "trips", "sheet-a")
        b = payload_cache._cache_file_path(str(tmp_path), "trips", "sheet-b")
        assert a != b

    def test_different_plugin_ids_do_not_collide_on_the_same_cache_key(
        self, tmp_path: Path
    ) -> None:
        a = payload_cache._cache_file_path(str(tmp_path), "trips", "abc")
        b = payload_cache._cache_file_path(str(tmp_path), "home_maintenance", "abc")
        assert a != b

    def test_lives_under_plugin_cache_subdir(self, tmp_path: Path) -> None:
        path = payload_cache._cache_file_path(str(tmp_path), "trips", "sheet-a")
        assert os.path.dirname(path) == str(tmp_path / "plugin_cache")

    def test_rejects_empty_cache_key(self, tmp_path: Path) -> None:
        with pytest.raises(ValueError):
            payload_cache._cache_file_path(str(tmp_path), "trips", "")


class TestCachedFetch:
    def test_success_writes_cache_and_returns_fresh(self, tmp_path: Path) -> None:
        result = payload_cache.cached_fetch(
            str(tmp_path), "home_maintenance", "sheet-a", lambda: {"n": 1}
        )
        assert result.fresh is True
        assert result.stale is False
        assert result.empty is False
        assert result.payload == {"n": 1}
        assert result.synced_at is not None

    def test_transient_failure_with_existing_cache_serves_stale(
        self, tmp_path: Path
    ) -> None:
        payload_cache.cached_fetch(str(tmp_path), "trips", "sheet-a", lambda: {"n": 1})

        def _flaky() -> dict[str, int]:
            raise TimeoutError("network blip")

        result = payload_cache.cached_fetch(str(tmp_path), "trips", "sheet-a", _flaky)
        assert result.fresh is False
        assert result.stale is True
        assert result.empty is False
        assert result.payload == {"n": 1}

    def test_transient_failure_with_no_cache_is_empty(self, tmp_path: Path) -> None:
        def _flaky() -> dict[str, int]:
            raise TimeoutError("network blip")

        result = payload_cache.cached_fetch(
            str(tmp_path), "home_maintenance", "sheet-a", _flaky
        )
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
            payload_cache.cached_fetch(
                str(tmp_path), "home_maintenance", "sheet-a", _misconfigured
            )

        path = payload_cache._cache_file_path(
            str(tmp_path), "home_maintenance", "sheet-a"
        )
        assert payload_cache.read_json_or_none(path) is None

    def test_custom_config_errors_tuple_is_respected(self, tmp_path: Path) -> None:
        class _MissingCredential(Exception):
            pass

        def _misconfigured() -> None:
            raise _MissingCredential("no service account json")

        with pytest.raises(_MissingCredential):
            payload_cache.cached_fetch(
                str(tmp_path),
                "board",
                "note-a",
                _misconfigured,
                config_errors=(_MissingCredential,),
            )

    def test_second_success_overwrites_first(self, tmp_path: Path) -> None:
        payload_cache.cached_fetch(str(tmp_path), "board", "note-a", lambda: {"n": 1})
        result = payload_cache.cached_fetch(
            str(tmp_path), "board", "note-a", lambda: {"n": 2}
        )
        assert result.payload == {"n": 2}

    def test_two_cache_keys_under_the_same_plugin_do_not_clobber(
        self, tmp_path: Path
    ) -> None:
        # Regression: this is the whole point of keying on cache_key, not
        # just plugin_id — two instances of the same plugin with different
        # source data must not share a cache entry.
        payload_cache.cached_fetch(
            str(tmp_path), "trips", "sheet-a", lambda: {"n": "a"}
        )
        payload_cache.cached_fetch(
            str(tmp_path), "trips", "sheet-b", lambda: {"n": "b"}
        )

        def _flaky() -> None:
            raise TimeoutError("network blip")

        result_a = payload_cache.cached_fetch(str(tmp_path), "trips", "sheet-a", _flaky)
        result_b = payload_cache.cached_fetch(str(tmp_path), "trips", "sheet-b", _flaky)
        assert result_a.payload == {"n": "a"}
        assert result_b.payload == {"n": "b"}
