# pyright: reportMissingImports=false
"""Tests for the home_maintenance plugin (SPEC §8.2)."""

from __future__ import annotations

from typing import Any

import pytest
from PIL import Image

from homeboard import palette
from homeboard.adapters import boardbot
from plugins.home_maintenance.due_dates import Status
from plugins.home_maintenance.home_maintenance import HomeMaintenance

_SETTINGS = {
    "base_url": "http://piserver.local:8765",
}


def _bw_roles() -> palette.RoleMap:
    colors: dict[palette.Role, tuple[int, int, int]] = dict.fromkeys(
        palette.Role, (0, 0, 0)
    )
    colors[palette.Role.PAPER] = (255, 255, 255)
    return palette.RoleMap(colors=colors, six_colour=False, warn_is_solid=False)


_FIXTURE_ROWS: list[dict[str, Any]] = [
    {
        "task": "Replace furnace filter",
        "interval_value": 3,
        "interval_unit": "months",
        "last_done": "2025-08-01",
    },
    {
        "task": "Flush water heater",
        "interval_value": 1,
        "interval_unit": "years",
        "last_done": "2026-01-01",
    },
    {
        "task": "Gutter clean-out",
        "interval_unit": "seasonal",
        "next_due_override": "2026-03-01",
    },
]


class TestValidateSettings:
    def test_missing_base_url_is_rejected(self) -> None:
        plugin = HomeMaintenance({"id": "home_maintenance"})
        error = plugin.validate_settings({"base_url": ""})
        assert error is not None

    def test_negative_due_soon_days_is_rejected(self) -> None:
        plugin = HomeMaintenance({"id": "home_maintenance"})
        error = plugin.validate_settings({**_SETTINGS, "due_soon_days": "-1"})
        assert error is not None

    def test_valid_settings_pass(self) -> None:
        plugin = HomeMaintenance({"id": "home_maintenance"})
        assert plugin.validate_settings({**_SETTINGS, "due_soon_days": "14"}) is None


class TestGenerateImageConfigErrors:
    def test_missing_base_url_raises_runtime_error(
        self, device_config_dev: Any
    ) -> None:
        plugin = HomeMaintenance({"id": "home_maintenance"})
        with pytest.raises(RuntimeError):
            plugin.generate_image({"base_url": ""}, device_config_dev)

    def test_missing_api_token_raises_runtime_error(
        self, device_config_dev: Any
    ) -> None:
        plugin = HomeMaintenance({"id": "home_maintenance"})
        # device_config_dev's .env has no BOARDBOT_API_TOKEN set.
        with pytest.raises(RuntimeError, match="API token"):
            plugin.generate_image(_SETTINGS, device_config_dev)


class TestGenerateImageHappyPath:
    def test_returns_an_image_with_mocked_boardbot_data(
        self, device_config_dev: Any, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        plugin = HomeMaintenance({"id": "home_maintenance"})
        monkeypatch.setattr(
            device_config_dev.__class__, "load_env_key", lambda self, key: "fake-token"
        )
        monkeypatch.setattr(
            boardbot, "fetch_maintenance", lambda *a, **k: _FIXTURE_ROWS
        )

        image = plugin.generate_image(_SETTINGS, device_config_dev)
        assert isinstance(image, Image.Image)
        assert image.size == tuple(device_config_dev.get_resolution())

    def test_two_instances_with_different_base_urls_do_not_collide(
        self, device_config_dev: Any, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Regression check: the cache key must be derived from the
        deployment's base_url, not just the plugin id — otherwise two
        differently-configured instances of the same plugin would clobber
        each other's cached payload."""
        plugin = HomeMaintenance({"id": "home_maintenance"})
        monkeypatch.setattr(
            device_config_dev.__class__, "load_env_key", lambda self, key: "fake-token"
        )

        monkeypatch.setattr(
            boardbot, "fetch_maintenance", lambda *a, **k: _FIXTURE_ROWS
        )
        plugin.generate_image({"base_url": "http://host-a:8765"}, device_config_dev)

        other_rows = [
            {
                "task": "Descale kettle",
                "interval_value": 2,
                "interval_unit": "months",
                "last_done": "2026-01-01",
            }
        ]
        monkeypatch.setattr(boardbot, "fetch_maintenance", lambda *a, **k: other_rows)
        plugin.generate_image({"base_url": "http://host-b:8765"}, device_config_dev)

        # Now make host-a's fetch fail — it should fall back to host-a's
        # own cached rows, not host-b's.
        def _flaky(*a: object, **k: object) -> list[dict[str, Any]]:
            raise TimeoutError("network blip")

        monkeypatch.setattr(boardbot, "fetch_maintenance", _flaky)
        image = plugin.generate_image(
            {"base_url": "http://host-a:8765"}, device_config_dev
        )
        assert isinstance(image, Image.Image)


class TestGenerateImageFailSoft:
    def test_transient_failure_with_prior_cache_still_returns_an_image(
        self, device_config_dev: Any, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        plugin = HomeMaintenance({"id": "home_maintenance"})
        monkeypatch.setattr(
            device_config_dev.__class__, "load_env_key", lambda self, key: "fake-token"
        )

        monkeypatch.setattr(
            boardbot, "fetch_maintenance", lambda *a, **k: _FIXTURE_ROWS
        )
        plugin.generate_image(_SETTINGS, device_config_dev)  # populates the cache

        def _flaky(*a: object, **k: object) -> list[dict[str, Any]]:
            raise TimeoutError("network blip")

        monkeypatch.setattr(boardbot, "fetch_maintenance", _flaky)
        image = plugin.generate_image(_SETTINGS, device_config_dev)
        assert isinstance(image, Image.Image)

    def test_transient_failure_with_no_cache_renders_empty_state_not_raise(
        self, device_config_dev: Any, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        plugin = HomeMaintenance({"id": "home_maintenance"})
        monkeypatch.setattr(
            device_config_dev.__class__, "load_env_key", lambda self, key: "fake-token"
        )

        def _flaky(*a: object, **k: object) -> list[dict[str, Any]]:
            raise TimeoutError("network blip")

        monkeypatch.setattr(boardbot, "fetch_maintenance", _flaky)

        image = plugin.generate_image(_SETTINGS, device_config_dev)
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
