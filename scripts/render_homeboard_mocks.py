#!/usr/bin/env python3
"""Render the documentation mockups for the homeboard screens.

Drives the *real* ``board``/``trips``/``home_maintenance``/``weekends``
plugins against fixture data — no ``boardbot`` deployment, no calendar
feeds, no Pi — and writes the resulting PNGs to ``docs/images/homeboard/``
for ``docs/homeboard_screens.md`` to embed.

Rendering through the plugins themselves (rather than hand-drawing a
mockup) is the point: the images can never drift from the layout tokens,
palette and chip ladders the screens actually use, because they *are* that
code's output. The six-colour Spectra 6 palette is forced on via the
dev-only ``HOMEBOARD_COLOUR_PREVIEW`` override so the mockups show what the
physical panel shows, not the black-and-white ``mock`` fallback.

Usage::

    .venv/bin/python scripts/render_homeboard_mocks.py
    .venv/bin/python scripts/render_homeboard_mocks.py --dimensions 480x800

Fixture dates are relative to the day the script runs, so re-running it
produces the same *content* (the same chips, states and countdowns) on
different absolute dates. Board's backlog rotation is seeded by the date,
so which backlog items appear will vary between runs — that rotation is
the feature, not noise.
"""

from __future__ import annotations

import argparse
import os
import sys
import tempfile
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "src"))

# Must be set before homeboard.palette is imported so the six-colour
# preview override is live when resolve() first runs.
os.environ.setdefault("INKYPI_ENV", "dev")
os.environ.setdefault("HOMEBOARD_COLOUR_PREVIEW", "1")  # --palette overrides

from homeboard.adapters import boardbot, ical  # noqa: E402
from plugins.base_plugin.base_plugin import BasePlugin  # noqa: E402
from plugins.board import board_data  # noqa: E402
from plugins.board.board import Board  # noqa: E402
from plugins.home_maintenance.home_maintenance import HomeMaintenance  # noqa: E402
from plugins.trips.trips import Trips  # noqa: E402
from plugins.weekends.classify import weekend_dates  # noqa: E402
from plugins.weekends.weekends import Weekends  # noqa: E402
from utils.payload_cache import CacheResult, atomic_write_json  # noqa: E402

TIMEZONE = "Europe/London"
BASE_URL = "http://homelab.local:8765"
ICS_URL = "http://homelab.local/calendars/family.ics"
HOLIDAY_ICS_URL = "http://homelab.local/calendars/holidays.ics"

OUTPUT_DIR = REPO_ROOT / "docs" / "images" / "homeboard"

TZ = ZoneInfo(TIMEZONE)
TODAY = datetime.now(TZ).date()


def _iso(day: date, hour: int, minute: int = 0) -> str:
    return datetime(day.year, day.month, day.day, hour, minute, tzinfo=TZ).isoformat()


def _days(offset: int) -> str:
    return (TODAY + timedelta(days=offset)).isoformat()


# --- fixtures -----------------------------------------------------------

PROJECT_ROWS: list[dict[str, Any]] = [
    {
        "text": f"*Kitchen shelving — started {_days(-6)}",
        "checked": False,
        "effort_days": 1,
        "priority": "high",
    },
    {
        "text": "*Garage sort-out",
        "checked": False,
        "effort_days": 3,
        "due_date": _days(5),
    },
    {"text": "Repaint the hallway", "checked": False, "effort_days": 6},
    {"text": "Sort out the loft", "checked": False, "effort_days": 3},
    {"text": "Bike service", "checked": False, "effort_days": 1},
    {"text": "Replace the fence panel", "checked": False, "effort_days": 2},
    {"text": "Build the raised beds", "checked": False, "effort_days": 4},
]

# text -> how many days ago the board first saw it (drives the age chips).
PROJECT_AGES = {
    "*Kitchen shelving — started " + _days(-6): 6,
    "*Garage sort-out": 40,
    "Repaint the hallway": 210,
    "Sort out the loft": 120,
    "Bike service": 30,
    "Replace the fence panel": 95,
    "Build the raised beds": 160,
}

