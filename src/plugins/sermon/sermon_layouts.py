"""Template parameters for the sermon plugin's two designs.

* ``band`` — "Colour band": a full-width header band in the screen's palette
  colour (title, date, series, speaker), black-on-white body below.
* ``sidebar`` — "Sidebar poster": a solid colour column on the left carrying
  the screen number, its name and the date/series/speaker; title and body on
  white to the right.

Each design keeps its geometry in one table of em-of-``base`` constants and
hands the template every size as px, so the CSS and the text-fit estimates
(``sermon_data.fit_blocks``) can't drift apart. Pure functions — no I/O.
"""

from __future__ import annotations

import math
from typing import Any, Literal

from homeboard import layout, palette
from homeboard.palette import Role
from plugins.sermon import sermon_data as sd

Design = Literal["band", "sidebar"]
DESIGNS: tuple[Design, ...] = ("band", "sidebar")
DEFAULT_DESIGN: Design = "sidebar"
# (template, stylesheet) under the plugin's render/ dir.
TEMPLATES: dict[Design, tuple[str, str]] = {
    "band": ("sermon.html", "sermon.css"),
    "sidebar": ("sermon_sidebar.html", "sermon_sidebar.css"),
}

# Colour per screen. Text on it is paper, except on yellow (warn), where it
# is ink — see band_colours for the mono fallback.
_SCREEN_ROLE: dict[sd.Screen, Role] = {
    "message": Role.EMPHASIS,
    "highlights": Role.ALERT,
    "apply": Role.AVAILABLE,
    "reflect": Role.WARN,
}

_MIN_BODY_EM = 6.0  # below this the body can't hold a useful screen
_FOOTER_ZONE_EM = 1.56  # reserved at the bottom for sync text / footnote
_FOOTER_EM = 0.68
_MAX_SCRIPTURES = 8
_MAX_RELATED = 2
# Bold Jost titles measure ~0.50 of the font size per glyph against the
# shared 0.46 advance ratio (plus word-wrap slack), so titles are fitted into
# 88% of their width. The sidebar CSS also caps the title at two lines.
_BOLD_WIDTH = 0.88


def resolve_design(value: Any) -> Design:
    """The ``design`` setting, falling back to the default for anything
    unknown (e.g. settings saved before the option existed)."""
    if isinstance(value, str) and value in DESIGNS:
        return value
    return DEFAULT_DESIGN


def band_colours(roles: palette.RoleMap, screen: sd.Screen) -> tuple[str, str]:
    """``(colour, text-on-colour)`` CSS colours for *screen*. On a mono
    panel every role resolves to ink, so the text must flip to paper even
    for the (normally yellow, ink-text) reflect screen."""
    colour = roles.colors[_SCREEN_ROLE[screen]]
    on_ink = screen == "reflect" and roles.six_colour
    text = roles.colors[Role.INK if on_ink else Role.PAPER]
    return _css_rgb(colour), _css_rgb(text)


def _css_rgb(rgb: tuple[int, int, int]) -> str:
    return f"rgb({rgb[0]}, {rgb[1]}, {rgb[2]})"


def build_params(
    t: layout.Tokens,
    roles: palette.RoleMap,
    sermon: sd.Sermon | None,
    screen: sd.Screen,
    design: Design,
    font_url: str,
) -> dict[str, Any]:
    """Template parameters for one render of *design*. ``sermon=None`` is
    the "no sermon yet" frame."""
    colour, on_colour = band_colours(roles, screen)
    # Accents drawn on white (rules, bars, numerals) can't be yellow.
    accent = _css_rgb(roles.colors[Role.INK]) if screen == "reflect" else colour
    params: dict[str, Any] = {
        "design": design,
        "root_css": layout.tokens_css(t) + "\n" + palette.palette_css(roles),
        "font_url": font_url,
        "band": colour,
        "on_band": on_colour,
        "accent": accent,
        "mark": _css_rgb(roles.colors[Role.ALERT]),
        "screen": screen,
        "screen_idx": sd.SCREENS.index(screen),
        "screen_count": len(sd.SCREENS),
        "empty": sermon is None,
        "too_small": False,
        "footnote": (
            sd.INFERRED_FOOTNOTE if sermon and sd.has_inferred(sermon, screen) else ""
        ),
        "sync": "",
        # Body defaults, overridden per screen.
        "notes": [],
        "summary": [],
        "items": [],
        "item_gap": 0.0,
        "font_px": 0.0,
        "scriptures": [],
        "related": [],
        "reflection": None,
    }
    builder = _sidebar_params if design == "sidebar" else _band_params
    params.update(builder(t, sermon, screen))
    return params


