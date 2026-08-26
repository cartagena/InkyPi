# pyright: reportMissingImports=false
"""Tests for the plugin disable/enable feature.

Covers Config's disabled_plugins persistence, the interaction with
plugin_registry.load_plugins() (see the regression class below), and the
/plugin/<id>/disable and /plugin/<id>/enable routes.
"""

from typing import Any

from flask.testing import FlaskClient

from plugins.plugin_registry import (
    get_registered_plugin_ids,
    load_plugins,
    reset_plugin_registry,
)


class TestConfigDisabledPlugins:
    def test_disable_then_enable_round_trip(self, device_config_dev: Any) -> None:
        assert device_config_dev.get_disabled_plugin_ids() == set()

        device_config_dev.set_plugin_disabled("clock", True)
        assert device_config_dev.get_disabled_plugin_ids() == {"clock"}

        device_config_dev.set_plugin_disabled("clock", False)
        assert device_config_dev.get_disabled_plugin_ids() == set()

    def test_get_plugins_excludes_disabled_by_default(
        self, device_config_dev: Any
    ) -> None:
        device_config_dev.set_plugin_disabled("clock", True)

        ids = {p["id"] for p in device_config_dev.get_plugins()}
        assert "clock" not in ids
        assert "weather" in ids

    def test_get_plugins_include_disabled_returns_full_list_annotated(
        self, device_config_dev: Any
    ) -> None:
        device_config_dev.set_plugin_disabled("clock", True)

        all_plugins = {
            p["id"]: p for p in device_config_dev.get_plugins(include_disabled=True)
        }
        assert all_plugins["clock"]["disabled"] is True
        assert all_plugins["weather"]["disabled"] is False


class TestDisabledPluginStaysRegistered:
    """Regression coverage for the boot/worker registry interaction.

    plugin_registry.load_plugins() has its own long-standing (and separately
    tested, see test_plugin_registry.py) "disabled" skip check on each plugin
    config dict. Config.get_plugins(include_disabled=True) reuses the same
    "disabled" key to mark UI-disabled plugins, so passing that list straight
    into load_plugins() would make it skip registering them too — breaking
    already-configured playlist instances of a disabled plugin. src/inkypi.py
    and src/refresh_task/worker.py both force disabled=False on every entry
    before calling load_plugins() for exactly this reason; these tests pin
    that behavior down.
    """

    def test_loader_reset_keeps_disabled_plugin_registered(
        self, device_config_dev: Any
    ) -> None:
        device_config_dev.set_plugin_disabled("clock", True)
        reset_plugin_registry()

        plugins_for_registry = device_config_dev.get_plugins(include_disabled=True)
        for p in plugins_for_registry:
            p["disabled"] = False
        load_plugins(plugins_for_registry)

        assert "clock" in get_registered_plugin_ids()

    def test_without_reset_disabled_plugin_would_be_dropped(
        self, device_config_dev: Any
    ) -> None:
        """Documents the failure mode the reset above guards against."""
        device_config_dev.set_plugin_disabled("clock", True)
        reset_plugin_registry()

        load_plugins(device_config_dev.get_plugins(include_disabled=True))

        assert "clock" not in get_registered_plugin_ids()


class TestDisableEnableRoutes:
    def test_disable_route_success(
        self, client: FlaskClient, device_config_dev: Any
    ) -> None:
        resp = client.post("/plugin/clock/disable")
        assert resp.status_code == 200
        data = resp.get_json()
        assert data["success"] is True
        assert data["disabled_plugins"] == ["clock"]
        assert device_config_dev.get_disabled_plugin_ids() == {"clock"}

    def test_enable_route_success(
        self, client: FlaskClient, device_config_dev: Any
    ) -> None:
        device_config_dev.set_plugin_disabled("clock", True)

        resp = client.post("/plugin/clock/enable")
        assert resp.status_code == 200
        data = resp.get_json()
        assert data["success"] is True
        assert data["disabled_plugins"] == []
        assert device_config_dev.get_disabled_plugin_ids() == set()

    def test_disable_unknown_plugin_returns_404(self, client: FlaskClient) -> None:
        resp = client.post("/plugin/not_a_real_plugin/disable")
        assert resp.status_code == 404
        assert resp.get_json()["success"] is False

    def test_plugins_page_lists_disabled_plugin_in_disabled_section(
        self, client: FlaskClient, device_config_dev: Any
    ) -> None:
        device_config_dev.set_plugin_disabled("weather", True)

        resp = client.get("/plugins")
        assert resp.status_code == 200
        html = resp.get_data(as_text=True)
        assert "Disabled plugins (1)" in html
        assert 'data-plugin-toggle="enable"' in html
        assert 'data-plugin-id="weather"' in html