TODO_ROWS: list[dict[str, Any]] = [
    {"text": "Chase the plumber", "checked": False},
    {"text": "Fix the gate latch", "checked": False},
    {"text": "Call about the boiler service", "checked": False},
    {"text": "Renew passport", "checked": False},
    {"text": "Replace the hall bulb", "checked": False},
    {"text": "Book the dentist", "checked": False},
    {"text": "Return the router", "checked": False},
    {"text": "Order printer ink", "checked": False},
]

TODO_AGES = {
    "Chase the plumber": 60,
    "Fix the gate latch": 45,
    "Call about the boiler service": 21,
    "Renew passport": 18,
    "Replace the hall bulb": 5,
    "Book the dentist": 3,
    "Return the router": 2,
    "Order printer ink": 1,
}

# Items ticked off in WhatsApp over the past few days — the "N cleared this
# week" line. They are gone from the list, so they only exist in the ledger.
TODO_CLEARED = {
    "Post the parcel": 1,
    "Water the plants": 3,
    "Pick up the dry cleaning": 5,
}


def _next_weekday(weekday: int, weeks_out: int) -> date:
    """The *weekday* (Mon=0) that falls *weeks_out* weeks after the next
    upcoming one — so trip fixtures land on real Fridays and Saturdays
    whatever day the script is run."""
    ahead = (weekday - TODAY.weekday()) % 7 or 7
    return TODAY + timedelta(days=ahead, weeks=weeks_out)


_LISBON_START = _next_weekday(4, 1)  # a Friday, ~1-2 weeks out
_SKI_START = _next_weekday(5, 6)  # a Saturday, ~7 weeks out

TRIP_ROWS: list[dict[str, Any]] = [
    {
        "name": "Lisbon",
        "status": "booked",
        "start": _LISBON_START.isoformat(),
        "end": (_LISBON_START + timedelta(days=2)).isoformat(),
        "next_action": "Book airport parking",
    },
    {
        "name": "Ski week",
        "status": "booked",
        "start": _SKI_START.isoformat(),
        "end": (_SKI_START + timedelta(days=7)).isoformat(),
        "next_action": "",
    },
    {"name": "Copenhagen", "status": "idea", "target_window": "Spring, long weekend"},
    {"name": "Northern Portugal", "status": "idea", "target_window": "Next autumn"},
    {"name": "Dolomites", "status": "idea", "target_window": "Summer 2027"},
]

MAINTENANCE_ROWS: list[dict[str, Any]] = [
    {
        "task": "Replace the furnace filter",
        "interval_value": 3,
        "interval_unit": "months",
        "last_done": _days(-105),
    },
    {
        "task": "Clean the gutters",
        "interval_value": None,
        "interval_unit": "seasonal",
        "next_due_override": _days(-4),
    },
    {
        "task": "Service the boiler",
        "interval_value": 1,
        "interval_unit": "years",
        "last_done": _days(-356),
    },
    {
        "task": "Bleed the radiators",
        "interval_value": 6,
        "interval_unit": "months",
        "last_done": _days(-170),
    },
    {
        "task": "Descale the kettle",
        "interval_value": 6,
        "interval_unit": "months",
        "last_done": _days(-120),
    },
    {
        "task": "Smoke alarm batteries",
        "interval_value": 1,
        "interval_unit": "years",
        "last_done": _days(-250),
    },
    {
        "task": "Flush the water heater",
        "interval_value": 2,
        "interval_unit": "years",
        "last_done": _days(-500),
    },
]


