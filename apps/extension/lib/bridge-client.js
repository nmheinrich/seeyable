"use strict";
/*
 * Issue #28 spike: extension side of the localhost MCP bridge.
 *
 * Loaded in the service worker via importScripts (see background.js).
 * The worker is a WebSocket *client* of the loopback bridge server
 * (ws://127.0.0.1:6123 by default). Outbound-only: nothing listens in
 * the browser, and no webpage can reach this socket.
 *
 * Pairing: the operator pastes the runtime token (printed once by the
 * server) into the side panel's Developer view. The token is kept in
 * chrome.storage.session (cleared when the browser closes) and is never
 * logged; only op names and request ids appear in diagnostics.
 *
 * Requests handled (all require an explicit tabId; there is no
 * active-tab fallback, and tabs are never substituted):
 *  - tabs      -> [{ tabId, title, url }] via chrome.tabs.query
 *  - snapshot  -> SEEYABLE_SNAPSHOT_DOM to that tab (real engine output)
 *  - highlight -> SEEYABLE_HIGHLIGHT_ID to that tab (guarded route)
 *
 * Service-worker lifecycle: a suspended worker drops the socket and the
 * server fails pending requests without replay. On wake (startup,
 * install, or any panel bridge message) the worker reconnects when a
 * token is stored. Reconnect uses bounded backoff retries while the
 * worker is alive; nothing persists undispatched work.
 */

/* global chrome, WebSocket */

const SEEYABLE_BRIDGE_DEFAULT_PORT = 6123;
const SEEYABLE_BRIDGE_RECONNECT_DELAYS_MS = [2000, 5000, 15000, 30000];
// Authenticated application heartbeat, following Chrome's documented
// service-worker WebSocket pattern (message exchange inside the 30 s
// activity window; minimum_chrome_version 116): ping every 20 s while
// paired, treat the connection as dead after 45 s without a pong.
const SEEYABLE_BRIDGE_HEARTBEAT_MS = 20000;
const SEEYABLE_BRIDGE_HEARTBEAT_DEAD_MS = 45000;

const __seeyableBridge = {
  socket: null,
  authed: false, // auth_ok received for the current socket (tracked separately from OPEN)
  connecting: false,
  reconnectAttempt: 0,
  reconnectTimer: null,
  wantConnection: false,
  port: SEEYABLE_BRIDGE_DEFAULT_PORT,
  heartbeatTimer: null,
  lastPongAt: 0,
  // Monotonic ownership: every Connect/Disconnect/reconnect-timer cycle
  // takes a generation. Async continuations (storage reads, socket
  // callbacks, timers) revalidate their generation before acting, so a
  // superseded attempt can never open a socket, claim ownership, clear a
  // newer connection, or schedule an unwanted reconnect.
  generation: 0,
};

function __bridgeLog(...args) {
  console.info(`[seeyable-bridge ${new Date().toISOString()}]`, ...args);
}

async function __bridgeStoredToken() {
  try {
    const { bridgeToken } = await chrome.storage.session.get("bridgeToken");
    return typeof bridgeToken === "string" && bridgeToken.length > 0 ? bridgeToken : null;
  } catch {
    return null;
  }
}

function __bridgeClearReconnect() {
  if (__seeyableBridge.reconnectTimer) {
    clearTimeout(__seeyableBridge.reconnectTimer);
    __seeyableBridge.reconnectTimer = null;
  }
}

function __bridgeStopHeartbeat() {
  if (__seeyableBridge.heartbeatTimer) {
    clearInterval(__seeyableBridge.heartbeatTimer);
    __seeyableBridge.heartbeatTimer = null;
  }
}

