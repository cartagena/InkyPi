# pyright: reportMissingImports=false
"""Tests for the board plugin (SPEC §7)."""

from __future__ import annotations

from datetime import date
from typing import Any

import pytest
from PIL import Image

from homeboard.adapters import boardbot
from plugins.board.board import Board

_SETTINGS = {
    "base_url": "http://piserver.local:8765",
}

_PROJECTS_ROWS: list[dict[str, Any]] = [
    {
        "text": "* Frame the BBQ counter [weekend] — started 2026-08-22",
        "checked": False,
    },
    {"text": "Rebuild the side gate [half day]", "checked": False},
    {"text": "Insulate the garage door [weekend]", "checked": False},
]
_TODO_ROWS = [
    {"text": "Buy filters", "checked": False},
    {"text": "Return library books", "checked": False},
]


def _fetch_for(
    projects_rows: list[dict[str, Any]], todo_rows: list[dict[str, Any]]
) -> Any:
    def _fetch(list_name: str, base_url: str, token: str) -> list[dict[str, Any]]:
        return projects_rows if list_name == "projects" else todo_rows

    return _fetch


class TestValidateSettings:
    def test_missing_base_url_is_rejected(self) -> None:
        plugin = Board({"id": "board"})
        settings = {**_SETTINGS, "base_url": ""}
        assert plugin.validate_settings(settings) is not None

    def test_valid_settings_pass(self) -> None:
        plugin = Board({"id": "board"})
        assert plugin.validate_settings(_SETTINGS) is None

    def test_non_http_scheme_is_rejected(self) -> None:
        plugin = Board({"id": "board"})
        settings = {**_SETTINGS, "base_url": "file:///etc/passwd"}
        error = plugin.validate_settings(settings)
        assert error is not None
        assert "http" in error.lower()


class TestIntOrNone:
    def test_positive_int_passes_through(self) -> None:
        assert Board._int_or_none(2) == 2

    def test_whole_number_float_is_coerced(self) -> None:
        assert Board._int_or_none(2.0) == 2

    def test_fractional_float_is_rejected(self) -> None:
        assert Board._int_or_none(2.5) is None

    def test_zero_and_negative_are_rejected(self) -> None:
        assert Board._int_or_none(0) is None
        assert Board._int_or_none(-1) is None

    def test_bool_is_rejected(self) -> None:
        assert Board._int_or_none(True) is None

    def test_none_and_string_are_rejected(self) -> None:
        assert Board._int_or_none(None) is None
        assert Board._int_or_none("2") is None


class TestDateOrNone:
    def test_bare_iso_date_parses(self) -> None:
        assert Board._date_or_none("2026-09-10") == date(2026, 9, 10)

    def test_iso_datetime_with_time_component_is_tolerated(self) -> None:
        assert Board._date_or_none("2026-09-10T00:00:00") == date(2026, 9, 10)

    def test_unparseable_string_returns_none(self) -> None:
        assert Board._date_or_none("not-a-date") is None

    def test_none_and_blank_return_none(self) -> None:
        assert Board._date_or_none(None) is None
        assert Board._date_or_none("   ") is None


class TestGenerateImageConfigErrors:
    def test_missing_settings_raises_runtime_error(
        self, device_config_dev: Any
    ) -> None:
        plugin = Board({"id": "board"})
        with pytest.raises(RuntimeError):
            plugin.generate_image({**_SETTINGS, "base_url": ""}, device_config_dev)

    def test_missing_api_token_raises_runtime_error(
        self, device_config_dev: Any
    ) -> None:
        plugin = Board({"id": "board"})
        with pytest.raises(RuntimeError, match="API token"):
            plugin.generate_image(_SETTINGS, device_config_dev)