def _calendar_events() -> list[dict[str, Any]]:
    """Six weekends' worth of events: one all-day birthday, one short
    brunch, and one overnight trip that spans Saturday into Sunday."""
    weekends = weekend_dates(TODAY, 6)
    events: list[dict[str, Any]] = []

    if len(weekends) > 1:
        sat = weekends[1][0]
        events.append(
            {
                "summary": "Ben's birthday party",
                "start": _iso(sat, 0),
                "end": _iso(sat + timedelta(days=1), 0),
                "all_day": True,
                "transparent": False,
                "recurring": False,
            }
        )
    if len(weekends) > 2:
        sun = weekends[2][1]
        events.append(
            {
                "summary": "Brunch with the Harpers",
                "start": _iso(sun, 11),
                "end": _iso(sun, 14),
                "all_day": False,
                "transparent": False,
                "recurring": False,
            }
        )
    if len(weekends) > 3:
        sat = weekends[3][0]
        events.append(
            {
                "summary": "Cabin at the lake",
                "start": _iso(sat, 16),
                "end": _iso(sat + timedelta(days=1), 14),
                "all_day": False,
                "transparent": False,
                "recurring": False,
            }
        )
    return events


def _holiday_events() -> list[dict[str, Any]]:
    """A bank holiday on the Monday after the last visible weekend, so one
    row renders its date in the long-weekend accent."""
    weekends = weekend_dates(TODAY, 6)
    if not weekends:
        return []
    monday = weekends[-1][1] + timedelta(days=1)
    return [
        {
            "summary": "Bank holiday",
            "start": _iso(monday, 0),
            "end": _iso(monday + timedelta(days=1), 0),
            "all_day": True,
            "transparent": False,
            "recurring": False,
        }
    ]


# --- harness ------------------------------------------------------------


class MockDeviceConfig:
    """The slice of ``DeviceConfigLike`` the four screens actually read."""

    def __init__(self, config_dir: str, dimensions: tuple[int, int]) -> None:
        self.config_file = os.path.join(config_dir, "device.json")
        self._dimensions = dimensions

    def get_resolution(self) -> tuple[int, int]:
        return self._dimensions

    def get_config(self, key: str, default: object = None) -> object:
        return {
            "timezone": TIMEZONE,
            # "mock" + HOMEBOARD_COLOUR_PREVIEW resolves to the real
            # six-colour Spectra 6 palette without needing a panel attached.
            "display_type": "mock",
            "orientation": "horizontal",
        }.get(key, default)

    def load_env_key(self, key: str) -> str | None:
        return "mock-token"


def _stub_cached_fetch(
    self: BasePlugin,
    device_config: Any,
    cache_key: str,
    fetch_fn: Any,
    config_errors: Any = (RuntimeError,),
) -> CacheResult:
    """Bypass the on-disk payload cache — the fixtures never fail, and a
    mockup should show the ``Synced …`` footer, not ``As of …``."""
    return CacheResult(
        payload=fetch_fn(),
        fresh=True,
        stale=False,
        empty=False,
        synced_at=datetime.now(TZ),
    )


def _seed_board_ledger(device_config: MockDeviceConfig) -> None:
    """Write the item-age ledgers the age chips read from.

    Without this every item's ``first_seen`` is today and no board row
    carries an age chip at all — the ledger is normally built up over weeks
    of real refreshes.
    """
    projects = {
        board_data.ledger_key("projects", text): {
            "first_seen": _days(-age),
            "completed_at": None,
        }
        for text, age in PROJECT_AGES.items()
    }
    todo = {
        board_data.ledger_key("todo", text): {
            "first_seen": _days(-age),
            "completed_at": None,
        }
        for text, age in TODO_AGES.items()
    }
    todo.update(
        {
            board_data.ledger_key("todo", text): {
                "first_seen": _days(-age - 10),
                "completed_at": _days(-age),
            }
            for text, age in TODO_CLEARED.items()
        }
    )
    atomic_write_json(
        Board._ledger_path(device_config, BASE_URL, "projects"),  # noqa: SLF001
        projects,
    )
    atomic_write_json(
        Board._ledger_path(device_config, BASE_URL, "todo"),  # noqa: SLF001
        todo,
    )


