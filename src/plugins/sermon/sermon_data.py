"""Pure parsing, screen selection and text-fit logic for the sermon plugin.

No I/O and no rendering — everything here is deterministic so it can be
unit-tested without a browser. Layout rules follow boardbot's hand-off for
``GET /sermons/latest``: three body screens under one shared header, text
shrunk a font step before it is truncated, never cut mid-word.
"""

from __future__ import annotations

import math
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from datetime import date
from typing import Any, Literal

from homeboard.layout import ADVANCE_RATIO

Screen = Literal["message", "apply", "reflect"]
SCREENS: tuple[Screen, ...] = ("message", "apply", "reflect")
SCREEN_SETTING_VALUES = ("auto", *SCREENS)

_SECONDS_PER_SCREEN = 3600

_SERVICE_NOTE_LABELS = {
    "communion": "Communion Sunday",
    "baptism": "Baptism",
}

INFERRED_MARK = "*"
INFERRED_FOOTNOTE = "* drawn from the message"

# Line height as a multiple of the font size, and the gap between list
# items as a fraction of the font size.
LINE_HEIGHT = 1.3
ITEM_GAP = 0.35

_ELLIPSIS = "…"


@dataclass(frozen=True)
class MarkedText:
    """A line of text plus whether boardbot's model inferred it (vs. the
    pastor stating it)."""

    text: str
    inferred: bool = False

    @property
    def display(self) -> str:
        return f"{self.text}{INFERRED_MARK}" if self.inferred else self.text


@dataclass(frozen=True)
class Sermon:
    title: str
    service_date: date | None
    speaker: str
    series: str
    summary: str
    highlights: list[str] = field(default_factory=list)
    takeaways: list[MarkedText] = field(default_factory=list)
    scriptures: list[str] = field(default_factory=list)
    related_passages: list[str] = field(default_factory=list)
    reflection: MarkedText | None = None
    service_notes: list[str] = field(default_factory=list)


def _clean_str(value: Any) -> str:
    return " ".join(value.split()) if isinstance(value, str) else ""


