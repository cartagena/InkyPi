"""Tests for the /api/blackout route (B12 kill switch)."""

from typing import Any

from flask import Flask
from flask.testing import FlaskClient


class TestBlackoutRoute:
    def test_get_toggles_on_from_off(
        self, client: FlaskClient, flask_app: Flask
    ) -> None:
        refresh_task = flask_app.config["REFRESH_TASK"]
        assert refresh_task.blackout_active is False

        resp = client.get("/api/blackout")

        assert resp.status_code == 200
        data = resp.get_json()
        assert data["success"] is True
        assert data["blackout_active"] is True
        assert refresh_task.blackout_active is True

    def test_get_toggles_off_from_on(
        self, client: FlaskClient, flask_app: Flask
    ) -> None:
        refresh_task = flask_app.config["REFRESH_TASK"]
        refresh_task.blackout_active = True

        resp = client.get("/api/blackout")

        assert resp.status_code == 200
        data = resp.get_json()
        assert data["blackout_active"] is False
        assert refresh_task.blackout_active is False

    def test_get_explicit_active_true(
        self, client: FlaskClient, flask_app: Flask
    ) -> None:
        resp = client.get("/api/blackout?active=1")
        assert resp.get_json()["blackout_active"] is True
        assert flask_app.config["REFRESH_TASK"].blackout_active is True

        resp = client.get("/api/blackout?active=1")
        # Idempotent: already active, asking for active again stays active.
        assert resp.get_json()["blackout_active"] is True

    def test_get_explicit_active_false(
        self, client: FlaskClient, flask_app: Flask
    ) -> None:
        flask_app.config["REFRESH_TASK"].blackout_active = True
        resp = client.get("/api/blackout?active=0")
        assert resp.get_json()["blackout_active"] is False

    def test_state_persists_to_device_config(
        self, client: FlaskClient, device_config_dev: Any
    ) -> None:
        client.get("/api/blackout?active=true")
        assert device_config_dev.get_config("blackout_active") is True

    def test_post_toggles_same_as_get(
        self, client: FlaskClient, flask_app: Flask
    ) -> None:
        resp = client.post("/api/blackout", data={"active": "1"})
        assert resp.status_code == 200
        assert resp.get_json()["blackout_active"] is True
        assert flask_app.config["REFRESH_TASK"].blackout_active is True

    def test_display_next_refuses_while_blackout_active(
        self, client: FlaskClient, flask_app: Flask
    ) -> None:
        """Regression: /display-next must not silently advance the playlist
        index while blacked out — see the advance_playlist_next() blackout
        regression test for why get_next_eligible_plugin() can't be allowed
        to run first."""
        flask_app.config["REFRESH_TASK"].blackout_active = True

        resp = client.post("/display-next")

        assert resp.status_code == 409
