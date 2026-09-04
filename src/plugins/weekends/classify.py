"""Weekend classification algorithm (SPEC §6.4). Pure functions, no I/O —
unit-testable without Chromium or a live ICS fetch.
"""

from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from enum import StrEnum
from typing import Any


class CellState(StrEnum):
    FREE = "free"
    PARTLY = "partly"
    BOOKED = "booked"


@dataclass(frozen=True)
class IcsEvent:
    summary: str
    start: datetime
    end: datetime
    all_day: bool
    transparent: bool
    recurring: bool


@dataclass(frozen=True)
class DayCell:
    state: CellState
    label: str
    note: str
    long_weekend: bool
    long_weekend_note: str  # "Fri off" / "Mon off"


@dataclass(frozen=True)
class WeekendRow:
    saturday: date
    sunday: date
    spanning: bool
    sat: DayCell
    sun: DayCell


def parse_event(raw: Mapping[str, Any]) -> IcsEvent:
    return IcsEvent(
        summary=str(raw.get("summary", "")),
        start=datetime.fromisoformat(str(raw["start"])),
        end=datetime.fromisoformat(str(raw["end"])),
        all_day=bool(raw.get("all_day")),
        transparent=bool(raw.get("transparent")),
        recurring=bool(raw.get("recurring")),
    )


def weekend_dates(today: date, count: int) -> list[tuple[date, date]]:
    """The next *count* (Saturday, Sunday) pairs, starting with the current
    weekend if *today* falls on one, else the upcoming Saturday."""
    weekday = today.weekday()  # Monday=0 ... Sunday=6
    if weekday == 6:  # Sunday: the current weekend's Saturday already passed
        first_saturday = today - timedelta(days=1)
    else:
        first_saturday = today + timedelta(days=(5 - weekday) % 7)
    return [
        (
            first_saturday + timedelta(weeks=i),
            first_saturday + timedelta(weeks=i, days=1),
        )
        for i in range(count)
    ]


def _overlaps_day(ev: IcsEvent, day: date) -> bool:
    day_start = datetime.combine(day, datetime.min.time(), tzinfo=ev.start.tzinfo)
    day_end = day_start + timedelta(days=1)
    return ev.start < day_end and ev.end > day_start


def _spans_adjacent_day(ev: IcsEvent) -> bool:
    return ev.start.date() != ev.end.date()


def qualifying_events(
    events: Sequence[IcsEvent], ignore_recurring_minutes: int
) -> list[IcsEvent]:
    """Discard transparent events and recurring events shorter than
    ``ignore_recurring_minutes`` — SPEC §6.4 steps 2-3."""
    out: list[IcsEvent] = []
    for ev in events:
        if ev.transparent:
            continue
        duration_minutes = (ev.end - ev.start).total_seconds() / 60.0
        if ev.recurring and duration_minutes < ignore_recurring_minutes:
            continue
        out.append(ev)
    return out


def _busy_hours_on(day: date, day_events: Sequence[IcsEvent]) -> float:
    tz = day_events[0].start.tzinfo if day_events else None
    day_start = datetime.combine(day, datetime.min.time(), tzinfo=tz)
    day_end = day_start + timedelta(days=1)
    total = timedelta()
    for ev in day_events:
        if ev.all_day:
            continue
        overlap_start = max(ev.start, day_start)
        overlap_end = min(ev.end, day_end)
        if overlap_end > overlap_start:
            total += overlap_end - overlap_start
    return total.total_seconds() / 3600.0


def _format_time(dt: datetime) -> str:
    return dt.strftime("%-I%p").lower()


def duration_note(day: date, day_events: Sequence[IcsEvent]) -> str:
    """One of "All day", "Morning only", "Afternoon only", "<Day> night to
    <Day>", or a rendered time range (SPEC §6.4)."""
    if not day_events:
        return ""
    longest = max(day_events, key=lambda e: e.end - e.start)
    if longest.all_day:
        return "All day"
    if _spans_adjacent_day(longest):
        return f"{longest.start.strftime('%a')} night to {longest.end.strftime('%a')}"
    start_hour = longest.start.hour + longest.start.minute / 60
    end_hour = longest.end.hour + longest.end.minute / 60
    if end_hour <= 12:
        return "Morning only"
    if start_hour >= 12:
        return "Afternoon only"
    return f"{_format_time(longest.start)}–{_format_time(longest.end)}"


