"""Semantic colour-role resolution for the bedroom-dashboard screens.

Screens are authored against roles (``ink``, ``paper``, ``available``,
``warn``, ``alert``, ``emphasis``), not concrete colours, so the same
template renders correctly on a six-colour panel and on black-and-white
(SPEC §2.1-2.2). This module resolves those roles against whatever the
device's ``device_config`` says about its display. ``quantize()`` then maps
a rendered screenshot onto exactly those colours before it reaches the
display driver (SPEC §2.3) — every screen calls it on its way out.

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

# Indicators of a six/seven-colour ACeP or Spectra 6 Inky panel, read off
# `inky.auto.auto().colour`. VERIFIED against inky 2.4.0: every full-colour
# driver hardcodes `colour="multi"` as its constructor default
# (inky_ac073tc1a.py:119, inky_e673.py:106, inky_uc8159.py:131,
# inky_e640.py:106, inky_el133uf1.py:128) and `inky/auto.py` builds them
# with `resolution=` only, never forwarding the EEPROM colour string — so
# "multi" is the only value a full-colour panel ever reports.
#
# No false positives: the mono/bicolour drivers default to something else
# entirely — `colour="black"` (inky.py:55, inky_ssd1683.py:44),
# `colour="red/yellow"` (inky_jd79661.py:91, inky_jd79668.py:91) — and the
# PHAT/wHAT paths pass the EEPROM string through verbatim ("black",
# "red", "yellow").
#
# The two hyphen/underscore "seven_colour" spellings below are kept purely
# as belt-and-braces against a future `inky` release changing the value;
# no shipped version has ever emitted either one.
_INKY_SIX_COLOUR_COLOUR_VALUES = frozenset({"multi", "seven_colour", "seven-colour"})

# The Inky Impression 7.3" (Spectra 6) panel's real native ink colours —
# not a guess. Sourced from the `inky` package's own `inky_e673.py` driver
# (SATURATED_PALETTE/DESATURATED_PALETTE), blended at this fork's own
# default `inky_saturation` of 0.5 (see display/inky_display.py and
# display/mock_display.py, both `image_settings.inky_saturation` default),
# so this matches what a real panel configured at the default saturation
# actually shows — e-paper ink reads duller than a vivid on-monitor guess
# would. Re-derive with `blended = sat*SATURATED[i] + (1-sat)*DESATURATED[i]`
# if this fork's default saturation ever changes. `paper` is kept pure
# white rather than the driver's true (208, 209, 210) substrate colour —
# every screen uses it as the full-panel background, and a visibly grey
# background reads as a rendering glitch rather than "faithful preview";
# the real panel's substrate tint is a hardware limit, not something worth
# simulating at the cost of every other screen looking dingy. Still
# pending SPEC §9 step 2's physical-panel legibility check (warn_is_solid
# below), but the ink colour values themselves are no longer a placeholder.
_SIX_COLOUR_RGB: dict[Role, RGB] = {
    Role.INK: (0, 0, 0),
    Role.PAPER: (255, 255, 255),
    Role.AVAILABLE: (29, 173, 35),
    Role.WARN: (231, 222, 35),
    Role.ALERT: (205, 36, 37),
    Role.EMPHASIS: (30, 29, 174),
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

# --- neutral-pixel handling in quantize() -------------------------------
#
# A nearest-Euclidean match over the saturated palette is wrong for the
# greys that text antialiasing produces: measured against this palette,
# grey 72..136 lands on AVAILABLE (29, 173, 35) and grey 144..160 on WARN
# (231, 222, 35), so a 50%-grey glyph edge would come out *green*. Measured
# on a 320x230 text-only region of the board screen, the unguarded version
# turned 2121 antialias pixels chromatic (1676 green, 445 yellow) where the
# right answer is zero — i.e. it would have made the panel worse, not
# better, and given the driver's dither more error to diffuse, not less.
#
# So neutrals are snapped to ink/paper before the chromatic match runs. A
# pixel counts as neutral when its channel spread is within this tolerance
# — wide enough to catch subpixel-ish antialiasing tints, narrow enough to
# leave every real palette ink (min spread: warn's 231-35 = 196) alone.
_NEUTRAL_CHROMA_TOLERANCE = 24

# Luma below which a neutral pixel becomes ink rather than paper. Chosen by
# sweep, not by splitting the range: at 128 the DejaVu strokes at the small
# type sizes these screens use (~14-17px) come out visibly thin and broken,
# because most of an antialiased stem's coverage sits above mid-grey. 176
# keeps the stems solid without fattening glyphs into blobs.
_NEUTRAL_INK_LUMA_THRESHOLD = 176


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


def palette_css(roles: RoleMap) -> str:
    """Render *roles* as a ``:root { --color-<role>: #rrggbb; }`` CSS
    custom-property block, plus a ``--warn-solid`` flag templates use to
    pick between an outline and a solid-fill treatment for `warn`."""
    lines = [f"  --warn-solid: {1 if roles.warn_is_solid else 0};"]
    for role, rgb in roles.colors.items():
        lines.append(f"  --color-{role.value}: rgb({rgb[0]}, {rgb[1]}, {rgb[2]});")
    return ":root {\n" + "\n".join(lines) + "\n}"


def _is_dev_mode() -> bool:
    env_mode = (
        os.getenv("INKYPI_ENV", "").strip() or os.getenv("FLASK_ENV", "").strip()
    ).lower()
    return env_mode in ("dev", "development")


# Opt-in, dev-only override to preview the six-colour Spectra 6 palette
# against `display_type: "mock"` instead of the bw fallback. Deliberately
# does not change what "mock" resolves to by default — SPEC §2.1's "never
# rely on colour alone" guarantee is verified throughout board/trips/
# home_maintenance/weekends specifically by rendering against the bw
# collapse (every non-ink/paper role -> black), and that check needs to
# keep running against the *default* mock behaviour, not an opt-in one.
# Gated on _is_dev_mode() so it can never activate against a real device's
# config.
_COLOUR_PREVIEW_ENV_KEY = "HOMEBOARD_COLOUR_PREVIEW"


def _colour_preview_enabled() -> bool:
    if not _is_dev_mode():
        return False
    return os.getenv(_COLOUR_PREVIEW_ENV_KEY, "").strip().lower() in (
        "1",
        "true",
        "yes",
    )


# Memo for _detect_inky_six_colour(). `inky.auto.auto()` probes the panel's
# I2C EEPROM, and resolve() is called on every render of every homeboard
# screen — without this the worker subprocess pays a bus round-trip per
# refresh to re-learn a value that cannot change while the process lives.
# Module-level state is safe here precisely because plugins run in a
# short-lived subprocess (docs/adr/0001): the memo dies with the render, so
# swapping panels still re-detects on the next refresh.
_inky_six_colour_memo: bool | None = None


def reset_inky_detection_cache() -> None:
    """Clear the `_detect_inky_six_colour()` memo.

    Exists for tests, which monkeypatch a different fake `inky` module per
    case and would otherwise all see whichever result was cached first.
    """
    global _inky_six_colour_memo
    _inky_six_colour_memo = None


def _detect_inky_six_colour() -> bool:
    """Best-effort hardware introspection for an `inky`-driven panel.

    Import stays function-local so it never runs (and never counts against
    startup RSS / the lazy-import gate) unless `display_type == "inky"`.
    Any failure — no hardware, package not installed, unexpected shape —
    falls back to the safe bw default.

    Only a *completed* probe is memoised, never one that raised. This matters
    because `generate_image()` is not exclusively a subprocess path: the
    preview, update-now and display-next routes call it synchronously inside
    the long-lived Flask process (`blueprints/plugin.py`, `blueprints/main.py`).
    Caching a transient failure there — the refresh worker holding the I2C
    bus, or `inky` momentarily unimportable mid-update — would pin every
    later web-triggered render to the bw fallback until `inkypi` restarts,
    while the refresh task carried on rendering in colour. A failed probe
    stays cheap to retry; a wrong answer does not.
    """
    global _inky_six_colour_memo
    if _inky_six_colour_memo is not None:
        return _inky_six_colour_memo

    try:
        from inky.auto import auto

        driver = auto()
        colour = getattr(driver, "colour", "")
        detected = isinstance(colour, str) and colour.lower() in (
            v.lower() for v in _INKY_SIX_COLOUR_COLOUR_VALUES
        )
    except Exception:  # noqa: BLE001 - hardware/detection is best-effort
        return False

    _inky_six_colour_memo = detected
    return detected


def _detect_capability(device_config: DeviceConfigLike) -> bool:
    """Return True for a detected six-colour panel, False for bw/unknown."""
    display_type = device_config.get_config("display_type", default="mock")
    if not isinstance(display_type, str):
        return False

    if display_type == "mock":
        return _colour_preview_enabled()
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


def _neutral_mask(arr: np.ndarray) -> np.ndarray:
    """(H, W) mask of pixels carrying no real hue — antialiasing greys.

    Shared by ``_snap_neutrals`` (which resolves them by luma) and
    ``quantize`` (which excludes them from the segment match, since that
    result would only be overwritten).
    """
    spread = arr.max(axis=-1) - arr.min(axis=-1)
    mask: np.ndarray = spread <= _NEUTRAL_CHROMA_TOLERANCE
    return mask


def _snap_neutrals(
    arr: np.ndarray,
    palette: list[RGB],
    nearest_idx: np.ndarray,
    roles: RoleMap,
) -> np.ndarray:
    """Override *nearest_idx* with ink/paper wherever the pixel is neutral.

    *arr* is the (H, W, 3) int32 source image and *nearest_idx* the (H, W)
    result of the chromatic nearest-match. A pixel whose channel spread is
    within ``_NEUTRAL_CHROMA_TOLERANCE`` carries no real hue — it is an
    antialiasing grey — and is resolved by luma alone, so glyph edges stay
    black-and-white instead of being pulled onto whichever saturated ink
    happens to sit nearest in RGB space.
    """
    try:
        ink_idx = palette.index(roles.colors[Role.INK])
        paper_idx = palette.index(roles.colors[Role.PAPER])
    except (KeyError, ValueError):  # a RoleMap missing ink/paper entirely
        return nearest_idx

    neutral = _neutral_mask(arr)
    if not bool(neutral.any()):
        return nearest_idx

    # Rec. 601 luma, in integer arithmetic: the weights sum to exactly 1000,
    # so a true grey maps back to its own channel value rather than to a
    # float a half-ULP either side of it — which would make the threshold
    # comparison arbitrary for pixels sitting exactly on it.
    luma = (
        299 * arr[:, :, 0] + 587 * arr[:, :, 1] + 114 * arr[:, :, 2]
    ) // 1000  # (H, W)
    neutral_idx = np.where(luma < _NEUTRAL_INK_LUMA_THRESHOLD, ink_idx, paper_idx)
    return np.where(neutral, neutral_idx, nearest_idx)


def _nearest_segment_idx(
    arr: np.ndarray, pal: np.ndarray, skip: np.ndarray | None = None
) -> np.ndarray:
    """Snap each pixel to an endpoint of the palette pair it sits between.

    A plain nearest-Euclidean match is wrong for pixels that antialiasing
    produced by blending *two* palette colours: the blend can land closer to
    some unrelated third ink than to either of the colours that made it. The
    measured case is a white-on-red glyph edge, ``(240, 145, 140)`` — squared
    distance 23715 to red and 25550 to white, but only 17035 to yellow, so
    every such edge pixel used to quantize to yellow and speckle the panel
    with an ink the design never uses.

    Treating the palette as the set of segments between its entries fixes
    that: the pixel is matched to the *pair* whose connecting segment it lies
    nearest, then resolved to the nearer of that pair's two endpoints. A
    white-red blend can then only ever become white or red.
    """
    n = len(pal)
    diff = arr[:, :, None, :] - pal[None, None, :, :]
    dist_sq = np.sum(diff * diff, axis=-1)  # (H, W, N) distance to endpoints
    nearest_idx: np.ndarray = np.argmin(dist_sq, axis=-1).astype(np.intp)  # (H, W)
    if n < 2:
        return nearest_idx

    # A pixel that already *is* a palette colour must map to itself: it can
    # sit exactly on the segment between two other entries, and would then be
    # pulled to one of them by loop order. Solving only for the rest also
    # keeps the pair loop cheap — on these screens the overwhelming majority
    # of pixels are already exactly ink or paper, and only glyph edges and
    # chip borders are blends.
    blended = dist_sq.min(axis=-1) != 0  # (H, W)
    if skip is not None:
        # Neutral pixels are about to be overwritten by _snap_neutrals, and
        # on these text-heavy screens they are essentially *all* the blended
        # pixels (measured: 23208 of 23208 on an 800x480 text-only render),
        # so without this the whole pair loop is computed and discarded.
        blended &= ~skip
    blended = blended.reshape(-1)  # (H*W,)
    if not bool(blended.any()):
        return nearest_idx

    flat = arr.reshape(-1, 3)[blended].astype(np.float32)  # (M, 3)
    flat_dist = dist_sq.reshape(-1, n)[blended]  # (M, N)
    best_dist = np.full(flat.shape[0], np.inf, dtype=np.float32)
    best_idx = np.argmin(flat_dist, axis=-1).astype(np.intp)

    # At most 21 pairs for a 7-colour palette, so the loop is cheap; it runs
    # per-pair rather than over a stacked (M, pairs) array to keep peak RSS
    # down — this executes in the render subprocess on a Pi Zero 2 W.
    for i in range(n):
        for j in range(i + 1, n):
            seg = (pal[j] - pal[i]).astype(np.float32)  # (3,)
            seg_len_sq = float(seg @ seg)
            rel = flat - pal[i].astype(np.float32)  # (M, 3)
            if seg_len_sq == 0.0:  # duplicate palette entries
                t = np.zeros(flat.shape[0], dtype=np.float32)
            else:
                t = np.clip(np.sum(rel * seg, axis=-1) / seg_len_sq, 0.0, 1.0)
            perp = rel - t[:, None] * seg
            seg_dist = np.sum(perp * perp, axis=-1)  # (M,)

            endpoint = np.where(flat_dist[:, j] < flat_dist[:, i], j, i)
            improved = seg_dist < best_dist
            best_dist = np.where(improved, seg_dist, best_dist)
            best_idx = np.where(improved, endpoint, best_idx)

    resolved = nearest_idx.reshape(-1).copy()
    resolved[blended] = best_idx
    out: np.ndarray = resolved.reshape(arr.shape[:2])
    return out


def quantize(img: Image.Image, roles: RoleMap) -> Image.Image:
    """Map every pixel of *img* onto the exact colours in *roles* (SPEC §2.3).

    Neutral (near-grey) pixels — which is what glyph antialiasing over paper
    produces — snap to ink or paper by luma; genuinely saturated pixels go
    through the nearest-*segment* match in ``_nearest_segment_idx``. Both
    steps exist because the naive nearest-colour version makes the panel
    *worse*: see ``_NEUTRAL_CHROMA_TOLERANCE`` for the grey case and
    ``_nearest_segment_idx`` for the two-ink-blend case.

    No dithering happens here, and that is the whole point on an Inky panel:
    the `inky` drivers Floyd-Steinberg every non-``P``-mode image they are
    handed (``inky_ac073tc1a.set_image``'s ``image.im.convert("P", True,
    ...)``, ``inky_e673``'s ``quantize(..., dither=FLOYDSTEINBERG)``) and
    InkyPi always hands them RGB, so FS is unconditionally on. Feeding it
    palette-exact pixels leaves zero error to diffuse, which turns the
    driver's dither into a no-op instead of a speckle generator.

    Two caveats on how far that goes:

    * It is exact only for Inky. ``_WAVESHARE_FULL_COLOUR_MODELS`` also
      resolves to ``_SIX_COLOUR_RGB``, but that table is derived from
      `inky`'s Spectra 6 driver, while ``WaveshareDisplay`` quantizes
      against the vendor ``getbuffer()``'s own, much more saturated,
      seven-colour palette. Output there is *not* palette-exact and the
      vendor dither still has error to diffuse. The neutral-snap half of
      this function is still a clear win on those panels — it is only the
      "dither becomes a no-op" half that does not carry over.
    * ``DisplayManager`` runs ``apply_image_enhancement`` after the plugin
      returns. The 1.0 defaults are exact no-ops, but any user-set
      brightness/contrast/saturation/sharpness shifts every pixel back off
      palette, as does an ``inky_saturation`` other than the 0.5 that
      ``_SIX_COLOUR_RGB`` is pinned to. Both silently restore the speckle
      this function exists to remove.
    """
    palette = list(dict.fromkeys(roles.colors.values()))  # de-dup, keep order
    if not palette:
        return img

    rgb_img = img.convert("RGB")
    # int32, not int16: squared channel distances (up to 255**2*3 = 195075)
    # overflow a signed 16-bit range.
    arr = np.asarray(rgb_img, dtype=np.int32)  # (H, W, 3)
    pal = np.asarray(palette, dtype=np.int32)  # (N, 3)

    neutral = _neutral_mask(arr)
    nearest_idx = _nearest_segment_idx(arr, pal, skip=neutral)
    nearest_idx = _snap_neutrals(arr, palette, nearest_idx, roles)

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
