/**
 * @file config.mjs
 * @description Runtime config resolution: **CLI flags > env > defaults**.
 *
 * Single place for bridge knobs (client id, OAuth, MCP URL, creds, skip-oauth).
 * Testable without starting MCP: pass synthetic `argv` + `env` to `resolveConfig`.
 */

import { profileCredentialsDir } from "./platform.mjs";
import { DEFAULT_CLIENT_ID } from "./oauth-flow.mjs";

/**
 * @typedef {object} ParsedFlags
 * @property {string} [clientId]
 * @property {string} [clientSecret]
 * @property {string} [oauthHost]
 * @property {string} [oauthPath]
 * @property {number} [oauthPort]
 * @property {string} [mcpUrl]
 * @property {string} [credsDir]
 * @property {string} [profile]
 * @property {boolean} [skipOAuth]
 * @property {string} [token]
 * @property {boolean} help
 * @property {string[]} unknown
 */

/**
 * @typedef {object} RuntimeConfig
 * @property {boolean} help
 * @property {string} clientId
 * @property {string} [clientSecret]
 * @property {string} oauthHost
 * @property {string} oauthPath
 * @property {number} oauthPort
 * @property {string} mcpUrl
 * @property {string} [credsDir]
 * @property {string} [profile]
 * @property {boolean} skipOAuth
 * @property {string} [token]
 * @property {string[]} unknownFlags
 */

/** Defaults when there is no flag or env (historical bridge behavior). */
export const CONFIG_DEFAULTS = Object.freeze({
  clientId: DEFAULT_CLIENT_ID,
  oauthHost: "localhost",
  oauthPath: "/callback",
  oauthPort: 3118,
  mcpUrl: "https://mcp.slack.com/mcp",
  skipOAuth: false,
});

/** @type {Readonly<Record<string, string>>} */
export const FLAG_TO_ENV = Object.freeze({
  "client-id": "SLACK_CLIENT_ID",
  "client-secret": "SLACK_CLIENT_SECRET",
  "oauth-host": "SLACK_OAUTH_HOST",
  "oauth-path": "SLACK_OAUTH_PATH",
  "oauth-port": "SLACK_OAUTH_PORT",
  "mcp-url": "SLACK_MCP_URL",
  "creds-dir": "SLACK_STDIO_CREDS_DIR",
  profile: "SLACK_STDIO_PROFILE",
  "skip-oauth": "SLACK_SKIP_OAUTH",
  token: "SLACK_MCP_TOKEN",
  "mcp-token": "SLACK_MCP_TOKEN",
});

/** Known flags (long form without --). */
const KNOWN_FLAGS = new Set([
  "client-id",
  "client-secret",
  "oauth-host",
  "oauth-path",
  "oauth-port",
  "mcp-url",
  "creds-dir",
  "profile",
  "skip-oauth",
  "token",
  "mcp-token",
  "help",
  "h",
]);

/**
 * Parse process argv (without `node` or the script path).
 * Accepts `--flag value` and `--flag=value`. Booleans: `--skip-oauth` / `--skip-oauth=true|false`.
 *
 * @param {string[]} argv
 * @returns {ParsedFlags}
 * @throws {Error} If a value flag is missing its argument or `--oauth-port` is invalid
 */
export function parseArgv(argv) {
  /** @type {ParsedFlags} */
  const out = { help: false, unknown: [] };
  const args = Array.isArray(argv) ? [...argv] : [];

  for (let i = 0; i < args.length; i += 1) {
    const raw = args[i];
    if (raw == null || raw === "") {
      continue;
    }

    // Hosts (Cursor, some npx invocations) pass a literal `--` before flags.
    // Skip it and keep parsing; do not drop `--profile` / `--creds-dir`.
    if (raw === "--") {
      continue;
    }

    if (raw === "-h" || raw === "--help") {
      out.help = true;
      continue;
    }

    if (!raw.startsWith("--")) {
      out.unknown.push(raw);
      continue;
    }

    let name = raw.slice(2);
    /** @type {string | undefined} */
    let inline;
    const eq = name.indexOf("=");
    if (eq >= 0) {
      inline = name.slice(eq + 1);
      name = name.slice(0, eq);
    }

    if (!KNOWN_FLAGS.has(name)) {
      out.unknown.push(raw.includes("=") ? `--${name}` : raw);
      continue;
    }

    if (name === "help" || name === "h") {
      out.help = true;
      continue;
    }

    if (name === "skip-oauth") {
      if (inline === undefined) {
        // Bare `--skip-oauth` ⇒ true. Optional next token true/false.
        const next = args[i + 1];
        if (next === "true" || next === "false") {
          i += 1;
          out.skipOAuth = next === "true";
        } else {
          out.skipOAuth = true;
        }
      } else {
        out.skipOAuth = inline !== "0" && inline.toLowerCase() !== "false";
      }
      continue;
    }

    /** @type {string | undefined} */
    let value = inline;
    if (value === undefined) {
      const next = args[i + 1];
      if (next == null || next.startsWith("-")) {
        throw new Error(`Flag --${name} requires a value`);
      }
      value = next;
      i += 1;
    }

    switch (name) {
      case "client-id":
        out.clientId = value;
        break;
      case "client-secret":
        out.clientSecret = value;
        break;
      case "oauth-host":
        out.oauthHost = value;
        break;
      case "oauth-path":
        out.oauthPath = value;
        break;
      case "oauth-port": {
        const n = Number(value);
        if (!Number.isFinite(n) || n <= 0) {
          throw new Error(`--oauth-port invalid: ${value}`);
        }
        out.oauthPort = n;
        break;
      }
      case "mcp-url":
        out.mcpUrl = value;
        break;
      case "creds-dir":
        out.credsDir = value;
        break;
      case "profile":
        out.profile = value;
        break;
      case "token":
      case "mcp-token":
        out.token = value;
        break;
      default:
        out.unknown.push(`--${name}`);
    }
  }

  return out;
}

