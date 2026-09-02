"""Unit tests for RefreshTask blackout (B12 kill switch)."""

from typing import Any
from unittest.mock import MagicMock

import pytest


def _make_task(device_config_dev: Any) -> Any:
    from display.display_manager import DisplayManager
    from refresh_task import RefreshTask

    dm = DisplayManager(device_config_dev)
    return RefreshTask(device_config_dev, dm)


def test_blackout_defaults_off(device_config_dev: Any) -> None:
    task = _make_task(device_config_dev)
    assert task.blackout_active is False


def test_blackout_reads_persisted_state(device_config_dev: Any) -> None:
    device_config_dev.update_value("blackout_active", True)
    task = _make_task(device_config_dev)
    assert task.blackout_active is True


def test_set_blackout_true_persists_and_blanks_display(
    device_config_dev: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    task = _make_task(device_config_dev)
    blank_calls = []
    monkeypatch.setattr(task, "_blank_display", lambda: blank_calls.append(True))

    result = task.set_blackout(True)

    assert result is True
    assert task.blackout_active is True
    assert device_config_dev.get_config("blackout_active") is True
    assert blank_calls == [True]


def test_set_blackout_false_resumes_current_plugin(
    device_config_dev: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    task = _make_task(device_config_dev)
    task.blackout_active = True
    refresh_current = MagicMock(return_value=True)
    advance = MagicMock()
    monkeypatch.setattr(task, "refresh_current", refresh_current)
    monkeypatch.setattr(task, "advance_playlist_next", advance)

    result = task.set_blackout(False)

    assert result is False
    assert task.blackout_active is False
    refresh_current.assert_called_once()
    advance.assert_not_called()


def test_set_blackout_false_falls_back_to_advance_when_nothing_showing(
    device_config_dev: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    task = _make_task(device_config_dev)
    task.blackout_active = True
    refresh_current = MagicMock(return_value=False)
    advance = MagicMock()
    monkeypatch.setattr(task, "refresh_current", refresh_current)
    monkeypatch.setattr(task, "advance_playlist_next", advance)

    task.set_blackout(False)

    refresh_current.assert_called_once()
    advance.assert_called_once()


def test_manual_update_skipped_while_blackout_active(
    device_config_dev: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    from refresh_task import ManualRefresh

    task = _make_task(device_config_dev)
    task.running = True
    task.blackout_active = True
    enqueue = MagicMock()
    monkeypatch.setattr(task, "_enqueue_manual_request", enqueue)

    result = task.manual_update(ManualRefresh("ai_text", {}))

    assert result is None
    enqueue.assert_not_called()


def test_select_refresh_action_skips_scheduled_refresh_during_blackout(
    device_config_dev: Any,
) -> None:
    task = _make_task(device_config_dev)
    task.blackout_active = True
    playlist_manager = MagicMock()

    refresh_action, request_id = task._select_refresh_action(
        playlist_manager, None, task._get_current_datetime(), None
    )

    assert refresh_action is None
    assert request_id is None
    playlist_manager.determine_active_playlist.assert_not_called()


def test_start_reblanks_display_when_blackout_persisted(
    device_config_dev: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    device_config_dev.update_value("blackout_active", True)
    task = _make_task(device_config_dev)
    blank_calls = []
    monkeypatch.setattr(task, "_blank_display", lambda: blank_calls.append(True))

    task.start()
    try:
        assert blank_calls == [True]
    finally:
        task.stop()
