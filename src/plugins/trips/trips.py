"""Trips — booked trips with countdowns + trip ideas (SPEC §8.1).

Same adapter as home_maintenance (read-only Google Sheets, service
account), richer layout: a countdown block per booked trip plus a
target-window idea list below a section rule.
"""

from __future__ import annotations

import logging
from collections.abc import Mapping
from typing import Any

from homeboard import chrome, layout, palette
from homeboard.adapters import gsheets
from plugins.base_plugin.base_plugin import BasePlugin, DeviceConfigLike
from plugins.base_plugin.settings_schema import field, row, schema, section
from plugins.trips.trips_data import (
    BOOKED_LABEL_BAND_EM,
    CARD_PITCH_EM,
    IDEA_PITCH_EM,
    fits_screen,
    idea_label_top_em,
    idea_start_em,
    parse_trip_row,
    screen_fits,
    select_booked,
    select_ideas,
    visible_counts,
)
from utils.time_utils import get_timezone, now_in_timezone

logger = logging.getLogger(__name__)

_DEFAULT_WORKSHEET = "Trips"

# Rendering-only layout constants (em/pct of `base`/width) not needed by
# trips_data's row-count math. Card/idea pitch and the section-label
# spacing live in trips_data, imported above, since the row-count formulas
# depend on them.
_COUNTDOWN_H_EM = 4.2
_COUNTDOWN_W_PCT = 12.9
_TEXT_COL_START_PCT = 17.5
_CONTENT_END_PCT = 97.5  # margin-x (2.5%) + content-w (95%)
# SPEC §8.1's idea row is a flex space-between with no explicit title/window
# split — approximated as roughly even, biased toward the title, pending
# the physical-panel check (SPEC §9 step 2) like the other em-based
# assumptions in this build.
_IDEA_TITLE_PCT = 55.0
_IDEA_WINDOW_PCT = 40.0


class Trips(BasePlugin):
    def validate_settings(self, settings: Mapping[str, Any]) -> str | None:
        return gsheets.validate_sheet_settings(settings)

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
            "expected_key": gsheets.SERVICE_ACCOUNT_ENV_KEY,
        }
        return template_params

    def generate_image(
        self, settings: Mapping[str, Any], device_config: DeviceConfigLike
    ) -> Any:
        sheet_id, worksheet_name = gsheets.resolve_sheet_settings(
            settings, _DEFAULT_WORKSHEET
        )

        dimensions = self.get_oriented_dimensions(device_config)
        t = layout.tokens(*dimensions)
        roles = palette.resolve(device_config)

        credentials_path = (
            device_config.load_env_key(gsheets.SERVICE_ACCOUNT_ENV_KEY) or ""
        )

        def _fetch() -> list[dict[str, str]]:
            return gsheets.read_worksheet(sheet_id, worksheet_name, credentials_path)

        cache_key = gsheets.cache_key(sheet_id, worksheet_name)
        result = self.cached_fetch(device_config, cache_key, _fetch)

        timezone_raw = device_config.get_config("timezone", default="UTC")
        timezone_name = timezone_raw if isinstance(timezone_raw, str) else "UTC"
        tz = get_timezone(timezone_name)
        today = now_in_timezone(timezone_name).date()

        source_text = f"Sheet · {worksheet_name}"
        sync_text = chrome.sync_text(result, tz)

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

        if not screen_fits(t, visible_booked_count, visible_ideas_count):
            # visible_counts() still guarantees MIN_IDEAS rows once there's
            # idea data, even if this exact panel has no room for them —
            # SPEC §3.5's fallback, not a partial/overflowing render.
            chrome_html = chrome.build_chrome(
                t, roles, "Trips", "", source_text, sync_text
            )
            base_params.update(chrome_html)
            base_params["too_small"] = True
            return self._render(dimensions, base_params)

        visible_booked = booked[:visible_booked_count]
        visible_ideas = ideas[:visible_ideas_count]

        meta = f"{len(booked)} booked · {len(ideas)} ideas"
        chrome_html = chrome.build_chrome(
            t, roles, "Trips", meta, source_text, sync_text
        )
        base_params.update(chrome_html)

        text_col_w_px = t.width * (_CONTENT_END_PCT - _TEXT_COL_START_PCT) / 100
        title_fs_px = t.fs["title"] * 0.9
        idea_title_w_px = t.width * _IDEA_TITLE_PCT / 100
        idea_window_w_px = t.width * _IDEA_WINDOW_PCT / 100

        base_params["booked"] = [
            {
                "name": layout.truncate(b.name, text_col_w_px, title_fs_px),
                "dates": self._format_date_range(b.start, b.end),
                "days_until": b.days_until,
                "next_action": layout.truncate(
                    b.next_action, text_col_w_px, t.fs["label"]
                ),
                "blocking": b.blocking,
            }
            for b in visible_booked
        ]
        base_params["ideas"] = [
            {
                "name": layout.truncate(i.name, idea_title_w_px, t.fs["item"]),
                "target_window": layout.truncate(
                    i.target_window, idea_window_w_px, t.fs["cell"]
                ),
            }
            for i in visible_ideas
        ]

        # Section geometry, computed in px (not em — see the note on
        # homeboard.layout.tokens_css for why an em value here would drift)
        # and, for the idea section, via trips_data's own
        # idea_label_top_em()/idea_start_em() so this can never drift from
        # visible_counts()'s capacity math again (that drift was a real,
        # confirmed overflow bug on smaller panels — see trips_data.py).
        base_params["booked_start_px"] = BOOKED_LABEL_BAND_EM * t.base
        base_params["idea_label_top_px"] = (
            idea_label_top_em(visible_booked_count) * t.base
        )
        base_params["idea_start_px"] = idea_start_em(visible_booked_count) * t.base

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
    def _format_date_range(start: Any, end: Any) -> str:
        # "Fri 3 Oct – Sun 5 Oct" (SPEC §8.1 mockup)
        return f"{start.strftime('%a %-d %b')} – {end.strftime('%a %-d %b')}"
