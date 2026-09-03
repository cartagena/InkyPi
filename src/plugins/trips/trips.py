"""Trips — booked trips with countdowns + trip ideas (SPEC §8.1).

Same adapter as home_maintenance (read-only Google Sheets, service
account), richer layout: a countdown block per booked trip plus a
target-window idea list below a section rule.
"""

from __future__ import annotations

import logging
from collections.abc import Mapping
from typing import Any

from homeboard import cache, chrome, layout, palette
from homeboard.adapters import gsheets
from plugins.base_plugin.base_plugin import BasePlugin, DeviceConfigLike
from plugins.base_plugin.settings_schema import field, row, schema, section
from plugins.trips.trips_data import (
    BOOKED_LABEL_BAND_EM,
    CARD_PITCH_EM,
    IDEA_PITCH_EM,
    SECTION_GAP_EM,
    fits_screen,
    parse_trip_row,
    select_booked,
    select_ideas,
    visible_counts,
)
from utils.time_utils import get_timezone, now_in_timezone

logger = logging.getLogger(__name__)

_DEFAULT_WORKSHEET = "Trips"
_SERVICE_ACCOUNT_ENV_KEY = "GOOGLE_SERVICE_ACCOUNT_JSON_PATH"

# Rendering-only layout constants (em of `base`) not needed by trips_data's
# row-count math. Card/idea pitch and the section-label spacing live in
# trips_data, imported above, since the row-count formulas depend on them.
_COUNTDOWN_H_EM = 4.2
_COUNTDOWN_W_PCT = 12.9
_TEXT_COL_START_PCT = 17.5


class Trips(BasePlugin):
    def validate_settings(self, settings: Mapping[str, Any]) -> str | None:
        sheet_id = settings.get("sheet_id")
        if not isinstance(sheet_id, str) or not sheet_id.strip():
            return "Sheet ID is required."
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

        dimensions = self.get_oriented_dimensions(device_config)
        t = layout.tokens(*dimensions)
        roles = palette.resolve(device_config)

        credentials_path = device_config.load_env_key(_SERVICE_ACCOUNT_ENV_KEY) or ""

        def _fetch() -> list[dict[str, str]]:
            return gsheets.read_worksheet(sheet_id, worksheet_name, credentials_path)

        result = cache.cached_fetch(
            self.get_plugin_dir("cache"), self.get_plugin_id(), _fetch
        )

        timezone_raw = device_config.get_config("timezone", default="UTC")
        timezone_name = timezone_raw if isinstance(timezone_raw, str) else "UTC"
        tz = get_timezone(timezone_name)
        today = now_in_timezone(timezone_name).date()

        source_text = f"Sheet · {worksheet_name}"
        sync_text = self._sync_text(result, tz)

        base_params: dict[str, Any] = {
            "root_css": "",
            "header_html": "",
            "footer_html": "",
            "extra_css_files": [chrome.CHROME_CSS_PATH],
            "booked": [],
            "ideas": [],
            "too_small": False,
            "empty_html": "",
            "countdown_w_pct": _COUNTDOWN_W_PCT,
            "countdown_h_px": _COUNTDOWN_H_EM * t.base,
            "text_col_start_pct": _TEXT_COL_START_PCT,
            "card_pitch_px": CARD_PITCH_EM * t.base,
            "idea_pitch_px": IDEA_PITCH_EM * t.base,
        }

        if result.empty:
            chrome_html = chrome.build_chrome(
                t, roles, "Trips", "", source_text, sync_text
            )
            base_params.update(chrome_html)
            base_params["empty_html"] = chrome.empty_state_html(
                "Trips", "No data available"
            )
            return self._render(dimensions, base_params)

        if not fits_screen(t):
            chrome_html = chrome.build_chrome(
                t, roles, "Trips", "", source_text, sync_text
            )
            base_params.update(chrome_html)
            base_params["too_small"] = True
            return self._render(dimensions, base_params)

        raw_rows = result.payload or []
        parsed = [parse_trip_row(raw) for raw in raw_rows]
        booked = select_booked(parsed, today)
        ideas = select_ideas(parsed)

        visible_booked_count, visible_ideas_count = visible_counts(
            t, len(booked), len(ideas)
        )
        visible_booked = booked[:visible_booked_count]
        visible_ideas = ideas[:visible_ideas_count]

        meta = f"{len(booked)} booked · {len(ideas)} ideas"
        chrome_html = chrome.build_chrome(
            t, roles, "Trips", meta, source_text, sync_text
        )
        base_params.update(chrome_html)
        base_params["booked"] = [
            {
                "name": b.name,
                "dates": self._format_date_range(b.start, b.end),
                "days_until": b.days_until,
                "next_action": b.next_action,
                "blocking": b.blocking,
            }
            for b in visible_booked
        ]
        base_params["ideas"] = [
            {"name": i.name, "target_window": i.target_window} for i in visible_ideas
        ]

        # Section geometry, computed in px (not em — see the note on
        # homeboard.layout.tokens_css for why an em value here would drift).
        booked_start_px = BOOKED_LABEL_BAND_EM * t.base
        booked_section_h_px = len(base_params["booked"]) * base_params["card_pitch_px"]
        section_gap_px = SECTION_GAP_EM * t.base
        idea_label_top_px = booked_start_px + booked_section_h_px + section_gap_px
        base_params["booked_start_px"] = booked_start_px
        base_params["idea_label_top_px"] = idea_label_top_px
        base_params["idea_start_px"] = idea_label_top_px + booked_start_px

        return self._render(dimensions, base_params)

    def _render(
        self, dimensions: tuple[int, int], template_params: dict[str, Any]
    ) -> Any:
        image = self.render_image(
            dimensions, "trips.html", "trips.css", template_params
        )
        if not image:
            raise RuntimeError("Failed to take screenshot, please check logs.")
        return image

    @staticmethod
    def _sync_text(result: cache.CacheResult, tz: Any) -> str:
        if result.synced_at is None:
            return ""
        stamp = result.synced_at.astimezone(tz).strftime("%a %-I:%M %p").lower()
        return f"As of {stamp}" if result.stale else f"Synced {stamp}"

    @staticmethod
    def _format_date_range(start: Any, end: Any) -> str:
        # "Fri 3 Oct – Sun 5 Oct" (SPEC §8.1 mockup)
        return f"{start.strftime('%a %-d %b')} – {end.strftime('%a %-d %b')}"
