"""Data-source adapters for the bedroom-dashboard screens.

Each adapter's fetch function is thin and plugin-agnostic — no caching.
Callers (the plugins) wrap it in ``self.cached_fetch(...)``
(``BasePlugin.cached_fetch``, backed by ``utils.payload_cache``) and
raise/catch ``RuntimeError`` at the plugin layer for configuration problems
(SPEC §4.4). Where multiple plugins share an adapter's settings shape (e.g.
every boardbot-backed screen takes a ``base_url`` and the
``BOARDBOT_API_TOKEN`` bearer token), the adapter module also exposes small
settings-validation/resolution helpers so that wiring isn't duplicated per
plugin — see ``homeboard.adapters.boardbot`` for the pattern.
"""
