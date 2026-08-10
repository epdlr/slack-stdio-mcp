/**
 * @file ensure-token.mjs
 * @description Obtain a usable Bearer: env → valid disk → refresh → interactive OAuth.
 *
 * Separated from the MCP proxy so the token lifecycle can be tested without stdio
 * or mcp.slack.com.
 */

import { credentialsPathFor } from "./token.mjs";
import { resolveOrRefreshAccessToken } from "./refresh.mjs";

/**
 * @typedef {typeof fetch} FetchFn
 */

/**
 * Obtain a usable access token: env/disk (via refresh) → optional interactive OAuth.
 *
 * @param {{
 *   clientId: string,
 *   clientSecret?: string,
 *   skipOAuth?: boolean,
 *   fetchFn?: FetchFn,
 *   tokenUrl?: string,
 *   now?: number,
 *   nowDate?: Date,
 *   skewMs?: number,
 *   runOAuth?: (opts: { clientId: string, clientSecret?: string }) => Promise<string>,
 * }} opts
 * @returns {Promise<string>} Bearer access token
 * @throws {Error} If `clientId` is empty, no usable token and `skipOAuth`, or no `runOAuth`
 */
export async function ensureAccessToken(opts) {
  const clientId = opts.clientId?.trim();
  if (!clientId) {
    throw new Error("ensureAccessToken: clientId required");
  }

  const existing = await resolveOrRefreshAccessToken(clientId, {
    clientSecret: opts.clientSecret,
    fetchFn: opts.fetchFn,
    tokenUrl: opts.tokenUrl,
    now: opts.now,
    nowDate: opts.nowDate,
    skewMs: opts.skewMs,
  });
  if (existing) {
    return existing;
  }

  if (opts.skipOAuth) {
    throw new Error(
      `No usable token for client_id=${clientId} and SLACK_SKIP_OAUTH=1. ` +
        `Run npm run auth or remove the flag. Expected: ${credentialsPathFor(clientId)}`,
    );
  }

  if (typeof opts.runOAuth !== "function") {
    throw new Error(
      `No usable token for client_id=${clientId} and no runOAuth configured.`,
    );
  }

  return opts.runOAuth({
    clientId,
    clientSecret: opts.clientSecret,
  });
}
