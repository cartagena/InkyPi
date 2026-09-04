"""Weekends — free/partly/booked weekend lookahead (SPEC §6).

Reads one or more ICS-over-HTTP calendar feeds (product decision: not the
Google Calendar API — see the shared adapter's docstring for why) and an
optional holiday feed, classifies each upcoming weekend, and renders a
column-per-day grid where free time reads as whitespace.
"""

from __future__ import annotations

import hashlib
import logging
from collections.abc import Mapping
from datetime import date, timedelta
from typing import Any

from homeboard import chrome, layout, palette
from homeboard.adapters import ical
from plugins.base_plugin.base_plugin import BasePlugin, DeviceConfigLike
from plugins.base_plugin.settings_schema import field, row, schema, section
from plugins.weekends.classify import (
    apply_long_weekend,
    classify_weekend,
    holiday_dates,
    parse_event,
    weekend_dates,
)
from utils.time_utils import get_timezone, now_in_timezone

logger = logging.getLogger(__name__)

_MIN_ROWS = 4
_MAX_ROWS = 6
_ROW_PITCH_EM = 3.10
_ROW_HEIGHT_EM = 2.75
_HEADER_BAND_EM = 1.15  # column-label row (Saturday/Sunday)

_DATE_COL_END_PCT = 18.0
_SAT_CELL_START_PCT = 18.75
_SAT_CELL_END_PCT = 58.1
_SUN_CELL_START_PCT = 59.4
_SUN_CELL_END_PCT = 97.5
_CELL_TEXT_INSET_PCT = 1.9

_DEFAULT_WEEKENDS_AHEAD = 6
_DEFAULT_PARTLY_HOURS = 2.0
_DEFAULT_FULL_DAY_HOURS = 6.0
_DEFAULT_IGNORE_RECURRING_MINUTES = 120