# --- shared body builders -------------------------------------------------


def _summary(
    sermon: sd.Sermon,
    width: float,
    height: float,
    steps: list[float],
    line_height: float,
    tag_h: float,
) -> dict[str, Any]:
    """Message screen: service-note tags (one row, *tag_h* tall) above the
    summary, fitted into what the tags leave of *height*."""
    notes = sd.service_note_labels(sermon.service_notes)
    texts, font_px = sd.fit_blocks(
        [sermon.summary] if sermon.summary else [],
        width,
        height - (tag_h if notes else 0.0),
        steps,
        line_height=line_height,
    )
    return {"notes": notes, "summary": texts, "font_px": font_px}


def _list_body(
    sermon: sd.Sermon,
    screen: sd.Screen,
    text_w: float,
    height: float,
    steps: list[float],
    gap: float,
    line_height: float,
    min_block: float,
) -> dict[str, Any]:
    """Key points or takeaways (the only two list screens), fitted into
    *height*; *gap*, *line_height* and *min_block* are as for
    ``sermon_data.block_height``."""
    if screen == "highlights":
        texts, inferred = sermon.highlights, [False] * len(sermon.highlights)
    else:
        texts = [m.text for m in sermon.takeaways]
        inferred = [m.inferred for m in sermon.takeaways]
    fitted, font_px = sd.fit_blocks(
        texts,
        text_w,
        height,
        steps,
        gap=gap,
        line_height=line_height,
        min_block=min_block,
    )
    return {
        "items": [
            {"text": tx, "inferred": inf}
            for tx, inf in zip(fitted, inferred, strict=False)
        ],
        "font_px": font_px,
        "item_gap": gap,
    }


def _question(
    sermon: sd.Sermon, width: float, room: float, steps: list[float], lh: float
) -> dict[str, Any] | None:
    """Reflection question fitted into *room* (what the passage lists leave),
    or ``None`` when there is no question or nothing of it fits."""
    if not sermon.reflection:
        return None
    texts, q_px = sd.fit_blocks(
        [sermon.reflection.text], width, max(room, 0.0), steps, line_height=lh
    )
    if not texts:
        return None
    return {"text": texts[0], "inferred": sermon.reflection.inferred, "font_px": q_px}


# --- design A: colour band ---------------------------------------------------

_BAND_PAD_X_EM = 1.35
_BAND_H_EM = 6.875
_BAND_PAD_EM = 0.73
_BAND_KICKER_EM = 0.78
_BAND_TITLE_STEPS_EM = (1.93, 1.67, 1.46)
_BAND_META_EM = 0.99
_BAND_BODY_GAP_EM = 1.04  # band -> first body line
_BAND_TAG_EM = 0.73
_BAND_TAG_BOX_EM = 0.94  # tag padding + border + margin below it
_BAND_SUMMARY_STEPS_EM = (1.6, 1.45, 1.3, 1.15, 1.04, 0.94, 0.85)
_BAND_SUMMARY_LH = 1.38
_BAND_POINT_STEPS_EM = (1.6, 1.45, 1.3, 1.2, 1.1, 1.0, 0.9)
_BAND_APPLY_STEPS_EM = (1.5, 1.35, 1.2, 1.1, 1.0, 0.94, 0.85, 0.78)
_BAND_LIST_LH = 1.2
_BAND_POINT_GAP = 0.4
_BAND_APPLY_GAP = 0.35
_BAND_BADGE_EM = 1.57  # number badge, ems of the list font
_BAND_BADGE_GAP_EM = 0.65
_BAND_LABEL_EM = 0.73
_BAND_LABEL_BOX_EM = 0.36  # margin below a label
_BAND_CHIP_EM = 0.94
_BAND_CHIP_X_EM = 1.67  # chip padding + border + right margin, horizontally
_BAND_CHIP_Y_EM = 0.78  # chip padding + border + bottom margin, vertically
_BAND_CHIPS_GAP_EM = 0.63
_BAND_QUESTION_STEPS_EM = (1.6, 1.45, 1.3, 1.15, 1.0, 0.9)
_BAND_QUESTION_LH = 1.25
_BAND_QUESTION_BAR_EM = 1.46  # coloured bar + its padding
_BAND_QUESTION_GAP_EM = 0.6


