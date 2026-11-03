#!/usr/bin/env node
"use strict";
/*
 * Seeyable local MCP server (Issue #28 transport; Issue #19 full toolset).
 *
 * Flow: MCP client -> stdio JSON-RPC here -> loopback WebSocket bridge
 * -> extension service worker -> chrome.tabs.sendMessage -> the existing
 * content-script interfaces (snapshot engine, overlay highlight, the ONE
 * shared executor, bounded section reading). No planner proxy or
 * MODEL_API_KEY is involved: the MCP client supplies the intelligence,
 * Seeyable supplies page information and guarded actions.
 *
 * Shared bridge (cross-chat fix): MCP desktop clients start one stdio
 * process per chat (and short-lived ones for tool discovery). This
 * process no longer binds the bridge port itself. It answers MCP
 * `initialize` first, then joins the ONE shared, authenticated loopback
 * bridge process for the port (lib/shared-bridge.mjs), starting it
 * detached if nothing is listening. Closing this process never closes
 * the bridge or another chat's session. If the port is held by anything
 * that cannot prove the pairing token, tools report PORT_CONFLICT and
 * nothing is sent to it.
 *
 * stdout is reserved for MCP protocol traffic (the SDK owns it).
 * All diagnostics go to stderr. A newly generated pairing token is
 * printed once so the operator can paste it into the extension's
 * Developer view; it is never logged again and never sent to webpages.
 *
 * Usage: node server.mjs [--port 6123]
 *   SEEYABLE_BRIDGE_TOKEN=... sets the token (otherwise one is kept in
 *   ~/.seeyable/bridge-<port>.token, mode 0600; SEEYABLE_STATE_DIR moves it).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { DEFAULT_PORT, LOOPBACK_HOST, BridgeError } from "./lib/bridge.mjs";
import { createPeerClient } from "./lib/shared-bridge.mjs";
import { resolveToken, spawnHubProcess } from "./lib/hub-launch.mjs";
import { toolHandlers } from "./lib/tools.mjs";

const errlog = (...args) => console.error(...args);

function parsePort(argv) {
  const i = argv.indexOf("--port");
  if (i === -1) return DEFAULT_PORT;
  const p = Number(argv[i + 1]);
  if (!Number.isInteger(p) || p < 1 || p > 65535) throw new Error(`Invalid --port: ${argv[i + 1]}`);
  return p;
}

function toolError(err) {
  const code = err instanceof BridgeError ? err.code : "INTERNAL_ERROR";
  return { content: [{ type: "text", text: `${code}: ${err && err.message ? err.message : err}` }], isError: true };
}

function unavailableBridge(err) {
  const why = { code: "PAIRING_UNAVAILABLE", message: `Pairing token unavailable: ${err && err.message ? err.message : err}` };
  return {
    isConnected: () => false,
    lastError: () => why,
    ensure: async () => false,
    request: async () => { throw new BridgeError(why.code, `${why.message} Nothing was sent.`); },
    close: async () => {},
  };
}

async function main() {
  const port = parsePort(process.argv.slice(2));
  let pairing = null;
  let pairingError = null;
  try { pairing = resolveToken({ port }); } catch (err) { pairingError = err; }
  const { token, source, path } = pairing || {};
  // An unusable token file must not stop MCP initialize: tools then
  // report PAIRING_UNAVAILABLE and no bridge connection is attempted.
  const bridge = pairing ? createPeerClient({
    port, token, log: errlog,
    spawnHub: () => spawnHubProcess({ port, token, log: errlog }),
  }) : unavailableBridge(pairingError);

  // Pairing instructions for the local operator. Only a token generated
  // just now is printed; existing tokens are referenced, not repeated.
  errlog(`[seeyable-mcp] shared bridge port ${LOOPBACK_HOST}:${port} (loopback only)`);
  if (source === "generated") {
    errlog(`[seeyable-mcp] new pairing token (paste into the extension Developer view, MCP bridge section; also kept in ${path}):`);
    errlog(token);
  } else if (source === "file") {
    errlog(`[seeyable-mcp] using the existing pairing token in ${path}`);
  } else if (source === "env") {
    errlog("[seeyable-mcp] using the pairing token from SEEYABLE_BRIDGE_TOKEN");
  } else {
    errlog(`[seeyable-mcp] pairing token unavailable: ${pairingError && pairingError.message}`);
  }

  const server = new McpServer({ name: "seeyable", version: "0.2.0" });

  // Tool contracts live in lib/tools.mjs (strict schemas, outcome
  // mapping). Registration is a thin loop; handlers return both text
  // and structuredContent so SDK clients get either form.
  for (const def of toolHandlers(bridge)) {
    server.registerTool(def.name, {
      description: def.description,
      inputSchema: def.inputSchema,
    }, async (args) => {
      try {
        return await def.handler(args || {});
      } catch (err) { return toolError(err); }
    });
  }

  // Answer MCP initialize before touching the bridge: a busy or broken
  // port must never prevent this chat's session from starting.
  const transport = new StdioServerTransport();
  await server.connect(transport);
  errlog("[seeyable-mcp] stdio transport connected; stdout reserved for MCP traffic");
  bridge.ensure().catch((err) => errlog(`[seeyable-mcp] bridge join failed: ${err && err.message ? err.message : err}`));

  let stopping = false;
  const shutdown = async (why) => {
    if (stopping) return;
    stopping = true;
    errlog(`[seeyable-mcp] shutting down (${why}); the shared bridge stays up for other chats`);
    try { await transport.close(); } catch {}
    try { await bridge.close(); } catch {}
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  // The MCP client closing our stdin ends this session; the open bridge
  // socket must not keep an orphaned process alive.
  process.stdin.on("end", () => shutdown("stdin closed"));
  process.stdin.on("close", () => shutdown("stdin closed"));
}
main().catch((err) => { errlog(`[seeyable-mcp] fatal: ${err && err.message ? err.message : err}`); process.exit(1); });
