#!/usr/bin/env python3
"""
Render every Sermon plugin screen from a boardbot payload, in six colour.

Usage (run from repo root):
  python scripts/render_sermon_preview.py
  python scripts/render_sermon_preview.py --design sidebar --mono
  python scripts/render_sermon_preview.py --payload my.json --out /tmp/sermon

Defaults to the reference sample at tests/plugins/fixtures/sermon_sample.json
and the Spectra 6 palette, so design iterations stay comparable. Renders
every design (one sub-folder each) unless --design picks one; --mono uses
the black-and-white palette instead. Nothing is fetched: the
payload is fed straight to the plugin's template builder.
"""

import argparse
import json
import os
import sys

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC_DIR = os.path.join(REPO_ROOT, "src")
if SRC_DIR not in sys.path:
    sys.path.insert(0, SRC_DIR)

DEFAULT_PAYLOAD = os.path.join(
    REPO_ROOT, "tests", "plugins", "fixtures", "sermon_sample.json"
)


def main() -> int:
    from PIL import Image

    from homeboard import layout, palette
    from plugins.sermon import sermon_data as sd, sermon_layouts as sl
    from plugins.sermon.sermon import Sermon

    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--payload", default=DEFAULT_PAYLOAD)
    parser.add_argument(
        "--out", default=os.path.join(REPO_ROOT, "runtime", "sermon_preview")
    )
    parser.add_argument("--width", type=int, default=800)
    parser.add_argument("--height", type=int, default=480)
    parser.add_argument("--design", choices=sl.DESIGNS, help="default: all designs")
    parser.add_argument("--mono", action="store_true", help="black-and-white palette")
    args = parser.parse_args()

    with open(args.payload, encoding="utf-8") as fh:
        sermon = sd.parse_sermon(json.load(fh))
    roles = palette.RoleMap(
        colors=dict(palette._BW_RGB if args.mono else palette._SIX_COLOUR_RGB),
        six_colour=not args.mono,
        warn_is_solid=False,
    )
    t = layout.tokens(args.width, args.height)
    plugin = Sermon({"id": "sermon"})
    for design in [args.design] if args.design else sl.DESIGNS:
        out_dir = os.path.join(args.out, design)
        os.makedirs(out_dir, exist_ok=True)
        frames = []
        for idx, screen in enumerate(sd.SCREENS, start=1):
            params = plugin.build_params(t, roles, sermon, screen, design)
            params["sync"] = "Synced (preview)"
            size = (args.width, args.height)
            image = plugin._render(size, params, roles).convert("RGB")
            path = os.path.join(out_dir, f"{idx}_{screen}.png")
            image.save(path)
            frames.append(image)
            print(path)
        print(_contact_sheet(Image, frames, args.width, args.height, out_dir))
    return 0


def _contact_sheet(image_mod, frames, width, height, out_dir):  # type: ignore[no-untyped-def]
    """2x2 grid of the four screens, saved as all_screens.png."""
    gap = 16
    sheet = image_mod.new(
        "RGB", (2 * width + 3 * gap, 2 * height + 3 * gap), (210, 210, 210)
    )
    for i, frame in enumerate(frames):
        sheet.paste(
            frame, (gap + (i % 2) * (width + gap), gap + (i // 2) * (height + gap))
        )
    path = os.path.join(out_dir, "all_screens.png")
    sheet.save(path)
    return path


if __name__ == "__main__":
    raise SystemExit(main())
