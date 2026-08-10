/**
 * @file oauth-flow.mjs
 * @description User (not bot) OAuth 2.0 + PKCE for Slack’s hosted MCP.
 *
 * Loopback authorize → `oauth.v2.user.access` → local credentials.
 * Default client is Claude’s partner app; override with `--client-id` / env.
 *
 * Pitfalls (see also docs/ARCHITECTURE.md):
 * - Authorize uses query param **`scope`** (spaces), not `user_scope`.
 * - Resolve the token promise only **after** exchange + save (not on code alone).
 * - App must have **MCP enabled** or connect to mcp.slack.com fails.
 */

import crypto from "node:crypto";
import http from "node:http";
import { URL } from "node:url";
import { execFile } from "node:child_process";
import {
  browserOpenCommand,
  browserOpenExecFileOptions,
} from "./platform.mjs";
import { resolveClientId, saveTokenResponse } from "./token.mjs";

export { browserOpenCommand, browserOpenExecFileOptions } from "./platform.mjs";

/**
 * Default client ID: **Claude** partner app (official Slack plugin).
 * Override: env `SLACK_CLIENT_ID` (or `--client-id`) for your own Slack app.
 */
export const DEFAULT_CLIENT_ID = "1601185624273.8899143856786";

/**
 * User Token Scopes requested at OAuth (aligned with mcp.slack.com protected-resource).
 * Source of truth for your own app: declare them under OAuth & Permissions → User Token Scopes.
 * Docs: README “Own Slack app” + docs/ARCHITECTURE.md.
 *
 * @type {readonly string[]}
 */
export const USER_SCOPES = Object.freeze([
  "search:read.public",
  "search:read.private",
  "search:read.mpim",
  "search:read.im",
  "search:read.files",
  "search:read.users",
  "chat:write",
  "channels:history",
  "groups:history",
  "mpim:history",
  "im:history",
  "canvases:read",
  "canvases:write",
  "users:read",
  "users:read.email",
  "reactions:write",
  "reactions:read",
  "emoji:read",
  "files:read",
  "channels:write",
  "groups:write",
  "im:write",
  "mpim:write",
  "channels:read",
  "groups:read",
  "mpim:read",
]);

/**
 * Value of the authorize `scope` query param (spaces, not commas).
 * Same source as `USER_SCOPES` — do not redefine the list elsewhere.
 *
 * @returns {string}
 */
export function userScopesQueryParam() {
  return USER_SCOPES.join(" ");
}

/**
 * Build the **user** authorize URL (testable without a browser).
 *
 * @param {{
 *   clientId: string,
 *   redirectUri: string,
 *   state: string,
 *   codeChallenge: string,
 *   resource?: string,
 * }} opts
 * @returns {URL}
 * @throws {Error} If `clientId` or `redirectUri` is empty
 */
export function buildUserAuthorizeUrl(opts) {
  const clientId = opts.clientId?.trim();
  if (!clientId) {
    throw new Error("buildUserAuthorizeUrl: clientId required");
  }
  if (!opts.redirectUri?.trim()) {
    throw new Error("buildUserAuthorizeUrl: redirectUri required");
  }
  if (!opts.state?.trim()) {
    throw new Error("buildUserAuthorizeUrl: state required");
  }
  if (!opts.codeChallenge?.trim()) {
    throw new Error("buildUserAuthorizeUrl: codeChallenge required");
  }

  // User-only endpoint (not classic bot+user oauth/v2/authorize).
  const authUrl = new URL("https://slack.com/oauth/v2_user/authorize");
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", clientId);
  // IMPORTANT: param name = "scope" with spaces, not "user_scope".
  authUrl.searchParams.set("scope", userScopesQueryParam());
  authUrl.searchParams.set("redirect_uri", opts.redirectUri.trim());
  authUrl.searchParams.set("state", opts.state.trim());
  authUrl.searchParams.set("code_challenge", opts.codeChallenge.trim());
  authUrl.searchParams.set("code_challenge_method", "S256");
  // Resource indicator (RFC 8707) pointing at the MCP protected resource.
  authUrl.searchParams.set("resource", opts.resource?.trim() || "https://mcp.slack.com/");
  return authUrl;
}