def _clean_list(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    cleaned = (_clean_str(v) for v in value)
    return [v for v in cleaned if v]


def _marked(value: Any) -> MarkedText | None:
    if not isinstance(value, Mapping):
        return None
    text = _clean_str(value.get("text"))
    if not text:
        return None
    return MarkedText(text=text, inferred=value.get("source") == "inferred")


def _parse_date(value: Any) -> date | None:
    if not isinstance(value, str):
        return None
    try:
        return date.fromisoformat(value.strip()[:10])
    except ValueError:
        return None


def parse_sermon(raw: Mapping[str, Any]) -> Sermon:
    """Coerce boardbot's ``/sermons/latest`` object into a ``Sermon``.

    Tolerant by design: unset fields are omitted by boardbot, and a bad
    field must never take the whole screen down.
    """
    takeaways_raw = raw.get("takeaways")
    takeaways = [
        m
        for m in (
            _marked(t)
            for t in (takeaways_raw if isinstance(takeaways_raw, list) else [])
        )
        if m is not None
    ]
    return Sermon(
        title=_clean_str(raw.get("title")),
        service_date=_parse_date(raw.get("service_date")),
        speaker=_clean_str(raw.get("speaker")),
        series=_clean_str(raw.get("series")),
        summary=_clean_str(raw.get("summary")),
        highlights=_clean_list(raw.get("highlights")),
        takeaways=takeaways,
        scriptures=_clean_list(raw.get("scriptures")),
        related_passages=_clean_list(raw.get("related_passages")),
        reflection=_marked(raw.get("reflection_question")),
        service_notes=_clean_list(raw.get("service_notes")),
    )


def format_service_date(d: date | None) -> str:
    """``2026-10-04`` -> ``Sunday, Oct 4`` (the Sunday itself, never the
    upload time)."""
    if d is None:
        return ""
    return f"{d.strftime('%A, %b')} {d.day}"


def service_note_labels(notes: Sequence[str]) -> list[str]:
    """Human labels for known ``service_notes``; unknown values are skipped."""
    return [
        _SERVICE_NOTE_LABELS[n.lower()]
        for n in notes
        if n.lower() in _SERVICE_NOTE_LABELS
    ]


def screen_for_clock(now_epoch: float) -> Screen:
    """Hourly rotation derived from the clock so no state is stored."""
    return SCREENS[int(now_epoch // _SECONDS_PER_SCREEN) % len(SCREENS)]


def resolve_screen(setting: Any, now_epoch: float) -> Screen:
    """The ``screen`` setting: a fixed screen, or ``auto`` (clock rotation)."""
    if isinstance(setting, str) and setting in SCREENS:
        return setting
    return screen_for_clock(now_epoch)


def has_inferred(sermon: Sermon, screen: Screen) -> bool:
    """Whether *screen* shows any inferred text (drives the footnote)."""
    if screen == "apply":
        return any(t.inferred for t in sermon.takeaways)
    if screen == "reflect":
        return bool(sermon.reflection and sermon.reflection.inferred)
    return False


# --- text fitting --------------------------------------------------------


def estimate_lines(text: str, width_px: float, font_px: float) -> int:
    """Rough wrapped line count using the shared average glyph advance."""
    if not text:
        return 0
    chars_per_line = max(1, int(width_px / (font_px * ADVANCE_RATIO)))
    lines = 1
    used = 0
    for word in text.split():
        need = len(word) + (1 if used else 0)
        if used and used + need > chars_per_line:
            lines += 1
            used = len(word)
        else:
            used += need
        # A single word longer than a line wraps by characters.
        if used > chars_per_line:
            extra = math.ceil(used / chars_per_line) - 1
            lines += extra
            used = used % chars_per_line or chars_per_line
    return lines


def block_height(
    texts: Sequence[str], width_px: float, font_px: float, gap: float = ITEM_GAP
) -> float:
    """Estimated rendered height of *texts* stacked as separate blocks."""
    if not texts:
        return 0.0
    lines = sum(estimate_lines(t, width_px, font_px) for t in texts)
    return lines * font_px * LINE_HEIGHT + (len(texts) - 1) * gap * font_px


def truncate_words(text: str, max_chars: int) -> str:
    """Cut *text* to at most *max_chars* on a word boundary, adding an
    ellipsis. Never splits a word (a single over-long word is hard-cut)."""
    if len(text) <= max_chars:
        return text
    budget = max(1, max_chars - len(_ELLIPSIS))
    cut = text[:budget]
    if text[budget : budget + 1] != " " and " " in cut:
        cut = cut.rsplit(" ", 1)[0]
    return cut.rstrip(" ,;:.-") + _ELLIPSIS


def fit_blocks(
    texts: Sequence[str],
    width_px: float,
    height_px: float,
    font_steps: Sequence[float],
) -> tuple[list[str], float]:
    """Pick the largest font in *font_steps* (descending) at which *texts*
    fit, shrinking before truncating. At the smallest font, if it still
    overflows, the longest block is word-truncated repeatedly until it fits.
    Returns ``(texts, font_px)``."""
    blocks = list(texts)
    for font_px in font_steps:
        if block_height(blocks, width_px, font_px) <= height_px:
            return blocks, font_px
    font_px = font_steps[-1]
    for _ in range(1000):
        if block_height(blocks, width_px, font_px) <= height_px or not blocks:
            break
        idx = max(range(len(blocks)), key=lambda i: len(blocks[i]))
        if len(blocks[idx]) <= 1:
            blocks.pop()
            continue
        shorter = truncate_words(blocks[idx], int(len(blocks[idx]) * 0.85))
        # Guard against truncate_words returning something no shorter.
        blocks[idx] = shorter if len(shorter) < len(blocks[idx]) else blocks[idx][:-2]
    return blocks, font_px
