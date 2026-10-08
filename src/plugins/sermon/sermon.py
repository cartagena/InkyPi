"""Sermon — the weekly sermon summary from boardbot (``GET /sermons/latest``).

One plugin, three body screens (message / apply it / read & reflect) under a
shared header, picked from the clock so a plain hourly playlist rotates
through them with no stored state. Same adapter and fail-soft cache as
``trips`` (see ``homeboard.adapters.boardbot``); boardbot does all the
fetching, transcription and summarizing, this only reads JSON and draws it.
"""

from __future__ import annotations

import logging
import time
from collections.abc import Mapping
from typing import Any

from homeboard import chrome, layout, palette
from homeboard.adapters import boardbot
from plugins.base_plugin.base_plugin import BasePlugin, DeviceConfigLike
from plugins.base_plugin.settings_schema import (
    field,
    option,
    row,
    schema,
    section,
)
from plugins.sermon import sermon_data as sd
from utils.time_utils import get_timezone

logger = logging.getLogger(__name__)

# Body font steps as multiples of `base` (28/24/21/18/16px on 800x480):
# shrink a step before truncating.
_FONT_STEPS = (1.45, 1.25, 1.1, 0.95, 0.85)
_HEADER_TITLE_W_PCT = 62.0
_SUBLINE_EM = 1.5
_REFLECT_SHARE = 0.38  # of the body height, reserved for the question


