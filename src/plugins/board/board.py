"""Board — projects (rotating backlog) + to-do (SPEC §7). The default
bedroom-dashboard screen.

Reads two lists (a rotation-tolerant Projects list and a show-everything
To-do list) from a self-hosted `boardbot` deployment
(github.com/cartagena/boardbot — a WhatsApp bridge + HTTP API replacing
Google Keep as the data source) via the read-only HTTP adapter, and
maintains a local item-age ledger since the source may not expose reliable
per-item creation timestamps (SPEC §4.5).
"""

from __future__ import annotations

import hashlib
import logging
import os
from collections.abc import Mapping
from datetime import date
from typing import Any

from homeboard import chrome, layout, palette, tags
from homeboard.adapters import boardbot
from homeboard.palette import Role
from plugins.base_plugin.base_plugin import BasePlugin, DeviceConfigLike
from plugins.base_plugin.settings_schema import field, row, schema, section
from plugins.board import board_data
from utils.payload_cache import CacheResult, atomic_write_json, read_json_or_none
from utils.time_utils import get_timezone, now_in_timezone

logger = logging.getLogger(__name__)

_DEFAULT_IN_FLIGHT_PREFIX = "*"
_DEFAULT_PROJECT_AGE_SHOW_DAYS = 0
_DEFAULT_PROJECT_AGE_WARN_DAYS = 90
_DEFAULT_PROJECT_AGE_ALERT_DAYS = 180
_DEFAULT_TODO_AGE_SHOW_DAYS = 14
_DEFAULT_TODO_AGE_WARN_DAYS = 30

# To-do age tags never escalate past the ink-outline tier (SPEC §7.6: only
# `todo_age_show_days`/`todo_age_warn_days` are configurable, deliberately
# no alert tier — "keeps the column quiet"). tags.age_tag() always needs an
# alert threshold, so this is set unreachably high (no todo item will ever
# be open a billion days).
_TODO_AGE_ALERT_DAYS = 1_000_000_000

# Vertical gap between the Projects and To-do sections when a portrait/
# near-square panel stacks them (SPEC §3.5). UNVERIFIED — no explicit
# metric given for this element.
_STACK_GAP_EM = 1.5