/**
 * @param {string | undefined} flagVal
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} env
 * @param {string} envKey
 * @param {string | undefined} fallback
 * @returns {string | undefined}
 */
function pickString(flagVal, env, envKey, fallback) {
  if (flagVal !== undefined && flagVal !== null && String(flagVal).trim() !== "") {
    return String(flagVal).trim();
  }
  const fromEnv = env[envKey]?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  return fallback;
}

/**
 * Resolve effective config. Precedence: **flag > env > default**.
 *
 * @param {{
 *   argv?: string[],
 *   env?: NodeJS.ProcessEnv | Record<string, string | undefined>,
 *   rejectUnknown?: boolean,
 * }} [opts]
 * @returns {RuntimeConfig}
 * @throws {Error} On unknown flags (when `rejectUnknown`), bad ports, or parse errors
 */
export function resolveConfig(opts = {}) {
  const argv = opts.argv ?? [];
  const env = opts.env ?? process.env;
  const rejectUnknown = opts.rejectUnknown !== false;

  const flags = parseArgv(argv);

  if (rejectUnknown && flags.unknown.length > 0) {
    throw new Error(
      `Unknown flags or arguments: ${flags.unknown.join(", ")}. Use --help.`,
    );
  }

  const clientId =
    pickString(flags.clientId, env, "SLACK_CLIENT_ID", CONFIG_DEFAULTS.clientId) ||
    CONFIG_DEFAULTS.clientId;

  const clientSecret = pickString(flags.clientSecret, env, "SLACK_CLIENT_SECRET", undefined);

  const oauthHost =
    pickString(flags.oauthHost, env, "SLACK_OAUTH_HOST", CONFIG_DEFAULTS.oauthHost) ||
    CONFIG_DEFAULTS.oauthHost;

  let oauthPath =
    pickString(flags.oauthPath, env, "SLACK_OAUTH_PATH", CONFIG_DEFAULTS.oauthPath) ||
    CONFIG_DEFAULTS.oauthPath;
  oauthPath = oauthPath.replace(/\/$/, "") || "/callback";
  if (!oauthPath.startsWith("/")) {
    oauthPath = `/${oauthPath}`;
  }

  /** @type {number} */
  let oauthPort = CONFIG_DEFAULTS.oauthPort;
  if (flags.oauthPort != null) {
    oauthPort = flags.oauthPort;
  } else if (env.SLACK_OAUTH_PORT?.trim()) {
    const n = Number(env.SLACK_OAUTH_PORT.trim());
    if (!Number.isFinite(n) || n <= 0) {
      throw new Error(`SLACK_OAUTH_PORT invalid: ${env.SLACK_OAUTH_PORT}`);
    }
    oauthPort = n;
  }

  const mcpUrl =
    pickString(flags.mcpUrl, env, "SLACK_MCP_URL", CONFIG_DEFAULTS.mcpUrl) ||
    CONFIG_DEFAULTS.mcpUrl;

  // Precedence for storage: --creds-dir > --profile / SLACK_STDIO_PROFILE > default dir.
  const explicitCredsDir = pickString(flags.credsDir, env, "SLACK_STDIO_CREDS_DIR", undefined);
  const profile = pickString(flags.profile, env, "SLACK_STDIO_PROFILE", undefined);
  /** @type {string | undefined} */
  let credsDir = explicitCredsDir;
  if (!credsDir && profile) {
    const homeHint =
      (typeof env.HOME === "string" && env.HOME.trim()) ||
      (typeof env.USERPROFILE === "string" && env.USERPROFILE.trim()) ||
      undefined;
    credsDir = profileCredentialsDir(profile, { homedir: homeHint || undefined });
  }

  const skipOAuth =
    flags.skipOAuth === true ||
    (flags.skipOAuth !== false && env.SLACK_SKIP_OAUTH === "1");

  const token =
    pickString(flags.token, env, "SLACK_MCP_TOKEN", undefined) ||
    env.SLACK_USER_TOKEN?.trim() ||
    env.SLACK_TOKEN?.trim() ||
    undefined;

  return {
    help: flags.help,
    clientId,
    clientSecret: clientSecret || undefined,
    oauthHost,
    oauthPath,
    oauthPort,
    mcpUrl,
    credsDir: credsDir || undefined,
    profile: profile || undefined,
    skipOAuth,
    token: token || undefined,
    unknownFlags: flags.unknown,
  };
}

