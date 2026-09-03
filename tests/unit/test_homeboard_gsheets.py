"""Unit tests for homeboard.adapters.gsheets — no live network calls."""

from __future__ import annotations

from typing import Any
from unittest.mock import MagicMock

import pytest

from homeboard.adapters import gsheets


class TestReadWorksheetConfigErrors:
    def test_missing_sheet_id_raises_runtime_error(self) -> None:
        with pytest.raises(RuntimeError, match="Sheet ID"):
            gsheets.read_worksheet("", "Maintenance", "/tmp/creds.json")

    def test_missing_worksheet_name_raises_runtime_error(self) -> None:
        with pytest.raises(RuntimeError, match="Worksheet name"):
            gsheets.read_worksheet("sheet123", "", "/tmp/creds.json")

    def test_missing_credentials_path_raises_runtime_error(self) -> None:
        with pytest.raises(RuntimeError, match="service account"):
            gsheets.read_worksheet("sheet123", "Maintenance", "")

    def test_unreadable_credentials_file_raises_runtime_error(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Any
    ) -> None:
        missing_path = str(tmp_path / "does-not-exist.json")
        with pytest.raises(RuntimeError, match="credentials"):
            gsheets.read_worksheet("sheet123", "Maintenance", missing_path)


class TestReadWorksheetParsing:
    def _mock_service(self, values: list[list[str]]) -> MagicMock:
        service = MagicMock()
        service.spreadsheets.return_value.values.return_value.get.return_value.execute.return_value = {
            "values": values
        }
        return service

    def test_parses_rows_keyed_by_header(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Any
    ) -> None:
        creds_path = tmp_path / "creds.json"
        creds_path.write_text("{}", encoding="utf-8")

        monkeypatch.setattr(
            gsheets.service_account.Credentials,
            "from_service_account_file",
            classmethod(lambda cls, *a, **k: MagicMock()),
        )
        service = self._mock_service(
            [
                ["task", "interval_value", "interval_unit"],
                ["Replace furnace filter", "3", "months"],
                ["Flush water heater", "1", "years"],
            ]
        )
        monkeypatch.setattr(gsheets, "build", lambda *a, **k: service)

        rows = gsheets.read_worksheet("sheet123", "Maintenance", str(creds_path))
        assert rows == [
            {
                "task": "Replace furnace filter",
                "interval_value": "3",
                "interval_unit": "months",
            },
            {
                "task": "Flush water heater",
                "interval_value": "1",
                "interval_unit": "years",
            },
        ]

    def test_empty_sheet_returns_empty_list(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Any
    ) -> None:
        creds_path = tmp_path / "creds.json"
        creds_path.write_text("{}", encoding="utf-8")

        monkeypatch.setattr(
            gsheets.service_account.Credentials,
            "from_service_account_file",
            classmethod(lambda cls, *a, **k: MagicMock()),
        )
        monkeypatch.setattr(gsheets, "build", lambda *a, **k: self._mock_service([]))

        assert gsheets.read_worksheet("sheet123", "Maintenance", str(creds_path)) == []

    def test_short_rows_are_padded_with_empty_strings(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Any
    ) -> None:
        creds_path = tmp_path / "creds.json"
        creds_path.write_text("{}", encoding="utf-8")

        monkeypatch.setattr(
            gsheets.service_account.Credentials,
            "from_service_account_file",
            classmethod(lambda cls, *a, **k: MagicMock()),
        )
        service = self._mock_service(
            [
                ["task", "interval_value", "next_due_override"],
                ["Replace furnace filter", "3"],  # missing trailing column
            ]
        )
        monkeypatch.setattr(gsheets, "build", lambda *a, **k: service)

        rows = gsheets.read_worksheet("sheet123", "Maintenance", str(creds_path))
        assert rows == [
            {
                "task": "Replace furnace filter",
                "interval_value": "3",
                "next_due_override": "",
            }
        ]

    def test_transient_api_error_is_not_wrapped_as_runtime_error(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Any
    ) -> None:
        creds_path = tmp_path / "creds.json"
        creds_path.write_text("{}", encoding="utf-8")

        monkeypatch.setattr(
            gsheets.service_account.Credentials,
            "from_service_account_file",
            classmethod(lambda cls, *a, **k: MagicMock()),
        )

        def _boom(*a: object, **k: object) -> None:
            raise TimeoutError("network blip")

        monkeypatch.setattr(gsheets, "build", _boom)

        # A transient failure must propagate as-is (not RuntimeError), so
        # homeboard.cache.cached_fetch's default config_errors=(RuntimeError,)
        # treats it as fail-soft rather than tripping the circuit breaker.
        with pytest.raises(TimeoutError):
            gsheets.read_worksheet("sheet123", "Maintenance", str(creds_path))
