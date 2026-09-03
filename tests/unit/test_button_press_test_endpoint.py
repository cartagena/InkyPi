"""Tests for the opt-in /__test/button_press endpoint.

Mirrors tests/unit/test_smoke_render.py's shape: the route must be
* Absent from the app when neither --dev mode nor the env var is set
* Present and CSRF-exempt when either is set
* Dispatch through ButtonTask.press() using the exact same debounce +
  ACTIONS path a real GPIO edge event would
"""

from __future__ import annotations

from typing import Any
from unittest.mock import MagicMock

import pytest
from flask import Flask

from app_setup.button_press_test import (
    BUTTON_PRESS_TEST_ENV_VAR,
    BUTTON_PRESS_TEST_PATH,
    button_press_test_enabled,
    register_button_press_test_endpoint,
)


def _make_app(*, button_task: Any = None) -> Flask:
    """Build a tiny Flask app wired just enough for the button-press endpoint."""
    app = Flask(__name__)
    app.secret_key = "test-button-press"
    if button_task is not None:
        app.config["BUTTON_TASK"] = button_task
    register_button_press_test_endpoint(app)
    return app


def _clear_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("INKYPI_ENV", raising=False)
    monkeypatch.delenv("FLASK_ENV", raising=False)
    monkeypatch.delenv(BUTTON_PRESS_TEST_ENV_VAR, raising=False)


def test_not_registered_without_dev_mode_or_env_var(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _clear_env(monkeypatch)
    assert button_press_test_enabled() is False

    app = _make_app()
    client = app.test_client()

    resp = client.post(BUTTON_PRESS_TEST_PATH, data={"button": "A"})
    assert resp.status_code == 404

    rules = [str(rule) for rule in app.url_map.iter_rules()]
    assert BUTTON_PRESS_TEST_PATH not in rules


def test_registered_in_dev_mode(monkeypatch: pytest.MonkeyPatch) -> None:
    _clear_env(monkeypatch)
    monkeypatch.setenv("INKYPI_ENV", "dev")
    assert button_press_test_enabled() is True

    app = _make_app(button_task=MagicMock())
    rules = [str(rule) for rule in app.url_map.iter_rules()]
    assert BUTTON_PRESS_TEST_PATH in rules


@pytest.mark.parametrize("value", ["1", "true", "yes", "TRUE"])
def test_registered_when_env_var_set(
    monkeypatch: pytest.MonkeyPatch, value: str
) -> None:
    _clear_env(monkeypatch)
    monkeypatch.setenv(BUTTON_PRESS_TEST_ENV_VAR, value)
    assert button_press_test_enabled() is True

    app = _make_app(button_task=MagicMock())
    rules = [str(rule) for rule in app.url_map.iter_rules()]
    assert BUTTON_PRESS_TEST_PATH in rules


def test_press_dispatches_through_button_task(monkeypatch: pytest.MonkeyPatch) -> None:
    _clear_env(monkeypatch)
    monkeypatch.setenv(BUTTON_PRESS_TEST_ENV_VAR, "1")
    button_task = MagicMock()
    button_task.configured_action.return_value = "next_playlist_item"
    app = _make_app(button_task=button_task)
    client = app.test_client()

    resp = client.post(BUTTON_PRESS_TEST_PATH, data={"button": "a"})

    assert resp.status_code == 200
    payload = resp.get_json()
    assert payload["success"] is True
    assert payload["message"] == "Simulated button A press."
    assert payload["button"] == "A"
    assert payload["action"] == "next_playlist_item"
    button_task.press.assert_called_once_with("A")


def test_press_accepts_json_body(monkeypatch: pytest.MonkeyPatch) -> None:
    _clear_env(monkeypatch)
    monkeypatch.setenv(BUTTON_PRESS_TEST_ENV_VAR, "1")
    button_task = MagicMock()
    button_task.configured_action.return_value = "refresh_now"
    app = _make_app(button_task=button_task)
    client = app.test_client()

    resp = client.post(BUTTON_PRESS_TEST_PATH, json={"button": "B"})

    assert resp.status_code == 200
    button_task.press.assert_called_once_with("B")


def test_invalid_button_label_rejected(monkeypatch: pytest.MonkeyPatch) -> None:
    _clear_env(monkeypatch)
    monkeypatch.setenv(BUTTON_PRESS_TEST_ENV_VAR, "1")
    button_task = MagicMock()
    app = _make_app(button_task=button_task)
    client = app.test_client()

    resp = client.post(BUTTON_PRESS_TEST_PATH, data={"button": "Z"})

    assert resp.status_code == 422
    button_task.press.assert_not_called()


def test_missing_button_task_returns_500(monkeypatch: pytest.MonkeyPatch) -> None:
    _clear_env(monkeypatch)
    monkeypatch.setenv(BUTTON_PRESS_TEST_ENV_VAR, "1")
    app = _make_app()
    client = app.test_client()

    resp = client.post(BUTTON_PRESS_TEST_PATH, data={"button": "A"})

    assert resp.status_code == 500


def test_disabled_at_request_time_returns_404(monkeypatch: pytest.MonkeyPatch) -> None:
    """Route stays registered, but re-checks the env var per request (defense in depth)."""
    _clear_env(monkeypatch)
    monkeypatch.setenv(BUTTON_PRESS_TEST_ENV_VAR, "1")
    button_task = MagicMock()
    app = _make_app(button_task=button_task)
    client = app.test_client()

    monkeypatch.delenv(BUTTON_PRESS_TEST_ENV_VAR, raising=False)
    resp = client.post(BUTTON_PRESS_TEST_PATH, data={"button": "A"})

    assert resp.status_code == 404
    button_task.press.assert_not_called()
