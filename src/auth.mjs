#!/usr/bin/env node
/**
 * @file auth.mjs
 * @description Standalone OAuth CLI (same flow as server.mjs startup).
 *
 * Usage:
 * ```bash
 * npm run auth
 * npm run auth -- --client-id 123.456 --oauth-path /oauth/callback
 * # also env: SLACK_CLIENT_ID, SLACK_CLIENT_SECRET, …
 * ```
 *
 * Precedence: CLI flags > env > defaults (`src/config.mjs`).
 */

import { loadRuntimeConfig } from "./config.mjs";
import { runUserOAuth } from "./oauth-flow.mjs";
import { credentialsPathFor, loadCredentials } from "./token.mjs";

const config = loadRuntimeConfig();
const clientId = config.clientId;

try {
  await runUserOAuth({
    clientId,
    clientSecret: config.clientSecret,
    host: config.oauthHost,
    port: config.oauthPort,
    callbackPath: config.oauthPath,
  });
  const saved = loadCredentials(clientId);
  console.error(`OK: credentials for client_id=${clientId}`);
  console.error(`    ${credentialsPathFor(clientId)}`);
  if (saved?.expires_at) {
    console.error(`    expires_at=${saved.expires_at}`);
  }
  if (saved?.refresh_token) {
    console.error(`    refresh_token=present`);
  }
  process.exit(0);
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}
