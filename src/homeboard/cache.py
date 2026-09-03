"""Fail-soft on-disk cache wrapper shared by every screen (SPEC §4.4).

Each of the four plugins owns and writes to its own cache directory (this
codebase's `get_plugin_dir("cache")`, i.e. `src/plugins/<id>/cache/`) —
nothing here hardcodes a shared location. This module only supplies the
generic atomic-write/fail-soft mechanics, modeled on the existing
`src/utils/plugin_history.py` pattern (atomic tempfile + os.replace,
never raise on I/O failure).
"""

from __future__ import annotations

import json
import logging
import os
import tempfile
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

logger = logging.getLogger(__name__)

_PAYLOAD_KEY = "payload"
_SYNCED_AT_KEY = "synced_at"


def atomic_write_json(path: str, data: Any) -> None:
    """Write *data* to *path* as JSON, atomically (tempfile + os.replace in
    the same directory), creating parent directories as needed."""
    dir_path = os.path.dirname(path) or "."
    os.makedirs(dir_path, exist_ok=True)
    fd, tmp_path = tempfile.mkstemp(dir=dir_path, prefix=".hbcache_", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(data, fh)
        os.replace(tmp_path, path)
    except Exception:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise


def read_json_or_none(path: str) -> Any | None:
    """Read *path* as JSON, returning ``None`` if it doesn't exist or fails
    to parse — never raises."""
    if not os.path.isfile(path):
        return None
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except Exception as exc:  # noqa: BLE001 - a corrupt cache file is not fatal
        logger.warning("homeboard.cache: could not read %s: %s", path, exc)
        return None


@dataclass(frozen=True)
class CacheResult:
    """The outcome of one `cached_fetch` call."""

    payload: Any | None
    fresh: bool  # freshly fetched this call
    stale: bool  # fetch failed; serving a previously cached payload
    empty: bool  # fetch failed and no cache exists
    synced_at: datetime | None  # timestamp of the payload actually returned


def _cache_file_path(cache_dir: str, cache_key: str) -> str:
    return os.path.join(cache_dir, f"{cache_key}.json")


def cached_fetch(
    cache_dir: str,
    cache_key: str,
    fetch_fn: Callable[[], Any],
    config_errors: tuple[type[BaseException], ...] = (RuntimeError,),
) -> CacheResult:
    """Call *fetch_fn*, caching the result under *cache_dir*/*cache_key*.json.

    - On success: write the payload + a UTC timestamp, return it fresh.
    - On an exception whose type is in *config_errors* (default:
      ``RuntimeError``): re-raise. This is the one path allowed to trip the
      plugin's circuit breaker — reserved for missing credentials, unset
      ids, or malformed settings (SPEC §4.4).
    - On any other exception (a transient fetch/parse failure): log at
      WARNING and never raise. Serve the cached payload with ``stale=True``
      if one exists, else report ``empty=True``.
    """
    path = _cache_file_path(cache_dir, cache_key)
    try:
        payload = fetch_fn()
    except config_errors:
        raise
    except Exception as exc:  # noqa: BLE001 - transient failures must never raise
        logger.warning(
            "homeboard.cache: fetch failed for %s, serving cached data if any: %s",
            cache_key,
            exc,
        )
        cached = read_json_or_none(path)
        if cached is None:
            return CacheResult(
                payload=None, fresh=False, stale=False, empty=True, synced_at=None
            )
        synced_at = _parse_synced_at(cached.get(_SYNCED_AT_KEY))
        return CacheResult(
            payload=cached.get(_PAYLOAD_KEY),
            fresh=False,
            stale=True,
            empty=False,
            synced_at=synced_at,
        )

    now = datetime.now(UTC)
    atomic_write_json(path, {_PAYLOAD_KEY: payload, _SYNCED_AT_KEY: now.isoformat()})
    return CacheResult(
        payload=payload, fresh=True, stale=False, empty=False, synced_at=now
    )


def _parse_synced_at(value: Any) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        return datetime.fromisoformat(value)
    except ValueError:
        return None
