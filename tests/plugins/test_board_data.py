"""Unit tests for plugins.board.board_data — SPEC §7."""

from __future__ import annotations

from datetime import date

from plugins.board import board_data


class TestSplitNote:
    def test_no_note_returns_full_text(self) -> None:
        assert board_data._split_note("Rebuild the side gate [half day]") == (
            "Rebuild the side gate [half day]",
            "",
        )

    def test_note_split_off(self) -> None:
        title, note = board_data._split_note(
            "Frame the BBQ counter [weekend] — started 2026-08-22"
        )
        assert title == "Frame the BBQ counter [weekend]"
        assert note == "started 2026-08-22"


class TestRenderProjectNote:
    def test_started_date_renders_days_ago(self) -> None:
        out = board_data.render_project_note("started 2026-08-22", date(2026, 9, 4))
        assert out == "Started 13 d ago"

    def test_non_started_note_renders_verbatim(self) -> None:
        assert board_data.render_project_note(
            "blocked on permit", date(2026, 9, 4)
        ) == ("blocked on permit")

    def test_empty_note_renders_empty(self) -> None:
        assert board_data.render_project_note("", date(2026, 9, 4)) == ""

    def test_malformed_started_date_renders_verbatim(self) -> None:
        out = board_data.render_project_note("started not-a-date", date(2026, 9, 4))
        assert out == "started not-a-date"


class TestParseProjectItem:
    def test_in_flight_prefix_detected(self) -> None:
        item = board_data.parse_project_item(
            "* Frame the BBQ counter — started 2026-08-22",
            "*",
            date(2026, 8, 22),
            date(2026, 9, 4),
            effort_days=4,
        )
        assert item.in_flight is True
        assert item.title == "Frame the BBQ counter"
        assert item.size_tag is not None
        assert item.size_tag.label == "Multiple days"
        assert item.note_text == "Started 13 d ago"

    def test_backlog_item_has_no_note_text_even_if_present(self) -> None:
        item = board_data.parse_project_item(
            "Rebuild the side gate — someday",
            "*",
            date(2026, 9, 1),
            date(2026, 9, 4),
        )
        assert item.in_flight is False
        assert item.note_text == ""

    def test_no_effort_days_yields_no_size_tag(self) -> None:
        item = board_data.parse_project_item(
            "Paint the fence", "*", date(2026, 9, 1), date(2026, 9, 4)
        )
        assert item.size_tag is None

    def test_stray_bracket_is_stripped_from_title_without_producing_a_tag(
        self,
    ) -> None:
        """A bracket boardbot's own [S]/[M]/[L] shorthand didn't recognize
        (so it wasn't stripped/converted upstream) still shouldn't show up
        as literal text in the title — but it must not produce a size chip
        either, since only effort_days does that now."""
        item = board_data.parse_project_item(
            "Paint the fence [weekend]", "*", date(2026, 9, 1), date(2026, 9, 4)
        )
        assert item.title == "Paint the fence"
        assert item.size_tag is None

    def test_identical_text_maps_to_the_same_ledger_key(self) -> None:
        a = board_data.parse_project_item(
            "Paint the fence", "*", date(2026, 9, 1), date(2026, 9, 4)
        )
        b = board_data.parse_project_item(
            "Paint the fence", "*", date(2026, 9, 2), date(2026, 9, 4)
        )
        assert a.key == b.key

    def test_priority_and_due_date_pass_through(self) -> None:
        item = board_data.parse_project_item(
            "Paint the fence",
            "*",
            date(2026, 9, 1),
            date(2026, 9, 4),
            priority="high",
            due_date=date(2026, 9, 10),
        )
        assert item.priority == "high"
        assert item.due_date == date(2026, 9, 10)

    def test_priority_and_due_date_default_to_none(self) -> None:
        item = board_data.parse_project_item(
            "Paint the fence", "*", date(2026, 9, 1), date(2026, 9, 4)
        )
        assert item.priority is None
        assert item.due_date is None


