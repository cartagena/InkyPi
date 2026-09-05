"""Size, priority, due-date, and age tag rendering shared by every screen
(SPEC §4.3)."""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from datetime import date

from homeboard.palette import Role


@dataclass(frozen=True)
class SizeTag:
    """A rendered size chip: label text plus the fixed `available` outline
    treatment every size tag uses (SPEC §4.3)."""

    label: str
    role: Role = Role.AVAILABLE
    solid: bool = False


# Bucket boundaries (inclusive upper edge) -> display label, in ascending
# order. boardbot (github.com/cartagena/boardbot) is the only producer of
# effort_days — either its Claude classifier extracts a day estimate from a
# freeform message, or its structured "project <text> [S|M|L]" shorthand
# maps directly to 1/2/4 days. These buckets intentionally match that
# shorthand's own values so a project tagged "[M]" round-trips back to a
# stable label rather than drifting if either side's thresholds change
# independently.
_EFFORT_BUCKETS: tuple[tuple[int, str], ...] = (
    (1, "One day"),
    (3, "A few days"),
)
_EFFORT_LABEL_OVERFLOW = "Multiple days"


def effort_tag(effort_days: int | None) -> SizeTag | None:
    """Bucket a raw day-count into a size chip, per SPEC §4.3: "An item
    with no size tag — never a placeholder." *effort_days* of ``None`` or
    non-positive (shouldn't happen — boardbot validates before sending —
    but never trust an upstream int blindly) renders no chip."""
    if effort_days is None or effort_days < 1:
        return None
    for upper_bound, label in _EFFORT_BUCKETS:
        if effort_days <= upper_bound:
            return SizeTag(label=label)
    return SizeTag(label=_EFFORT_LABEL_OVERFLOW)


@dataclass(frozen=True)
class PriorityTag:
    """A rendered priority chip: label text plus the role/fill-treatment
    for the sender-supplied urgency level (SPEC §4.3-style ladder, reusing
    the same visual vocabulary as ``AgeTag``)."""

    label: str
    role: Role
    solid: bool


def priority_tag(priority: str | None) -> PriorityTag | None:
    """Compute the priority chip for a raw ``"high"``/``"medium"``/
    ``"low"`` value (or ``None``), matched case-insensitively — only
    Claude's classifier on the boardbot side sets this (see
    ``classifier.py``'s tool schema), never the structured fast path.
    ``"low"`` and anything unrecognised render no chip, matching the "no
    placeholder" convention: an item with no stated urgency is the
    default, not a fourth visible tier.

    Labels are bare ("High"/"Medium") rather than "High priority" — a row
    can carry this chip alongside size/age/due chips too, and the ALERT/
    WARN color already reads as urgency in that context; the word
    "priority" would be the single biggest consumer of a crowded row's
    limited width for no added clarity."""
    normalized = priority.strip().lower() if isinstance(priority, str) else priority
    if normalized == "high":
        return PriorityTag(label="High", role=Role.ALERT, solid=True)
    if normalized == "medium":
        return PriorityTag(label="Medium", role=Role.WARN, solid=True)
    return None


@dataclass(frozen=True)
class DueTag:
    """A rendered due-date chip: label text plus the role/fill-treatment
    for how close *due_date* is (SPEC §4.3-style ladder, reusing the same
    visual vocabulary as ``AgeTag``)."""

    label: str
    role: Role
    solid: bool


# UNVERIFIED — no explicit "how many days counts as due soon" spec exists
# for this new field (SPEC predates due_date entirely); picked to mirror
# age_tag's three-tier shape rather than invent a fourth. Adjust once this
# has been seen on a real board for a few weeks.
_DUE_SOON_DAYS = 1


def due_tag(due_date: date | None, today: date) -> DueTag | None:
    """Compute the due-date chip, per the shared ladder:

    - no ``due_date`` — omitted entirely (``None``)
    - overdue — `alert` solid, "Overdue Nd"
    - due today/tomorrow — `warn` solid, "Today"/"Tomorrow"
    - further out — `ink` outline, "Due Nd"

    "Overdue"/"Due" prefixes stay on the numeric-day forms — a row can
    also carry ``AgeTag``, whose label is a bare "Nd", so an unprefixed
    due-date "Nd" would be ambiguous about which date it's counting from.
    "Today"/"Tomorrow" aren't numeric, so they don't need the prefix to
    stay unambiguous, and dropping it saves width on a potentially
    crowded row.
    """
    if due_date is None:
        return None
    days_until = (due_date - today).days
    if days_until < 0:
        return DueTag(label=f"Overdue {abs(days_until)}d", role=Role.ALERT, solid=True)
    if days_until == 0:
        return DueTag(label="Today", role=Role.WARN, solid=True)
    if days_until <= _DUE_SOON_DAYS:
        return DueTag(label="Tomorrow", role=Role.WARN, solid=True)
    return DueTag(label=f"Due {days_until}d", role=Role.INK, solid=False)


@dataclass(frozen=True)
class AgeTag:
    """A rendered age chip: label text plus the role/fill-treatment for the
    threshold bucket *days* falls into (SPEC §4.3)."""

    label: str
    role: Role
    solid: bool


def age_tag(
    days: int, age_show_days: int, age_warn_days: int, age_alert_days: int
) -> AgeTag | None:
    """Compute the age chip for an item *days* old, per the shared ladder:

    - below ``age_show_days`` — omitted entirely (``None``)
    - up to ``age_warn_days`` — `ink` outline
    - up to ``age_alert_days`` — `warn` solid
    - beyond — `alert` solid
    """
    if days < age_show_days:
        return None
    if days < age_warn_days:
        return AgeTag(label=f"{days}d", role=Role.INK, solid=False)
    if days < age_alert_days:
        return AgeTag(label=f"{days}d", role=Role.WARN, solid=True)
    return AgeTag(label=f"{days}d", role=Role.ALERT, solid=True)


def item_key(text: str) -> str:
    """A stable, opaque key for an item's normalised text, used by the
    board plugin's item-age ledger (SPEC §4.5) — hashed so filesystem/dict
    keys never carry raw user-controlled note text."""
    normalised = " ".join(text.strip().lower().split())
    return hashlib.sha256(normalised.encode("utf-8")).hexdigest()[:16]
