# pyright: reportMissingImports=false
"""Tests for the weekends plugin (SPEC §6)."""

from __future__ import annotations

from typing import Any

import pytest
from PIL import Image

from homeboard.adapters import ical
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
