# pyright: reportMissingImports=false
"""Tests for the sermon plugin and its pure helpers."""

from __future__ import annotations

from datetime import date
from typing import Any

import pytest
from PIL import Image

from homeboard.adapters import boardbot
from plugins.sermon import sermon_data as sd
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
        seen = [sd.screen_for_clock(h * 3600 + 5) for h in range(6)]
        assert seen[:3] == seen[3:]
        assert set(seen) == set(sd.SCREENS)

    def test_explicit_setting_overrides_clock(self) -> None:
        assert sd.resolve_screen("apply", 0) == "apply"
        assert sd.resolve_screen("auto", 0) == sd.screen_for_clock(0)
        assert sd.resolve_screen("bogus", 0) == sd.screen_for_clock(0)

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

    @pytest.mark.parametrize("screen", ["message", "apply", "reflect", "auto"])
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
        for screen in ("message", "apply"):
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
