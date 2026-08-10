/**
 * @file session.test.mjs
 * @description Mid-session auth recovery: detect expiry, force refresh,
 * reauth message + clickable URL, startUserOAuth authorizeUrl, recovery policy.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { startUserOAuth } from "../src/oauth-flow.mjs";
import {
  LOCAL_BRIDGE_TOOL_NAMES,
  SLACK_REAUTH_REQUIRED,
  _resetPendingReauthForTests,
  beginInteractiveReauth,
  decideAuthRecovery,
  forceRefreshAccessToken,
  formatReauthMessage,
  getPendingReauth,
  isAuthSessionError,
  reauthToolResult,
} from "../src/session.mjs";
import { loadCredentials, saveCredentials } from "../src/token.mjs";
import { SLACK_TOKEN_URL } from "../src/refresh.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** @type {string} */
let tmpDir;
/** @type {string | undefined} */
let prevCredsDir;
/** @type {string | undefined} */
let prevMcpToken;

beforeEach(() => {
  _resetPendingReauthForTests();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "slack-session-test-"));
  prevCredsDir = process.env.SLACK_STDIO_CREDS_DIR;
  prevMcpToken = process.env.SLACK_MCP_TOKEN;
  process.env.SLACK_STDIO_CREDS_DIR = tmpDir;
  delete process.env.SLACK_MCP_TOKEN;
  delete process.env.SLACK_USER_TOKEN;
  delete process.env.SLACK_TOKEN;
});

afterEach(async () => {
  const pending = getPendingReauth();
  if (pending) {
    try {
      await pending.cancel();
    } catch {
      /* ignore */
    }
  }
  _resetPendingReauthForTests();
  if (prevCredsDir === undefined) {
    delete process.env.SLACK_STDIO_CREDS_DIR;
  } else {
    process.env.SLACK_STDIO_CREDS_DIR = prevCredsDir;
  }
  if (prevMcpToken === undefined) {
    delete process.env.SLACK_MCP_TOKEN;
  } else {
    process.env.SLACK_MCP_TOKEN = prevMcpToken;
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * @returns {Promise<number>}
 */
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      s.close((err) => {
        if (err) {
          reject(err);
        } else {
          resolve(port);
        }
      });
    });
    s.on("error", reject);
  });
}

describe("isAuthSessionError", () => {
  it("detects common Slack/HTTP auth failures", () => {
    assert.equal(isAuthSessionError(new Error("HTTP 401 Unauthorized")), true);
    assert.equal(isAuthSessionError("invalid_auth"), true);
    assert.equal(isAuthSessionError({ error: "token_expired" }), true);
    assert.equal(isAuthSessionError("token_revoked"), true);
    assert.equal(isAuthSessionError("not_authed"), true);
  });

  it("does not treat missing_scope as session loss", () => {
    assert.equal(isAuthSessionError("missing_scope: chat:write"), false);
  });

  it("detects isError MCP tool payloads with auth text", () => {
    assert.equal(
      isAuthSessionError({
        isError: true,
        content: [{ type: "text", text: "Unauthorized: invalid_token" }],
      }),
      true,
    );
  });

  it("ignores ordinary tool errors", () => {
    assert.equal(isAuthSessionError(new Error("channel_not_found")), false);
    assert.equal(isAuthSessionError("rate_limited"), false);
  });

  it("never treats successful tool results as auth failures", () => {
    // Successful payloads may legitimately mention "access token" / "authentication".
    assert.equal(
      isAuthSessionError({
        content: [
          { type: "text", text: "Message sent. The user mentioned their access token." },
        ],
      }),
      false,
    );
    assert.equal(
      isAuthSessionError({
        isError: false,
        content: [{ type: "text", text: "authentication discussion thread" }],
      }),
      false,
    );
    assert.equal(isAuthSessionError(null), false);
    assert.equal(isAuthSessionError(undefined), false);
  });
});

