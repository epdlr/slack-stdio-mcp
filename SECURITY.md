# Security Policy

## Supported versions

Only the latest release on the default branch is supported.

## Reporting a vulnerability

If you find a security issue (token handling, credential storage, OAuth
misconfiguration, etc.):

1. **Do not** open a public GitHub issue with exploit details or tokens.
2. Contact the maintainer privately (`epdlr` on GitHub).
3. Include a minimal reproduction and impact assessment if possible.

## What this project stores

- OAuth **user** tokens under the platform credentials root:
  - Unix: `~/.config/slack-stdio-mcp/by-client/` (mode `0600` when supported)
  - Windows: `%APPDATA%\slack-stdio-mcp\by-client\`
- Optional overrides: `--creds-dir` / `SLACK_STDIO_CREDS_DIR`, or
  `SLACK_MCP_TOKEN` / related inject env vars.

Never commit credentials, `.env` files, or token dumps. If a token may have
leaked, revoke the Slack app authorization from your Slack account.
