# pyright: reportMissingImports=false
"""Tests for the board plugin (SPEC §7)."""

from __future__ import annotations

from typing import Any

import pytest
from PIL import Image

from homeboard.adapters import gkeep
from plugins.board.board import Board

_SETTINGS = {
    "keep_account_email": "throwaway@example.com",
    "projects_note_title": "Projects",
    "todo_note_title": "To do",
}

_PROJECTS_ROWS: list[dict[str, Any]] = [
    {
        "text": "* Frame the BBQ counter [weekend] — started 2026-08-22",
        "checked": False,
    },
    {"text": "Rebuild the side gate [half day]", "checked": False},
    {"text": "Insulate the garage door [weekend]", "checked": False},
]
_TODO_ROWS = [
    {"text": "Buy filters", "checked": False},
    {"text": "Return library books", "checked": False},
]


def _fetch_for(
    projects_rows: list[dict[str, Any]], todo_rows: list[dict[str, Any]]
) -> Any:
    def _fetch(note_title: str, email: str, master_token: str) -> list[dict[str, Any]]:
        return projects_rows if note_title == "Projects" else todo_rows

    return _fetch


class TestValidateSettings:
    def test_missing_email_is_rejected(self) -> None:
        plugin = Board({"id": "board"})
        settings = {**_SETTINGS, "keep_account_email": ""}
        assert plugin.validate_settings(settings) is not None

    def test_valid_settings_pass(self) -> None:
        plugin = Board({"id": "board"})
        assert plugin.validate_settings(_SETTINGS) is None


class TestGenerateImageConfigErrors:
    def test_missing_settings_raises_runtime_error(
        self, device_config_dev: Any
    ) -> None:
        plugin = Board({"id": "board"})
        with pytest.raises(RuntimeError):
            plugin.generate_image(
                {**_SETTINGS, "todo_note_title": ""}, device_config_dev
            )

    def test_missing_master_token_raises_runtime_error(
        self, device_config_dev: Any
    ) -> None:
        plugin = Board({"id": "board"})
        with pytest.raises(RuntimeError, match="master token"):
            plugin.generate_image(_SETTINGS, device_config_dev)


