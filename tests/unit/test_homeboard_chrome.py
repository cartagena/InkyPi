"""Unit tests for homeboard.chrome — SPEC.md §4.2 shared render chrome."""

from __future__ import annotations

from homeboard import chrome, layout, palette


class _FakeDeviceConfig:
    def get_config(self, key: str, default: object = None) -> object:
        return "mock" if key == "display_type" else default

    def get_resolution(self) -> tuple[int, int]:
        return (800, 480)

    def load_env_key(self, key: str) -> str | None:
        return None


def _tokens_and_roles() -> tuple[layout.Tokens, palette.RoleMap]:
    return layout.tokens(800, 480), palette.resolve(_FakeDeviceConfig())


class TestBuildChrome:
    def test_returns_expected_keys(self) -> None:
        t, roles = _tokens_and_roles()
        result = chrome.build_chrome(
            t, roles, "Weekends", "6 weekends", "ICS", "Synced 6:30 am"
        )
        assert set(result.keys()) == {"root_css", "header_html", "footer_html"}

    def test_root_css_includes_layout_and_palette_tokens(self) -> None:
        t, roles = _tokens_and_roles()
        result = chrome.build_chrome(
            t, roles, "Weekends", "6 weekends", "ICS", "Synced 6:30 am"
        )
        assert "--fs-title:" in result["root_css"]
        assert "--color-ink:" in result["root_css"]
        assert "--warn-solid:" in result["root_css"]

    def test_header_html_contains_title_and_meta(self) -> None:
        t, roles = _tokens_and_roles()
        result = chrome.build_chrome(
            t, roles, "Projects & to do", "11 open", "Keep", "Synced 6:30 am"
        )
        # Jinja autoescaping should turn "&" into "&amp;" - confirms the
        # header template is HTML-escaped, not raw-interpolated.
        assert "Projects &amp; to do" in result["header_html"]
        assert "11 open" in result["header_html"]

    def test_footer_html_contains_source_and_sync_text(self) -> None:
        t, roles = _tokens_and_roles()
        result = chrome.build_chrome(
            t, roles, "Trips", "2 booked", "Sheets", "As of Tue 6:30 am"
        )
        assert "Sheets" in result["footer_html"]
        assert "As of Tue 6:30 am" in result["footer_html"]

    def test_header_html_escapes_untrusted_text(self) -> None:
        t, roles = _tokens_and_roles()
        result = chrome.build_chrome(
            t, roles, "<script>evil()</script>", "meta", "src", "sync"
        )
        assert "<script>" not in result["header_html"]
        assert "&lt;script&gt;" in result["header_html"]


class TestEmptyStateAndTooSmall:
    def test_empty_state_contains_title_and_message(self) -> None:
        html = chrome.empty_state_html("Weekends", "No data available")
        assert "Weekends" in html
        assert "No data available" in html

    def test_too_small_contains_message(self) -> None:
        html = chrome.too_small_html()
        assert "too small" in html.lower()


class TestChromeCss:
    def test_returns_non_empty_css(self) -> None:
        css = chrome.chrome_css()
        assert ".hb-header" in css
        assert ".hb-chip" in css
        assert "var(--color-ink)" in css
