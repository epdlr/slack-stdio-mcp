/**
 * @file config.test.mjs
 * @description Tests of the **shipped** CLI + env parse/resolve (config.mjs).
 */

import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  CONFIG_DEFAULTS,
  applyConfigToEnv,
  parseArgv,
  resolveConfig,
} from "../src/config.mjs";
import { DEFAULT_CLIENT_ID } from "../src/oauth-flow.mjs";
import { profileCredentialsDir } from "../src/platform.mjs";

describe("parseArgv", () => {
  it("parses --flag value and --flag=value", () => {
    const a = parseArgv(["--client-id", "a.b", "--oauth-path=/oauth/callback"]);
    assert.equal(a.clientId, "a.b");
    assert.equal(a.oauthPath, "/oauth/callback");
  });

  it("--skip-oauth without value ⇒ true", () => {
    assert.equal(parseArgv(["--skip-oauth"]).skipOAuth, true);
  });

  it("unknown flags go to unknown", () => {
    const p = parseArgv(["--nope", "x"]);
    assert.ok(p.unknown.some((u) => u.includes("nope") || u === "--nope"));
  });

  it("bare -- is skipped so flags after it still parse", () => {
    const p = parseArgv(["--", "--profile", "chooseme", "--skip-oauth"]);
    assert.equal(p.profile, "chooseme");
    assert.equal(p.skipOAuth, true);
  });
});

describe("resolveConfig (shipped)", () => {
  it("no flags or env ⇒ Claude partner defaults", () => {
    const c = resolveConfig({ argv: [], env: {} });
    assert.equal(c.clientId, DEFAULT_CLIENT_ID);
    assert.equal(c.clientId, CONFIG_DEFAULTS.clientId);
    assert.equal(c.oauthHost, "localhost");
    assert.equal(c.oauthPath, "/callback");
    assert.equal(c.oauthPort, 3118);
    assert.equal(c.mcpUrl, "https://mcp.slack.com/mcp");
    assert.equal(c.skipOAuth, false);
    assert.equal(c.token, undefined);
    assert.equal(c.credsDir, undefined);
  });

  it("env-only applies SLACK_*", () => {
    const c = resolveConfig({
      argv: [],
      env: {
        SLACK_CLIENT_ID: "env.client",
        SLACK_OAUTH_HOST: "127.0.0.1",
        SLACK_OAUTH_PATH: "/oauth/callback",
        SLACK_OAUTH_PORT: "4000",
        SLACK_SKIP_OAUTH: "1",
        SLACK_STDIO_CREDS_DIR: "/tmp/creds-env",
        SLACK_MCP_URL: "https://example.test/mcp",
      },
    });
    assert.equal(c.clientId, "env.client");
    assert.equal(c.oauthHost, "127.0.0.1");
    assert.equal(c.oauthPath, "/oauth/callback");
    assert.equal(c.oauthPort, 4000);
    assert.equal(c.skipOAuth, true);
    assert.equal(c.credsDir, "/tmp/creds-env");
    assert.equal(c.mcpUrl, "https://example.test/mcp");
  });

  it("flag --client-id wins over SLACK_CLIENT_ID", () => {
    const c = resolveConfig({
      argv: ["--client-id", "from.flag"],
      env: { SLACK_CLIENT_ID: "from.env" },
    });
    assert.equal(c.clientId, "from.flag");
    assert.notEqual(c.clientId, "from.env");
  });

  it("--skip-oauth flag maps to skipOAuth true (like SLACK_SKIP_OAUTH=1)", () => {
    const byFlag = resolveConfig({ argv: ["--skip-oauth"], env: {} });
    const byEnv = resolveConfig({ argv: [], env: { SLACK_SKIP_OAUTH: "1" } });
    assert.equal(byFlag.skipOAuth, true);
    assert.equal(byEnv.skipOAuth, true);
  });

  it("flag wins for oauth path/host/port and token", () => {
    const c = resolveConfig({
      argv: [
        "--oauth-host",
        "127.0.0.1",
        "--oauth-path",
        "/oauth/callback",
        "--oauth-port",
        "9999",
        "--token",
        "xoxp-flag",
        "--creds-dir",
        "/tmp/flag-creds",
      ],
      env: {
        SLACK_OAUTH_HOST: "localhost",
        SLACK_OAUTH_PATH: "/callback",
        SLACK_OAUTH_PORT: "3118",
        SLACK_MCP_TOKEN: "xoxp-env",
        SLACK_STDIO_CREDS_DIR: "/tmp/env-creds",
      },
    });
    assert.equal(c.oauthHost, "127.0.0.1");
    assert.equal(c.oauthPath, "/oauth/callback");
    assert.equal(c.oauthPort, 9999);
    assert.equal(c.token, "xoxp-flag");
    assert.equal(c.credsDir, "/tmp/flag-creds");
  });

  it("rejects unknown flags by default", () => {
    assert.throws(
      () => resolveConfig({ argv: ["--totally-unknown"], env: {} }),
      /unknown|unknown/i,
    );
  });

  it("applyConfigToEnv writes resolved knobs", () => {
    /** @type {Record<string, string | undefined>} */
    const env = {};
    const c = resolveConfig({
      argv: ["--client-id", "app.1", "--skip-oauth", "--creds-dir", "/c"],
      env: {},
    });
    applyConfigToEnv(c, env);
    assert.equal(env.SLACK_CLIENT_ID, "app.1");
    assert.equal(env.SLACK_SKIP_OAUTH, "1");
    assert.equal(env.SLACK_STDIO_CREDS_DIR, "/c");
    assert.equal(env.SLACK_OAUTH_HOST, "localhost");
  });

  it("--profile resolves to ~/.slack-stdio-mcp/profiles/<name>", () => {
    const home = "/tmp/fake-home-profile";
    const c = resolveConfig({
      argv: ["--profile", "user_cl"],
      env: { HOME: home },
    });
    assert.equal(c.profile, "user_cl");
    assert.equal(
      c.credsDir,
      profileCredentialsDir("user_cl", { homedir: home }),
    );
    assert.equal(
      c.credsDir,
      path.join(home, ".slack-stdio-mcp", "profiles", "user_cl"),
    );
  });

  it("--creds-dir wins over --profile", () => {
    const c = resolveConfig({
      argv: ["--profile", "user_cl", "--creds-dir", "/explicit/creds"],
      env: { HOME: "/tmp/fake-home" },
    });
    assert.equal(c.credsDir, "/explicit/creds");
    assert.equal(c.profile, "user_cl");
  });

  it("npx/Cursor argv -- --profile still resolves the named store", () => {
    const home = "/tmp/fake-home-profile-ddash";
    const c = resolveConfig({
      argv: ["--", "--profile", "chooseme"],
      env: { HOME: home },
    });
    assert.equal(c.profile, "chooseme");
    assert.equal(
      c.credsDir,
      path.join(home, ".slack-stdio-mcp", "profiles", "chooseme"),
    );
  });

  it("same profile name yields the same path (share across repos)", () => {
    const a = resolveConfig({ argv: ["--profile", "user_cl"], env: {} });
    const b = resolveConfig({ argv: ["--profile", "user_cl"], env: {} });
    assert.equal(a.credsDir, b.credsDir);
    assert.ok(a.credsDir?.includes(`${path.sep}profiles${path.sep}user_cl`));
    // Default home on this machine
    assert.equal(
      a.credsDir,
      path.join(os.homedir(), ".slack-stdio-mcp", "profiles", "user_cl"),
    );
  });
});
