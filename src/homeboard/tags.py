"""Size and age tag parsing/rendering shared by every screen (SPEC §4.3)."""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass

from homeboard.palette import Role

# Trailing "[...]" bracket, optionally preceded by whitespace, anchored to
# the end of the string — e.g. "Rebuild the side gate [half day]".
_SIZE_BRACKET_RE = re.compile(r"\s*\[([^\[\]]+)\]\s*$")

# Recognised bracket contents -> normalised display label (SPEC §4.3 table).
# Matching is case-insensitive; unrecognised contents render verbatim.
_SIZE_LABELS: dict[str, str] = {
    "30m": "30 minutes",
    "30 minutes": "30 minutes",
    "half day": "Half a day",
    "2h": "Half a day",
    "weekend": "One weekend",
    "1d": "One weekend",
}


@dataclass(frozen=True)
class SizeTag:
    """A rendered size chip: label text plus the fixed `available` outline
    treatment every size tag uses (SPEC §4.3)."""

    label: str
    role: Role = Role.AVAILABLE
    solid: bool = False


def parse_size_tag(text: str) -> tuple[str, SizeTag | None]:
    """Split a trailing size bracket off *text*.

    Returns ``(title, size_tag)`` — *title* has the bracket (and any
    separating whitespace) stripped; *size_tag* is ``None`` when no bracket
    is present, per SPEC §4.3: "An item with no bracket renders with no
    size tag — never a placeholder."
    """
    match = _SIZE_BRACKET_RE.search(text)
    if not match:
        return text.strip(), None

    title = text[: match.start()].rstrip()
    raw = match.group(1).strip()
    label = _SIZE_LABELS.get(raw.lower(), raw)
    return title, SizeTag(label=label)


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
