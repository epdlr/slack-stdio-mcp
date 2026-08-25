/**
 * @file overlay.mjs
 * @description Local tools on top of the hosted Slack MCP catalog.
 *
 * Hosted `slack_read_file` returns text or in-memory base64 (size-capped) and
 * often metadata-only for video. Agents need a path on disk. Catalog lists
 * local vs remote tool names so parity can be checked without opening the repo.
 *
 * Uses the same user Bearer against slack.com/api (files.info + chat / reactions
 * methods the hosted catalog omits). Fetch is injectable. Never logs tokens or
 * private URLs.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fsMkdirOptions, fsWriteOptions } from "./platform.mjs";

/** @typedef {typeof fetch} FetchFn */

/** Hard cap: agents cannot raise this via `max_bytes`. */
export const DEFAULT_MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024;

export const SLACK_FILES_INFO_URL = "https://slack.com/api/files.info";

/**
 * Error from the overlay (Slack API or local validation).
 * `code` is the Slack error string when present (`invalid_auth`, `file_not_found`).
 */
export class OverlayError extends Error {
  /**
   * @param {string} message
   * @param {{ code?: string, httpStatus?: number }} [extra]
   */
  constructor(message, extra = {}) {
    super(message);
    this.name = "OverlayError";
    this.code = extra.code;
    this.httpStatus = extra.httpStatus;
  }
}

/**
 * Default dest dir (OS temp). Created on first download.
 * @returns {string}
 */
export function defaultDownloadDir() {
  return path.join(os.tmpdir(), "slack-stdio-mcp-downloads");
}

/**
 * Single path segment from a Slack file name. Rejects traversal.
 *
 * @param {unknown} name
 * @returns {string}
 */
export function sanitizeDownloadBasename(name) {
  const raw = String(name ?? "").trim() || "slack-file";
  const base = path.basename(raw);
  const safe = base.replace(/[^a-zA-Z0-9._-]/g, "_");
  if (!safe || safe === "." || safe === "..") {
    return "slack-file";
  }
  return safe.slice(0, 180);
}

/**
 * Resolve dest path inside `destDir`. Filename is `{fileId}-{safeName}`.
 *
 * @param {{ destDir: string, fileId: string, name?: unknown }} opts
 * @returns {string}
 */
export function resolveDownloadDestPath(opts) {
  const destDir = path.resolve(opts.destDir);
  const fileId = String(opts.fileId ?? "").replace(/[^a-zA-Z0-9._-]/g, "_");
  if (!fileId) {
    throw new OverlayError("download: file_id required", { code: "invalid_arguments" });
  }
  const dest = path.join(destDir, `${fileId}-${sanitizeDownloadBasename(opts.name)}`);
  const rel = path.relative(destDir, dest);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new OverlayError("download: dest path escaped dest_dir", { code: "invalid_arguments" });
  }
  return dest;
}

/**
 * @param {{ local: string[], remote: string[] }} opts
 * @returns {{ local: string[], remote: string[], localCount: number, remoteCount: number }}
 */
export function formatCatalog(opts) {
  const local = [...(opts.local ?? [])].filter((n) => typeof n === "string").sort();
  const remote = [...(opts.remote ?? [])].filter((n) => typeof n === "string").sort();
  return {
    local,
    remote,
    localCount: local.length,
    remoteCount: remote.length,
  };
}

/**
 * Effective byte cap: caller may lower, never raise above the hard cap.
 *
 * @param {unknown} requested
 * @param {number} [hardCap]
 * @returns {number}
 */
export function resolveMaxBytes(requested, hardCap = DEFAULT_MAX_DOWNLOAD_BYTES) {
  const n = Number(requested);
  if (!Number.isFinite(n) || n <= 0) {
    return hardCap;
  }
  return Math.min(Math.floor(n), hardCap);
}

/**
 * @param {unknown} slackError
 * @returns {boolean}
 */
