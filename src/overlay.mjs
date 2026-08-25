/**
 * @file overlay.mjs
 * @description Local tools on top of the hosted Slack MCP catalog.
 *
 * Hosted `slack_read_file` returns text or in-memory base64 (size-capped) and
 * often metadata-only for video. Agents need a path on disk. Catalog lists
 * local vs remote tool names so parity can be checked without opening the repo.
 *
 * Uses the same user Bearer against slack.com/api (files.info + private URL).
 * Fetch is injectable. Never logs tokens or private URLs.
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
