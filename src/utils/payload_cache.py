"""System-wide fail-soft payload cache for plugins that fetch remote data.

Any plugin's `generate_image()` can call `self.cached_fetch(...)`
(`BasePlugin.cached_fetch`) to survive a transient fetch failure by serving
the last successful payload instead of raising — see
`specs/SPEC.md` §4.4 for the bedroom-dashboard screens this was built for,
though nothing here is specific to them; any plugin may opt in.

Each plugin gets a small JSON file under:
    <config_dir>/plugin_cache/<sha256(plugin_id + ":" + cache_key)[:16]>.json

modeled directly on `utils/plugin_history.py`'s existing convention
(hashed filename — so filesystem paths never depend on user-controlled
string contents, keeping CodeQL's path-injection analyzer happy — and
atomic tempfile+os.replace writes). `cache_key` is supplied by the caller
and should reflect whatever distinguishes one configured instance of a
plugin from another (e.g. a sheet id, a set of calendar ids) — plugin
instance *names* aren't available to `generate_image()`, only `settings`
and `device_config`, so identity has to come from the data itself.
"""

from __future__ import annotations

import hashlib
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
    fd, tmp_path = tempfile.mkstemp(dir=dir_path, prefix=".plugincache_", suffix=".tmp")
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
        logger.warning("payload_cache: could not read %s: %s", path, exc)
        return None


@dataclass(frozen=True)
class CacheResult:
    """The outcome of one `cached_fetch` call."""

    payload: Any | None
    fresh: bool  # freshly fetched this call
    stale: bool  # fetch failed; serving a previously cached payload
    empty: bool  # fetch failed and no cache exists
    synced_at: datetime | None  # timestamp of the payload actually returned


def _cache_dir(config_dir: str) -> str:
    return os.path.join(config_dir, "plugin_cache")


def _cache_file_path(config_dir: str, plugin_id: str, cache_key: str) -> str:
    if not isinstance(cache_key, str) or not cache_key:
        raise ValueError("payload_cache: cache_key must be a non-empty string")
    digest = hashlib.sha256(f"{plugin_id}:{cache_key}".encode()).hexdigest()
    return os.path.join(_cache_dir(config_dir), f"{digest[:16]}.json")


def cached_fetch(
    config_dir: str,
    plugin_id: str,
    cache_key: str,
    fetch_fn: Callable[[], Any],
    config_errors: tuple[type[BaseException], ...] = (RuntimeError,),
) -> CacheResult:
    """Call *fetch_fn*, caching the result under a file identified by
    *plugin_id* + *cache_key*.

    - On success: write the payload + a UTC timestamp, return it fresh.
    - On an exception whose type is in *config_errors* (default:
      ``RuntimeError``): re-raise. This is the one path allowed to trip the
      plugin's circuit breaker — reserved for missing credentials, unset
      ids, or malformed settings (SPEC §4.4).
    - On any other exception (a transient fetch/parse failure): log at
      WARNING and never raise. Serve the cached payload with ``stale=True``
      if one exists, else report ``empty=True``.
    """
    path = _cache_file_path(config_dir, plugin_id, cache_key)
    try:
        payload = fetch_fn()
    except config_errors:
        raise
    except Exception as exc:  # noqa: BLE001 - transient failures must never raise
        logger.warning(
            "payload_cache: fetch failed for plugin_id=%s, serving cached data if any: %s",
            plugin_id,
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