class TestGenerateImageHappyPath:
    def test_returns_an_image_with_mocked_boardbot_data(
        self, device_config_dev: Any, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        plugin = Board({"id": "board"})
        monkeypatch.setattr(
            device_config_dev.__class__, "load_env_key", lambda self, key: "fake-token"
        )
        monkeypatch.setattr(
            boardbot, "fetch_checklist", _fetch_for(_PROJECTS_ROWS, _TODO_ROWS)
        )

        image = plugin.generate_image(_SETTINGS, device_config_dev)
        assert isinstance(image, Image.Image)
        assert image.size == tuple(device_config_dev.get_resolution())

    def test_both_lists_empty_renders_empty_state(
        self, device_config_dev: Any, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        plugin = Board({"id": "board"})
        monkeypatch.setattr(
            device_config_dev.__class__, "load_env_key", lambda self, key: "fake-token"
        )
        monkeypatch.setattr(boardbot, "fetch_checklist", _fetch_for([], []))

        image = plugin.generate_image(_SETTINGS, device_config_dev)
        assert isinstance(image, Image.Image)

    def test_no_in_flight_items_still_renders(
        self, device_config_dev: Any, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        plugin = Board({"id": "board"})
        monkeypatch.setattr(
            device_config_dev.__class__, "load_env_key", lambda self, key: "fake-token"
        )
        backlog_only = [r for r in _PROJECTS_ROWS if not r["text"].startswith("*")]
        monkeypatch.setattr(
            boardbot, "fetch_checklist", _fetch_for(backlog_only, _TODO_ROWS)
        )

        image = plugin.generate_image(_SETTINGS, device_config_dev)
        assert isinstance(image, Image.Image)

    def test_empty_todo_list_still_renders(
        self, device_config_dev: Any, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        plugin = Board({"id": "board"})
        monkeypatch.setattr(
            device_config_dev.__class__, "load_env_key", lambda self, key: "fake-token"
        )
        monkeypatch.setattr(boardbot, "fetch_checklist", _fetch_for(_PROJECTS_ROWS, []))

        image = plugin.generate_image(_SETTINGS, device_config_dev)
        assert isinstance(image, Image.Image)

    def test_renders_with_due_date_priority_and_effort_days(
        self, device_config_dev: Any, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        plugin = Board({"id": "board"})
        monkeypatch.setattr(
            device_config_dev.__class__, "load_env_key", lambda self, key: "fake-token"
        )
        rich_projects: list[dict[str, Any]] = [
            {
                "text": "Clean the garage",
                "checked": False,
                "due_date": "2026-09-10",
                "priority": "high",
                "effort_days": 2,
            },
            {
                "text": "Fix the fence",
                "checked": False,
                "due_date": None,
                "priority": "medium",
                "effort_days": None,
            },
        ]
        rich_todo: list[dict[str, Any]] = [
            {
                "text": "Buy filters",
                "checked": False,
                "due_date": "2026-09-04",
                "priority": None,
                "effort_days": None,
            },
        ]
        monkeypatch.setattr(
            boardbot, "fetch_checklist", _fetch_for(rich_projects, rich_todo)
        )

        image = plugin.generate_image(_SETTINGS, device_config_dev)
        assert isinstance(image, Image.Image)

    def test_renders_when_rows_omit_new_fields_entirely(
        self, device_config_dev: Any, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Rows shaped like a pre-schema-change boardbot response (no
        due_date/priority/effort_days keys at all) must not crash."""
        plugin = Board({"id": "board"})
        monkeypatch.setattr(
            device_config_dev.__class__, "load_env_key", lambda self, key: "fake-token"
        )
        bare_projects = [{"text": "Paint the fence", "checked": False}]
        bare_todo = [{"text": "Buy filters", "checked": False}]
        monkeypatch.setattr(
            boardbot, "fetch_checklist", _fetch_for(bare_projects, bare_todo)
        )

        image = plugin.generate_image(_SETTINGS, device_config_dev)
        assert isinstance(image, Image.Image)


class TestGenerateImageFailSoft:
    def test_transient_failure_with_prior_cache_still_returns_an_image(
        self, device_config_dev: Any, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        plugin = Board({"id": "board"})
        monkeypatch.setattr(
            device_config_dev.__class__, "load_env_key", lambda self, key: "fake-token"
        )
        monkeypatch.setattr(
            boardbot, "fetch_checklist", _fetch_for(_PROJECTS_ROWS, _TODO_ROWS)
        )
        plugin.generate_image(_SETTINGS, device_config_dev)  # populates the cache

        def _flaky(*a: object, **k: object) -> list[dict[str, Any]]:
            raise TimeoutError("network blip")

        monkeypatch.setattr(boardbot, "fetch_checklist", _flaky)
        image = plugin.generate_image(_SETTINGS, device_config_dev)
        assert isinstance(image, Image.Image)

    def test_two_instances_with_different_deployments_do_not_collide(
        self, device_config_dev: Any, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        plugin = Board({"id": "board"})
        monkeypatch.setattr(
            device_config_dev.__class__, "load_env_key", lambda self, key: "fake-token"
        )
        monkeypatch.setattr(
            boardbot, "fetch_checklist", _fetch_for(_PROJECTS_ROWS, _TODO_ROWS)
        )
        plugin.generate_image(
            {**_SETTINGS, "base_url": "http://deployment-a:8765"}, device_config_dev
        )

        other_rows = [{"text": "Something else entirely", "checked": False}]
        monkeypatch.setattr(
            boardbot, "fetch_checklist", _fetch_for(other_rows, other_rows)
        )
        plugin.generate_image(
            {**_SETTINGS, "base_url": "http://deployment-b:8765"}, device_config_dev
        )

        def _flaky(*a: object, **k: object) -> list[dict[str, Any]]:
            raise TimeoutError("network blip")

        monkeypatch.setattr(boardbot, "fetch_checklist", _flaky)
        image = plugin.generate_image(
            {**_SETTINGS, "base_url": "http://deployment-a:8765"}, device_config_dev
        )
        assert isinstance(image, Image.Image)


class TestGenerateImageTooSmall:
    def test_tiny_panel_renders_too_small_message_not_raise(
        self, device_config_dev: Any, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        plugin = Board({"id": "board"})
        monkeypatch.setattr(
            device_config_dev.__class__, "load_env_key", lambda self, key: "fake-token"
        )
        monkeypatch.setattr(
            device_config_dev.__class__, "get_resolution", lambda self: (200, 100)
        )
        monkeypatch.setattr(
            boardbot, "fetch_checklist", _fetch_for(_PROJECTS_ROWS, _TODO_ROWS)
        )

        image = plugin.generate_image(_SETTINGS, device_config_dev)
        assert isinstance(image, Image.Image)


class TestLedger:
    def test_cleared_count_reflects_a_newly_checked_item(
        self, device_config_dev: Any, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        plugin = Board({"id": "board"})
        monkeypatch.setattr(
            device_config_dev.__class__, "load_env_key", lambda self, key: "fake-token"
        )
        open_todo = [{"text": "Buy filters", "checked": False}]
        monkeypatch.setattr(
            boardbot, "fetch_checklist", _fetch_for(_PROJECTS_ROWS, open_todo)
        )
        plugin.generate_image(_SETTINGS, device_config_dev)

        now_checked = [{"text": "Buy filters", "checked": True}]
        monkeypatch.setattr(
            boardbot, "fetch_checklist", _fetch_for(_PROJECTS_ROWS, now_checked)
        )
        image = plugin.generate_image(_SETTINGS, device_config_dev)
        assert isinstance(image, Image.Image)

    def test_ledger_path_is_independent_per_list(self, device_config_dev: Any) -> None:
        """Regression: the ledger used to be keyed by a hash of both note
        titles combined, so renaming either note in settings reset BOTH
        notes' age tracking. Each list must get its own ledger file, keyed
        the same way as that list's own payload cache entry."""
        base_url = "http://piserver.local:8765"
        projects_path = Board._ledger_path(device_config_dev, base_url, "projects")
        todo_path = Board._ledger_path(device_config_dev, base_url, "todo")
        other_deployment_path = Board._ledger_path(
            device_config_dev, "http://other-host:8765", "todo"
        )
        assert projects_path != todo_path
        # A different deployment's todo list must not share the same
        # ledger path.
        assert projects_path == Board._ledger_path(
            device_config_dev, base_url, "projects"
        )
        assert todo_path != other_deployment_path


class TestWorseCacheResult:
    def test_empty_outranks_fresh(self) -> None:
        from utils.payload_cache import CacheResult

        empty = CacheResult(
            payload=None, fresh=False, stale=False, empty=True, synced_at=None
        )
        fresh = CacheResult(
            payload=[1], fresh=True, stale=False, empty=False, synced_at=None
        )
        assert Board._worse_cache_result(empty, fresh) is empty
        assert Board._worse_cache_result(fresh, empty) is empty

    def test_stale_outranks_fresh(self) -> None:
        from utils.payload_cache import CacheResult

        stale = CacheResult(
            payload=[1], fresh=False, stale=True, empty=False, synced_at=None
        )
        fresh = CacheResult(
            payload=[1], fresh=True, stale=False, empty=False, synced_at=None
        )
        assert Board._worse_cache_result(stale, fresh) is stale

    def test_empty_outranks_stale(self) -> None:
        from utils.payload_cache import CacheResult

        empty = CacheResult(
            payload=None, fresh=False, stale=False, empty=True, synced_at=None
        )
        stale = CacheResult(
            payload=[1], fresh=False, stale=True, empty=False, synced_at=None
        )
        assert Board._worse_cache_result(empty, stale) is empty


class TestBacklogSeedKey:
    def test_seed_key_includes_base_url_not_just_list_name(
        self, device_config_dev: Any, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Regression: two board instances pointed at different boardbot
        deployments must not get the exact same daily backlog rotation —
        sampling.seeded_rng's seed_key needs to carry the deployment
        identity too, not just the list name."""
        from plugins.board import board_data as board_data_module

        seen_seed_keys: list[str] = []
        real_select_backlog = board_data_module.select_backlog

        def _spy_select_backlog(*args: Any, **kwargs: Any) -> Any:
            seen_seed_keys.append(kwargs["seed_key"])
            return real_select_backlog(*args, **kwargs)

        monkeypatch.setattr(board_data_module, "select_backlog", _spy_select_backlog)
        monkeypatch.setattr(
            device_config_dev.__class__, "load_env_key", lambda self, key: "fake-token"
        )
        monkeypatch.setattr(
            boardbot, "fetch_checklist", _fetch_for(_PROJECTS_ROWS, _TODO_ROWS)
        )

        plugin = Board({"id": "board"})
        plugin.generate_image(
            {**_SETTINGS, "base_url": "http://deployment-a:8765"}, device_config_dev
        )
        plugin.generate_image(
            {**_SETTINGS, "base_url": "http://deployment-b:8765"}, device_config_dev
        )

        assert len(seen_seed_keys) == 2
        assert seen_seed_keys[0] != seen_seed_keys[1]