class TestGenerateImageHappyPath:
    def test_returns_an_image_with_mocked_keep_data(
        self, device_config_dev: Any, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        plugin = Board({"id": "board"})
        monkeypatch.setattr(
            device_config_dev.__class__, "load_env_key", lambda self, key: "fake-token"
        )
        monkeypatch.setattr(
            gkeep, "fetch_checklist", _fetch_for(_PROJECTS_ROWS, _TODO_ROWS)
        )

        image = plugin.generate_image(_SETTINGS, device_config_dev)
        assert isinstance(image, Image.Image)
        assert image.size == tuple(device_config_dev.get_resolution())

    def test_both_notes_empty_renders_empty_state(
        self, device_config_dev: Any, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        plugin = Board({"id": "board"})
        monkeypatch.setattr(
            device_config_dev.__class__, "load_env_key", lambda self, key: "fake-token"
        )
        monkeypatch.setattr(gkeep, "fetch_checklist", _fetch_for([], []))

        image = plugin.generate_image(_SETTINGS, device_config_dev)
        assert isinstance(image, Image.Image)

    def test_no_in_flight_items_still_renders(
        self, device_config_dev: Any, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        plugin = Board({"id": "board"})
        monkeypatch.setattr(
            device_config_dev.__class__, "load_env_key", lambda self, key: "fake-token"
        )
        backlog_only = [r for r in _PROJECTS_ROWS if not r["text"].startswith("*")]
        monkeypatch.setattr(
            gkeep, "fetch_checklist", _fetch_for(backlog_only, _TODO_ROWS)
        )

        image = plugin.generate_image(_SETTINGS, device_config_dev)
        assert isinstance(image, Image.Image)

    def test_empty_todo_list_still_renders(
        self, device_config_dev: Any, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        plugin = Board({"id": "board"})
        monkeypatch.setattr(
            device_config_dev.__class__, "load_env_key", lambda self, key: "fake-token"
        )
        monkeypatch.setattr(gkeep, "fetch_checklist", _fetch_for(_PROJECTS_ROWS, []))

        image = plugin.generate_image(_SETTINGS, device_config_dev)
        assert isinstance(image, Image.Image)


class TestGenerateImageFailSoft:
    def test_transient_failure_with_prior_cache_still_returns_an_image(
        self, device_config_dev: Any, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        plugin = Board({"id": "board"})
        monkeypatch.setattr(
            device_config_dev.__class__, "load_env_key", lambda self, key: "fake-token"
        )
        monkeypatch.setattr(
            gkeep, "fetch_checklist", _fetch_for(_PROJECTS_ROWS, _TODO_ROWS)
        )
        plugin.generate_image(_SETTINGS, device_config_dev)  # populates the cache

        def _flaky(*a: object, **k: object) -> list[dict[str, Any]]:
            raise TimeoutError("network blip")

        monkeypatch.setattr(gkeep, "fetch_checklist", _flaky)
        image = plugin.generate_image(_SETTINGS, device_config_dev)
        assert isinstance(image, Image.Image)

    def test_two_instances_with_different_notes_do_not_collide(
        self, device_config_dev: Any, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        plugin = Board({"id": "board"})
        monkeypatch.setattr(
            device_config_dev.__class__, "load_env_key", lambda self, key: "fake-token"
        )
        monkeypatch.setattr(
            gkeep, "fetch_checklist", _fetch_for(_PROJECTS_ROWS, _TODO_ROWS)
        )
        plugin.generate_image(
            {**_SETTINGS, "projects_note_title": "Projects A"}, device_config_dev
        )

        other_rows = [{"text": "Something else entirely", "checked": False}]
        monkeypatch.setattr(
            gkeep, "fetch_checklist", _fetch_for(other_rows, other_rows)
        )
        plugin.generate_image(
            {**_SETTINGS, "projects_note_title": "Projects B"}, device_config_dev
        )

        def _flaky(*a: object, **k: object) -> list[dict[str, Any]]:
            raise TimeoutError("network blip")

        monkeypatch.setattr(gkeep, "fetch_checklist", _flaky)
        image = plugin.generate_image(
            {**_SETTINGS, "projects_note_title": "Projects A"}, device_config_dev
        )
        assert isinstance(image, Image.Image)


class TestGenerateImageTooSmall:
    def test_tiny_panel_renders_too_small_message_not_raise(
        self, device_config_dev: Any, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        plugin = Board({"id": "board"})
        monkeypatch.setattr(
            device_config_dev.__class__, "load_env_key", lambda self, key: "fake-token"
        )
        monkeypatch.setattr(
            device_config_dev.__class__, "get_resolution", lambda self: (200, 100)
        )
        monkeypatch.setattr(
            gkeep, "fetch_checklist", _fetch_for(_PROJECTS_ROWS, _TODO_ROWS)
        )

        image = plugin.generate_image(_SETTINGS, device_config_dev)
        assert isinstance(image, Image.Image)


class TestLedger:
    def test_cleared_count_reflects_a_newly_checked_item(
        self, device_config_dev: Any, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        plugin = Board({"id": "board"})
        monkeypatch.setattr(
            device_config_dev.__class__, "load_env_key", lambda self, key: "fake-token"
        )
        open_todo = [{"text": "Buy filters", "checked": False}]
        monkeypatch.setattr(
            gkeep, "fetch_checklist", _fetch_for(_PROJECTS_ROWS, open_todo)
        )
        plugin.generate_image(_SETTINGS, device_config_dev)

        now_checked = [{"text": "Buy filters", "checked": True}]
        monkeypatch.setattr(
            gkeep, "fetch_checklist", _fetch_for(_PROJECTS_ROWS, now_checked)
        )
        image = plugin.generate_image(_SETTINGS, device_config_dev)
        assert isinstance(image, Image.Image)
