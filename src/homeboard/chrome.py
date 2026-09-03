"""Shared render chrome for the bedroom-dashboard screens (SPEC §4.2).

Every screen's own ``render/<id>.html`` is a standalone HTML5 document, not
one that ``{% extends %}`` the InkyPi-wide
``plugins/base_plugin/render/plugin.html`` — that shared base hardcodes
``padding: 1.5vw`` and per-side margins on ``<body>`` and centers
``.container`` with flexbox, all of which fight a full-bleed layout, and
``BasePlugin._render_template`` doesn't require extending it in the first
place (it just renders whatever template it's given and screenshots the
result).

So the header/footer markup that's supposed to be identical across all four
screens is authored exactly once, here, as Jinja macros in
``render/_chrome.html``, and rendered through a small **private** Jinja
environment — independent of any plugin's own ``BasePlugin`` env, which
can't see outside its own plugin directory / ``base_plugin/render/``
anyway. ``build_chrome()`` turns those macros into plain HTML strings a
screen's template drops in with ``{{ … | safe }}``.
"""

from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING, TypedDict

from jinja2 import Environment, FileSystemLoader, select_autoescape

from homeboard import layout, palette

if TYPE_CHECKING:
    from homeboard.layout import Tokens
    from homeboard.palette import RoleMap

_RENDER_DIR = Path(__file__).parent / "render"

_env = Environment(
    loader=FileSystemLoader(str(_RENDER_DIR)),
    autoescape=select_autoescape(["html"]),
)


def _chrome_module() -> object:
    return _env.get_template("_chrome.html").module


class Chrome(TypedDict):
    """Everything a screen's template needs to render the shared frame."""

    root_css: str  # layout tokens + palette custom properties, one <style> block
    header_html: str
    footer_html: str


def chrome_css() -> str:
    """The static positioning rules for the header/footer/empty-state/chip
    markup (SPEC §3.3, §4.2, §4.3). Read fresh each call so dev-mode
    hot-reload of the CSS file works like the rest of the codebase."""
    return (_RENDER_DIR / "_chrome.css").read_text(encoding="utf-8")


def build_chrome(
    t: Tokens,
    roles: RoleMap,
    title: str,
    meta: str,
    source: str,
    sync_text: str,
) -> Chrome:
    """Build the shared header/footer HTML and the combined tokens+palette
    CSS custom-property block for one screen render.

    ``title``/``meta`` populate the header (screen name, right-aligned meta
    line); ``source``/``sync_text`` populate the footer (data source,
    "Synced …" / "As of …" per SPEC §4.4).
    """
    macros = _chrome_module()
    root_css = layout.tokens_css(t) + "\n" + palette.palette_css(roles)
    header_html = str(macros.header_html(title, meta))  # type: ignore[attr-defined]
    footer_html = str(macros.footer_html(source, sync_text))  # type: ignore[attr-defined]
    return Chrome(root_css=root_css, header_html=header_html, footer_html=footer_html)


def empty_state_html(title: str, message: str) -> str:
    """Minimal "no data available" body for a plugin's cache-empty case
    (SPEC §4.4 point 2). Still renders inside the normal header/footer
    chrome — only the body content is replaced."""
    macros = _chrome_module()
    return str(macros.empty_state_html(title, message))  # type: ignore[attr-defined]


def too_small_html() -> str:
    """ "Panel too small for this screen" body (SPEC §3.5)."""
    macros = _chrome_module()
    return str(macros.too_small_html())  # type: ignore[attr-defined]
