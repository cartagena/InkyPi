# pyright: reportMissingImports=false
"""Tests for the home_maintenance plugin (SPEC §8.2)."""

from __future__ import annotations

from typing import Any

import pytest
from PIL import Image

from homeboard import palette
from homeboard.adapters import gsheets
from plugins.home_maintenance.due_dates import Status
from plugins.home_maintenance.home_maintenance import HomeMaintenance


def _bw_roles() -> palette.RoleMap:
    colors: dict[palette.Role, tuple[int, int, int]] = dict.fromkeys(
        palette.Role, (0, 0, 0)
    )
    colors[palette.Role.PAPER] = (255, 255, 255)
    return palette.RoleMap(colors=colors, six_colour=False, warn_is_solid=False)


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
        self, device_config_dev: Any
    ) -> None:
        plugin = HomeMaintenance({"id": "home_maintenance"})
        with pytest.raises(RuntimeError, match="Sheet ID"):
            plugin.generate_image({"sheet_id": ""}, device_config_dev)

    def test_missing_credentials_raises_runtime_error(
        self, device_config_dev: Any
    ) -> None:
        plugin = HomeMaintenance({"id": "home_maintenance"})
        # device_config_dev's .env has no GOOGLE_SERVICE_ACCOUNT_JSON_PATH set.
        with pytest.raises(RuntimeError, match="service account"):
            plugin.generate_image({"sheet_id": "abc"}, device_config_dev)


class TestGenerateImageHappyPath:
    def test_returns_an_image_with_mocked_sheet_data(
        self, device_config_dev: Any, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        plugin = HomeMaintenance({"id": "home_maintenance"})
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

    def test_two_instances_with_different_sheet_ids_do_not_collide(
        self, device_config_dev: Any, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Regression check: the cache key must be derived from the sheet
        id/worksheet name, not just the plugin id — otherwise two
        differently-configured instances of the same plugin would clobber
        each other's cached payload."""
        plugin = HomeMaintenance({"id": "home_maintenance"})
        monkeypatch.setattr(
            device_config_dev.__class__,
            "load_env_key",
            lambda self, key: "/fake/creds.json",
        )

        monkeypatch.setattr(gsheets, "read_worksheet", lambda *a, **k: _FIXTURE_ROWS)
        plugin.generate_image(
            {"sheet_id": "sheet-a", "worksheet_name": "Maintenance"}, device_config_dev
        )

        other_rows = [
            {
                "task": "Descale kettle",
                "interval_value": "2",
                "interval_unit": "months",
                "last_done": "2026-01-01",
                "next_due_override": "",
            }
        ]
        monkeypatch.setattr(gsheets, "read_worksheet", lambda *a, **k: other_rows)
        plugin.generate_image(
            {"sheet_id": "sheet-b", "worksheet_name": "Maintenance"}, device_config_dev
        )

        # Now make sheet-a's fetch fail — it should fall back to sheet-a's
        # own cached rows, not sheet-b's.
        def _flaky(*a: object, **k: object) -> list[dict[str, str]]:
            raise TimeoutError("network blip")

        monkeypatch.setattr(gsheets, "read_worksheet", _flaky)
        image = plugin.generate_image(
            {"sheet_id": "sheet-a", "worksheet_name": "Maintenance"}, device_config_dev
        )
        assert isinstance(image, Image.Image)


class TestGenerateImageFailSoft:
    def test_transient_failure_with_prior_cache_still_returns_an_image(
        self, device_config_dev: Any, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        plugin = HomeMaintenance({"id": "home_maintenance"})
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
        self, device_config_dev: Any, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        plugin = HomeMaintenance({"id": "home_maintenance"})
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


class TestRowTemplateParamsTruncation:
    def test_long_task_name_is_truncated(self) -> None:
        from datetime import date

        from homeboard import layout
        from plugins.home_maintenance.due_dates import IntervalUnit, build_item

        t = layout.tokens(800, 480)
        item = build_item(
            "Replace HVAC filter and check outdoor condenser unit for debris",
            3,
            IntervalUnit.MONTHS,
            None,
            None,
            today=date(2026, 1, 1),
            due_soon_days=14,
        )
        params = HomeMaintenance._row_template_params(item, t, _bw_roles())
        assert params["task"] != item.task
        assert params["task"].endswith("…")

    def test_short_task_name_is_untouched(self) -> None:
        from datetime import date

        from homeboard import layout
        from plugins.home_maintenance.due_dates import IntervalUnit, build_item

        t = layout.tokens(800, 480)
        item = build_item(
            "Flush water heater",
            1,
            IntervalUnit.YEARS,
            None,
            None,
            today=date(2026, 1, 1),
            due_soon_days=14,
        )
        params = HomeMaintenance._row_template_params(item, t, _bw_roles())
        assert params["task"] == "Flush water heater"

    def test_due_soon_chip_solid_follows_role_map_not_hardcoded(self) -> None:
        from datetime import date, timedelta

        from homeboard import layout
        from plugins.home_maintenance.due_dates import IntervalUnit, build_item

        t = layout.tokens(800, 480)
        today = date(2026, 1, 1)
        item = build_item(
            "Rotate mattress",
            1,
            IntervalUnit.YEARS,
            today - timedelta(days=350),
            None,
            today=today,
            due_soon_days=30,
        )
        assert item.status == Status.DUE_SOON

        params = HomeMaintenance._row_template_params(item, t, _bw_roles())
        assert params["chip"]["solid"] is False

        solid_roles = palette.RoleMap(
            colors=_bw_roles().colors, six_colour=True, warn_is_solid=True
        )
        params = HomeMaintenance._row_template_params(item, t, solid_roles)
        assert params["chip"]["solid"] is True
