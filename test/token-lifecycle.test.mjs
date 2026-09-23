/**
 * @file token-lifecycle.test.mjs
 * @description Credential lifecycle tests **against the shipped code**.
 *
 * Covers: save/resolve per client_id, isolation across apps, expiry → refresh
 * (injected fetch), failed refresh (does not reuse dead access).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { ensureAccessToken } from "../src/ensure-token.mjs";
import {
  resolveOrRefreshAccessToken,
  requestTokenRefresh,
  SLACK_TOKEN_URL,
} from "../src/refresh.mjs";
import {
  clearCredentials,
  credentialsFromTokenResponse,
  credentialsPathFor,
  isAccessTokenValid,
  loadCredentials,
  parseExpiryMs,
  pickAccessToken,
  resolveAccessToken,
  saveCredentials,
  saveTokenResponse,
} from "../src/token.mjs";

/** @type {string} */
let tmpDir;
/** @type {string | undefined} */
let prevCredsDir;
/** @type {string | undefined} */
let prevMcpToken;
/** @type {string | undefined} */
let prevUserToken;
/** @type {string | undefined} */
let prevSlackToken;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "slack-stdio-test-"));
  prevCredsDir = process.env.SLACK_STDIO_CREDS_DIR;
  prevMcpToken = process.env.SLACK_MCP_TOKEN;
  prevUserToken = process.env.SLACK_USER_TOKEN;
  prevSlackToken = process.env.SLACK_TOKEN;
  process.env.SLACK_STDIO_CREDS_DIR = tmpDir;
  delete process.env.SLACK_MCP_TOKEN;
  delete process.env.SLACK_USER_TOKEN;
  delete process.env.SLACK_TOKEN;
});

