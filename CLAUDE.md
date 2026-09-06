# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

InkyPi is a Flask web app + background refresh task (same process) that drives e-ink displays
(Pimoroni Inky, Waveshare) from a Raspberry Pi.

Fork topology is three levels deep — `fatihak/InkyPi` → `jtn0123/InkyPi` → **this checkout**:

- `origin` = `cartagena/InkyPi` — where you work and merge.
- `upstream` = `jtn0123/InkyPi` — a heavily diverged fork of `fatihak/InkyPi`, focused on security
  hardening, testing, and install/update reliability. Treat those as first-class concerns here too.

Sync direction is upstream → origin. Personal features (the Homeboard screens and their `boardbot`
adapter, below) exist only in `origin` and are **not** upstream candidates — keep them out of any
branch you intend to send to `jtn0123`.

## Commands

### Setup
```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r install/requirements-dev.txt
bash install/update_vendors.sh
pre-commit install   # runs ruff, mypy, gitleaks, conventional-commit checks on every commit
```
Or via devbox: `devbox run dev` (installs deps + activates venv automatically, works on macOS/Linux/WSL2).

### Run dev server (no hardware required)
```bash
.venv/bin/python src/inkypi.py --dev --web-only   # web UI only, port 8080
.venv/bin/python src/inkypi.py --dev              # full program incl. background refresh thread
./scripts/dev.sh                                  # scripted equivalent
./scripts/dev_watch.sh                            # auto-rebuilds CSS/JS on file changes
```
`--dev` avoids needing a Pi, a physical display, root/GPIO, or systemd — works on macOS/Linux/Windows.
Rendered output lands in `runtime/mock_display_output/latest.png`; simulated panel output is at
`/tmp/inkypi-mock-frame.png` or `GET /dev/mock-frame`.

### Test
```bash
scripts/test.sh                                        # fast local runner, sharded across 4 lanes
scripts/test.sh tests/unit/test_refresh_task_stress.py  # single file (runs serial)
scripts/test.sh browser-smoke                           # Playwright browser-smoke gate
scripts/preflash_validate.sh                            # hardware-free pre-flash gate
PYTHONPATH=$(pwd)/src pytest -q                          # serial, for debugging xdist-only issues
```
Browser/a11y tests (Playwright) are excluded from the fast path by default — install Chromium
first with `.venv/bin/python -m playwright install chromium`, then run with `SKIP_BROWSER=0`.
**Any PR touching `src/static/**` or `src/templates/**` must pass `scripts/test.sh browser-smoke`**
before review — `SKIP_BROWSER=1` is not acceptable for those changes.

