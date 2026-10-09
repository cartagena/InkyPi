# pyright: reportMissingImports=false
"""Tests for the sermon plugin and its pure helpers."""

from __future__ import annotations

import json
from datetime import date
from pathlib import Path
from typing import Any

import pytest
from PIL import Image

from homeboard import layout, palette
from homeboard.adapters import boardbot
from plugins.sermon import sermon_data as sd, sermon_layouts as sl
from plugins.sermon.sermon import Sermon

_SETTINGS = {"base_url": "http://piserver.local:8765"}

_FIXTURE: dict[str, Any] = {
    "title": "Dry Bones",
    "video_title": "CAMPFIRE STORIES: Dry Bones | Andrew Poe",
    "url": "https://www.youtube.com/watch?v=3w7BFGroSOE",
    "published_at": "2026-10-05T05:47:31+00:00",
    "service_date": "2026-10-04",
    "speaker": "Andrew Poe",
    "series": "Campfire Stories",
    "summary": "Many of us act one way at church and live another way backstage. "
    "God wants a changed heart, not a performance.",
    "highlights": ["You can't act your way to repentance."],
    "takeaways": [
        {"text": "Turn to God now.", "source": "stated"},
        {"text": "Pick one area and confess it this week.", "source": "inferred"},
    ],
    "scriptures": ["Ezekiel 33:30-32", "Ezekiel 37:1-14"],
    "related_passages": ["Psalms 51:10", "John 3:3"],
    "reflection_question": {
        "text": "How bad does it have to get?",
        "source": "inferred",
    },
    "service_notes": ["communion"],
}


@pytest.fixture
def with_token(device_config_dev: Any, monkeypatch: pytest.MonkeyPatch) -> Any:
    monkeypatch.setattr(
        device_config_dev.__class__, "load_env_key", lambda self, key: "fake-token"
    )
    return device_config_dev


class TestParse:
    def test_parses_handoff_fixture(self) -> None:
        s = sd.parse_sermon(_FIXTURE)
        assert s.service_date == date(2026, 10, 4)
        assert [t.inferred for t in s.takeaways] == [False, True]
        assert s.reflection is not None and s.reflection.inferred

    def test_missing_optionals_and_garbage_are_tolerated(self) -> None:
        s = sd.parse_sermon({"title": "X", "takeaways": "nope", "service_date": "bad"})
        assert s.series == "" and s.speaker == ""
        assert s.takeaways == [] and s.service_date is None and s.reflection is None

    def test_format_date_uses_service_date(self) -> None:
        assert sd.format_service_date(date(2026, 10, 4)) == "Sunday, Oct 4"
        assert sd.format_service_date(None) == ""

    def test_service_notes_labels_skip_unknown(self) -> None:
        assert sd.service_note_labels(["communion", "x", "baptism"]) == [
            "Communion Sunday",
            "Baptism",
        ]


class TestScreens:
    def test_clock_rotation_cycles_hourly(self) -> None:
        seen = [sd.screen_for_clock(h * 3600 + 5) for h in range(8)]
        assert seen[:4] == seen[4:]
        assert set(seen) == set(sd.SCREENS)

    def test_explicit_setting_overrides_clock(self) -> None:
        assert sd.resolve_screen("apply", 0) == "apply"
        assert sd.resolve_screen("auto", 0) == sd.screen_for_clock(0)
        assert sd.resolve_screen("bogus", 0) == sd.screen_for_clock(0)

    @pytest.mark.parametrize(
        ("screen", "missing"),
        [
            ("highlights", {"highlights": []}),
            ("apply", {"takeaways": []}),
            (
                "reflect",
                {"scriptures": [], "related_passages": [], "reflection_question": {}},
            ),
        ],
    )
    def test_empty_screen_falls_back_to_the_message(
        self, screen: sd.Screen, missing: dict[str, Any]
    ) -> None:
        full = sd.parse_sermon(_FIXTURE)
        assert sd.resolve_screen(screen, 0, full) == screen
        sparse = sd.parse_sermon({**_FIXTURE, **missing})
        assert sd.resolve_screen(screen, 0, sparse) == "message"
        hour = sd.SCREENS.index(screen) * 3600
        assert sd.resolve_screen("auto", hour, sparse) == "message"

    def test_footnote_only_when_inferred_shown(self) -> None:
        s = sd.parse_sermon(_FIXTURE)
        assert sd.has_inferred(s, "apply") and sd.has_inferred(s, "reflect")
        assert not sd.has_inferred(s, "message")