afterEach(() => {
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
  if (prevUserToken === undefined) {
    delete process.env.SLACK_USER_TOKEN;
  } else {
    process.env.SLACK_USER_TOKEN = prevUserToken;
  }
  if (prevSlackToken === undefined) {
    delete process.env.SLACK_TOKEN;
  } else {
    process.env.SLACK_TOKEN = prevSlackToken;
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * @param {Record<string, unknown>} body
 * @returns {typeof fetch}
 */
function mockFetchOk(body) {
  return async (url, init) => {
    assert.equal(String(url), SLACK_TOKEN_URL);
    assert.equal(init?.method, "POST");
    return {
      ok: true,
      status: 200,
      async json() {
        return body;
      },
    };
  };
}

/**
 * @param {string} error
 * @returns {typeof fetch}
 */
function mockFetchFail(error) {
  return async () => ({
    ok: true,
    status: 200,
    async json() {
      return { ok: false, error };
    },
  });
}

describe("credentialsFromTokenResponse + save", () => {
  it("persists refresh_token, expires_at, and client_id", () => {
    const clientId = "app.one";
    const now = new Date("2026-07-22T12:00:00.000Z");
    const saved = saveTokenResponse(
      {
        ok: true,
        access_token: "xoxe.xoxp-access-1",
        refresh_token: "xoxe-refresh-1",
        expires_in: 43200,
        token_type: "Bearer",
        scope: "chat:write",
      },
      clientId,
      { now },
    );

    assert.equal(saved.access_token, "xoxe.xoxp-access-1");
    assert.equal(saved.refresh_token, "xoxe-refresh-1");
    assert.equal(saved.client_id, clientId);
    // 12:00Z + 43200s = 00:00Z next day
    assert.equal(saved.expires_at, "2026-07-23T00:00:00.000Z");

    const onDisk = JSON.parse(fs.readFileSync(credentialsPathFor(clientId), "utf8"));
    assert.equal(onDisk.refresh_token, "xoxe-refresh-1");
    assert.equal(onDisk.expires_at, "2026-07-23T00:00:00.000Z");
    assert.equal(onDisk.client_id, clientId);
  });

  it("isolates tokens across different client_ids", () => {
    saveCredentials(
      { access_token: "tok-a", client_id: "id-a", obtained_at: new Date().toISOString() },
      "id-a",
    );
    saveCredentials(
      { access_token: "tok-b", client_id: "id-b", obtained_at: new Date().toISOString() },
      "id-b",
    );

    assert.equal(resolveAccessToken("id-a"), "tok-a");
    assert.equal(resolveAccessToken("id-b"), "tok-b");
    assert.equal(loadCredentials("id-a")?.access_token, "tok-a");
    assert.notEqual(credentialsPathFor("id-a"), credentialsPathFor("id-b"));
  });
});

describe("expiry detection", () => {
  it("isAccessTokenValid respects skew and expires_at", () => {
    const creds = credentialsFromTokenResponse(
      {
        access_token: "x",
        expires_in: 3600,
        refresh_token: "r",
      },
      "c1",
      { now: new Date("2026-01-01T00:00:00.000Z") },
    );
    // expires_at = 01:00Z; with 5m skew, valid at 00:54:59; invalid at 00:55:01
    assert.equal(
      isAccessTokenValid(creds, { now: Date.parse("2026-01-01T00:54:59.000Z") }),
      true,
    );
    assert.equal(
      isAccessTokenValid(creds, { now: Date.parse("2026-01-01T00:55:01.000Z") }),
      false,
    );
  });

  it("resolveAccessToken does not return expired access", () => {
    const clientId = "expired-app";
    saveCredentials(
      {
        access_token: "dead-access",
        refresh_token: "still-have-refresh",
        expires_at: "2020-01-01T00:00:00.000Z",
        client_id: clientId,
      },
      clientId,
    );
    assert.equal(resolveAccessToken(clientId), null);
  });

  it("derives expiry from raw.expires_in + obtained_at (legacy without expires_at)", () => {
    const clientId = "legacy-raw-expiry";
    saveCredentials(
      {
        access_token: "legacy-access",
        refresh_token: "legacy-refresh",
        obtained_at: "2026-01-01T00:00:00.000Z",
        raw: { expires_in: 3600, refresh_token: "legacy-refresh" },
        client_id: clientId,
      },
      clientId,
    );
    // 00:00 + 1h, skew 5m → invalid at 00:55:01
    assert.equal(
      resolveAccessToken(clientId, { now: Date.parse("2026-01-01T00:55:01.000Z") }),
      null,
    );
    assert.equal(
      resolveAccessToken(clientId, { now: Date.parse("2026-01-01T00:50:00.000Z") }),
      "legacy-access",
    );
  });

  it("treats a legacy unix-seconds expires_at as expired", () => {
    const unixSeconds = 1788940976.5434098;
    assert.equal(parseExpiryMs(unixSeconds), Math.round(unixSeconds * 1000));
    assert.equal(
      isAccessTokenValid(
        {
          access_token: "dead-unix",
          expires_at: unixSeconds,
        },
        { now: Date.parse("2026-09-23T12:00:00.000Z") },
      ),
      false,
    );
  });

  it("accepts a future unix-seconds expires_at and a millisecond timestamp", () => {
    const futureSeconds = Date.parse("2026-12-01T00:00:00.000Z") / 1000;
    assert.equal(
      isAccessTokenValid(
        { access_token: "future-unix", expires_at: futureSeconds },
        { now: Date.parse("2026-09-23T12:00:00.000Z") },
      ),
      true,
    );
    const futureMs = Date.parse("2026-12-01T00:00:00.000Z");
    assert.equal(
      isAccessTokenValid(
        { access_token: "future-ms", expires_at: futureMs },
        { now: Date.parse("2026-09-23T12:00:00.000Z") },
      ),
      true,
    );
  });

  it("does not treat an unreadable expires_at as never-expiring", () => {
    assert.equal(
      isAccessTokenValid({ access_token: "bad-exp", expires_at: "not-a-date" }),
      false,
    );
    assert.equal(isAccessTokenValid({ access_token: "legacy-no-exp" }), true);
  });
});

describe("refresh path (shipped)", () => {
  it("requestTokenRefresh sends grant_type=refresh_token", async () => {
    /** @type {string | undefined} */
    let seenBody;
    const fetchFn = async (_url, init) => {
      seenBody = String(init?.body);
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            ok: true,
            access_token: "new-access",
            refresh_token: "new-refresh",
            expires_in: 1000,
          };
        },
      };
    };

    const data = await requestTokenRefresh({
      clientId: "cid",
      refreshToken: "old-refresh",
      clientSecret: "sec",
      fetchFn: /** @type {typeof fetch} */ (fetchFn),
    });
    assert.equal(data.access_token, "new-access");
    assert.ok(seenBody?.includes("grant_type=refresh_token"));
    assert.ok(seenBody?.includes("client_id=cid"));
    assert.ok(seenBody?.includes("refresh_token=old-refresh"));
    assert.ok(seenBody?.includes("client_secret=sec"));
  });

  it("resolveOrRefreshAccessToken refreshes and updates disk", async () => {
    const clientId = "refresh-me";
    const past = "2020-01-01T00:00:00.000Z";
    saveCredentials(
      {
        access_token: "old-access-DEAD",
        refresh_token: "refresh-OLD",
        expires_at: past,
        client_id: clientId,
      },
      clientId,
    );

    const token = await resolveOrRefreshAccessToken(clientId, {
      fetchFn: mockFetchOk({
        ok: true,
        access_token: "new-access-LIVE",
        refresh_token: "refresh-NEW",
        expires_in: 43200,
        token_type: "Bearer",
      }),
      now: Date.parse("2026-07-22T12:00:00.000Z"),
      nowDate: new Date("2026-07-22T12:00:00.000Z"),
    });

    assert.equal(token, "new-access-LIVE");
    const disk = loadCredentials(clientId);
    assert.equal(disk?.access_token, "new-access-LIVE");
    assert.equal(disk?.refresh_token, "refresh-NEW");
    assert.equal(disk?.expires_at, "2026-07-23T00:00:00.000Z");
    assert.notEqual(disk?.access_token, "old-access-DEAD");
  });

  it("failed refresh does not reuse expired access and clears credentials", async () => {
    const clientId = "refresh-fail";
    saveCredentials(
      {
        access_token: "expired-access-SHOULD-NOT-RETURN",
        refresh_token: "bad-refresh",
        expires_at: "2020-01-01T00:00:00.000Z",
        client_id: clientId,
      },
      clientId,
    );

    const token = await resolveOrRefreshAccessToken(clientId, {
      fetchFn: mockFetchFail("invalid_refresh_token"),
      now: Date.now(),
    });

    assert.equal(token, null);
    assert.equal(loadCredentials(clientId), null);
    assert.equal(fs.existsSync(credentialsPathFor(clientId)), false);
    // synchronous resolve must not return the dead access either
    assert.equal(resolveAccessToken(clientId), null);
  });

  it("still-valid access does not call fetch", async () => {
    const clientId = "still-good";
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    saveCredentials(
      {
        access_token: "still-valid",
        refresh_token: "r",
        expires_at: future,
        client_id: clientId,
      },
      clientId,
    );

    let called = 0;
    const token = await resolveOrRefreshAccessToken(clientId, {
      fetchFn: async () => {
        called += 1;
        throw new Error("should not call refresh");
      },
    });
    assert.equal(token, "still-valid");
    assert.equal(called, 0);
  });
});

