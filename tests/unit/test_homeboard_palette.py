"""Unit tests for homeboard.palette — SPEC.md §2 colour-role resolution."""

from __future__ import annotations

import sys
import types
from typing import Any

import numpy as np
import pytest
from PIL import Image

from homeboard import palette


@pytest.fixture(autouse=True)
def _clear_inky_detection_memo() -> Any:
    """Drop palette's inky-probe memo around every test.

    `_detect_inky_six_colour()` caches its result for the life of the
    process (the probe is an I2C EEPROM read on real hardware). Each test
    below monkeypatches a *different* fake `inky` module, so without this
    they would all see whichever answer happened to be cached first.
    """
    palette.reset_inky_detection_cache()
    yield
    palette.reset_inky_detection_cache()


class _FakeDeviceConfig:
    config_file = "/tmp/does-not-matter/device.json"

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
        # What every full-colour inky driver actually reports: `colour="multi"`
        # (inky 2.4.0, e.g. inky_e673.py:106). The previous "seven_colour"
        # mock asserted a contract no release of `inky` has ever emitted.
        fake_driver = types.SimpleNamespace(colour="multi")
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

    def test_mock_stays_bw_with_preview_env_unset(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("INKYPI_ENV", "dev")
        monkeypatch.delenv("HOMEBOARD_COLOUR_PREVIEW", raising=False)
        assert palette._detect_capability(_FakeDeviceConfig("mock")) is False

    def test_mock_is_six_colour_with_preview_env_enabled_in_dev(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("INKYPI_ENV", "dev")
        monkeypatch.setenv("HOMEBOARD_COLOUR_PREVIEW", "1")
        assert palette._detect_capability(_FakeDeviceConfig("mock")) is True

    def test_preview_env_enabled_outside_dev_mode_stays_bw(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # The toggle is dev-only by design — it must never activate against
        # a real device's config just because the env var leaked in.
        monkeypatch.delenv("INKYPI_ENV", raising=False)
        monkeypatch.delenv("FLASK_ENV", raising=False)
        monkeypatch.setenv("HOMEBOARD_COLOUR_PREVIEW", "1")
        assert palette._detect_capability(_FakeDeviceConfig("mock")) is False

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


class TestMissingDisplayTypeDefault:
    """display_type is absent from device.json on every Inky install.

    install.sh's update_config() only writes the key when WS_TYPE is set
    (i.e. for Waveshare), and install/config_base/device.json does not carry
    it. So the default this module picks is what a real Inky Impression
    actually gets, and it has to agree with DisplayManager's.
    """

    class _NoDisplayType:
        config_file = "/tmp/does-not-matter/device.json"

        def get_config(self, key: str, default: object = None) -> object:
            return default  # key genuinely absent, as in production

        def get_resolution(self) -> tuple[int, int]:
            return (800, 480)

        def load_env_key(self, key: str) -> str | None:
            return None

    def test_default_matches_display_manager(self) -> None:
        # Regression: palette defaulted to "mock" while DisplayManager
        # defaulted to "inky", so a real panel drove correctly *and*
        # resolved to the bw palette — every screen rendered monochrome
        # however the hardware probe answered.
        import inspect

        from display.display_manager import DisplayManager

        src = inspect.getsource(DisplayManager.__init__)
        assert 'get_config("display_type", default="inky")' in src, (
            "DisplayManager's display_type default changed; palette's "
            "_detect_capability default must be changed to match."
        )

    def test_absent_display_type_probes_the_inky_hardware(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        fake_driver = types.SimpleNamespace(colour="multi")
        fake_auto_module = types.SimpleNamespace(auto=lambda: fake_driver)
        fake_inky_pkg = types.ModuleType("inky")
        fake_inky_pkg.auto = fake_auto_module  # type: ignore[attr-defined]
        monkeypatch.setitem(sys.modules, "inky", fake_inky_pkg)
        monkeypatch.setitem(sys.modules, "inky.auto", fake_auto_module)

        assert palette._detect_capability(self._NoDisplayType()) is True

    def test_absent_display_type_resolves_colour_roles(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        fake_driver = types.SimpleNamespace(colour="multi")
        fake_auto_module = types.SimpleNamespace(auto=lambda: fake_driver)
        fake_inky_pkg = types.ModuleType("inky")
        fake_inky_pkg.auto = fake_auto_module  # type: ignore[attr-defined]
        monkeypatch.setitem(sys.modules, "inky", fake_inky_pkg)
        monkeypatch.setitem(sys.modules, "inky.auto", fake_auto_module)

        roles = palette.resolve(self._NoDisplayType())
        assert roles.six_colour is True
        assert roles.colors[palette.Role.ALERT] != (0, 0, 0)


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

    @pytest.mark.parametrize("grey", [64, 96, 128, 144, 160, 175])
    def test_dark_neutral_greys_snap_to_ink_not_a_chromatic_ink(
        self, grey: int
    ) -> None:
        # Regression: a plain nearest-Euclidean match sent glyph-antialiasing
        # greys onto the saturated inks (grey 72..136 -> AVAILABLE green,
        # 144..160 -> WARN yellow), so text edges came out coloured and the
        # panel's Floyd-Steinberg pass had error to diffuse. Neutrals must
        # resolve on luma alone.
        roles = palette.resolve(_FakeDeviceConfig("epd7in3f"))
        img = Image.new("RGB", (3, 3), color=(grey, grey, grey))
        arr = np.asarray(palette.quantize(img, roles))
        assert np.all(arr == np.array(roles.colors[palette.Role.INK]))

    @pytest.mark.parametrize("grey", [176, 200, 240, 255])
    def test_light_neutral_greys_snap_to_paper(self, grey: int) -> None:
        roles = palette.resolve(_FakeDeviceConfig("epd7in3f"))
        img = Image.new("RGB", (3, 3), color=(grey, grey, grey))
        arr = np.asarray(palette.quantize(img, roles))
        assert np.all(arr == np.array(roles.colors[palette.Role.PAPER]))

    def test_saturated_pixels_still_take_the_chromatic_match(self) -> None:
        # The neutral special-case must not swallow real colour: a near-miss
        # of each saturated ink still has to land back on that ink.
        roles = palette.resolve(_FakeDeviceConfig("epd7in3f"))
        for role in (
            palette.Role.AVAILABLE,
            palette.Role.WARN,
            palette.Role.ALERT,
            palette.Role.EMPHASIS,
        ):
            target = roles.colors[role]
            near = tuple(max(0, min(255, c + 5)) for c in target)
            img = Image.new("RGB", (2, 2), color=near)
            arr = np.asarray(palette.quantize(img, roles))
            assert np.all(arr == np.array(target)), role

    def test_white_on_red_glyph_edge_does_not_become_yellow(self) -> None:
        # Regression: (240, 145, 140) is a real antialiasing blend from
        # white text on an alert-red chip. Under a plain nearest-colour
        # match its squared distance was 23715 to red and 25550 to white,
        # but only 17035 to WARN yellow — so every such edge pixel came out
        # yellow, an ink none of the screens use. Measured speckle before
        # the segment match: 64 px on board, 210 on trips, 113 on
        # home_maintenance, 767 on weekends.
        roles = palette.resolve(_FakeDeviceConfig("epd7in3f"))
        img = Image.new("RGB", (2, 2), color=(240, 145, 140))
        arr = np.asarray(palette.quantize(img, roles))
        assert np.all(arr == np.array(roles.colors[palette.Role.ALERT]))

    def test_blend_of_two_inks_resolves_to_one_of_those_two(self) -> None:
        # The general invariant behind the case above: quantizing a blend of
        # two palette colours must pick one of those two endpoints, never a
        # third ink that happens to sit nearer the midpoint.
        roles = palette.resolve(_FakeDeviceConfig("epd7in3f"))
        entries = list(dict.fromkeys(roles.colors.values()))
        for i, first in enumerate(entries):
            for second in entries[i + 1 :]:
                for weight in (0.25, 0.5, 0.75):
                    blend = tuple(
                        round(a * (1 - weight) + b * weight)
                        for a, b in zip(first, second, strict=True)
                    )
                    img = Image.new("RGB", (2, 2), color=blend)
                    got = tuple(np.asarray(palette.quantize(img, roles))[0, 0])
                    assert got in (first, second), (first, second, weight, blend)


class TestInkyDetectionMemo:
    def test_result_is_memoised_so_the_eeprom_is_probed_once(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # resolve() runs on every render of every homeboard screen; the probe
        # behind it is an I2C read on real hardware.
        calls: list[int] = []

        def _auto() -> Any:
            calls.append(1)
            return types.SimpleNamespace(colour="multi")

        fake_auto_module = types.SimpleNamespace(auto=_auto)
        fake_inky_pkg = types.ModuleType("inky")
        fake_inky_pkg.auto = fake_auto_module  # type: ignore[attr-defined]
        monkeypatch.setitem(sys.modules, "inky", fake_inky_pkg)
        monkeypatch.setitem(sys.modules, "inky.auto", fake_auto_module)

        cfg = _FakeDeviceConfig("inky")
        assert palette._detect_capability(cfg) is True
        assert palette._detect_capability(cfg) is True
        assert palette._detect_capability(cfg) is True
        assert len(calls) == 1

    def test_completed_negative_probe_is_memoised(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # A probe that *ran* and said "bw panel" is a real answer and can be
        # cached like any other.
        calls: list[int] = []

        def _auto() -> Any:
            calls.append(1)
            return types.SimpleNamespace(colour="black")

        fake_auto_module = types.SimpleNamespace(auto=_auto)
        fake_inky_pkg = types.ModuleType("inky")
        fake_inky_pkg.auto = fake_auto_module  # type: ignore[attr-defined]
        monkeypatch.setitem(sys.modules, "inky", fake_inky_pkg)
        monkeypatch.setitem(sys.modules, "inky.auto", fake_auto_module)

        cfg = _FakeDeviceConfig("inky")
        assert palette._detect_capability(cfg) is False
        assert palette._detect_capability(cfg) is False
        assert len(calls) == 1

    def test_failed_probe_is_not_memoised(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # A probe that *raised* is not an answer. generate_image() also runs
        # synchronously in the long-lived Flask process (preview, update-now,
        # display-next), so caching a transient I2C/import failure there would
        # pin every later web-triggered render to the bw fallback until
        # inkypi restarts, while the refresh worker kept rendering in colour.
        calls: list[int] = []

        def _auto() -> Any:
            calls.append(1)
            raise RuntimeError("no hardware attached")

        fake_auto_module = types.SimpleNamespace(auto=_auto)
        fake_inky_pkg = types.ModuleType("inky")
        fake_inky_pkg.auto = fake_auto_module  # type: ignore[attr-defined]
        monkeypatch.setitem(sys.modules, "inky", fake_inky_pkg)
        monkeypatch.setitem(sys.modules, "inky.auto", fake_auto_module)

        cfg = _FakeDeviceConfig("inky")
        assert palette._detect_capability(cfg) is False
        assert palette._detect_capability(cfg) is False
        assert len(calls) == 2

    def test_probe_self_heals_after_a_transient_failure(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # The point of not caching failures: once the bus frees up, the very
        # next render picks up the real answer without a restart.
        calls: list[int] = []

        def _auto() -> Any:
            calls.append(1)
            if len(calls) == 1:
                raise RuntimeError("bus busy")
            return types.SimpleNamespace(colour="multi")

        fake_auto_module = types.SimpleNamespace(auto=_auto)
        fake_inky_pkg = types.ModuleType("inky")
        fake_inky_pkg.auto = fake_auto_module  # type: ignore[attr-defined]
        monkeypatch.setitem(sys.modules, "inky", fake_inky_pkg)
        monkeypatch.setitem(sys.modules, "inky.auto", fake_auto_module)

        cfg = _FakeDeviceConfig("inky")
        assert palette._detect_capability(cfg) is False
        assert palette._detect_capability(cfg) is True
        assert palette._detect_capability(cfg) is True
        assert len(calls) == 2

    def test_reset_forces_a_re_probe(self, monkeypatch: pytest.MonkeyPatch) -> None:
        calls: list[int] = []

        def _auto() -> Any:
            calls.append(1)
            return types.SimpleNamespace(colour="multi")

        fake_auto_module = types.SimpleNamespace(auto=_auto)
        fake_inky_pkg = types.ModuleType("inky")
        fake_inky_pkg.auto = fake_auto_module  # type: ignore[attr-defined]
        monkeypatch.setitem(sys.modules, "inky", fake_inky_pkg)
        monkeypatch.setitem(sys.modules, "inky.auto", fake_auto_module)

        cfg = _FakeDeviceConfig("inky")
        assert palette._detect_capability(cfg) is True
        palette.reset_inky_detection_cache()
        assert palette._detect_capability(cfg) is True
        assert len(calls) == 2
