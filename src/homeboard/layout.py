"""Layout token math shared by the bedroom-dashboard screens.

Every geometric value the screens use derives from the panel's
``(width, height)`` — see ``specs/SPEC.md`` §3. Nothing here hardcodes a
pixel value; per-screen constants (row pitch, row height, min/max rows) are
supplied by the caller so this module stays testable purely against the
dimension/orientation matrix in §3, independent of any one screen's layout.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

# --- §3.1 the base unit -----------------------------------------------

_BASE_MIN_PX = 14.0
_BASE_MAX_PX = 28.0
_BASE_HEIGHT_RATIO = 0.040

# Token name -> multiple of `base`, from the §3.1 type scale table.
_FONT_SCALE = {
    "small": 0.75,
    "label": 0.78,
    "body": 1.00,
    "cell": 1.05,
    "item": 1.10,
    "title": 1.40,
    "display": 2.25,
}

# --- §3.2 horizontal metrics (percentages of width) --------------------

MARGIN_X_PCT = 2.5
CONTENT_W_PCT = 95.0
GUTTER_PCT = 5.0
COL_W_PCT = 47.5

# --- §3.3 vertical bands (em of base) -----------------------------------

HEADER_RULE_EM = 2.75
BODY_TOP_EM = 3.30
BODY_BOTTOM_EM = 1.82  # distance from the bottom edge, not a position
FOOTER_RULE_EM = 1.40
FOOTER_BASELINE_EM = 0.47

# --- §3.5 orientation and aspect ----------------------------------------

_LANDSCAPE_ASPECT_THRESHOLD = 1.2

# --- §3.6 truncation ------------------------------------------------------

# Average glyph-advance ratio used to turn a pixel width into a character
# budget. UNVERIFIED — calibrate against the bundled font before trusting
# this value for anything narrower than a rough estimate (SPEC §3.6).
ADVANCE_RATIO = 0.52

_ELLIPSIS = "…"


def clamp(value: float, low: float, high: float) -> float:
    """Clamp *value* to the inclusive range ``[low, high]``."""
    return max(low, min(high, value))


@dataclass(frozen=True)
class Tokens:
    """Resolved layout tokens for one ``(width, height)`` pair."""

    width: int
    height: int
    base: float  # px
    fs: dict[str, float] = field(repr=False)  # token name -> px
    landscape: bool = True

    margin_x_pct: float = MARGIN_X_PCT
    content_w_pct: float = CONTENT_W_PCT
    gutter_pct: float = GUTTER_PCT
    col_w_pct: float = COL_W_PCT

    header_rule_em: float = HEADER_RULE_EM
    body_top_em: float = BODY_TOP_EM
    body_bottom_em: float = BODY_BOTTOM_EM
    footer_rule_em: float = FOOTER_RULE_EM
    footer_baseline_em: float = FOOTER_BASELINE_EM

    @property
    def height_em(self) -> float:
        """Panel height expressed in ems of ``base``."""
        return self.height / self.base

    @property
    def body_height_em(self) -> float:
        """Height of the body region, in ems of ``base``.

        ``body_bottom_em`` is a distance *from the bottom edge* (per the
        §3.3 table), so the body region's height is the panel height minus
        both the top offset and that bottom margin — not the formula as
        literally transcribed in SPEC §3.3, which self-cancels to
        ``bodyBottom - bodyTop`` if read as position-minus-position. This is
        the reading that reproduces the mockup's numbers.
        """
        return self.height_em - self.body_top_em - self.body_bottom_em


def tokens(width: int, height: int) -> Tokens:
    """Derive all layout tokens for a panel of the given pixel dimensions."""
    base = clamp(height * _BASE_HEIGHT_RATIO, _BASE_MIN_PX, _BASE_MAX_PX)
    fs = {name: base * multiple for name, multiple in _FONT_SCALE.items()}
    landscape = (width / height) >= _LANDSCAPE_ASPECT_THRESHOLD if height else True
    return Tokens(width=width, height=height, base=base, fs=fs, landscape=landscape)


def row_count(
    t: Tokens,
    row_pitch_em: float,
    row_height_em: float,
    min_rows: int,
    max_rows: int,
    header_band_em: float = 0.0,
) -> int:
    """Compute how many rows fit in the body region.

    ``rows = clamp(floor((availableHeight + gap) / rowPitch), minRows, maxRows)``
    where ``gap = rowPitch - rowHeight`` (SPEC §3.4). ``header_band_em``
    subtracts a fixed in-body band (e.g. weekends' column-label row) from
    the available height before the row math runs.
    """
    available_em = t.body_height_em - header_band_em
    gap_em = row_pitch_em - row_height_em
    if row_pitch_em <= 0:
        raise ValueError("row_pitch_em must be positive")
    raw_rows = math.floor((available_em + gap_em) / row_pitch_em)
    return int(clamp(raw_rows, min_rows, max_rows))


def fits_min_rows(
    t: Tokens, row_pitch_em: float, row_height_em: float, min_rows: int
) -> bool:
    """Whether the panel can fit at least ``min_rows`` rows at all.

    Used to decide when a screen must fall back to the §3.5 "panel too
    small for this screen" message instead of overflowing. Computed against
    the *unclamped* row count — calling row_count() with min_rows==max_rows
    would always report success, since the clamp itself hides the shortfall.
    """
    if row_pitch_em <= 0:
        raise ValueError("row_pitch_em must be positive")
    gap_em = row_pitch_em - row_height_em
    raw_rows = math.floor((t.body_height_em + gap_em) / row_pitch_em)
    return raw_rows >= min_rows


def truncate(text: str, region_width_px: float, font_size_px: float) -> str:
    """Truncate *text* to the character budget for a region, word-boundary
    aware, with a trailing ellipsis (SPEC §3.6).

    ``budget = floor(regionWidthPx / (fontSizePx * ADVANCE_RATIO))``.
    """
    if font_size_px <= 0 or region_width_px <= 0:
        return ""
    budget = math.floor(region_width_px / (font_size_px * ADVANCE_RATIO))
    if budget <= 0:
        return ""
    if len(text) <= budget:
        return text
    if budget == 1:
        return _ELLIPSIS

    target = budget - 1  # reserve one character for the ellipsis
    slice_ = text[:target]
    # Prefer cutting at a word boundary, but don't discard most of the
    # budget chasing one — only back off to the last space if it keeps at
    # least half the target length.
    last_space = slice_.rfind(" ")
    if last_space >= target // 2:
        slice_ = slice_[:last_space]
    return slice_.rstrip() + _ELLIPSIS


def tokens_css(t: Tokens) -> str:
    """Render *t* as a ``:root { --token: value; }`` CSS custom-property
    block, consumed by every screen's ``<style>`` block."""
    lines = [
        f"  --base: {t.base:.4f}px;",
    ]
    for name, px in t.fs.items():
        lines.append(f"  --fs-{name}: {px:.4f}px;")
    lines.extend(
        [
            f"  --margin-x: {t.margin_x_pct}%;",
            f"  --content-w: {t.content_w_pct}%;",
            f"  --gutter: {t.gutter_pct}%;",
            f"  --col-w: {t.col_w_pct}%;",
            f"  --header-rule: {t.header_rule_em}em;",
            f"  --body-top: {t.body_top_em}em;",
            f"  --body-bottom: {t.body_bottom_em}em;",
            f"  --footer-rule: {t.footer_rule_em}em;",
            f"  --footer-baseline: {t.footer_baseline_em}em;",
        ]
    )
    return ":root {\n" + "\n".join(lines) + "\n}"
