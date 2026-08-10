/**
 * @file refresh.mjs
 * @description Slack access-token renewal (token rotation) with injectable fetch.
 *
 * Endpoint: POST https://slack.com/api/oauth.v2.access
 * Body: grant_type=refresh_token&client_id=…&refresh_token=…[&client_secret=…]
 *
 * After a successful refresh, Slack often rotates the refresh_token as well;
 * the per-client_id JSON is always rewritten with the new response.
 */

import {
  clearCredentials,
  isAccessTokenValid,
  loadCredentials,
  pickAccessToken,
  pickRefreshToken,
  saveTokenResponse,
} from "./token.mjs";

/** Documented Slack OAuth v2 exchange / refresh URL. */
export const SLACK_TOKEN_URL = "https://slack.com/api/oauth.v2.access";

/**
 * @typedef {typeof fetch} FetchFn
 */

/**
 * Call the token endpoint with `grant_type=refresh_token`.
 *
 * @param {{
 *   clientId: string,
 *   refreshToken: string,
 *   clientSecret?: string,
 *   fetchFn?: FetchFn,
 *   tokenUrl?: string,
 * }} opts
 * @returns {Promise<Record<string, unknown>>} Raw Slack token response (`ok` implied)
 * @throws {Error} On missing args, non-JSON body, Slack error, or missing `access_token`
 */
export async function requestTokenRefresh(opts) {
  const clientId = opts.clientId?.trim();
  const refreshToken = opts.refreshToken?.trim();
  if (!clientId) {
    throw new Error("requestTokenRefresh: clientId required");
  }
  if (!refreshToken) {
    throw new Error("requestTokenRefresh: refreshToken required");
  }

  const fetchFn = opts.fetchFn ?? globalThis.fetch;
  if (typeof fetchFn !== "function") {
    throw new Error("requestTokenRefresh: fetch is not available");
  }

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: clientId,
    refresh_token: refreshToken,
  });
  if (opts.clientSecret?.trim()) {
    body.set("client_secret", opts.clientSecret.trim());
  }

  const tokenUrl = opts.tokenUrl ?? SLACK_TOKEN_URL;
  const res = await fetchFn(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  /** @type {Record<string, unknown>} */
  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error(`refresh: non-JSON response (HTTP ${res.status})`);
  }

  if (!res.ok || data.ok === false) {
    const detail = String(data.error || res.status || "unknown");
    throw new Error(`oauth.v2.access refresh: ${detail}`);
  }

  const access = pickAccessToken(data);
  if (!access) {
    throw new Error("refresh: response missing access_token");
  }
  return data;
}

/**
 * If the access token is still valid, return it.
 * If expired (or near expiry) and a refresh_token exists, renew and persist.
 * On refresh failure, invalidate that client_id credentials and return null.
 * Never returns an expired access_token as if it were usable.
 *
 * @param {string} clientId
 * @param {{
 *   clientSecret?: string,
 *   fetchFn?: FetchFn,
 *   tokenUrl?: string,
 *   now?: number,
 *   skewMs?: number,
 *   nowDate?: Date,
 * }} [opts]
 * @returns {Promise<string | null>}
 */
export async function resolveOrRefreshAccessToken(clientId, opts = {}) {
  if (!clientId?.trim()) {
    throw new Error("resolveOrRefreshAccessToken: clientId required");
  }
  const id = clientId.trim();

  // Env override: no refresh lifecycle (injection / CI).
  const fromEnv =
    process.env.SLACK_MCP_TOKEN?.trim() ||
    process.env.SLACK_USER_TOKEN?.trim() ||
    process.env.SLACK_TOKEN?.trim();
  if (fromEnv) {
    return fromEnv;
  }

  const data = loadCredentials(id);
  if (!data) {
    return null;
  }

  if (isAccessTokenValid(data, { now: opts.now, skewMs: opts.skewMs })) {
    return pickAccessToken(data);
  }

  const refreshToken = pickRefreshToken(data);
  if (!refreshToken) {
    // Expired (or invalid expiry) and no refresh → do not reuse dead access.
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
    const saved = saveTokenResponse(tokenResponse, id, {
      now: opts.nowDate ?? (opts.now != null ? new Date(opts.now) : undefined),
    });
    return pickAccessToken(saved);
  } catch (err) {
    // Refresh failed: invalidate so expired access is not reused.
    clearCredentials(id);
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[slack-stdio] Refresh failed (${msg}); credentials invalidated.`);
    return null;
  }
}

// forceRefresh lives in session.mjs (mid-session 401 path) to keep this module
// focused on expiry-based resolve-or-refresh.