class TestParseTodoItem:
    def test_trailing_bracket_is_ignored(self) -> None:
        item = board_data.parse_todo_item("Buy filters [30m]", date(2026, 9, 1))
        assert item.title == "Buy filters"

    def test_namespace_prevents_collision_with_projects(self) -> None:
        todo_key = board_data.ledger_key("todo", "Paint the fence")
        project_key = board_data.ledger_key("projects", "Paint the fence")
        assert todo_key != project_key

    def test_priority_and_due_date_pass_through(self) -> None:
        item = board_data.parse_todo_item(
            "Buy filters",
            date(2026, 9, 1),
            priority="medium",
            due_date=date(2026, 9, 6),
        )
        assert item.priority == "medium"
        assert item.due_date == date(2026, 9, 6)


class TestUpdateLedger:
    def test_new_open_item_recorded(self) -> None:
        ledger = board_data.update_ledger({}, [("k1", False)], date(2026, 9, 4))
        assert ledger["k1"] == {"first_seen": "2026-09-04", "completed_at": None}

    def test_new_checked_item_recorded_as_already_completed(self) -> None:
        ledger = board_data.update_ledger({}, [("k1", True)], date(2026, 9, 4))
        assert ledger["k1"]["completed_at"] == "2026-09-04"

    def test_existing_open_item_newly_checked_gets_completed_at(self) -> None:
        ledger = {"k1": {"first_seen": "2026-08-01", "completed_at": None}}
        updated = board_data.update_ledger(ledger, [("k1", True)], date(2026, 9, 4))
        assert updated["k1"]["completed_at"] == "2026-09-04"
        assert updated["k1"]["first_seen"] == "2026-08-01"

    def test_existing_completed_item_reopened_clears_completed_at(self) -> None:
        ledger = {"k1": {"first_seen": "2026-08-01", "completed_at": "2026-08-15"}}
        updated = board_data.update_ledger(ledger, [("k1", False)], date(2026, 9, 4))
        assert updated["k1"]["completed_at"] is None

    def test_item_vanished_from_note_treated_as_cleared(self) -> None:
        ledger = {"k1": {"first_seen": "2026-08-01", "completed_at": None}}
        updated = board_data.update_ledger(ledger, [], date(2026, 9, 4))
        assert updated["k1"]["completed_at"] == "2026-09-04"

    def test_item_vanished_but_already_completed_keeps_original_date(self) -> None:
        ledger = {"k1": {"first_seen": "2026-08-01", "completed_at": "2026-08-20"}}
        updated = board_data.update_ledger(ledger, [], date(2026, 9, 4))
        assert updated["k1"]["completed_at"] == "2026-08-20"

    def test_untouched_items_are_not_modified(self) -> None:
        ledger = {"k1": {"first_seen": "2026-08-01", "completed_at": None}}
        updated = board_data.update_ledger(ledger, [("k1", False)], date(2026, 9, 4))
        assert updated["k1"] == ledger["k1"]


class TestPruneLedger:
    def test_old_completed_entries_pruned(self) -> None:
        ledger = {"k1": {"first_seen": "2026-01-01", "completed_at": "2026-01-02"}}
        pruned = board_data.prune_ledger(
            ledger, date(2026, 9, 4), max_completed_age_days=60
        )
        assert pruned == {}

    def test_recent_completed_entries_kept(self) -> None:
        ledger = {"k1": {"first_seen": "2026-08-01", "completed_at": "2026-08-20"}}
        pruned = board_data.prune_ledger(
            ledger, date(2026, 9, 4), max_completed_age_days=60
        )
        assert "k1" in pruned

    def test_open_entries_never_pruned_regardless_of_age(self) -> None:
        ledger = {"k1": {"first_seen": "2020-01-01", "completed_at": None}}
        pruned = board_data.prune_ledger(
            ledger, date(2026, 9, 4), max_completed_age_days=60
        )
        assert "k1" in pruned


