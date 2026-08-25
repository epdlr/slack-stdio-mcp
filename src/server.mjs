#!/usr/bin/env node
/**
 * @file server.mjs
 * @description MCP stdio bridge entry: config → token → proxy ↔ mcp.slack.com.
 *
 * Does not implement Slack tools; proxies the hosted catalog over Streamable HTTP
 * with a user Bearer. Mid-session auth: force-refresh, then interactive re-auth
 * (`SLACK_REAUTH_REQUIRED` + authorize URL). Local tools:
 * `slack_stdio_reauth`, `slack_stdio_session_status`,
 * `slack_stdio_download_file`, `slack_stdio_catalog`, plus message
 * update/delete, reaction remove, and scheduled list/cancel.
 *
 * Config: CLI flags > env > defaults (`config.mjs`).
 * **stdout** = MCP JSON-RPC only; **stderr** = operator logs.
 */

import { createRequire } from "node:module";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { loadRuntimeConfig } from "./config.mjs";
import { ensureAccessToken } from "./ensure-token.mjs";
import { runUserOAuth } from "./oauth-flow.mjs";
import {
  LOCAL_BRIDGE_TOOL_NAMES,
  beginInteractiveReauth,
  decideAuthRecovery,
  forceRefreshAccessToken,
  getPendingReauth,
  isAuthSessionError,
  reauthToolResult,
  takeCompletedReauthToken,
} from "./session.mjs";
import {
  deleteSlackMessage,
  downloadSlackFile,
  formatCatalog,
  isOverlayAuthError,
  removeSlackReaction,
  scheduledSlackMessages,
  updateSlackMessage,
} from "./overlay.mjs";

const require = createRequire(import.meta.url);
/** @type {string} Single source of truth: package.json `version`. */
const VERSION = /** @type {{ version: string }} */ (require("../package.json")).version;
const config = loadRuntimeConfig();

const MCP_URL = config.mcpUrl;
const CLIENT_ID = config.clientId;
const SKIP_OAUTH = config.skipOAuth;

/** @type {string} */
let accessToken = "";
/** @type {Client | null} */
let remote = null;

/**
 * @param {string} token
 * @returns {Promise<void>}
 */
async function connectRemote(token) {
  if (remote) {
    try {
      await remote.close();
    } catch {
      /* ignore */
    }
    remote = null;
  }
  const client = new Client(
    { name: "slack-stdio-bridge", version: VERSION },
    { capabilities: {} },
  );
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
    requestInit: {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
  });
  await client.connect(transport);
  remote = client;
  accessToken = token;
  console.error(`[slack-stdio] Connected to ${MCP_URL}`);
}

/**
 * @returns {Client}
 */
function requireRemote() {
  if (!remote) {
    throw new Error("Remote MCP client is not connected");
  }
  return remote;
}

// --- Phase 1: token (valid disk → refresh → OAuth) ---
try {
  console.error(`[slack-stdio] Resolving token for client_id=${CLIENT_ID}…`);
  accessToken = await ensureAccessToken({
    clientId: CLIENT_ID,
    clientSecret: config.clientSecret,
    skipOAuth: SKIP_OAUTH,
    runOAuth: async ({ clientId, clientSecret }) => {
      console.error(
        `[slack-stdio] No usable token → browser OAuth (PKCE) client_id=${clientId}…`,
      );
      return runUserOAuth({
        clientId,
        clientSecret,
        host: config.oauthHost,
        port: config.oauthPort,
        callbackPath: config.oauthPath,
      });
    },
  });
  console.error(`[slack-stdio] Token ready for client_id=${CLIENT_ID}`);
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  console.error(`[slack-stdio] Auth failed: ${msg}`);
  process.exit(1);
}

// --- Phase 2: remote MCP client ---
try {
  await connectRemote(accessToken);
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  console.error(`[slack-stdio] Connect to ${MCP_URL} failed: ${msg}`);
  console.error("[slack-stdio] Check MCP enable on the app, scopes, and token validity.");
  process.exit(1);
}

try {
  const listed = await requireRemote().listTools();
  const n = listed.tools?.length ?? 0;
  console.error(`[slack-stdio] Remote tools: ${n}`);
  if (n > 0 && listed.tools) {
    console.error(
      `[slack-stdio] Names: ${listed.tools
        .map((t) => t.name)
        .slice(0, 20)
        .join(", ")}${n > 20 ? "…" : ""}`,
    );
  }
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  console.error(`[slack-stdio] remote listTools failed (continuing anyway): ${msg}`);
}

