"""Row parsing, filtering, sorting and section-sizing for `trips` (SPEC §8.1).

Pure functions, no I/O — unit-testable without Chromium or a Sheets fetch.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import date

from homeboard import layout

MIN_BOOKED = 1
MAX_BOOKED = 2
MIN_IDEAS = 2
MAX_IDEAS = 4

CARD_PITCH_EM = 4.7
IDEA_PITCH_EM = 2.2

# Vertical space (in em of `base`) reserved for the "Booked"/"On the list"
# section labels and the gap between the two sections. Not given explicitly
# in SPEC §8.1 (unlike the card/idea pitches, which are) — estimated from
# the mockup's pixel positions at 800x480 and flagged, like
# home_maintenance's row-height assumption, as pending the physical-panel
# check (SPEC §9 step 2).
BOOKED_LABEL_BAND_EM = 0.8
SECTION_GAP_EM = 2.3

_TRUTHY = {"true", "1", "yes", "y"}


def parse_bool(raw: object) -> bool:
    return str(raw).strip().lower() in _TRUTHY


def parse_date(raw: object) -> date | None:
    if raw in (None, ""):
        return None
    try:
        return date.fromisoformat(str(raw).strip())
    except ValueError:
        return None


@dataclass(frozen=True)
class TripRow:
    name: str
    status: str  # "booked" | "idea"
    start: date | None
    end: date | None
    target_window: str
    next_action: str
    blocking: bool


def parse_trip_row(raw: dict[str, str]) -> TripRow:
    return TripRow(
        name=str(raw.get("name", "")).strip(),
        status=str(raw.get("status", "")).strip().lower(),
        start=parse_date(raw.get("start")),
        end=parse_date(raw.get("end")),
        target_window=str(raw.get("target_window", "")).strip(),
        next_action=str(raw.get("next_action", "")).strip(),
        blocking=parse_bool(raw.get("blocking")),
    )


@dataclass(frozen=True)
class BookedTrip:
    name: str
    start: date
    end: date
    days_until: int
    next_action: str
    blocking: bool


@dataclass(frozen=True)
class IdeaTrip:
    name: str
    target_window: str


def select_booked(rows: list[TripRow], today: date) -> list[BookedTrip]:
    """Booked trips sorted by start date ascending. A trip is dropped the
    day after it ends (i.e. kept while ``end >= today``)."""
    out: list[BookedTrip] = []
    for row in rows:
        if row.status != "booked" or row.start is None or row.end is None:
            continue
        if row.end < today:
            continue
        days_until = max(0, (row.start - today).days)
        out.append(
            BookedTrip(
                name=row.name,
                start=row.start,
                end=row.end,
                days_until=days_until,
                next_action=row.next_action,
                blocking=row.blocking,
            )
        )
    out.sort(key=lambda t: t.start)
    return out


def select_ideas(rows: list[TripRow]) -> list[IdeaTrip]:
    return [
        IdeaTrip(name=row.name, target_window=row.target_window)
        for row in rows
        if row.status == "idea"
    ]


def idea_label_top_em(visible_booked: int) -> float:
    """Em-offset (from the body top) of the "On the list" section label:
    past the booked section's own label band, its cards, and the
    inter-section gap."""
    return BOOKED_LABEL_BAND_EM + visible_booked * CARD_PITCH_EM + SECTION_GAP_EM


def idea_start_em(visible_booked: int) -> float:
    """Em-offset (from the body top) where idea *rows* begin: past the
    "On the list" label's own band too.

    This is the single source of truth for that offset — both
    ``visible_counts()`` (capacity) and the plugin's render geometry call
    this, so the two can't drift apart the way they did before (the render
    side added a second label-band's worth of space that the capacity math
    never reserved, letting idea rows overflow past body_height on some
    panel sizes)."""
    return idea_label_top_em(visible_booked) + BOOKED_LABEL_BAND_EM


def visible_counts(
    t: layout.Tokens, num_booked: int, num_ideas: int
) -> tuple[int, int]:
    """How many booked cards and idea rows actually fit, per SPEC §3.4's
    "computed, never fixed" row-count rule applied to a screen with two
    stacked sections sharing one body region.

    Booked gets first claim on space (it's the "only actionable thing on
    the screen" per SPEC §8.1), then ideas get whatever's left.
    """
    booked_cap = _clamped_row_count(
        t.body_height_em - BOOKED_LABEL_BAND_EM, CARD_PITCH_EM, MIN_BOOKED, MAX_BOOKED
    )
    visible_booked = min(num_booked, booked_cap)

    remaining_em = t.body_height_em - idea_start_em(visible_booked)
    idea_cap = _clamped_row_count(remaining_em, IDEA_PITCH_EM, MIN_IDEAS, MAX_IDEAS)
    visible_ideas = min(num_ideas, idea_cap)

    return visible_booked, visible_ideas


def fits_screen(t: layout.Tokens) -> bool:
    """Cheap early-out: whether the panel can fit even the smallest useful
    render (one booked card) at all, before bothering to parse rows. Not
    sufficient on its own — see ``screen_fits()`` for the precise check
    against the actual computed row counts, since ``visible_counts()``'s
    ``MIN_IDEAS``/``MIN_BOOKED`` floors can still be forced past what a
    given panel has room for (SPEC §3.5's "too small" fallback)."""
    minimum_em = BOOKED_LABEL_BAND_EM + CARD_PITCH_EM
    return t.body_height_em >= minimum_em


def screen_fits(t: layout.Tokens, visible_booked: int, visible_ideas: int) -> bool:
    """Whether the *actual* computed row counts (from ``visible_counts()``)
    fit the body region.

    ``visible_counts()`` always returns at least ``MIN_IDEAS`` idea rows
    when there's idea data, even on a panel too small to actually hold
    them — the row-count formula's job is picking a count, not vetoing the
    render. This is the check that catches that case and should gate
    falling back to the SPEC §3.5 "panel too small" message instead of
    silently overflowing past the footer.
    """
    idea_bottom_em = idea_start_em(visible_booked) + visible_ideas * IDEA_PITCH_EM
    return idea_bottom_em <= t.body_height_em


def _clamped_row_count(
    available_em: float, pitch_em: float, min_rows: int, max_rows: int
) -> int:
    raw = math.floor(available_em / pitch_em) if pitch_em > 0 else 0
    return int(layout.clamp(raw, min_rows, max_rows))