def _classify_from_day_events(
    day: date,
    day_events: Sequence[IcsEvent],
    partly_hours: float,
    full_day_hours: float,
) -> DayCell:
    """Classify one day given the qualifying events that overlap it (SPEC
    §6.4 steps 4-5): any all-day or adjacent-day-spanning event forces
    ``booked`` outright; otherwise the day is ``booked``/``partly``/``free``
    by summed busy hours against the two thresholds. The rendered
    label/note come from the longest qualifying event, with " +1" appended
    to the note when a second qualifying event exists ("Merging" /
    "Label selection" in SPEC §6.4)."""
    if not day_events:
        return DayCell(CellState.FREE, "", "", False, "")

    if any(e.all_day or _spans_adjacent_day(e) for e in day_events):
        state = CellState.BOOKED
    else:
        busy = _busy_hours_on(day, day_events)
        if busy >= full_day_hours:
            state = CellState.BOOKED
        elif busy >= partly_hours:
            state = CellState.PARTLY
        else:
            state = CellState.FREE

    if state == CellState.FREE:
        return DayCell(CellState.FREE, "", "", False, "")

    longest = max(day_events, key=lambda e: e.end - e.start)
    note = duration_note(day, day_events)
    if len(day_events) > 1:
        note = f"{note} +1" if note else "+1"
    return DayCell(state, longest.summary, note, False, "")


def _classify_day_from_qualifying(
    day: date,
    qualifying: Sequence[IcsEvent],
    partly_hours: float,
    full_day_hours: float,
) -> DayCell:
    day_events = [e for e in qualifying if _overlaps_day(e, day)]
    return _classify_from_day_events(day, day_events, partly_hours, full_day_hours)


def classify_day(
    day: date,
    events: Sequence[IcsEvent],
    ignore_recurring_minutes: int,
    partly_hours: float,
    full_day_hours: float,
) -> DayCell:
    qualifying = qualifying_events(events, ignore_recurring_minutes)
    return _classify_day_from_qualifying(day, qualifying, partly_hours, full_day_hours)


def classify_weekend(
    saturday: date,
    sunday: date,
    events: Sequence[IcsEvent],
    ignore_recurring_minutes: int,
    partly_hours: float,
    full_day_hours: float,
) -> WeekendRow:
    """Classify one weekend row. If a single qualifying event covers both
    days, both cells collapse to one shared (booked) label/note rather than
    repeating it (SPEC §6.4 "Merging").

    Filters ``events`` down to the qualifying set once and reuses it for
    the spanning check and both days, rather than re-filtering the full
    event list per day.
    """
    qualifying = qualifying_events(events, ignore_recurring_minutes)
    spanning = next(
        (
            e
            for e in qualifying
            if _overlaps_day(e, saturday) and _overlaps_day(e, sunday)
        ),
        None,
    )
    if spanning is not None:
        others = [
            e
            for e in qualifying
            if e is not spanning
            and (_overlaps_day(e, saturday) or _overlaps_day(e, sunday))
        ]
        cell = _classify_from_day_events(
            saturday, [spanning, *others], partly_hours, full_day_hours
        )
        return WeekendRow(saturday, sunday, True, cell, cell)

    sat_cell = _classify_day_from_qualifying(
        saturday, qualifying, partly_hours, full_day_hours
    )
    sun_cell = _classify_day_from_qualifying(
        sunday, qualifying, partly_hours, full_day_hours
    )
    return WeekendRow(saturday, sunday, False, sat_cell, sun_cell)


def holiday_dates(holiday_events: Sequence[IcsEvent]) -> set[date]:
    """All-day event dates from a holiday feed — SPEC §6.4's
    ``holiday_calendar_id`` (here: ``holiday_ics_url``)."""
    return {e.start.date() for e in holiday_events if e.all_day}


def is_school_out(day: date, events: Sequence[IcsEvent], pattern: str) -> bool:
    """Whether an all-day event on *day* matches ``school_out_pattern``
    (SPEC §6.4)."""
    if not pattern:
        return False
    try:
        compiled = re.compile(pattern, re.IGNORECASE)
    except re.error:
        return False
    return any(
        e.all_day and _overlaps_day(e, day) and compiled.search(e.summary)
        for e in events
    )


def apply_long_weekend(
    row: WeekendRow,
    friday_events: Sequence[IcsEvent],
    monday_events: Sequence[IcsEvent],
    holidays: set[date],
    school_out_pattern: str,
) -> WeekendRow:
    """Flag Saturday/Sunday cells as long-weekend when the adjacent Friday
    or Monday is a holiday or school-out day (SPEC §6.4)."""
    friday = row.saturday - timedelta(days=1)
    monday = row.sunday + timedelta(days=1)

    friday_off = friday in holidays or is_school_out(
        friday, friday_events, school_out_pattern
    )
    monday_off = monday in holidays or is_school_out(
        monday, monday_events, school_out_pattern
    )

    if not friday_off and not monday_off:
        return row

    if friday_off and monday_off:
        note = "Fri + Mon off"
    else:
        note = "Fri off" if friday_off else "Mon off"
    sat = DayCell(row.sat.state, row.sat.label, row.sat.note, True, note)
    sun = DayCell(row.sun.state, row.sun.label, row.sun.note, True, note)
    return WeekendRow(row.saturday, row.sunday, row.spanning, sat, sun)