def _band_params(
    t: layout.Tokens, sermon: sd.Sermon | None, screen: sd.Screen
) -> dict[str, Any]:
    """Colour-band design: band header (kicker, fitted title, meta line) and
    the per-screen body, with every CSS size in ``px``."""
    b = t.base
    pad_x = _BAND_PAD_X_EM * b
    content_w = t.width - 2 * pad_x
    out: dict[str, Any] = {
        "px": {
            "pad_x": pad_x,
            "band_h": _BAND_H_EM * b,
            "band_pad": _BAND_PAD_EM * b,
            "kicker": _BAND_KICKER_EM * b,
            "title": _BAND_TITLE_STEPS_EM[0] * b,
            "meta": _BAND_META_EM * b,
            "body_top": (_BAND_H_EM + _BAND_BODY_GAP_EM) * b,
            "body_bottom": _FOOTER_ZONE_EM * b,
            "footer": _FOOTER_EM * b,
            "tag": _BAND_TAG_EM * b,
            "label": _BAND_LABEL_EM * b,
            "chip": _BAND_CHIP_EM * b,
        },
    }
    if sermon is None:
        out.update(kicker="Sermon", title="No sermon yet", meta="")
        return out

    title, title_px = sd.fit_line(
        sermon.title or "Sermon",
        content_w * _BOLD_WIDTH,
        [m * b for m in _BAND_TITLE_STEPS_EM],
    )
    meta_parts = [
        sd.format_service_date(sermon.service_date),
        sermon.series,
        sermon.speaker,
    ]
    meta = layout.truncate(
        " · ".join(p for p in meta_parts if p), content_w, _BAND_META_EM * b
    )
    out.update(kicker=sd.SCREEN_LABELS[screen], title=title, meta=meta)
    out["px"]["title"] = title_px

    body_h = t.height - (_BAND_H_EM + _BAND_BODY_GAP_EM + _FOOTER_ZONE_EM) * b
    if body_h < _MIN_BODY_EM * b:
        out["too_small"] = True
        return out

    if screen == "message":
        tag_h = (_BAND_TAG_EM * sd.LINE_HEIGHT + _BAND_TAG_BOX_EM) * b
        out.update(
            _summary(
                sermon,
                content_w,
                body_h,
                [m * b for m in _BAND_SUMMARY_STEPS_EM],
                _BAND_SUMMARY_LH,
                tag_h,
            )
        )
    elif screen in ("highlights", "apply"):
        steps_em, gap = (
            (_BAND_POINT_STEPS_EM, _BAND_POINT_GAP)
            if screen == "highlights"
            else (_BAND_APPLY_STEPS_EM, _BAND_APPLY_GAP)
        )
        steps = [m * b for m in steps_em]
        # The text column narrows by the badge and its gap; sized at the
        # largest step so the estimate stays conservative as the font shrinks.
        text_w = content_w - (_BAND_BADGE_EM + _BAND_BADGE_GAP_EM) * steps[0]
        out.update(
            _list_body(
                sermon,
                screen,
                text_w,
                body_h,
                steps,
                gap,
                _BAND_LIST_LH,
                _BAND_BADGE_EM,
            )
        )
    else:
        scriptures = sermon.scriptures[:_MAX_SCRIPTURES]
        related = sermon.related_passages[:_MAX_RELATED]
        chip_px = _BAND_CHIP_EM * b
        row_h = chip_px * sd.LINE_HEIGHT + _BAND_CHIP_Y_EM * b
        group_h = (
            _BAND_LABEL_EM * sd.LINE_HEIGHT + _BAND_LABEL_BOX_EM + _BAND_CHIPS_GAP_EM
        ) * b
        lists_h = sum(
            group_h + sd.chip_rows(g, content_w, chip_px, _BAND_CHIP_X_EM * b) * row_h
            for g in (scriptures, related)
            if g
        )
        out.update(
            scriptures=scriptures,
            related=related,
            reflection=_question(
                sermon,
                content_w - _BAND_QUESTION_BAR_EM * b,
                body_h - lists_h - _BAND_QUESTION_GAP_EM * b,
                [m * b for m in _BAND_QUESTION_STEPS_EM],
                _BAND_QUESTION_LH,
            ),
        )
    return out


# --- design B: sidebar poster -------------------------------------------------

