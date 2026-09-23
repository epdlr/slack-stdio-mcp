/**
 * @file token.mjs
 * @description Slack credential persistence and policy **per client_id**.
 *
 * Canonical layout:
 *   $SLACK_STDIO_CREDS_DIR/by-client/<client_id_safe>.json
 *   Default (if no override):
 *     - Windows: %APPDATA%/slack-stdio-mcp
 *     - macOS/Linux: ~/.config/slack-stdio-mcp (or $XDG_CONFIG_HOME)
 *
 * Each Slack app issues different tokens. Changing client_id forces re-auth.
 * Rotating tokens (`xoxe.*`) carry `refresh_token` + `expires_in`;
 * this module persists `expires_at` and exposes validity helpers.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  defaultCredentialsDir,
  fsMkdirOptions,
  fsWriteOptions,
} from "./platform.mjs";

/**
 * @typedef {object} SlackMcpCredentials
 * @property {string} access_token
 * @property {string} [client_id]
 * @property {string} [refresh_token]
 * @property {string} [token_type]
 * @property {string} [scope]
 * @property {string | number} [expires_at]  ISO-8601 or unix time; absent = no known expiry
 * @property {object} [raw]
 * @property {string} [obtained_at]
 */

/** Margin (ms) before expires_at at which the token is treated as near-expired. */
export const EXPIRY_SKEW_MS = 5 * 60 * 1000;

// Re-export for tests/docs without a circular import of platform.
export { defaultCredentialsDir } from "./platform.mjs";

/**
 * Credentials directory (reads env on each call → tests can set
 * SLACK_STDIO_CREDS_DIR without restarting the process).
 *
 * @param {{
 *   env?: NodeJS.ProcessEnv | Record<string, string | undefined>,
 *   platform?: string,
 *   homedir?: string,
 * }} [opts]
 * @returns {string}
 */
export function getCredentialsDir(opts = {}) {
  const env = opts.env ?? process.env;
  const override = env.SLACK_STDIO_CREDS_DIR?.trim();
  if (override) {
    return override;
  }
  return defaultCredentialsDir({
    platform: opts.platform ?? process.platform,
    env,
    homedir: opts.homedir ?? os.homedir(),
  });
}

/** @deprecated Prefer getCredentialsDir() / credentialsPathFor. */
export const CREDENTIALS_DIR = getCredentialsDir();

/** @deprecated Prefer credentialsPathFor(clientId). */
export const CREDENTIALS_PATH = path.join(CREDENTIALS_DIR, "credentials.json");

const LEGACY_GROK_PATH = path.join(
  os.homedir(),
  ".grok",
  "mcp-servers",
  "slack-stdio",
  "credentials.json",
);

/**
 * Sanitize a client id for use as a single path segment.
 *
 * @param {string} clientId
 * @returns {string}
 */
export function safeClientId(clientId) {
  return clientId.replace(/[^a-zA-Z0-9._-]/g, "_");
}

/**
 * @param {string} clientId
 * @param {{ env?: NodeJS.ProcessEnv | Record<string, string | undefined>, platform?: string, homedir?: string }} [opts]
 * @returns {string}
 */
export function credentialsPathFor(clientId, opts = {}) {
  return path.join(getCredentialsDir(opts), "by-client", `${safeClientId(clientId)}.json`);
}

/**
 * Effective client id (env or fallback).
 *
 * @param {string} [fallback]
 * @returns {string}
 */
export function resolveClientId(fallback = "1601185624273.8899143856786") {
  return process.env.SLACK_CLIENT_ID?.trim() || fallback;
}

/**
 * Read and parse a credentials JSON file, or `null` if missing/invalid.
 *
 * @param {string} filePath
 * @returns {SlackMcpCredentials | null}
 */
export function readCredentialsFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    return /** @type {SlackMcpCredentials} */ (JSON.parse(fs.readFileSync(filePath, "utf8")));
  } catch {
    return null;
  }
}

/**
 * Extract access_token from a credentials blob or OAuth response.
 *
 * @param {SlackMcpCredentials | Record<string, unknown> | null | undefined} data
 * @returns {string | null}
 */
export function pickAccessToken(data) {
  if (!data || typeof data !== "object") {
    return null;
  }
  const top = /** @type {{ access_token?: string }} */ (data).access_token?.trim();
  if (top) {
    return top;
  }
  const nested = /** @type {{ access_token?: string } | undefined} */ (
    data.raw && typeof data.raw === "object"
      ? /** @type {{ authed_user?: { access_token?: string } }} */ (data.raw).authed_user
      : undefined
  )?.access_token?.trim();
  if (nested) {
    return nested;
  }
  const au =
    data.authed_user && typeof data.authed_user === "object"
      ? /** @type {{ access_token?: string }} */ (data.authed_user).access_token?.trim()
      : undefined;
  return au || null;
}