class TestFit:
    def test_truncate_never_cuts_mid_word(self) -> None:
        out = sd.truncate_words("alpha beta gamma delta", 14)
        assert out.endswith("…")
        assert out[:-1].split()[-1] in {"alpha", "beta", "gamma", "delta"}

    def test_shrinks_before_truncating(self) -> None:
        text = "word " * 60
        blocks, px = sd.fit_blocks([text.strip()], 700, 200, [28, 24, 20, 16])
        assert px < 28 and blocks == [text.strip()]

    def test_truncates_when_nothing_fits(self) -> None:
        text = "word " * 400
        blocks, px = sd.fit_blocks([text.strip()], 700, 120, [28, 16])
        assert px == 16 and blocks[0].endswith("…")
        assert sd.block_height(blocks, 700, px) <= 120


class TestGenerateImage:
    def test_missing_token_raises(self, device_config_dev: Any) -> None:
        with pytest.raises(RuntimeError, match="API token"):
            Sermon({"id": "sermon"}).generate_image(_SETTINGS, device_config_dev)

    def test_bad_url_raises(self, device_config_dev: Any) -> None:
        with pytest.raises(RuntimeError):
            Sermon({"id": "sermon"}).generate_image({"base_url": ""}, device_config_dev)

    @pytest.mark.parametrize(
        "screen", ["message", "highlights", "apply", "reflect", "auto"]
    )
    def test_each_screen_renders(
        self, with_token: Any, monkeypatch: pytest.MonkeyPatch, screen: str
    ) -> None:
        monkeypatch.setattr(boardbot, "fetch_sermon_latest", lambda *a, **k: _FIXTURE)
        image = Sermon({"id": "sermon"}).generate_image(
            {**_SETTINGS, "screen": screen}, with_token
        )
        assert isinstance(image, Image.Image)
        assert image.size == tuple(with_token.get_resolution())

    def test_minimal_payload_renders(
        self, with_token: Any, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(
            boardbot, "fetch_sermon_latest", lambda *a, **k: {"title": "T"}
        )
        for screen in sd.SCREENS:
            image = Sermon({"id": "sermon"}).generate_image(
                {**_SETTINGS, "screen": screen}, with_token
            )
            assert isinstance(image, Image.Image)

    def test_overlong_content_renders(
        self, with_token: Any, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        big = {
            **_FIXTURE,
            "summary": "long sentence here. " * 80,
            "takeaways": [{"text": "x " * 100, "source": "stated"}] * 5,
        }
        monkeypatch.setattr(boardbot, "fetch_sermon_latest", lambda *a, **k: big)
        for screen in ("message", "highlights", "apply"):
            image = Sermon({"id": "sermon"}).generate_image(
                {**_SETTINGS, "screen": screen}, with_token
            )
            assert isinstance(image, Image.Image)

    def test_no_sermon_yet_renders_empty_frame(
        self, with_token: Any, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        def _503(*a: object, **k: object) -> dict[str, Any]:
            raise TimeoutError("503 No sermon summary available yet")

        monkeypatch.setattr(boardbot, "fetch_sermon_latest", _503)
        image = Sermon({"id": "sermon"}).generate_image(_SETTINGS, with_token)
        assert isinstance(image, Image.Image)

    def test_failure_after_success_serves_stale(
        self, with_token: Any, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        plugin = Sermon({"id": "sermon"})
        monkeypatch.setattr(boardbot, "fetch_sermon_latest", lambda *a, **k: _FIXTURE)
        plugin.generate_image(_SETTINGS, with_token)

        def _boom(*a: object, **k: object) -> dict[str, Any]:
            raise TimeoutError("down")

        monkeypatch.setattr(boardbot, "fetch_sermon_latest", _boom)
        assert isinstance(plugin.generate_image(_SETTINGS, with_token), Image.Image)


class TestAdapter:
    def test_rejects_non_object(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(boardbot, "_get_json", lambda *a, **k: [1])
        with pytest.raises(ValueError):
            boardbot.fetch_sermon_latest("http://h", "t")

    def test_passes_object_through(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(boardbot, "_get_json", lambda *a, **k: {"title": "T"})
        assert boardbot.fetch_sermon_latest("http://h", "t") == {"title": "T"}


class TestReviewFixes:
    def test_empty_object_does_not_replace_cache(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(boardbot, "_get_json", lambda *a, **k: {})
        with pytest.raises(ValueError):
            boardbot.fetch_sermon_latest("http://h", "t")

    def test_fit_pop_removes_the_truncated_block(self) -> None:
        blocks, _ = sd.fit_blocks(["a", "bb"], 5, 1, [16])
        assert "a" not in blocks or blocks == ["a"]

    def test_tiny_panel_uses_too_small_frame(
        self, with_token: Any, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(boardbot, "fetch_sermon_latest", lambda *a, **k: _FIXTURE)
        monkeypatch.setattr(
            Sermon, "get_oriented_dimensions", lambda self, dc: (200, 60)
        )
        image = Sermon({"id": "sermon"}).generate_image(_SETTINGS, with_token)
        assert isinstance(image, Image.Image)


_SAMPLE = json.loads(
    (Path(__file__).parent / "fixtures" / "sermon_sample.json").read_text()
)
_SIX = palette.RoleMap(
    colors=dict(palette._SIX_COLOUR_RGB), six_colour=True, warn_is_solid=False
)
_MONO = palette.RoleMap(
    colors=dict(palette._BW_RGB), six_colour=False, warn_is_solid=False
)


def _rgb(role: palette.Role, roles: palette.RoleMap = _SIX) -> str:
    r, g, b = roles.colors[role]
    return f"rgb({r}, {g}, {b})"


@pytest.fixture(params=sl.DESIGNS)
def design(request: pytest.FixtureRequest) -> sl.Design:
    return request.param  # type: ignore[no-any-return]


class TestLayouts:
    @pytest.fixture(autouse=True)
    def _design(self, design: sl.Design) -> None:
        self.design = design

    def _params(
        self, screen: sd.Screen, roles: palette.RoleMap = _SIX
    ) -> dict[str, Any]:
        return Sermon({"id": "sermon"}).build_params(
            layout.tokens(800, 480),
            roles,
            sd.parse_sermon(_SAMPLE),
            screen,
            self.design,
        )

    @pytest.mark.parametrize(
        ("screen", "role"),
        [
            ("message", palette.Role.EMPHASIS),
            ("highlights", palette.Role.ALERT),
            ("apply", palette.Role.AVAILABLE),
            ("reflect", palette.Role.WARN),
        ],
    )
    def test_each_screen_has_its_own_colour(
        self, screen: sd.Screen, role: palette.Role
    ) -> None:
        params = self._params(screen)
        assert params["band"] == _rgb(role)
        text = palette.Role.INK if screen == "reflect" else palette.Role.PAPER
        assert params["on_band"] == _rgb(text)

    def test_mono_panel_never_puts_ink_text_on_an_ink_band(self) -> None:
        for screen in sd.SCREENS:
            params = self._params(screen, _MONO)
            assert params["band"] != params["on_band"], screen

    def test_sample_fits_without_truncation(self) -> None:
        sample = sd.parse_sermon(_SAMPLE)
        message = self._params("message")
        assert message["summary"] == [sample.summary]
        assert message["notes"] == ["Baptism"]
        assert message["title"] == sample.title
        points = self._params("highlights")
        assert [i["text"] for i in points["items"]] == sample.highlights
        apply = self._params("apply")
        assert [i["text"] for i in apply["items"]] == [t.text for t in sample.takeaways]
        assert [i["inferred"] for i in apply["items"]] == [False] * 4 + [True]
        reflect = self._params("reflect")
        assert reflect["reflection"]["text"] == sample.reflection.text  # type: ignore[union-attr]

    def test_footnote_only_where_inferred_text_shows(self) -> None:
        # The sample's last takeaway is inferred; its reflection is stated.
        assert self._params("apply")["footnote"] == sd.INFERRED_FOOTNOTE
        for screen in ("message", "highlights", "reflect"):
            assert self._params(screen)["footnote"] == ""

    def test_screen_position_tracks_the_screen(self) -> None:
        for idx, screen in enumerate(sd.SCREENS):
            params = self._params(screen)
            assert params["design"] == self.design
            assert params["screen_idx"] == idx
            assert params["screen_count"] == 4

    def test_no_sermon_frame(self) -> None:
        params = Sermon({"id": "sermon"}).build_params(
            layout.tokens(800, 480), _SIX, None, "message", self.design
        )
        assert params["empty"] and params["title"] == "No sermon yet"

    def test_overlong_title_shrinks_then_truncates(self) -> None:
        raw = {**_SAMPLE, "title": "Word " * 40}
        t = layout.tokens(800, 480)
        params = Sermon({"id": "sermon"}).build_params(
            t, _SIX, sd.parse_sermon(raw), "message", self.design
        )
        assert params["title"].endswith("…")
        assert params["px"]["title"] < 1.5 * t.base

    def test_reflect_accent_is_never_yellow_on_white(self) -> None:
        params = self._params("reflect")
        assert params["band"] == _rgb(palette.Role.WARN)
        assert params["accent"] == _rgb(palette.Role.INK)


class TestDesignSetting:
    def test_band_screens_label_the_kicker(self) -> None:
        for screen in sd.SCREENS:
            params = Sermon({"id": "sermon"}).build_params(
                layout.tokens(800, 480), _SIX, sd.parse_sermon(_SAMPLE), screen, "band"
            )
            assert params["kicker"] == sd.SCREEN_LABELS[screen]

    def test_sidebar_carries_name_and_meta(self) -> None:
        params = Sermon({"id": "sermon"}).build_params(
            layout.tokens(800, 480),
            _SIX,
            sd.parse_sermon(_SAMPLE),
            "reflect",
            "sidebar",
        )
        assert params["name_lines"] == ("Read &", "Reflect")
        assert [m["text"] for m in params["side_meta"]] == [
            "SUNDAY, SEP 27",
            "Fit for the King",
            "Joel Dombrow",
        ]

    def test_unknown_design_falls_back_to_the_default(self) -> None:
        assert sl.DEFAULT_DESIGN == "sidebar"
        assert sl.resolve_design(None) == "sidebar"
        assert sl.resolve_design("poster") == "sidebar"
        assert sl.resolve_design("band") == "band"

    def test_settings_schema_offers_both_designs(self) -> None:
        text = json.dumps(Sermon({"id": "sermon"}).build_settings_schema())
        assert '"design"' in text and '"band"' in text and '"sidebar"' in text

    @pytest.mark.parametrize("screen", sd.SCREENS)
    def test_sidebar_renders_each_screen(
        self, with_token: Any, monkeypatch: pytest.MonkeyPatch, screen: str
    ) -> None:
        monkeypatch.setattr(boardbot, "fetch_sermon_latest", lambda *a, **k: _SAMPLE)
        image = Sermon({"id": "sermon"}).generate_image(
            {**_SETTINGS, "screen": screen, "design": "sidebar"}, with_token
        )
        assert isinstance(image, Image.Image)
        assert image.size == tuple(with_token.get_resolution())


class TestFitHelpers:
    def test_badge_height_counts_for_single_line_items(self) -> None:
        plain = sd.block_height(["one line"], 700, 20, line_height=1.28)
        badged = sd.block_height(
            ["one line"], 700, 20, line_height=1.28, min_block=1.57
        )
        assert badged == pytest.approx(1.57 * 20) and badged > plain

    def test_fit_line_keeps_short_text(self) -> None:
        assert sd.fit_line("Short", 700, [37, 32]) == ("Short", 37)

    def test_chip_rows_wraps(self) -> None:
        assert sd.chip_rows([], 700, 18, 32) == 0
        assert sd.chip_rows(["Psalms 23"], 700, 18, 32) == 1
        assert sd.chip_rows(["Psalms 103:19"] * 12, 700, 18, 32) > 1
