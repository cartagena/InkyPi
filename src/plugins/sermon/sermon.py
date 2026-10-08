"""Sermon — the weekly sermon summary from boardbot (``GET /sermons/latest``).

One plugin, four body screens (message / key points / apply it / read &
reflect), each in its own palette colour, picked from the clock so a plain
hourly playlist rotates through them with no stored state. Two designs,
chosen per instance — see ``sermon_layouts``. Same adapter and fail-soft
cache as ``trips`` (see ``homeboard.adapters.boardbot``); boardbot does all
the fetching, transcription and summarizing, this only reads JSON and draws
it.

Unlike the other homeboard screens this one draws its own header and footer
instead of ``homeboard.chrome``: the colour band or sidebar *is* the header.
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
from plugins.sermon import sermon_data as sd, sermon_layouts as sl
from utils.app_utils import get_font_path
from utils.time_utils import get_timezone

logger = logging.getLogger(__name__)


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
                        "design",
                        "select",
                        label="Design",
                        default=sl.DEFAULT_DESIGN,
                        options=[
                            option("band", "Colour band"),
                            option("sidebar", "Sidebar poster"),
                        ],
                        hint="Colour band: a coloured header across the top. Sidebar poster: a coloured column on the left with the screen number.",
                    ),
                ),
                row(
                    field(
                        "screen",
                        "select",
                        label="Screen",
                        default="auto",
                        options=[
                            option("auto", "Rotate hourly"),
                            option("message", "The message"),
                            option("highlights", "Key points"),
                            option("apply", "Apply it"),
                            option("reflect", "Read & reflect"),
                        ],
                        hint="Rotate hourly picks one of the four screens from the clock (hour mod 4), so set the playlist/refresh interval to 1 hour — at 2 or 4 hours only some screens would ever show.",
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

        payload = result.payload
        if result.empty or not isinstance(payload, Mapping):
            sermon = None
            screen: sd.Screen = "message"
        else:
            sermon = sd.parse_sermon(payload)
            screen = sd.resolve_screen(settings.get("screen"), time.time())

        design = sl.resolve_design(settings.get("design"))
        params = self.build_params(t, roles, sermon, screen, design)
        params["sync"] = chrome.sync_text(result, tz)
        return self._render(dimensions, params, roles)

    def build_params(
        self,
        t: layout.Tokens,
        roles: palette.RoleMap,
        sermon: sd.Sermon | None,
        screen: sd.Screen,
        design: sl.Design = sl.DEFAULT_DESIGN,
    ) -> dict[str, Any]:
        """Template parameters for one render (``sermon=None`` is the "no
        sermon yet" frame). Separate from ``generate_image`` so previews and
        tests can drive it with any palette, payload and design."""
        font_url = self.to_file_url(get_font_path("jost"))
        return sl.build_params(t, roles, sermon, screen, design, font_url)

    def _render(
        self,
        dimensions: tuple[int, int],
        template_params: dict[str, Any],
        roles: palette.RoleMap,
    ) -> Any:
        html_file, css_file = sl.TEMPLATES[template_params["design"]]
        image = self.render_image(dimensions, html_file, css_file, template_params)
        if not image:
            raise RuntimeError("Failed to take screenshot, please check logs.")
        # Snap onto the resolved palette — see homeboard.palette.quantize.
        return palette.quantize(image, roles)
