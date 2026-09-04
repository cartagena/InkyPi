"""Unit tests for plugins.weekends.classify — SPEC §6.4."""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta

import pytest

from plugins.weekends.classify import (
    CellState,
    IcsEvent,
    apply_long_weekend,
    classify_day,
    classify_weekend,
    duration_note,
    holiday_dates,
    is_school_out,
    parse_event,
    qualifying_events,
    weekend_dates,
)

UTC = UTC
SAT = date(2026, 10, 3)
SUN = date(2026, 10, 4)


def _ev(
    summary: str,
    start: datetime,
    end: datetime,
    all_day: bool = False,
    transparent: bool = False,
    recurring: bool = False,
) -> IcsEvent:
    return IcsEvent(summary, start, end, all_day, transparent, recurring)


class TestWeekendDates:
    def test_starts_from_upcoming_saturday(self) -> None:
        # Tuesday 2026-09-01 -> next Saturday is 2026-09-05
        out = weekend_dates(date(2026, 9, 1), 2)
        assert out == [
            (date(2026, 9, 5), date(2026, 9, 6)),
            (date(2026, 9, 12), date(2026, 9, 13)),
        ]

    def test_today_on_saturday_includes_current_weekend(self) -> None:
        out = weekend_dates(SAT, 1)
        assert out == [(SAT, SUN)]

    def test_today_on_sunday_includes_current_weekend(self) -> None:
        out = weekend_dates(SUN, 1)
        assert out == [(SAT, SUN)]


class TestQualifyingEvents:
    def test_transparent_events_discarded(self) -> None:
        events = [
            _ev(
                "Free block",
                datetime(2026, 10, 3, 10, tzinfo=UTC),
                datetime(2026, 10, 3, 12, tzinfo=UTC),
                transparent=True,
            )
        ]
        assert qualifying_events(events, 120) == []

    def test_short_recurring_events_discarded(self) -> None:
        events = [
            _ev(
                "Standing sync",
                datetime(2026, 10, 4, 9, tzinfo=UTC),
                datetime(2026, 10, 4, 10, 15, tzinfo=UTC),
                recurring=True,
            )
        ]
        assert qualifying_events(events, 120) == []

    def test_long_recurring_events_kept(self) -> None:
        events = [
            _ev(
                "Standing retreat",
                datetime(2026, 10, 4, 9, tzinfo=UTC),
                datetime(2026, 10, 4, 12, tzinfo=UTC),
                recurring=True,
            )
        ]
        assert qualifying_events(events, 120) == events

    def test_non_recurring_short_event_kept(self) -> None:
        events = [
            _ev(
                "Coffee",
                datetime(2026, 10, 4, 9, tzinfo=UTC),
                datetime(2026, 10, 4, 9, 30, tzinfo=UTC),
            )
        ]
        assert qualifying_events(events, 120) == events


class TestClassifyDay:
    def test_no_events_is_free(self) -> None:
        cell = classify_day(SAT, [], 120, 2.0, 6.0)
        assert cell.state == CellState.FREE

    def test_all_day_event_is_booked(self) -> None:
        events = [
            _ev(
                "Wedding",
                datetime(2026, 10, 3, 0, tzinfo=UTC),
                datetime(2026, 10, 4, 0, tzinfo=UTC),
                all_day=True,
            )
        ]
        cell = classify_day(SAT, events, 120, 2.0, 6.0)
        assert cell.state == CellState.BOOKED
        assert cell.label == "Wedding"

    def test_overnight_event_is_booked(self) -> None:
        events = [
            _ev(
                "Camping",
                datetime(2026, 10, 3, 20, tzinfo=UTC),
                datetime(2026, 10, 4, 9, tzinfo=UTC),
            )
        ]
        cell = classify_day(SAT, events, 120, 2.0, 6.0)
        assert cell.state == CellState.BOOKED

    def test_under_partly_threshold_is_free(self) -> None:
        events = [
            _ev(
                "Coffee",
                datetime(2026, 10, 3, 9, tzinfo=UTC),
                datetime(2026, 10, 3, 10, tzinfo=UTC),
            )
        ]
        cell = classify_day(SAT, events, 120, 2.0, 6.0)
        assert cell.state == CellState.FREE

    def test_over_partly_under_full_day_is_partly(self) -> None:
        events = [
            _ev(
                "Brunch + hike",
                datetime(2026, 10, 3, 9, tzinfo=UTC),
                datetime(2026, 10, 3, 12, tzinfo=UTC),
            )
        ]
        cell = classify_day(SAT, events, 120, 2.0, 6.0)
        assert cell.state == CellState.PARTLY

    def test_over_full_day_hours_is_booked(self) -> None:
        events = [
            _ev(
                "Conference",
                datetime(2026, 10, 3, 9, tzinfo=UTC),
                datetime(2026, 10, 3, 17, tzinfo=UTC),
            )
        ]
        cell = classify_day(SAT, events, 120, 2.0, 6.0)
        assert cell.state == CellState.BOOKED

    def test_second_qualifying_event_appends_plus_one(self) -> None:
        events = [
            _ev(
                "Conference",
                datetime(2026, 10, 3, 9, tzinfo=UTC),
                datetime(2026, 10, 3, 17, tzinfo=UTC),
            ),
            _ev(
                "Dinner",
                datetime(2026, 10, 3, 18, tzinfo=UTC),
                datetime(2026, 10, 3, 19, tzinfo=UTC),
            ),
        ]
        cell = classify_day(SAT, events, 120, 2.0, 6.0)
        assert cell.note.endswith("+1")

    def test_events_on_other_days_are_ignored(self) -> None:
        events = [
            _ev(
                "Weekday thing",
                datetime(2026, 10, 5, 9, tzinfo=UTC),
                datetime(2026, 10, 5, 17, tzinfo=UTC),
            )
        ]
        cell = classify_day(SAT, events, 120, 2.0, 6.0)
        assert cell.state == CellState.FREE


