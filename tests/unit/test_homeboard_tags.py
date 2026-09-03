"""Unit tests for homeboard.tags — SPEC.md §4.3 size/age tags."""

from __future__ import annotations

import pytest

from homeboard import tags
from homeboard.palette import Role


class TestParseSizeTag:
    @pytest.mark.parametrize(
        ("raw", "expected_title", "expected_label"),
        [
            ("Replace the hose bib [30m]", "Replace the hose bib", "30 minutes"),
            ("Replace the hose bib [30 minutes]", "Replace the hose bib", "30 minutes"),
            ("Run the gas line [half day]", "Run the gas line", "Half a day"),
            ("Run the gas line [2h]", "Run the gas line", "Half a day"),
            ("Frame the BBQ counter [weekend]", "Frame the BBQ counter", "One weekend"),
            ("Frame the BBQ counter [1d]", "Frame the BBQ counter", "One weekend"),
            # Matching should be case-insensitive on the bracket contents.
            ("Task [HALF DAY]", "Task", "Half a day"),
        ],
    )
    def test_recognized_brackets_normalize(
        self, raw: str, expected_title: str, expected_label: str
    ) -> None:
        title, tag = tags.parse_size_tag(raw)
        assert title == expected_title
        assert tag is not None
        assert tag.label == expected_label
        assert tag.role == Role.AVAILABLE
        assert tag.solid is False

    def test_unrecognized_bracket_renders_verbatim(self) -> None:
        title, tag = tags.parse_size_tag("Paint the shed [ask Dave]")
        assert title == "Paint the shed"
        assert tag is not None
        assert tag.label == "ask Dave"

    def test_absent_bracket_omits_tag_entirely(self) -> None:
        title, tag = tags.parse_size_tag("Insulate the garage door")
        assert title == "Insulate the garage door"
        assert tag is None

    def test_non_trailing_brackets_are_not_treated_as_size_tags(self) -> None:
        # A bracket that isn't at the end of the string shouldn't be parsed
        # as a size tag.
        title, tag = tags.parse_size_tag("Fix [the] gate")
        assert title == "Fix [the] gate"
        assert tag is None


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