describe("ensureAccessToken (shipped entry policy)", () => {
  it("after successful refresh returns the new access (ensure)", async () => {
    const clientId = "ensure-refresh";
    saveCredentials(
      {
        access_token: "old",
        refresh_token: "r1",
        expires_at: "2019-01-01T00:00:00.000Z",
        client_id: clientId,
      },
      clientId,
    );

    const token = await ensureAccessToken({
      clientId,
      skipOAuth: true,
      fetchFn: mockFetchOk({
        ok: true,
        access_token: "ensured-new",
        refresh_token: "r2",
        expires_in: 100,
      }),
      now: Date.now(),
      nowDate: new Date(),
    });
    // ensureAccessToken does not pass nowDate — refresh uses Date.now via saveTokenResponse default
    assert.equal(token, "ensured-new");
    assert.equal(pickAccessToken(loadCredentials(clientId)), "ensured-new");
  });

  it("skipOAuth + no usable token throws (no dead token)", async () => {
    const clientId = "ensure-fail";
    saveCredentials(
      {
        access_token: "dead",
        refresh_token: "r",
        expires_at: "2019-01-01T00:00:00.000Z",
        client_id: clientId,
      },
      clientId,
    );

    await assert.rejects(
      () =>
        ensureAccessToken({
          clientId,
          skipOAuth: true,
          fetchFn: mockFetchFail("token_revoked"),
        }),
      /No usable token|SLACK_SKIP_OAUTH/,
    );
    assert.equal(resolveAccessToken(clientId), null);
  });

  it("without credentials calls runOAuth when allowed", async () => {
    const clientId = "need-oauth";
    let oauthCalls = 0;
    const token = await ensureAccessToken({
      clientId,
      skipOAuth: false,
      runOAuth: async ({ clientId: cid }) => {
        oauthCalls += 1;
        assert.equal(cid, clientId);
        // simulate OAuth persisting as oauth-flow would
        saveTokenResponse(
          {
            ok: true,
            access_token: "from-oauth",
            refresh_token: "r-oauth",
            expires_in: 3600,
          },
          cid,
        );
        return "from-oauth";
      },
    });
    assert.equal(token, "from-oauth");
    assert.equal(oauthCalls, 1);
  });
});

describe("clearCredentials", () => {
  it("deletes only the given client_id", () => {
    saveCredentials({ access_token: "a" }, "keep");
    saveCredentials({ access_token: "b" }, "drop");
    assert.equal(clearCredentials("drop"), true);
    assert.equal(clearCredentials("drop"), false);
    assert.equal(loadCredentials("keep")?.access_token, "a");
    assert.equal(loadCredentials("drop"), null);
  });
});
