"""Unit tests for homeboard.adapters.ical — no live network calls."""

from __future__ import annotations

from datetime import date
from unittest.mock import MagicMock
from zoneinfo import ZoneInfo

import pytest

from homeboard.adapters import ical

UTC = ZoneInfo("UTC")

_ICS_TIMED = """BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//test//test//EN
BEGIN:VEVENT
UID:1@example.com
DTSTART:20261003T090000Z
DTEND:20261003T110000Z
SUMMARY:Farmers market
END:VEVENT
END:VCALENDAR
"""

_ICS_ALL_DAY = """BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//test//test//EN
BEGIN:VEVENT
UID:2@example.com
DTSTART;VALUE=DATE:20261003
DTEND;VALUE=DATE:20261005
SUMMARY:Family reunion
END:VEVENT
END:VCALENDAR
"""

_ICS_TRANSPARENT = """BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//test//test//EN
BEGIN:VEVENT
UID:3@example.com
DTSTART:20261003T090000Z
DTEND:20261003T100000Z
SUMMARY:Focus block
TRANSP:TRANSPARENT
END:VEVENT
END:VCALENDAR
"""


def _mock_session(text: str, status_ok: bool = True) -> MagicMock:
    session = MagicMock()
    response = MagicMock()
    response.text = text
    if not status_ok:
        response.raise_for_status.side_effect = Exception("boom")
    session.get.return_value = response
    return session


class TestParseIcsUrls:
    def test_splits_newlines(self) -> None:
        assert ical.parse_ics_urls("https://a\nhttps://b") == ["https://a", "https://b"]

    def test_splits_commas(self) -> None:
        assert ical.parse_ics_urls("https://a, https://b") == ["https://a", "https://b"]

    def test_blank_lines_ignored(self) -> None:
        assert ical.parse_ics_urls("https://a\n\n  \nhttps://b") == [
            "https://a",
            "https://b",
        ]

    def test_non_string_returns_empty(self) -> None:
        assert ical.parse_ics_urls(None) == []


class TestValidateIcsUrls:
    def test_empty_is_rejected(self) -> None:
        assert ical.validate_ics_urls("") is not None

    def test_present_is_accepted(self) -> None:
        assert ical.validate_ics_urls("https://example.com/cal.ics") is None


class TestFetchEvents:
    def test_timed_event_parsed(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(ical, "get_http_session", lambda: _mock_session(_ICS_TIMED))
        events = ical.fetch_events(
            "https://example.com/cal.ics", date(2026, 10, 1), date(2026, 10, 10), UTC
        )
        assert len(events) == 1
        ev = events[0]
        assert ev["summary"] == "Farmers market"
        assert ev["all_day"] is False
        assert ev["transparent"] is False
        assert ev["start"].startswith("2026-10-03T09:00:00")

    def test_all_day_event_parsed(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(
            ical, "get_http_session", lambda: _mock_session(_ICS_ALL_DAY)
        )
        events = ical.fetch_events(
            "https://example.com/cal.ics", date(2026, 10, 1), date(2026, 10, 10), UTC
        )
        assert len(events) == 1
        assert events[0]["all_day"] is True
        assert events[0]["summary"] == "Family reunion"

    def test_transparent_event_flagged(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(
            ical, "get_http_session", lambda: _mock_session(_ICS_TRANSPARENT)
        )
        events = ical.fetch_events(
            "https://example.com/cal.ics", date(2026, 10, 1), date(2026, 10, 10), UTC
        )
        assert len(events) == 1
        assert events[0]["transparent"] is True

    def test_empty_feed_returns_no_events(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(ical, "get_http_session", lambda: _mock_session(""))
        events = ical.fetch_events(
            "https://example.com/cal.ics", date(2026, 10, 1), date(2026, 10, 10), UTC
        )
        assert events == []

    def test_webcal_scheme_rewritten_to_https(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        session = _mock_session(_ICS_TIMED)
        monkeypatch.setattr(ical, "get_http_session", lambda: session)
        ical.fetch_events(
            "webcal://example.com/cal.ics", date(2026, 10, 1), date(2026, 10, 10), UTC
        )
        called_url = session.get.call_args[0][0]
        assert called_url == "https://example.com/cal.ics"