/** Local bridge tools (not from mcp.slack.com). Names: LOCAL_BRIDGE_TOOL_NAMES. */
const LOCAL_TOOLS = [
  {
    name: LOCAL_BRIDGE_TOOL_NAMES[0],
    description:
      "Start Slack re-authorization when the session expired. Opens a browser " +
      "and returns a **clickable authorize URL** for the user. " +
      "Optional argument wait=true blocks until Allow (or timeout). " +
      "After success, retry the previous Slack tool.",
    inputSchema: {
      type: "object",
      properties: {
        wait: {
          type: "boolean",
          description: "If true, wait until the user completes Allow (default false).",
        },
      },
    },
  },
  {
    name: LOCAL_BRIDGE_TOOL_NAMES[1],
    description:
      "Report whether a Slack re-auth flow is in progress and the authorize URL if any.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: LOCAL_BRIDGE_TOOL_NAMES[2],
    description:
      "Download a Slack file to disk by file_id. Hosted slack_read_file often " +
      "returns metadata-only for video or large binaries; this writes the bytes " +
      "to dest_dir (default: OS temp slack-stdio-mcp-downloads) and returns " +
      "path, mime_type, and size. Max 50 MB. Requires files:read.",
    inputSchema: {
      type: "object",
      properties: {
        file_id: {
          type: "string",
          description: "Slack file ID (e.g. F0ABC12345)",
        },
        dest_dir: {
          type: "string",
          description: "Directory to write into (created if missing). Default: OS temp.",
        },
        max_bytes: {
          type: "integer",
          description: "Optional lower size cap in bytes (cannot exceed 50 MB).",
        },
      },
      required: ["file_id"],
    },
  },
  {
    name: LOCAL_BRIDGE_TOOL_NAMES[3],
    description:
      "List local overlay tool names vs the current hosted mcp.slack.com catalog. " +
      "Use to verify the bridge is proxying the full remote set.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: LOCAL_BRIDGE_TOOL_NAMES[4],
    description:
      "Edit a message the user posted (chat.update). Hosted Slack MCP can send " +
      "but not edit. Requires channel_id, message_ts, and the new message text.",
    inputSchema: {
      type: "object",
      properties: {
        channel_id: { type: "string", description: "Channel, DM, or IM id" },
        message_ts: { type: "string", description: "Timestamp of the message to edit" },
        message: { type: "string", description: "Replacement text (Slack mrkdwn)" },
      },
      required: ["channel_id", "message_ts", "message"],
    },
  },
  {
    name: LOCAL_BRIDGE_TOOL_NAMES[5],
    description:
      "Delete a message the user posted (chat.delete). Hosted Slack MCP cannot delete.",
    inputSchema: {
      type: "object",
      properties: {
        channel_id: { type: "string", description: "Channel, DM, or IM id" },
        message_ts: { type: "string", description: "Timestamp of the message to delete" },
      },
      required: ["channel_id", "message_ts"],
    },
  },
  {
    name: LOCAL_BRIDGE_TOOL_NAMES[6],
    description:
      "Remove an emoji reaction the user added (reactions.remove). " +
      "Hosted catalog has add/get only. Emoji name without colons.",
    inputSchema: {
      type: "object",
      properties: {
        channel_id: { type: "string", description: "Channel, DM, or IM id" },
        message_ts: { type: "string", description: "Timestamp of the message" },
        emoji: { type: "string", description: "Reaction name without colons (e.g. thumbsup)" },
      },
      required: ["channel_id", "message_ts", "emoji"],
    },
  },
  {
    name: LOCAL_BRIDGE_TOOL_NAMES[7],
    description:
      "List or cancel scheduled messages (chat.scheduledMessages.list / " +
      "chat.deleteScheduledMessage). Hosted slack_schedule_message cannot cancel. " +
      "action=list (optional channel_id) or action=cancel (channel_id + scheduled_message_id).",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          description: "list or cancel",
          enum: ["list", "cancel"],
        },
        channel_id: { type: "string", description: "Required for cancel; optional filter for list" },
        scheduled_message_id: {
          type: "string",
          description: "Required when action=cancel",
        },
      },
      required: ["action"],
    },
  },
];

