"""Deterministic, daily-seeded weighted sampling for the board plugin's
backlog rotation (SPEC §7.5).

Pure functions, no I/O — unit-testable without a live Keep fetch. The
sample must be stable within a day (same seed -> same result) and rotate
daily (different date -> a materially different sample), and heavier
weights should surface more often across repeated daily draws without ever
guaranteeing any one item a slot ("weighted... without ever being pinned").
"""

from __future__ import annotations

import hashlib
import random
from collections.abc import Callable, Sequence
from datetime import date
from typing import TypeVar

T = TypeVar("T")


def seeded_rng(today: date, seed_key: str) -> random.Random:
    """A ``random.Random`` seeded from *today* and *seed_key* (e.g. the
    configured Keep note title) — stable within a day, different the next
    day, and independent across differently-configured board instances."""
    digest = hashlib.sha256(f"{today.isoformat()}:{seed_key}".encode()).hexdigest()
    return random.Random(int(digest[:16], 16))


def weighted_sample_without_replacement(
    rng: random.Random,
    items: Sequence[T],
    weights: Callable[[T], float],
    k: int,
) -> list[T]:
    """*k* items drawn without replacement, weighted by ``weights(item)``,
    using the Efraimidis-Spirakis A-ES algorithm: each item gets a key
    ``rng.random() ** (1 / weight)``, and the top ``k`` keys win. Higher
    weight pushes the key closer to 1 (more likely to rank high) without
    ever making a lower-weighted item impossible to draw.

    Draws one ``rng.random()`` call per item, in *items*' given order, so
    the result is deterministic for a given ``rng`` state and input order.
    """
    if k <= 0 or not items:
        return []

    keyed = []
    for item in items:
        weight = max(weights(item), 1e-9)
        key = rng.random() ** (1.0 / weight)
        keyed.append((key, item))

    keyed.sort(key=lambda pair: pair[0], reverse=True)
    return [item for _, item in keyed[:k]]
