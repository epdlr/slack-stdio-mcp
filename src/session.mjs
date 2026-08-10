/**
 * @file session.mjs
 * @description Mid-session Slack auth recovery: detect expiry, silent refresh,
 * interactive re-auth with **browser + clickable authorize URL** for the chat.
 */

import { startUserOAuth } from "./oauth-flow.mjs";
import {
  clearCredentials,
  loadCredentials,
  pickAccessToken,
  pickRefreshToken,
  saveTokenResponse,
} from "./token.mjs";
import { requestTokenRefresh } from "./refresh.mjs";

/** Stable code for agents to detect and prompt the user. */
export const SLACK_REAUTH_REQUIRED = "SLACK_REAUTH_REQUIRED";

/**
 * Local bridge tools always exposed by the stdio server (not from mcp.slack.com).
 * Keep names in sync with `src/server.mjs` LOCAL_TOOLS.
 */
export const LOCAL_BRIDGE_TOOL_NAMES = Object.freeze([
  "slack_stdio_reauth",
  "slack_stdio_session_status",
]);

/**
 * Pure decision after a Slack tool auth failure and a silent-recover attempt.
 * Used by the server so recovery policy is unit-testable without stdio MCP.
 *
 * @param {{ recovered: boolean, skipOAuth: boolean }} opts
 * @returns {"retry" | "interactive_reauth" | "fail_skip_oauth"}
 */
export function decideAuthRecovery(opts) {
  if (opts.recovered) {
    return "retry";
  }
  if (opts.skipOAuth) {
    return "fail_skip_oauth";
  }
  return "interactive_reauth";
}

/**
 * @typedef {object} PendingReauth
 * @property {string} authorizeUrl
 * @property {string} clientId
 * @property {Promise<string>} tokenPromise
 * @property {() => Promise<void>} cancel
 * @property {number} startedAt
 */

/** @type {PendingReauth | null} */
let pendingReauth = null;

/**
 * Detect auth/session failures from errors or MCP tool results.
 * Successful tool payloads (`content` array without `isError: true`) are never matched.
 *
 * @param {unknown} errOrResult
 * @returns {boolean}
 */
