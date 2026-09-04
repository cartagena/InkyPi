"""Unit tests for homeboard.chrome — SPEC.md §4.2 shared render chrome."""

from __future__ import annotations

from homeboard import chrome, layout, palette


class _FakeDeviceConfig:
    config_file = "/tmp/does-not-matter/device.json"

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


class TestSyncText:
    def test_no_synced_at_returns_empty_string(self) -> None:
        from datetime import UTC

        from utils.payload_cache import CacheResult

        result = CacheResult(
            payload=None, fresh=False, stale=False, empty=True, synced_at=None
        )
        assert chrome.sync_text(result, UTC) == ""

    def test_fresh_result_says_synced(self) -> None:
        from datetime import UTC, datetime

        from utils.payload_cache import CacheResult

        result = CacheResult(
            payload={"n": 1},
            fresh=True,
            stale=False,
            empty=False,
            synced_at=datetime(2026, 1, 6, 18, 30, tzinfo=UTC),
        )
        assert chrome.sync_text(result, UTC) == "Synced tue 6:30 pm"

    def test_stale_result_says_as_of(self) -> None:
        from datetime import UTC, datetime

        from utils.payload_cache import CacheResult

        result = CacheResult(
            payload={"n": 1},
            fresh=False,
            stale=True,
            empty=False,
            synced_at=datetime(2026, 1, 6, 18, 30, tzinfo=UTC),
        )
        assert chrome.sync_text(result, UTC) == "As of tue 6:30 pm"

    def test_converts_to_the_given_timezone(self) -> None:
        from datetime import UTC, datetime
        from zoneinfo import ZoneInfo

        from utils.payload_cache import CacheResult

        # 18:30 UTC == 10:30 pacific (standard time, UTC-8) in January.
        result = CacheResult(
            payload={"n": 1},
            fresh=True,
            stale=False,
            empty=False,
            synced_at=datetime(2026, 1, 6, 18, 30, tzinfo=UTC),
        )
        text = chrome.sync_text(result, ZoneInfo("America/Los_Angeles"))
        assert "10:30" in text