/**
 * @typedef {object} UserOAuthSession
 * @property {string} authorizeUrl  Clickable Slack Allow URL (also opened in browser).
 * @property {string} redirectUri
 * @property {string} clientId
 * @property {Promise<string>} tokenPromise  Resolves after Allow + token save.
 * @property {() => Promise<void>} cancel  Abort and close the loopback server.
 */

/**
 * Start user OAuth without awaiting the Allow click.
 * Use this mid-session so the agent can show `authorizeUrl` in chat immediately
 * while the browser opens in parallel.
 *
 * @param {{
 *   clientId?: string,
 *   clientSecret?: string,
 *   port?: number,
 *   host?: string,
 *   callbackPath?: string,
 *   timeoutMs?: number,
 *   openBrowser?: boolean,
 *   onAuthorizeUrl?: (url: string) => void,
 * }} [opts]
 * @returns {Promise<UserOAuthSession>}
 */
export async function startUserOAuth(opts = {}) {
  // --- OAuth client configuration ---
  const clientId = opts.clientId?.trim() || resolveClientId(DEFAULT_CLIENT_ID);

  // Claude style: optional secret. Slack confidential apps sometimes require it
  // at the token endpoint; on invalid_client, set SLACK_CLIENT_SECRET.
  const clientSecret =
    opts.clientSecret?.trim() || process.env.SLACK_CLIENT_SECRET?.trim() || "";

  // Defaults aligned with the Claude plugin (callbackPort 3118 + path /callback).
  // Canonical Claude Code redirect URI: http://localhost:3118/callback
  const port = opts.port ?? Number(process.env.SLACK_OAUTH_PORT || 3118);
  const timeoutMs = opts.timeoutMs ?? Number(process.env.SLACK_OAUTH_TIMEOUT_MS || 180_000);
  const openBrowser = opts.openBrowser !== false;

  // Host in the redirect URL (what Slack sees). Claude uses "localhost", not 127.0.0.1.
  const redirectHost =
    opts.host?.trim() || process.env.SLACK_OAUTH_HOST?.trim() || "localhost";

  // Path: Claude partner default = /callback; own apps often use /oauth/callback.
  const callbackPath = (
    opts.callbackPath ||
    process.env.SLACK_OAUTH_PATH ||
    "/callback"
  ).replace(/\/$/, "") || "/callback";

  // Must EXACTLY match a Redirect URL registered on the Slack OAuth app.
  const redirectUri = `http://${redirectHost}:${port}${callbackPath}`;

  // --- PKCE (RFC 7636) ---
  // random verifier; challenge = BASE64URL(SHA256(verifier)).
  // Slack requires it if the app has PKCE Opt In (recommended for public clients).
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const state = crypto.randomBytes(16).toString("hex");

  /** @type {(token: string) => void} */
  let resolveToken;
  /** @type {(err: Error) => void} */
  let rejectToken;
  const tokenPromise = new Promise((resolve, reject) => {
    resolveToken = resolve;
    rejectToken = reject;
  });

  let settled = false;
  /** @type {import("node:http").Server | null} */
  let serverRef = null;

  const closeServer = async () => {
    if (!serverRef) {
      return;
    }
    const s = serverRef;
    serverRef = null;
    await new Promise((resolve) => {
      s.close(() => resolve(undefined));
    });
  };

  // --- Minimal HTTP server only for the OAuth redirect ---
  // Listens on loopback; the host agent (Grok) does not implement this callback.
  const server = http.createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url || "/", `http://127.0.0.1:${port}`);

        // Accept the configured path and common redirect aliases.
        const pathOk =
          url.pathname === callbackPath ||
          url.pathname === "/callback" ||
          url.pathname === "/oauth/callback";
        if (!pathOk) {
          res.writeHead(404);
          res.end("Not found");
          return;
        }

        // User denied or Slack returned an error in the query.
        const err = url.searchParams.get("error");
        if (err) {
          res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
          res.end(`Slack error: ${err}`);
          if (!settled) {
            settled = true;
            rejectToken(new Error(`Slack OAuth error: ${err}`));
          }
          return;
        }

        const code = url.searchParams.get("code");
        const returnedState = url.searchParams.get("state");
        if (!code || returnedState !== state) {
          res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("Invalid code/state");
          return;
        }

        // --- Exchange authorization_code → tokens ---
        // Documented endpoint for MCP user tokens:
        // https://slack.com/api/oauth.v2.user.access
        const body = new URLSearchParams({
          client_id: clientId,
          code,
          redirect_uri: redirectUri,
          code_verifier: verifier,
        });
        // Only if the app is confidential and needs it.
        if (clientSecret) {
          body.set("client_secret", clientSecret);
        }

        const tokenRes = await fetch("https://slack.com/api/oauth.v2.user.access", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body,
        });

        /** @type {Record<string, unknown>} */
        const data = await tokenRes.json();
        if (!data.ok) {
          const detail = String(data.error || tokenRes.status);
          const hint =
            detail === "invalid_client" || detail === "bad_client_secret"
              ? " (the app may require client_secret; the Claude plugin uses a different partner app)"
              : "";
          throw new Error(`oauth.v2.user.access: ${detail}${hint}`);
        }

        // Normalize access/refresh/expires_at and save per client_id.
        const saved = saveTokenResponse(data, clientId);
        const accessToken = saved.access_token;

        // Success HTML: only after exchange and save (unlike mcp-remote,
        // which sometimes shows success as soon as the code arrives).
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(
          "<!doctype html><meta charset=utf-8><title>Slack MCP OK</title>" +
            "<p><b>Authorization successful.</b> Return to the agent; the bridge will list Slack tools.</p>" +
            "<script>window.close()</script>",
        );
        if (!settled) {
          settled = true;
          resolveToken(accessToken);
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(msg);
        if (!settled) {
          settled = true;
          rejectToken(e instanceof Error ? e : new Error(msg));
        }
      }
    })();
  });
  serverRef = server;

  // Bind on loopback interfaces (localhost and 127.0.0.1).
  // redirect_uri remains Claude's (http://localhost:3118/callback).
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(undefined));
  });

  // --- Authorize URL (same builder as tests) ---
  const authUrl = buildUserAuthorizeUrl({
    clientId,
    redirectUri,
    state,
    codeChallenge: challenge,
  });
  const authorizeUrl = authUrl.toString();

  // Logs only on stderr: stdout stays free for the parent MCP protocol.
  console.error(
    `[slack-stdio] OAuth (client_id + PKCE${clientSecret ? " + secret" : ", no secret"})`,
  );
  console.error(`[slack-stdio] Callback: ${redirectUri}`);
  console.error(`[slack-stdio] URL:\n${authorizeUrl}\n`);

  if (typeof opts.onAuthorizeUrl === "function") {
    opts.onAuthorizeUrl(authorizeUrl);
  }

  if (openBrowser) {
    // URL is already on stderr above: if open fails, the user can click the chat URL.
    const spec = browserOpenCommand(authorizeUrl);
    execFile(spec.command, spec.args, browserOpenExecFileOptions(spec), (err) => {
      if (err) {
        console.error(
          `[slack-stdio] Could not open the browser (${err.message}). Open the URL above manually.`,
        );
      }
    });
  }

  const timedTokenPromise = Promise.race([
    tokenPromise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`OAuth timeout (${timeoutMs}ms)`)), timeoutMs);
    }),
  ]).finally(() => {
    void closeServer();
  });

  // Prevent unhandledRejection when cancel()/timeout rejects and no waiter is attached.
  timedTokenPromise.catch(() => {
    /* observed via tokenPromise await or ignored after cancel */
  });

  const cancel = async () => {
    if (!settled) {
      settled = true;
      rejectToken(new Error("OAuth cancelled"));
    }
    await closeServer();
  };

  return {
    authorizeUrl,
    redirectUri,
    clientId,
    tokenPromise: /** @type {Promise<string>} */ (timedTokenPromise),
    cancel,
  };
}

/**
 * Run the full OAuth flow and return the access_token (awaits Allow).
 *
 * @param {{
 *   clientId?: string,
 *   clientSecret?: string,
 *   port?: number,
 *   host?: string,
 *   callbackPath?: string,
 *   timeoutMs?: number,
 *   openBrowser?: boolean,
 *   onAuthorizeUrl?: (url: string) => void,
 * }} [opts]
 * @returns {Promise<string>} access_token ready for Bearer
 */
export async function runUserOAuth(opts = {}) {
  const session = await startUserOAuth(opts);
  return session.tokenPromise;
}
