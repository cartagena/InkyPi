# pyright: reportMissingImports=false
"""Tests for the home_maintenance plugin (SPEC §8.2)."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
from PIL import Image

from homeboard.adapters import gsheets
from plugins.home_maintenance.home_maintenance import HomeMaintenance

_FIXTURE_ROWS = [
    {
        "task": "Replace furnace filter",
        "interval_value": "3",
        "interval_unit": "months",
        "last_done": "2025-08-01",
        "next_due_override": "",
    },
    {
        "task": "Flush water heater",
        "interval_value": "1",
        "interval_unit": "years",
        "last_done": "2026-01-01",
        "next_due_override": "",
    },
    {
        "task": "Rotate tires",
        "interval_value": "7500",
        "interval_unit": "miles",
        "last_done": "",
        "next_due_override": "2026-03-01",
    },
]


def _isolate_plugin_cache_dir(
    monkeypatch: pytest.MonkeyPatch, plugin: HomeMaintenance, tmp_path: Path
) -> None:
    """Keep the plugin's on-disk cache out of the real src/plugins/ tree.

    Patches the instance's own get_plugin_dir() rather than the module-level
    PLUGINS_DIR constant, since the latter is also what BasePlugin.__init__
    already used to build the Jinja template loader — repointing it after
    construction would break render/<id>.html lookup.
    """
    real_get_plugin_dir = plugin.get_plugin_dir

    def _patched(path: str | None = None) -> str:
        if path == "cache":
            return str(tmp_path / "cache")
        return real_get_plugin_dir(path)

    monkeypatch.setattr(plugin, "get_plugin_dir", _patched)


class TestValidateSettings:
    def test_missing_sheet_id_is_rejected(self) -> None:
        plugin = HomeMaintenance({"id": "home_maintenance"})
        error = plugin.validate_settings({"sheet_id": ""})
        assert error is not None
        assert "Sheet ID" in error

    def test_negative_due_soon_days_is_rejected(self) -> None:
        plugin = HomeMaintenance({"id": "home_maintenance"})
        error = plugin.validate_settings({"sheet_id": "abc", "due_soon_days": "-1"})
        assert error is not None

    def test_valid_settings_pass(self) -> None:
        plugin = HomeMaintenance({"id": "home_maintenance"})
        assert (
            plugin.validate_settings({"sheet_id": "abc", "due_soon_days": "14"}) is None
        )


class TestGenerateImageConfigErrors:
    def test_missing_sheet_id_raises_runtime_error(
        self, device_config_dev: Any, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        plugin = HomeMaintenance({"id": "home_maintenance"})
        _isolate_plugin_cache_dir(monkeypatch, plugin, tmp_path)
        with pytest.raises(RuntimeError, match="Sheet ID"):
            plugin.generate_image({"sheet_id": ""}, device_config_dev)

    def test_missing_credentials_raises_runtime_error(
        self, device_config_dev: Any, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        plugin = HomeMaintenance({"id": "home_maintenance"})
        _isolate_plugin_cache_dir(monkeypatch, plugin, tmp_path)
        # device_config_dev's .env has no GOOGLE_SERVICE_ACCOUNT_JSON_PATH set.
        with pytest.raises(RuntimeError, match="service account"):
            plugin.generate_image({"sheet_id": "abc"}, device_config_dev)


class TestGenerateImageHappyPath:
    def test_returns_an_image_with_mocked_sheet_data(
        self, device_config_dev: Any, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        plugin = HomeMaintenance({"id": "home_maintenance"})
        _isolate_plugin_cache_dir(monkeypatch, plugin, tmp_path)
        monkeypatch.setattr(
            device_config_dev.__class__,
            "load_env_key",
            lambda self, key: "/fake/creds.json",
        )
        monkeypatch.setattr(gsheets, "read_worksheet", lambda *a, **k: _FIXTURE_ROWS)

        image = plugin.generate_image(
            {"sheet_id": "abc", "worksheet_name": "Maintenance"}, device_config_dev
        )
        assert isinstance(image, Image.Image)
        assert image.size == tuple(device_config_dev.get_resolution())


class TestGenerateImageFailSoft:
    def test_transient_failure_with_prior_cache_still_returns_an_image(
        self, device_config_dev: Any, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        plugin = HomeMaintenance({"id": "home_maintenance"})
        _isolate_plugin_cache_dir(monkeypatch, plugin, tmp_path)
        monkeypatch.setattr(
            device_config_dev.__class__,
            "load_env_key",
            lambda self, key: "/fake/creds.json",
        )

        settings = {"sheet_id": "abc", "worksheet_name": "Maintenance"}

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
        plugin = HomeMaintenance({"id": "home_maintenance"})
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
            {"sheet_id": "abc", "worksheet_name": "Maintenance"}, device_config_dev
        )
        assert isinstance(image, Image.Image)
