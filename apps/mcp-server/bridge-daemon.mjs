#!/usr/bin/env node
"use strict";
/*
 * The single shared Seeyable bridge process for one loopback port.
 *
 * Started on demand (detached) by the first MCP stdio server that finds
 * nothing listening; see lib/hub-launch.mjs and lib/shared-bridge.mjs.
 * Owns 127.0.0.1:<port>, the one authenticated extension pairing, and
 * serves every authenticated local MCP peer. Reads the pairing token from
 * stdin. Exits quietly if the port is already taken (another bridge won
 * the start race) and after SEEYABLE_BRIDGE_IDLE_MS (default 5 min) with
 * no MCP peers connected; a later MCP process starts a new one, and the
 * extension reconnects to it with the same token on its own backoff.
 *
 * Usage (normally automatic): node bridge-daemon.mjs --port 6123 < token
 */
import { createBridge, DEFAULT_PORT, LOOPBACK_HOST } from "./lib/bridge.mjs";
import { createPeerHub, PEER_PATH } from "./lib/shared-bridge.mjs";

const log = (...args) => console.error(`[seeyable-bridge ${new Date().toISOString()} pid ${process.pid}]`, ...args);
const DEFAULT_IDLE_MS = 5 * 60 * 1000;

function parsePort(argv) {
  const i = argv.indexOf("--port");
  if (i === -1) return DEFAULT_PORT;
  const p = Number(argv[i + 1]);
  if (!Number.isInteger(p) || p < 1 || p > 65535) throw new Error(`Invalid --port: ${argv[i + 1]}`);
  return p;
}

function readToken() {
  return new Promise((resolve, reject) => {
    let data = "";
    const timer = setTimeout(() => reject(new Error("no pairing token on stdin")), 5000);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
      if (data.length > 4096) { clearTimeout(timer); reject(new Error("pairing token input too long")); }
    });
    process.stdin.on("end", () => { clearTimeout(timer); resolve(data.trim()); });
    process.stdin.on("error", (err) => { clearTimeout(timer); reject(err); });
  });
}

async function main() {
  const port = parsePort(process.argv.slice(2));
  const token = await readToken();
  if (!token) throw new Error("empty pairing token");
  const idleMs = Number(process.env.SEEYABLE_BRIDGE_IDLE_MS) > 0 ? Number(process.env.SEEYABLE_BRIDGE_IDLE_MS) : DEFAULT_IDLE_MS;

  let idleTimer = null;
  let bridge = null;
  const shutdown = async (why) => {
    log(`shutting down (${why})`);
    try { if (bridge) await bridge.close(); } catch {}
    process.exit(0);
  };
  const armIdle = () => {
    if (idleTimer) return;
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (hub.peerCount() === 0) shutdown(`no MCP peers for ${idleMs} ms`);
    }, idleMs);
  };
  const disarmIdle = () => { if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; } };

  const hub = createPeerHub({ token, log, onPeerCountChange: (n) => (n === 0 ? armIdle() : disarmIdle()) });
  bridge = createBridge({
    port, token, log,
    peerPath: PEER_PATH,
    onPeerConnection: hub.handleConnection,
    onExtensionChange: hub.broadcastStatus,
  });
  hub.attach(bridge);
  try {
    await bridge.start();
  } catch (err) {
    if (err && err.code === "EADDRINUSE") {
      // Never touch whatever owns the port. Peers authenticate it (or
      // report PORT_CONFLICT) on their own.
      log(`${LOOPBACK_HOST}:${port} is already in use; leaving it alone and exiting`);
      process.exit(0);
    }
    throw err;
  }
  log(`shared bridge listening on ${LOOPBACK_HOST}:${port} (loopback only); idle exit after ${idleMs} ms without MCP peers`);
  armIdle();
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

process.on("uncaughtException", (err) => { log(`fatal: ${err && err.message ? err.message : err}`); process.exit(1); });
process.on("unhandledRejection", (err) => { log(`fatal: ${err && err.message ? err.message : err}`); process.exit(1); });
main().catch((err) => { log(`fatal: ${err && err.message ? err.message : err}`); process.exit(1); });
