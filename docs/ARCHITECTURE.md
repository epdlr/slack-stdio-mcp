# Architecture — slack-stdio-mcp

## Problem

Slack’s official MCP is Streamable HTTP + OAuth at `https://mcp.slack.com/mcp`.
Claude Code has a smooth path (partner app + host-managed callback). Many other
agents stall on native HTTP OAuth. This repo is a **local stdio process** that
owns OAuth/refresh and proxies the hosted tools 1:1. A thin **overlay**
(`overlay.mjs`) adds local tools that the hosted catalog does not cover well
(file bytes on disk, catalog dump). It is not a second Slack MCP server.

## Data path

```text
┌─────────────┐  stdio MCP  ┌──────────────────┐  HTTP + Bearer  ┌─────────────────────┐
│ Agent host  │ ──────────► │  server.mjs      │ ──────────────► │ mcp.slack.com/mcp   │
│             │ ◄────────── │  (this repo)     │ ◄────────────── │ hosted Slack tools  │
└─────────────┘             └──────────────────┘                 └─────────────────────┘
                                     │
                     ensure-token.mjs │
              ┌──────────────────────┼──────────────────────┐
              ▼                      ▼                      ▼
        valid access          refresh.mjs              oauth-flow.mjs
        on disk               (oauth.v2.access)        (browser + PKCE)
              │                      │                      │
              └──────────────────────┴──────────────────────┘
                                     ▼
              ~/.config/slack-stdio-mcp/by-client/<client_id>.json
```

## Modules

| File | Responsibility |
|------|----------------|
| `server.mjs` | Entry: config → token → remote MCP client → stdio proxy |
| `config.mjs` | CLI flags > env > defaults (`resolveConfig` / `loadRuntimeConfig`) |
| `platform.mjs` | Multi-OS paths, browser open, file modes |
| `ensure-token.mjs` | Valid disk → refresh → optional OAuth |
| `refresh.mjs` | `grant_type=refresh_token`; injectable `fetch` |
| `oauth-flow.mjs` | Loopback PKCE + `oauth.v2.user.access` |
| `session.mjs` | Mid-session recovery (detect, force-refresh, interactive re-auth) |
| `overlay.mjs` | Local tools: download, catalog, edit/delete message, remove reaction, scheduled list/cancel |
| `token.mjs` | Paths, save/load, expiry skew, `client_id` isolation |
| `auth.mjs` | CLI `npm run auth` |

## Token lifecycle

1. **OAuth success** (`oauth.v2.user.access`): persist `access_token`,
   `refresh_token` (if any), `expires_at`, `client_id`, and `raw` response.
2. **Ensure**: access is invalid if within `EXPIRY_SKEW_MS` (5 min) of expiry.
   `expires_at` may be ISO-8601 or a legacy unix timestamp (seconds or ms).
   A present but unreadable expiry is invalid, not "never expires".
3. **Refresh**: `POST https://slack.com/api/oauth.v2.access` with
   `grant_type=refresh_token` (+ optional `client_secret`). Rewrite the same
   by-client file (Slack often rotates `refresh_token`).
4. **Refresh failure**: `clearCredentials(client_id)`; never reuse a dead
   access token. Fall back to OAuth unless `skipOAuth`.

Credentials are always keyed by OAuth `client_id`. Apps never share tokens.

## Mid-session recovery

On proxied tool auth failure (`session.mjs`):

1. **Detect** (`isAuthSessionError`): 401 / `invalid_auth` / `token_expired` / …
   on thrown errors and tool results with `isError: true` only. Successful
   payloads are never scanned. `missing_scope` and `not_allowed_token_type`
   are excluded.
2. **Silent recover**: consume a completed pending re-auth if any, else
   force-refresh + reconnect; retry the call once on success.
3. **Interactive re-auth**: browser + `SLACK_REAUTH_REQUIRED` + authorize URL
   in the tool result. Concurrent starts reuse one pending flow; after settle,
   the next start gets a fresh URL.
4. **Proactive reconnect** (`watchPendingReauth`): reconnect remote as soon as
   Allow completes so the agent’s retry hits a live session.

Startup OAuth uses the same flow with `SLACK_OAUTH_TIMEOUT_MS` (default 180 s);
timeout → process exit 1.

Startup does **not** wait for Slack. stdio answers `initialize` immediately.
An existing token is attached in the background (`tryAttachExistingSession`):
valid access, else refresh, else leave `remote` unset. No browser at startup.

If a tool, resource, or prompt needs Slack and there is still no session, the
handler returns `SLACK_REAUTH_REQUIRED` with an authorize URL
(`missingSlackSessionDetail`). The agent asks the user to open that URL and
press Allow, then retries. `skipOAuth` still refuses the browser and explains
why. Non-auth connect failures are logged; the process stays up.

## Config

`resolveConfig({ argv, env })` is pure and unit-tested:

1. CLI long flags  
2. `SLACK_*` env  
3. Built-in defaults (Claude partner client id, `localhost:3118/callback`, …)

Entry points call `loadRuntimeConfig()` once, then pass fields into ensure/OAuth
and mirror creds-dir / inject-token into env for deep readers.

## OAuth details that matter

- Authorize: `https://slack.com/oauth/v2_user/authorize` with query param
  **`scope`** (space-separated user scopes), **not** `user_scope`.
- Scopes: only `USER_SCOPES` / `userScopesQueryParam()` in `oauth-flow.mjs`.
- Custom app: matching redirect URLs, PKCE Opt In recommended, **MCP enabled**
  under App Assistant (else connect fails with “not enabled for Slack MCP”).
- Success page is shown only **after** token exchange + save, not merely on code receipt.

## stdout vs stderr

| Stream | Content |
|--------|---------|
| **stdout** | MCP JSON-RPC only |
| **stderr** | Operator logs (`[slack-stdio] …`), authorize URL |

## Security notes

- Credential files `0600`, dirs `0700` on Unix; Windows uses profile ACLs.
- Never commit credentials or `.env`.
- Full policy: [SECURITY.md](../SECURITY.md).

## Why not reimplement tools

Hosted tools use Slack-specific “hydrated” shapes. This project is a **bridge**,
not a second Slack MCP server. Overlay tools stay narrow (download, catalog,
edit/delete, unreact, scheduled cancel) and reuse the same user token + session
recovery. There is no generic `slack.com/api` passthrough.

## Overlay download

1. `files.info` with the user Bearer.
2. Reject if `size` / `content-length` exceeds 50 MB (caller may lower `max_bytes`).
3. GET `url_private_download` (or `url_private`). Reject HTML bodies.
4. Write `{fileId}-{safeName}` under `dest_dir` (default OS temp), mode `0600`.
5. `invalid_auth` / `token_expired` go through the same silent-refresh / re-auth path.

## Overlay chat methods

Hosted MCP can send, react (add), and schedule. It cannot edit, delete, unreact,
or cancel a scheduled message. Those four go through `slackWebApi` in
`overlay.mjs` (`chat.update`, `chat.delete`, `reactions.remove`,
`chat.scheduledMessages.list` / `chat.deleteScheduledMessage`) with the same
user token. No generic Web API passthrough. Invite/kick stay out of the overlay:
they are not testable in a self-DM without touching other people.