/**
 * Reconnect the remote as soon as a background re-auth completes, so the next
 * tool call finds the session already restored (no lazy reconnect needed).
 * Rejections are observed here; the failure also surfaces via
 * `slack_stdio_session_status` and the next tool call's recovery path.
 *
 * @param {Promise<string>} tokenPromise
 * @returns {void}
 */
function watchPendingReauth(tokenPromise) {
  tokenPromise.then(
    async (token) => {
      try {
        await connectRemote(token);
        console.error("[slack-stdio] Session restored after completed re-auth.");
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[slack-stdio] Reconnect after re-auth failed: ${msg}`);
      }
    },
    () => {
      /* timeout/cancel: surfaced on the next tool call */
    },
  );
}

/**
 * @param {boolean} [wait]
 * @returns {Promise<{ content: { type: string, text: string }[], isError?: boolean }>}
 */
async function handleLocalReauth(wait = false) {
  if (SKIP_OAUTH) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text:
            "Cannot re-auth: SLACK_SKIP_OAUTH / --skip-oauth is set. " +
            "Remove it and call slack_stdio_reauth again.",
        },
      ],
    };
  }

  const started = await beginInteractiveReauth({
    clientId: CLIENT_ID,
    clientSecret: config.clientSecret,
    host: config.oauthHost,
    port: config.oauthPort,
    callbackPath: config.oauthPath,
    openBrowser: true,
  });

  if (wait) {
    try {
      const token = await started.tokenPromise;
      await connectRemote(token);
      return {
        content: [
          {
            type: "text",
            text:
              "Slack re-authorization completed. Session restored. " +
              "You can retry the previous Slack tool now.",
          },
        ],
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return reauthToolResult({
        authorizeUrl: started.authorizeUrl,
        detail: `Re-auth wait failed: ${msg}`,
        browserOpened: true,
      });
    }
  }

  // Non-blocking: return URL immediately so the chat can show a clickable link.
  // Reconnect proactively when the user finishes Allow.
  watchPendingReauth(started.tokenPromise);
  const prefix = started.alreadyInProgress
    ? "A Slack re-auth is already in progress.\n\n"
    : "Slack re-authorization started.\n\n";
  // Not isError: the user (or agent) asked for re-auth deliberately.
  return {
    content: [
      {
        type: "text",
        text:
          prefix +
          formatReauthMessageForChat(started.authorizeUrl),
      },
    ],
  };
}

/**
 * @param {string} authorizeUrl
 * @returns {string}
 */
function formatReauthMessageForChat(authorizeUrl) {
  return reauthToolResult({
    authorizeUrl,
    browserOpened: true,
  }).content[0].text;
}

/**
 * @returns {{ content: { type: string, text: string }[] }}
 */
async function handleCatalog() {
  /** @type {string[]} */
  let remoteNames = [];
  try {
    const listed = await requireRemote().listTools();
    remoteNames = (listed.tools ?? []).map((t) => t.name);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[slack-stdio] catalog: remote listTools failed: ${msg}`);
  }
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          formatCatalog({
            local: [...LOCAL_BRIDGE_TOOL_NAMES],
            remote: remoteNames,
          }),
          null,
          2,
        ),
      },
    ],
  };
}

/**
 * @param {{ file_id?: string, dest_dir?: string, max_bytes?: number }} args
 * @param {boolean} [isRetry]
 * @returns {Promise<{ content: { type: string, text: string }[], isError?: boolean }>}
 */
async function handleDownloadFile(args, isRetry = false) {
  const fileId = String(args.file_id ?? "").trim();
  if (!fileId) {
    return {
      isError: true,
      content: [{ type: "text", text: "file_id is required" }],
    };
  }
  try {
    const result = await downloadSlackFile({
      token: accessToken,
      fileId,
      destDir: args.dest_dir,
      maxBytes: args.max_bytes,
    });
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  } catch (e) {
    const authFail = isOverlayAuthError(e) || isAuthSessionError(e);
    if (authFail && !isRetry) {
      const prompt = await recoverOrPromptReauth(
        e instanceof Error ? e.message : String(e),
      );
      if (prompt === null) {
        return handleDownloadFile(args, true);
      }
      return /** @type {{ content: { type: string, text: string }[], isError?: boolean }} */ (
        prompt
      );
    }
    const msg = e instanceof Error ? e.message : String(e);
    return {
      isError: true,
      content: [{ type: "text", text: msg }],
    };
  }
}

