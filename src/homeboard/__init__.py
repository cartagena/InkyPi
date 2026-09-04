"""Shared rendering support for the bedroom-dashboard plugins.

This package is intentionally *not* a plugin: it has no ``plugin-info.json``,
so ``Config.read_plugins_list()`` (which scans ``src/plugins/`` for that
file) never discovers it. It holds code shared by the ``weekends``,
``board``, ``trips`` and ``home_maintenance`` plugins — palette resolution,
layout token math, tag rendering and the Google/ICS adapters — so that logic
exists once instead of once per plugin.
"""
