"""Semantic colour-role resolution for the bedroom-dashboard screens.

Screens are authored against roles (``ink``, ``paper``, ``available``,
``warn``, ``alert``, ``emphasis``), not concrete colours, so the same
template renders correctly on a six-colour panel and on black-and-white
(SPEC §2.1-2.2). This module resolves those roles against whatever the
device's ``device_config`` says about its display, and quantizes a rendered
image down to the resolved palette with no dithering (SPEC §2.3).

Nothing here adds a new ``device_config`` field or touches the display
drivers — capability is inferred read-only from the existing
``display_type`` config value, the same one ``DisplayManager`` already uses
to pick a driver.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from enum import StrEnum
from fnmatch import fnmatch
from typing import TYPE_CHECKING

import numpy as np
from PIL import Image

if TYPE_CHECKING:
    from plugins.base_plugin.base_plugin import DeviceConfigLike

logger = logging.getLogger(__name__)


class Role(StrEnum):
    """Semantic colour roles used by every screen (SPEC §2.1)."""

    INK = "ink"
    PAPER = "paper"
    AVAILABLE = "available"
    WARN = "warn"
    ALERT = "alert"
    EMPHASIS = "emphasis"


RGB = tuple[int, int, int]

# Waveshare's own "full colour" model-name suffix convention (e/f), pinned
# against the exact set of six/seven-colour drivers this fork ships in
# install/waveshare-manifest.txt. Deliberately hardcoded rather than read
# from the manifest at runtime — the manifest is an install-time artifact,
# not guaranteed present on a running Pi.
_WAVESHARE_FULL_COLOUR_MODELS = frozenset(
    {
        "epd4in01f",
        "epd5in65f",
        "epd7in3e",
        "epd7in3f",
    }
)

# Best-effort indicators of a seven/six-colour ACeP Inky panel, read off
# `inky.auto.auto().colour`. UNVERIFIED — the `inky` package isn't
# available in this dev environment; confirm the exact attribute value
# against a real install before relying on this for anything but the
# conservative bw-fallback default (SPEC §9 step 2, §10 item 1).
_INKY_SIX_COLOUR_COLOUR_VALUES = frozenset({"seven_colour", "seven-colour"})

# Placeholder RGB values. UNVERIFIED — must be re-measured against the
# physical panel; saturated e-paper inks read duller than these look on a
# monitor (SPEC §2.2).
_SIX_COLOUR_RGB: dict[Role, RGB] = {
    Role.INK: (0, 0, 0),
    Role.PAPER: (255, 255, 255),
    Role.AVAILABLE: (0, 150, 64),
    Role.WARN: (255, 209, 0),
    Role.ALERT: (200, 16, 46),
    Role.EMPHASIS: (0, 90, 181),
}

_BW_RGB: dict[Role, RGB] = {
    Role.INK: (0, 0, 0),
    Role.PAPER: (255, 255, 255),
    Role.AVAILABLE: (0, 0, 0),
    Role.WARN: (0, 0, 0),
    Role.ALERT: (0, 0, 0),
    Role.EMPHASIS: (0, 0, 0),
}

# Percentage of off-palette pixels above which quantize() logs a warning in
# dev mode — signals a stray tint/gradient in a screen's CSS (SPEC §2.3).
_OFF_PALETTE_WARN_PCT = 8.0


@dataclass(frozen=True)
class RoleMap:
    """A resolved set of colours plus the fill-treatment flags templates
    need to satisfy SPEC §2.1's "never rely on colour alone" rule."""

    colors: dict[Role, RGB]
    six_colour: bool
    # False forces an outline-only `warn` treatment. Stays False even on a
    # detected six-colour panel until a human confirms dark-text-on-yellow
    # legibility on the physical panel (SPEC §2.2) — flip in one place once
    # verified, no separate code path needed.
    warn_is_solid: bool


def _is_dev_mode() -> bool:
    env_mode = (
        os.getenv("INKYPI_ENV", "").strip() or os.getenv("FLASK_ENV", "").strip()
    ).lower()
    return env_mode in ("dev", "development")


def _detect_inky_six_colour() -> bool:
    """Best-effort hardware introspection for an `inky`-driven panel.

    Import stays function-local so it never runs (and never counts against
    startup RSS / the lazy-import gate) unless `display_type == "inky"`.
    Any failure — no hardware, package not installed, unexpected shape —
    falls back to the safe bw default.
    """
    try:
        from inky.auto import auto

        driver = auto()
        colour = getattr(driver, "colour", "")
        return isinstance(colour, str) and colour.lower() in (
            v.lower() for v in _INKY_SIX_COLOUR_COLOUR_VALUES
        )
    except Exception:  # noqa: BLE001 - hardware/detection is best-effort
        return False


def _detect_capability(device_config: DeviceConfigLike) -> bool:
    """Return True for a detected six-colour panel, False for bw/unknown."""
    display_type = device_config.get_config("display_type", default="mock")
    if not isinstance(display_type, str):
        return False

    if display_type == "mock":
        return False
    if fnmatch(display_type, "epd*"):
        return display_type in _WAVESHARE_FULL_COLOUR_MODELS
    if display_type == "inky":
        return _detect_inky_six_colour()
    return False


def resolve(device_config: DeviceConfigLike) -> RoleMap:
    """Resolve semantic roles against *device_config*'s display capability."""
    six_colour = _detect_capability(device_config)
    colors = _SIX_COLOUR_RGB if six_colour else _BW_RGB
    return RoleMap(colors=dict(colors), six_colour=six_colour, warn_is_solid=False)


def quantize(img: Image.Image, roles: RoleMap) -> Image.Image:
    """Map every pixel of *img* to the nearest colour in *roles* — no
    dithering, since every intended colour is already palette-exact and
    dithering would only add noise (SPEC §2.3)."""
    palette = list(dict.fromkeys(roles.colors.values()))  # de-dup, keep order
    if not palette:
        return img

    rgb_img = img.convert("RGB")
    # int32, not int16: squared channel distances (up to 255**2*3 = 195075)
    # overflow a signed 16-bit range.
    arr = np.asarray(rgb_img, dtype=np.int32)  # (H, W, 3)
    pal = np.asarray(palette, dtype=np.int32)  # (N, 3)

    # Squared Euclidean distance from every pixel to every palette colour.
    diff = arr[:, :, None, :] - pal[None, None, :, :]
    dist_sq = np.sum(diff * diff, axis=-1)  # (H, W, N)
    nearest_idx = np.argmin(dist_sq, axis=-1)  # (H, W)

    if _is_dev_mode():
        exact = np.any(
            np.all(arr[:, :, None, :] == pal[None, None, :, :], axis=-1), axis=-1
        )
        off_palette_pct = 100.0 * (1.0 - float(np.mean(exact)))
        if off_palette_pct > _OFF_PALETTE_WARN_PCT:
            logger.warning(
                "homeboard.palette: %.1f%% of pixels were off-palette before "
                "quantization (>%.0f%% threshold) — check for a stray tint "
                "or gradient in the screen's CSS.",
                off_palette_pct,
                _OFF_PALETTE_WARN_PCT,
            )

    pal_arr = np.asarray(palette, dtype=np.uint8)
    quantized = pal_arr[nearest_idx]
    return Image.fromarray(quantized.astype(np.uint8), mode="RGB")
