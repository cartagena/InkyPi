"""Unit tests for homeboard.adapters.boardbot — no live boardbot deployment
needed."""

from __future__ import annotations

from typing import Any
from unittest.mock import MagicMock

import pytest
import requests

from homeboard.adapters import boardbot


class TestValidateBoardSettings:
    def test_missing_base_url_is_rejected(self) -> None:
        error = boardbot.validate_board_settings({"base_url": ""})
        assert error is not None
        assert "url" in error.lower()

    def test_blank_base_url_is_rejected(self) -> None:
        error = boardbot.validate_board_settings({"base_url": "   "})
        assert error is not None

    def test_present_base_url_passes(self) -> None:
        error = boardbot.validate_board_settings(
            {"base_url": "http://piserver.local:8765"}
        )
        assert error is None

    def test_https_base_url_passes(self) -> None:
        error = boardbot.validate_board_settings(
            {"base_url": "https://piserver.local:8765"}
        )
        assert error is None

    def test_non_http_scheme_is_rejected(self) -> None:
        error = boardbot.validate_board_settings({"base_url": "file:///etc/passwd"})
        assert error is not None
        assert "http" in error.lower()

    def test_schemeless_value_is_rejected(self) -> None:
        error = boardbot.validate_board_settings({"base_url": "piserver.local:8765"})
        assert error is not None


class TestRequestTimeoutBudget:
    def test_request_timeout_leaves_room_for_two_sequential_fetches(self) -> None:
        """board.py calls fetch_checklist() twice per refresh (projects,
        then todo). With the shared HTTP session's retry policy (see
        utils.http_client._PLUGIN_RETRY_TOTAL = 3, i.e. 4 attempts), the
        worst-case wall-clock time for a single fetch against a genuinely
        unreachable host is roughly `4 * timeout` seconds plus retry
        backoff -- measured at ~19s for a 4s timeout in the field. Two
        sequential fetches at that worst case must stay comfortably under
        board's own plugin-execution timeout allowance
        (refresh_task.task._PLUGIN_TIMEOUT_DEFAULTS_S["board"] = 90.0), or
        the outer watchdog kills the plugin before
        BasePlugin.cached_fetch's graceful fallback ever runs."""
        from refresh_task.task import _PLUGIN_TIMEOUT_DEFAULTS_S

        board_timeout_budget = _PLUGIN_TIMEOUT_DEFAULTS_S["board"]
        worst_case_two_fetches = 2 * (4 * boardbot._REQUEST_TIMEOUT_SECONDS + 4)
        assert worst_case_two_fetches < board_timeout_budget


class TestCacheKey:
    def test_combines_base_url_and_list_name(self) -> None:
        assert (
            boardbot.cache_key("http://piserver.local:8765", "todo")
            == "http://piserver.local:8765:todo"
        )

    def test_different_lists_get_different_keys(self) -> None:
        base = "http://piserver.local:8765"
        assert boardbot.cache_key(base, "todo") != boardbot.cache_key(base, "projects")


class TestFetchChecklistConfigErrors:
    def test_missing_base_url_raises(self) -> None:
        with pytest.raises(RuntimeError, match="URL"):
            boardbot.fetch_checklist("todo", "", "token")

    def test_non_http_scheme_raises(self) -> None:
        with pytest.raises(RuntimeError, match="http"):
            boardbot.fetch_checklist("todo", "file:///etc/passwd", "token")

    def test_missing_token_raises(self) -> None:
        with pytest.raises(RuntimeError, match="API token"):
            boardbot.fetch_checklist("todo", "http://piserver.local:8765", "")


class _FakeResponse:
    def __init__(self, payload: list[dict[str, Any]], status_ok: bool = True) -> None:
        self._payload = payload
        self._status_ok = status_ok

    def raise_for_status(self) -> None:
        if not self._status_ok:
            raise requests.exceptions.HTTPError("boom")

    def json(self) -> list[dict[str, Any]]:
        return self._payload


def _item(
    text: str,
    checked: bool = False,
    due_date: str | None = None,
    priority: str | None = None,
    effort_days: int | None = None,
) -> dict[str, Any]:
    return {
        "text": text,
        "checked": checked,
        "due_date": due_date,
        "priority": priority,
        "effort_days": effort_days,
    }


