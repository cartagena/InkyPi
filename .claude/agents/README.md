# InkyPi subagents

Eight agents, one per subsystem, each with its own colour and tool set. Claude picks one
automatically from the `description` line, or you can name it (`use plugin-dev to …`).

| Agent | Colour | Owns | Tools |
|---|---|---|---|
| `plugin-dev` | green | `src/plugins/**`, `src/homeboard/**`, `tests/plugins/**`, snapshots | + WebFetch/WebSearch (plugins wrap external APIs) |
| `web-backend` | blue | `src/blueprints/**`, `src/app_setup/**`, `config.py`, `model.py`, `src/utils/**`, `src/schemas/**` | read/write/bash |
| `frontend-ui` | cyan | `src/templates/**`, `src/static/**`, Playwright + a11y suites | read/write/bash |
| `render-pipeline` | orange | `src/refresh_task/**`, `src/display/**`, `image_utils.py`, `button_task.py` | read/write/bash |
| `test-qa` | purple | `tests/**`, fixtures, markers, coverage/flake/snapshot/perf gates | read/write/bash |
| `device-install` | red | `install/**`, systemd units, Pi image, install/simulation tests | read/write/bash |
| `ci-release` | yellow | `.github/workflows/**`, pre-commit, uv lock/export, semantic-release | + WebFetch (action + advisory lookup) |
| `security-audit` | pink | auth, CSP/CSRF/SRI, secrets, SSRF, scanners | **read-only** — no Edit/Write by design |

Notes:

- `security-audit` deliberately cannot modify files. It reports findings with `file:line`
  and an exploit path; the main session applies the fix.
- Everything else gets `Read, Grep, Glob, Edit, Write, Bash` — this repo's verification loop
  (`scripts/test.sh`, `scripts/lint.sh`, `scripts/build_css.py`, Playwright, Docker) is
  shell-driven, so Bash is not optional for them.
- Only `plugin-dev` and `ci-release` get network tools, and for a stated reason.

`.claude/` is gitignored, so these are per-checkout local config — copy them into new
worktrees or clones as needed.
