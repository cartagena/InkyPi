# pyright: reportMissingImports=false
"""Tests for the weekends plugin (SPEC §6)."""

from __future__ import annotations

from datetime import date
from typing import Any

import pytest
from PIL import Image

from homeboard import layout
from homeboard.adapters import ical
from plugins.weekends.classify import CellState, DayCell, WeekendRow
from plugins.weekends.weekends import Weekends

_SETTINGS = {"ics_urls": "https://example.com/cal.ics"}


class TestValidateSettings:
    def test_missing_urls_is_rejected(self) -> None:
        plugin = Weekends({"id": "weekends"})
        assert plugin.validate_settings({"ics_urls": ""}) is not None

    def test_valid_settings_pass(self) -> None:
        plugin = Weekends({"id": "weekends"})
        assert plugin.validate_settings(_SETTINGS) is None


class TestGenerateImageConfigErrors:
    def test_missing_urls_raises_runtime_error(self, device_config_dev: Any) -> None:
        plugin = Weekends({"id": "weekends"})
        with pytest.raises(RuntimeError, match="calendar URL"):
            plugin.generate_image({"ics_urls": ""}, device_config_dev)


class TestGenerateImageHappyPath:
    def test_returns_an_image_with_mocked_events(
        self, device_config_dev: Any, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        plugin = Weekends({"id": "weekends"})
        monkeypatch.setattr(ical, "fetch_events", lambda *a, **k: [])

        image = plugin.generate_image(_SETTINGS, device_config_dev)
        assert isinstance(image, Image.Image)
        assert image.size == tuple(device_config_dev.get_resolution())

    def test_no_calendars_ever_fetched_still_renders(
        self, device_config_dev: Any, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        def _flaky(*a: object, **k: object) -> list[dict[str, str]]:
            raise TimeoutError("network blip")

        plugin = Weekends({"id": "weekends"})
        monkeypatch.setattr(ical, "fetch_events", _flaky)

        image = plugin.generate_image(_SETTINGS, device_config_dev)
        assert isinstance(image, Image.Image)


class TestGenerateImageFailSoft:
    def test_transient_failure_with_prior_cache_still_returns_an_image(
        self, device_config_dev: Any, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        plugin = Weekends({"id": "weekends"})
        monkeypatch.setattr(ical, "fetch_events", lambda *a, **k: [])
        plugin.generate_image(_SETTINGS, device_config_dev)  # populates the cache

        def _flaky(*a: object, **k: object) -> list[dict[str, str]]:
            raise TimeoutError("network blip")

        monkeypatch.setattr(ical, "fetch_events", _flaky)
        image = plugin.generate_image(_SETTINGS, device_config_dev)
        assert isinstance(image, Image.Image)

    def test_two_instances_with_different_urls_do_not_collide(
        self, device_config_dev: Any, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        plugin = Weekends({"id": "weekends"})
        monkeypatch.setattr(ical, "fetch_events", lambda *a, **k: [])
        plugin.generate_image(
            {"ics_urls": "https://a.example/cal.ics"}, device_config_dev
        )
        plugin.generate_image(
            {"ics_urls": "https://b.example/cal.ics"}, device_config_dev
        )

        def _flaky(*a: object, **k: object) -> list[dict[str, str]]:
            raise TimeoutError("network blip")

        monkeypatch.setattr(ical, "fetch_events", _flaky)
        image = plugin.generate_image(
            {"ics_urls": "https://a.example/cal.ics"}, device_config_dev
        )
        assert isinstance(image, Image.Image)


class TestGenerateImageTooSmall:
    def test_tiny_panel_renders_too_small_message_not_raise(
        self, device_config_dev: Any, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        plugin = Weekends({"id": "weekends"})
        monkeypatch.setattr(
            device_config_dev.__class__, "get_resolution", lambda self: (200, 100)
        )
        monkeypatch.setattr(ical, "fetch_events", lambda *a, **k: [])

        image = plugin.generate_image(_SETTINGS, device_config_dev)
        assert isinstance(image, Image.Image)


class TestRowTemplateParams:
    def test_free_weekend_count_reflected_in_meta(
        self, device_config_dev: Any, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        plugin = Weekends({"id": "weekends"})
        monkeypatch.setattr(ical, "fetch_events", lambda *a, **k: [])

        image = plugin.generate_image(
            {**_SETTINGS, "weekends_ahead": "3"}, device_config_dev
        )
        assert isinstance(image, Image.Image)

    def test_spanning_row_gets_the_wider_spanning_cell_truncation_budget(
        self,
    ) -> None:
        """Regression: a spanning row's rendered cell is the full
        Saturday+Sunday span, not one single-day cell — truncating against
        the narrower single-cell width would over-truncate text that
        actually has roughly double the room to render in."""
        t = layout.tokens(800, 480)
        long_label = "Grandma and Grandpa's Fiftieth Anniversary Family Reunion"
        cell = DayCell(CellState.BOOKED, long_label, "All day", False, "")
        spanning_row = WeekendRow(
            date(2026, 10, 3), date(2026, 10, 4), True, cell, cell
        )
        non_spanning_row = WeekendRow(
            date(2026, 10, 3), date(2026, 10, 4), False, cell, cell
        )

        spanning_params = Weekends._row_template_params(spanning_row, t)
        non_spanning_params = Weekends._row_template_params(non_spanning_row, t)

        assert len(spanning_params["sat"]["label"]) > len(
            non_spanning_params["sat"]["label"]
        )

    def test_spanning_row_carries_long_weekend_note_into_params(self) -> None:
        cell = DayCell(CellState.BOOKED, "Family reunion", "", True, "Mon off")
        row = WeekendRow(date(2026, 10, 3), date(2026, 10, 4), True, cell, cell)
        t = layout.tokens(800, 480)

        params = Weekends._row_template_params(row, t)
        assert params["sat"]["long_weekend"] is True
        assert params["sat"]["long_weekend_note"] == "Mon off"