function __bridgeStartHeartbeat(gen, socket) {
  __bridgeStopHeartbeat();
  __seeyableBridge.lastPongAt = Date.now();
  __seeyableBridge.heartbeatTimer = setInterval(() => {
    // Owned by generation and socket identity: a superseded timer stops
    // itself instead of pinging on (or killing) a newer connection.
    if (gen !== __seeyableBridge.generation
        || __seeyableBridge.socket !== socket
        || !__seeyableBridge.authed
        || !__seeyableBridge.wantConnection) {
      __bridgeStopHeartbeat();
      return;
    }
    if (Date.now() - __seeyableBridge.lastPongAt > SEEYABLE_BRIDGE_HEARTBEAT_DEAD_MS) {
      __bridgeLog("heartbeat: no pong within 45 s; treating the connection as dead");
      __bridgeStopHeartbeat();
      try { socket.close(1011, "heartbeat timeout"); } catch {}
      return;
    }
    try { socket.send(JSON.stringify({ type: "ping", t: Date.now() })); } catch {}
  }, SEEYABLE_BRIDGE_HEARTBEAT_MS);
}

function __bridgeScheduleReconnect() {
  if (!__seeyableBridge.wantConnection || __seeyableBridge.reconnectTimer) return;
  const gen = __seeyableBridge.generation;
  const delays = SEEYABLE_BRIDGE_RECONNECT_DELAYS_MS;
  const wait = delays[Math.min(__seeyableBridge.reconnectAttempt, delays.length - 1)];
  __seeyableBridge.reconnectAttempt += 1;
  __seeyableBridge.reconnectTimer = setTimeout(() => {
    __seeyableBridge.reconnectTimer = null;
    if (gen !== __seeyableBridge.generation || !__seeyableBridge.wantConnection) return;
    __seeyableBridgeConnectInner();
  }, wait);
  __bridgeLog(`reconnect in ${wait} ms (attempt ${__seeyableBridge.reconnectAttempt})`);
}

async function __bridgeCheckTab(tabId) {
  if (!Number.isInteger(tabId)) {
    return { error: { code: "INVALID_REQUEST", message: "An explicit integer tabId is required." } };
  }
  try {
    await chrome.tabs.get(tabId);
    return { tabId };
  } catch {
    return { error: { code: "TAB_UNAVAILABLE", message: `Tab ${tabId} is missing or closed. Pick a tab from list_tabs; nothing was substituted.` } };
  }
}

function __bridgeSendError(ws, id, code, message) {
  try { ws.send(JSON.stringify({ type: "response", id, ok: false, error: { code, message } })); } catch {}
}

function __bridgeSendOk(ws, id, payload) {
  try { ws.send(JSON.stringify({ type: "response", id, ok: true, payload })); } catch {}
}

function __bridgeClassifyHighlightError(text) {
  if (/^Wrong document session/.test(text)) return "WRONG_SESSION";
  if (/^Unknown element ID/.test(text)) return "UNKNOWN_TARGET";
  if (/^Stale reference/.test(text)) return "STALE_TARGET";
  return "HIGHLIGHT_FAILED";
}

async function __bridgeHandleRequest(ws, msg) {
  const { id, op, tabId, params } = msg;
  if (op === "tabs") {
    try {
      const tabs = await chrome.tabs.query({});
      __bridgeSendOk(ws, id, tabs.map((t) => ({ tabId: t.id, title: t.title || null, url: t.url || null })));
    } catch (err) {
      __bridgeSendError(ws, id, "TABS_FAILED", `Could not list tabs: ${err.message || err}`);
    }
    return;
  }
  if (op === "snapshot" || op === "highlight") {
    const checked = await __bridgeCheckTab(tabId);
    if (checked.error) { __bridgeSendError(ws, id, checked.error.code, checked.error.message); return; }
    try {
      let res;
      if (op === "snapshot") {
        res = await chrome.tabs.sendMessage(tabId, { type: "SEEYABLE_SNAPSHOT_DOM" });
        if (!res || !res.ok) throw new Error((res && res.error) || "Empty snapshot response.");
        __bridgeSendOk(ws, id, res.snapshot);
      } else {
        const p = params || {};
        res = await chrome.tabs.sendMessage(tabId, {
          type: "SEEYABLE_HIGHLIGHT_ID",
          elementId: p.elementId, documentSessionId: p.documentSessionId, revision: p.revision,
        });
        if (!res || !res.ok) {
          const text = String((res && res.error) || "Empty highlight response.");
          __bridgeSendError(ws, id, __bridgeClassifyHighlightError(text), text);
          return;
        }
        __bridgeSendOk(ws, id, { highlighted: res.highlighted });
      }
    } catch (err) {
      const text = String(err && err.message ? err.message : err);
      if (/Receiving end does not exist|Could not establish connection|No tab with id/i.test(text)) {
        __bridgeSendError(ws, id, "TAB_NOT_READY", `Tab ${tabId} has no Seeyable content script (restricted page or not yet loaded).`);
      } else {
        __bridgeSendError(ws, id, "EXTENSION_ERROR", text);
      }
    }
    return;
  }
  __bridgeSendError(ws, id, "INVALID_REQUEST", `Unknown bridge op ${JSON.stringify(op)}.`);
}