class Weekends(BasePlugin):
    def validate_settings(self, settings: Mapping[str, Any]) -> str | None:
        return ical.validate_ics_urls(settings.get("ics_urls"))

    def build_settings_schema(self) -> dict[str, object]:
        return schema(
            section(
                "Calendars",
                field(
                    "ics_urls",
                    "textarea",
                    label="Calendar ICS URLs",
                    hint="One URL per line (or comma-separated).",
                    required=True,
                ),
                field(
                    "holiday_ics_url",
                    label="Holiday calendar ICS URL",
                    hint="Optional — used for long-weekend detection.",
                ),
            ),
            section(
                "Thresholds",
                row(
                    field(
                        "weekends_ahead",
                        "number",
                        label="Weekends ahead",
                        default=_DEFAULT_WEEKENDS_AHEAD,
                        min=1,
                        step=1,
                    ),
                    field(
                        "partly_hours",
                        "number",
                        label="Partly-booked threshold (hours)",
                        default=_DEFAULT_PARTLY_HOURS,
                        min=0,
                        step=0.5,
                    ),
                    field(
                        "full_day_hours",
                        "number",
                        label="Fully-booked threshold (hours)",
                        default=_DEFAULT_FULL_DAY_HOURS,
                        min=0,
                        step=0.5,
                    ),
                ),
                row(
                    field(
                        "ignore_recurring_minutes",
                        "number",
                        label="Ignore recurring events under (minutes)",
                        default=_DEFAULT_IGNORE_RECURRING_MINUTES,
                        min=0,
                        step=15,
                    ),
                    field(
                        "school_out_pattern",
                        label="School-out pattern (regex)",
                        hint="Matched against all-day event summaries. Optional.",
                    ),
                ),
            ),
        )

    def generate_image(
        self, settings: Mapping[str, Any], device_config: DeviceConfigLike
    ) -> Any:
        ics_urls = ical.parse_ics_urls(settings.get("ics_urls"))
        if not ics_urls:
            raise RuntimeError("At least one calendar URL is required")

        holiday_url_raw = settings.get("holiday_ics_url")
        holiday_url = (
            holiday_url_raw.strip() if isinstance(holiday_url_raw, str) else ""
        )
        school_out_pattern_raw = settings.get("school_out_pattern")
        school_out_pattern = (
            school_out_pattern_raw.strip()
            if isinstance(school_out_pattern_raw, str)
            else ""
        )

        weekends_ahead = self._parse_int(
            settings.get("weekends_ahead"), _DEFAULT_WEEKENDS_AHEAD, minimum=1
        )
        partly_hours = self._parse_float(
            settings.get("partly_hours"), _DEFAULT_PARTLY_HOURS
        )
        full_day_hours = self._parse_float(
            settings.get("full_day_hours"), _DEFAULT_FULL_DAY_HOURS
        )
        ignore_recurring_minutes = self._parse_int(
            settings.get("ignore_recurring_minutes"),
            _DEFAULT_IGNORE_RECURRING_MINUTES,
            minimum=0,
        )

        dimensions = self.get_oriented_dimensions(device_config)
        t = layout.tokens(*dimensions)
        roles = palette.resolve(device_config)

        max_rows = layout.row_count(
            t, _ROW_PITCH_EM, _ROW_HEIGHT_EM, _MIN_ROWS, _MAX_ROWS, _HEADER_BAND_EM
        )
        row_count = min(weekends_ahead, max_rows)

        timezone_raw = device_config.get_config("timezone", default="UTC")
        timezone_name = timezone_raw if isinstance(timezone_raw, str) else "UTC"
        tz = get_timezone(timezone_name)
        today = now_in_timezone(timezone_name).date()

        weekends = weekend_dates(today, row_count)
        range_start = weekends[0][0] - timedelta(days=1) if weekends else today
        range_end = weekends[-1][1] + timedelta(days=2) if weekends else today

        def _fetch() -> dict[str, list[dict[str, Any]]]:
            events: list[dict[str, Any]] = []
            for url in ics_urls:
                events.extend(ical.fetch_events(url, range_start, range_end, tz))
            holiday_events = (
                ical.fetch_events(holiday_url, range_start, range_end, tz)
                if holiday_url
                else []
            )
            return {"events": events, "holiday_events": holiday_events}

        cache_key = self._cache_key(ics_urls, holiday_url)
        result = self.cached_fetch(device_config, cache_key, _fetch)

        source_text = f"{len(ics_urls)} calendar" + ("s" if len(ics_urls) != 1 else "")
        sync_text = chrome.sync_text(result, tz)

        base_params: dict[str, Any] = {
            "root_css": "",
            "header_html": "",
            "footer_html": "",
            "extra_css_files": [chrome.CHROME_CSS_PATH],
            "rows": [],
            "too_small": False,
            "empty_html": "",
            "row_pitch_px": _ROW_PITCH_EM * t.base,
            "column_labels_top_px": t.body_top_em * t.base,
            "body_top_px": (t.body_top_em + _HEADER_BAND_EM) * t.base,
            "date_col_end_pct": _DATE_COL_END_PCT,
            "sat_cell_start_pct": _SAT_CELL_START_PCT,
            "sat_cell_end_pct": _SAT_CELL_END_PCT,
            "sun_cell_start_pct": _SUN_CELL_START_PCT,
            "sun_cell_end_pct": _SUN_CELL_END_PCT,
            "cell_text_inset_pct": _CELL_TEXT_INSET_PCT,
            "warn_solid": roles.warn_is_solid,
        }

        if result.empty:
            chrome_html = chrome.build_chrome(
                t, roles, "Weekends", "", source_text, sync_text
            )
            base_params.update(chrome_html)
            base_params["empty_html"] = chrome.empty_state_html(
                "Weekends", "No data available"
            )
            return self._render(dimensions, base_params)

        if not layout.fits_min_rows(
            t, _ROW_PITCH_EM, _ROW_HEIGHT_EM, _MIN_ROWS, _HEADER_BAND_EM
        ):
            chrome_html = chrome.build_chrome(
                t, roles, "Weekends", "", source_text, sync_text
            )
            base_params.update(chrome_html)
            base_params["too_small"] = True
            return self._render(dimensions, base_params)

        payload = result.payload or {}
        events = [parse_event(raw) for raw in payload.get("events", [])]
        holiday_events = [parse_event(raw) for raw in payload.get("holiday_events", [])]
        holidays = holiday_dates(holiday_events)

        rows = []
        free_weekend_count = 0
        for saturday, sunday in weekends:
            row_result = classify_weekend(
                saturday,
                sunday,
                events,
                ignore_recurring_minutes,
                partly_hours,
                full_day_hours,
            )
            row_result = apply_long_weekend(
                row_result, events, events, holidays, school_out_pattern
            )
            if row_result.sat.state == "free" and row_result.sun.state == "free":
                free_weekend_count += 1
            rows.append(row_result)

        # SPEC §6.6 gives weekends its own footer content ("Accent date =
        # long weekend" legend left, free-weekend count right), which
        # doesn't fit the shared chrome footer's source/sync-status slots
        # (SPEC §4.4, "mandatory" fail-soft sync status — kept as-is here,
        # same as trips/home_maintenance) — so the free-weekend count goes
        # in the header meta line instead (the same slot those two screens
        # use for a summary count) and the legend renders as a small extra
        # caption in the template, independent of the shared footer.
        # A generous but bounded budget — long enough for "N free weekends
        # in the next M" at typical counts without risking overflow past
        # the header's right edge on narrow panels (title + meta share one
        # flex row, so an untruncated meta string can otherwise push past
        # --content-w and get clipped by the body's overflow:hidden).
        meta_budget_px = t.width * 0.45
        meta = layout.truncate(
            f"{free_weekend_count} free weekends in the next {len(rows)}",
            meta_budget_px,
            t.fs["label"],
        )
        chrome_html = chrome.build_chrome(
            t, roles, "Weekends", meta, source_text, sync_text
        )
        base_params.update(chrome_html)
        base_params["rows"] = [self._row_template_params(r, t) for r in rows]
        base_params["legend_text"] = "Accent date = long weekend"

        return self._render(dimensions, base_params)

    def _render(
        self, dimensions: tuple[int, int], template_params: dict[str, Any]
    ) -> Any:
        image = self.render_image(
            dimensions, "weekends.html", "weekends.css", template_params
        )
        if not image:
            raise RuntimeError("Failed to take screenshot, please check logs.")
        return image

    @staticmethod
    def _cache_key(ics_urls: list[str], holiday_url: str) -> str:
        joined = "|".join(sorted(ics_urls)) + f"||{holiday_url}"
        return hashlib.sha256(joined.encode()).hexdigest()[:16]

    @staticmethod
    def _parse_int(raw: Any, default: int, minimum: int) -> int:
        try:
            value = int(raw)
        except (TypeError, ValueError):
            return default
        return max(minimum, value)

    @staticmethod
    def _parse_float(raw: Any, default: float) -> float:
        try:
            return max(0.0, float(raw))
        except (TypeError, ValueError):
            return default

    @staticmethod
    def _row_template_params(row: Any, t: layout.Tokens) -> dict[str, Any]:
        single_cell_w_px = t.width * (_SAT_CELL_END_PCT - _SAT_CELL_START_PCT) / 100
        # A spanning row's rendered cell is the full Saturday+Sunday span
        # (SPEC §6.2: "Spanning cell: 18.75% to 97.5%"), not one single-day
        # cell — budgeting truncation against the narrower single-cell width
        # would over-truncate text that actually has roughly double the
        # room to render in.
        spanning_cell_w_px = t.width * (_SUN_CELL_END_PCT - _SAT_CELL_START_PCT) / 100
        cell_w_px = spanning_cell_w_px if row.spanning else single_cell_w_px

        def _cell(day: date, cell: Any) -> dict[str, Any]:
            return {
                "state": cell.state.value,
                "label": layout.truncate(cell.label, cell_w_px, t.fs["cell"]),
                "note": layout.truncate(cell.note, cell_w_px, t.fs["label"]),
                "long_weekend": cell.long_weekend,
                "long_weekend_note": cell.long_weekend_note,
            }

        return {
            "date_label": row.saturday.strftime("%b %-d"),
            "spanning": row.spanning,
            "sat": _cell(row.saturday, row.sat),
            "sun": _cell(row.sunday, row.sun),
        }
