"""Unit tests for ButtonTask (configurable physical Inky Impression buttons)."""

import sys
import types
from typing import Any
from unittest.mock import MagicMock

import pytest


class _FakeDeviceConfig:
    def __init__(self, config: dict[str, Any]) -> None:
        self._config = config

    def get_config(self, key: str, default: Any = None) -> Any:
        return self._config.get(key, default)


def _make_button_task(
    config: dict[str, Any], refresh_task: Any = None
) -> tuple[Any, Any]:
    from button_task import ButtonTask

    refresh_task = refresh_task if refresh_task is not None else MagicMock()
    device_config = _FakeDeviceConfig(config)
    return ButtonTask(device_config, refresh_task), refresh_task


def test_does_not_start_when_display_type_is_not_inky() -> None:
    task, _ = _make_button_task({"display_type": "mock"})
    task.start()
    assert task.thread is None
    assert task.running is False


def test_does_not_start_when_buttons_disabled() -> None:
    task, _ = _make_button_task({"display_type": "inky", "buttons": {"enabled": False}})
    task.start()
    assert task.thread is None


def test_does_not_start_when_every_button_action_is_none() -> None:
    task, _ = _make_button_task(
        {
            "display_type": "inky",
            "buttons": {
                "actions": {"A": "none", "B": "none", "C": "none", "D": "none"}
            },
        }
    )
    task.start()
    assert task.thread is None