class Board(BasePlugin):
    def validate_settings(self, settings: Mapping[str, Any]) -> str | None:
        error = boardbot.validate_board_settings(settings)
        if error:
            return error

        project_show = self._int_setting(
            settings.get("project_age_show_days"), _DEFAULT_PROJECT_AGE_SHOW_DAYS
        )
        project_warn = self._int_setting(
            settings.get("project_age_warn_days"), _DEFAULT_PROJECT_AGE_WARN_DAYS
        )
        project_alert = self._int_setting(
            settings.get("project_age_alert_days"), _DEFAULT_PROJECT_AGE_ALERT_DAYS
        )
        error = board_data.validate_age_thresholds(
            "Project age", project_show, project_warn, project_alert
        )
        if error:
            return error

        todo_show = self._int_setting(
            settings.get("todo_age_show_days"), _DEFAULT_TODO_AGE_SHOW_DAYS
        )
        todo_warn = self._int_setting(
            settings.get("todo_age_warn_days"), _DEFAULT_TODO_AGE_WARN_DAYS
        )
        return board_data.validate_age_thresholds("To-do age", todo_show, todo_warn)

    def build_settings_schema(self) -> dict[str, object]:
        return schema(
            section(
                "Source",
                row(
                    field(
                        "base_url",
                        label="BoardBot URL",
                        required=True,
                        hint="Base URL of your boardbot deployment, e.g. http://piserver.local:8765",
                    ),
                ),
                field(
                    "in_flight_prefix",
                    label="In-flight Prefix",
                    default=_DEFAULT_IN_FLIGHT_PREFIX,
                    placeholder=_DEFAULT_IN_FLIGHT_PREFIX,
                ),
            ),
            section(
                "Thresholds",
                row(
                    field(
                        "project_age_show_days",
                        "number",
                        label="Project age: show (days)",
                        default=_DEFAULT_PROJECT_AGE_SHOW_DAYS,
                        min=0,
                        step=1,
                    ),
                    field(
                        "project_age_warn_days",
                        "number",
                        label="Project age: warn (days)",
                        default=_DEFAULT_PROJECT_AGE_WARN_DAYS,
                        min=0,
                        step=1,
                    ),
                    field(
                        "project_age_alert_days",
                        "number",
                        label="Project age: alert (days)",
                        default=_DEFAULT_PROJECT_AGE_ALERT_DAYS,
                        min=0,
                        step=1,
                    ),
                ),
                row(
                    field(
                        "todo_age_show_days",
                        "number",
                        label="To-do age: show (days)",
                        default=_DEFAULT_TODO_AGE_SHOW_DAYS,
                        min=0,
                        step=1,
                    ),
                    field(
                        "todo_age_warn_days",
                        "number",
                        label="To-do age: warn (days)",
                        default=_DEFAULT_TODO_AGE_WARN_DAYS,
                        min=0,
                        step=1,
                    ),
                ),
            ),
        )

    def generate_settings_template(self) -> dict[str, object]:
        template_params = super().generate_settings_template()
        template_params["api_key"] = {
            "required": True,
            "service": "BoardBot",
            "expected_key": boardbot.BOARDBOT_API_TOKEN_ENV_KEY,
        }
        return template_params

    def generate_image(
        self, settings: Mapping[str, Any], device_config: DeviceConfigLike
    ) -> Any:
        error = boardbot.validate_board_settings(settings)
        if error:
            raise RuntimeError(error)

        base_url = str(settings["base_url"]).strip()
        in_flight_prefix = self._str_setting(
            settings.get("in_flight_prefix"), _DEFAULT_IN_FLIGHT_PREFIX
        )

        project_age_show = self._int_setting(
            settings.get("project_age_show_days"), _DEFAULT_PROJECT_AGE_SHOW_DAYS
        )
        project_age_warn = self._int_setting(
            settings.get("project_age_warn_days"), _DEFAULT_PROJECT_AGE_WARN_DAYS
        )
        project_age_alert = self._int_setting(
            settings.get("project_age_alert_days"), _DEFAULT_PROJECT_AGE_ALERT_DAYS
        )
        todo_age_show = self._int_setting(
            settings.get("todo_age_show_days"), _DEFAULT_TODO_AGE_SHOW_DAYS
        )
        todo_age_warn = self._int_setting(
            settings.get("todo_age_warn_days"), _DEFAULT_TODO_AGE_WARN_DAYS
        )

        dimensions = self.get_oriented_dimensions(device_config)
        t = layout.tokens(*dimensions)
        roles = palette.resolve(device_config)

        api_token = (
            device_config.load_env_key(boardbot.BOARDBOT_API_TOKEN_ENV_KEY) or ""
        )

        def _fetch_projects() -> list[dict[str, Any]]:
            return boardbot.fetch_checklist("projects", base_url, api_token)

        def _fetch_todo() -> list[dict[str, Any]]:
            return boardbot.fetch_checklist("todo", base_url, api_token)

        projects_result = self.cached_fetch(
            device_config, boardbot.cache_key(base_url, "projects"), _fetch_projects
        )
        todo_result = self.cached_fetch(
            device_config, boardbot.cache_key(base_url, "todo"), _fetch_todo
        )

        timezone_raw = device_config.get_config("timezone", default="UTC")
        timezone_name = timezone_raw if isinstance(timezone_raw, str) else "UTC"
        tz = get_timezone(timezone_name)
        today = now_in_timezone(timezone_name).date()

        source_text = "BoardBot"
        # Two independent fetches, two independent CacheResults — show the
        # more pessimistic freshness status of the pair so a reader is
        # never told "Synced" when one of the two notes is actually
        # serving cached (or, worse, zero) data. Ranked worst-first: a
        # never-succeeded fetch (empty) outranks a stale one, which
        # outranks fresh — comparing only `.stale` would treat `.empty`
        # (fetch failed with nothing cached at all) as equivalent to
        # fresh, since neither sets `stale`.
        sync_text = chrome.sync_text(
            self._worse_cache_result(projects_result, todo_result), tz
        )

        both_empty = projects_result.empty and todo_result.empty
        base_params: dict[str, Any] = {
            "root_css": "",
            "header_html": "",
            "footer_html": "",
            "extra_css_files": [chrome.CHROME_CSS_PATH],
            "empty_html": "",
            "too_small": False,
            "in_flight": [],
            "backlog": [],
            "todo": [],
            "todo_empty": False,
            "cleared_count": 0,
            "projects_meta": "",
            "todo_meta": "",
            "stacked": not t.landscape,
            "todo_top_css": "var(--body-top)",
            "projects_column_h_px": 0,
            "todo_column_h_px": 0,
            "backlog_label_top_px": 0,
            "backlog_start_px": 0,
            "in_flight_start_px": 0,
            "in_flight_pitch_px": 0,
            "backlog_pitch_px": 0,
            "todo_pitch_px": 0,
            "todo_cleared_top_px": 0,
        }

        if both_empty:
            chrome_html = chrome.build_chrome(
                t, roles, "Board", "", source_text, sync_text
            )
            base_params.update(chrome_html)
            base_params["empty_html"] = chrome.empty_state_html(
                "Board", "No data available"
            )
            return self._render(dimensions, base_params)

        # Two independent ledger files, keyed the same way as the two
        # payload caches (base_url + that list's own name) — a combined key
        # over both lists would reset both lists' age tracking whenever
        # either one changed.
        projects_ledger_path = self._ledger_path(device_config, base_url, "projects")
        todo_ledger_path = self._ledger_path(device_config, base_url, "todo")
        projects_ledger = read_json_or_none(projects_ledger_path) or {}
        todo_ledger = read_json_or_none(todo_ledger_path) or {}

        projects_raw = projects_result.payload or []
        todo_raw = todo_result.payload or []
        projects_current_items = [
            (
                board_data.ledger_key("projects", str(r.get("text", ""))),
                bool(r.get("checked")),
            )
            for r in projects_raw
        ]
        todo_current_items = [
            (
                board_data.ledger_key("todo", str(r.get("text", ""))),
                bool(r.get("checked")),
            )
            for r in todo_raw
        ]
        projects_ledger = board_data.prune_ledger(
            board_data.update_ledger(projects_ledger, projects_current_items, today),
            today,
        )
        todo_ledger = board_data.prune_ledger(
            board_data.update_ledger(todo_ledger, todo_current_items, today), today
        )
        atomic_write_json(projects_ledger_path, projects_ledger)
        atomic_write_json(todo_ledger_path, todo_ledger)

        open_project_rows = [r for r in projects_raw if not r.get("checked")]
        open_todo_rows = [r for r in todo_raw if not r.get("checked")]

        project_items = [
            board_data.parse_project_item(
                str(r.get("text", "")),
                in_flight_prefix,
                board_data.first_seen_of(
                    projects_ledger,
                    board_data.ledger_key("projects", str(r.get("text", ""))),
                    today,
                ),
                today,
                effort_days=self._int_or_none(r.get("effort_days")),
                priority=self._str_or_none(r.get("priority")),
                due_date=self._date_or_none(r.get("due_date")),
            )
            for r in open_project_rows
        ]
        todo_items = [
            board_data.parse_todo_item(
                str(r.get("text", "")),
                board_data.first_seen_of(
                    todo_ledger,
                    board_data.ledger_key("todo", str(r.get("text", ""))),
                    today,
                ),
                priority=self._str_or_none(r.get("priority")),
                due_date=self._date_or_none(r.get("due_date")),
            )
            for r in open_todo_rows
        ]

        in_flight_items = [p for p in project_items if p.in_flight]
        backlog_items = [p for p in project_items if not p.in_flight]

        stacked = not t.landscape
        if stacked:
            projects_body_em = todo_body_em = (t.body_height_em - _STACK_GAP_EM) / 2
        else:
            projects_body_em = todo_body_em = t.body_height_em

        visible_in_flight_count = min(
            len(in_flight_items), board_data.in_flight_capacity(projects_body_em)
        )
        backlog_cap = board_data.backlog_capacity(
            projects_body_em, visible_in_flight_count
        )
        visible_backlog_count = min(len(backlog_items), backlog_cap)

        todo_cap = board_data.todo_capacity(todo_body_em)
        visible_todo_count = min(len(todo_items), todo_cap)
        todo_is_empty = len(todo_items) == 0
        cleared_line_rows = board_data.todo_cleared_line_rows(
            visible_todo_count, todo_is_empty
        )

        projects_fits = board_data.projects_column_fits(
            projects_body_em, visible_in_flight_count, visible_backlog_count
        )
        todo_fits = board_data.todo_column_fits(todo_body_em, cleared_line_rows)
        if not projects_fits or not todo_fits:
            chrome_html = chrome.build_chrome(
                t, roles, "Board", "", source_text, sync_text
            )
            base_params.update(chrome_html)
            base_params["too_small"] = True
            return self._render(dimensions, base_params)

        visible_in_flight, overflow = board_data.select_in_flight(
            in_flight_items, visible_in_flight_count
        )
        visible_backlog = board_data.select_backlog(
            backlog_items,
            visible_backlog_count,
            today,
            seed_key=boardbot.cache_key(base_url, "projects"),
        )
        visible_todo = board_data.select_todo(todo_items, visible_todo_count)

        # SPEC §7.3 wants two independent titles+metas in the header
        # ("Projects" / "To do"), which doesn't fit the shared chrome
        # header's single title+meta slot (used as-is by every other
        # screen) — so header_html is overridden below with board's own
        # two-title markup, and only root_css/footer_html come from
        # build_chrome.
        chrome_html = chrome.build_chrome(t, roles, "Board", "", source_text, sync_text)
        base_params.update(chrome_html)
        base_params["header_html"] = ""

        projects_meta = f"{len(in_flight_items)} in flight" if in_flight_items else ""
        if overflow:
            projects_meta = f"{projects_meta} +{overflow}"
        base_params["projects_meta"] = projects_meta
        base_params["todo_meta"] = f"{len(todo_items)} open"

        column_w_pct = layout.CONTENT_W_PCT if stacked else layout.COL_W_PCT
        base_params["in_flight"] = [
            self._in_flight_params(item, t, column_w_pct, today, roles)
            for item in visible_in_flight
        ]
        base_params["backlog"] = [
            self._backlog_params(
                item,
                t,
                column_w_pct,
                today,
                project_age_show,
                project_age_warn,
                project_age_alert,
                roles,
            )
            for item in visible_backlog
        ]
        base_params["todo"] = [
            self._todo_params(
                item, t, column_w_pct, today, todo_age_show, todo_age_warn, roles
            )
            for item in visible_todo
        ]
        base_params["todo_empty"] = todo_is_empty
        # SPEC §7.3 places the "Cleared" line under the To-do column
        # specifically, so it counts to-do completions only, not projects.
        base_params["cleared_count"] = board_data.cleared_this_week(todo_ledger, today)

        base_params["stacked"] = stacked
        base_params["backlog_label_top_px"] = (
            board_data.backlog_label_top_em(visible_in_flight_count) * t.base
        )
        base_params["backlog_start_px"] = (
            board_data.backlog_start_em(visible_in_flight_count) * t.base
        )
        base_params["in_flight_start_px"] = board_data.IN_FLIGHT_LABEL_BAND_EM * t.base
        base_params["in_flight_pitch_px"] = board_data.IN_FLIGHT_PITCH_EM * t.base
        base_params["backlog_pitch_px"] = board_data.BACKLOG_PITCH_EM * t.base
        base_params["todo_pitch_px"] = board_data.TODO_PITCH_EM * t.base
        base_params["todo_cleared_top_px"] = (
            cleared_line_rows * board_data.TODO_PITCH_EM * t.base
        )
        base_params["projects_column_h_px"] = projects_body_em * t.base
        base_params["todo_column_h_px"] = todo_body_em * t.base
        if stacked:
            todo_top_px = (projects_body_em + _STACK_GAP_EM) * t.base
            base_params["todo_top_css"] = f"calc(var(--body-top) + {todo_top_px:.4f}px)"
        else:
            base_params["todo_top_css"] = "var(--body-top)"

        return self._render(dimensions, base_params)

    def _render(
        self, dimensions: tuple[int, int], template_params: dict[str, Any]
    ) -> Any:
        image = self.render_image(
            dimensions, "board.html", "board.css", template_params
        )
        if not image:
            raise RuntimeError("Failed to take screenshot, please check logs.")
        return image

    @staticmethod
    def _ledger_path(
        device_config: DeviceConfigLike, base_url: str, list_name: str
    ) -> str:
        # Keyed the same way as BasePlugin.cached_fetch's cache_key for
        # this list (base_url + that list's own name) — deliberately not
        # combined with the other list's name, so a settings change to one
        # doesn't reset the other's age tracking too.
        config_dir = os.path.dirname(device_config.config_file) or "."
        digest = hashlib.sha256(f"{base_url}:{list_name}".encode()).hexdigest()[:16]
        return os.path.join(
            config_dir, "plugin_cache", "board_ledger", f"{digest}.json"
        )

    @staticmethod
    def _str_setting(raw: Any, default: str) -> str:
        if isinstance(raw, str) and raw.strip():
            return raw
        return default

    @staticmethod
    def _int_setting(raw: Any, default: int) -> int:
        try:
            return max(0, int(raw))
        except (TypeError, ValueError):
            return default

    @staticmethod
    def _int_or_none(raw: Any) -> int | None:
        # boardbot validates effort_days is a positive int before ever
        # storing it, but this is a network response — never trust it
        # blindly on this side either. A whole-number float (e.g. a SQLite
        # REAL column round-tripping through JSON as 2.0) is coerced rather
        # than dropped; a fractional float (2.5) is not a valid day count
        # and falls through to None same as any other malformed value.
        if isinstance(raw, bool):
            return None
        if isinstance(raw, float) and raw.is_integer():
            raw = int(raw)
        if not isinstance(raw, int):
            return None
        return raw if raw > 0 else None

    @staticmethod
    def _str_or_none(raw: Any) -> str | None:
        return raw if isinstance(raw, str) and raw.strip() else None

    @staticmethod
    def _date_or_none(raw: Any) -> date | None:
        if not isinstance(raw, str) or not raw.strip():
            return None
        value = raw.strip()
        try:
            return date.fromisoformat(value)
        except ValueError:
            pass
        # boardbot's own contract (docs/api.md) is a bare YYYY-MM-DD date,
        # never a timestamp, but tolerate a leading date component anyway
        # (e.g. a datetime column that starts serializing with a time
        # part) rather than silently dropping an otherwise-valid due date.
        try:
            return date.fromisoformat(value[:10])
        except ValueError:
            logger.warning("boardbot returned an unparseable date: %r", raw)
            return None

    @staticmethod
    def _worse_cache_result(a: CacheResult, b: CacheResult) -> CacheResult:
        """The more pessimistic of two independent CacheResults, ranked
        empty (never succeeded, nothing cached) worse than stale (serving
        cached data) worse than fresh."""
        if a.empty or b.empty:
            return a if a.empty else b
        if a.stale or b.stale:
            return a if a.stale else b
        return a if a.synced_at else b

    @staticmethod
    def _in_flight_params(
        item: board_data.ProjectItem,
        t: layout.Tokens,
        column_w_pct: float,
        today: date,
        roles: palette.RoleMap,
    ) -> dict[str, Any]:
        title_w_px = t.width * column_w_pct / 100 * 0.8
        return {
            "title": layout.truncate(item.title, title_w_px, t.fs["item"]),
            "size_tag": _size_tag_params(item.size_tag),
            "priority_tag": _chip_params(tags.priority_tag(item.priority), roles),
            "due_tag": _chip_params(tags.due_tag(item.due_date, today), roles),
            "note_text": item.note_text,
        }

    @staticmethod
    def _backlog_params(
        item: board_data.ProjectItem,
        t: layout.Tokens,
        column_w_pct: float,
        today: date,
        age_show: int,
        age_warn: int,
        age_alert: int,
        roles: palette.RoleMap,
    ) -> dict[str, Any]:
        title_w_px = t.width * column_w_pct / 100 * 0.9
        age = tags.age_tag(
            board_data.days_since(item.first_seen, today), age_show, age_warn, age_alert
        )
        return {
            "title": layout.truncate(item.title, title_w_px, t.fs["cell"]),
            "size_tag": _size_tag_params(item.size_tag),
            "age_tag": _chip_params(age, roles),
            "priority_tag": _chip_params(tags.priority_tag(item.priority), roles),
            "due_tag": _chip_params(tags.due_tag(item.due_date, today), roles),
        }

    @staticmethod
    def _todo_params(
        item: board_data.TodoItem,
        t: layout.Tokens,
        column_w_pct: float,
        today: date,
        age_show: int,
        age_warn: int,
        roles: palette.RoleMap,
    ) -> dict[str, Any]:
        priority = tags.priority_tag(item.priority)
        due = tags.due_tag(item.due_date, today)
        age = tags.age_tag(
            board_data.days_since(item.first_seen, today),
            age_show,
            age_warn,
            _TODO_AGE_ALERT_DAYS,
        )
        # A to-do row lays title and chips out on one flex line (unlike
        # in-flight/backlog project rows, which put chips on their own
        # line below the title), so an untrimmed 0.75 title budget can
        # claim more width than the row has left once priority/due chips
        # (new — age_tag alone never needed this) actually render,
        # overflowing the column. This is a backstop against a pathologically
        # long title specifically — board.css's .board-todo-row width is
        # what actually keeps a short title + several chips from
        # overflowing (see that file's comment for why). UNVERIFIED
        # per-chip discount — no physical-panel measurement backs 0.08.
        chip_discount = sum(0.08 for tag in (priority, due) if tag is not None)
        title_w_px = t.width * (column_w_pct / 100 * 0.75 - chip_discount)
        return {
            "title": layout.truncate(item.title, title_w_px, t.fs["body"]),
            "age_tag": _chip_params(age, roles),
            "priority_tag": _chip_params(priority, roles),
            "due_tag": _chip_params(due, roles),
        }


def _size_tag_params(size_tag: tags.SizeTag | None) -> dict[str, Any] | None:
    if size_tag is None:
        return None
    return {
        "label": size_tag.label,
        "role": size_tag.role.value,
        "solid": size_tag.solid,
    }


_Chip = tags.AgeTag | tags.PriorityTag | tags.DueTag


def _chip_params(chip: _Chip | None, roles: palette.RoleMap) -> dict[str, Any] | None:
    """Shared rendering for AgeTag/PriorityTag/DueTag — all three are the
    same (label, role, solid) shape. The warn bucket's solid fill needs
    RoleMap.warn_is_solid, same as home_maintenance's due-soon chip and
    weekends' partly cell — an unconditional solid=True renders as
    invisible ink-on-ink text on the bw/mock palette (every non-ink/paper
    role collapses to black there)."""
    if chip is None:
        return None
    solid = roles.warn_is_solid if chip.role == Role.WARN else chip.solid
    return {"label": chip.label, "role": chip.role.value, "solid": solid}