_SB_SIDE_PCT = 23.0
_SB_SIDE_PAD_EM = 1.0
_SB_NUM_EM = 4.4
_SB_NUM_OF_EM = 1.3
_SB_NAME_EM = 1.62
_SB_SIDE_META_EM = 0.83
_SB_SIDE_DATE_EM = 0.73
_SB_PAD_L_EM = 1.25
_SB_PAD_R_EM = 1.15
_SB_PAD_T_EM = 1.15
_SB_TITLE_STEPS_EM = (1.51, 1.35, 1.2)
_SB_TITLE_LH = 1.1
_SB_TITLE_MAX_LINES = 2
_SB_RULE_W_EM = 3.75
_SB_RULE_H_EM = 0.31
_SB_RULE_TOP_EM = 0.63
_SB_RULE_BOTTOM_EM = 0.73
_SB_TAG_EM = 0.68
_SB_TAG_BOX_EM = 0.78
_SB_SUMMARY_STEPS_EM = (1.45, 1.3, 1.15, 1.04, 0.94, 0.85, 0.78)
_SB_SUMMARY_LH = 1.4
_SB_POINT_STEPS_EM = (1.45, 1.3, 1.15, 1.04, 0.94, 0.85, 0.78)
_SB_POINT_BAR_EM = 0.99  # left bar + its padding
_SB_POINT_GAP = 0.55
_SB_APPLY_STEPS_EM = (1.35, 1.2, 1.1, 1.0, 0.91, 0.85, 0.78, 0.73)
# Numeral column, ems of the list font: the CSS ``flex: 0 0 1.4em`` resolves
# against the numeral's own 1.37em font, so it is 1.4 * 1.37 list-font ems.
_SB_APPLY_NUM_SCALE = 1.37
_SB_APPLY_NUM_EM = 1.4 * _SB_APPLY_NUM_SCALE
_SB_APPLY_NUM_GAP_EM = 0.63
_SB_APPLY_GAP = 0.46
_SB_LIST_LH = 1.25
_SB_LABEL_EM = 0.68
_SB_LABEL_BOX_EM = 0.26
_SB_COL_EM = 0.94
_SB_COL_LH = 1.38
_SB_COLS_GAP_EM = 0.52
_SB_QUESTION_STEPS_EM = (1.45, 1.3, 1.15, 1.04, 0.94, 0.85)
_SB_QUESTION_LH = 1.25
_SB_QUESTION_RULE_EM = 0.68  # top rule + its padding
_SB_QUESTION_GAP_EM = 1.1

_SB_NAME_LINES: dict[sd.Screen, tuple[str, str]] = {
    "message": ("The", "Message"),
    "highlights": ("Key", "Points"),
    "apply": ("Apply", "It"),
    "reflect": ("Read &", "Reflect"),
}


def _sidebar_title(title: str, width: float, steps: list[float]) -> tuple[str, float]:
    """Largest step at which *title* wraps to at most two lines, else the
    smallest step word-truncated to two lines."""
    for font_px in steps:
        if sd.estimate_lines(title, width, font_px) <= _SB_TITLE_MAX_LINES:
            return title, font_px
    font_px = steps[-1]
    texts, _ = sd.fit_blocks(
        [title],
        width,
        _SB_TITLE_MAX_LINES * _SB_TITLE_LH * font_px,
        [font_px],
        line_height=_SB_TITLE_LH,
    )
    return (texts[0] if texts else ""), font_px


