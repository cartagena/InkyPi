"""Shared render chrome for the bedroom-dashboard screens (SPEC §4.2).

Every screen's own ``render/<id>.html`` is a standalone HTML5 document, not
one that ``{% extends %}`` the InkyPi-wide
``plugins/base_plugin/render/plugin.html`` — that shared base hardcodes
``padding: 1.5vw`` and per-side margins on ``<body>`` and centers
``.container`` with flexbox, all of which fight a full-bleed layout, and
``BasePlugin._render_template`` doesn't require extending it in the first
place (it just renders whatever template it's given and screenshots the
result).

The header/footer markup that's supposed to be identical across all four
screens still has to live somewhere canonical — no plugin's own Jinja
environment can see outside its own plugin directory / ``base_plugin/render/``
(``BasePlugin.__init__`` builds that loader per-plugin), so it can't
``{% extends %}``/``{% import %}`` anything under ``src/homeboard/``. But the
markup itself is four small, fixed-shape snippets, so it's built directly in
Python with ``markupsafe.escape()`` rather than through a second templating
engine — no template file, no second ``Environment``/``FileSystemLoader`` to
reason about, same escaping guarantee Jinja's autoescape would have given.
"""

from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING, TypedDict

from markupsafe import Markup, escape

from homeboard import layout, palette

if TYPE_CHECKING:
    from homeboard.layout import Tokens
    from homeboard.palette import RoleMap

_RENDER_DIR = Path(__file__).parent / "render"

# Absolute path, meant to be passed as one of a plugin's
# render_image(..., template_params={"extra_css_files": [CHROME_CSS_PATH]})
# entries. BasePlugin._build_css_files() joins extra_css_files with the
# plugin's own render dir via os.path.join(), which — given an absolute
# path — returns the absolute path unchanged, so this resolves correctly
# from any plugin.
CHROME_CSS_PATH = str(_RENDER_DIR / "_chrome.css")


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


def _header_html(title: str, meta: str) -> str:
    return str(
        Markup(
            '<div class="hb-header">'
            '<div class="hb-title">{title}</div>'
            '<div class="hb-meta">{meta}</div>'
            "</div>"
            '<div class="hb-header-rule"></div>'
        ).format(title=escape(title), meta=escape(meta))
    )


def _footer_html(source: str, sync_text: str) -> str:
    return str(
        Markup(
            '<div class="hb-footer-rule"></div>'
            '<div class="hb-footer">'
            '<div class="hb-source">{source}</div>'
            '<div class="hb-sync">{sync_text}</div>'
            "</div>"
        ).format(source=escape(source), sync_text=escape(sync_text))
    )


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
    "Synced …" / "As of …" per SPEC §4.4). All four are escaped — they may
    carry untrusted text (calendar event summaries, Keep note titles).
    """
    root_css = layout.tokens_css(t) + "\n" + palette.palette_css(roles)
    return Chrome(
        root_css=root_css,
        header_html=_header_html(title, meta),
        footer_html=_footer_html(source, sync_text),
    )


def empty_state_html(title: str, message: str) -> str:
    """Minimal "no data available" body for a plugin's cache-empty case
    (SPEC §4.4 point 2). Still renders inside the normal header/footer
    chrome — only the body content is replaced."""
    return str(
        Markup(
            '<div class="hb-empty-state">'
            '<div class="hb-empty-title">{title}</div>'
            '<div class="hb-empty-message">{message}</div>'
            "</div>"
        ).format(title=escape(title), message=escape(message))
    )


def too_small_html() -> str:
    """ "Panel too small for this screen" body (SPEC §3.5)."""
    return '<div class="hb-too-small">Panel too small for this screen</div>'
