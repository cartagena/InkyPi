"""Read-only adapter for a self-hosted ``boardbot`` deployment.

``boardbot`` (github.com/cartagena/boardbot) is a small self-hosted service
that replaces Google Keep as the ``board`` plugin's data source: a WhatsApp
bridge lets items be added/completed from a phone, a Python service stores
them in SQLite and exposes ``GET /todo`` / ``GET /projects`` over HTTP. This
module is the InkyPi-side client for that HTTP API — it never sees WhatsApp
or SQLite directly.

Uses the shared pooled ``requests.Session`` (``utils.http_client``), not
``utils.http_utils.safe_http_get`` — that helper rejects URLs resolving to
a private IP (SSRF protection for arbitrary user-supplied URLs like RSS
feeds), but a ``boardbot`` deployment is expected to live on the same LAN
(e.g. a home server), so that protection would break the intended setup.
This is a trusted, explicitly-configured internal service, not
arbitrary user input.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, Literal

from utils.http_client import get_http_session

ListName = Literal["todo", "projects"]

# Env key the plugin reads its bearer token from (via
# device_config.load_env_key). Matches the env var name boardbot's own
# services use for the same shared secret.
BOARDBOT_API_TOKEN_ENV_KEY = "BOARDBOT_API_TOKEN"

_REQUEST_TIMEOUT_SECONDS = 10


def validate_board_settings(settings: Mapping[str, Any]) -> str | None:
    """Return a human-readable error if ``base_url`` is missing/blank, else
    ``None``. For use from a plugin's ``validate_settings()``."""
    base_url = settings.get("base_url")
    if not isinstance(base_url, str) or not base_url.strip():
        return "BoardBot URL is required."
    return None


def cache_key(base_url: str, list_name: ListName) -> str:
    """Cache key for ``BasePlugin.cached_fetch`` / the board ledger —
    identifies *which* boardbot deployment and list, not which plugin
    instance."""
    return f"{base_url}:{list_name}"


def fetch_checklist(
    list_name: ListName, base_url: str, token: str
) -> list[dict[str, Any]]:
    """Fetch every item (open and checked) from *list_name* on the
    ``boardbot`` deployment at *base_url*.

    Returns one dict per item: ``{"text": ..., "checked": ...}`` — same
    shape ``homeboard.adapters.gkeep.fetch_checklist`` returned, so
    ``board_data.py``'s parsing is unaffected by which adapter is in use.

    Raises ``RuntimeError`` for configuration problems (missing/blank
    settings) — callers should already have rejected these via
    ``validate_board_settings()``, but this re-checks since settings can
    predate validation or be edited outside the web UI. Any other
    exception (network failure, non-2xx response, malformed JSON) is left
    to propagate so ``BasePlugin.cached_fetch`` treats it as a transient,
    fail-soft failure rather than a config error.
    """
    if not base_url:
        raise RuntimeError("BoardBot URL is required")
    if not token:
        raise RuntimeError(
            f"BoardBot API token is not configured ({BOARDBOT_API_TOKEN_ENV_KEY})"
        )

    session = get_http_session()
    response = session.get(
        f"{base_url.rstrip('/')}/{list_name}",
        headers={"Authorization": f"Bearer {token}"},
        timeout=_REQUEST_TIMEOUT_SECONDS,
    )
    response.raise_for_status()
    data = response.json()

    items = data.get("items", [])
    return [
        {"text": str(item.get("text", "")), "checked": bool(item.get("checked"))}
        for item in items
    ]