class Sermon(BasePlugin):
    def validate_settings(self, settings: Mapping[str, Any]) -> str | None:
        return boardbot.validate_board_settings(settings)

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
            ),
            section(
                "Display",
                row(
                    field(
                        "screen",
                        "select",
                        label="Screen",
                        default="auto",
                        options=[
                            option("auto", "Rotate hourly"),
                            option("message", "The message"),
                            option("apply", "Apply it"),
                            option("reflect", "Read & reflect"),
                        ],
                        hint="Rotate hourly cycles through all three screens.",
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

        dimensions = self.get_oriented_dimensions(device_config)
        t = layout.tokens(*dimensions)
        roles = palette.resolve(device_config)

        api_token = (
            device_config.load_env_key(boardbot.BOARDBOT_API_TOKEN_ENV_KEY) or ""
        )

        def _fetch() -> dict[str, Any]:
            return boardbot.fetch_sermon_latest(base_url, api_token)

        result = self.cached_fetch(
            device_config, boardbot.cache_key(base_url, "sermons/latest"), _fetch
        )

        timezone_raw = device_config.get_config("timezone", default="UTC")
        tz = get_timezone(timezone_raw if isinstance(timezone_raw, str) else "UTC")
        sync_text = chrome.sync_text(result, tz)

        params: dict[str, Any] = {
            "root_css": "",
            "header_html": "",
            "footer_html": "",
            "extra_css_files": [chrome.CHROME_CSS_PATH],
            "empty_html": "",
            "screen": "",
        }

        payload = result.payload
        if result.empty or not isinstance(payload, Mapping):
            params.update(chrome.build_chrome(t, roles, "Sermon", "", "", sync_text))
            params["empty_html"] = chrome.empty_state_html("Sermon", "No sermon yet")
            return self._render(dimensions, params, roles)

        sermon = sd.parse_sermon(payload)
        screen = sd.resolve_screen(settings.get("screen"), time.time())

        title_w_px = t.width * _HEADER_TITLE_W_PCT / 100
        header_title = layout.truncate(
            sermon.title or "Sermon", title_w_px, t.fs["title"]
        )
        params.update(
            chrome.build_chrome(
                t,
                roles,
                header_title,
                sd.format_service_date(sermon.service_date),
                "",
                sync_text,
            )
        )
        params.update(self._body_params(t, sermon, screen))
        params["screen"] = screen
        return self._render(dimensions, params, roles)

    @staticmethod
    def _body_params(
        t: layout.Tokens, sermon: sd.Sermon, screen: sd.Screen
    ) -> dict[str, Any]:
        content_w = t.width * t.content_w_pct / 100
        subline = " · ".join(p for p in (sermon.series, sermon.speaker) if p)
        subline_h = _SUBLINE_EM * t.base if subline else 0.0
        body_top = t.body_top_em * t.base
        body_h = t.height - body_top - t.body_bottom_em * t.base - subline_h
        steps = [m * t.base for m in _FONT_STEPS]
        footnote_h = t.fs["small"] * sd.LINE_HEIGHT
        footnote = sd.has_inferred(sermon, screen)
        if footnote:
            body_h -= footnote_h

        out: dict[str, Any] = {
            "subline": layout.truncate(subline, content_w, t.fs["label"]),
            "subline_h_px": subline_h,
            "body_h_px": body_h,
            "footnote": sd.INFERRED_FOOTNOTE if footnote else "",
            "footnote_h_px": footnote_h if footnote else 0.0,
            "notes": "",
            "summary": [],
            "highlights": [],
            "takeaways": [],
            "scriptures": [],
            "related": [],
            "reflection": None,
            "font_px": steps[0],
            "list_font_px": t.fs["item"],
            "label_px": t.fs["label"],
        }

        if screen == "message":
            labels = sd.service_note_labels(sermon.service_notes)
            notes = " · ".join(labels)
            note_h = t.fs["label"] * sd.LINE_HEIGHT if notes else 0.0
            out["notes"] = notes
            texts, font_px = sd.fit_blocks(
                [sermon.summary] if sermon.summary else [],
                content_w,
                body_h - note_h,
                steps,
            )
            out["summary"], out["font_px"] = texts, font_px
            # Highlights only if all of them fit, untruncated, in what the
            # summary left over; they are optional (see boardbot hand-off).
            if texts and sermon.highlights:
                room = body_h - note_h - sd.block_height(texts, content_w, font_px)
                hl = [f"• {h}" for h in sermon.highlights]
                small = steps[-1]
                if sd.block_height(hl, content_w, small) <= room - small:
                    out["highlights"] = hl
                    out["highlight_font_px"] = small
        elif screen == "apply":
            # Width reserve (96%) leaves room for the trailing `*` marker.
            texts, font_px = sd.fit_blocks(
                [m.text for m in sermon.takeaways], content_w * 0.96, body_h, steps
            )
            out["takeaways"] = [
                {"text": tx, "inferred": m.inferred}
                for tx, m in zip(texts, sermon.takeaways, strict=False)
            ]
            out["font_px"] = font_px
        else:
            out.update(Sermon._reflect_params(t, sermon, content_w, body_h))
        return out

    @staticmethod
    def _reflect_params(
        t: layout.Tokens, sermon: sd.Sermon, content_w: float, body_h: float
    ) -> dict[str, Any]:
        list_px = t.fs["item"]
        out: dict[str, Any] = {
            "scriptures": sermon.scriptures[:8],
            "related": sermon.related_passages[:2],
            "list_font_px": list_px,
        }
        if sermon.reflection:
            q_steps = [m * t.base for m in _FONT_STEPS]
            q_texts, q_px = sd.fit_blocks(
                [sermon.reflection.text],
                content_w * 0.96,
                body_h * _REFLECT_SHARE,
                q_steps,
            )
            out["reflection"] = {
                "text": q_texts[0],
                "inferred": sermon.reflection.inferred,
                "font_px": q_px,
            }
        return out

    def _render(
        self,
        dimensions: tuple[int, int],
        template_params: dict[str, Any],
        roles: palette.RoleMap,
    ) -> Any:
        image = self.render_image(
            dimensions, "sermon.html", "sermon.css", template_params
        )
        if not image:
            raise RuntimeError("Failed to take screenshot, please check logs.")
        # Snap onto the resolved palette — see homeboard.palette.quantize.
        return palette.quantize(image, roles)