class TestClearedThisWeek:
    def test_counts_within_rolling_seven_day_window(self) -> None:
        today = date(2026, 9, 4)
        ledger = {
            "in_window": {
                "first_seen": "x",
                "completed_at": "2026-08-30",
            },  # 5 days ago
            "on_boundary": {
                "first_seen": "x",
                "completed_at": "2026-08-29",
            },  # 6 days ago
            "out_of_window": {
                "first_seen": "x",
                "completed_at": "2026-08-28",
            },  # 7 days ago
            "still_open": {"first_seen": "x", "completed_at": None},
        }
        assert board_data.cleared_this_week(ledger, today) == 2


class TestDaysSince:
    def test_basic(self) -> None:
        assert board_data.days_since(date(2026, 8, 1), date(2026, 9, 4)) == 34

    def test_future_first_seen_clamped_to_zero(self) -> None:
        assert board_data.days_since(date(2026, 9, 10), date(2026, 9, 4)) == 0


class TestSelectInFlight:
    def _item(self, text: str, first_seen: date) -> board_data.ProjectItem:
        return board_data.ProjectItem(
            key=text,
            title=text,
            size_tag=None,
            note_text="",
            in_flight=True,
            first_seen=first_seen,
        )

    def test_within_max_returned_in_note_order(self) -> None:
        items = [self._item("a", date(2026, 9, 1)), self._item("b", date(2026, 8, 1))]
        visible, overflow = board_data.select_in_flight(items, max_in_flight=2)
        assert [i.title for i in visible] == ["a", "b"]
        assert overflow == 0

    def test_overflow_shows_oldest_first_and_reports_count(self) -> None:
        items = [
            self._item("newest", date(2026, 9, 1)),
            self._item("oldest", date(2026, 7, 1)),
            self._item("middle", date(2026, 8, 1)),
        ]
        visible, overflow = board_data.select_in_flight(items, max_in_flight=2)
        assert [i.title for i in visible] == ["oldest", "middle"]
        assert overflow == 1


class TestSelectBacklog:
    def _item(self, key: str, first_seen: date) -> board_data.ProjectItem:
        return board_data.ProjectItem(
            key=key,
            title=key,
            size_tag=None,
            note_text="",
            in_flight=False,
            first_seen=first_seen,
        )

    def test_fewer_items_than_rows_returns_all(self) -> None:
        items = [self._item("a", date(2026, 9, 1))]
        out = board_data.select_backlog(
            items, row_count=4, today=date(2026, 9, 4), seed_key="x"
        )
        assert out == items

    def test_stable_within_a_day(self) -> None:
        items = [self._item(f"item{i}", date(2026, 9, 1)) for i in range(10)]
        today = date(2026, 9, 4)
        out_a = board_data.select_backlog(
            items, row_count=3, today=today, seed_key="Projects"
        )
        out_b = board_data.select_backlog(
            items, row_count=3, today=today, seed_key="Projects"
        )
        assert [i.key for i in out_a] == [i.key for i in out_b]

    def test_returns_exactly_row_count_distinct_items(self) -> None:
        items = [self._item(f"item{i}", date(2026, 9, 1)) for i in range(10)]
        out = board_data.select_backlog(
            items, row_count=4, today=date(2026, 9, 4), seed_key="x"
        )
        assert len(out) == 4
        assert len({i.key for i in out}) == 4


class TestSelectTodo:
    def test_sorted_oldest_first_and_truncated(self) -> None:
        items = [
            board_data.TodoItem(key="a", title="a", first_seen=date(2026, 9, 2)),
            board_data.TodoItem(key="b", title="b", first_seen=date(2026, 8, 1)),
            board_data.TodoItem(key="c", title="c", first_seen=date(2026, 8, 15)),
        ]
        out = board_data.select_todo(items, row_count=2)
        assert [i.title for i in out] == ["b", "c"]


