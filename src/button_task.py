"""ButtonTask — polls the Inky Impression's physical buttons (A-D).

Each button's action is configurable via the ``buttons`` block in
device.json (``buttons.actions.A``, etc.) — see the settings UI's "Physical
Buttons" section. Available actions are the keys of ``ACTIONS`` below.

Runs as its own daemon thread alongside ``RefreshTask``, following the same
pattern as the ``WatchdogHeartbeat`` thread in ``refresh_task/task.py``: a
second thread, coordinated only through thread-safe calls, never touching the
display or config directly. Button presses are dispatched via methods on
``RefreshTask`` (``advance_playlist_next``, ``refresh_current``,
``set_blackout``), which in turn go through ``manual_update()`` and run the
actual refresh on the refresh thread — see those methods' docstrings for why
(upstream InkyPi PR #686's write-race note).

Hardware access (``gpiod``/``gpiodevice``) is imported lazily inside
``start()`` so this module always imports cleanly off-Pi, mirroring the
``try/except ImportError`` guard ``display/display_manager.py`` uses for the
Inky/Waveshare drivers.
"""

import logging
import threading
from collections.abc import Callable
from time import monotonic
from typing import Any

logger = logging.getLogger(__name__)

#: BCM GPIO numbers for buttons A-D on Inky Impression boards (4", 5.7",
#: 7.3"). The 13.3" variant uses GPIO 25 for C instead of 16 — override via
#: config (``buttons.pins.C``). See examples/spectra6/buttons.py upstream.
DEFAULT_PINS: dict[str, int] = {"A": 5, "B": 6, "C": 16, "D": 24}

#: Only button A does anything out of the box; B-D are opt-in.
DEFAULT_ACTIONS: dict[str, str] = {
    "A": "next_playlist_item",
    "B": "none",
    "C": "none",
    "D": "none",
}

_DEFAULT_DEBOUNCE_SECONDS = 1.0

#: How long a single ``wait_edge_events()`` call blocks before rechecking
#: ``self.running`` — keeps ``stop()`` responsive without busy-polling.
_POLL_TIMEOUT_SECONDS = 0.25

#: Action name -> callable(refresh_task) -> bool (whether a refresh was
#: dispatched). "none" deliberately does nothing.
ACTIONS: dict[str, Callable[[Any], bool]] = {
    "none": lambda refresh_task: False,
    "next_playlist_item": lambda refresh_task: bool(
        refresh_task.advance_playlist_next()
    ),
    "refresh_now": lambda refresh_task: bool(refresh_task.refresh_current()),
    "blackout_toggle": lambda refresh_task: bool(
        refresh_task.set_blackout(not refresh_task.blackout_active)
    ),
}

_VALID_LABELS = ("A", "B", "C", "D")


