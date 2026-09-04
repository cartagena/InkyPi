"""Parsing, item-age ledger, selection/sorting and section-sizing for
`board` (SPEC §7). Pure functions, no I/O beyond the ledger dict passed in
and out — unit-testable without Chromium or a live Keep fetch.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass
from datetime import date, timedelta
from typing import Any

from homeboard import layout, tags
from plugins.board import sampling

# --- §7.3 layout constants (em of `base`) -------------------------------

IN_FLIGHT_LABEL_BAND_EM = 0.8
IN_FLIGHT_PITCH_EM = 3.4
MIN_IN_FLIGHT = 0
MAX_IN_FLIGHT = 2

# Gap between the in-flight section and the "From the backlog" label.
# UNVERIFIED — SPEC §7.3 doesn't give this element an explicit em value
# (unlike the pitches, which are explicit); estimated pending the
# physical-panel check (SPEC §9 step 2), same as trips' SECTION_GAP_EM.
BACKLOG_SECTION_GAP_EM = 1.0
BACKLOG_LABEL_BAND_EM = 0.8
BACKLOG_PITCH_EM = 3.1
MIN_BACKLOG = 2
MAX_BACKLOG = 4

TODO_PITCH_EM = 2.6
MIN_TODO = 4
MAX_TODO = 9
# Space reserved below the last to-do row for the "Cleared" line. UNVERIFIED
# for the same reason as BACKLOG_SECTION_GAP_EM above.
CLEARED_LINE_BAND_EM = 1.4

_CLEARED_WINDOW_DAYS = 7


# --- §7.4 parsing --------------------------------------------------------

_NOTE_SEP_RE = re.compile(r"\s+—\s+")
_STARTED_RE = re.compile(r"^started\s+(\d{4}-\d{2}-\d{2})$", re.IGNORECASE)


def _split_note(text: str) -> tuple[str, str]:
    """Split a trailing `` — <note>`` (em dash) suffix off *text*."""
    parts = _NOTE_SEP_RE.split(text, maxsplit=1)
    if len(parts) == 2:
        return parts[0].rstrip(), parts[1].strip()
    return text, ""


def render_project_note(note_raw: str, today: date) -> str:
    """`` — started 2026-08-22`` renders as ``Started N d ago``; anything
    else renders verbatim (SPEC §7.4)."""
    if not note_raw:
        return ""
    match = _STARTED_RE.match(note_raw)
    if not match:
        return note_raw
    try:
        started = date.fromisoformat(match.group(1))
    except ValueError:
        return note_raw
    days = max(0, (today - started).days)
    return f"Started {days} d ago"


@dataclass(frozen=True)
class ProjectItem:
    key: str
    title: str
    size_tag: tags.SizeTag | None
    note_text: str  # rendered; only meaningful for in-flight items
    in_flight: bool
    first_seen: date


@dataclass(frozen=True)
class TodoItem:
    key: str
    title: str
    first_seen: date


def parse_project_item(
    raw_text: str, in_flight_prefix: str, first_seen: date, today: date
) -> ProjectItem:
    """Parse one open Projects-note line (SPEC §7.4): an optional
    ``in_flight_prefix``, an optional trailing size bracket, and — for
    in-flight items only — an optional trailing `` — <note>``."""
    text = raw_text
    in_flight = False
    if in_flight_prefix and text.startswith(in_flight_prefix):
        in_flight = True
        text = text[len(in_flight_prefix) :].lstrip()

    title_and_bracket, note_raw = _split_note(text)
    title, size_tag = tags.parse_size_tag(title_and_bracket)
    note_text = render_project_note(note_raw, today) if in_flight else ""

    return ProjectItem(
        key=ledger_key("projects", raw_text),
        title=title,
        size_tag=size_tag,
        note_text=note_text,
        in_flight=in_flight,
        first_seen=first_seen,
    )


def parse_todo_item(raw_text: str, first_seen: date) -> TodoItem:
    """Parse one open To-do-note line: a trailing bracket is ignored here
    (SPEC §7.4 — "a trailing bracket is ignored")."""
    title, _ = tags.parse_size_tag(raw_text)
    return TodoItem(
        key=ledger_key("todo", raw_text), title=title, first_seen=first_seen
    )


# --- §4.5 item-age ledger --------------------------------------------------


def ledger_key(namespace: str, raw_text: str) -> str:
    """A stable ledger key for one Keep item, namespaced so identical text
    in the Projects and To-do notes can never collide."""
    return f"{namespace}:{tags.item_key(raw_text)}"


def update_ledger(
    ledger: dict[str, Any],
    current_items: list[tuple[str, bool]],
    today: date,
) -> dict[str, Any]:
    """Advance the ledger given *current_items* — ``(key, checked)`` for
    every item currently in a note, open or checked (SPEC §4.5: `gkeepapi`
    may not expose reliable per-item creation timestamps, so this ledger,
    not the Keep API, is the source of truth for `first_seen`).

    - A new key is recorded with ``first_seen=today`` and
      ``completed_at=today`` if already checked, else ``None``.
    - An existing key newly observed checked gets ``completed_at=today``.
    - An existing key newly observed unchecked (reopened) has
      ``completed_at`` cleared back to ``None``.
    - A key that has vanished from the note entirely (Keep doesn't retain
      deleted lines, so there's no way to distinguish "checked then
      removed" from "deleted outright") is treated as cleared today, if it
      wasn't already marked completed — needed for SPEC §7.2's
      "N cleared this week" freshness signal to have *any* removal path.
    """
    updated = dict(ledger)
    current_keys = {key for key, _ in current_items}

    for key, checked in current_items:
        entry = updated.get(key)
        if entry is None:
            updated[key] = {
                "first_seen": today.isoformat(),
                "completed_at": today.isoformat() if checked else None,
            }
            continue
        was_completed = entry.get("completed_at") is not None
        if checked and not was_completed:
            updated[key] = {**entry, "completed_at": today.isoformat()}
        elif not checked and was_completed:
            updated[key] = {**entry, "completed_at": None}

    for key in list(updated):
        if key not in current_keys and updated[key].get("completed_at") is None:
            updated[key] = {**updated[key], "completed_at": today.isoformat()}

    return updated


def prune_ledger(
    ledger: dict[str, Any], today: date, max_completed_age_days: int = 60
) -> dict[str, Any]:
    """Drop ledger entries completed more than *max_completed_age_days* ago
    so the file doesn't grow unboundedly for a busy checklist. Open entries
    (``completed_at`` is ``None``) are never pruned."""
    cutoff = today - timedelta(days=max_completed_age_days)
    pruned = {}
    for key, entry in ledger.items():
        completed_raw = entry.get("completed_at")
        if completed_raw and date.fromisoformat(completed_raw) < cutoff:
            continue
        pruned[key] = entry
    return pruned


def first_seen_of(ledger: dict[str, Any], key: str, today: date) -> date:
    """The ledger's ``first_seen`` for *key*, or *today* if absent (should
    not happen for a key that was just passed through ``update_ledger``,
    but keeps callers total)."""
    entry = ledger.get(key)
    if entry is None:
        return today
    return date.fromisoformat(entry["first_seen"])


def days_since(first_seen: date, today: date) -> int:
    return max(0, (today - first_seen).days)


def cleared_this_week(ledger: dict[str, Any], today: date) -> int:
    """Count of ledger entries completed within the last 7 days (SPEC
    §7.2's "N cleared this week" — a rolling 7-day window, not a
    calendar-week boundary, since neither is specified)."""
    window_start = today - timedelta(days=_CLEARED_WINDOW_DAYS - 1)
    count = 0
    for entry in ledger.values():
        completed_raw = entry.get("completed_at")
        if not completed_raw:
            continue
        completed = date.fromisoformat(completed_raw)
        if window_start <= completed <= today:
            count += 1
    return count


# --- §7.5 selection and sorting -------------------------------------------


def select_in_flight(
    in_flight_items: list[ProjectItem], max_in_flight: int
) -> tuple[list[ProjectItem], int]:
    """Up to *max_in_flight* items. If more are marked in-flight, show the
    oldest by ``first_seen`` instead of note order, and report the overflow
    count for the "+N" header suffix (SPEC §7.5)."""
    if len(in_flight_items) <= max_in_flight:
        return in_flight_items, 0
    oldest_first = sorted(in_flight_items, key=lambda item: item.first_seen)
    overflow = len(in_flight_items) - max_in_flight
    return oldest_first[:max_in_flight], overflow


def select_backlog(
    backlog_items: list[ProjectItem],
    row_count: int,
    today: date,
    seed_key: str,
) -> list[ProjectItem]:
    """Fill up to *row_count* backlog rows, weighted by days since
    first-seen so long-ignored projects surface more often (SPEC §7.5),
    deterministically for the day via ``sampling.seeded_rng``."""
    if len(backlog_items) <= row_count:
        return backlog_items
    rng = sampling.seeded_rng(today, seed_key)
    return sampling.weighted_sample_without_replacement(
        rng,
        backlog_items,
        weights=lambda item: days_since(item.first_seen, today) + 1,
        k=row_count,
    )


def select_todo(todo_items: list[TodoItem], row_count: int) -> list[TodoItem]:
    """All open items sorted by ``first_seen`` ascending, truncated to
    *row_count* (SPEC §7.5)."""
    ordered = sorted(todo_items, key=lambda item: item.first_seen)
    return ordered[:row_count]


# --- §7.3 section geometry --------------------------------------------------


def _clamped_row_count(
    available_em: float, pitch_em: float, min_rows: int, max_rows: int
) -> int:
    raw = math.floor(available_em / pitch_em) if pitch_em > 0 else 0
    return int(layout.clamp(raw, min_rows, max_rows))


def in_flight_capacity(body_height_em: float) -> int:
    available_em = body_height_em - IN_FLIGHT_LABEL_BAND_EM
    return _clamped_row_count(
        available_em, IN_FLIGHT_PITCH_EM, MIN_IN_FLIGHT, MAX_IN_FLIGHT
    )


def backlog_label_top_em(visible_in_flight: int) -> float:
    """Em-offset (from the column top) of the "From the backlog" label —
    0 if the in-flight section is collapsed (SPEC §7.8: "No in-flight
    items: collapse the section and give the backlog its rows"), else past
    the in-flight label band, its cards, and the inter-section gap. This is
    the single source of truth both capacity and render geometry call, so
    the two can't drift apart the way trips' idea-section offset once did
    (see trips_data.idea_start_em's docstring for that history)."""
    if visible_in_flight == 0:
        return 0.0
    return (
        IN_FLIGHT_LABEL_BAND_EM
        + visible_in_flight * IN_FLIGHT_PITCH_EM
        + BACKLOG_SECTION_GAP_EM
    )


def backlog_start_em(visible_in_flight: int) -> float:
    """Em-offset (from the column top) where backlog *rows* begin: past
    the "From the backlog" label's own band, which always renders (even
    when the in-flight section above it is collapsed — only the "In
    flight" section itself collapses per SPEC §7.8, not this one)."""
    return backlog_label_top_em(visible_in_flight) + BACKLOG_LABEL_BAND_EM


def backlog_capacity(body_height_em: float, visible_in_flight: int) -> int:
    available_em = body_height_em - backlog_start_em(visible_in_flight)
    return _clamped_row_count(available_em, BACKLOG_PITCH_EM, MIN_BACKLOG, MAX_BACKLOG)


def projects_column_fits(
    body_height_em: float, visible_in_flight: int, visible_backlog: int
) -> bool:
    """Whether the *actual* computed row counts fit the column's body
    region — ``MIN_BACKLOG``'s floor can force more backlog rows than a
    small panel has room for even after the in-flight section is sized
    correctly, the same failure mode trips_data.screen_fits() guards
    against."""
    bottom_em = backlog_start_em(visible_in_flight) + visible_backlog * BACKLOG_PITCH_EM
    return bottom_em <= body_height_em


def todo_capacity(body_height_em: float) -> int:
    available_em = body_height_em - CLEARED_LINE_BAND_EM
    return _clamped_row_count(available_em, TODO_PITCH_EM, MIN_TODO, MAX_TODO)


def todo_column_fits(body_height_em: float, visible_todo: int) -> bool:
    bottom_em = visible_todo * TODO_PITCH_EM + CLEARED_LINE_BAND_EM
    return bottom_em <= body_height_em
