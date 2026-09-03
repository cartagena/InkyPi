# pyright: reportMissingImports=false
"""Tests for the trips plugin (SPEC §8.1)."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
from PIL import Image

from homeboard.adapters import gsheets
from plugins.trips.trips import Trips

_FIXTURE_ROWS = [
    {
        "name": "Tahoe with the Silvas",
        "status": "booked",
        "start": "2026-10-03",
        "end": "2026-10-05",
        "next_action": "Cabin not confirmed yet",
        "blocking": "true",
    },
    {
        "name": "Brazil, family visit",
        "status": "booked",
        "start": "2026-12-20",
        "end": "2027-01-05",
        "next_action": "Domestic leg still to book",
        "blocking": "false",
    },
    {
        "name": "Yosemite, off season",
        "status": "idea",
        "target_window": "Feb, book by Nov",
    },
    {
        "name": "Big Sur, long weekend",
        "status": "idea",
        "target_window": "Spring",
    },
]


def _isolate_plugin_cache_dir(
    monkeypatch: pytest.MonkeyPatch, plugin: Trips, tmp_path: Path
) -> None:
    real_get_plugin_dir = plugin.get_plugin_dir

    def _patched(path: str | None = None) -> str:
        if path == "cache":
            return str(tmp_path / "cache")
        return real_get_plugin_dir(path)

    monkeypatch.setattr(plugin, "get_plugin_dir", _patched)


class TestValidateSettings:
    def test_missing_sheet_id_is_rejected(self) -> None:
        plugin = Trips({"id": "trips"})
        assert plugin.validate_settings({"sheet_id": ""}) is not None

    def test_valid_settings_pass(self) -> None:
        plugin = Trips({"id": "trips"})
        assert plugin.validate_settings({"sheet_id": "abc"}) is None


class TestGenerateImageConfigErrors:
    def test_missing_sheet_id_raises_runtime_error(
        self, device_config_dev: Any, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        plugin = Trips({"id": "trips"})
        _isolate_plugin_cache_dir(monkeypatch, plugin, tmp_path)
        with pytest.raises(RuntimeError, match="Sheet ID"):
            plugin.generate_image({"sheet_id": ""}, device_config_dev)

    def test_missing_credentials_raises_runtime_error(
        self, device_config_dev: Any, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        plugin = Trips({"id": "trips"})
        _isolate_plugin_cache_dir(monkeypatch, plugin, tmp_path)
        with pytest.raises(RuntimeError, match="service account"):
            plugin.generate_image({"sheet_id": "abc"}, device_config_dev)


class TestGenerateImageHappyPath:
    def test_returns_an_image_with_mocked_sheet_data(
        self, device_config_dev: Any, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        plugin = Trips({"id": "trips"})
        _isolate_plugin_cache_dir(monkeypatch, plugin, tmp_path)
        monkeypatch.setattr(
            device_config_dev.__class__,
            "load_env_key",
            lambda self, key: "/fake/creds.json",
        )
        monkeypatch.setattr(gsheets, "read_worksheet", lambda *a, **k: _FIXTURE_ROWS)

        image = plugin.generate_image(
            {"sheet_id": "abc", "worksheet_name": "Trips"}, device_config_dev
        )
        assert isinstance(image, Image.Image)
        assert image.size == tuple(device_config_dev.get_resolution())

    def test_empty_sheet_returns_an_image(
        self, device_config_dev: Any, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        plugin = Trips({"id": "trips"})
        _isolate_plugin_cache_dir(monkeypatch, plugin, tmp_path)
        monkeypatch.setattr(
            device_config_dev.__class__,
            "load_env_key",
            lambda self, key: "/fake/creds.json",
        )
        monkeypatch.setattr(gsheets, "read_worksheet", lambda *a, **k: [])

        image = plugin.generate_image(
            {"sheet_id": "abc", "worksheet_name": "Trips"}, device_config_dev
        )
        assert isinstance(image, Image.Image)


class TestGenerateImageFailSoft:
    def test_transient_failure_with_prior_cache_still_returns_an_image(
        self, device_config_dev: Any, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        plugin = Trips({"id": "trips"})
        _isolate_plugin_cache_dir(monkeypatch, plugin, tmp_path)
        monkeypatch.setattr(
            device_config_dev.__class__,
            "load_env_key",
            lambda self, key: "/fake/creds.json",
        )

        settings = {"sheet_id": "abc", "worksheet_name": "Trips"}
        monkeypatch.setattr(gsheets, "read_worksheet", lambda *a, **k: _FIXTURE_ROWS)
        plugin.generate_image(settings, device_config_dev)  # populates the cache

        def _flaky(*a: object, **k: object) -> list[dict[str, str]]:
            raise TimeoutError("network blip")

        monkeypatch.setattr(gsheets, "read_worksheet", _flaky)
        image = plugin.generate_image(settings, device_config_dev)
        assert isinstance(image, Image.Image)

    def test_transient_failure_with_no_cache_renders_empty_state_not_raise(
        self, device_config_dev: Any, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        plugin = Trips({"id": "trips"})
        _isolate_plugin_cache_dir(monkeypatch, plugin, tmp_path)
        monkeypatch.setattr(
            device_config_dev.__class__,
            "load_env_key",
            lambda self, key: "/fake/creds.json",
        )

        def _flaky(*a: object, **k: object) -> list[dict[str, str]]:
            raise TimeoutError("network blip")

        monkeypatch.setattr(gsheets, "read_worksheet", _flaky)
        image = plugin.generate_image(
            {"sheet_id": "abc", "worksheet_name": "Trips"}, device_config_dev
        )
        assert isinstance(image, Image.Image)


class TestGenerateImageTooSmall:
    def test_tiny_panel_renders_too_small_message_not_raise(
        self, device_config_dev: Any, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        plugin = Trips({"id": "trips"})
        _isolate_plugin_cache_dir(monkeypatch, plugin, tmp_path)
        monkeypatch.setattr(
            device_config_dev.__class__,
            "load_env_key",
            lambda self, key: "/fake/creds.json",
        )
        monkeypatch.setattr(
            device_config_dev.__class__, "get_resolution", lambda self: (200, 100)
        )
        monkeypatch.setattr(gsheets, "read_worksheet", lambda *a, **k: _FIXTURE_ROWS)

        image = plugin.generate_image(
            {"sheet_id": "abc", "worksheet_name": "Trips"}, device_config_dev
        )
        assert isinstance(image, Image.Image)
