"""Read-only Google Sheets adapter, service-account auth (SPEC §8.1, §8.2).

Used by the ``trips`` and ``home_maintenance`` plugins. Imports its Google
SDKs at module scope, matching the existing ``plugins/calendar/calendar.py``
convention for ``icalendar``/``recurring_ical_events`` — plugin modules are
only imported on first use by ``plugin_registry`` (confirmed by
``tests/unit/test_lazy_imports.py`` not listing those two packages), so a
module-level import here doesn't affect startup RSS.
"""

from __future__ import annotations

from google.oauth2 import service_account
from googleapiclient.discovery import build

_SCOPES = ["https://www.googleapis.com/auth/spreadsheets.readonly"]


def read_worksheet(
    sheet_id: str, worksheet_name: str, service_account_json_path: str
) -> list[dict[str, str]]:
    """Fetch *worksheet_name* from the spreadsheet *sheet_id*.

    Returns one dict per data row, keyed by the header row (SPEC §4.5's
    "shared module" doc calls this shape out explicitly for
    ``homeboard.adapters.gsheets``).

    Raises ``RuntimeError`` for configuration problems (missing/blank
    settings, unreadable credentials file) — these are meant to trip the
    plugin's ``validate_settings``/circuit breaker path. Any other
    exception (network failure, malformed response, Google API error) is
    left to propagate as-is so ``homeboard.cache.cached_fetch`` treats it
    as a transient, fail-soft failure rather than a config error.
    """
    if not sheet_id:
        raise RuntimeError("Sheet ID is required")
    if not worksheet_name:
        raise RuntimeError("Worksheet name is required")
    if not service_account_json_path:
        raise RuntimeError(
            "Google service account credentials are not configured "
            "(GOOGLE_SERVICE_ACCOUNT_JSON_PATH)"
        )

    try:
        credentials = service_account.Credentials.from_service_account_file(  # type: ignore[no-untyped-call]
            service_account_json_path, scopes=_SCOPES
        )
    except (OSError, ValueError) as exc:
        raise RuntimeError(
            f"Could not read Google service account credentials: {exc}"
        ) from exc

    service = build("sheets", "v4", credentials=credentials, cache_discovery=False)
    result = (
        service.spreadsheets()
        .values()
        .get(spreadsheetId=sheet_id, range=worksheet_name)
        .execute()
    )

    rows: list[list[str]] = result.get("values", [])
    if not rows:
        return []

    header, *data_rows = rows
    parsed: list[dict[str, str]] = []
    for row in data_rows:
        padded = list(row) + [""] * (len(header) - len(row))
        parsed.append(dict(zip(header, padded, strict=False)))
    return parsed