/**
 * @param {() => Promise<unknown>} run
 * @param {boolean} [isRetry]
 * @returns {Promise<{ content: { type: string, text: string }[], isError?: boolean }>}
 */
async function handleOverlayJson(run, isRetry = false) {
  try {
    const result = await run();
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  } catch (e) {
    const authFail = isOverlayAuthError(e) || isAuthSessionError(e);
    if (authFail && !isRetry) {
      const prompt = await recoverOrPromptReauth(
        e instanceof Error ? e.message : String(e),
      );
      if (prompt === null) {
        return handleOverlayJson(run, true);
      }
      return /** @type {{ content: { type: string, text: string }[], isError?: boolean }} */ (
        prompt
      );
    }
    return {
      isError: true,
      content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }],
    };
  }
}

function handleSessionStatus() {
  const pending = getPendingReauth();
  if (!pending) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              pendingReauth: false,
              clientId: CLIENT_ID,
              hasAccessToken: Boolean(accessToken),
            },
            null,
            2,
          ),
        },
      ],
    };
  }
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            pendingReauth: true,
            clientId: pending.clientId,
            authorizeUrl: pending.authorizeUrl,
            startedAt: new Date(pending.startedAt).toISOString(),
            message:
              "Click authorizeUrl (or use the open browser) and press Allow on Slack.",
          },
          null,
          2,
        ),
      },
    ],
  };
}

/**
 * Silent refresh + reconnect. Returns true if remote was refreshed.
 * @returns {Promise<boolean>}
 */
async function trySilentSessionRecover() {
  // Prefer a completed background re-auth if the user already clicked Allow.
  const fromPending = await takeCompletedReauthToken({ waitMs: 0 });
  if (fromPending) {
    await connectRemote(fromPending);
    console.error("[slack-stdio] Session restored from completed re-auth.");
    return true;
  }

  const refreshed = await forceRefreshAccessToken(CLIENT_ID, {
    clientSecret: config.clientSecret,
  });
  if (refreshed) {
    await connectRemote(refreshed);
    console.error("[slack-stdio] Session restored via token refresh.");
    return true;
  }
  return false;
}

/**
 * After auth failure: recover silently or start re-auth with clickable URL.
 * @param {string} detail
 * @returns {Promise<unknown>}
 */