async function __seeyableBridgeConnectInner() {
  if (!__seeyableBridge.wantConnection) return;
  if (__seeyableBridge.connecting) return;
  if (__seeyableBridge.socket && __seeyableBridge.socket.readyState === WebSocket.OPEN) return;
  const gen = __seeyableBridge.generation;
  const token = await __bridgeStoredToken();
  // Revalidate after the async storage read: a Disconnect (or a newer
  // Connect) in between must win and no socket may be opened.
  if (gen !== __seeyableBridge.generation || !__seeyableBridge.wantConnection) return;
  if (!token) {
    __bridgeLog("no pairing token stored; waiting for the operator to pair");
    return;
  }
  __seeyableBridge.connecting = true;
  const port = __seeyableBridge.port;
  let socket;
  try {
    socket = new WebSocket(`ws://127.0.0.1:${port}`);
  } catch (err) {
    if (gen === __seeyableBridge.generation) __seeyableBridge.connecting = false;
    __bridgeLog("connect failed:", err.message || err);
    __bridgeScheduleReconnect();
    return;
  }
  __seeyableBridge.socket = socket;
  __seeyableBridge.authed = false;
  const isCurrent = () => gen === __seeyableBridge.generation && __seeyableBridge.socket === socket;
  socket.addEventListener("open", () => {
    if (!isCurrent()) return; // obsolete attempt: never authenticate on it
    __seeyableBridge.connecting = false;
    __seeyableBridge.reconnectAttempt = 0;
    __bridgeLog(`connected to bridge on 127.0.0.1:${port}`);
    socket.send(JSON.stringify({ type: "auth", token }));
  });
  socket.addEventListener("message", (event) => {
    if (!isCurrent()) return;
    let msg;
    try { msg = JSON.parse(String(event.data)); } catch { return; }
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "auth_ok") {
      __seeyableBridge.authed = true;
      __bridgeStartHeartbeat(gen, socket);
      __bridgeLog("pairing accepted by bridge");
      return;
    }
    if (msg.type === "pong") {
      if (__seeyableBridge.authed) __seeyableBridge.lastPongAt = Date.now();
      return;
    }
    if (!__seeyableBridge.authed) return; // no requests before pairing is confirmed
    if (msg.type === "request" && typeof msg.id === "string") {
      __bridgeLog(`request ${msg.id} op=${msg.op} tab=${msg.tabId}`);
      __bridgeHandleRequest(socket, msg);
      return;
    }
    __bridgeLog(`ignored unexpected frame: ${msg.type}`);
  });
  const onDown = (why) => {
    const current = isCurrent();
    try { socket.close(); } catch {}
    if (!current) return; // obsolete socket: must not clear or reschedule
    __seeyableBridge.connecting = false;
    __seeyableBridge.socket = null;
    __seeyableBridge.authed = false;
    __bridgeStopHeartbeat();
    __bridgeLog(`disconnected (${why})`);
    __bridgeScheduleReconnect();
  };
  socket.addEventListener("close", (event) => onDown(`close ${event.code || ""}`.trim()));
  socket.addEventListener("error", () => onDown("socket error"));
}