export function isAuthSessionError(errOrResult) {
  if (errOrResult == null) {
    return false;
  }
  // MCP tool result shape: never auth-probe successful payloads. Search results
  // or message text can legitimately contain words like "access token" and must
  // not trigger a re-auth flow.
  if (
    typeof errOrResult === "object" &&
    !(errOrResult instanceof Error) &&
    Array.isArray(/** @type {{ content?: unknown }} */ (errOrResult).content) &&
    /** @type {{ isError?: unknown }} */ (errOrResult).isError !== true
  ) {
    return false;
  }
  const text = normalizeAuthProbeText(errOrResult).toLowerCase();
  if (!text) {
    return false;
  }
  // Do not treat missing_scope as session loss (re-auth will not help).
  if (text.includes("missing_scope") || text.includes("not_allowed_token_type")) {
    return false;
  }
  const needles = [
    "401",
    "unauthorized",
    "invalid_auth",
    "token_expired",
    "token_revoked",
    "not_authed",
    "invalid_token",
    "invalid_access_token",
    "account_inactive",
    "authentication",
    "unauthenticated",
    "expired_token",
    "access token",
    "session expired",
    "not authenticated",
    "auth required",
    "authorization required",
    "invalid bearer",
    "www-authenticate",
  ];
  return needles.some((n) => text.includes(n));
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function normalizeAuthProbeText(value) {
  if (value == null) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (value instanceof Error) {
    return `${value.message}\n${value.stack || ""}`;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Force a refresh even if access token is not near expiry (e.g. API 401).
 * On failure, clears credentials for `clientId` and returns `null`.
 *
 * @param {string} clientId
 * @param {{ clientSecret?: string, fetchFn?: typeof fetch, tokenUrl?: string }} [opts]
 * @returns {Promise<string | null>} New access token, or `null` if refresh is impossible
 * @throws {Error} If `clientId` is empty
 */
export async function forceRefreshAccessToken(clientId, opts = {}) {
  if (!clientId?.trim()) {
    throw new Error("forceRefreshAccessToken: clientId required");
  }
  const id = clientId.trim();
  const data = loadCredentials(id);
  if (!data) {
    return null;
  }
  const refreshToken = pickRefreshToken(data);
  if (!refreshToken) {
    clearCredentials(id);
    return null;
  }
  try {
    const tokenResponse = await requestTokenRefresh({
      clientId: id,
      refreshToken,
      clientSecret: opts.clientSecret,
      fetchFn: opts.fetchFn,
      tokenUrl: opts.tokenUrl,
    });
    const saved = saveTokenResponse(tokenResponse, id);
    return pickAccessToken(saved);
  } catch (err) {
    clearCredentials(id);
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[slack-stdio] Force refresh failed (${msg}); credentials invalidated.`);
    return null;
  }
}

/**
 * User-facing + agent-facing re-auth message with a **clickable** authorize URL.
 *
 * @param {{ authorizeUrl: string, detail?: string, browserOpened?: boolean }} opts
 * @returns {string} Text including `SLACK_REAUTH_REQUIRED` and the full URL
 * @throws {Error} If `authorizeUrl` is empty
 */
export function formatReauthMessage(opts) {
  const url = opts.authorizeUrl?.trim();
  if (!url) {
    throw new Error("formatReauthMessage: authorizeUrl required");
  }
  const browserNote = opts.browserOpened === false
    ? "The browser could not be opened automatically."
    : "A browser window was also opened (if the host allows it).";
  const detail = opts.detail?.trim()
    ? `\nDetails: ${opts.detail.trim()}\n`
    : "";

  return (
    `${SLACK_REAUTH_REQUIRED}\n\n` +
    `Your Slack session is missing or expired.${detail}\n` +
    `**Click this URL to re-authorize** (or copy-paste into a browser):\n\n` +
    `${url}\n\n` +
    `${browserNote}\n` +
    `After you press **Allow** on Slack, tell the agent to retry the Slack action ` +
    `(or call tool \`slack_stdio_reauth\` with wait=true / retry the previous tool).\n` +
    `If a re-auth is already in progress, finish Allow first; do not start multiple flows.`
  );
}

/**
 * MCP tool result shape for re-auth (so the agent surfaces the URL in chat).
 *
 * @param {{ authorizeUrl: string, detail?: string, browserOpened?: boolean }} opts
 * @returns {{ content: { type: "text", text: string }[], isError: true }}
 */
export function reauthToolResult(opts) {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: formatReauthMessage(opts),
      },
    ],
  };
}

/**
 * @returns {PendingReauth | null}
 */
export function getPendingReauth() {
  return pendingReauth;
}

/**
 * Start interactive re-auth: opens browser + returns authorize URL for the chat.
 * Concurrent starts reuse the same pending flow (same URL).
 *
 * @param {{
 *   clientId: string,
 *   clientSecret?: string,
 *   host?: string,
 *   port?: number,
 *   callbackPath?: string,
 *   timeoutMs?: number,
 *   openBrowser?: boolean,
 * }} opts
 * @returns {Promise<{ authorizeUrl: string, alreadyInProgress: boolean, tokenPromise: Promise<string> }>}
 */
export async function beginInteractiveReauth(opts) {
  if (pendingReauth && pendingReauth.clientId === opts.clientId.trim()) {
    return {
      authorizeUrl: pendingReauth.authorizeUrl,
      alreadyInProgress: true,
      tokenPromise: pendingReauth.tokenPromise,
    };
  }
  if (pendingReauth) {
    try {
      await pendingReauth.cancel();
    } catch {
      /* ignore */
    }
    pendingReauth = null;
  }

  const session = await startUserOAuth({
    clientId: opts.clientId,
    clientSecret: opts.clientSecret,
    host: opts.host,
    port: opts.port,
    callbackPath: opts.callbackPath,
    timeoutMs: opts.timeoutMs,
    openBrowser: opts.openBrowser !== false,
  });

  const startedAt = Date.now();
  const tokenPromise = session.tokenPromise.finally(() => {
    if (pendingReauth && pendingReauth.startedAt === startedAt) {
      pendingReauth = null;
    }
  });

  pendingReauth = {
    authorizeUrl: session.authorizeUrl,
    clientId: session.clientId,
    tokenPromise,
    cancel: session.cancel,
    startedAt,
  };

  return {
    authorizeUrl: session.authorizeUrl,
    alreadyInProgress: false,
    tokenPromise,
  };
}

/**
 * If a pending re-auth completed, return the new access token; otherwise null.
 *
 * @param {{ waitMs?: number }} [opts]
 * @returns {Promise<string | null>}
 */
export async function takeCompletedReauthToken(opts = {}) {
  if (!pendingReauth) {
    return null;
  }
  const waitMs = opts.waitMs ?? 0;
  const p = pendingReauth.tokenPromise;

  if (waitMs <= 0) {
    // Non-blocking: inspect settlement via a microtask race with a sentinel.
    /** @type {{ done: true, ok: boolean, t: string | null } | { done: false }} */
    let state = { done: false };
    p.then(
      (t) => {
        state = { done: true, ok: true, t };
      },
      () => {
        state = { done: true, ok: false, t: null };
      },
    );
    await Promise.resolve();
    await Promise.resolve();
    if (!state.done) {
      return null;
    }
    return state.ok ? state.t : null;
  }

  try {
    return await Promise.race([
      p,
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error("wait timeout")), waitMs);
      }),
    ]);
  } catch {
    return null;
  }
}

/**
 * @internal test helper
 */
export function _resetPendingReauthForTests() {
  pendingReauth = null;
}
