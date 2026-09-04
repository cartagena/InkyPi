"""ICS-over-HTTP calendar adapter (SPEC §6, product decision — not the
Google Calendar API).

The user syncs Apple Calendar to local ICS files via ``vdirsyncer`` on a Pi 5
homelab, served unauthenticated over plain HTTP on the LAN. This adapter
fetches and expands one ICS feed's events in a date range, following the
same fetch/expand pattern as ``plugins/calendar/calendar.py`` (module-level
``icalendar``/``recurring_ical_events`` imports — confirmed safe for startup
RSS since plugin modules are only imported on first use, see
``tests/unit/test_lazy_imports.py``).

Returns plain JSON-serializable dicts, not a dataclass carrying
``datetime`` objects, so the raw fetch result can be written straight
through ``BasePlugin.cached_fetch`` (backed by ``json.dump``). Callers
parse the dicts back into ``classify.IcsEvent`` after a cache round-trip.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta
from typing import Any

import icalendar
import recurring_ical_events

from utils.http_client import get_http_session

_TIMEOUT_S = 30


def fetch_calendar(url: str) -> icalendar.Calendar:
    # workaround for webcal urls, matching plugins/calendar/calendar.py
    fetch_url = (
        url.replace("webcal://", "https://", 1) if url.startswith("webcal://") else url
    )
    response = get_http_session().get(fetch_url, timeout=_TIMEOUT_S)
    response.raise_for_status()
    if not response.text.strip():
        # A 200 with an empty body is a valid (if pointless) ICS feed.
        return icalendar.Calendar()
    return icalendar.Calendar.from_ical(response.text)


def _as_datetime(value: Any, tz: Any) -> tuple[datetime, bool]:
    """Return ``(aware datetime, all_day)`` for an icalendar DATE or
    DATE-TIME value, localizing a bare date to midnight in *tz*."""
    if isinstance(value, datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=tz)
        return value, False
    if isinstance(value, date):
        return datetime(value.year, value.month, value.day, tzinfo=tz), True
    return datetime.now(tz), False


def fetch_events(url: str, start: date, end: date, tz: Any) -> list[dict[str, Any]]:
    """Events between *start* (inclusive) and *end* (exclusive) from the ICS
    feed at *url*, expanded for recurrence.

    Each returned dict has: ``summary``, ``start``/``end`` (ISO 8601
    strings), ``all_day``, ``transparent``, ``recurring``. Any exception
    (bad URL, transport failure, malformed feed) propagates as-is — the
    caller's ``config_errors`` decides whether it's a config error or a
    transient, fail-soft one (SPEC §4.4); a missing/empty URL setting is a
    config error the caller should have already rejected before calling
    this.
    """
    cal = fetch_calendar(url)
    range_start = datetime(start.year, start.month, start.day, tzinfo=tz)
    range_end = datetime(end.year, end.month, end.day, tzinfo=tz)
    occurrences = recurring_ical_events.of(cal).between(range_start, range_end)

    events: list[dict[str, Any]] = []
    for occ in occurrences:
        start_dt, all_day = _as_datetime(occ.decoded("dtstart"), tz)

        if "dtend" in occ:
            end_dt, _ = _as_datetime(occ.decoded("dtend"), tz)
        elif "duration" in occ:
            duration = occ.decoded("duration")
            end_dt = (
                start_dt + duration if isinstance(duration, timedelta) else start_dt
            )
        else:
            end_dt = start_dt + (timedelta(days=1) if all_day else timedelta())

        transp = str(occ.get("transp", "")).strip().upper()
        # recurring_ical_events copies the source VEVENT's properties onto
        # each expanded occurrence (confirmed against its own test suite at
        # implementation time) — RRULE/RDATE presence on the occurrence is
        # therefore a reliable signal that it originated from a recurring
        # rule, not a one-off event.
        recurring = "rrule" in occ or "rdate" in occ

        events.append(
            {
                "summary": str(occ.get("summary", "")),
                "start": start_dt.isoformat(),
                "end": end_dt.isoformat(),
                "all_day": all_day,
                "transparent": transp == "TRANSPARENT",
                "recurring": recurring,
            }
        )
    return events


def parse_ics_urls(raw: object) -> list[str]:
    """Split a textarea's raw newline/comma-separated value into a list of
    non-empty, stripped URLs."""
    if not isinstance(raw, str):
        return []
    urls: list[str] = []
    for line in raw.replace(",", "\n").splitlines():
        url = line.strip()
        if url:
            urls.append(url)
    return urls


def validate_ics_urls(raw: object) -> str | None:
    if not parse_ics_urls(raw):
        return "At least one calendar URL is required."
    return None
