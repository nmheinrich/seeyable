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
 *  - execute   -> SEEYABLE_EXECUTE_ACTION to that tab (the ONE shared
 *                 executor; source is set to "mcp" HERE, in trusted
 *                 extension code — the MCP caller cannot choose it, and
 *                 no approval-shaped field is ever forwarded)
 *  - read_section -> SEEYABLE_READ_SECTION (bounded, read-only)
 *
 * Duplicate request frames (same id) are answered once: the first
 * handling owns the id and any repeat is dropped, so a mutation can
 * never dispatch twice from duplicate delivery. Ownership (socket
 * identity + connection generation) is rechecked after every await
 * and immediately before forwarding a mutation: a superseded socket
 * performs no page work.
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
  // Request ids already owned by a handler (in-flight or answered).
  // Bounded; duplicates are dropped so nothing dispatches twice.
  seenRequestIds: new Map(),
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

function __bridgeValidTargetParams(p, needsValue) {
  if (!p || typeof p !== "object") return "params are required.";
  if (typeof p.elementId !== "string" || !/^el-[0-9]+$/.test(p.elementId)) return "elementId must be a snapshot id like el-12.";
  if (typeof p.documentSessionId !== "string" || !p.documentSessionId) return "documentSessionId from a snapshot is required.";
  if (!Number.isInteger(p.revision)) return "revision from a snapshot is required.";
  for (const key of Object.keys(p)) {
    if (!["elementId", "documentSessionId", "revision", "action", "value", "maxChars"].includes(key)) {
      return `Unknown bridge param: ${key}.`;
    }
  }
  if (needsValue === "action") {
    if (!["click", "fill", "select"].includes(p.action)) return "action must be click, fill, or select.";
    if ((p.action === "fill" || p.action === "select") && typeof p.value !== "string") return `${p.action} needs a string value.`;
    if (p.action === "click" && p.value !== undefined) return "click takes no value.";
  }
  if (needsValue === "read" && p.maxChars !== undefined && !Number.isInteger(p.maxChars)) return "maxChars must be an integer.";
  return null;
}

// A held MCP action must surface in the panel's existing confirmation
// card. The runtime message is only a HINT (tab id, no authority): the
// panel re-fetches the authoritative pending challenge from the content
// script over its trusted route before showing anything.
async function __bridgeNotifyPanelOfHold(tabId) {
  // Independent channels: a failed runtime send must not leave an already
  // open panel idle until its next snapshot. Session storage changes wake
  // that panel's discovery too. Keep only one small, non-authoritative hint;
  // the nonce makes consecutive holds on the same tab distinct events.
  // Neither channel carries a challenge, request, value, or approval.
  const deliveries = [];
  try {
    deliveries.push(chrome.runtime.sendMessage({ type: "SEEYABLE_MCP_CONFIRMATION_HINT", tabId }));
  } catch { deliveries.push(Promise.reject(new Error("runtime hint unavailable"))); }
  try {
    deliveries.push(chrome.storage.session.set({
      mcpConfirmationHint: { tabId, nonce: `${Date.now()}-${Math.random()}` },
    }));
  } catch { deliveries.push(Promise.reject(new Error("session hint unavailable"))); }
  const results = await Promise.allSettled(deliveries);
  if (results.every((result) => result.status === "rejected")) {
    __bridgeLog("held-action notification unavailable; the executor still holds the action until human decision or expiry");
  }
}

