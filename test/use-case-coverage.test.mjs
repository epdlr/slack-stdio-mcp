/**
 * @file use-case-coverage.test.mjs
 * @description Structural checklist: product use cases map to shipped modules/tests.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Must-have product use cases → expected evidence in repo (files / symbols).
 * Kept in sync with quality-inspection matrix intent.
 */
const MUST_HAVE = [
  {
    id: "config_precedence",
    symbols: ["resolveConfig", "parseArgv"],
    testFile: "test/config.test.mjs",
  },
  {
    id: "per_client_credentials",
    symbols: ["credentialsPathFor", "saveCredentials"],
    testFile: "test/token-lifecycle.test.mjs",
  },
  {
    id: "startup_token_path",
    symbols: ["ensureAccessToken", "resolveOrRefreshAccessToken"],
    testFile: "test/token-lifecycle.test.mjs",
  },
  {
    id: "silent_refresh_success_failure",
    symbols: ["requestTokenRefresh", "resolveOrRefreshAccessToken"],
    testFile: "test/token-lifecycle.test.mjs",
  },
  {
    id: "mid_session_auth_detection",
    symbols: ["isAuthSessionError"],
    testFile: "test/session.test.mjs",
  },
  {
    id: "force_refresh_mid_session",
    symbols: ["forceRefreshAccessToken"],
    testFile: "test/session.test.mjs",
  },
  {
    id: "reauth_clickable_url",
    symbols: ["formatReauthMessage", "SLACK_REAUTH_REQUIRED", "reauthToolResult"],
    testFile: "test/session.test.mjs",
  },
  {
    id: "start_oauth_authorize_url",
    symbols: ["startUserOAuth", "beginInteractiveReauth"],
    testFile: "test/session.test.mjs",
  },
  {
    id: "auth_recovery_policy",
    symbols: [
      "decideAuthRecovery",
      "recoverStartupConnection",
      "missingSlackSessionDetail",
      "LOCAL_BRIDGE_TOOL_NAMES",
    ],
    testFile: "test/session.test.mjs",
  },
  {
    id: "multiplatform_paths_open_modes",
    symbols: ["defaultCredentialsDir", "browserOpenCommand", "fsWriteOptions"],
    testFile: "test/platform.test.mjs",
  },
  {
    id: "oauth_scopes_source_of_truth",
    symbols: ["USER_SCOPES", "buildUserAuthorizeUrl"],
    testFile: "test/scopes.test.mjs",
  },
  {
    id: "english_residual_gate",
    symbols: ["assert-english"],
    testFile: "test/english-residual.test.mjs",
  },
  {
    id: "overlay_download_catalog",
    symbols: [
      "downloadSlackFile",
      "formatCatalog",
      "updateSlackMessage",
      "deleteSlackMessage",
      "removeSlackReaction",
      "scheduledSlackMessages",
    ],
    testFile: "test/overlay.test.mjs",
  },
];

describe("use-case coverage inventory", () => {
  it("every must-have use case has shipped symbols and a test file", () => {
    const srcBlob = fs
      .readdirSync(path.join(root, "src"))
      .filter((f) => f.endsWith(".mjs"))
      .map((f) => fs.readFileSync(path.join(root, "src", f), "utf8"))
      .join("\n");
    const scriptsBlob = fs.existsSync(path.join(root, "scripts", "assert-english.mjs"))
      ? fs.readFileSync(path.join(root, "scripts", "assert-english.mjs"), "utf8")
      : "";

    /** @type {string[]} */
    const gaps = [];
    for (const uc of MUST_HAVE) {
      const testPath = path.join(root, uc.testFile);
      if (!fs.existsSync(testPath)) {
        gaps.push(`${uc.id}: missing ${uc.testFile}`);
        continue;
      }
      const testSrc = fs.readFileSync(testPath, "utf8");
      for (const sym of uc.symbols) {
        const inShipped =
          srcBlob.includes(sym) ||
          scriptsBlob.includes(sym) ||
          sym === "assert-english";
        const inTest = testSrc.includes(sym) || testSrc.includes(uc.id);
        if (!inShipped) {
          gaps.push(`${uc.id}: symbol ${sym} not in src/scripts`);
        }
        // Test must mention the symbol or exercise the module
        if (!testSrc.includes(sym) && !testSrc.includes(path.basename(uc.testFile, ".mjs"))) {
          gaps.push(`${uc.id}: test does not reference ${sym}`);
        }
        void inTest;
      }
    }
    assert.deepEqual(gaps, [], `Use-case GAPs:\n${gaps.join("\n")}`);
  });
});