/**
 * @param {SlackMcpCredentials | Record<string, unknown> | null | undefined} data
 * @returns {string | null}
 */
export function pickRefreshToken(data) {
  if (!data || typeof data !== "object") {
    return null;
  }
  const top = /** @type {{ refresh_token?: string }} */ (data).refresh_token?.trim();
  if (top) {
    return top;
  }
  const raw = /** @type {{ raw?: { refresh_token?: string }, authed_user?: { refresh_token?: string } }} */ (
    data
  );
  if (raw.raw && typeof raw.raw === "object" && raw.raw.refresh_token?.trim()) {
    return raw.raw.refresh_token.trim();
  }
  if (raw.authed_user && typeof raw.authed_user === "object" && raw.authed_user.refresh_token?.trim()) {
    return raw.authed_user.refresh_token.trim();
  }
  return null;
}

/**
 * @param {SlackMcpCredentials | null} data
 * @param {string} clientId
 * @returns {boolean}
 */
function matchesClientId(data, clientId) {
  if (!data) {
    return false;
  }
  if (data.client_id) {
    return data.client_id === clientId;
  }
  if (process.env.SLACK_ALLOW_LEGACY_TOKEN === "1") {
    return true;
  }
  return false;
}

/**
 * Load credentials for client_id (canonical path, then matching legacy).
 *
 * @param {string} clientId
 * @returns {SlackMcpCredentials | null}
 */
export function loadCredentials(clientId) {
  if (!clientId?.trim()) {
    throw new Error("loadCredentials: clientId required");
  }
  const id = clientId.trim();
  const byClient = readCredentialsFile(credentialsPathFor(id));
  if (byClient && pickAccessToken(byClient)) {
    return byClient;
  }
  const legacyFlat = path.join(getCredentialsDir(), "credentials.json");
  for (const legacy of [legacyFlat, LEGACY_GROK_PATH]) {
    const data = readCredentialsFile(legacy);
    if (matchesClientId(data, id) && pickAccessToken(data)) {
      return data;
    }
  }
  return null;
}

/**
 * Parse an expiry into epoch milliseconds.
 * ISO-8601, or unix time (seconds when the magnitude is below 1e12, otherwise ms).
 * Numeric strings are accepted because older credential files stored unix seconds.
 *
 * @param {unknown} value
 * @returns {number | null}
 */
export function parseExpiryMs(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 1e12 ? Math.round(value * 1000) : Math.round(value);
  }
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const asNumber = Number(trimmed);
    if (!Number.isFinite(asNumber)) {
      return null;
    }
    return asNumber < 1e12 ? Math.round(asNumber * 1000) : Math.round(asNumber);
  }
  const parsed = Date.parse(trimmed);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Resolve `expires_at`: top-level field or derived from raw.expires_in + obtained_at.
 * The top-level field may be an ISO string or a legacy unix timestamp.
 *
 * @param {SlackMcpCredentials | null | undefined} data
 * @returns {string | number | null}
 */
export function resolveExpiresAt(data) {
  if (!data) {
    return null;
  }
  if (data.expires_at != null && data.expires_at !== "") {
    return data.expires_at;
  }
  const raw = data.raw && typeof data.raw === "object" ? data.raw : null;
  const expiresIn =
    raw && typeof /** @type {{ expires_in?: number }} */ (raw).expires_in === "number"
      ? /** @type {{ expires_in: number }} */ (raw).expires_in
      : null;
  if (expiresIn == null || expiresIn <= 0 || !data.obtained_at) {
    return null;
  }
  const obtained = Date.parse(data.obtained_at);
  if (Number.isNaN(obtained)) {
    return null;
  }
  return new Date(obtained + expiresIn * 1000).toISOString();
}

/**
 * Is the access token still usable? (not near expiry).
 * Without known expiry, assume valid (non-rotating legacy tokens).
 *
 * @param {SlackMcpCredentials | null | undefined} data
 * @param {{ now?: number, skewMs?: number }} [opts]
 * @returns {boolean}
 */