/**
 * Call slack.com/api/{method}. Injectable fetch. Never puts the token in errors.
 *
 * @param {{
 *   token: string,
 *   method: string,
 *   params?: Record<string, unknown>,
 *   http?: "GET" | "POST",
 *   fetchFn?: FetchFn,
 * }} opts
 * @returns {Promise<Record<string, unknown>>}
 */
export async function slackWebApi(opts) {
  const token = opts.token?.trim();
  const method = opts.method?.trim();
  if (!token) {
    throw new OverlayError("api: token required", { code: "invalid_auth" });
  }
  if (!method || !/^[a-z0-9]+(?:\.[a-z0-9]+)+$/i.test(method)) {
    throw new OverlayError("api: method required", { code: "invalid_arguments" });
  }
  const fetchFn = opts.fetchFn ?? globalThis.fetch;
  if (typeof fetchFn !== "function") {
    throw new OverlayError("api: fetch is not available", { code: "internal_error" });
  }

  const http = opts.http ?? "POST";
  const params = opts.params ?? {};
  let url = `https://slack.com/api/${method}`;
  /** @type {RequestInit} */
  const init = {
    method: http,
    headers: { Authorization: `Bearer ${token}` },
  };
  if (http === "GET") {
    const parsed = new URL(url);
    for (const [key, value] of Object.entries(params)) {
      if (value == null || value === "") {
        continue;
      }
      parsed.searchParams.set(key, String(value));
    }
    url = parsed.toString();
  } else {
    /** @type {Record<string, string>} */ (init.headers)["Content-Type"] =
      "application/json; charset=utf-8";
    init.body = JSON.stringify(params);
  }

  const res = await fetchFn(url, init);
  /** @type {Record<string, unknown>} */
  let data;
  try {
    data = /** @type {Record<string, unknown>} */ (await res.json());
  } catch {
    throw new OverlayError(`${method}: non-JSON (HTTP ${res.status})`, {
      httpStatus: res.status,
    });
  }
  if (!res.ok || data.ok === false) {
    const code = String(data.error || res.status || "unknown");
    throw new OverlayError(`${method}: ${code}`, { code, httpStatus: res.status });
  }
  return data;
}

/**
 * @param {unknown} value
 * @param {string} field
 * @returns {string}
 */
function requireId(value, field) {
  const id = String(value ?? "").trim();
  if (!id) {
    throw new OverlayError(`${field} is required`, { code: "invalid_arguments" });
  }
  return id;
}

/**
 * Emoji name without colons.
 * @param {unknown} emoji
 * @returns {string}
 */
export function sanitizeEmojiName(emoji) {
  const name = String(emoji ?? "").trim().replace(/^:+|:+$/g, "");
  if (!name) {
    throw new OverlayError("emoji is required", { code: "invalid_arguments" });
  }
  return name;
}

/**
 * @param {{ token: string, channelId: string, messageTs: string, message: string, fetchFn?: FetchFn }} opts
 * @returns {Promise<{ channel: string, ts: string, text: string }>}
 */
export async function updateSlackMessage(opts) {
  const text = String(opts.message ?? "");
  if (!text.trim()) {
    throw new OverlayError("message is required", { code: "invalid_arguments" });
  }
  const data = await slackWebApi({
    token: opts.token,
    method: "chat.update",
    fetchFn: opts.fetchFn,
    params: {
      channel: requireId(opts.channelId, "channel_id"),
      ts: requireId(opts.messageTs, "message_ts"),
      text,
    },
  });
  return {
    channel: String(data.channel || opts.channelId),
    ts: String(data.ts || opts.messageTs),
    text: String(data.text || text),
  };
}

/**
 * @param {{ token: string, channelId: string, messageTs: string, fetchFn?: FetchFn }} opts
 * @returns {Promise<{ channel: string, ts: string }>}
 */