class ButtonTask:
    """Polls Inky Impression buttons A-D and dispatches configured actions."""

    def __init__(self, device_config: Any, refresh_task: Any) -> None:
        self.device_config = device_config
        self.refresh_task = refresh_task
        self.thread: threading.Thread | None = None
        self.running = False
        self._request: Any = None
        #: GPIO line offset -> button label ("A"-"D"), built at start().
        self._offset_labels: dict[int, str] = {}
        self._last_press_monotonic: dict[str, float] = {}

    def _buttons_config(self) -> dict[str, Any]:
        raw = self.device_config.get_config("buttons", default={})
        return raw if isinstance(raw, dict) else {}

    def _pins(self) -> dict[str, int]:
        configured = self._buttons_config().get("pins")
        pins = dict(DEFAULT_PINS)
        if isinstance(configured, dict):
            for label, pin in configured.items():
                if label in pins:
                    try:
                        pins[label] = int(pin)
                    except (TypeError, ValueError):
                        logger.warning(
                            "Ignoring invalid GPIO pin for button %s: %r", label, pin
                        )
        return pins

    def _actions(self) -> dict[str, str]:
        configured = self._buttons_config().get("actions")
        actions = dict(DEFAULT_ACTIONS)
        if isinstance(configured, dict):
            for label, action in configured.items():
                if label in actions and action in ACTIONS:
                    actions[label] = action
        return actions

    def configured_action(self, label: str) -> str:
        """Return the action name configured for button *label* ("A"-"D")."""
        return self._actions().get(label, "none")

    def _should_start(self) -> bool:
        display_type = self.device_config.get_config("display_type", default="inky")
        if display_type != "inky":
            return False
        return bool(self._buttons_config().get("enabled", True))

    def start(self) -> None:
        """Start the button-poll thread, if hardware and config allow it.

        Silently does nothing when ``display_type`` isn't ``"inky"``, buttons
        are disabled in config, no button has a non-``"none"`` action
        configured, or ``gpiod``/``gpiodevice`` aren't importable (matches
        how ``DisplayManager`` treats a missing Inky driver as "hardware
        support disabled" rather than an error) — every one of those is an
        expected, non-Pi outcome, not a startup failure.
        """
        if self.thread is not None and self.thread.is_alive():
            return
        if not self._should_start():
            return

        actions = self._actions()
        active_labels = [label for label, action in actions.items() if action != "none"]
        if not active_labels:
            logger.info("Button task not starting: every button is set to 'none'")
            return

        try:
            import gpiod
            import gpiodevice
            from gpiod.line import Bias, Direction, Edge
        except ImportError:
            logger.info("Button support unavailable (gpiod not installed)")
            return

        pins = self._pins()

        try:
            chip = gpiodevice.find_chip_by_platform()
            line_settings = gpiod.LineSettings(
                direction=Direction.INPUT,
                bias=Bias.PULL_UP,
                edge_detection=Edge.FALLING,
            )
            offset_labels: dict[int, str] = {}
            line_config = {}
            for label in active_labels:
                offset = chip.line_offset_from_id(pins[label])
                offset_labels[offset] = label
                line_config[offset] = line_settings
            self._request = chip.request_lines(
                consumer="inkypi-buttons", config=line_config
            )
            self._offset_labels = offset_labels
        except Exception:
            logger.warning("Could not initialize button GPIO lines", exc_info=True)
            self._request = None
            self._offset_labels = {}
            return

        self.running = True
        self.thread = threading.Thread(target=self._run, daemon=True, name="ButtonTask")
        self.thread.start()
        logger.info(
            "Button task started: %s",
            ", ".join(
                f"{label}={pins[label]}:{actions[label]}" for label in active_labels
            ),
        )

    def stop(self) -> None:
        """Stop the button-poll thread and release the GPIO lines."""
        self.running = False
        if self.thread:
            self.thread.join(timeout=5)
            if self.thread.is_alive():
                logger.warning("Button task thread did not stop within timeout")
        self.thread = None
        if self._request is not None:
            try:
                self._request.release()
            except Exception:
                logger.debug("Error releasing button GPIO lines", exc_info=True)
            self._request = None
        self._offset_labels = {}

    def _debounce_seconds(self) -> float:
        raw = self._buttons_config().get("debounce_seconds", _DEFAULT_DEBOUNCE_SECONDS)
        try:
            return max(0.0, float(raw))
        except (TypeError, ValueError):
            return _DEFAULT_DEBOUNCE_SECONDS

    def _handle_press(self, label: str) -> None:
        now = monotonic()
        debounce = self._debounce_seconds()
        last = self._last_press_monotonic.get(label, 0.0)
        if now - last < debounce:
            return
        self._last_press_monotonic[label] = now

        action_name = self._actions().get(label, "none")
        action = ACTIONS.get(action_name, ACTIONS["none"])
        logger.info("Button %s pressed: dispatching action %r", label, action_name)
        try:
            action(self.refresh_task)
        except Exception:
            logger.exception("Button %s action %r failed", label, action_name)

    def press(self, label: str) -> None:
        """Simulate a physical press of button *label* ("A"-"D").

        Public entry point for the hardware-free ``/__test/button_press``
        endpoint (see ``app_setup/button_press_test.py``) and for tests —
        goes through the exact same debounce + action-dispatch path a real
        GPIO edge event would (``_handle_press``), without requiring
        gpiod/hardware to be present or the poll thread to be running.
        """
        if label not in _VALID_LABELS:
            raise ValueError(f"Unknown button label: {label!r}")
        self._handle_press(label)

    def _run(self) -> None:
        """Poll for edge events until ``stop()`` clears ``self.running``.

        ``read_edge_events()`` has no timeout parameter — it blocks
        indefinitely — so waiting is split from reading via
        ``wait_edge_events(timeout=...)``, which returns ``False`` on
        timeout. That keeps this loop rechecking ``self.running``
        periodically instead of blocking ``stop()`` until the next press.
        """
        assert self._request is not None
        while self.running:
            try:
                ready = self._request.wait_edge_events(timeout=_POLL_TIMEOUT_SECONDS)
                if not ready:
                    continue
                events = self._request.read_edge_events()
            except Exception:
                logger.exception("Button GPIO read failed; stopping button task")
                self.running = False
                break
            for event in events:
                label = self._offset_labels.get(event.line_offset)
                if label is not None:
                    self._handle_press(label)
