"""Home — recurring household maintenance due dates (SPEC §8.2).

Simplest of the four bedroom-dashboard screens: one Google Sheet, no auth
exotica, fully deterministic given `now`. First end-to-end plugin built on
the homeboard shared module (SPEC §9 build order step 4).
"""

from __future__ import annotations

import logging
from collections.abc import Mapping
from datetime import date
from typing import Any

from homeboard import chrome, layout, palette
from homeboard.adapters import gsheets
from plugins.base_plugin.base_plugin import BasePlugin, DeviceConfigLike
from plugins.base_plugin.settings_schema import field, row, schema, section
from plugins.home_maintenance.due_dates import (
    IntervalUnit,
    Status,
    build_item,
    sort_items,
)
from utils.payload_cache import CacheResult
from utils.time_utils import get_timezone, now_in_timezone

logger = logging.getLogger(__name__)

_MIN_ROWS = 5
_MAX_ROWS = 10
# SPEC §8.2 only gives a row pitch (2.50em) for this screen, not a separate
# row height (unlike weekends' explicit pitch/height pair) — treated as
# packed with no inter-row gap until the physical-panel check (SPEC §9 step
# 2) says otherwise.
_ROW_PITCH_EM = 2.50
_ROW_HEIGHT_EM = _ROW_PITCH_EM

_DEFAULT_WORKSHEET = "Maintenance"
_DEFAULT_DUE_SOON_DAYS = 14

_SERVICE_ACCOUNT_ENV_KEY = "GOOGLE_SERVICE_ACCOUNT_JSON_PATH"


