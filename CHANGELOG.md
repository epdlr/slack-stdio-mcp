# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

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

[Unreleased]: https://github.com/epdlr/slack-stdio-mcp/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/epdlr/slack-stdio-mcp/releases/tag/v1.0.0
