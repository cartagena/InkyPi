"""Unit tests for plugins.home_maintenance.due_dates — SPEC.md §8.2."""

from __future__ import annotations

from datetime import date

from plugins.home_maintenance.due_dates import (
    IntervalUnit,
    MaintenanceItem,
    Status,
    build_item,
    classify,
    compute_next_due,
    interval_text,
    sort_items,
)


class TestComputeNextDue:
    def test_override_always_wins(self) -> None:
        assert compute_next_due(
            3, IntervalUnit.MONTHS, date(2026, 1, 1), date(2027, 6, 1)
        ) == date(2027, 6, 1)

    def test_days_interval(self) -> None:
        assert compute_next_due(30, IntervalUnit.DAYS, date(2026, 1, 1), None) == date(
            2026, 1, 31
        )

    def test_months_interval(self) -> None:
        assert compute_next_due(
            3, IntervalUnit.MONTHS, date(2026, 1, 15), None
        ) == date(2026, 4, 15)

    def test_months_interval_clamps_day_to_shorter_month(self) -> None:
        # Jan 31 + 1 month -> Feb has no 31st, clamp to Feb 28 (2026 is not
        # a leap year).
        assert compute_next_due(
            1, IntervalUnit.MONTHS, date(2026, 1, 31), None
        ) == date(2026, 2, 28)

    def test_years_interval(self) -> None:
        assert compute_next_due(2, IntervalUnit.YEARS, date(2026, 3, 10), None) == date(
            2028, 3, 10
        )

    def test_seasonal_without_override_has_no_computed_date(self) -> None:
        assert (
            compute_next_due(None, IntervalUnit.SEASONAL, date(2026, 1, 1), None)
            is None
        )

    def test_miles_without_override_has_no_computed_date(self) -> None:
        assert (
            compute_next_due(7500, IntervalUnit.MILES, date(2026, 1, 1), None) is None
        )

    def test_missing_last_done_has_no_computed_date(self) -> None:
        assert compute_next_due(3, IntervalUnit.MONTHS, None, None) is None


class TestIntervalText:
    def test_days_plural(self) -> None:
        assert interval_text(30, IntervalUnit.DAYS) == "Every 30 days"

    def test_days_singular(self) -> None:
        assert interval_text(1, IntervalUnit.DAYS) == "Every 1 day"

    def test_months(self) -> None:
        assert interval_text(3, IntervalUnit.MONTHS) == "Every 3 months"

    def test_years_singular(self) -> None:
        assert interval_text(1, IntervalUnit.YEARS) == "Every 1 year"

    def test_miles_uses_thousands_separator(self) -> None:
        assert interval_text(7500, IntervalUnit.MILES) == "Every 7,500 mi"

    def test_seasonal_has_no_number(self) -> None:
        assert interval_text(None, IntervalUnit.SEASONAL) == "Seasonal"


class TestClassify:
    def test_past_due_is_overdue(self) -> None:
        c = classify(date(2026, 1, 1), today=date(2026, 1, 10), due_soon_days=14)
        assert c.status == Status.OVERDUE
        assert c.days_overdue == 9
        assert c.days_until_due is None

    def test_within_due_soon_window(self) -> None:
        c = classify(date(2026, 1, 15), today=date(2026, 1, 10), due_soon_days=14)
        assert c.status == Status.DUE_SOON
        assert c.days_until_due == 5

    def test_at_due_soon_boundary_is_due_soon(self) -> None:
        c = classify(date(2026, 1, 24), today=date(2026, 1, 10), due_soon_days=14)
        assert c.status == Status.DUE_SOON
        assert c.days_until_due == 14

    def test_just_past_due_soon_boundary_is_ok(self) -> None:
        c = classify(date(2026, 1, 25), today=date(2026, 1, 10), due_soon_days=14)
        assert c.status == Status.OK

    def test_due_today_is_due_soon(self) -> None:
        c = classify(date(2026, 1, 10), today=date(2026, 1, 10), due_soon_days=14)
        assert c.status == Status.DUE_SOON
        assert c.days_until_due == 0

    def test_no_next_due_is_ok_with_no_days(self) -> None:
        c = classify(None, today=date(2026, 1, 10), due_soon_days=14)
        assert c.status == Status.OK
        assert c.days_overdue is None
        assert c.days_until_due is None


class TestBuildItem:
    def test_builds_a_fully_populated_item(self) -> None:
        item = build_item(
            "Replace furnace filter",
            3,
            IntervalUnit.MONTHS,
            date(2025, 11, 1),
            None,
            today=date(2026, 2, 15),
            due_soon_days=14,
        )
        assert item.task == "Replace furnace filter"
        assert item.next_due == date(2026, 2, 1)
        assert item.status == Status.OVERDUE
        assert item.days_overdue == 14
        assert item.interval_text == "Every 3 months"


class TestSortItems:
    def _item(
        self,
        task: str,
        status: Status,
        days_overdue: int | None = None,
        days_until_due: int | None = None,
        next_due: date | None = None,
    ) -> MaintenanceItem:
        return MaintenanceItem(
            task=task,
            interval_value=1,
            interval_unit=IntervalUnit.MONTHS,
            last_done=None,
            next_due=next_due,
            status=status,
            days_overdue=days_overdue,
            days_until_due=days_until_due,
            interval_text="Every 1 month",
        )

    def test_overdue_sorts_before_due_soon_and_ok(self) -> None:
        ok_item = self._item("ok", Status.OK, next_due=date(2027, 1, 1))
        overdue_item = self._item("overdue", Status.OVERDUE, days_overdue=5)
        due_soon_item = self._item("due_soon", Status.DUE_SOON, days_until_due=3)

        ordered = sort_items([ok_item, due_soon_item, overdue_item])
        assert [i.task for i in ordered] == ["overdue", "due_soon", "ok"]

    def test_most_overdue_sorts_first_within_overdue_bucket(self) -> None:
        a = self._item("a", Status.OVERDUE, days_overdue=2)
        b = self._item("b", Status.OVERDUE, days_overdue=20)
        assert [i.task for i in sort_items([a, b])] == ["b", "a"]

    def test_soonest_due_sorts_first_within_due_soon_bucket(self) -> None:
        a = self._item("a", Status.DUE_SOON, days_until_due=10)
        b = self._item("b", Status.DUE_SOON, days_until_due=1)
        assert [i.task for i in sort_items([a, b])] == ["b", "a"]

    def test_ok_bucket_sorts_by_next_due_ascending(self) -> None:
        a = self._item("a", Status.OK, next_due=date(2027, 6, 1))
        b = self._item("b", Status.OK, next_due=date(2026, 3, 1))
        assert [i.task for i in sort_items([a, b])] == ["b", "a"]

    def test_items_with_no_next_due_sort_last_in_their_bucket(self) -> None:
        dated = self._item("dated", Status.OK, next_due=date(2026, 3, 1))
        undated = self._item("undated", Status.OK, next_due=None)
        assert [i.task for i in sort_items([undated, dated])] == ["dated", "undated"]
