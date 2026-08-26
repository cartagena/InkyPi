#!/usr/bin/env python3
"""Run python-semantic-release with a compatibility shim for git.Actor.

GitPython 3.1.60 removed Actor.name_email_regex while fixing a ReDoS
(GHSA-g5vv-9gxw-82hx: catastrophic backtracking in "(.*) <(.*?)>" against an
unterminated "<"). Every published python-semantic-release release through
at least 10.6.1 still reads that attribute in cli/config.py to validate its
own `commit_author` setting, so it crashes with
"type object 'Actor' has no attribute 'name_email_regex'" on any GitPython
>=3.1.60.

Downgrading GitPython to work around this would reintroduce that CVSS 7.5
ReDoS (and two other advisories fixed in the same release), so instead this
re-adds the attribute using GitPython's own replacement pattern from the
fix, before handing off to semantic-release's real CLI entry point. Remove
once semantic-release ships a fix for this upstream.

Usage:
    python scripts/run_semantic_release.py version
    python scripts/run_semantic_release.py publish
"""

from __future__ import annotations

import re
import sys

import git

if not hasattr(git.Actor, "name_email_regex"):
    git.Actor.name_email_regex = re.compile(r"([^<>]*) <([^<>]*)>")  # type: ignore[attr-defined]

from semantic_release.__main__ import main  # noqa: E402

sys.argv = ["semantic-release", *sys.argv[1:]]
sys.exit(main())