export function isAccessTokenValid(data, opts = {}) {
  const token = pickAccessToken(data);
  if (!token) {
    return false;
  }
  const explicitExpiry = data?.expires_at != null && data.expires_at !== "";
  const expiresAt = resolveExpiresAt(data);
  if (!explicitExpiry && (expiresAt == null || expiresAt === "")) {
    return true;
  }
  const expMs = parseExpiryMs(expiresAt);
  // A present but unreadable expiry must not be treated as "never expires".
  if (expMs == null) {
    return false;
  }
  const now = opts.now ?? Date.now();
  const skew = opts.skewMs ?? EXPIRY_SKEW_MS;
  return now < expMs - skew;
}

/**
 * Build a credentials payload from the token endpoint response.
 *
 * @param {Record<string, unknown>} tokenResponse
 * @param {string} clientId
 * @param {{ now?: Date }} [opts]
 * @returns {SlackMcpCredentials}
 */
export function credentialsFromTokenResponse(tokenResponse, clientId, opts = {}) {
  const accessToken = pickAccessToken(tokenResponse);
  if (!accessToken) {
    throw new Error("OAuth/token response missing access_token");
  }
  const now = opts.now ?? new Date();
  const refresh = pickRefreshToken(tokenResponse);

  /** @type {number | undefined} */
  let expiresIn;
  if (typeof tokenResponse.expires_in === "number") {
    expiresIn = tokenResponse.expires_in;
  } else if (
    tokenResponse.authed_user &&
    typeof tokenResponse.authed_user === "object" &&
    typeof /** @type {{ expires_in?: number }} */ (tokenResponse.authed_user).expires_in === "number"
  ) {
    expiresIn = /** @type {{ expires_in: number }} */ (tokenResponse.authed_user).expires_in;
  }

  /** @type {SlackMcpCredentials} */
  const creds = {
    access_token: accessToken,
    client_id: clientId.trim(),
    token_type:
      typeof tokenResponse.token_type === "string" ? tokenResponse.token_type : "Bearer",
    scope: typeof tokenResponse.scope === "string" ? tokenResponse.scope : undefined,
    obtained_at: now.toISOString(),
    raw: tokenResponse,
  };
  if (refresh) {
    creds.refresh_token = refresh;
  }
  if (typeof expiresIn === "number" && Number.isFinite(expiresIn) && expiresIn > 0) {
    creds.expires_at = new Date(now.getTime() + expiresIn * 1000).toISOString();
  }
  return creds;
}

/**
 * Save credentials for a client_id (path + field in the JSON).
 *
 * @param {SlackMcpCredentials} data
 * @param {string} clientId
 * @returns {string} path written
 */
export function saveCredentials(data, clientId) {
  if (!clientId?.trim()) {
    throw new Error("saveCredentials: clientId required");
  }
  const id = clientId.trim();
  const payload = {
    ...data,
    client_id: id,
  };
  const filePath = credentialsPathFor(id);
  // Unix: 0700/0600. Windows: omit mode bits (still private under user profile).
  fs.mkdirSync(path.dirname(filePath), fsMkdirOptions(0o700));
  fs.writeFileSync(
    filePath,
    `${JSON.stringify(payload, null, 2)}\n`,
    fsWriteOptions(0o600, { encoding: "utf8" }),
  );
  return filePath;
}

/**
 * Persist token endpoint response (OAuth or refresh) with normalized fields.
 *
 * @param {Record<string, unknown>} tokenResponse
 * @param {string} clientId
 * @param {{ now?: Date }} [opts]
 * @returns {SlackMcpCredentials}
 */
export function saveTokenResponse(tokenResponse, clientId, opts = {}) {
  const creds = credentialsFromTokenResponse(tokenResponse, clientId, opts);
  saveCredentials(creds, clientId);
  return creds;
}

/**
 * Delete the canonical credentials file for a client_id (e.g. after failed refresh).
 *
 * @param {string} clientId
 * @returns {boolean} true if it existed and was deleted
 */
export function clearCredentials(clientId) {
  if (!clientId?.trim()) {
    throw new Error("clearCredentials: clientId required");
  }
  const filePath = credentialsPathFor(clientId.trim());
  if (!fs.existsSync(filePath)) {
    return false;
  }
  fs.unlinkSync(filePath);
  return true;
}

/**
 * Resolve a **valid on-disk/env** access_token without network.
 * Does not refresh: if expired returns null (even if the file exists).
 *
 * @param {string} clientId
 * @param {{ now?: number, skewMs?: number }} [opts]
 * @returns {string | null}
 */
export function resolveAccessToken(clientId, opts = {}) {
  if (!clientId?.trim()) {
    throw new Error("resolveAccessToken: clientId required");
  }
  const id = clientId.trim();

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
  if (!isAccessTokenValid(data, opts)) {
    return null;
  }
  return pickAccessToken(data);
}
