"""Unit tests for RefreshTask.refresh_current (button "refresh_now" action)."""

from typing import Any
from unittest.mock import MagicMock

import pytest


def _make_task(device_config_dev: Any) -> Any:
    from display.display_manager import DisplayManager
    from refresh_task import RefreshTask

    dm = DisplayManager(device_config_dev)
    return RefreshTask(device_config_dev, dm)


def test_refresh_current_noop_when_not_running(device_config_dev: Any) -> None:
    task = _make_task(device_config_dev)
    assert task.refresh_current() is False


def test_refresh_current_noop_when_no_active_playlist(
    device_config_dev: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    task = _make_task(device_config_dev)
    task.running = True
    playlist_manager = MagicMock()
    playlist_manager.determine_active_playlist.return_value = None
    monkeypatch.setattr(
        device_config_dev, "get_playlist_manager", lambda: playlist_manager
    )
    monkeypatch.setattr(task, "manual_update", MagicMock())

    assert task.refresh_current() is False
    task.manual_update.assert_not_called()


def test_refresh_current_noop_when_nothing_currently_showing(
    device_config_dev: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    task = _make_task(device_config_dev)
    task.running = True
    playlist = MagicMock()
    playlist.get_current_plugin.return_value = None
    playlist_manager = MagicMock()
    playlist_manager.determine_active_playlist.return_value = playlist
    monkeypatch.setattr(
        device_config_dev, "get_playlist_manager", lambda: playlist_manager
    )
    monkeypatch.setattr(task, "manual_update", MagicMock())

    assert task.refresh_current() is False
    task.manual_update.assert_not_called()


def test_refresh_current_dispatches_without_advancing(
    device_config_dev: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    from refresh_task import PlaylistRefresh

    task = _make_task(device_config_dev)
    task.running = True
    playlist = MagicMock()
    plugin_instance = MagicMock()
    playlist.get_current_plugin.return_value = plugin_instance
    playlist_manager = MagicMock()
    playlist_manager.determine_active_playlist.return_value = playlist
    monkeypatch.setattr(
        device_config_dev, "get_playlist_manager", lambda: playlist_manager
    )
    manual_update = MagicMock()
    monkeypatch.setattr(task, "manual_update", manual_update)

    assert task.refresh_current() is True
    manual_update.assert_called_once()
    (dispatched_action,), _kwargs = manual_update.call_args
    assert isinstance(dispatched_action, PlaylistRefresh)
    assert dispatched_action.playlist is playlist
    assert dispatched_action.plugin_instance is plugin_instance
    assert dispatched_action.force is True
    # Only the next-item path advances the index — this must not touch it.
    playlist.get_next_eligible_plugin.assert_not_called()
