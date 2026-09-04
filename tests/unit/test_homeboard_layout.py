"""Unit tests for homeboard.layout — SPEC.md §3 token/row-count math."""

from __future__ import annotations

import pytest

from homeboard import layout


class TestClamp:
    def test_within_range(self) -> None:
        assert layout.clamp(5, 0, 10) == 5

    def test_below_range(self) -> None:
        assert layout.clamp(-5, 0, 10) == 0

    def test_above_range(self) -> None:
        assert layout.clamp(15, 0, 10) == 10


class TestTokens:
    def test_800x480_matches_mockup_base(self) -> None:
        # SPEC §3.7: base = 19.2px at 800x480.
        t = layout.tokens(800, 480)
        assert t.base == pytest.approx(19.2)

    def test_800x480_mockup_derived_values(self) -> None:
        t = layout.tokens(800, 480)
        # SPEC §3.7 reference table.
        assert t.margin_x_pct / 100 * t.width == pytest.approx(20)
        assert t.header_rule_em * t.base == pytest.approx(52.8)
        assert t.body_top_em * t.base == pytest.approx(63.36)
        assert t.height - t.footer_rule_em * t.base == pytest.approx(453.12)
        assert t.fs["title"] == pytest.approx(26.88)
        assert t.fs["item"] == pytest.approx(21.12)
        assert t.fs["small"] == pytest.approx(14.4)
        assert t.fs["display"] == pytest.approx(43.2)

    def test_base_clamped_to_floor_on_a_short_panel(self) -> None:
        t = layout.tokens(400, 100)  # height*0.04 = 4, below the 14px floor
        assert t.base == 14.0

    def test_base_clamped_to_ceiling_on_a_tall_panel(self) -> None:
        t = layout.tokens(600, 2000)  # height*0.04 = 80, above the 28px ceiling
        assert t.base == 28.0

    def test_base_exactly_at_floor_boundary(self) -> None:
        # height*0.04 == 14 exactly at height=350
        t = layout.tokens(800, 350)
        assert t.base == pytest.approx(14.0)

    def test_base_exactly_at_ceiling_boundary(self) -> None:
        # height*0.04 == 28 exactly at height=700
        t = layout.tokens(800, 700)
        assert t.base == pytest.approx(28.0)

    @pytest.mark.parametrize(
        ("width", "height", "expected_landscape"),
        [
            (800, 480, True),  # 1.667
            (480, 400, True),  # 1.2 exactly - boundary is inclusive
            (600, 800, False),  # portrait
            (500, 500, False),  # square
        ],
    )
    def test_landscape_orientation_boundary(
        self, width: int, height: int, expected_landscape: bool
    ) -> None:
        t = layout.tokens(width, height)
        assert t.landscape is expected_landscape

    def test_font_scale_is_monotonic(self) -> None:
        t = layout.tokens(800, 480)
        ordered = ["small", "label", "body", "cell", "item", "title", "display"]
        values = [t.fs[name] for name in ordered]
        assert values == sorted(values)

    def test_nothing_renders_below_fs_small(self) -> None:
        # SPEC §3.1: fs-small is the legibility floor across the whole scale.
        t = layout.tokens(800, 480)
        assert min(t.fs.values()) == t.fs["small"]


class TestBodyHeight:
    def test_800x480_body_height_em(self) -> None:
        t = layout.tokens(800, 480)
        # height_em = 480/19.2 = 25; body_height = 25 - 3.30 - 1.82 = 19.88
        assert t.height_em == pytest.approx(25.0)
        assert t.body_height_em == pytest.approx(19.88)

    def test_body_height_stays_positive_at_clamp_boundaries(self) -> None:
        short = layout.tokens(800, 350)  # base at the 14px floor
        tall = layout.tokens(800, 700)  # base at the 28px ceiling
        assert short.body_height_em > 0
        assert tall.body_height_em > 0


class TestRowCount:
    def test_weekends_pitch_at_800x480_yields_max_rows(self) -> None:
        t = layout.tokens(800, 480)
        # SPEC §6.2: row pitch 3.10em, row height 2.75em, min/max 4/6,
        # header band 1.15em.
        rows = layout.row_count(
            t,
            row_pitch_em=3.10,
            row_height_em=2.75,
            min_rows=4,
            max_rows=6,
            header_band_em=1.15,
        )
        assert rows == 6

    def test_clamps_to_min_rows_on_a_short_panel(self) -> None:
        t = layout.tokens(800, 200)  # very little body height available
        rows = layout.row_count(
            t,
            row_pitch_em=3.10,
            row_height_em=2.75,
            min_rows=4,
            max_rows=6,
        )
        assert rows == 4

    def test_clamps_to_max_rows_on_a_tall_panel(self) -> None:
        t = layout.tokens(800, 2000)
        rows = layout.row_count(
            t,
            row_pitch_em=2.50,
            row_height_em=2.0,
            min_rows=5,
            max_rows=10,
        )
        assert rows == 10

    def test_rejects_non_positive_row_pitch(self) -> None:
        t = layout.tokens(800, 480)
        with pytest.raises(ValueError):
            layout.row_count(t, row_pitch_em=0, row_height_em=1, min_rows=1, max_rows=5)