class TestDurationNote:
    def test_all_day(self) -> None:
        ev = _ev(
            "Wedding",
            datetime(2026, 10, 3, 0, tzinfo=UTC),
            datetime(2026, 10, 4, 0, tzinfo=UTC),
            all_day=True,
        )
        assert duration_note(SAT, [ev]) == "All day"

    def test_morning_only(self) -> None:
        ev = _ev(
            "Hike",
            datetime(2026, 10, 3, 8, tzinfo=UTC),
            datetime(2026, 10, 3, 11, tzinfo=UTC),
        )
        assert duration_note(SAT, [ev]) == "Morning only"

    def test_afternoon_only(self) -> None:
        ev = _ev(
            "Hike",
            datetime(2026, 10, 3, 13, tzinfo=UTC),
            datetime(2026, 10, 3, 17, tzinfo=UTC),
        )
        assert duration_note(SAT, [ev]) == "Afternoon only"

    def test_overnight_spans_days(self) -> None:
        ev = _ev(
            "Camping",
            datetime(2026, 10, 3, 20, tzinfo=UTC),
            datetime(2026, 10, 4, 9, tzinfo=UTC),
        )
        assert "night to" in duration_note(SAT, [ev])


class TestMerging:
    def test_event_spanning_both_days_yields_one_spanning_row(self) -> None:
        events = [
            _ev(
                "Family reunion",
                datetime(2026, 10, 3, 0, tzinfo=UTC),
                datetime(2026, 10, 5, 0, tzinfo=UTC),
                all_day=True,
            )
        ]
        row = classify_weekend(SAT, SUN, events, 120, 2.0, 6.0)
        assert row.spanning is True
        assert row.sat.label == row.sun.label == "Family reunion"

    def test_non_spanning_events_yield_two_independent_cells(self) -> None:
        events = [
            _ev(
                "Sat thing",
                datetime(2026, 10, 3, 9, tzinfo=UTC),
                datetime(2026, 10, 3, 17, tzinfo=UTC),
            ),
        ]
        row = classify_weekend(SAT, SUN, events, 120, 2.0, 6.0)
        assert row.spanning is False
        assert row.sat.state == CellState.BOOKED
        assert row.sun.state == CellState.FREE


class TestLongWeekend:
    def test_friday_holiday_flags_row(self) -> None:
        row = classify_weekend(SAT, SUN, [], 120, 2.0, 6.0)
        friday = SAT - timedelta(days=1)
        flagged = apply_long_weekend(row, [], [], {friday}, "")
        assert flagged.sat.long_weekend is True
        assert flagged.sat.long_weekend_note == "Fri off"

    def test_monday_holiday_flags_row(self) -> None:
        row = classify_weekend(SAT, SUN, [], 120, 2.0, 6.0)
        monday = SUN + timedelta(days=1)
        flagged = apply_long_weekend(row, [], [], {monday}, "")
        assert flagged.sun.long_weekend is True
        assert flagged.sun.long_weekend_note == "Mon off"

    def test_both_friday_and_monday_off_reports_both(self) -> None:
        row = classify_weekend(SAT, SUN, [], 120, 2.0, 6.0)
        friday = SAT - timedelta(days=1)
        monday = SUN + timedelta(days=1)
        flagged = apply_long_weekend(row, [], [], {friday, monday}, "")
        assert flagged.sat.long_weekend_note == "Fri + Mon off"
        assert flagged.sun.long_weekend_note == "Fri + Mon off"

    def test_no_holiday_or_school_out_leaves_row_unchanged(self) -> None:
        row = classify_weekend(SAT, SUN, [], 120, 2.0, 6.0)
        flagged = apply_long_weekend(row, [], [], set(), "")
        assert flagged == row

    def test_school_out_pattern_matches_all_day_summary(self) -> None:
        friday = SAT - timedelta(days=1)
        events = [
            _ev(
                "No School - Teacher Inservice",
                datetime(2026, 10, 2, 0, tzinfo=UTC),
                datetime(2026, 10, 3, 0, tzinfo=UTC),
                all_day=True,
            )
        ]
        assert is_school_out(friday, events, r"no school") is True

    def test_invalid_regex_returns_false(self) -> None:
        assert is_school_out(SAT, [], "[") is False


class TestHolidayDates:
    def test_only_all_day_events_counted(self) -> None:
        events = [
            _ev(
                "Thanksgiving",
                datetime(2026, 11, 26, 0, tzinfo=UTC),
                datetime(2026, 11, 27, 0, tzinfo=UTC),
                all_day=True,
            ),
            _ev(
                "Not a holiday",
                datetime(2026, 11, 26, 9, tzinfo=UTC),
                datetime(2026, 11, 26, 10, tzinfo=UTC),
            ),
        ]
        assert holiday_dates(events) == {date(2026, 11, 26)}


class TestParseEvent:
    def test_round_trips_from_a_raw_dict(self) -> None:
        raw = {
            "summary": "Hike",
            "start": "2026-10-03T09:00:00+00:00",
            "end": "2026-10-03T12:00:00+00:00",
            "all_day": False,
            "transparent": False,
            "recurring": False,
        }
        ev = parse_event(raw)
        assert ev.summary == "Hike"
        assert ev.start == datetime(2026, 10, 3, 9, tzinfo=UTC)

    def test_missing_start_raises(self) -> None:
        with pytest.raises(KeyError):
            parse_event({"summary": "Bad"})