def test_does_not_start_when_gpiod_unavailable(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setitem(sys.modules, "gpiod", None)
    monkeypatch.setitem(sys.modules, "gpiodevice", None)
    task, _ = _make_button_task({"display_type": "inky"})
    task.start()
    assert task.thread is None
    assert task.running is False


def _install_fake_gpiod(
    monkeypatch: pytest.MonkeyPatch, request: Any
) -> tuple[Any, Any]:
    """Stub gpiod/gpiodevice so ButtonTask.start() can run without hardware."""
    fake_line_module = types.ModuleType("gpiod.line")
    fake_line_module.Bias = types.SimpleNamespace(PULL_UP="PULL_UP")  # type: ignore[attr-defined]
    fake_line_module.Direction = types.SimpleNamespace(INPUT="INPUT")  # type: ignore[attr-defined]
    fake_line_module.Edge = types.SimpleNamespace(FALLING="FALLING")  # type: ignore[attr-defined]

    fake_gpiod = types.ModuleType("gpiod")
    fake_gpiod.LineSettings = MagicMock(return_value="line-settings")  # type: ignore[attr-defined]
    fake_gpiod.line = fake_line_module  # type: ignore[attr-defined]

    # GPIO number -> line offset is identity for these tests.
    chip = MagicMock()
    chip.line_offset_from_id.side_effect = lambda gpio_num: gpio_num
    chip.request_lines.return_value = request

    fake_gpiodevice = types.ModuleType("gpiodevice")
    fake_gpiodevice.find_chip_by_platform = MagicMock(return_value=chip)  # type: ignore[attr-defined]

    monkeypatch.setitem(sys.modules, "gpiod", fake_gpiod)
    monkeypatch.setitem(sys.modules, "gpiod.line", fake_line_module)
    monkeypatch.setitem(sys.modules, "gpiodevice", fake_gpiodevice)
    return fake_gpiod, fake_gpiodevice


def test_start_stop_lifecycle(monkeypatch: pytest.MonkeyPatch) -> None:
    request = MagicMock()
    request.wait_edge_events.return_value = False
    _install_fake_gpiod(monkeypatch, request)

    task, _ = _make_button_task({"display_type": "inky"})
    task.start()
    try:
        assert task.running is True
        assert task.thread is not None
        assert task.thread.is_alive()
        # Only button A is active by default, so only its pin is requested.
        assert task._offset_labels == {5: "A"}
    finally:
        task.stop()

    assert task.running is False
    request.release.assert_called_once()


def _make_event(line_offset: int) -> Any:
    event = MagicMock()
    event.line_offset = line_offset
    return event


def test_button_a_press_advances_playlist_by_default(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import time

    request = MagicMock()
    request.wait_edge_events.side_effect = [True] + [False] * 200
    request.read_edge_events.return_value = [_make_event(5)]
    _install_fake_gpiod(monkeypatch, request)

    refresh_task = MagicMock()
    task, _ = _make_button_task(
        {"display_type": "inky", "buttons": {"debounce_seconds": 0}}, refresh_task
    )
    task.start()
    try:
        for _ in range(100):
            if refresh_task.advance_playlist_next.called:
                break
            time.sleep(0.01)
        else:
            pytest.fail("advance_playlist_next was not called after a button press")
    finally:
        task.stop()

    refresh_task.advance_playlist_next.assert_called()
    refresh_task.refresh_current.assert_not_called()


def test_button_b_press_dispatches_configured_refresh_now(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import time

    request = MagicMock()
    request.wait_edge_events.side_effect = [True] + [False] * 200
    request.read_edge_events.return_value = [_make_event(6)]
    _install_fake_gpiod(monkeypatch, request)

    refresh_task = MagicMock()
    task, _ = _make_button_task(
        {
            "display_type": "inky",
            "buttons": {
                "debounce_seconds": 0,
                "actions": {"A": "none", "B": "refresh_now"},
            },
        },
        refresh_task,
    )
    task.start()
    try:
        assert task._offset_labels == {6: "B"}
        for _ in range(100):
            if refresh_task.refresh_current.called:
                break
            time.sleep(0.01)
        else:
            pytest.fail("refresh_current was not called after a button press")
    finally:
        task.stop()

    refresh_task.refresh_current.assert_called()
    refresh_task.advance_playlist_next.assert_not_called()


def test_custom_pin_is_used_for_gpio_lookup(monkeypatch: pytest.MonkeyPatch) -> None:
    request = MagicMock()
    request.wait_edge_events.return_value = False
    _install_fake_gpiod(monkeypatch, request)

    task, _ = _make_button_task(
        {
            "display_type": "inky",
            "buttons": {"pins": {"C": 25}, "actions": {"C": "refresh_now"}},
        }
    )
    task.start()
    try:
        # Both the default button A and reconfigured C should be active.
        assert task._offset_labels == {5: "A", 25: "C"}
    finally:
        task.stop()


def test_debounce_suppresses_rapid_presses_per_button() -> None:
    from button_task import ButtonTask

    refresh_task = MagicMock()
    device_config = _FakeDeviceConfig(
        {
            "display_type": "inky",
            "buttons": {
                "debounce_seconds": 100.0,
                "actions": {"A": "next_playlist_item", "B": "refresh_now"},
            },
        }
    )
    task = ButtonTask(device_config, refresh_task)

    task._handle_press("A")
    task._handle_press("A")
    task._handle_press("B")

    refresh_task.advance_playlist_next.assert_called_once()
    refresh_task.refresh_current.assert_called_once()


def test_blackout_toggle_action_calls_set_blackout() -> None:
    from button_task import ButtonTask

    refresh_task = MagicMock()
    refresh_task.blackout_active = False
    device_config = _FakeDeviceConfig(
        {
            "display_type": "inky",
            "buttons": {"debounce_seconds": 0, "actions": {"A": "blackout_toggle"}},
        }
    )
    task = ButtonTask(device_config, refresh_task)

    task._handle_press("A")

    refresh_task.set_blackout.assert_called_once_with(True)


def test_invalid_action_falls_back_to_default() -> None:
    from button_task import ButtonTask

    refresh_task = MagicMock()
    device_config = _FakeDeviceConfig(
        {
            "display_type": "inky",
            "buttons": {
                "debounce_seconds": 0,
                "actions": {"A": "delete_everything"},
            },
        }
    )
    task = ButtonTask(device_config, refresh_task)

    task._handle_press("A")

    # Unknown action name in config is ignored; A keeps its default.
    refresh_task.advance_playlist_next.assert_called_once()


def test_press_dispatches_same_as_handle_press() -> None:
    from button_task import ButtonTask

    refresh_task = MagicMock()
    device_config = _FakeDeviceConfig(
        {
            "display_type": "inky",
            "buttons": {"debounce_seconds": 0, "actions": {"B": "refresh_now"}},
        }
    )
    task = ButtonTask(device_config, refresh_task)

    task.press("B")

    refresh_task.refresh_current.assert_called_once()


def test_press_rejects_unknown_label() -> None:
    task, _ = _make_button_task({"display_type": "inky"})
    with pytest.raises(ValueError):
        task.press("Z")


def test_configured_action_reflects_config() -> None:
    from button_task import ButtonTask

    device_config = _FakeDeviceConfig(
        {"display_type": "inky", "buttons": {"actions": {"C": "refresh_now"}}}
    )
    task = ButtonTask(device_config, MagicMock())

    assert task.configured_action("A") == "next_playlist_item"
    assert task.configured_action("C") == "refresh_now"
