# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.3.1] - 2026-09-21

### Fixed

- `parseArgv` no longer stops at a bare `--`. Cursor and some `npx` hosts
  pass `-- --profile <name>`; the profile (and later flags) were dropped and
  the default credential store was used instead.

## [1.3.0] - 2026-08-25

### Added

- Overlay tools the hosted catalog omits, using existing user scopes:
  - `slack_stdio_update_message` (`chat.update`)
  - `slack_stdio_delete_message` (`chat.delete`)
  - `slack_stdio_remove_reaction` (`reactions.remove`)
  - `slack_stdio_scheduled_messages` (`list` / `cancel`)

## [1.2.0] - 2026-08-25

### Added

- Local overlay on top of the hosted catalog (`src/overlay.mjs`):
  - `slack_stdio_download_file` — `files.info` + private URL → path on disk
    (default OS temp, 50 MB cap, `0600`). Hosted `slack_read_file` often
    returns metadata-only for video.
  - `slack_stdio_catalog` — local tool names vs the current remote `listTools`.
- Unit tests for dest-path safety, size cap, `invalid_auth`, and HTML rejection.

## [1.1.0] - 2026-08-10

### Added

- `--profile <name>` / `SLACK_STDIO_PROFILE`: portable credential stores under
  `~/.slack-stdio-mcp/profiles/<name>` so hosts share tokens without absolute
  `--creds-dir` paths. Explicit `--creds-dir` still wins over profile.

### Fixed

- Stable npm `bin` entry (`bin/slack-stdio-mcp.js`) so the CLI is not stripped on publish.
- Cross-platform test runner (`scripts/run-tests.mjs`) so Node 20 CI no longer
  fails on unexpanded `test/**/*.test.mjs` globs.

## [1.0.0] - 2026-08-10

First public release.

### Added

- MCP stdio bridge to Slack’s hosted server (`https://mcp.slack.com/mcp`).
- User OAuth with PKCE (loopback callback); default Claude partner app or own app.
- Token lifecycle: per-`client_id` credentials, silent refresh, expiry skew.
- Mid-session recovery: force-refresh, interactive re-auth with clickable authorize
  URL (`SLACK_REAUTH_REQUIRED`), proactive reconnect after Allow.
- Local tools: `slack_stdio_reauth`, `slack_stdio_session_status`.
- CLI flags and env (`config.mjs`): flags > env > defaults; `--help`.
- Multiplatform credentials and browser open (Windows / macOS / Linux).
- CI matrix (ubuntu, windows, macos × Node 20/22), unit tests, English residual gate.
- npm Trusted Publishing workflow (`.github/workflows/publish.yml`).

[Unreleased]: https://github.com/epdlr/slack-stdio-mcp/compare/v1.3.1...HEAD
[1.3.1]: https://github.com/epdlr/slack-stdio-mcp/compare/v1.3.0...v1.3.1
[1.3.0]: https://github.com/epdlr/slack-stdio-mcp/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/epdlr/slack-stdio-mcp/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/epdlr/slack-stdio-mcp/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/epdlr/slack-stdio-mcp/releases/tag/v1.0.0