class TestFetchChecklistParsing:
    def _patch_session(
        self, monkeypatch: pytest.MonkeyPatch, response: _FakeResponse
    ) -> MagicMock:
        session = MagicMock()
        session.get.return_value = response
        monkeypatch.setattr(boardbot, "get_http_session", lambda: session)
        return session

    def test_returns_items_in_list_order(self, monkeypatch: pytest.MonkeyPatch) -> None:
        response = _FakeResponse(
            [
                {"text": "Item A", "checked": False},
                {"text": "Item B", "checked": True},
            ]
        )
        self._patch_session(monkeypatch, response)

        result = boardbot.fetch_checklist(
            "projects", "http://piserver.local:8765", "token"
        )
        assert result == [_item("Item A"), _item("Item B", checked=True)]

    def test_passes_through_due_date_priority_effort_days(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        response = _FakeResponse(
            [
                {
                    "text": "Clean the garage",
                    "checked": False,
                    "due_date": "2026-09-10",
                    "priority": "high",
                    "effort_days": 2,
                }
            ]
        )
        self._patch_session(monkeypatch, response)

        result = boardbot.fetch_checklist(
            "projects", "http://piserver.local:8765", "token"
        )
        assert result == [
            _item(
                "Clean the garage",
                due_date="2026-09-10",
                priority="high",
                effort_days=2,
            )
        ]

    def test_empty_list_returns_empty(self, monkeypatch: pytest.MonkeyPatch) -> None:
        self._patch_session(monkeypatch, _FakeResponse([]))
        assert (
            boardbot.fetch_checklist("todo", "http://piserver.local:8765", "token")
            == []
        )

    def test_sends_bearer_token_and_correct_url(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        session = self._patch_session(monkeypatch, _FakeResponse([]))
        boardbot.fetch_checklist("todo", "http://piserver.local:8765", "secret-tok")

        session.get.assert_called_once()
        args, kwargs = session.get.call_args
        assert args[0] == "http://piserver.local:8765/todo"
        assert kwargs["headers"]["Authorization"] == "Bearer secret-tok"

    def test_strips_trailing_slash_from_base_url(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        session = self._patch_session(monkeypatch, _FakeResponse([]))
        boardbot.fetch_checklist("projects", "http://piserver.local:8765/", "token")

        args, _kwargs = session.get.call_args
        assert args[0] == "http://piserver.local:8765/projects"

    def test_http_error_propagates_for_fail_soft_handling(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        self._patch_session(monkeypatch, _FakeResponse([], status_ok=False))
        with pytest.raises(requests.exceptions.HTTPError):
            boardbot.fetch_checklist("todo", "http://piserver.local:8765", "token")

    def test_missing_checked_field_defaults_to_falsy(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        self._patch_session(monkeypatch, _FakeResponse([{"text": "No checked field"}]))
        result = boardbot.fetch_checklist("todo", "http://piserver.local:8765", "token")
        assert result == [_item("No checked field")]


class TestFetchTrips:
    def _patch_session(
        self, monkeypatch: pytest.MonkeyPatch, response: _FakeResponse
    ) -> MagicMock:
        session = MagicMock()
        session.get.return_value = response
        monkeypatch.setattr(boardbot, "get_http_session", lambda: session)
        return session

    def test_missing_base_url_raises(self) -> None:
        with pytest.raises(RuntimeError, match="URL"):
            boardbot.fetch_trips("", "token")

    def test_missing_token_raises(self) -> None:
        with pytest.raises(RuntimeError, match="API token"):
            boardbot.fetch_trips("http://piserver.local:8765", "")

    def test_passes_through_items_unmodified(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        rows = [
            {
                "name": "Lisbon with the Ortegas",
                "status": "booked",
                "start": "2026-10-03",
                "end": "2026-10-11",
                "next_action": "Book airport transfer",
            },
            {"name": "Japan - cherry blossom", "status": "idea"},
        ]
        self._patch_session(monkeypatch, _FakeResponse(rows))
        result = boardbot.fetch_trips("http://piserver.local:8765", "token")
        assert result == rows

    def test_calls_the_trips_endpoint(self, monkeypatch: pytest.MonkeyPatch) -> None:
        session = self._patch_session(monkeypatch, _FakeResponse([]))
        boardbot.fetch_trips("http://piserver.local:8765", "secret-tok")

        args, kwargs = session.get.call_args
        assert args[0] == "http://piserver.local:8765/trips"
        assert kwargs["headers"]["Authorization"] == "Bearer secret-tok"

    def test_http_error_propagates_for_fail_soft_handling(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        self._patch_session(monkeypatch, _FakeResponse([], status_ok=False))
        with pytest.raises(requests.exceptions.HTTPError):
            boardbot.fetch_trips("http://piserver.local:8765", "token")


class TestFetchMaintenance:
    def _patch_session(
        self, monkeypatch: pytest.MonkeyPatch, response: _FakeResponse
    ) -> MagicMock:
        session = MagicMock()
        session.get.return_value = response
        monkeypatch.setattr(boardbot, "get_http_session", lambda: session)
        return session

    def test_missing_base_url_raises(self) -> None:
        with pytest.raises(RuntimeError, match="URL"):
            boardbot.fetch_maintenance("", "token")

    def test_missing_token_raises(self) -> None:
        with pytest.raises(RuntimeError, match="API token"):
            boardbot.fetch_maintenance("http://piserver.local:8765", "")

    def test_passes_through_items_unmodified(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        rows = [
            {
                "task": "Gutter clean-out",
                "interval_unit": "seasonal",
                "next_due_override": "2026-10-25",
            },
            {
                "task": "Test smoke alarms",
                "interval_unit": "months",
                "interval_value": 6,
                "last_done": "2026-08-28",
            },
        ]
        self._patch_session(monkeypatch, _FakeResponse(rows))
        result = boardbot.fetch_maintenance("http://piserver.local:8765", "token")
        assert result == rows

    def test_calls_the_maintenance_endpoint(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        session = self._patch_session(monkeypatch, _FakeResponse([]))
        boardbot.fetch_maintenance("http://piserver.local:8765", "secret-tok")

        args, kwargs = session.get.call_args
        assert args[0] == "http://piserver.local:8765/maintenance"
        assert kwargs["headers"]["Authorization"] == "Bearer secret-tok"

    def test_http_error_propagates_for_fail_soft_handling(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        self._patch_session(monkeypatch, _FakeResponse([], status_ok=False))
        with pytest.raises(requests.exceptions.HTTPError):
            boardbot.fetch_maintenance("http://piserver.local:8765", "token")
