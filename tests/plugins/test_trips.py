# pyright: reportMissingImports=false
"""Tests for the trips plugin (SPEC §8.1)."""

from __future__ import annotations

from typing import Any

import pytest
from PIL import Image

from homeboard.adapters import boardbot
from plugins.trips.trips import Trips

_SETTINGS = {
    "base_url": "http://piserver.local:8765",
}

_FIXTURE_ROWS: list[dict[str, Any]] = [
    {
        "name": "Tahoe with the Silvas",
        "status": "booked",
        "start": "2026-10-03",
        "end": "2026-10-05",
        "next_action": "Cabin not confirmed yet",
    },
    {
        "name": "Brazil, family visit",
        "status": "booked",
        "start": "2026-12-20",
        "end": "2027-01-05",
        "next_action": "Domestic leg still to book",
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


class TestValidateSettings:
    def test_missing_base_url_is_rejected(self) -> None:
        plugin = Trips({"id": "trips"})
        assert plugin.validate_settings({"base_url": ""}) is not None

    def test_valid_settings_pass(self) -> None:
        plugin = Trips({"id": "trips"})
        assert plugin.validate_settings(_SETTINGS) is None


class TestGenerateImageConfigErrors:
    def test_missing_base_url_raises_runtime_error(
        self, device_config_dev: Any
    ) -> None:
        plugin = Trips({"id": "trips"})
        with pytest.raises(RuntimeError):
            plugin.generate_image({"base_url": ""}, device_config_dev)

    def test_missing_api_token_raises_runtime_error(
        self, device_config_dev: Any
    ) -> None:
        plugin = Trips({"id": "trips"})
        with pytest.raises(RuntimeError, match="API token"):
            plugin.generate_image(_SETTINGS, device_config_dev)


class TestGenerateImageHappyPath:
    def test_returns_an_image_with_mocked_boardbot_data(
        self, device_config_dev: Any, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        plugin = Trips({"id": "trips"})
        monkeypatch.setattr(
            device_config_dev.__class__, "load_env_key", lambda self, key: "fake-token"
        )
        monkeypatch.setattr(boardbot, "fetch_trips", lambda *a, **k: _FIXTURE_ROWS)

        image = plugin.generate_image(_SETTINGS, device_config_dev)
        assert isinstance(image, Image.Image)
        assert image.size == tuple(device_config_dev.get_resolution())

    def test_empty_boardbot_returns_an_image(
        self, device_config_dev: Any, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        plugin = Trips({"id": "trips"})
        monkeypatch.setattr(
            device_config_dev.__class__, "load_env_key", lambda self, key: "fake-token"
        )
        monkeypatch.setattr(boardbot, "fetch_trips", lambda *a, **k: [])

        image = plugin.generate_image(_SETTINGS, device_config_dev)
        assert isinstance(image, Image.Image)

    def test_two_instances_with_different_base_urls_do_not_collide(
        self, device_config_dev: Any, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        plugin = Trips({"id": "trips"})
        monkeypatch.setattr(
            device_config_dev.__class__, "load_env_key", lambda self, key: "fake-token"
        )

        monkeypatch.setattr(boardbot, "fetch_trips", lambda *a, **k: _FIXTURE_ROWS)
        plugin.generate_image({"base_url": "http://host-a:8765"}, device_config_dev)

        other_rows = [
            {
                "name": "Iceland ring road",
                "status": "idea",
                "target_window": "Summer",
            }
        ]
        monkeypatch.setattr(boardbot, "fetch_trips", lambda *a, **k: other_rows)
        plugin.generate_image({"base_url": "http://host-b:8765"}, device_config_dev)

        def _flaky(*a: object, **k: object) -> list[dict[str, Any]]:
            raise TimeoutError("network blip")

        monkeypatch.setattr(boardbot, "fetch_trips", _flaky)
        image = plugin.generate_image(
            {"base_url": "http://host-a:8765"}, device_config_dev
        )
        assert isinstance(image, Image.Image)


class TestGenerateImageFailSoft:
    def test_transient_failure_with_prior_cache_still_returns_an_image(
        self, device_config_dev: Any, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        plugin = Trips({"id": "trips"})
        monkeypatch.setattr(
            device_config_dev.__class__, "load_env_key", lambda self, key: "fake-token"
        )

        monkeypatch.setattr(boardbot, "fetch_trips", lambda *a, **k: _FIXTURE_ROWS)
        plugin.generate_image(_SETTINGS, device_config_dev)  # populates the cache

        def _flaky(*a: object, **k: object) -> list[dict[str, Any]]:
            raise TimeoutError("network blip")

        monkeypatch.setattr(boardbot, "fetch_trips", _flaky)
        image = plugin.generate_image(_SETTINGS, device_config_dev)
        assert isinstance(image, Image.Image)

    def test_transient_failure_with_no_cache_renders_empty_state_not_raise(
        self, device_config_dev: Any, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        plugin = Trips({"id": "trips"})
        monkeypatch.setattr(
            device_config_dev.__class__, "load_env_key", lambda self, key: "fake-token"
        )

        def _flaky(*a: object, **k: object) -> list[dict[str, Any]]:
            raise TimeoutError("network blip")

        monkeypatch.setattr(boardbot, "fetch_trips", _flaky)
        image = plugin.generate_image(_SETTINGS, device_config_dev)
        assert isinstance(image, Image.Image)


class TestGenerateImageTooSmall:
    def test_tiny_panel_renders_too_small_message_not_raise(
        self, device_config_dev: Any, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        plugin = Trips({"id": "trips"})
        monkeypatch.setattr(
            device_config_dev.__class__, "load_env_key", lambda self, key: "fake-token"
        )
        monkeypatch.setattr(
            device_config_dev.__class__, "get_resolution", lambda self: (200, 100)
        )
        monkeypatch.setattr(boardbot, "fetch_trips", lambda *a, **k: _FIXTURE_ROWS)

        image = plugin.generate_image(_SETTINGS, device_config_dev)
        assert isinstance(image, Image.Image)
