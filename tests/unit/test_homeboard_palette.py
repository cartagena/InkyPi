"""Unit tests for homeboard.palette — SPEC.md §2 colour-role resolution."""

from __future__ import annotations

import sys
import types
from typing import Any

import numpy as np
import pytest
from PIL import Image

from homeboard import palette


class _FakeDeviceConfig:
    def __init__(self, display_type: str) -> None:
        self._display_type = display_type

    def get_config(self, key: str, default: object = None) -> object:
        if key == "display_type":
            return self._display_type
        return default

    def get_resolution(self) -> tuple[int, int]:
        return (800, 480)

    def load_env_key(self, key: str) -> str | None:
        return None


class TestDetectCapability:
    def test_mock_display_is_bw(self) -> None:
        assert palette._detect_capability(_FakeDeviceConfig("mock")) is False

    def test_unknown_display_type_is_bw(self) -> None:
        assert palette._detect_capability(_FakeDeviceConfig("something-else")) is False

    def test_non_string_display_type_is_bw(self) -> None:
        class Weird(_FakeDeviceConfig):
            def get_config(self, key: str, default: object = None) -> object:
                return None if key == "display_type" else default

        assert palette._detect_capability(Weird("mock")) is False

    @pytest.mark.parametrize(
        "model",
        ["epd4in01f", "epd5in65f", "epd7in3e", "epd7in3f"],
    )
    def test_known_full_colour_waveshare_models_are_six_colour(
        self, model: str
    ) -> None:
        assert palette._detect_capability(_FakeDeviceConfig(model)) is True

    @pytest.mark.parametrize(
        "model",
        ["epd2in13", "epd2in13_V4", "epd7in5", "epd1in54b"],
    )
    def test_bw_and_bicolour_waveshare_models_are_bw(self, model: str) -> None:
        assert palette._detect_capability(_FakeDeviceConfig(model)) is False

    def test_inky_without_hardware_falls_back_to_bw(self) -> None:
        # No `inky` package installed in this environment -> ImportError,
        # caught broadly -> bw fallback. This is the real-world dev/CI path.
        assert palette._detect_capability(_FakeDeviceConfig("inky")) is False

    def test_inky_hardware_detection_success_path(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        fake_driver = types.SimpleNamespace(colour="seven_colour")
        fake_auto_module = types.SimpleNamespace(auto=lambda: fake_driver)
        fake_inky_pkg = types.ModuleType("inky")
        fake_inky_pkg.auto = fake_auto_module  # type: ignore[attr-defined]
        monkeypatch.setitem(sys.modules, "inky", fake_inky_pkg)
        monkeypatch.setitem(sys.modules, "inky.auto", fake_auto_module)

        assert palette._detect_capability(_FakeDeviceConfig("inky")) is True

    def test_inky_hardware_detection_bw_variant(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        fake_driver = types.SimpleNamespace(colour="black")
        fake_auto_module = types.SimpleNamespace(auto=lambda: fake_driver)
        fake_inky_pkg = types.ModuleType("inky")
        fake_inky_pkg.auto = fake_auto_module  # type: ignore[attr-defined]
        monkeypatch.setitem(sys.modules, "inky", fake_inky_pkg)
        monkeypatch.setitem(sys.modules, "inky.auto", fake_auto_module)

        assert palette._detect_capability(_FakeDeviceConfig("inky")) is False

    def test_inky_hardware_detection_raising_falls_back_to_bw(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        def _raise() -> Any:
            raise RuntimeError("no hardware attached")

        fake_auto_module = types.SimpleNamespace(auto=_raise)
        fake_inky_pkg = types.ModuleType("inky")
        fake_inky_pkg.auto = fake_auto_module  # type: ignore[attr-defined]
        monkeypatch.setitem(sys.modules, "inky", fake_inky_pkg)
        monkeypatch.setitem(sys.modules, "inky.auto", fake_auto_module)

        assert palette._detect_capability(_FakeDeviceConfig("inky")) is False


class TestResolve:
    def test_mock_resolves_to_bw_role_map(self) -> None:
        roles = palette.resolve(_FakeDeviceConfig("mock"))
        assert roles.six_colour is False
        assert roles.colors[palette.Role.INK] == (0, 0, 0)
        assert roles.colors[palette.Role.PAPER] == (255, 255, 255)
        # bw fallback: every non-paper role reduces to ink.
        assert roles.colors[palette.Role.AVAILABLE] == (0, 0, 0)
        assert roles.colors[palette.Role.WARN] == (0, 0, 0)
        assert roles.colors[palette.Role.ALERT] == (0, 0, 0)

    def test_six_colour_panel_resolves_distinct_roles(self) -> None:
        roles = palette.resolve(_FakeDeviceConfig("epd7in3f"))
        assert roles.six_colour is True
        # Every role should be a distinct colour on a six-colour panel.
        assert len(set(roles.colors.values())) == len(roles.colors)

    def test_warn_is_never_solid_by_default(self) -> None:
        # Conservative default even on a detected six-colour panel, until a
        # human verifies legibility on the physical panel (SPEC §2.2).
        assert palette.resolve(_FakeDeviceConfig("mock")).warn_is_solid is False
        assert palette.resolve(_FakeDeviceConfig("epd7in3f")).warn_is_solid is False

    def test_all_roles_present(self) -> None:
        roles = palette.resolve(_FakeDeviceConfig("mock"))
        assert set(roles.colors.keys()) == set(palette.Role)


class TestQuantize:
    def test_maps_pixels_to_nearest_palette_colour(self) -> None:
        roles = palette.resolve(_FakeDeviceConfig("epd7in3f"))
        # A pixel that's a slightly-off shade of the "available" colour
        # (antialiasing edge) should map exactly onto a palette colour.
        available = roles.colors[palette.Role.AVAILABLE]
        near_available = tuple(min(255, c + 3) for c in available)
        img = Image.new("RGB", (4, 4), color=near_available)
        out = palette.quantize(img, roles)
        arr = np.asarray(out)
        assert set(map(tuple, arr.reshape(-1, 3).tolist())) <= set(
            roles.colors.values()
        )

    def test_exact_palette_colours_are_unchanged(self) -> None:
        roles = palette.resolve(_FakeDeviceConfig("mock"))
        img = Image.new("RGB", (2, 2), color=roles.colors[palette.Role.PAPER])
        out = palette.quantize(img, roles)
        arr = np.asarray(out)
        assert np.all(arr == np.array(roles.colors[palette.Role.PAPER]))

    def test_output_dimensions_match_input(self) -> None:
        roles = palette.resolve(_FakeDeviceConfig("mock"))
        img = Image.new("RGB", (37, 21), color=(128, 128, 128))
        out = palette.quantize(img, roles)
        assert out.size == (37, 21)

    def test_does_not_raise_in_dev_mode(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("INKYPI_ENV", "dev")
        roles = palette.resolve(_FakeDeviceConfig("mock"))
        img = Image.new("RGB", (10, 10), color=(120, 60, 200))  # way off-palette
        out = palette.quantize(img, roles)
        assert out.size == (10, 10)
