/**
 * @file platform.test.mjs
 * @description Cross-platform: per-OS creds dir, browser open argv, write modes.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  browserOpenCommand,
  browserOpenExecFileOptions,
  defaultCredentialsDir,
  fsMkdirOptions,
  fsWriteOptions,
  isWindowsCmdQuotedUrlArg,
  quoteForWindowsCmd,
  supportsUnixFileModes,
} from "../src/platform.mjs";
import {
  credentialsPathFor,
  getCredentialsDir,
  saveCredentials,
} from "../src/token.mjs";

describe("defaultCredentialsDir (shipped)", () => {
  it("win32 uses APPDATA, does not force .config under home", () => {
    const dir = defaultCredentialsDir({
      platform: "win32",
      env: { APPDATA: "C:\\Users\\Ada\\AppData\\Roaming" },
      homedir: "C:\\Users\\Ada",
    });
    assert.ok(dir.includes("AppData") || dir.includes("Roaming") || dir.includes("slack-stdio-mcp"));
    assert.equal(
      dir,
      path.join("C:\\Users\\Ada\\AppData\\Roaming", "slack-stdio-mcp"),
    );
    assert.ok(!dir.includes(`${path.sep}.config${path.sep}`));
  });

  it("win32 without APPDATA falls back to AppData/Roaming under home", () => {
    const dir = defaultCredentialsDir({
      platform: "win32",
      env: {},
      homedir: "C:\\Users\\Bob",
    });
    assert.equal(dir, path.join("C:\\Users\\Bob", "AppData", "Roaming", "slack-stdio-mcp"));
  });

  it("darwin/linux use ~/.config or XDG_CONFIG_HOME", () => {
    const darwin = defaultCredentialsDir({
      platform: "darwin",
      env: {},
      homedir: "/Users/ada",
    });
    assert.equal(darwin, path.join("/Users/ada", ".config", "slack-stdio-mcp"));

    const xdg = defaultCredentialsDir({
      platform: "linux",
      env: { XDG_CONFIG_HOME: "/custom/cfg" },
      homedir: "/home/ada",
    });
    assert.equal(xdg, path.join("/custom/cfg", "slack-stdio-mcp"));
  });
});

describe("getCredentialsDir / credentialsPathFor", () => {
  /** @type {string | undefined} */
  let prev;

  beforeEach(() => {
    prev = process.env.SLACK_STDIO_CREDS_DIR;
  });
  afterEach(() => {
    if (prev === undefined) {
      delete process.env.SLACK_STDIO_CREDS_DIR;
    } else {
      process.env.SLACK_STDIO_CREDS_DIR = prev;
    }
  });

  it("env override wins and path uses path.join (path.sep)", () => {
    const base = path.join(os.tmpdir(), "slack-creds-override-test");
    process.env.SLACK_STDIO_CREDS_DIR = base;
    const dir = getCredentialsDir();
    assert.equal(dir, base);
    const file = credentialsPathFor("1.2.3");
    assert.equal(file, path.join(base, "by-client", "1.2.3.json"));
    assert.ok(file.includes(path.sep));
    assert.equal(path.basename(path.dirname(file)), "by-client");
  });

  it("without override, simulated win32 default is not only home/.config", () => {
    delete process.env.SLACK_STDIO_CREDS_DIR;
    const dir = getCredentialsDir({
      platform: "win32",
      env: { APPDATA: "D:\\AppData" },
      homedir: "D:\\Users\\x",
    });
    assert.equal(dir, path.join("D:\\AppData", "slack-stdio-mcp"));
  });
});

describe("browserOpenCommand (shipped)", () => {
  const url =
    "https://slack.com/oauth/v2_user/authorize?client_id=1.2&scope=a%20b&state=xyz&code_challenge=abc";

  it("darwin → open <url>", () => {
    const s = browserOpenCommand(url, { platform: "darwin" });
    assert.equal(s.command, "open");
    assert.deepEqual(s.args, [url]);
  });

  it("linux → xdg-open <url>", () => {
    const s = browserOpenCommand(url, { platform: "linux" });
    assert.equal(s.command, "xdg-open");
    assert.deepEqual(s.args, [url]);
  });

  it("win32 → start with empty title + quoted URL (cmd-safe for &)", () => {
    assert.ok(url.includes("&"), "fixture must include query &");
    const s = browserOpenCommand(url, { platform: "win32" });
    assert.equal(s.command, "cmd");
    assert.equal(s.args[0], "/c");
    assert.equal(s.args[1], "start");
    // Title slot: empty quoted title, not the URL
    assert.equal(s.args[2], '""');
    assert.notEqual(s.args[2], url);
    const urlArg = s.args[3];
    assert.equal(urlArg, quoteForWindowsCmd(url));
    assert.ok(
      isWindowsCmdQuotedUrlArg(urlArg, url),
      "URL must be quoted with & intact inside",
    );
    assert.ok(urlArg.startsWith('"') && urlArg.endsWith('"'));
    assert.ok(urlArg.includes("&"));
    assert.ok(urlArg.includes(url));
    // Unquoted form would expose & to cmd as separator — must not be bare url
    assert.notEqual(urlArg, url);
    assert.equal(s.windowsVerbatimArguments, true);
    const execOpts = browserOpenExecFileOptions(s);
    assert.equal(execOpts.windowsVerbatimArguments, true);
  });

  it("quoteForWindowsCmd doubles internal quotes", () => {
    assert.equal(quoteForWindowsCmd('a"b'), '"a""b"');
  });
});

describe("file modes + saveCredentials cross-platform", () => {
  it("fsWriteOptions omits mode on win32", () => {
    const w = fsWriteOptions(0o600, { platform: "win32", encoding: "utf8" });
    assert.equal(w.mode, undefined);
    assert.equal(w.encoding, "utf8");
    const u = fsWriteOptions(0o600, { platform: "linux", encoding: "utf8" });
    assert.equal(u.mode, 0o600);
    assert.equal(supportsUnixFileModes("win32"), false);
    assert.equal(supportsUnixFileModes("darwin"), true);
    assert.deepEqual(fsMkdirOptions(0o700, { platform: "win32" }), { recursive: true });
    assert.equal(fsMkdirOptions(0o700, { platform: "darwin" }).mode, 0o700);
  });

  it("saveCredentials writes readable JSON in a temp dir (any OS)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "slack-save-"));
    const prev = process.env.SLACK_STDIO_CREDS_DIR;
    process.env.SLACK_STDIO_CREDS_DIR = tmp;
    try {
      const written = saveCredentials(
        {
          access_token: "xoxp-fixture-token",
          refresh_token: "r",
          obtained_at: new Date().toISOString(),
        },
        "app.cross.platform",
      );
      assert.ok(fs.existsSync(written));
      const raw = fs.readFileSync(written, "utf8");
      const data = JSON.parse(raw);
      assert.equal(data.access_token, "xoxp-fixture-token");
      assert.equal(data.client_id, "app.cross.platform");
      console.error("saveCredentials path=", written);
    } finally {
      if (prev === undefined) {
        delete process.env.SLACK_STDIO_CREDS_DIR;
      } else {
        process.env.SLACK_STDIO_CREDS_DIR = prev;
      }
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
