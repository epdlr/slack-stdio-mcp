# slack-stdio-mcp

Local **MCP stdio bridge** to Slack’s hosted MCP server
([`https://mcp.slack.com/mcp`](https://mcp.slack.com/mcp)).

Proxies the official tool catalog (`slack_send_message`, search, history,
canvas, …) after user OAuth (PKCE) and keeps tokens fresh. It does **not**
reimplement hosted Slack tools. A small **local overlay** adds what the hosted
server does not: download a file to disk, and list local vs remote tool names.

| Approach | Typical result |
|----------|----------------|
| Host → HTTP `mcp.slack.com` with built-in OAuth | Often stuck *authenticating* |
| Claude Code Slack plugin | Works (partner app + host OAuth) |
| **This bridge** (stdio + local OAuth/refresh) | Works for Grok, Cursor, Open Code, Codex, Claude, … |

```text
Agent  ──stdio MCP──►  slack-stdio-mcp  ──Bearer──►  mcp.slack.com
                              │
                              ├─ valid access token → reuse
                              ├─ expired + refresh_token → silent refresh
                              ├─ no token → browser OAuth (PKCE)
                              └─ overlay: download, catalog, edit/delete, unreact, scheduled
```

## Requirements

- **Node.js ≥ 20** (Windows, macOS, Linux)
- Default OAuth app: **Claude’s partner Slack app** (no app setup required)
  - Client ID: `1601185624273.8899143856786`
  - Redirect: `http://localhost:3118/callback`
- Own app is optional — see [Own Slack app](#own-slack-app-optional)

## Install

```bash
npx -y slack-stdio-mcp
```

First run may open a browser for Slack **Allow**. Later runs reuse or refresh
tokens under the platform credentials directory (see [Auth](#auth)).

| Alternative | Command |
|-------------|---------|
| Latest git main | `npx -y github:epdlr/slack-stdio-mcp` |
| From clone | `git clone … && npm install && npm start` |

## Configure a host

Prefer `npx` so you never hardcode a machine path. Put knobs in `args`
(CLI flags beat env; see [Configuration](#configuration)).

Set `startup_timeout_sec` (or equivalent) **≥ 180** so the first OAuth Allow
is not killed by the host.

### Grok Build (`~/.grok/config.toml`)

```toml
[mcp_servers.slack-stdio]
command = "npx"
args = ["-y", "slack-stdio-mcp"]
enabled = true
startup_timeout_sec = 180
```

Own Slack app:

```toml
[mcp_servers.slack-stdio]
command = "npx"
args = [
  "-y", "slack-stdio-mcp",
  "--client-id", "YOUR.CLIENT.ID",
  "--oauth-host", "127.0.0.1",
  "--oauth-path", "/oauth/callback",
]
enabled = true
startup_timeout_sec = 180
```

### Claude Code / Cursor / similar (JSON)

```json
{
  "mcpServers": {
    "slack-stdio": {
      "command": "npx",
      "args": ["-y", "slack-stdio-mcp"]
    }
  }
}
```

Add the same optional flags as in the Grok example when using your own app.

### Local clone

```json
{
  "mcpServers": {
    "slack-stdio": {
      "command": "node",
      "args": ["/absolute/path/to/slack-stdio-mcp/src/server.mjs"]
    }
  }
}
```

## Auth

On start, if there is no usable token for the active `client_id`, the bridge
opens a browser (PKCE). Credentials are stored **per client_id**:

| OS | Default root |
|----|----------------|
| macOS / Linux | `~/.config/slack-stdio-mcp` (`$XDG_CONFIG_HOME` honored) |
| Windows | `%APPDATA%\slack-stdio-mcp` |

Path: `…/by-client/<client_id>.json`. Override with `--creds-dir` /
`SLACK_STDIO_CREDS_DIR`. Unix modes `0600`/`0700` when supported.

| Action | How |
|--------|-----|
| OAuth only (no MCP) | `npm run auth` (from a clone) |
| Skip browser (CI) | `--skip-oauth` / `SLACK_SKIP_OAUTH=1` |
| Inject token | `--token` / `SLACK_MCP_TOKEN` |

### Token lifecycle

1. Load credentials for the current `client_id`
2. Reuse access token if valid (5‑minute skew before `expires_at`)
3. Else refresh via `oauth.v2.access` (`grant_type=refresh_token`)
4. On refresh failure: clear that app’s file → OAuth (or fail if skip-oauth)

### No session

stdio starts even when Slack has no usable token. The host handshake does not
wait on the browser. The first tool call that needs Slack returns
`SLACK_REAUTH_REQUIRED` and a clickable authorize URL. The agent should ask
the user to open that URL and press **Allow**, then retry.

### Mid-session session loss

If a Slack tool fails with an auth error (`isError: true` or thrown error):

1. Silent force-refresh + reconnect + one retry
2. Else open browser and return `SLACK_REAUTH_REQUIRED` **plus the authorize URL**
   in the tool result (clickable in chat)
3. After **Allow**, the bridge reconnects in the background — retry the tool

Successful tool payloads are never scanned for auth keywords. Settled re-auth
flows are not reused; the next start gets a fresh URL.

| Local tool | Purpose |
|------------|---------|
| `slack_stdio_reauth` | Start re-auth; optional `wait: true` until Allow |
| `slack_stdio_session_status` | Pending re-auth + authorize URL if any |
| `slack_stdio_download_file` | Write a Slack `file_id` to disk (hosted `slack_read_file` is often metadata-only for video). Max 50 MB. `files:read` |
| `slack_stdio_catalog` | JSON of local overlay names vs the current `mcp.slack.com` catalog |
| `slack_stdio_update_message` | Edit a message the user posted (`chat.update`). Hosted MCP can send only |
| `slack_stdio_delete_message` | Delete a message the user posted (`chat.delete`) |
| `slack_stdio_remove_reaction` | Remove a reaction the user added (`reactions.remove`). Hosted catalog has add/get |
| `slack_stdio_scheduled_messages` | `action=list` or `action=cancel` for scheduled messages. Hosted `slack_schedule_message` cannot cancel |

Startup OAuth waits up to `SLACK_OAUTH_TIMEOUT_MS` (default **180000**). On
timeout the process exits `1` (host must restart). Keep host startup timeout
above that value. The authorize URL is always printed on **stderr**.

## Configuration

**Precedence: CLI flags > environment > built-in defaults.**

| CLI flag | Env | Purpose |
|----------|-----|---------|
| `--client-id <id>` | `SLACK_CLIENT_ID` | OAuth app id (default: Claude partner) |
| `--client-secret <s>` | `SLACK_CLIENT_SECRET` | Confidential apps only |
| `--oauth-host <host>` | `SLACK_OAUTH_HOST` | Redirect host (`localhost`) |
| `--oauth-path <path>` | `SLACK_OAUTH_PATH` | Redirect path (`/callback`) |
| `--oauth-port <port>` | `SLACK_OAUTH_PORT` | Loopback port (`3118`) |
| `--mcp-url <url>` | `SLACK_MCP_URL` | MCP endpoint |
| `--profile <name>` | `SLACK_STDIO_PROFILE` | Named store: `~/.slack-stdio-mcp/profiles/<name>` (share across repos) |
| `--creds-dir <dir>` | `SLACK_STDIO_CREDS_DIR` | Absolute credentials root (wins over `--profile`) |
| `--skip-oauth` | `SLACK_SKIP_OAUTH=1` | Never open browser |
| `--token` / `--mcp-token` | `SLACK_MCP_TOKEN` | Inject Bearer (tests/CI) |
| `-h` / `--help` | — | Help on stderr |

Env only: `SLACK_OAUTH_TIMEOUT_MS`, `SLACK_ALLOW_LEGACY_TOKEN=1` (flat legacy
JSON without `client_id`).

```bash
npx -y slack-stdio-mcp -- --profile user_cl
npx -y slack-stdio-mcp -- --client-id 123.456 --oauth-path /oauth/callback
npx -y slack-stdio-mcp -- --skip-oauth --creds-dir /tmp/empty-creds
```

A leading `--` in `args` (Cursor / `npx`) is ignored; `--profile` after it still applies.

**Profiles:** the same `--profile` name in every host/repo reuses
`~/.slack-stdio-mcp/profiles/<name>/…` (no absolute paths in config). Grok does
not inject the MCP server key into the process — put the profile string in
`args` yourself (convention: match your team/workspace name).

## Platforms

| | Windows | macOS / Linux |
|--|---------|----------------|
| Credentials | `%APPDATA%\slack-stdio-mcp` | `~/.config/…` or `$XDG_CONFIG_HOME` |
| Open browser | `cmd /c start "" "<url>"` (URL quoted for `&`) | `open` / `xdg-open` |
| File modes | omitted (profile ACL) | `0600` / `0700` |

CI: `npm test` on Ubuntu, Windows, macOS (Node 20 + 22). If the browser cannot
open, paste the authorize URL from **stderr**.

## Own Slack app (optional)

Only if you are **not** using the default Claude partner app.

1. Slack app → **OAuth & Permissions** → Redirect URLs must match your
   `--oauth-*` / `SLACK_OAUTH_*` (e.g. `http://localhost:3118/callback`)
2. **PKCE** Opt In (recommended without `client_secret`)
3. Enable **MCP** under App Assistant / Agents & AI Apps  
   (else: *App is not enabled for Slack MCP server access*)
4. **User Token Scopes** must match `USER_SCOPES` in `src/oauth-flow.mjs`
   (source of truth; CI checks the README list below)

| Scope | Used for |
|-------|----------|
| `search:read.public` | Search public channels |
| `search:read.private` | Search private channels |
| `search:read.mpim` | Search multi-person DMs |
| `search:read.im` | Search 1:1 DMs |
| `search:read.files` | Search files |
| `search:read.users` | Search users |
| `chat:write` | Send messages |
| `channels:history` | Public channel history |
| `groups:history` | Private channel history |
| `mpim:history` | Multi-person DM history |
| `im:history` | 1:1 DM history |
| `canvases:read` / `canvases:write` | Canvases |
| `users:read` / `users:read.email` | Profiles |
| `reactions:write` / `reactions:read` | Reactions |
| `emoji:read` | Custom emoji |
| `files:read` | Files |
| `channels:write` / `groups:write` / `im:write` / `mpim:write` | Open/manage conversations |
| `channels:read` / `groups:read` / `mpim:read` | List/metadata |

Copy-paste (comma-separated; authorize uses **space**-separated `scope`, not
`user_scope`):

```text
search:read.public,search:read.private,search:read.mpim,search:read.im,search:read.files,search:read.users,chat:write,channels:history,groups:history,mpim:history,im:history,canvases:read,canvases:write,users:read,users:read.email,reactions:write,reactions:read,emoji:read,files:read,channels:write,groups:write,im:write,mpim:write,channels:read,groups:read,mpim:read
```

These are **user** scopes (`xoxp` / `xoxe.xoxp`), not bot scopes. A subset is
fine if you only need some tools. Set `SLACK_CLIENT_SECRET` only if Slack
rejects public PKCE exchange.

```bash
npx -y slack-stdio-mcp -- \
  --client-id your.client.id \
  --oauth-host 127.0.0.1 \
  --oauth-path /oauth/callback
```

## Scripts

| Script | Command |
|--------|---------|
| Start bridge | `npm start` |
| OAuth only | `npm run auth` |
| Tests | `npm test` |
| Syntax + English gate | `npm run check` |

## Security

See [SECURITY.md](./SECURITY.md).

- Never commit credentials, `.env`, or token dumps
- Tokens act **as the authorizing user** — revoke the app in Slack when done
- **stdout** = MCP JSON-RPC only; human logs go to **stderr**

## Contributing

[CONTRIBUTING.md](./CONTRIBUTING.md) · [CHANGELOG.md](./CHANGELOG.md) ·
[docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)

## License

[MIT](./LICENSE)