### Lint / format
```bash
scripts/lint.sh     # ruff + black --check + mypy (ratcheted src/tests + blocking strict subset) + shellcheck
scripts/format.sh    # auto-fix formatting
python3 scripts/build_css.py           # rebuild bundled CSS after editing src/static/styles/partials/
python3 scripts/build_css.py --check   # verify main.css matches the partials (CI checks this)
python3 scripts/build_assets.py        # rebuild the JS bundle after editing src/static/scripts/
```
`src/static/styles/main.css` is **generated** — edit a partial and rebuild, never the bundle.
`scripts/dev_watch.sh` does both rebuilds automatically while you work.
mypy on `src/` must stay at the checked-in baseline in `scripts/mypy_src_baseline.txt` (currently
0 — don't introduce new errors); `tests/` is ratcheted against `scripts/mypy_tests_baseline.txt`
(currently 691). A curated file list (the `mypy --strict` invocation in `scripts/lint.sh`) is fully
blocking — check `docs/typing.md` before adding/removing files from that list.

**Never lower the `tests/` baseline from a local run.** It is calibrated to CI, and a local
`scripts/lint.sh` undercounts by ~30: outside CI it sources `venv.sh`, which exports
`PYTHONPATH=src:<repo-root>`, and that extra entry changes how mypy resolves some modules. CI runs
`bare mypy tests` with `CI=true` (skipping `venv.sh`), on Linux (so the `sys_platform == "linux"`
deps — cysystemd, inky, gpiod, spidev — are installed and resolvable) and under Python 3.12. A
macOS checkout reports ~30-60 fewer errors and will read as "ratchet improved" while CI still
fails. Take the number from a CI run. The baseline files themselves carry the full history and
rationale — read them before changing either.

### Plugin validator
```bash
python scripts/plugin_validator.py         # validate all plugins
python scripts/plugin_validator.py clock   # validate one plugin
```

## Architecture

Full diagram and detail: `docs/architecture.md`. Design rationale for non-obvious choices lives in
`docs/adr/` (ADRs) — read these before re-litigating: subprocess plugin isolation, the custom
HTTP cache, playlist scheduling, JSON-file config store, Waitress over Gunicorn, WebP encoding.

- **Web layer**: `src/inkypi.py` wires the Flask app, delegating setup to the `src/app_setup/*`
  helpers introduced by the JTN-289 split — CSP nonce, CSRF, rate limiting, security headers,
  secret key bootstrap, logging, health/smoke endpoints. Routes live in `src/blueprints/*` (main, plugin,
  playlist, settings, apikeys, history, diagnostics, etc.), reading/writing `Config` and
  `PlaylistManager`. Blueprints render Jinja2 templates from `src/templates/` and may call a
  plugin's `generate_settings_template()`, but **never** call `generate_image()` synchronously —
  that only happens in the refresh task.
- **Config layer**: `device.json` (or `device_dev.json` in `--dev` mode, under `src/config/`) is
  the single source of truth for device settings, playlists, and saved plugin instances — there
  is no database. `Config` (`src/config.py`) loads it once at startup; `PlaylistManager`
  (`src/model.py`) is a child of `Config` managing `Playlist` and `PluginInstance` objects.
- **Refresh flow (background)**: `RefreshTask` (`src/refresh_task/task.py`) runs in a background
  thread, asks `PlaylistManager` for the next plugin instance based on schedule + circuit-breaker
  `paused` state, then **spawns a subprocess** to run `plugin.generate_image()` in isolation (a
  crashing/leaking plugin can't take down the app). The `PIL.Image` result comes back over a
  queue; the parent updates `plugin_health` (circuit breaker) and pushes the image to
  `DisplayManager` (`src/display/display_manager.py`), which selects the Inky/Waveshare/mock
  driver based on `device.json`. Key methods: `_determine_next_plugin`, `_update_plugin_health`.
- **Plugins**: `src/plugins/plugin_registry.py` walks `src/plugins/<name>/`, reads each
  `plugin-info.json`, imports the class, and instantiates it. Every plugin subclasses `BasePlugin`
  (`src/plugins/base_plugin/`) and implements `generate_image(settings, device_config) -> PIL.Image`,
  raising `RuntimeError` with a user-facing message on config/API errors. A `PluginInstance` is one
  saved configuration of a plugin (e.g. two separately-configured Weather instances). See
  `docs/building_plugins.md` for the full guide (hello-world walkthrough at the bottom) — covers
  HTML/CSS-rendered images (via headless Chromium), settings templates, icons, and
  `plugin-info.json` registration. In dev mode, plugin modules hot-reload on access.
  HTML rendering needs a Chrome-like browser on `PATH` — chromium-headless-shell (Debian),
  chromium (other Linux/devbox), or Google Chrome (macOS) — see `docs/development.md` for the
  platform matrix.
- **Homeboard** (fork-specific): `src/homeboard/` is a shared layout/chrome/palette/tag toolkit for
  the dashboard-style screens — `board`, `trips`, `home_maintenance`, `weekends`. Its data comes
  from `src/homeboard/adapters/`: `ical.py`, and `boardbot.py`, a read-only client for a
  self-hosted `boardbot` service (WhatsApp bridge → SQLite → `GET /todo`, `/projects`, `/trips`,
  `/maintenance`). Note the deliberate exception documented in `boardbot.py`: it uses the pooled
  session from `utils.http_client` rather than `utils.http_utils.safe_http_get`, because the SSRF
  guard in that helper rejects private IPs and boardbot is an explicitly-configured LAN service.
  Don't "fix" that back to `safe_http_get`.

## Conventions specific to this repo

- **Run `/code-review low` before opening every PR** (and again after pushing further commits
  to it) — catch correctness bugs and obvious simplification/efficiency issues before a human
  reviewer sees them, not after.
- **Conventional Commits are enforced and drive releases.** PRs are squash-merged and the PR
  title becomes the commit subject on `main`, which `python-semantic-release` parses for the next
  version bump. `pr-title-lint.yml` accepts exactly these types: `feat`, `fix`, `perf`, `refactor`,
  `docs`, `style`, `test`, `build`, `ci`, `chore`, `revert` — anything else (`security:`, `ui:`,
  `css:`) is **rejected** by the title lint and by the local commit-msg hook, not silently accepted.
  The subject must also start with a lowercase letter (`subjectPattern: ^[^A-Z].+$`).
  Of the accepted types only `feat:`/`fix:`/`perf:` bump the version; `feat!:` or a
  `BREAKING CHANGE:` footer triggers a major bump. The rest release nothing, which is usually what
  you want for tooling and docs changes.
- **Always branch from a fresh `origin/main`**, not from a previous feature branch — GitHub's
  squash-merge body concatenates every commit on the branch being merged, so a stale
  `BREAKING CHANGE:` footer from an earlier PR can leak into a new squash and force an unwanted
  major bump.
- **CodeQL suppressions** (`# lgtm[<rule-id>] — <reason>` / `// lgtm[<rule-id>] — <reason>`) require
  the exact rule ID and a specific justification on the flagged line itself — generic
  `# noqa`-style comments and file/module-wide suppressions are forbidden. See "CodeQL suppression
  policy" in `docs/development.md`. `src/blueprints/**` and `src/utils/http_utils.py` need
  JTN-318 coordination before suppressing anything there.
- **Dependencies — runtime deps are uv-only; `pip-compile` is retired for them (JTN-616).**
  Source of truth is `[project.dependencies]` in `pyproject.toml` + `uv.lock`;
  `install/requirements.txt` is **generated** and must never be hand-edited (Dependabot points at
  `uv.lock` for exactly this reason). To change a runtime dep:
  ```bash
  # 1. edit pyproject.toml, then:
  uv lock
  uv export --format requirements.txt --no-dev --no-emit-project \
      --output-file install/requirements.txt
  bash scripts/check_requirements_drift.sh   # same check as the lockfile-drift CI job
  ```
  Commit `pyproject.toml`, `uv.lock` and `install/requirements.txt` together. `install/requirements.in`
  is a **legacy reference, not an input** — editing it changes nothing. Regenerating with pip-compile
  silently drops the `sys_platform` markers and the Pi arm64/armv7l/armv6l wheel hashes that
  `[tool.uv] required-environments` produces, and `install.sh` installs with `--require-hashes`, so a
  bad export breaks installs on the device.
  **Dev deps are the exception**: `install/requirements-dev.txt` is still pip-compiled from
  `install/requirements-dev.in` (uv migration deferred to JTN-616 Phase 3).
  Full detail: `docs/dependency_locking.md`, `docs/dependencies.md`.
- **`ci-gate`** is the single required GitHub status check (all real jobs feed into it) — see
  `docs/development.md` for the branch-protection setup. Frontend changes trigger a local
  pre-commit browser-smoke gate automatically.
- Private helper functions (`_*`) longer than ~5 lines or with non-obvious intent should have a
  docstring (see `CONTRIBUTING.md`).
- Supported hardware/OS matrix: Raspberry Pi (Zero 2 W and up), Debian Trixie (arm64),
  Python 3.11–3.13. Bookworm and Bullseye were dropped as install/release targets. IT8951-based
  Waveshare displays are not supported.

## Subagents

`.claude/agents/` defines eight subsystem agents. Each carries the conventions, invariants and
verification commands for its area, so delegate rather than re-deriving them:

| Agent | Area |
|---|---|
| `plugin-dev` | `src/plugins/**`, `src/homeboard/**`, `tests/plugins/**`, pixel snapshots |
| `web-backend` | `src/blueprints/**`, `src/app_setup/**`, `config.py`, `model.py`, `src/utils/**`, `src/schemas/**` |
| `frontend-ui` | `src/templates/**`, `src/static/**`, Playwright + a11y suites |
| `render-pipeline` | `src/refresh_task/**`, `src/display/**`, `image_utils.py`, `button_task.py` |
| `test-qa` | `tests/**`, fixtures, markers, coverage/flake/snapshot/perf/mutation gates |
| `device-install` | `install/**`, systemd units, Pi image, install + simulation tests |
| `ci-release` | `.github/workflows/**`, pre-commit, uv lock/export, semantic-release |
| `security-audit` | auth, CSP/CSRF/SRI, secrets, SSRF, scanner findings — **read-only, reports only** |

`.claude/` is gitignored, so the roster is per-checkout local config: new clones and worktrees need
a copy. `.claude/agents/README.md` records the tool grants and why each one differs.