export async function deleteSlackMessage(opts) {
  const channel = requireId(opts.channelId, "channel_id");
  const ts = requireId(opts.messageTs, "message_ts");
  await slackWebApi({
    token: opts.token,
    method: "chat.delete",
    fetchFn: opts.fetchFn,
    params: { channel, ts },
  });
  return { channel, ts };
}

/**
 * @param {{ token: string, channelId: string, messageTs: string, emoji: string, fetchFn?: FetchFn }} opts
 * @returns {Promise<{ channel: string, ts: string, emoji: string }>}
 */
export async function removeSlackReaction(opts) {
  const channel = requireId(opts.channelId, "channel_id");
  const ts = requireId(opts.messageTs, "message_ts");
  const emoji = sanitizeEmojiName(opts.emoji);
  await slackWebApi({
    token: opts.token,
    method: "reactions.remove",
    fetchFn: opts.fetchFn,
    params: { channel, timestamp: ts, name: emoji },
  });
  return { channel, ts, emoji };
}

/**
 * @param {{
 *   token: string,
 *   action: string,
 *   channelId?: string,
 *   scheduledMessageId?: string,
 *   fetchFn?: FetchFn,
 * }} opts
 * @returns {Promise<Record<string, unknown>>}
 */
export async function scheduledSlackMessages(opts) {
  const action = String(opts.action ?? "").trim().toLowerCase();
  if (action === "list") {
    /** @type {Record<string, unknown>} */
    const params = {};
    const channel = String(opts.channelId ?? "").trim();
    if (channel) {
      params.channel = channel;
    }
    const data = await slackWebApi({
      token: opts.token,
      method: "chat.scheduledMessages.list",
      fetchFn: opts.fetchFn,
      params,
    });
    const raw = Array.isArray(data.scheduled_messages) ? data.scheduled_messages : [];
    const scheduled_messages = raw.map((item) => {
      const row = /** @type {Record<string, unknown>} */ (item || {});
      return {
        id: String(row.id || ""),
        channel: String(row.channel_id || row.channel || ""),
        post_at: Number(row.post_at) || 0,
        text: String(row.text || ""),
      };
    });
    return { scheduled_messages, count: scheduled_messages.length };
  }
  if (action === "cancel") {
    const channel = requireId(opts.channelId, "channel_id");
    const id = requireId(opts.scheduledMessageId, "scheduled_message_id");
    await slackWebApi({
      token: opts.token,
      method: "chat.deleteScheduledMessage",
      fetchFn: opts.fetchFn,
      params: { channel, scheduled_message_id: id },
    });
    return { cancelled: true, channel, scheduled_message_id: id };
  }
  throw new OverlayError("action must be list or cancel", { code: "invalid_arguments" });
}

export function isOverlayAuthError(slackError) {
  const code = slackError instanceof OverlayError ? slackError.code : "";
  const text = `${code} ${slackError instanceof Error ? slackError.message : ""}`.toLowerCase();
  return (
    text.includes("invalid_auth") ||
    text.includes("token_expired") ||
    text.includes("not_authed") ||
    text.includes("token_revoked") ||
    text.includes("invalid_token")
  );
}

/**
 * GET slack.com/api/files.info
 *
 * @param {{
 *   token: string,
 *   fileId: string,
 *   fetchFn?: FetchFn,
 * }} opts
 * @returns {Promise<Record<string, unknown>>}
 */
