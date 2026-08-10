/**
 * @file scopes.test.mjs
 * @description Anti-drift: authorize scopes = exported USER_SCOPES; README lists each.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  USER_SCOPES,
  buildUserAuthorizeUrl,
  userScopesQueryParam,
} from "../src/oauth-flow.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("USER_SCOPES source of truth", () => {
  it("exports a non-empty array of scope strings", () => {
    assert.ok(Array.isArray(USER_SCOPES));
    assert.ok(USER_SCOPES.length >= 10);
    for (const s of USER_SCOPES) {
      assert.equal(typeof s, "string");
      assert.ok(s.length > 0);
      assert.ok(!s.includes(" "), `scope must not contain spaces: ${s}`);
    }
  });

  it("userScopesQueryParam is the space-join of USER_SCOPES", () => {
    const q = userScopesQueryParam();
    assert.equal(q, USER_SCOPES.join(" "));
    assert.ok(!q.includes(","));
    const parts = q.split(" ");
    assert.deepEqual(parts, [...USER_SCOPES]);
  });

  it("buildUserAuthorizeUrl sets scope= from userScopesQueryParam (not user_scope)", () => {
    const url = buildUserAuthorizeUrl({
      clientId: "123.456",
      redirectUri: "http://localhost:3118/callback",
      state: "abc",
      codeChallenge: "challenge",
    });

    assert.equal(url.origin + url.pathname, "https://slack.com/oauth/v2_user/authorize");
    assert.equal(url.searchParams.get("response_type"), "code");
    assert.equal(url.searchParams.get("client_id"), "123.456");
    assert.equal(url.searchParams.get("scope"), userScopesQueryParam());
    assert.equal(url.searchParams.get("user_scope"), null);
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    assert.equal(url.searchParams.get("resource"), "https://mcp.slack.com/");

    const scopeParam = url.searchParams.get("scope") || "";
    for (const s of USER_SCOPES) {
      assert.ok(
        scopeParam.split(" ").includes(s),
        `authorize scope param must include ${s}`,
      );
    }
  });

  it("README Own-app documents every USER_SCOPES entry", () => {
    const readme = fs.readFileSync(path.join(repoRoot, "README.md"), "utf8");
    const missing = USER_SCOPES.filter((s) => !readme.includes(s));
    assert.deepEqual(
      missing,
      [],
      `README is missing documentation for scopes: ${missing.join(", ")}`,
    );
  });
});
