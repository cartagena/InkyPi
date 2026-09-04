"""Unit tests for homeboard.adapters.gkeep — no live Keep account needed."""

from __future__ import annotations

from unittest.mock import MagicMock

import gkeepapi
import pytest

from homeboard.adapters import gkeep


class TestValidateBoardSettings:
    def test_missing_email_is_rejected(self) -> None:
        error = gkeep.validate_board_settings(
            {
                "keep_account_email": "",
                "projects_note_title": "P",
                "todo_note_title": "T",
            }
        )
        assert error is not None
        assert "email" in error.lower()

    def test_missing_projects_title_is_rejected(self) -> None:
        error = gkeep.validate_board_settings(
            {
                "keep_account_email": "a@example.com",
                "projects_note_title": "",
                "todo_note_title": "T",
            }
        )
        assert error is not None

    def test_missing_todo_title_is_rejected(self) -> None:
        error = gkeep.validate_board_settings(
            {
                "keep_account_email": "a@example.com",
                "projects_note_title": "P",
                "todo_note_title": "",
            }
        )
        assert error is not None

    def test_all_present_passes(self) -> None:
        error = gkeep.validate_board_settings(
            {
                "keep_account_email": "a@example.com",
                "projects_note_title": "Projects",
                "todo_note_title": "To do",
            }
        )
        assert error is None


class TestFetchChecklistConfigErrors:
    def test_missing_note_title_raises(self) -> None:
        with pytest.raises(RuntimeError, match="Note title"):
            gkeep.fetch_checklist("", "a@example.com", "token")

    def test_missing_email_raises(self) -> None:
        with pytest.raises(RuntimeError, match="email"):
            gkeep.fetch_checklist("Projects", "", "token")

    def test_missing_master_token_raises(self) -> None:
        with pytest.raises(RuntimeError, match="master token"):
            gkeep.fetch_checklist("Projects", "a@example.com", "")


class _FakeItem:
    def __init__(self, text: str, checked: bool) -> None:
        self.text = text
        self.checked = checked


class _FakeList:
    """Stands in for gkeepapi.node.List — fetch_checklist() isinstance()-
    checks against the real class, so the fake must actually subclass it
    (a bare MagicMock would always fail that check)."""

    def __init__(self, title: str, items: list[_FakeItem]) -> None:
        self.title = title
        self.items = items


class TestFetchChecklistParsing:
    def _patch_list_class(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(gkeepapi.node, "List", _FakeList)

    def test_returns_items_in_note_order(self, monkeypatch: pytest.MonkeyPatch) -> None:
        self._patch_list_class(monkeypatch)
        items = [_FakeItem("Item A", False), _FakeItem("Item B", True)]
        note = _FakeList("Projects", items)

        mock_keep = MagicMock()
        mock_keep.find.return_value = [note]
        monkeypatch.setattr(gkeepapi, "Keep", lambda: mock_keep)

        result = gkeep.fetch_checklist("Projects", "a@example.com", "token")
        assert result == [
            {"text": "Item A", "checked": False},
            {"text": "Item B", "checked": True},
        ]
        mock_keep.authenticate.assert_called_once_with("a@example.com", "token")

    def test_note_not_found_returns_empty_list(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        mock_keep = MagicMock()
        mock_keep.find.return_value = []
        monkeypatch.setattr(gkeepapi, "Keep", lambda: mock_keep)

        assert gkeep.fetch_checklist("Missing Note", "a@example.com", "token") == []

    def test_title_must_match_exactly_not_substring(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        self._patch_list_class(monkeypatch)
        note = _FakeList("Projects Archive", [])
        mock_keep = MagicMock()
        mock_keep.find.return_value = [note]
        monkeypatch.setattr(gkeepapi, "Keep", lambda: mock_keep)

        assert gkeep.fetch_checklist("Projects", "a@example.com", "token") == []

    def test_never_calls_any_write_method(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Read-only guarantee (SPEC §4.5): the adapter must never call any
        gkeepapi write/sync-back method."""
        self._patch_list_class(monkeypatch)
        note = _FakeList("Projects", [])
        mock_keep = MagicMock()
        mock_keep.find.return_value = [note]
        monkeypatch.setattr(gkeepapi, "Keep", lambda: mock_keep)

        gkeep.fetch_checklist("Projects", "a@example.com", "token")

        for write_method in ("add", "createNote", "createList", "sync", "save"):
            assert not getattr(mock_keep, write_method).called
