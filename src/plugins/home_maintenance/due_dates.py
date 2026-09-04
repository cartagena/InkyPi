"""Due-date computation and sorting for the home_maintenance plugin.

Pure functions, no I/O — SPEC §8.2. Kept separate from home_maintenance.py
so the due-date math is unit-testable without Chromium or a Sheets fetch.
"""

from __future__ import annotations

import calendar
from dataclasses import dataclass
from datetime import date, timedelta
from enum import StrEnum


class IntervalUnit(StrEnum):
    DAYS = "days"
    MONTHS = "months"
    YEARS = "years"
    MILES = "miles"
    SEASONAL = "seasonal"


class Status(StrEnum):
    OVERDUE = "overdue"
    DUE_SOON = "due_soon"
    OK = "ok"


_UNIT_SINGULAR = {
    IntervalUnit.DAYS: "day",
    IntervalUnit.MONTHS: "month",
    IntervalUnit.YEARS: "year",
}
_UNIT_PLURAL = {
    IntervalUnit.DAYS: "days",
    IntervalUnit.MONTHS: "months",
    IntervalUnit.YEARS: "years",
}


def _add_months(d: date, months: int) -> date:
    month_index = d.month - 1 + months
    year = d.year + month_index // 12
    month = month_index % 12 + 1
    day = min(d.day, calendar.monthrange(year, month)[1])
    return date(year, month, day)


def compute_next_due(
    interval_value: int | None,
    interval_unit: IntervalUnit,
    last_done: date | None,
    next_due_override: date | None,
) -> date | None:
    """``next_due = last_done + interval``, unless ``next_due_override`` is
    set (which always wins). ``seasonal`` has no computed date and relies
    entirely on the override; ``miles`` can't be computed from a date
    either — both return ``None`` here absent an override.
    """
    if next_due_override is not None:
        return next_due_override
    if interval_unit in (IntervalUnit.SEASONAL, IntervalUnit.MILES):
        return None
    if last_done is None or interval_value is None:
        return None
    if interval_unit == IntervalUnit.DAYS:
        return last_done + timedelta(days=interval_value)
    if interval_unit == IntervalUnit.MONTHS:
        return _add_months(last_done, interval_value)
    return _add_months(last_done, interval_value * 12)


def interval_text(interval_value: int | None, interval_unit: IntervalUnit) -> str:
    """Human-readable interval, e.g. "Every 3 months" / "Every 7,500 mi"."""
    if interval_unit == IntervalUnit.SEASONAL:
        return "Seasonal"
    if interval_value is None:
        return ""
    if interval_unit == IntervalUnit.MILES:
        return f"Every {interval_value:,} mi"
    unit_label = (
        _UNIT_SINGULAR[interval_unit]
        if interval_value == 1
        else _UNIT_PLURAL[interval_unit]
    )
    return f"Every {interval_value} {unit_label}"


@dataclass(frozen=True)
class Classification:
    status: Status
    days_overdue: int | None  # set only when status == OVERDUE
    days_until_due: int | None  # set only when status == DUE_SOON


def classify(next_due: date | None, today: date, due_soon_days: int) -> Classification:
    """Overdue / due-soon / plain, per the SPEC §8.2 status table."""
    if next_due is None:
        return Classification(Status.OK, None, None)
    delta_days = (next_due - today).days
    if delta_days < 0:
        return Classification(Status.OVERDUE, -delta_days, None)
    if delta_days <= due_soon_days:
        return Classification(Status.DUE_SOON, None, delta_days)
    return Classification(Status.OK, None, None)


@dataclass(frozen=True)
class MaintenanceItem:
    task: str
    interval_value: int | None
    interval_unit: IntervalUnit
    last_done: date | None
    next_due: date | None
    status: Status
    days_overdue: int | None
    days_until_due: int | None
    interval_text: str


def build_item(
    task: str,
    interval_value: int | None,
    interval_unit: IntervalUnit,
    last_done: date | None,
    next_due_override: date | None,
    today: date,
    due_soon_days: int,
) -> MaintenanceItem:
    next_due = compute_next_due(
        interval_value, interval_unit, last_done, next_due_override
    )
    classification = classify(next_due, today, due_soon_days)
    return MaintenanceItem(
        task=task,
        interval_value=interval_value,
        interval_unit=interval_unit,
        last_done=last_done,
        next_due=next_due,
        status=classification.status,
        days_overdue=classification.days_overdue,
        days_until_due=classification.days_until_due,
        interval_text=interval_text(interval_value, interval_unit),
    )


def _sort_key(item: MaintenanceItem) -> tuple[int, int, date]:
    """Overdue first (most overdue first), then due-soon (soonest first),
    then the rest by next_due ascending — items with no computed date sort
    last within their bucket."""
    far_future = date.max
    if item.status == Status.OVERDUE:
        return (0, -(item.days_overdue or 0), item.next_due or far_future)
    if item.status == Status.DUE_SOON:
        return (1, item.days_until_due or 0, item.next_due or far_future)
    return (2, 0, item.next_due or far_future)


def sort_items(items: list[MaintenanceItem]) -> list[MaintenanceItem]:
    return sorted(items, key=_sort_key)
