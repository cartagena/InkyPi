"""Unit tests for homeboard.tags — SPEC.md §4.3 size/age tags."""

from __future__ import annotations

from datetime import date

from homeboard import tags
from homeboard.palette import Role


class TestEffortTag:
    def test_one_day_buckets_to_one_day_label(self) -> None:
        tag = tags.effort_tag(1)
        assert tag is not None
        assert tag.label == "One day"
        assert tag.role == Role.AVAILABLE
        assert tag.solid is False

    def test_two_days_buckets_to_a_few_days_label(self) -> None:
        tag = tags.effort_tag(2)
        assert tag is not None
        assert tag.label == "A few days"

    def test_three_days_still_a_few_days_label(self) -> None:
        tag = tags.effort_tag(3)
        assert tag is not None
        assert tag.label == "A few days"

    def test_four_days_buckets_to_multiple_days_label(self) -> None:
        tag = tags.effort_tag(4)
        assert tag is not None
        assert tag.label == "Multiple days"

    def test_well_beyond_four_days_still_multiple_days_label(self) -> None:
        tag = tags.effort_tag(30)
        assert tag is not None
        assert tag.label == "Multiple days"

    def test_none_renders_no_chip(self) -> None:
        assert tags.effort_tag(None) is None

    def test_non_positive_renders_no_chip(self) -> None:
        assert tags.effort_tag(0) is None
        assert tags.effort_tag(-1) is None


class TestPriorityTag:
    def test_high_is_alert_solid(self) -> None:
        tag = tags.priority_tag("high")
        assert tag is not None
        assert tag.label == "High"
        assert tag.role == Role.ALERT
        assert tag.solid is True

    def test_medium_is_warn_solid(self) -> None:
        tag = tags.priority_tag("medium")
        assert tag is not None
        assert tag.label == "Medium"
        assert tag.role == Role.WARN
        assert tag.solid is True

    def test_low_renders_no_chip(self) -> None:
        assert tags.priority_tag("low") is None

    def test_none_renders_no_chip(self) -> None:
        assert tags.priority_tag(None) is None

    def test_unrecognized_value_renders_no_chip(self) -> None:
        assert tags.priority_tag("urgent!!!") is None

    def test_matching_is_case_insensitive(self) -> None:
        tag = tags.priority_tag("High")
        assert tag is not None
        assert tag.label == "High"

    def test_matching_tolerates_surrounding_whitespace(self) -> None:
        tag = tags.priority_tag(" Medium ")
        assert tag is not None
        assert tag.label == "Medium"


class TestDueTag:
    def test_none_renders_no_chip(self) -> None:
        assert tags.due_tag(None, date(2026, 9, 4)) is None

    def test_overdue_is_alert_solid(self) -> None:
        tag = tags.due_tag(date(2026, 9, 1), today=date(2026, 9, 4))
        assert tag is not None
        assert tag.label == "Overdue 3d"
        assert tag.role == Role.ALERT
        assert tag.solid is True

    def test_due_today_is_warn_solid(self) -> None:
        tag = tags.due_tag(date(2026, 9, 4), today=date(2026, 9, 4))
        assert tag is not None
        assert tag.label == "Today"
        assert tag.role == Role.WARN
        assert tag.solid is True

    def test_due_tomorrow_is_warn_solid(self) -> None:
        tag = tags.due_tag(date(2026, 9, 5), today=date(2026, 9, 4))
        assert tag is not None
        assert tag.label == "Tomorrow"
        assert tag.role == Role.WARN
        assert tag.solid is True

    def test_further_out_is_ink_outline(self) -> None:
        tag = tags.due_tag(date(2026, 9, 10), today=date(2026, 9, 4))
        assert tag is not None
        assert tag.label == "Due 6d"
        assert tag.role == Role.INK
        assert tag.solid is False


class TestAgeTag:
    def test_below_show_days_is_omitted(self) -> None:
        assert (
            tags.age_tag(5, age_show_days=14, age_warn_days=30, age_alert_days=90)
            is None
        )

    def test_at_show_days_boundary_is_ink_outline(self) -> None:
        tag = tags.age_tag(14, age_show_days=14, age_warn_days=30, age_alert_days=90)
        assert tag is not None
        assert tag.role == Role.INK
        assert tag.solid is False

    def test_at_warn_days_boundary_is_warn_solid(self) -> None:
        tag = tags.age_tag(30, age_show_days=14, age_warn_days=30, age_alert_days=90)
        assert tag is not None
        assert tag.role == Role.WARN
        assert tag.solid is True

    def test_at_alert_days_boundary_is_alert_solid(self) -> None:
        tag = tags.age_tag(90, age_show_days=14, age_warn_days=30, age_alert_days=90)
        assert tag is not None
        assert tag.role == Role.ALERT
        assert tag.solid is True

    def test_well_past_alert_days_is_still_alert_solid(self) -> None:
        tag = tags.age_tag(400, age_show_days=14, age_warn_days=30, age_alert_days=90)
        assert tag is not None
        assert tag.role == Role.ALERT

    def test_zero_show_days_means_everything_shows(self) -> None:
        # board's project_age_show_days defaults to 0 (SPEC §7.6).
        tag = tags.age_tag(0, age_show_days=0, age_warn_days=90, age_alert_days=180)
        assert tag is not None
        assert tag.role == Role.INK


class TestItemKey:
    def test_stable_for_identical_text(self) -> None:
        assert tags.item_key("Replace the hose bib") == tags.item_key(
            "Replace the hose bib"
        )

    def test_normalizes_case_and_whitespace(self) -> None:
        assert tags.item_key("Replace   the Hose Bib") == tags.item_key(
            "replace the hose bib"
        )

    def test_different_text_yields_different_key(self) -> None:
        assert tags.item_key("Replace the hose bib") != tags.item_key(
            "Rebuild the side gate"
        )

    def test_key_is_short_and_hex(self) -> None:
        key = tags.item_key("Replace the hose bib")
        assert len(key) == 16
        int(key, 16)  # raises ValueError if not valid hex