export async function fetchSlackFileInfo(opts) {
  const token = opts.token?.trim();
  const fileId = opts.fileId?.trim();
  if (!token) {
    throw new OverlayError("download: token required", { code: "invalid_auth" });
  }
  if (!fileId) {
    throw new OverlayError("download: file_id required", { code: "invalid_arguments" });
  }
  const fetchFn = opts.fetchFn ?? globalThis.fetch;
  if (typeof fetchFn !== "function") {
    throw new OverlayError("download: fetch is not available", { code: "internal_error" });
  }

  const url = new URL(SLACK_FILES_INFO_URL);
  url.searchParams.set("file", fileId);
  const res = await fetchFn(url.toString(), {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
  });

  /** @type {Record<string, unknown>} */
  let data;
  try {
    data = /** @type {Record<string, unknown>} */ (await res.json());
  } catch {
    throw new OverlayError(`files.info: non-JSON (HTTP ${res.status})`, {
      httpStatus: res.status,
    });
  }

  if (!res.ok || data.ok === false) {
    const code = String(data.error || res.status || "unknown");
    throw new OverlayError(`files.info: ${code}`, { code, httpStatus: res.status });
  }

  const file = data.file;
  if (!file || typeof file !== "object") {
    throw new OverlayError("files.info: missing file", { code: "file_not_found" });
  }
  return /** @type {Record<string, unknown>} */ (file);
}

/**
 * Download a Slack file to disk. Returns metadata + absolute path.
 *
 * @param {{
 *   token: string,
 *   fileId: string,
 *   destDir?: string,
 *   maxBytes?: number,
 *   fetchFn?: FetchFn,
 *   writeFile?: typeof fs.writeFileSync,
 *   mkdir?: typeof fs.mkdirSync,
 * }} opts
 * @returns {Promise<{
 *   path: string,
 *   file_id: string,
 *   name: string,
 *   mime_type: string,
 *   bytes: number,
 * }>}
 */
export async function downloadSlackFile(opts) {
  const fileId = opts.fileId?.trim();
  const destDir = path.resolve(opts.destDir?.trim() || defaultDownloadDir());
  const maxBytes = resolveMaxBytes(opts.maxBytes);
  const fetchFn = opts.fetchFn ?? globalThis.fetch;
  const writeFile = opts.writeFile ?? fs.writeFileSync;
  const mkdir = opts.mkdir ?? fs.mkdirSync;

  const file = await fetchSlackFileInfo({
    token: opts.token,
    fileId,
    fetchFn,
  });

  const size = Number(file.size);
  if (Number.isFinite(size) && size > maxBytes) {
    throw new OverlayError(
      `download: file is ${size} bytes; max is ${maxBytes}`,
      { code: "file_too_large" },
    );
  }

  const downloadUrl = String(file.url_private_download || file.url_private || "").trim();
  if (!downloadUrl.startsWith("https://")) {
    throw new OverlayError("download: file has no private https URL", {
      code: "file_not_downloadable",
    });
  }

  const destPath = resolveDownloadDestPath({
    destDir,
    fileId,
    name: file.name,
  });

  const res = await fetchFn(downloadUrl, {
    method: "GET",
    headers: { Authorization: `Bearer ${opts.token.trim()}` },
    redirect: "follow",
  });

  if (!res.ok) {
    throw new OverlayError(`download: HTTP ${res.status}`, {
      code: res.status === 401 ? "invalid_auth" : "download_failed",
      httpStatus: res.status,
    });
  }

  const contentType = String(res.headers.get("content-type") || "");
  if (contentType.includes("text/html")) {
    throw new OverlayError("download: got HTML instead of file bytes", {
      code: "download_failed",
    });
  }

  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new OverlayError(
      `download: content-length ${declared} exceeds max ${maxBytes}`,
      { code: "file_too_large" },
    );
  }

  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > maxBytes) {
    throw new OverlayError(
      `download: body is ${buf.length} bytes; max is ${maxBytes}`,
      { code: "file_too_large" },
    );
  }

  mkdir(destDir, fsMkdirOptions(0o700));
  writeFile(destPath, buf, fsWriteOptions(0o600));

  return {
    path: destPath,
    file_id: String(file.id || fileId),
    name: String(file.name || sanitizeDownloadBasename(file.name)),
    mime_type: String(file.mimetype || contentType.split(";")[0] || "application/octet-stream"),
    bytes: buf.length,
  };
}