async function __bridgeHandleRequest(ws, msg, isCurrent) {
  const { id, op, tabId, params } = msg;
  const ownsWork = () => typeof isCurrent !== "function" || isCurrent();
  // The server's bounded request validity (Issue #19): a frame whose
  // deadline has passed must not be forwarded — the caller has already
  // seen TIMEOUT, and dispatching now would mutate without an owner.
  // The later of the two wall-clock reads is used so a clock moved
  // forward by the embedding environment is honored too.
  const expiresAt = Number.isFinite(msg.expiresAt) ? msg.expiresAt : null;
  const expired = () => expiresAt !== null && Math.max(Date.now(), new Date().getTime()) >= expiresAt;
  if (op === "tabs") {
    try {
      const tabs = await chrome.tabs.query({});
      if (!ownsWork()) return;
      __bridgeSendOk(ws, id, tabs.map((t) => ({ tabId: t.id, title: t.title || null, url: t.url || null })));
    } catch (err) {
      __bridgeSendError(ws, id, "TABS_FAILED", `Could not list tabs: ${err.message || err}`);
    }
    return;
  }
  if (op === "snapshot" || op === "highlight" || op === "execute" || op === "read_section") {
    const p = params || {};
    const invalid = op === "execute" ? __bridgeValidTargetParams(p, "action")
      : op === "read_section" ? __bridgeValidTargetParams(p, "read")
      : op === "highlight" ? __bridgeValidTargetParams(p, false)
      : null; // snapshot needs no target params
    if (invalid) { __bridgeSendError(ws, id, "INVALID_REQUEST", invalid); return; }
    const checked = await __bridgeCheckTab(tabId);
    if (checked.error) { __bridgeSendError(ws, id, checked.error.code, checked.error.message); return; }
    // Ownership is rechecked after the tab lookup and immediately
    // before forwarding: a superseded connection performs no page work,
    // least of all a mutation.
    if (!ownsWork()) { __bridgeLog(`dropped ${op} for superseded connection before dispatch`); return; }
    if (expired()) {
      __bridgeLog(`dropped ${op} request ${id}: deadline expired before forwarding`);
      __bridgeSendError(ws, id, "REQUEST_EXPIRED", "The request deadline expired before it could be forwarded; nothing was dispatched.");
      return;
    }
    try {
      let res;
      if (op === "snapshot") {
        res = await chrome.tabs.sendMessage(tabId, { type: "SEEYABLE_SNAPSHOT_DOM" });
        if (!res || !res.ok) throw new Error((res && res.error) || "Empty snapshot response.");
        __bridgeSendOk(ws, id, res.snapshot);
      } else if (op === "highlight") {
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
      } else if (op === "execute") {
        // The ONE shared executor. Only these fields cross; approval-shaped
        // fields are dropped by construction, and the audit source is set
        // here — never by the MCP caller.
        res = await chrome.tabs.sendMessage(tabId, {
          type: "SEEYABLE_EXECUTE_ACTION",
          request: {
            action: p.action,
            elementId: p.elementId,
            documentSessionId: p.documentSessionId,
            revision: p.revision,
            value: p.action === "click" ? undefined : p.value,
            source: "mcp",
            // The same deadline is re-checked inside the executor,
            // after its asynchronous waits, at the dispatch boundary.
            ...(expiresAt !== null ? { deadline: expiresAt } : {}),
          },
        });
        if (!res || typeof res.ok !== "boolean") throw new Error("Empty executor response.");
        if (!res.ok && res.error && res.error.code === "CONFIRMATION_REQUIRED" && res.confirmation) {
          await __bridgeNotifyPanelOfHold(tabId);
        }
        __bridgeSendOk(ws, id, res);
      } else {
        res = await chrome.tabs.sendMessage(tabId, {
          type: "SEEYABLE_READ_SECTION",
          elementId: p.elementId, documentSessionId: p.documentSessionId, revision: p.revision,
          maxChars: p.maxChars,
        });
        if (!res || !res.ok) {
          const e = res && res.error && typeof res.error === "object" ? res.error : null;
          __bridgeSendError(ws, id, e ? e.code || "READ_SECTION_FAILED" : "READ_SECTION_FAILED", e ? e.message || "Section read failed." : String((res && res.error) || "Empty section response."));
          return;
        }
        __bridgeSendOk(ws, id, res.section);
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

function __bridgeOwnRequest(id) {
  const seen = __seeyableBridge.seenRequestIds;
  if (seen.has(id)) return false;
  seen.set(id, Date.now());
  if (seen.size > 200) {
    // Bounded: forget the oldest ids. Server request ids are unique per
    // call, so forgetting an answered id cannot cause a replay.
    for (const key of seen.keys()) {
      if (seen.size <= 200) break;
      seen.delete(key);
    }
  }
  return true;
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
      if (!__bridgeOwnRequest(msg.id)) {
        __bridgeLog(`dropped duplicate request frame ${msg.id} (already owned; nothing re-dispatched)`);
        return;
      }
      __bridgeLog(`request ${msg.id} op=${msg.op} tab=${msg.tabId}`);
      __bridgeHandleRequest(socket, msg, isCurrent);
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
