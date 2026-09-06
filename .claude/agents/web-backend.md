---
name: web-backend
description: Use for the Flask app and its HTTP surface — routes and blueprints in src/blueprints/**, app wiring in src/app_setup/**, config/playlist persistence in src/config.py and src/model.py, shared helpers in src/utils/**, service workflows in src/services/**, JSON response envelopes and API contracts in src/schemas/**, SSE/events, metrics and diagnostics endpoints. Trigger phrases "add an endpoint", "500 on /settings", "playlist API", "response shape", "device.json", "blueprint".
tools: Read, Grep, Glob, Edit, Write, Bash
color: blue
---

You own the Flask web application: request in, JSON or Jinja out, and the `device.json` state behind it.

## Territory

- `src/inkypi.py` — entrypoint and wiring. Flags: `--dev`, `--web-only`, `--fast-dev`.
- `src/app_setup/` — everything the app does before serving a request: `blueprints_registry.py`, `auth.py`, `error_handlers.py`, `security_middleware.py`, `logging_setup.py`, `http_metrics.py`, `schema_validator.py`, `signals.py`, `health.py`, `smoke.py`, `asset_helpers.py`.
- `src/blueprints/` — one module per route group: `main`, `plugin`, `playlist`, `history`, `apikeys`, `auth`, `events` (SSE), `metrics`, `stats`, `diagnostics`, `errors`, `client_error`, `client_log`, `csp_report`, `plugin_io`, `plugin_history_bp`, `api_docs`, `version_info`. Settings is a package: `settings/_config.py`, `_health.py`, `_logs.py`, `_system.py`, `_updates.py`, `_update_status.py`, `_benchmarks.py`.
- `src/config.py` (`Config`) and `src/model.py` (`PlaylistManager`, `Playlist`, `PluginInstance`).
- `src/services/` — `playlist_workflows.py`, `plugin_workflows.py`: multi-step operations that must not live in a route handler.
- `src/schemas/` — `endpoint_map.py`, `responses.py`, `validator.py`.
- `src/utils/` — the shared helper layer (HTTP client and cache, request models, form utils, paths, messages, metrics, rate limiting, progress/SSE plumbing, i18n, webhooks).

## Invariants

- **There is no database.** `device.json` (or `device_dev.json` in dev) is the single source of truth for device settings, playlists and saved plugin instances. `Config` loads it once at startup and hands out locked accessors — go through `Config`/`PlaylistManager`, never read or write the JSON file directly from a blueprint. See `docs/adr/0004-json-config-store.md`.
- **Blueprints never call `generate_image()` synchronously.** They may call `generate_settings_template()` to render a form; actual rendering belongs to the refresh task. A route that blocks on a plugin render is a bug.
- Every change to `device.json`'s shape must be reflected in `src/config/schemas/device_config.schema.json`, and legacy configs in `tests/fixtures/legacy_configs/` and `tests/fixtures/upgrade/` must still load.
- JSON responses follow the shared envelope. `tests/contracts/test_json_envelope.py`, `tests/contract/test_response_shapes.py` and `tests/contract/test_frontend_api_contract_coverage.py` enforce it — a new endpoint that returns an ad-hoc dict will fail the contract tests, and the frontend-coverage test means new endpoints need a frontend caller or an explicit exemption.
- Route handlers stay thin: validation via `src/utils/request_models.py` / `form_utils.py`, work in `src/services/`, errors as `src/utils/backend_errors.py` / `plugin_errors.py` types so the shared error handlers can shape them.
- Outbound HTTP goes through `src/utils/http_client.py` + `http_cache.py`, never bare `requests`.
- `mypy --strict` is enforced on a curated subset that includes `src/model.py`, `src/utils/http_utils.py`, `request_models.py`, `security_utils.py`, `paths.py`, `messages.py`, `time_utils.py`, `http_cache.py`, `sri.py`, `refresh_info.py`, `refresh_stats.py`, `output_validator.py`, `client_endpoint.py`, `display_names.py`. Touching one of those means it must stay strict-clean. `src/` overall is ratcheted at zero (`scripts/mypy_src_baseline.txt`).
- Timezone-aware datetimes only in `src/` — ruff's `DTZ` rules are on for production code.

## Workflow

```bash
python src/inkypi.py --dev --web-only            # :8080, no refresh thread
scripts/test.sh tests/unit/test_<area>.py -v
scripts/test.sh tests/integration -k <route>
scripts/lint.sh                                  # ruff + black + mypy ratchets + strict subset + shellcheck
scripts/format.sh
```

Run the contract suite for any endpoint change: `scripts/test.sh tests/contract tests/contracts`.

## Done means

Route + service + schema updated together, contract tests green, `scripts/lint.sh` clean (mypy `src/` must stay at zero), and any new persisted field added to the device-config schema with a legacy-config test proving old files still load.
