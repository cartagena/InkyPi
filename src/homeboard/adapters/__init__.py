"""Data-source adapters for the bedroom-dashboard screens.

Each adapter is a thin, plugin-agnostic fetch function — no caching, no
settings parsing. Callers (the plugins) wrap these in
``homeboard.cache.cached_fetch`` and raise/catch ``RuntimeError`` at the
plugin layer for configuration problems (SPEC §4.4).
"""