async function __seeyableBridgeConnect({ token, port } = {}) {
  const entryGen = __seeyableBridge.generation;
  const wantPort = Number.isInteger(port) ? port : __seeyableBridge.port;
  const socket = __seeyableBridge.socket;
  const paired = Boolean(socket && socket.readyState === WebSocket.OPEN && __seeyableBridge.authed);
  if (paired && wantPort === __seeyableBridge.port) {
    // Identical repeated Connect preserves the working connection: the
    // generation is untouched, so the live socket's callbacks stay valid.
    if (typeof token !== "string" || token.length === 0) return { ok: true };
    const stored = await __bridgeStoredToken();
    if (entryGen !== __seeyableBridge.generation) return { ok: true }; // Disconnect/newer Connect won
    if (stored === token) return { ok: true };
  }
  if (typeof token === "string" && token.length > 0) {
    await chrome.storage.session.set({ bridgeToken: token });
  }
  // A Disconnect (or a newer Connect) during the write above wins.
  if (entryGen !== __seeyableBridge.generation) return { ok: true };
  // Deliberate replacement: drop the old socket first so changed
  // credentials/port can never leave it reported as the new
  // connection. Its callbacks are obsolete-generation inert.
  if (__seeyableBridge.socket) {
    try { __seeyableBridge.socket.close(1000, "replaced by new connect"); } catch {}
    __seeyableBridge.socket = null;
  }
  __seeyableBridge.authed = false;
  __seeyableBridge.connecting = false;
  __bridgeStopHeartbeat();
  if (Number.isInteger(port)) __seeyableBridge.port = port;
  __seeyableBridge.wantConnection = true;
  __seeyableBridge.generation += 1; // supersede any in-flight attempt or timer
  try { await chrome.storage.session.set({ bridgeWanted: true, bridgePort: __seeyableBridge.port }); } catch {}
  __bridgeClearReconnect();
  __seeyableBridge.reconnectAttempt = 0;
  await __seeyableBridgeConnectInner();
  return { ok: true };
}

async function __seeyableBridgeDisconnect() {
  __seeyableBridge.wantConnection = false;
  __seeyableBridge.generation += 1; // invalidate pending starts, callbacks, timers
  __bridgeClearReconnect();
  try { await chrome.storage.session.remove(["bridgeToken", "bridgeWanted"]); } catch {}
  if (__seeyableBridge.socket) {
    try { __seeyableBridge.socket.close(1000, "operator disconnect"); } catch {}
    __seeyableBridge.socket = null;
  }
  __seeyableBridge.authed = false;
  __seeyableBridge.connecting = false;
  __bridgeStopHeartbeat();
  __bridgeLog("disconnected by operator; pairing token discarded");
  return { ok: true };
}

function __seeyableBridgeStatus() {
  const socket = __seeyableBridge.socket;
  const fresh = Date.now() - __seeyableBridge.lastPongAt <= SEEYABLE_BRIDGE_HEARTBEAT_DEAD_MS;
  return {
    ok: true,
    wanted: __seeyableBridge.wantConnection,
    // Paired means auth_ok arrived for the current socket and the
    // heartbeat is fresh: an OPEN socket that never authenticated,
    // or one whose pongs stopped, is not reported as connected.
    connected: Boolean(socket && socket.readyState === WebSocket.OPEN && __seeyableBridge.authed && fresh),
    port: __seeyableBridge.port,
  };
}

// Restore a previously requested pairing on worker initialization
// (called synchronously at service-worker evaluation and on browser
// startup). Runs once per worker lifetime; the generation recheck
// after the storage read lets an explicit Disconnect win over a
// pending restore, and ConnectInner's own guards prevent duplicates.
let __seeyableBridgeRestoreStarted = false;
async function __seeyableBridgeMaybeReconnect() {
  if (__seeyableBridgeRestoreStarted) return;
  __seeyableBridgeRestoreStarted = true;
  const gen = __seeyableBridge.generation;
  try {
    const { bridgeWanted, bridgePort } = await chrome.storage.session.get(["bridgeWanted", "bridgePort"]);
    if (gen !== __seeyableBridge.generation) return;
    if (bridgeWanted) {
      __seeyableBridge.wantConnection = true;
      if (Number.isInteger(bridgePort)) __seeyableBridge.port = bridgePort;
      await __seeyableBridgeConnectInner();
    }
  } catch {}
}

globalThis.__seeyableBridgeConnect = __seeyableBridgeConnect;
globalThis.__seeyableBridgeDisconnect = __seeyableBridgeDisconnect;
globalThis.__seeyableBridgeStatus = __seeyableBridgeStatus;
globalThis.__seeyableBridgeMaybeReconnect = __seeyableBridgeMaybeReconnect;
