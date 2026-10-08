"""Read-only adapter for a self-hosted ``boardbot`` deployment.

``boardbot`` (github.com/cartagena/boardbot) is a small self-hosted service
that backs four InkyPi screens — ``board`` (to-dos + projects), ``trips``,
``home_maintenance`` and ``sermon`` — over one HTTP API: a WhatsApp bridge
lets items be added/completed from a phone, a Python service stores them in
SQLite and exposes ``GET /todo``, ``GET /projects``, ``GET /trips``,
``GET /maintenance`` and ``GET /sermons/latest``. This module is the InkyPi-side client for that HTTP
API — it never sees WhatsApp or SQLite directly.

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
from urllib.parse import urlsplit

from utils.http_client import get_http_session

ListName = Literal["todo", "projects"]
ResourceName = Literal["todo", "projects", "trips", "maintenance", "sermons/latest"]

# Env key the plugin reads its bearer token from (via
# device_config.load_env_key). Matches the env var name boardbot's own
# services use for the same shared secret.
BOARDBOT_API_TOKEN_ENV_KEY = "BOARDBOT_API_TOKEN"

# boardbot is a self-hosted LAN service (see module docstring) -- if it's
# unreachable, a real response is not coming, so fail fast rather than wait
# out a generous timeout. This matters doubly here because board.py calls
# fetch_checklist() TWICE per generate_image() (projects, then todo),
# sequentially, and the shared HTTP session retries up to 3 times
# (utils.http_client._PLUGIN_RETRY_TOTAL) on a connect failure -- at the
# previous 10s value, a single fetch's worst case (4 attempts x 10s + retry
# backoff) measured ~43s against a genuinely unreachable host, so the pair
# together could exceed the 60s generic plugin execution timeout
# (refresh_task.task._PLUGIN_TIMEOUT_DEFAULTS_S) and get killed by that
# outer watchdog before BasePlugin.cached_fetch's own graceful
# stale-cache/empty-state fallback ever got a chance to run. At 4s this
# same worst case is ~19s per fetch, ~38s for both -- safely inside the
# window with margin for rendering (also given headroom via board's own
# entry in _PLUGIN_TIMEOUT_DEFAULTS_S).
_REQUEST_TIMEOUT_SECONDS = 4


def validate_board_settings(settings: Mapping[str, Any]) -> str | None:
    """Return a human-readable error if ``base_url`` is missing/blank or
    doesn't use ``http``/``https``, else ``None``. For use from a plugin's
    ``validate_settings()``.

    The scheme check is defense-in-depth, not SSRF protection — ``base_url``
    is trusted (see the module docstring), so this doesn't stop it pointing
    at an attacker-controlled *http(s)* host, only at a non-HTTP scheme
    (``file://``, ``gopher://``, ...) being entered by mistake or malice.
    """
    base_url = settings.get("base_url")
    if not isinstance(base_url, str) or not base_url.strip():
        return "BoardBot URL is required."
    if urlsplit(base_url.strip()).scheme not in ("http", "https"):
        return "BoardBot URL must start with http:// or https://."
    return None


def cache_key(base_url: str, resource: ResourceName) -> str:
    """Cache key for ``BasePlugin.cached_fetch`` / the board ledger —
    identifies *which* boardbot deployment and resource, not which plugin
    instance."""
    return f"{base_url}:{resource}"


def _get_json(resource: ResourceName, base_url: str, token: str) -> Any:
    """Shared GET for every boardbot read endpoint — auth and config
    validation are identical across all of them. The list endpoints
    (``/todo``, ``/projects``, ``/trips``, ``/maintenance``) return a bare
    JSON array (SPEC/docs/api.md §"Response conventions"); ``/sermons/latest``
    returns a single object. Callers handle the shape per resource.

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
    if urlsplit(base_url).scheme not in ("http", "https"):
        raise RuntimeError("BoardBot URL must start with http:// or https://")
    if not token:
        raise RuntimeError(
            f"BoardBot API token is not configured ({BOARDBOT_API_TOKEN_ENV_KEY})"
        )

    session = get_http_session()
    response = session.get(
        f"{base_url.rstrip('/')}/{resource}",
        headers={"Authorization": f"Bearer {token}"},
        timeout=_REQUEST_TIMEOUT_SECONDS,
    )
    response.raise_for_status()
    return response.json()


def _get_resource(
    resource: ResourceName, base_url: str, token: str
) -> list[dict[str, Any]]:
    """``_get_json`` for the list endpoints (bare JSON array)."""
    items: list[dict[str, Any]] = _get_json(resource, base_url, token)
    return items


def fetch_checklist(
    list_name: ListName, base_url: str, token: str
) -> list[dict[str, Any]]:
    """Fetch every item (open and checked) from *list_name* (``todo`` or
    ``projects``) on the ``boardbot`` deployment at *base_url*.

    Returns one dict per item: ``{"text": ..., "checked": ..., "due_date":
    ... | None, "priority": ... | None, "effort_days": ... | None}`` —
    ``text``/``checked`` match the shape ``homeboard.adapters.gkeep.
    fetch_checklist`` used to return, so ``board_data.py``'s existing
    parsing is unaffected; the three extra fields are new (see SPEC §4.3's
    effort/priority/due tags).
    """
    items = _get_resource(list_name, base_url, token)
    return [
        {
            "text": str(item.get("text", "")),
            "checked": bool(item.get("checked")),
            "due_date": item.get("due_date"),
            "priority": item.get("priority"),
            "effort_days": item.get("effort_days"),
        }
        for item in items
    ]


def fetch_trips(base_url: str, token: str) -> list[dict[str, Any]]:
    """Fetch every trip from ``GET /trips`` on the ``boardbot`` deployment
    at *base_url*, ordered by ``start`` ascending (trips with no ``start``
    sort last) per boardbot's own contract.

    Returned dicts carry whichever of ``name``, ``status``, ``start``,
    ``end``, ``target_window``, ``next_action`` boardbot included for that
    row — a missing key means absent, never ``null`` (boardbot never emits
    ``null``). Passed through as-is; ``plugins.trips.trips_data.
    parse_trip_row`` does the field-level parsing/coercion, same as it
    already does for a Google Sheets row.
    """
    return _get_resource("trips", base_url, token)


def fetch_maintenance(base_url: str, token: str) -> list[dict[str, Any]]:
    """Fetch every task from ``GET /maintenance`` on the ``boardbot``
    deployment at *base_url*, oldest-created first per boardbot's own
    contract.

    Returned dicts carry whichever of ``task``, ``interval_unit``,
    ``interval_value``, ``next_due_override``, ``last_done`` boardbot
    included for that row. Passed through as-is;
    ``plugins.home_maintenance.home_maintenance._parse_row`` does the
    field-level parsing/coercion, same as it already does for a Google
    Sheets row. boardbot computes no ``next_due`` itself (by design, per
    its docs) — that stays this repo's ``due_dates.compute_next_due``.
    """
    return _get_resource("maintenance", base_url, token)


def fetch_sermon_latest(base_url: str, token: str) -> dict[str, Any]:
    """Fetch the most recent summarized service from ``GET /sermons/latest``.

    Returns boardbot's JSON object as-is (``title``, ``service_date``,
    ``summary``, ``takeaways``, ``scriptures``, ... — unset fields are
    omitted, never ``null``); ``plugins.sermon.sermon_data.parse_sermon``
    does the field-level parsing. A ``503`` (feature off, or nothing
    summarized yet) and a ``401`` raise ``requests.HTTPError`` like any
    other non-2xx, which ``BasePlugin.cached_fetch`` treats as transient:
    the last good sermon keeps rendering, or the plugin shows its
    "no sermon yet" frame when there is none.
    """
    data = _get_json("sermons/latest", base_url, token)
    if not isinstance(data, dict):
        raise ValueError("boardbot /sermons/latest did not return a JSON object")
    return data