/**
 * Help text (stderr). No secrets.
 *
 * @returns {string}
 */
export function formatHelp() {
  return `slack-stdio-mcp — MCP stdio bridge to mcp.slack.com

Usage:
  slack-stdio-mcp [options]
  node src/server.mjs [options]
  npm run auth -- [options]

Precedence: CLI flags > environment variables > built-in defaults.

Options:
  --client-id <id>       OAuth app client id (env SLACK_CLIENT_ID)
  --client-secret <s>    Optional client secret (env SLACK_CLIENT_SECRET)
  --oauth-host <host>    Redirect host (default: localhost)
  --oauth-path <path>    Redirect path (default: /callback)
  --oauth-port <port>    Loopback port (default: 3118)
  --mcp-url <url>        MCP endpoint (default: https://mcp.slack.com/mcp)
  --profile <name>       Named creds under ~/.slack-stdio-mcp/profiles/<name>
                         (env SLACK_STDIO_PROFILE). Same name ⇒ share tokens across hosts.
  --creds-dir <dir>      Absolute credentials root (wins over --profile)
  --skip-oauth           Do not open browser; fail if no usable token
  --token <bearer>       Inject access token (env SLACK_MCP_TOKEN)
  --mcp-token <bearer>   Alias of --token
  -h, --help             Show this help

Examples:
  npx -y slack-stdio-mcp --profile user_cl
  npx -y slack-stdio-mcp --skip-oauth
  node src/server.mjs --client-id 123.456 --oauth-path /oauth/callback --oauth-host 127.0.0.1
`;
}

/**
 * Apply resolved knobs to process.env for modules that still read env
 * (token inject, creds dir). Only writes values defined in config.
 *
 * @param {RuntimeConfig} config
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} [env]
 */
export function applyConfigToEnv(config, env = process.env) {
  env.SLACK_CLIENT_ID = config.clientId;
  if (config.clientSecret) {
    env.SLACK_CLIENT_SECRET = config.clientSecret;
  }
  env.SLACK_OAUTH_HOST = config.oauthHost;
  env.SLACK_OAUTH_PATH = config.oauthPath;
  env.SLACK_OAUTH_PORT = String(config.oauthPort);
  env.SLACK_MCP_URL = config.mcpUrl;
  if (config.credsDir) {
    env.SLACK_STDIO_CREDS_DIR = config.credsDir;
  }
  if (config.profile) {
    env.SLACK_STDIO_PROFILE = config.profile;
  }
  if (config.skipOAuth) {
    env.SLACK_SKIP_OAUTH = "1";
  } else if (env.SLACK_SKIP_OAUTH === "1" && !config.skipOAuth) {
    // Resolved false: clear so deep readers do not see a stale 1 when only defaults apply.
    // If env had 1, resolveConfig would have set skipOAuth true — so this branch means
    // neither flag nor env requested skip.
    delete env.SLACK_SKIP_OAUTH;
  }
  if (config.token) {
    env.SLACK_MCP_TOKEN = config.token;
  }
}

/**
 * Load config from the current process argv/env.
 * If `help`, print and exit 0. On parse error, print and exit 1.
 *
 * @param {{ argv?: string[], env?: NodeJS.ProcessEnv }} [opts]
 * @returns {RuntimeConfig}
 */
export function loadRuntimeConfig(opts = {}) {
  const argv = opts.argv ?? process.argv.slice(2);
  const env = opts.env ?? process.env;
  try {
    const config = resolveConfig({ argv, env });
    if (config.help) {
      console.error(formatHelp());
      process.exit(0);
    }
    applyConfigToEnv(config, env);
    return config;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[slack-stdio] Config: ${msg}`);
    process.exit(1);
    throw e;
  }
}
