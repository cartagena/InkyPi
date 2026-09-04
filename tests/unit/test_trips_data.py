"""Unit tests for plugins.trips.trips_data — SPEC.md §8.1."""

from __future__ import annotations

from datetime import date

import pytest

from homeboard import layout
from plugins.trips.trips_data import (
    IDEA_PITCH_EM,
    TripRow,
    fits_screen,
    idea_label_top_em,
    idea_start_em,
    parse_bool,
    parse_date,
    parse_trip_row,
    screen_fits,
    select_booked,
    select_ideas,
    visible_counts,
)


class TestParseBool:
    @pytest.mark.parametrize("raw", ["true", "True", "TRUE", "1", "yes", "y"])
    def test_truthy_values(self, raw: str) -> None:
        assert parse_bool(raw) is True

    @pytest.mark.parametrize("raw", ["false", "0", "no", "", None])
    def test_falsy_values(self, raw: object) -> None:
        assert parse_bool(raw) is False


class TestParseDate:
    def test_valid_iso_date(self) -> None:
        assert parse_date("2026-10-03") == date(2026, 10, 3)

    def test_empty_and_none_are_none(self) -> None:
        assert parse_date("") is None
        assert parse_date(None) is None

    def test_malformed_is_none(self) -> None:
        assert parse_date("not-a-date") is None


class TestParseTripRow:
    def test_parses_booked_row(self) -> None:
        row = parse_trip_row(
            {
                "name": "Tahoe with the Silvas",
                "status": "Booked",
                "start": "2026-10-03",
                "end": "2026-10-05",
                "next_action": "Cabin not confirmed yet",
                "blocking": "true",
            }
        )
        assert row.name == "Tahoe with the Silvas"
        assert row.status == "booked"
        assert row.start == date(2026, 10, 3)
        assert row.end == date(2026, 10, 5)
        assert row.blocking is True

    def test_parses_idea_row(self) -> None:
        row = parse_trip_row(
            {
                "name": "Yosemite, off season",
                "status": "idea",
                "target_window": "Feb, book by Nov",
            }
        )
        assert row.status == "idea"
        assert row.start is None
        assert row.target_window == "Feb, book by Nov"


class TestSelectBooked:
    def test_sorted_by_start_ascending(self) -> None:
        rows = [
            TripRow(
                "Brazil", "booked", date(2026, 12, 20), date(2027, 1, 5), "", "", False
            ),
            TripRow(
                "Tahoe", "booked", date(2026, 10, 3), date(2026, 10, 5), "", "", False
            ),
        ]
        out = select_booked(rows, today=date(2026, 9, 1))
        assert [t.name for t in out] == ["Tahoe", "Brazil"]

    def test_idea_rows_are_excluded(self) -> None:
        rows = [TripRow("Yosemite", "idea", None, None, "Feb", "", False)]
        assert select_booked(rows, today=date(2026, 1, 1)) == []

    def test_trip_ending_today_is_kept(self) -> None:
        rows = [
            TripRow(
                "Tahoe", "booked", date(2026, 10, 3), date(2026, 10, 5), "", "", False
            )
        ]
        out = select_booked(rows, today=date(2026, 10, 5))
        assert len(out) == 1

    def test_trip_dropped_the_day_after_it_ends(self) -> None:
        rows = [
            TripRow(
                "Tahoe", "booked", date(2026, 10, 3), date(2026, 10, 5), "", "", False
            )
        ]
        out = select_booked(rows, today=date(2026, 10, 6))
        assert out == []

    def test_days_until_is_clamped_to_zero_once_started(self) -> None:
        rows = [
            TripRow(
                "Tahoe", "booked", date(2026, 10, 3), date(2026, 10, 5), "", "", False
            )
        ]
        out = select_booked(rows, today=date(2026, 10, 4))
        assert out[0].days_until == 0

    def test_days_until_counts_down(self) -> None:
        rows = [
            TripRow(
                "Brazil", "booked", date(2027, 1, 20), date(2027, 2, 1), "", "", False
            )
        ]
        out = select_booked(rows, today=date(2026, 10, 4))
        assert out[0].days_until == (date(2027, 1, 20) - date(2026, 10, 4)).days

    def test_missing_start_or_end_is_excluded(self) -> None:
        rows = [TripRow("Bad row", "booked", None, date(2026, 10, 5), "", "", False)]
        assert select_booked(rows, today=date(2026, 1, 1)) == []


