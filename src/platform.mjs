/**
 * @file platform.mjs
 * @description Cross-platform helpers (Windows / macOS / Linux) with no native dependencies.
 *
 * - Default credentials dir per OS conventions
 * - Command to open the OAuth browser (avoids the Windows `start` pitfall)
 * - Safe file-mode options on Windows
 */

import os from "node:os";
import path from "node:path";

/**
 * @typedef {"win32" | "darwin" | "linux" | string} PlatformId
 */

/**
 * @typedef {{
 *   command: string,
 *   args: string[],
 *   shell?: boolean,
 *   windowsVerbatimArguments?: boolean,
 * }} BrowserOpenSpec
 */

/**
 * Escape an argument for `cmd.exe` (double quotes; internal `"` are doubled).
 * Required for OAuth URLs with `&`, `=`, spaces, etc.
 *
 * @param {string} value
 * @returns {string} value wrapped in `"..."`
 */
export function quoteForWindowsCmd(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

/**
 * Is the arg already quoted and does it hold the payload without cmd splitting?
 *
 * @param {string} arg  e.g. result of quoteForWindowsCmd(url)
 * @param {string} rawUrl
 * @returns {boolean}
 */
export function isWindowsCmdQuotedUrlArg(arg, rawUrl) {
  if (typeof arg !== "string" || typeof rawUrl !== "string") {
    return false;
  }
  if (!(arg.startsWith('"') && arg.endsWith('"') && arg.length >= 2)) {
    return false;
  }
  // Inside the quotes must be the full URL (including query `&`).
  const inner = arg.slice(1, -1).replace(/""/g, '"');
  return inner === rawUrl;
}

/**
 * Default credentials directory for the OS.
 *
 * - Windows: `%APPDATA%/slack-stdio-mcp` (fallback `%LOCALAPPDATA%`, then `homedir/AppData/Roaming`)
 * - macOS / Linux / other Unix-like: `~/.config/slack-stdio-mcp` (XDG-style)
 *
 * Does not read `SLACK_STDIO_CREDS_DIR` (that is applied by `getCredentialsDir`).
 *
 * @param {{
 *   platform?: PlatformId,
 *   env?: NodeJS.ProcessEnv | Record<string, string | undefined>,
 *   homedir?: string,
 * }} [opts]
 * @returns {string}
 */
export function defaultCredentialsDir(opts = {}) {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const home = opts.homedir ?? os.homedir();

  if (platform === "win32") {
    const appData = env.APPDATA?.trim();
    if (appData) {
      return path.join(appData, "slack-stdio-mcp");
    }
    const local = env.LOCALAPPDATA?.trim();
    if (local) {
      return path.join(local, "slack-stdio-mcp");
    }
    return path.join(home, "AppData", "Roaming", "slack-stdio-mcp");
  }

  // darwin, linux, freebsd, … — XDG-ish under home
  const xdg = env.XDG_CONFIG_HOME?.trim();
  if (xdg) {
    return path.join(xdg, "slack-stdio-mcp");
  }
  return path.join(home, ".config", "slack-stdio-mcp");
}

/**
 * Build command + args (+ execFile options) to open a URL in the browser.
 *
 * Windows: `cmd /c start "" "<url>"`
 * - Empty title `""` prevents `start` from treating the URL as the window title.
 * - Quoted URL so query `&` does not split commands in cmd.exe.
 * - `windowsVerbatimArguments: true` so Node does not re-escape the quotes.
 *
 * @param {string} url
 * @param {{ platform?: PlatformId }} [opts]
 * @returns {BrowserOpenSpec}
 */
export function browserOpenCommand(url, opts = {}) {
  if (!url || typeof url !== "string") {
    throw new Error("browserOpenCommand: url required");
  }
  const platform = opts.platform ?? process.platform;

  if (platform === "win32") {
    return {
      command: "cmd",
      args: ["/c", "start", "\"\"", quoteForWindowsCmd(url)],
      shell: false,
      windowsVerbatimArguments: true,
    };
  }

  if (platform === "darwin") {
    return { command: "open", args: [url] };
  }

  // linux and other unix-like
  return { command: "xdg-open", args: [url] };
}

/**
 * `execFile` options derived from the spec (Windows verbatim, etc.).
 *
 * @param {BrowserOpenSpec} spec
 * @returns {import("node:child_process").ExecFileOptions}
 */
export function browserOpenExecFileOptions(spec) {
  /** @type {import("node:child_process").ExecFileOptions} */
  const options = {};
  if (spec.shell === true) {
    options.shell = true;
  }
  if (spec.windowsVerbatimArguments === true) {
    options.windowsVerbatimArguments = true;
  }
  return options;
}

/**
 * Does the current OS apply Unix modes (0o600/0o700) meaningfully?
 *
 * @param {PlatformId} [platform]
 * @returns {boolean}
 */
export function supportsUnixFileModes(platform = process.platform) {
  return platform !== "win32";
}

/**
 * Options for `fs.mkdirSync` / `fs.writeFileSync` with mode only on Unix.
 * On Windows they are omitted to avoid relying on permission emulation.
 *
 * @param {number} mode
 * @param {{ platform?: PlatformId, encoding?: BufferEncoding }} [opts]
 * @returns {import("node:fs").WriteFileOptions & { recursive?: boolean, mode?: number }}
 */
export function fsWriteOptions(mode, opts = {}) {
  const platform = opts.platform ?? process.platform;
  /** @type {import("node:fs").WriteFileOptions & { recursive?: boolean, mode?: number }} */
  const out = {};
  if (opts.encoding) {
    out.encoding = opts.encoding;
  }
  if (supportsUnixFileModes(platform)) {
    out.mode = mode;
  }
  return out;
}

/**
 * Options for `fs.mkdirSync(..., { recursive: true, mode? })`.
 *
 * @param {number} mode
 * @param {{ platform?: PlatformId }} [opts]
 * @returns {{ recursive: true, mode?: number }}
 */
export function fsMkdirOptions(mode, opts = {}) {
  const platform = opts.platform ?? process.platform;
  if (supportsUnixFileModes(platform)) {
    return { recursive: true, mode };
  }
  return { recursive: true };
}