async function recoverOrPromptReauth(detail) {
  let recovered = false;
  try {
    recovered = await trySilentSessionRecover();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[slack-stdio] Silent recover failed: ${msg}`);
    recovered = false;
  }

  const decision = decideAuthRecovery({
    recovered,
    skipOAuth: SKIP_OAUTH,
  });

  if (decision === "retry") {
    return null; // signal caller to retry
  }

  if (decision === "fail_skip_oauth") {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text:
            `Slack session expired (${detail}). ` +
            `skip-oauth is set; run without --skip-oauth or inject a new token.`,
        },
      ],
    };
  }

  // interactive_reauth: open browser + return clickable URL for the chat
  const started = await beginInteractiveReauth({
    clientId: CLIENT_ID,
    clientSecret: config.clientSecret,
    host: config.oauthHost,
    port: config.oauthPort,
    callbackPath: config.oauthPath,
    openBrowser: true,
  });
  console.error(
    `[slack-stdio] Re-auth required. URL for user:\n${started.authorizeUrl}\n`,
  );
  // Reconnect proactively when the user finishes Allow, so the agent's retry
  // hits an already-restored session.
  watchPendingReauth(started.tokenPromise);
  return reauthToolResult({
    authorizeUrl: started.authorizeUrl,
    detail,
    browserOpened: true,
  });
}

// --- Phase 3: local MCP server (stdio to the agent) ---
const local = new Server(
  { name: "slack-stdio", version: VERSION },
  {
    capabilities: {
      tools: {},
      resources: {},
      prompts: {},
    },
  },
);

local.setRequestHandler(ListToolsRequestSchema, async () => {
  try {
    const remoteListed = await requireRemote().listTools();
    return {
      tools: [...LOCAL_TOOLS, ...(remoteListed.tools ?? [])],
    };
  } catch (e) {
    if (isAuthSessionError(e)) {
      const recovered = await trySilentSessionRecover();
      if (recovered) {
        const remoteListed = await requireRemote().listTools();
        return { tools: [...LOCAL_TOOLS, ...(remoteListed.tools ?? [])] };
      }
    }
    // Still expose local re-auth tools so the agent can recover.
    return { tools: [...LOCAL_TOOLS] };
  }
});

local.setRequestHandler(CallToolRequestSchema, async (request) => {
  const name = request.params.name;
  const args = request.params.arguments ?? {};

  if (name === "slack_stdio_reauth") {
    const wait = Boolean(/** @type {{ wait?: boolean }} */ (args).wait);
    return handleLocalReauth(wait);
  }
  if (name === "slack_stdio_session_status") {
    return handleSessionStatus();
  }
  if (name === "slack_stdio_catalog") {
    return handleCatalog();
  }
  if (name === "slack_stdio_download_file") {
    return handleDownloadFile(
      /** @type {{ file_id?: string, dest_dir?: string, max_bytes?: number }} */ (args),
    );
  }
  if (name === "slack_stdio_update_message") {
    const a = /** @type {{ channel_id?: string, message_ts?: string, message?: string }} */ (args);
    return handleOverlayJson(() =>
      updateSlackMessage({
        token: accessToken,
        channelId: String(a.channel_id ?? ""),
        messageTs: String(a.message_ts ?? ""),
        message: String(a.message ?? ""),
      }),
    );
  }
  if (name === "slack_stdio_delete_message") {
    const a = /** @type {{ channel_id?: string, message_ts?: string }} */ (args);
    return handleOverlayJson(() =>
      deleteSlackMessage({
        token: accessToken,
        channelId: String(a.channel_id ?? ""),
        messageTs: String(a.message_ts ?? ""),
      }),
    );
  }
  if (name === "slack_stdio_remove_reaction") {
    const a = /** @type {{ channel_id?: string, message_ts?: string, emoji?: string }} */ (args);
    return handleOverlayJson(() =>
      removeSlackReaction({
        token: accessToken,
        channelId: String(a.channel_id ?? ""),
        messageTs: String(a.message_ts ?? ""),
        emoji: String(a.emoji ?? ""),
      }),
    );
  }
  if (name === "slack_stdio_scheduled_messages") {
    const a = /** @type {{
      action?: string,
      channel_id?: string,
      scheduled_message_id?: string,
    }} */ (args);
    return handleOverlayJson(() =>
      scheduledSlackMessages({
        token: accessToken,
        action: String(a.action ?? ""),
        channelId: a.channel_id,
        scheduledMessageId: a.scheduled_message_id,
      }),
    );
  }

  /**
   * @param {boolean} isRetry
   * @returns {Promise<unknown>}
   */
  async function callRemote(isRetry) {
    try {
      const result = await requireRemote().callTool({
        name,
        arguments: args,
      });
      // Some MCP servers put auth failures in isError results.
      if (isAuthSessionError(result) && !isRetry) {
        const prompt = await recoverOrPromptReauth(`tool ${name} returned auth error`);
        if (prompt === null) {
          return callRemote(true);
        }
        return prompt;
      }
      return result;
    } catch (e) {
      if (!isAuthSessionError(e) || isRetry) {
        throw e;
      }
      const prompt = await recoverOrPromptReauth(
        e instanceof Error ? e.message : String(e),
      );
      if (prompt === null) {
        return callRemote(true);
      }
      return prompt;
    }
  }

  return callRemote(false);
});

local.setRequestHandler(ListResourcesRequestSchema, async (request) => {
  try {
    return await requireRemote().listResources(request.params);
  } catch {
    return { resources: [] };
  }
});

local.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  return await requireRemote().readResource(request.params);
});

local.setRequestHandler(ListPromptsRequestSchema, async (request) => {
  try {
    return await requireRemote().listPrompts(request.params);
  } catch {
    return { prompts: [] };
  }
});

local.setRequestHandler(GetPromptRequestSchema, async (request) => {
  return await requireRemote().getPrompt(request.params);
});

const stdio = new StdioServerTransport();
await local.connect(stdio);
console.error("[slack-stdio] stdio ready (tools = mcp.slack.com + local overlay)");

const shutdown = async () => {
  try {
    if (remote) {
      await remote.close();
    }
  } catch {
    /* ignore */
  }
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
