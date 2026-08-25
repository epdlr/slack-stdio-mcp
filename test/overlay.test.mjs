/**
 * @file overlay.test.mjs
 * @description Local overlay: catalog shape, dest-path safety, mocked download.
 */

import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  DEFAULT_MAX_DOWNLOAD_BYTES,
  OverlayError,
  defaultDownloadDir,
  deleteSlackMessage,
  downloadSlackFile,
  formatCatalog,
  isOverlayAuthError,
  removeSlackReaction,
  resolveDownloadDestPath,
  resolveMaxBytes,
  sanitizeDownloadBasename,
  sanitizeEmojiName,
  scheduledSlackMessages,
  slackWebApi,
  updateSlackMessage,
} from "../src/overlay.mjs";

describe("sanitizeDownloadBasename", () => {
  it("strips directories and replaces unsafe chars", () => {
    assert.equal(sanitizeDownloadBasename("../../etc/passwd"), "passwd");
    assert.equal(sanitizeDownloadBasename("clip name.mp4"), "clip_name.mp4");
    assert.equal(sanitizeDownloadBasename("."), "slack-file");
    assert.equal(sanitizeDownloadBasename(""), "slack-file");
  });
});

describe("resolveDownloadDestPath", () => {
  it("stays inside destDir even if the Slack name is hostile", () => {
    const destDir = path.join(os.tmpdir(), "overlay-dest");
    const dest = resolveDownloadDestPath({
      destDir,
      fileId: "F0ABC",
      name: "../../../etc/passwd",
    });
    assert.equal(path.dirname(dest), path.resolve(destDir));
    assert.ok(dest.endsWith("F0ABC-passwd"));
  });

  it("rejects empty file id", () => {
    assert.throws(
      () => resolveDownloadDestPath({ destDir: "/tmp", fileId: "" }),
      OverlayError,
    );
  });
});

describe("formatCatalog / resolveMaxBytes", () => {
  it("sorts local and remote and counts them", () => {
    const out = formatCatalog({
      local: ["slack_stdio_catalog", "slack_stdio_reauth"],
      remote: ["slack_send_message", "slack_read_file"],
    });
    assert.deepEqual(out.local, ["slack_stdio_catalog", "slack_stdio_reauth"]);
    assert.deepEqual(out.remote, ["slack_read_file", "slack_send_message"]);
    assert.equal(out.localCount, 2);
    assert.equal(out.remoteCount, 2);
  });

  it("caps max_bytes at the hard limit", () => {
    assert.equal(resolveMaxBytes(undefined), DEFAULT_MAX_DOWNLOAD_BYTES);
    assert.equal(resolveMaxBytes(100), 100);
    assert.equal(resolveMaxBytes(DEFAULT_MAX_DOWNLOAD_BYTES * 4), DEFAULT_MAX_DOWNLOAD_BYTES);
    assert.equal(resolveMaxBytes(-1), DEFAULT_MAX_DOWNLOAD_BYTES);
  });

  it("defaultDownloadDir is under the OS temp dir", () => {
    const dir = defaultDownloadDir();
    assert.equal(path.dirname(dir), os.tmpdir());
    assert.ok(dir.includes("slack-stdio-mcp-downloads"));
  });
});

