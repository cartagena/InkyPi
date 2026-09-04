"""Read-only Google Keep adapter, master-token auth (SPEC §4.5, §7.4).

Google Keep has no official API for personal accounts, so this uses
``gkeepapi`` (authenticated via ``gpsoauth`` with a master token derived
from a dedicated throwaway account's app password — see SPEC §4.5's
security requirements: never a primary account, 2FA required, token stored
via the existing dotenv/API-key vault, never in the repo).

**Read-only, no exceptions.** This module must never call any ``gkeepapi``
write/sync-back method (``.add()``, ``.save()``, note mutation) — writes are
where an unofficial, reverse-engineered client can corrupt real data, and
the phone is the intended write path for these two notes.

Imports ``gkeepapi`` at module scope, matching the existing
``homeboard.adapters.gsheets``/``plugins/calendar/calendar.py`` convention
— plugin modules are only imported on first use by ``plugin_registry``, so
this doesn't affect startup RSS (``tests/unit/test_lazy_imports.py`` does
not list it).
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

import gkeepapi

MASTER_TOKEN_ENV_KEY = "GOOGLE_KEEP_MASTER_TOKEN"


def validate_board_settings(settings: Mapping[str, Any]) -> str | None:
    """Return a human-readable error if a required board setting is
    missing/blank, else ``None``. For use from ``validate_settings()``."""
    email = settings.get("keep_account_email")
    if not isinstance(email, str) or not email.strip():
        return "Keep account email is required."
    projects_title = settings.get("projects_note_title")
    if not isinstance(projects_title, str) or not projects_title.strip():
        return "Projects note title is required."
    todo_title = settings.get("todo_note_title")
    if not isinstance(todo_title, str) or not todo_title.strip():
        return "To-do note title is required."
    return None


def fetch_checklist(
    note_title: str, email: str, master_token: str
) -> list[dict[str, Any]]:
    """Fetch every item (open and checked) from the named Keep checklist
    note, in note order.

    Returns one dict per item: ``{"text": ..., "checked": ...}`` — plain
    and JSON-serializable so it round-trips through
    ``BasePlugin.cached_fetch`` unchanged.

    Raises ``RuntimeError`` for configuration problems (missing/blank
    settings) — callers should already have rejected these via
    ``validate_board_settings()``, but this re-checks since settings can
    predate validation or be edited outside the web UI. Any other
    exception (auth failure, network error, a `gkeepapi` internals change —
    it's reverse-engineered and can break without notice) is left to
    propagate so ``BasePlugin.cached_fetch`` treats it as a transient,
    fail-soft failure rather than a config error.
    """
    if not note_title:
        raise RuntimeError("Note title is required")
    if not email:
        raise RuntimeError("Keep account email is required")
    if not master_token:
        raise RuntimeError(
            f"Google Keep master token is not configured ({MASTER_TOKEN_ENV_KEY})"
        )

    keep = gkeepapi.Keep()
    keep.authenticate(email, master_token)

    note = next(
        (n for n in keep.find(query=note_title) if n.title == note_title),
        None,
    )
    if note is None or not isinstance(note, gkeepapi.node.List):
        return []

    # Excludes indented sub-items: gkeepapi's List.items flattens the whole
    # checklist regardless of indentation (confirmed against its source —
    # indentation is only a sort-order hint via item.indented/parent_item,
    # not a separate container), so an indented Keep sub-item would
    # otherwise be parsed as its own independent Projects/To-do row.
    return [
        {"text": item.text, "checked": item.checked}
        for item in note.items
        if not item.indented
    ]
