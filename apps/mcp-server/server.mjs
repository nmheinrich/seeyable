#!/usr/bin/env node
"use strict";
/*
 * Issue #28 spike: local stdio MCP server for Seeyable.
 *
 * Flow: MCP Inspector -> stdio JSON-RPC here -> loopback WebSocket bridge
 * -> extension service worker -> chrome.tabs.sendMessage -> the existing
 * content-script interfaces (snapshot engine, overlay highlight).
 *
 * stdout is reserved for MCP protocol traffic (the SDK owns it).
 * All diagnostics go to stderr. The pairing token is printed once at
 * startup so the operator can paste it into the extension's Developer
 * view; it is never logged again and never sent to webpages.
 *
 * Usage: node server.mjs [--port 6123]
 *   SEEYABLE_BRIDGE_TOKEN=... overrides the generated token (local dev).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createBridge, DEFAULT_PORT, LOOPBACK_HOST, BridgeError } from "./lib/bridge.mjs";

const errlog = (...args) => console.error(...args);

function parsePort(argv) {
  const i = argv.indexOf("--port");
  if (i === -1) return DEFAULT_PORT;
  const p = Number(argv[i + 1]);
  if (!Number.isInteger(p) || p < 1 || p > 65535) throw new Error(`Invalid --port: ${argv[i + 1]}`);
  return p;
}

function toolText(payload) {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}
function toolError(err) {
  const code = err instanceof BridgeError ? err.code : "INTERNAL_ERROR";
  return { content: [{ type: "text", text: `${code}: ${err && err.message ? err.message : err}` }], isError: true };
}

async function main() {
  const port = parsePort(process.argv.slice(2));
  const token = process.env.SEEYABLE_BRIDGE_TOKEN || undefined; // undefined => generated
  const bridge = createBridge({ port, token, log: errlog });
  await bridge.start();

  // Pairing instructions for the local operator. This is the only place
  // the token is ever printed; per-connection code never logs it.
  errlog(`[seeyable-mcp] bridge on ${LOOPBACK_HOST}:${port} (loopback only)`);
  errlog(`[seeyable-mcp] pairing token (paste into the extension Developer view, MCP bridge section):`);
  errlog(bridge.token);

  const server = new McpServer({ name: "seeyable", version: "0.1.0-spike" });

  server.registerTool("list_tabs", {
    description: "List open browser tabs (id, title, URL) so the caller can pick an explicit tabId. Never guesses a tab.",
    inputSchema: {},
  }, async () => {
    try {
      const tabs = await bridge.request("tabs", null);
      return toolText({ tabs });
    } catch (err) { return toolError(err); }
  });

  server.registerTool("page_snapshot", {
    description: "Return the production DOM/ARIA snapshot (schema v2, redacted) from the explicitly chosen tab. No canned data.",
    inputSchema: { tabId: z.number().int().describe("Tab id from list_tabs. Required; no active-tab fallback.") },
  }, async ({ tabId }) => {
    try {
      const snapshot = await bridge.request("snapshot", tabId);
      return toolText(snapshot);
    } catch (err) { return toolError(err); }
  });

  server.registerTool("highlight_target", {
    description: "Highlight one snapshot target by its stable id on the explicitly chosen tab (scrolls into view, draws the ring). Read-only: no clicks, fills, or executor actions.",
    inputSchema: {
      tabId: z.number().int().describe("Tab id from list_tabs."),
      elementId: z.string().describe("Stable snapshot id, e.g. el-12."),
      documentSessionId: z.string().describe("documentSessionId from the snapshot this id belongs to."),
      revision: z.number().int().describe("Snapshot revision this id belongs to."),
    },
  }, async ({ tabId, elementId, documentSessionId, revision }) => {
    try {
      const result = await bridge.request("highlight", tabId, { elementId, documentSessionId, revision });
      return toolText(result);
    } catch (err) { return toolError(err); }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  errlog("[seeyable-mcp] stdio transport connected; stdout reserved for MCP traffic");

  const shutdown = async () => {
    errlog("[seeyable-mcp] shutting down");
    try { await transport.close(); } catch {}
    try { await bridge.close(); } catch {}
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => { errlog(`[seeyable-mcp] fatal: ${err && err.message ? err.message : err}`); process.exit(1); });