def _install_stubs() -> None:
    BasePlugin.cached_fetch = _stub_cached_fetch  # type: ignore[method-assign]
    boardbot.fetch_checklist = (  # type: ignore[assignment]
        lambda name, base_url, token: PROJECT_ROWS if name == "projects" else TODO_ROWS
    )
    boardbot.fetch_trips = lambda base_url, token: TRIP_ROWS  # type: ignore[assignment]
    boardbot.fetch_maintenance = (  # type: ignore[assignment]
        lambda base_url, token: MAINTENANCE_ROWS
    )
    ical.fetch_events = (  # type: ignore[assignment]
        lambda url, start, end, tz: (
            _holiday_events() if url == HOLIDAY_ICS_URL else _calendar_events()
        )
    )


SCREENS: dict[str, tuple[type[BasePlugin], dict[str, Any]]] = {
    "board": (Board, {"base_url": BASE_URL, "in_flight_prefix": "*"}),
    "trips": (Trips, {"base_url": BASE_URL}),
    "home_maintenance": (HomeMaintenance, {"base_url": BASE_URL}),
    "weekends": (
        Weekends,
        {"ics_urls": ICS_URL, "holiday_ics_url": HOLIDAY_ICS_URL},
    ),
}


def render(
    screen: str, dimensions: tuple[int, int], out_dir: Path, suffix: str = ""
) -> Path:
    plugin_cls, settings = SCREENS[screen]
    plugin_id = screen
    plugin = plugin_cls({"id": plugin_id, "class": plugin_cls.__name__})

    with tempfile.TemporaryDirectory() as config_dir:
        device_config = MockDeviceConfig(config_dir, dimensions)
        if screen == "board":
            _seed_board_ledger(device_config)
        image = plugin.generate_image(settings, device_config)

    if image is None:
        raise RuntimeError(f"{screen}: generate_image returned no image")

    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"{screen}{suffix}.png"
    image.save(out_path)
    return out_path


def _parse_dimensions(raw: str) -> tuple[int, int]:
    width, _, height = raw.lower().partition("x")
    return int(width), int(height)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "screens",
        nargs="*",
        # Validated below rather than via `choices=`: argparse checks a
        # nargs="*" positional's empty default against choices too, so
        # "render everything" would be rejected as an invalid choice.
        help=f"Screens to render (default: all of {', '.join(SCREENS)}).",
    )
    parser.add_argument(
        "--dimensions",
        default="800x480",
        help="Panel size as WIDTHxHEIGHT (default: 800x480).",
    )
    parser.add_argument(
        "--palette",
        choices=("colour", "bw"),
        default="colour",
        help=(
            "Which panel to resolve against: the six-colour Spectra 6 preview "
            "(default) or the black-and-white fallback every accent collapses "
            "to on a mono panel."
        ),
    )
    parser.add_argument(
        "--suffix",
        default="",
        help="Appended to each output filename, e.g. --suffix _bw.",
    )
    parser.add_argument(
        "--out-dir",
        default=str(OUTPUT_DIR),
        help=f"Output directory (default: {OUTPUT_DIR}).",
    )
    args = parser.parse_args()

    # Read per-render by homeboard.palette, so flipping it here is enough.
    os.environ["HOMEBOARD_COLOUR_PREVIEW"] = "0" if args.palette == "bw" else "1"

    unknown = [screen for screen in args.screens if screen not in SCREENS]
    if unknown:
        parser.error(
            f"unknown screen(s): {', '.join(unknown)} "
            f"(choose from {', '.join(SCREENS)})"
        )

    _install_stubs()
    dimensions = _parse_dimensions(args.dimensions)
    out_dir = Path(args.out_dir)

    for screen in args.screens or list(SCREENS):
        path = render(screen, dimensions, out_dir, suffix=args.suffix)
        print(f"{screen}: {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