class TestSelectIdeas:
    def test_only_idea_rows_included(self) -> None:
        rows = [
            TripRow(
                "Tahoe", "booked", date(2026, 10, 3), date(2026, 10, 5), "", "", False
            ),
            TripRow("Yosemite", "idea", None, None, "Feb, book by Nov", "", False),
            TripRow("Big Sur", "idea", None, None, "Spring", "", False),
        ]
        out = select_ideas(rows)
        assert [i.name for i in out] == ["Yosemite", "Big Sur"]
        assert out[0].target_window == "Feb, book by Nov"


class TestVisibleCounts:
    def test_800x480_fits_the_mockups_two_booked_and_several_ideas(self) -> None:
        t = layout.tokens(800, 480)
        visible_booked, visible_ideas = visible_counts(t, num_booked=2, num_ideas=5)
        assert visible_booked == 2
        assert visible_ideas >= 2  # at least the minimum

    def test_booked_gets_first_claim_on_space(self) -> None:
        t = layout.tokens(800, 480)
        visible_booked, _ = visible_counts(t, num_booked=5, num_ideas=5)
        assert visible_booked == 2  # MAX_BOOKED

    def test_never_exceeds_actual_data_counts(self) -> None:
        t = layout.tokens(800, 480)
        visible_booked, visible_ideas = visible_counts(t, num_booked=1, num_ideas=1)
        assert visible_booked == 1
        assert visible_ideas == 1

    def test_zero_data_yields_zero_visible(self) -> None:
        t = layout.tokens(800, 480)
        assert visible_counts(t, num_booked=0, num_ideas=0) == (0, 0)


class TestFitsScreen:
    def test_normal_panel_fits(self) -> None:
        assert fits_screen(layout.tokens(800, 480)) is True

    def test_tiny_panel_does_not_fit(self) -> None:
        assert fits_screen(layout.tokens(200, 100)) is False


class TestIdeaGeometry:
    """Regression coverage for the capacity/render drift bug: visible_counts()
    and the plugin's render geometry must agree on where idea rows start,
    or idea content can overflow past body_height on some panel sizes."""

    def test_idea_start_em_is_past_idea_label_top_em(self) -> None:
        assert idea_start_em(1) > idea_label_top_em(1)

    def test_visible_counts_never_lets_idea_rows_overflow_when_screen_fits(
        self,
    ) -> None:
        for width, height in [
            (800, 480),
            (600, 400),
            (480, 320),
            (800, 350),
            (700, 420),
        ]:
            t = layout.tokens(width, height)
            for num_booked in (0, 1, 2, 5):
                visible_booked, visible_ideas = visible_counts(t, num_booked, 10)
                if not screen_fits(t, visible_booked, visible_ideas):
                    continue  # correctly caught by the too-small fallback
                idea_bottom_em = (
                    idea_start_em(visible_booked) + visible_ideas * IDEA_PITCH_EM
                )
                assert idea_bottom_em <= t.body_height_em + 1e-9, (
                    width,
                    height,
                    num_booked,
                )


class TestScreenFits:
    def test_normal_panel_with_computed_counts_fits(self) -> None:
        t = layout.tokens(800, 480)
        visible_booked, visible_ideas = visible_counts(t, 2, 5)
        assert screen_fits(t, visible_booked, visible_ideas) is True

    def test_forced_minimum_idea_rows_on_a_tight_panel_does_not_fit(self) -> None:
        # A panel small enough that MIN_IDEAS rows genuinely don't fit
        # after MAX_BOOKED cards, even though visible_counts() still
        # returns MIN_IDEAS (its job is picking a count, not vetoing).
        t = layout.tokens(400, 300)
        visible_booked, visible_ideas = visible_counts(t, 2, 10)
        assert screen_fits(t, visible_booked, visible_ideas) is False

    def test_zero_visible_fits_on_a_normal_panel(self) -> None:
        # Even the empty-overhead check (label bands + gap, before any row)
        # should pass on an ordinary panel with no data to show.
        t = layout.tokens(800, 480)
        assert screen_fits(t, 0, 0) is True