describe("formatReauthMessage / reauthToolResult", () => {
  const url =
    "https://slack.com/oauth/v2_user/authorize?client_id=1.2&scope=a%20b&state=x";

  it("includes SLACK_REAUTH_REQUIRED and the full clickable URL", () => {
    const msg = formatReauthMessage({
      authorizeUrl: url,
      detail: "callTool 401",
      browserOpened: true,
    });
    assert.ok(msg.startsWith(SLACK_REAUTH_REQUIRED));
    assert.ok(msg.includes(url));
    assert.ok(msg.includes("Click this URL"));
    assert.ok(msg.includes("callTool 401"));
    assert.ok(msg.includes("browser"));
  });

  it("reauthToolResult is an isError tool payload with the URL for the chat", () => {
    const result = reauthToolResult({ authorizeUrl: url, browserOpened: true });
    assert.equal(result.isError, true);
    assert.equal(result.content.length, 1);
    assert.equal(result.content[0].type, "text");
    assert.ok(result.content[0].text.includes(url));
    assert.ok(result.content[0].text.includes(SLACK_REAUTH_REQUIRED));
    // Same string path as formatReauthMessage (not a retyped fixture)
    assert.equal(
      result.content[0].text,
      formatReauthMessage({ authorizeUrl: url, browserOpened: true }),
    );
  });

  it("requires authorizeUrl", () => {
    assert.throws(() => formatReauthMessage({ authorizeUrl: "" }), /authorizeUrl/);
  });
});

describe("decideAuthRecovery (shipped pure policy)", () => {
  it("retry when silent recover succeeded", () => {
    assert.equal(decideAuthRecovery({ recovered: true, skipOAuth: false }), "retry");
    assert.equal(decideAuthRecovery({ recovered: true, skipOAuth: true }), "retry");
  });

  it("fail_skip_oauth when not recovered and skipOAuth", () => {
    assert.equal(
      decideAuthRecovery({ recovered: false, skipOAuth: true }),
      "fail_skip_oauth",
    );
  });

  it("interactive_reauth when not recovered and OAuth allowed", () => {
    assert.equal(
      decideAuthRecovery({ recovered: false, skipOAuth: false }),
      "interactive_reauth",
    );
  });
});

describe("forceRefreshAccessToken (shipped)", () => {
  it("refreshes even when access is still within expires_at window", async () => {
    const clientId = "force-refresh-app";
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    saveCredentials(
      {
        access_token: "OLD_STILL_IN_WINDOW",
        refresh_token: "R_FORCE",
        expires_at: future,
        client_id: clientId,
      },
      clientId,
    );

    /** @type {string | undefined} */
    let bodySeen;
    const token = await forceRefreshAccessToken(clientId, {
      fetchFn: async (url, init) => {
        assert.equal(String(url), SLACK_TOKEN_URL);
        bodySeen = String(init?.body);
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              ok: true,
              access_token: "NEW_AFTER_FORCE",
              refresh_token: "R_FORCE_NEW",
              expires_in: 43200,
            };
          },
        };
      },
    });

    assert.equal(token, "NEW_AFTER_FORCE");
    assert.ok(bodySeen?.includes("grant_type=refresh_token"));
    assert.ok(bodySeen?.includes("refresh_token=R_FORCE"));
    assert.equal(loadCredentials(clientId)?.access_token, "NEW_AFTER_FORCE");
    assert.equal(loadCredentials(clientId)?.refresh_token, "R_FORCE_NEW");
  });

  it("clears credentials and returns null on refresh failure", async () => {
    const clientId = "force-fail-app";
    saveCredentials(
      {
        access_token: "x",
        refresh_token: "bad",
        expires_at: new Date(Date.now() + 3600_000).toISOString(),
        client_id: clientId,
      },
      clientId,
    );
    const token = await forceRefreshAccessToken(clientId, {
      fetchFn: async () => ({
        ok: true,
        status: 200,
        async json() {
          return { ok: false, error: "invalid_refresh_token" };
        },
      }),
    });
    assert.equal(token, null);
    assert.equal(loadCredentials(clientId), null);
  });

  it("returns null when no refresh_token", async () => {
    const clientId = "no-refresh";
    saveCredentials(
      {
        access_token: "only-access",
        expires_at: new Date(Date.now() + 3600_000).toISOString(),
        client_id: clientId,
      },
      clientId,
    );
    const token = await forceRefreshAccessToken(clientId, {
      fetchFn: async () => {
        throw new Error("must not call fetch");
      },
    });
    assert.equal(token, null);
  });
});