class TestFitsMinRows:
    def test_true_when_min_rows_fit(self) -> None:
        t = layout.tokens(800, 480)
        assert layout.fits_min_rows(t, row_pitch_em=2.50, row_height_em=2.0, min_rows=5)

    def test_false_on_a_too_small_panel(self) -> None:
        t = layout.tokens(200, 120)
        assert not layout.fits_min_rows(
            t, row_pitch_em=3.10, row_height_em=2.75, min_rows=4
        )

    def test_header_band_em_matches_row_count_masking_case(self) -> None:
        """Regression: without accounting for header_band_em the same way
        row_count() does, this could report True on a panel where
        row_count()'s own min_rows clamp is silently masking a shortfall —
        exactly the failure mode this function exists to catch."""
        t = layout.tokens(800, 245)
        row_pitch_em, row_height_em, min_rows, header_band_em = 3.10, 2.75, 4, 1.15
        # Confirm row_count's clamp really is masking a shortfall here.
        assert (
            layout.row_count(
                t, row_pitch_em, row_height_em, min_rows, 6, header_band_em
            )
            == min_rows
        )
        # The pre-fix call (no header_band_em) reported True here — masked.
        assert layout.fits_min_rows(t, row_pitch_em, row_height_em, min_rows)
        assert not layout.fits_min_rows(
            t, row_pitch_em, row_height_em, min_rows, header_band_em
        )

    def test_default_header_band_em_is_zero_for_backward_compatibility(self) -> None:
        t = layout.tokens(800, 480)
        with_default = layout.fits_min_rows(t, 2.50, 2.0, 5)
        with_explicit_zero = layout.fits_min_rows(t, 2.50, 2.0, 5, 0.0)
        assert with_default == with_explicit_zero


class TestTruncate:
    def test_short_text_is_untouched(self) -> None:
        assert layout.truncate("Free", 400, 20) == "Free"

    def test_long_text_is_truncated_with_ellipsis(self) -> None:
        text = "Rebuild the side gate and paint the fence before winter"
        out = layout.truncate(text, region_width_px=150, font_size_px=20)
        assert out.endswith("…")
        assert len(out) < len(text)

    def test_truncates_at_word_boundary_when_possible(self) -> None:
        text = "Insulate the garage door completely this weekend"
        # budget = floor(200/(20*0.52)) = 19 -> target = 18 -> last space at
        # index 12 within text[:18] is kept since 12 >= 18//2.
        out = layout.truncate(text, region_width_px=200, font_size_px=20)
        assert out == "Insulate the…"

    def test_zero_width_returns_empty(self) -> None:
        assert layout.truncate("anything", 0, 20) == ""

    def test_zero_font_size_returns_empty(self) -> None:
        assert layout.truncate("anything", 200, 0) == ""

    def test_single_character_budget_returns_ellipsis_only(self) -> None:
        # budget = floor(15/(20*0.52)) = 1
        out = layout.truncate("Something long", region_width_px=15, font_size_px=20)
        assert out == "…"

    def test_zero_budget_returns_empty(self) -> None:
        # budget = floor(10/(20*0.52)) = 0 -> no room even for an ellipsis
        out = layout.truncate("Something long", region_width_px=10, font_size_px=20)
        assert out == ""


class TestTokensCss:
    def test_emits_root_block_with_expected_custom_properties(self) -> None:
        t = layout.tokens(800, 480)
        css = layout.tokens_css(t)
        assert css.startswith(":root {")
        assert css.rstrip().endswith("}")
        for expected in (
            "--base:",
            "--fs-small:",
            "--fs-display:",
            "--margin-x: 2.5%;",
            "--content-w: 95.0%;",
            "--gutter: 5.0%;",
            "--col-w: 47.5%;",
            "--header-rule: 52.8000px;",
            "--body-top: 63.3600px;",
            "--body-bottom: 34.9440px;",
            "--footer-rule: 26.8800px;",
            "--footer-baseline: 9.0240px;",
        ):
            assert expected in css