class HomeMaintenance(BasePlugin):
    def validate_settings(self, settings: Mapping[str, Any]) -> str | None:
        sheet_id = settings.get("sheet_id")
        if not isinstance(sheet_id, str) or not sheet_id.strip():
            return "Sheet ID is required."
        due_soon_raw = settings.get("due_soon_days")
        if due_soon_raw not in (None, ""):
            try:
                if int(due_soon_raw) < 0:
                    return "Due soon (days) must be zero or positive."
            except (TypeError, ValueError):
                return "Due soon (days) must be a whole number."
        return None

    def build_settings_schema(self) -> dict[str, object]:
        return schema(
            section(
                "Source",
                row(
                    field("sheet_id", label="Google Sheet ID", required=True),
                    field(
                        "worksheet_name",
                        label="Worksheet Name",
                        default=_DEFAULT_WORKSHEET,
                        placeholder=_DEFAULT_WORKSHEET,
                    ),
                ),
            ),
            section(
                "Thresholds",
                row(
                    field(
                        "due_soon_days",
                        "number",
                        label="Due soon (days)",
                        default=_DEFAULT_DUE_SOON_DAYS,
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
            "service": "Google Sheets (service account)",
            "expected_key": _SERVICE_ACCOUNT_ENV_KEY,
        }
        return template_params

    def generate_image(
        self, settings: Mapping[str, Any], device_config: DeviceConfigLike
    ) -> Any:
        sheet_id = settings.get("sheet_id")
        if not isinstance(sheet_id, str) or not sheet_id.strip():
            raise RuntimeError("Sheet ID is required")
        worksheet_name = settings.get("worksheet_name") or _DEFAULT_WORKSHEET
        if not isinstance(worksheet_name, str):
            worksheet_name = _DEFAULT_WORKSHEET
        due_soon_days = self._parse_due_soon_days(settings.get("due_soon_days"))

        dimensions = self.get_oriented_dimensions(device_config)
        t = layout.tokens(*dimensions)
        roles = palette.resolve(device_config)

        credentials_path = device_config.load_env_key(_SERVICE_ACCOUNT_ENV_KEY) or ""

        def _fetch() -> list[dict[str, str]]:
            return gsheets.read_worksheet(sheet_id, worksheet_name, credentials_path)

        cache_key = f"{sheet_id}:{worksheet_name}"
        result = self.cached_fetch(device_config, cache_key, _fetch)

        timezone_raw = device_config.get_config("timezone", default="UTC")
        timezone_name = timezone_raw if isinstance(timezone_raw, str) else "UTC"
        tz = get_timezone(timezone_name)
        today = now_in_timezone(timezone_name).date()
        template_params: dict[str, Any] = {
            "root_css": "",
            "header_html": "",
            "footer_html": "",
            "extra_css_files": [chrome.CHROME_CSS_PATH],
            "rows": [],
            # Absolute px, not em: an em value on `.hm-row` (which sets its
            # own font-size to --fs-item) would resolve against fs-item
            # rather than `base`, drifting the row pitch. See the note on
            # homeboard.layout.tokens_css for the general version of this.
            "row_pitch_px": _ROW_PITCH_EM * t.base,
            "total_count": 0,
        }

        sync_text = self._sync_text(result, tz)

        if result.empty:
            chrome_html = chrome.build_chrome(
                t, roles, "Home", "", "Google Sheets", sync_text
            )
            template_params.update(chrome_html)
            template_params["empty_html"] = chrome.empty_state_html(
                "Home", "No data available"
            )
            image = self.render_image(
                dimensions,
                "home_maintenance.html",
                "home_maintenance.css",
                template_params,
            )
            if not image:
                raise RuntimeError("Failed to take screenshot, please check logs.")
            return image

        raw_rows = result.payload or []
        items = sort_items(
            [self._parse_row(raw, today, due_soon_days) for raw in raw_rows]
        )

        max_rows = layout.row_count(
            t, _ROW_PITCH_EM, _ROW_HEIGHT_EM, _MIN_ROWS, _MAX_ROWS
        )
        visible = items[:max_rows]

        meta = f"{len(items)} tasks" if len(items) != max_rows else ""
        chrome_html = chrome.build_chrome(
            t, roles, "Home", meta, "Google Sheets", sync_text
        )
        template_params.update(chrome_html)
        template_params["total_count"] = len(items)
        template_params["rows"] = [
            self._row_template_params(item, t.width) for item in visible
        ]

        image = self.render_image(
            dimensions,
            "home_maintenance.html",
            "home_maintenance.css",
            template_params,
        )
        if not image:
            raise RuntimeError("Failed to take screenshot, please check logs.")
        return image

    @staticmethod
    def _parse_due_soon_days(raw: Any) -> int:
        try:
            return max(0, int(raw))
        except (TypeError, ValueError):
            return _DEFAULT_DUE_SOON_DAYS

    @staticmethod
    def _sync_text(result: CacheResult, tz: Any) -> str:
        if result.synced_at is None:
            return ""
        stamp = result.synced_at.astimezone(tz).strftime("%a %-I:%M %p").lower()
        return f"As of {stamp}" if result.stale else f"Synced {stamp}"

    @staticmethod
    def _parse_row(raw: Mapping[str, str], today: date, due_soon_days: int) -> Any:
        task = str(raw.get("task", "")).strip()
        unit_raw = str(raw.get("interval_unit", "")).strip().lower()
        try:
            interval_unit = IntervalUnit(unit_raw)
        except ValueError:
            interval_unit = IntervalUnit.SEASONAL

        interval_value = HomeMaintenance._parse_int(raw.get("interval_value"))
        last_done = HomeMaintenance._parse_date(raw.get("last_done"))
        next_due_override = HomeMaintenance._parse_date(raw.get("next_due_override"))

        return build_item(
            task,
            interval_value,
            interval_unit,
            last_done,
            next_due_override,
            today,
            due_soon_days,
        )

    @staticmethod
    def _parse_int(raw: Any) -> int | None:
        if raw in (None, ""):
            return None
        try:
            return int(str(raw).strip())
        except ValueError:
            return None

    @staticmethod
    def _parse_date(raw: Any) -> date | None:
        if raw in (None, ""):
            return None
        try:
            return date.fromisoformat(str(raw).strip())
        except ValueError:
            return None

    @staticmethod
    def _row_template_params(item: Any, width_px: int) -> dict[str, Any]:
        chip = None
        if item.status == Status.OVERDUE:
            chip = {
                "label": f"Overdue {item.days_overdue} d",
                "role": "alert",
                "solid": True,
            }
        elif item.status == Status.DUE_SOON:
            chip = {
                "label": f"Due in {item.days_until_due} days",
                "role": "warn",
                "solid": True,
            }

        due_text = ""
        if chip is None:
            due_text = (
                item.next_due.strftime("%b %Y") if item.next_due else item.interval_text
            )

        return {
            "task": item.task,
            "interval_text": item.interval_text,
            "chip": chip,
            "due_text": due_text,
        }
