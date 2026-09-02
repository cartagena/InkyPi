"""Opt-in /__test/button_press endpoint — simulate a button press without hardware.

Lets a configured button action (see button_task.py's ACTIONS registry) be
exercised from dev/CI without real GPIO/gpiod hardware — the same problem
app_setup/smoke.py's render endpoint solves for plugin rendering, and this
module follows its pattern closely: opt-in only, registered (and CSRF-exempt,
see security_middleware.py) only when explicitly enabled, so production
deployments have zero exposure from this route.

Enabled automatically in ``--dev`` mode (``INKYPI_ENV``/``FLASK_ENV``, same
check ``inkypi.py``'s own ``_env_dev_mode()`` uses), or explicitly via
``INKYPI_ENABLE_BUTTON_PRESS_TEST=1`` (e.g. for a CI job that isn't running
--dev but still wants to hit this endpoint against a real build).
``button_press_test_enabled()`` takes no arguments — deliberately, like
``smoke.smoke_render_enabled`` — so both the route registration in
``inkypi.py`` and the CSRF/rate-limit exemptions in
``security_middleware.py`` read the exact same, request-time-evaluated
condition without threading a ``dev_mode`` flag between modules.
"""

from __future__ import annotations

import logging
import os

from flask import Flask, current_app, request

from button_task import VALID_LABELS
from utils.http_utils import JsonResponse, json_error, json_success

logger = logging.getLogger(__name__)

#: Path of the opt-in button-press test endpoint. Prefixed with ``__test`` so
#: it is visibly non-production and unlikely to collide with real routes.
BUTTON_PRESS_TEST_PATH = "/__test/button_press"

#: Environment variable that force-enables the endpoint outside --dev mode.
BUTTON_PRESS_TEST_ENV_VAR = "INKYPI_ENABLE_BUTTON_PRESS_TEST"

_TRUTHY = frozenset({"1", "true", "yes"})


def _env_dev_mode() -> bool:
    env_mode = (
        os.getenv("INKYPI_ENV", "").strip() or os.getenv("FLASK_ENV", "").strip()
    ).lower()
    return env_mode in ("dev", "development")


def button_press_test_enabled() -> bool:
    """Return True if the button-press test endpoint should be active.

    Read at request time (not just registration time) so tests can toggle
    the env var via monkeypatch without reloading the module — mirrors
    ``smoke.smoke_render_enabled``.
    """
    return (
        _env_dev_mode()
        or os.getenv(BUTTON_PRESS_TEST_ENV_VAR, "").strip().lower() in _TRUTHY
    )


def _extract_button_label() -> str:
    """Pull the button label out of form data or a JSON body, uppercased."""
    raw = request.form.get("button")
    if not raw:
        body = request.get_json(silent=True)
        if isinstance(body, dict):
            raw = body.get("button")
    return str(raw or "").strip().upper()


def register_button_press_test_endpoint(app: Flask) -> None:
    """Register the opt-in button-press test endpoint when enabled.

    A no-op when disabled, so production builds add zero attack surface from
    this module — same defense-in-depth shape as
    ``smoke.register_smoke_endpoints``.
    """
    if not button_press_test_enabled():
        return

    logger.info(
        "Registering %s (--dev mode or %s is set)",
        BUTTON_PRESS_TEST_PATH,
        BUTTON_PRESS_TEST_ENV_VAR,
    )

    @app.route(BUTTON_PRESS_TEST_PATH, methods=["POST"])
    def button_press_test() -> JsonResponse:
        # Defense in depth: re-check at request time, same reasoning as the
        # smoke render endpoint — an operator could unset the env var after
        # Flask has already registered the route.
        if not button_press_test_enabled():
            return json_error("Button press test endpoint not enabled", status=404)

        label = _extract_button_label()
        if label not in VALID_LABELS:
            return json_error(
                "button must be one of A, B, C, D",
                status=422,
                code="validation_error",
                details={"field": "button"},
            )

        button_task = current_app.config.get("BUTTON_TASK")
        if button_task is None:
            return json_error("Button task unavailable", status=500)

        # Goes through the same debounce + ACTIONS dispatch a real GPIO edge
        # event would (button_task.py's _handle_press, via the public
        # press() wrapper) — this only needs the ButtonTask object to exist,
        # not gpiod/hardware or the poll thread to actually be running.
        button_task.press(label)

        return json_success(
            message=f"Simulated button {label} press.",
            button=label,
            action=button_task.configured_action(label),
        )