def _sidebar_params(
    t: layout.Tokens, sermon: sd.Sermon | None, screen: sd.Screen
) -> dict[str, Any]:
    """Sidebar-poster design: colour column (number, screen name, date /
    series / speaker), a title of up to two lines whose height sets the body
    top, and the per-screen body, with every CSS size in ``px``."""
    b = t.base
    side_w = t.width * _SB_SIDE_PCT / 100
    side_pad = _SB_SIDE_PAD_EM * b
    side_inner = side_w - 2 * side_pad
    pad_l, pad_r, pad_t = _SB_PAD_L_EM * b, _SB_PAD_R_EM * b, _SB_PAD_T_EM * b
    sec_w = t.width - side_w - pad_l - pad_r
    out: dict[str, Any] = {
        "px": {
            "side_w": side_w,
            "side_pad": side_pad,
            "num": _SB_NUM_EM * b,
            "num_of": _SB_NUM_OF_EM * b,
            "name": _SB_NAME_EM * b,
            "side_meta": _SB_SIDE_META_EM * b,
            "side_date": _SB_SIDE_DATE_EM * b,
            "pad_l": pad_l,
            "pad_r": pad_r,
            "pad_t": pad_t,
            "title": _SB_TITLE_STEPS_EM[0] * b,
            "rule_w": _SB_RULE_W_EM * b,
            "rule_h": _SB_RULE_H_EM * b,
            "rule_top": _SB_RULE_TOP_EM * b,
            "rule_bottom": _SB_RULE_BOTTOM_EM * b,
            "body_top": 0.0,
            "body_bottom": _FOOTER_ZONE_EM * b,
            "footer": _FOOTER_EM * b,
            "tag": _SB_TAG_EM * b,
            "label": _SB_LABEL_EM * b,
            "col": _SB_COL_EM * b,
        },
        "name_lines": _SB_NAME_LINES[screen],
        "side_meta": [],
    }
    if sermon is None:
        out.update(name_lines=("Sermon", ""), title="No sermon yet")
        return out

    steps = [m * b for m in _SB_TITLE_STEPS_EM]
    title, title_px = _sidebar_title(
        sermon.title or "Sermon", sec_w * _BOLD_WIDTH, steps
    )
    title_lines = max(1, sd.estimate_lines(title, sec_w * _BOLD_WIDTH, title_px))
    body_top = (
        pad_t
        + title_lines * title_px * _SB_TITLE_LH
        + (_SB_RULE_TOP_EM + _SB_RULE_H_EM + _SB_RULE_BOTTOM_EM) * b
    )
    out["px"].update(title=title_px, body_top=body_top)
    date = sd.format_service_date(sermon.service_date).upper()
    out["title"] = title
    out["side_meta"] = [
        {"text": layout.truncate(text, 2 * side_inner, size * b), "date": is_date}
        for text, size, is_date in (
            (date, _SB_SIDE_DATE_EM, True),
            (sermon.series, _SB_SIDE_META_EM, False),
            (sermon.speaker, _SB_SIDE_META_EM, False),
        )
        if text
    ]

    body_h = t.height - body_top - _FOOTER_ZONE_EM * b
    if body_h < _MIN_BODY_EM * b or side_inner < 4 * b:
        out["too_small"] = True
        return out

    if screen == "message":
        tag_h = (_SB_TAG_EM * sd.LINE_HEIGHT + _SB_TAG_BOX_EM) * b
        out.update(
            _summary(
                sermon,
                sec_w,
                body_h,
                [m * b for m in _SB_SUMMARY_STEPS_EM],
                _SB_SUMMARY_LH,
                tag_h,
            )
        )
    elif screen == "highlights":
        out.update(
            _list_body(
                sermon,
                screen,
                sec_w - _SB_POINT_BAR_EM * b,
                body_h,
                [m * b for m in _SB_POINT_STEPS_EM],
                _SB_POINT_GAP,
                _SB_LIST_LH,
                0.0,
            )
        )
    elif screen == "apply":
        steps = [m * b for m in _SB_APPLY_STEPS_EM]
        text_w = sec_w - (_SB_APPLY_NUM_EM + _SB_APPLY_NUM_GAP_EM) * steps[0]
        out.update(
            _list_body(
                sermon,
                screen,
                text_w,
                body_h,
                steps,
                _SB_APPLY_GAP,
                _SB_LIST_LH,
                # The numeral (line-height 1 at 1.37em) outgrows one text line.
                _SB_APPLY_NUM_SCALE,
            )
        )
    else:
        scriptures = sermon.scriptures[:_MAX_SCRIPTURES]
        related = sermon.related_passages[:_MAX_RELATED]
        row_h = _SB_COL_EM * _SB_COL_LH * b
        group_h = (
            _SB_LABEL_EM * sd.LINE_HEIGHT + _SB_LABEL_BOX_EM + _SB_COLS_GAP_EM
        ) * b
        lists_h = sum(
            group_h + math.ceil(len(g) / 2) * row_h for g in (scriptures, related) if g
        )
        out.update(
            scriptures=scriptures,
            related=related,
            reflection=_question(
                sermon,
                sec_w,
                body_h - lists_h - (_SB_QUESTION_GAP_EM + _SB_QUESTION_RULE_EM) * b,
                [m * b for m in _SB_QUESTION_STEPS_EM],
                _SB_QUESTION_LH,
            ),
        )
    return out