describe("downloadSlackFile (mocked fetch)", () => {
  const destDir = path.join(os.tmpdir(), "overlay-dl-test");
  const body = Buffer.from("hello-bytes");

  /**
   * @param {{
   *   info?: Record<string, unknown>,
   *   infoHttp?: number,
   *   downloadHttp?: number,
   *   downloadType?: string,
   *   downloadBody?: Buffer,
   * }} [cfg]
   * @returns {import("../src/overlay.mjs").FetchFn}
   */
  function mockFetch(cfg = {}) {
    return async (url) => {
      const u = String(url);
      if (u.includes("files.info")) {
        const info = cfg.info ?? {
          ok: true,
          file: {
            id: "F0TEST",
            name: "clip.mp4",
            mimetype: "video/mp4",
            size: body.length,
            url_private_download: "https://files.slack.com/files-pri/T-F/download/clip.mp4",
          },
        };
        return {
          ok: (cfg.infoHttp ?? 200) < 400,
          status: cfg.infoHttp ?? 200,
          json: async () => info,
        };
      }
      const downloadBody = cfg.downloadBody ?? body;
      return {
        ok: (cfg.downloadHttp ?? 200) < 400,
        status: cfg.downloadHttp ?? 200,
        headers: {
          get: (name) => {
            if (name === "content-type") {
              return cfg.downloadType ?? "video/mp4";
            }
            if (name === "content-length") {
              return String(downloadBody.length);
            }
            return null;
          },
        },
        arrayBuffer: async () => downloadBody.buffer.slice(
          downloadBody.byteOffset,
          downloadBody.byteOffset + downloadBody.byteLength,
        ),
      };
    };
  }

  it("writes the file and returns metadata", async () => {
    /** @type {{ path?: string, buf?: Buffer }} */
    const written = {};
    const result = await downloadSlackFile({
      token: "xoxe-test",
      fileId: "F0TEST",
      destDir,
      fetchFn: mockFetch(),
      mkdir: () => {},
      writeFile: (p, buf) => {
        written.path = String(p);
        written.buf = Buffer.from(buf);
      },
    });
    assert.equal(result.file_id, "F0TEST");
    assert.equal(result.name, "clip.mp4");
    assert.equal(result.mime_type, "video/mp4");
    assert.equal(result.bytes, body.length);
    assert.equal(written.path, result.path);
    assert.equal(written.buf?.toString(), "hello-bytes");
    assert.equal(path.dirname(result.path), path.resolve(destDir));
  });

  it("rejects oversized files.info.size before fetching bytes", async () => {
    await assert.rejects(
      () =>
        downloadSlackFile({
          token: "xoxe-test",
          fileId: "F0TEST",
          destDir,
          maxBytes: 4,
          fetchFn: mockFetch({
            info: {
              ok: true,
              file: {
                id: "F0TEST",
                name: "big.bin",
                size: 99,
                url_private_download: "https://files.slack.com/files-pri/T-F/download/big.bin",
              },
            },
          }),
          mkdir: () => {
            throw new Error("must not mkdir");
          },
          writeFile: () => {
            throw new Error("must not write");
          },
        }),
      (err) => err instanceof OverlayError && err.code === "file_too_large",
    );
  });

  it("maps Slack invalid_auth for session recovery", async () => {
    await assert.rejects(
      () =>
        downloadSlackFile({
          token: "xoxe-dead",
          fileId: "F0TEST",
          destDir,
          fetchFn: mockFetch({ info: { ok: false, error: "invalid_auth" } }),
        }),
      (err) => isOverlayAuthError(err) && err instanceof OverlayError,
    );
  });

  it("rejects HTML login pages instead of treating them as the file", async () => {
    await assert.rejects(
      () =>
        downloadSlackFile({
          token: "xoxe-test",
          fileId: "F0TEST",
          destDir,
          fetchFn: mockFetch({ downloadType: "text/html; charset=utf-8" }),
          mkdir: () => {},
          writeFile: () => {
            throw new Error("must not write HTML");
          },
        }),
      (err) => err instanceof OverlayError && err.code === "download_failed",
    );
  });

  it("rejects files.info without a private URL", async () => {
    await assert.rejects(
      () =>
        downloadSlackFile({
          token: "xoxe-test",
          fileId: "F0TEST",
          destDir,
          fetchFn: mockFetch({
            info: { ok: true, file: { id: "F0TEST", name: "x", size: 1 } },
          }),
        }),
      (err) => err instanceof OverlayError && err.code === "file_not_downloadable",
    );
  });
});

describe("message / reaction / scheduled overlay", () => {
  it("strips colons from emoji names", () => {
    assert.equal(sanitizeEmojiName(":thumbsup:"), "thumbsup");
    assert.throws(() => sanitizeEmojiName("  "), OverlayError);
  });

  /**
   * @param {string} expectedMethod
   * @param {Record<string, unknown>} payload
   */
  function jsonOk(expectedMethod, payload) {
    return async (url, init) => {
      assert.ok(String(url).endsWith(`/api/${expectedMethod}`));
      const body = JSON.parse(String(init?.body || "{}"));
      return {
        ok: true,
        status: 200,
        json: async () => payload,
        _body: body,
      };
    };
  }

  it("updateSlackMessage posts chat.update", async () => {
    /** @type {Record<string, unknown> | undefined} */
    let sent;
    const fetchFn = async (url, init) => {
      sent = JSON.parse(String(init?.body || "{}"));
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, channel: "D1", ts: "1.2", text: "edited" }),
      };
    };
    const out = await updateSlackMessage({
      token: "xoxe-test",
      channelId: "D1",
      messageTs: "1.2",
      message: "edited",
      fetchFn,
    });
    assert.deepEqual(sent, { channel: "D1", ts: "1.2", text: "edited" });
    assert.equal(out.text, "edited");
  });

  it("deleteSlackMessage posts chat.delete", async () => {
    const out = await deleteSlackMessage({
      token: "xoxe-test",
      channelId: "D1",
      messageTs: "1.2",
      fetchFn: jsonOk("chat.delete", { ok: true }),
    });
    assert.deepEqual(out, { channel: "D1", ts: "1.2" });
  });

  it("removeSlackReaction posts reactions.remove", async () => {
    const out = await removeSlackReaction({
      token: "xoxe-test",
      channelId: "D1",
      messageTs: "1.2",
      emoji: ":eyes:",
      fetchFn: jsonOk("reactions.remove", { ok: true }),
    });
    assert.equal(out.emoji, "eyes");
  });

  it("scheduled list/cancel map Slack payloads", async () => {
    const listed = await scheduledSlackMessages({
      token: "xoxe-test",
      action: "list",
      channelId: "D1",
      fetchFn: jsonOk("chat.scheduledMessages.list", {
        ok: true,
        scheduled_messages: [{ id: "Q1", channel_id: "D1", post_at: 99, text: "later" }],
      }),
    });
    assert.equal(listed.count, 1);
    const cancelled = await scheduledSlackMessages({
      token: "xoxe-test",
      action: "cancel",
      channelId: "D1",
      scheduledMessageId: "Q1",
      fetchFn: jsonOk("chat.deleteScheduledMessage", { ok: true }),
    });
    assert.equal(cancelled.cancelled, true);
  });

  it("slackWebApi maps missing_scope", async () => {
    await assert.rejects(
      () =>
        slackWebApi({
          token: "xoxe-test",
          method: "pins.list",
          fetchFn: async () => ({
            ok: true,
            status: 200,
            json: async () => ({ ok: false, error: "missing_scope" }),
          }),
        }),
      (err) => err instanceof OverlayError && err.code === "missing_scope",
    );
  });
});