describe("startUserOAuth / beginInteractiveReauth authorizeUrl", () => {
  it("startUserOAuth exposes https authorizeUrl before Allow (openBrowser false)", async () => {
    const port = await freePort();
    const session = await startUserOAuth({
      clientId: "1601185624273.8899143856786",
      port,
      host: "localhost",
      callbackPath: "/callback",
      openBrowser: false,
      timeoutMs: 5_000,
    });
    session.tokenPromise.catch(() => {
      /* cancel */
    });
    try {
      assert.ok(session.authorizeUrl.startsWith("https://slack.com/oauth/v2_user/authorize"));
      assert.ok(session.authorizeUrl.includes("client_id="));
      assert.ok(session.authorizeUrl.includes("code_challenge="));
      assert.ok(session.authorizeUrl.includes(`redirect_uri=`));
      // Same URL is what the chat message must carry
      const chatMsg = formatReauthMessage({
        authorizeUrl: session.authorizeUrl,
        browserOpened: false,
      });
      assert.ok(chatMsg.includes(session.authorizeUrl));
      assert.ok(chatMsg.includes(SLACK_REAUTH_REQUIRED));
    } finally {
      await session.cancel();
    }
  });

  it("beginInteractiveReauth returns authorizeUrl and reuses pending for same client", async () => {
    const port = await freePort();
    const first = await beginInteractiveReauth({
      clientId: "reauth-client-1",
      port,
      host: "localhost",
      callbackPath: "/callback",
      openBrowser: false,
      timeoutMs: 5_000,
    });
    first.tokenPromise.catch(() => {
      /* cancel */
    });
    try {
      assert.ok(first.authorizeUrl.startsWith("https://"));
      assert.equal(first.alreadyInProgress, false);
      const second = await beginInteractiveReauth({
        clientId: "reauth-client-1",
        port,
        host: "localhost",
        callbackPath: "/callback",
        openBrowser: false,
        timeoutMs: 5_000,
      });
      assert.equal(second.alreadyInProgress, true);
      assert.equal(second.authorizeUrl, first.authorizeUrl);
      assert.equal(getPendingReauth()?.authorizeUrl, first.authorizeUrl);
    } finally {
      const p = getPendingReauth();
      if (p) {
        p.tokenPromise.catch(() => {
          /* cancel */
        });
        await p.cancel();
      }
    }
  });

  it("starts a fresh flow with a new URL after the pending one settles", async () => {
    const port = await freePort();
    const first = await beginInteractiveReauth({
      clientId: "reauth-client-fresh",
      port,
      host: "localhost",
      callbackPath: "/callback",
      openBrowser: false,
      timeoutMs: 5_000,
    });
    first.tokenPromise.catch(() => {
      /* cancel */
    });
    // Settle the pending flow (e.g. wait=true failed / user cancelled).
    const pending = getPendingReauth();
    assert.ok(pending);
    await pending.cancel();
    assert.equal(getPendingReauth(), null);

    const second = await beginInteractiveReauth({
      clientId: "reauth-client-fresh",
      port,
      host: "localhost",
      callbackPath: "/callback",
      openBrowser: false,
      timeoutMs: 5_000,
    });
    second.tokenPromise.catch(() => {
      /* cancel */
    });
    try {
      assert.equal(second.alreadyInProgress, false);
      // New PKCE verifier + state ⇒ a different authorize URL.
      assert.notEqual(second.authorizeUrl, first.authorizeUrl);
    } finally {
      const p = getPendingReauth();
      if (p) {
        await p.cancel();
      }
    }
  });
});

describe("local bridge tools structural coverage", () => {
  it("LOCAL_BRIDGE_TOOL_NAMES match server.mjs LOCAL_TOOLS wiring", () => {
    assert.deepEqual([...LOCAL_BRIDGE_TOOL_NAMES], [
      "slack_stdio_reauth",
      "slack_stdio_session_status",
    ]);
    const serverSrc = fs.readFileSync(path.join(repoRoot, "src", "server.mjs"), "utf8");
    for (const name of LOCAL_BRIDGE_TOOL_NAMES) {
      assert.ok(
        serverSrc.includes(name) || serverSrc.includes("LOCAL_BRIDGE_TOOL_NAMES"),
        `server.mjs must expose ${name}`,
      );
    }
    assert.ok(serverSrc.includes("decideAuthRecovery"));
    assert.ok(serverSrc.includes("recoverOrPromptReauth") || serverSrc.includes("beginInteractiveReauth"));
    assert.ok(serverSrc.includes("forceRefreshAccessToken"));
    assert.ok(serverSrc.includes("reauthToolResult") || serverSrc.includes("SLACK_REAUTH_REQUIRED"));
  });
});