class TestProjectsColumnGeometry:
    def test_backlog_start_is_past_label_top(self) -> None:
        assert board_data.backlog_start_em(1) > board_data.backlog_label_top_em(1)

    def test_zero_in_flight_still_reserves_backlog_label_band(self) -> None:
        """Regression: the "From the backlog" label always renders (only
        the "In flight" section collapses per SPEC §7.8), so rows must
        still start past its label band even with 0 in-flight items —
        otherwise the label and the first backlog row overlap."""
        assert board_data.backlog_start_em(0) == board_data.BACKLOG_LABEL_BAND_EM

    def test_projects_column_fits_matches_capacity_at_normal_size(self) -> None:
        body_height_em = 19.88  # 800x480 reference
        visible_in_flight = board_data.in_flight_capacity(body_height_em)
        visible_backlog = board_data.backlog_capacity(body_height_em, visible_in_flight)
        assert board_data.projects_column_fits(
            body_height_em, visible_in_flight, visible_backlog
        )

    def test_projects_column_does_not_fit_on_a_tight_column(self) -> None:
        # Enough for 1 in-flight row but not MIN_BACKLOG=2 backlog rows after it.
        body_height_em = 9.19
        visible_in_flight = 1
        visible_backlog = board_data.backlog_capacity(body_height_em, visible_in_flight)
        assert visible_backlog == board_data.MIN_BACKLOG
        assert not board_data.projects_column_fits(
            body_height_em, visible_in_flight, visible_backlog
        )


class TestTodoColumnGeometry:
    def test_normal_panel_fits(self) -> None:
        body_height_em = 19.88
        visible_todo = board_data.todo_capacity(body_height_em)
        assert board_data.todo_column_fits(body_height_em, visible_todo)

    def test_tiny_panel_does_not_fit_min_rows(self) -> None:
        body_height_em = 2.0
        visible_todo = board_data.MIN_TODO  # capacity always clamps up to this floor
        assert not board_data.todo_column_fits(body_height_em, visible_todo)

    def test_cleared_line_rows_reserves_one_slot_when_empty(self) -> None:
        assert (
            board_data.todo_cleared_line_rows(visible_todo=0, todo_is_empty=True) == 1
        )

    def test_cleared_line_rows_matches_visible_count_when_not_empty(self) -> None:
        assert (
            board_data.todo_cleared_line_rows(visible_todo=3, todo_is_empty=False) == 3
        )

    def test_fits_check_uses_the_same_reserved_row_as_the_empty_render(self) -> None:
        """Regression: todo_column_fits() must be called with
        todo_cleared_line_rows()'s result, not the raw visible-todo count —
        an empty to-do list still renders one "Nothing open" row-slot
        before the cleared line, so a fits-check against 0 rows would
        underestimate the space actually needed and let the too-small
        fallback be skipped on a panel where the cleared line then
        overflows the column."""
        # Just past CLEARED_LINE_BAND_EM (1.4em) but short of one full
        # TODO_PITCH_EM (2.6em) row-slot plus the band.
        body_height_em = 2.0
        raw_visible_todo = 0
        assert board_data.todo_column_fits(body_height_em, raw_visible_todo)
        cleared_line_rows = board_data.todo_cleared_line_rows(
            raw_visible_todo, todo_is_empty=True
        )
        assert not board_data.todo_column_fits(body_height_em, cleared_line_rows)


class TestValidateAgeThresholds:
    def test_non_decreasing_thresholds_pass(self) -> None:
        assert board_data.validate_age_thresholds("Project age", 0, 90, 180) is None

    def test_equal_thresholds_pass(self) -> None:
        assert board_data.validate_age_thresholds("Project age", 10, 10, 10) is None

    def test_warn_after_alert_is_rejected(self) -> None:
        error = board_data.validate_age_thresholds("Project age", 0, 200, 100)
        assert error is not None
        assert "Project age" in error

    def test_two_value_todo_thresholds_supported(self) -> None:
        assert board_data.validate_age_thresholds("To-do age", 14, 30) is None
        assert board_data.validate_age_thresholds("To-do age", 30, 14) is not None
