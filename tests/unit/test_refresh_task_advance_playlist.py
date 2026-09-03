"""Unit tests for RefreshTask.advance_playlist_next (button-A entry point)."""

from typing import Any
from unittest.mock import MagicMock

import pytest


def _make_task(device_config_dev: Any) -> Any:
    from display.display_manager import DisplayManager
    from refresh_task import RefreshTask

    dm = DisplayManager(device_config_dev)
    return RefreshTask(device_config_dev, dm)


def test_advance_playlist_next_noop_when_not_running(device_config_dev: Any) -> None:
    task = _make_task(device_config_dev)
    assert task.advance_playlist_next() is False


def test_advance_playlist_next_noop_when_blackout_active(
    device_config_dev: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Regression: must not commit current_plugin_index while blacked out.

    get_next_eligible_plugin() mutates and commits the playlist index
    unconditionally, before manual_update() ever gets a chance to check
    blackout_active — so the blackout check has to happen here, first, or a
    playlist item is silently skipped every time this is called while
    blacked out (see /code-review finding on this branch).
    """
    task = _make_task(device_config_dev)
    task.running = True
    task.blackout_active = True
    playlist_manager = MagicMock()
    monkeypatch.setattr(
        device_config_dev, "get_playlist_manager", lambda: playlist_manager
    )
    manual_update = MagicMock()
    monkeypatch.setattr(task, "manual_update", manual_update)

    assert task.advance_playlist_next() is False
    playlist_manager.determine_active_playlist.assert_not_called()
    manual_update.assert_not_called()


def test_advance_playlist_next_noop_when_no_active_playlist(
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

    assert task.advance_playlist_next() is False
    task.manual_update.assert_not_called()


def test_advance_playlist_next_noop_when_no_eligible_plugin(
    device_config_dev: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    task = _make_task(device_config_dev)
    task.running = True
    playlist = MagicMock()
    playlist.get_next_eligible_plugin.return_value = None
    playlist_manager = MagicMock()
    playlist_manager.determine_active_playlist.return_value = playlist
    monkeypatch.setattr(
        device_config_dev, "get_playlist_manager", lambda: playlist_manager
    )
    monkeypatch.setattr(task, "manual_update", MagicMock())

    assert task.advance_playlist_next() is False
    task.manual_update.assert_not_called()


def test_advance_playlist_next_dispatches_playlist_refresh(
    device_config_dev: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    from refresh_task import PlaylistRefresh

    task = _make_task(device_config_dev)
    task.running = True
    playlist = MagicMock()
    plugin_instance = MagicMock()
    playlist.get_next_eligible_plugin.return_value = plugin_instance
    playlist_manager = MagicMock()
    playlist_manager.determine_active_playlist.return_value = playlist
    monkeypatch.setattr(
        device_config_dev, "get_playlist_manager", lambda: playlist_manager
    )
    manual_update = MagicMock()
    monkeypatch.setattr(task, "manual_update", manual_update)

    assert task.advance_playlist_next() is True
    manual_update.assert_called_once()
    (dispatched_action,), _kwargs = manual_update.call_args
    assert isinstance(dispatched_action, PlaylistRefresh)
    assert dispatched_action.playlist is playlist
    assert dispatched_action.plugin_instance is plugin_instance
    assert dispatched_action.force is True
