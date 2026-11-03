"use strict";
/*
 * Shared local bridge: one authenticated extension pairing serving many
 * local MCP stdio processes (one per chat, plus discovery probes).
 *
 * Why: MCP desktop clients launch a separate stdio server process per
 * chat. When every process tried to own the loopback listener, only the
 * first could bind; the rest died with EADDRINUSE before answering
 * `initialize`. Now exactly one detached bridge process (bridge-daemon.mjs)
 * owns 127.0.0.1:<port> and the extension pairing; every stdio process is
 * a *peer* of it over the same loopback port on PEER_PATH.
 *
 * Trust boundaries:
 *  - Loopback only. The peer path refuses any connection carrying an
 *    Origin header (enforced in bridge.mjs), so no webpage can be a peer.
 *  - Mutual authentication by HMAC-SHA256 challenge/response over the
 *    pairing token. The token itself never crosses the peer socket, so an
 *    unrelated program listening on the port learns nothing usable and is
 *    never mistaken for Seeyable: the peer requires the hub's proof
 *    before sending any request. The hub proves only AFTER the peer has
 *    proved, so it is not an oracle for unauthenticated callers.
 *  - Peers get no approval authority: the peer protocol carries only
 *    request/response for the five existing bridge ops; there is no
 *    approval frame. All actions still reach the ONE shared executor
 *    and its human safety gate through the extension.
 *
 * Peer protocol (JSON text frames on PEER_PATH):
 *  hub  -> peer {"type":"hello","protocol":1,"nonce"}
 *  peer -> hub  {"type":"peer_auth","protocol":1,"nonce","proof"}
 *  hub  -> peer {"type":"peer_ok","proof","peerId","extensionConnected"}
 *  peer -> hub  {"type":"request","id","op","tabId","params","expiresAt"}
 *  hub  -> peer {"type":"response","id","ok","payload"|"error"}
 *  hub  -> peer {"type":"status","extensionConnected"}
 * Plus WebSocket-level ping/pong heartbeats in both directions.
 *
 * Isolation: peer request ids are scoped to that peer's socket. The hub
 * issues a fresh, globally unique bridge id for every forwarded request
 * (bridge.request) and routes the answer back through the promise that
 * belongs to that one peer socket, so peers can neither collide on ids
 * nor receive each other's results. A duplicate id from the same peer
 * is dropped (never forwarded twice).
 *
 * Deadlines: the peer stamps expiresAt (epoch ms, same host clock) when
 * it ISSUES the request, in transport code — never from MCP tool input,
 * whose strict schemas reject unknown fields. The hub refuses a missing
 * or already-expired deadline without forwarding, and passes it to
 * bridge.request, which only ever shortens it. So the extension and the
 * executor enforce the original validity, and a request delayed in
 * transit can never dispatch after its caller saw TIMEOUT. Any link
 * failure fails that link's pending work honestly; nothing is replayed.
 */
import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import WebSocket from "ws";
import { BridgeError, DEFAULT_REQUEST_TIMEOUT_MS, LOOPBACK_HOST } from "./bridge.mjs";

export const PEER_PATH = "/seeyable-mcp-peer";
export const PEER_PROTOCOL = 1;
export const PEER_AUTH_TIMEOUT_MS = 3000;
export const PEER_HEARTBEAT_MS = 15000;
const ALLOWED_OPS = new Set(["tabs", "snapshot", "highlight", "execute", "read_section"]);
const NONCE_RE = /^[0-9a-f]{32}$/;
const MAX_ID_LEN = 64;
const SEEN_LIMIT = 500;
const RECONNECT_DELAYS_MS = [500, 1000, 2000, 5000, 10000];

export function peerProof(token, role, serverNonce, peerNonce) {
  return createHmac("sha256", String(token))
    .update(`seeyable-bridge-peer-v1|${role}|${serverNonce}|${peerNonce}`)
    .digest("hex");
}

function sameHex(a, b) {
  const ab = Buffer.from(String(a || ""), "utf8");
  const bb = Buffer.from(String(b || ""), "utf8");
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function send(ws, frame) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  try { ws.send(JSON.stringify(frame)); return true; } catch { return false; }
}

/**
 * Hub side, inside the single bridge process. Wire with
 * createBridge({ peerPath: PEER_PATH, onPeerConnection: hub.handleConnection,
 * onExtensionChange: hub.broadcastStatus }) and then hub.attach(bridge).
 */
export function createPeerHub({ token, log = () => {}, onPeerCountChange = () => {}, heartbeatMs = PEER_HEARTBEAT_MS } = {}) {
  let bridge = null;
  let nextPeer = 0;
  const peers = new Set();

  function handleConnection(ws) {
    const serverNonce = randomBytes(16).toString("hex");
    const peer = { ws, id: null, authed: false, seen: new Map(), alive: true };
    const authTimer = setTimeout(() => {
      if (!peer.authed) { log("[hub] peer auth timeout"); try { ws.close(4401, "authentication required"); } catch {} }
    }, PEER_AUTH_TIMEOUT_MS);
    let beat = null;
    ws.on("pong", () => { peer.alive = true; });
    send(ws, { type: "hello", protocol: PEER_PROTOCOL, nonce: serverNonce });

    ws.on("message", (raw) => {
      let msg;
      try { msg = JSON.parse(String(raw)); } catch { ws.close(4400, "invalid JSON"); return; }
      if (!msg || typeof msg !== "object") { ws.close(4400, "invalid frame"); return; }
      if (!peer.authed) {
        clearTimeout(authTimer);
        const valid = msg.type === "peer_auth" && msg.protocol === PEER_PROTOCOL
          && typeof msg.nonce === "string" && NONCE_RE.test(msg.nonce)
          && sameHex(msg.proof, peerProof(token, "peer", serverNonce, msg.nonce));
        if (!valid) {
          log("[hub] rejected peer: wrong pairing proof or protocol");
          ws.close(4401, "bad pairing proof");
          return;
        }
        peer.authed = true;
        peer.id = `p${++nextPeer}`;
        peers.add(peer);
        send(ws, {
          type: "peer_ok",
          proof: peerProof(token, "hub", serverNonce, msg.nonce),
          peerId: peer.id,
          extensionConnected: Boolean(bridge && bridge.isConnected()),
        });
        beat = setInterval(() => {
          if (!peer.alive) { log(`[hub] peer ${peer.id} missed heartbeat; closing it`); try { ws.terminate(); } catch {} return; }
          peer.alive = false;
          try { ws.ping(); } catch {}
        }, heartbeatMs);
        log(`[hub] peer ${peer.id} authenticated (${peers.size} connected)`);
        onPeerCountChange(peers.size);
        return;
      }
      if (msg.type !== "request") { log(`[hub] ignored ${String(msg.type)} frame from ${peer.id}`); return; }
      const { id, op, tabId } = msg;
      if (typeof id !== "string" || id.length === 0 || id.length > MAX_ID_LEN) {
        log(`[hub] dropped request with invalid id from ${peer.id}`);
        return;
      }
      if (peer.seen.has(id)) {
        // Duplicate delivery from the same peer: never forwarded twice.
        log(`[hub] dropped duplicate request ${peer.id}/${id}; nothing re-dispatched`);
        return;
      }
      peer.seen.set(id, true);
      if (peer.seen.size > SEEN_LIMIT) peer.seen.delete(peer.seen.keys().next().value);
      if (!ALLOWED_OPS.has(op)) {
        send(ws, { type: "response", id, ok: false, error: { code: "INVALID_REQUEST", message: `Unknown bridge op ${JSON.stringify(op)}.` } });
        return;
      }
      const params = msg.params && typeof msg.params === "object" ? msg.params : {};
      if (!Number.isFinite(msg.expiresAt)) {
        send(ws, { type: "response", id, ok: false, error: { code: "INVALID_REQUEST", message: "Request deadline (expiresAt) is required; nothing was dispatched." } });
        return;
      }
      if (msg.expiresAt <= Date.now()) {
        log(`[hub] ${peer.id}/${id} op=${op} arrived after its deadline; not forwarded`);
        send(ws, { type: "response", id, ok: false, error: { code: "REQUEST_EXPIRED", message: "The request deadline expired before it reached the bridge; nothing was dispatched." } });
        return;
      }
      if (!bridge) {
        send(ws, { type: "response", id, ok: false, error: { code: "NO_EXTENSION", message: "Bridge is not ready; nothing was sent." } });
        return;
      }
      log(`[hub] ${peer.id}/${id} op=${op} tab=${tabId}`);
      bridge.request(op, tabId ?? null, params, { expiresAt: msg.expiresAt }).then(
        (payload) => {
          if (!send(ws, { type: "response", id, ok: true, payload })) log(`[hub] result for closed peer ${peer.id}/${id} dropped`);
        },
        (err) => {
          const code = err instanceof BridgeError ? err.code : "INTERNAL_ERROR";
          const message = err && err.message ? err.message : String(err);
          if (!send(ws, { type: "response", id, ok: false, error: { code, message } })) log(`[hub] error for closed peer ${peer.id}/${id} dropped`);
        },
      );
    });

    const gone = () => {
      clearTimeout(authTimer);
      if (beat) clearInterval(beat);
      if (peers.delete(peer)) {
        log(`[hub] peer ${peer.id} disconnected (${peers.size} remain); its in-flight results will be dropped`);
        onPeerCountChange(peers.size);
      }
    };
    ws.on("close", gone);
    ws.on("error", gone);
  }

  return {
    attach(b) { bridge = b; },
    handleConnection,
    broadcastStatus(connected) {
      for (const p of peers) send(p.ws, { type: "status", extensionConnected: Boolean(connected) });
    },
    peerCount: () => peers.size,
  };
}

/**
 * Peer side, inside each MCP stdio process. Exposes the same
 * request/isConnected surface tools.mjs uses with a direct bridge.
 *
 * ensure(): connect + mutually authenticate. If nothing listens on the
 * port and spawnHub is given, start the shared bridge process once and
 * retry briefly. If something else answers (no Seeyable hello, wrong
 * proof, HTTP-only, closes on us), report PORT_CONFLICT and never send
 * it a request. Lost links reconnect in the background; reconnecting
 * restores transport only — nothing is replayed.
 */
export function createPeerClient({
  port, token, log = () => {}, spawnHub = null,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  spawnWaitMs = 6000, heartbeatMs = PEER_HEARTBEAT_MS,
} = {}) {
  let ws = null;
  let peerId = null;
  let extensionConnected = false;
  let seq = 0;
  const pending = new Map();
  let connecting = null;
  let lastError = { code: "BRIDGE_UNAVAILABLE", message: "Not yet connected to the shared Seeyable bridge." };
  let closed = false;
  let reconnectTimer = null;
  let reconnectAttempt = 0;
  let beat = null;

  const url = `ws://${LOOPBACK_HOST}:${port}${PEER_PATH}`;

  function failPending(err) {
    for (const [id, p] of pending) {
      clearTimeout(p.timer);
      pending.delete(id);
      p.reject(err);
    }
  }

  function scheduleReconnect() {
    if (closed || reconnectTimer) return;
    const wait = RECONNECT_DELAYS_MS[Math.min(reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)];
    reconnectAttempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      ensure().catch(() => {});
    }, wait);
    if (typeof reconnectTimer.unref === "function") reconnectTimer.unref();
  }

  // One attempt: resolves { ok } | { refused } | { conflict, message }.
  function attempt() {
    return new Promise((resolve) => {
      let settled = false;
      const sock = new WebSocket(url, { handshakeTimeout: PEER_AUTH_TIMEOUT_MS, maxPayload: 16 * 1024 * 1024 });
      const peerNonce = randomBytes(16).toString("hex");
      let serverNonce = null;
      const done = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (!result.ok) { try { sock.terminate(); } catch {} }
        resolve(result);
      };
      const conflict = (why) => done({
        conflict: true,
        message: `127.0.0.1:${port} is in use by something that did not authenticate as the Seeyable bridge (${why}). Nothing was sent to it. If it is an older Seeyable server, quit that MCP client; if it is a Seeyable bridge with a different pairing token, use the same SEEYABLE_BRIDGE_TOKEN everywhere.`,
      });
      const timer = setTimeout(() => conflict("no authenticated handshake in time"), PEER_AUTH_TIMEOUT_MS * 2);
      sock.on("unexpected-response", (_req, res) => conflict(`HTTP ${res.statusCode} instead of a WebSocket`));
      sock.on("error", (err) => {
        if (err && err.code === "ECONNREFUSED") done({ refused: true });
        else conflict(err && err.code ? err.code : "socket error");
      });
      sock.on("close", (code) => {
        // Accepted then dropped before any hello (e.g. a bridge in its
        // idle shutdown): transient, retried once before calling it a conflict.
        if (!serverNonce && (code === 1005 || code === 1006)) done({ dropped: true });
        else conflict(`closed ${code}${code === 4401 ? ": pairing proof refused" : ""}`);
      });
      sock.on("message", (raw) => {
        if (settled) return;
        let msg;
        try { msg = JSON.parse(String(raw)); } catch { conflict("non-JSON frame"); return; }
        if (!serverNonce) {
          if (!msg || msg.type !== "hello" || msg.protocol !== PEER_PROTOCOL || typeof msg.nonce !== "string" || !NONCE_RE.test(msg.nonce)) {
            conflict("no Seeyable hello"); return;
          }
          serverNonce = msg.nonce;
          sock.send(JSON.stringify({ type: "peer_auth", protocol: PEER_PROTOCOL, nonce: peerNonce, proof: peerProof(token, "peer", serverNonce, peerNonce) }));
          return;
        }
        if (!msg || msg.type !== "peer_ok" || !sameHex(msg.proof, peerProof(token, "hub", serverNonce, peerNonce))) {
          conflict("bridge proof missing or wrong"); return;
        }
        sock.removeAllListeners("close");
        sock.removeAllListeners("error");
        sock.removeAllListeners("message");
        done({ ok: true, sock, peerId: String(msg.peerId || ""), extensionConnected: Boolean(msg.extensionConnected) });
      });
    });
  }

  function adopt(result) {
    ws = result.sock;
    peerId = result.peerId;
    extensionConnected = result.extensionConnected;
    reconnectAttempt = 0;
    lastError = null;
    const sock = ws;
    let alive = true;
    sock.on("pong", () => { alive = true; });
    beat = setInterval(() => {
      if (!alive) { log("[peer] shared bridge missed heartbeat; dropping link"); try { sock.terminate(); } catch {} return; }
      alive = false;
      try { sock.ping(); } catch {}
    }, heartbeatMs);
    if (typeof beat.unref === "function") beat.unref();
    sock.on("message", (raw) => {
      let msg;
      try { msg = JSON.parse(String(raw)); } catch { return; }
      if (!msg || typeof msg !== "object") return;
      if (msg.type === "status") { extensionConnected = Boolean(msg.extensionConnected); return; }
      if (msg.type === "response" && typeof msg.id === "string") {
        const p = pending.get(msg.id);
        if (!p) { log(`[peer] dropped late response ${msg.id}`); return; }
        clearTimeout(p.timer);
        pending.delete(msg.id);
        if (msg.ok) p.resolve(msg.payload);
        else {
          const e = msg.error && typeof msg.error === "object" ? msg.error : {};
          p.reject(new BridgeError(e.code || "EXTENSION_ERROR", e.message || "Extension reported failure."));
        }
      }
    });
    const down = (why) => {
      if (ws !== sock) return;
      ws = null;
      extensionConnected = false;
      clearInterval(beat);
      beat = null;
      lastError = { code: "BRIDGE_UNAVAILABLE", message: `Lost the connection to the shared Seeyable bridge (${why}). Nothing was replayed.` };
      log(`[peer] shared bridge link down (${why}); failing ${pending.size} pending request(s), no replay`);
      failPending(new BridgeError("BRIDGE_UNAVAILABLE", lastError.message));
      scheduleReconnect();
    };
    sock.on("close", (code) => down(`close ${code}`));
    sock.on("error", () => down("socket error"));
    log(`[peer] joined shared bridge on 127.0.0.1:${port} as ${peerId}; extension ${extensionConnected ? "paired" : "not paired yet"}`);
  }

  async function connectFlow() {
    let result = await attempt();
    if (result.dropped && !closed) {
      await new Promise((r) => setTimeout(r, 300));
      result = await attempt();
    }
    if (result.dropped) result = { conflict: true, message: `127.0.0.1:${port} accepted and then dropped the connection before a Seeyable hello. Nothing was sent to it.` };
    if (result.refused && spawnHub && !closed) {
      log(`[peer] no bridge on 127.0.0.1:${port}; starting the shared bridge process`);
      try { spawnHub(); } catch (err) { log(`[peer] could not start shared bridge: ${err && err.message ? err.message : err}`); }
      const deadline = Date.now() + spawnWaitMs;
      while ((result.refused || result.dropped) && Date.now() < deadline && !closed) {
        await new Promise((r) => setTimeout(r, 150));
        result = await attempt();
      }
    }
    if (closed) { if (result.ok) { try { result.sock.terminate(); } catch {} } return false; }
    if (result.ok) { adopt(result); return true; }
    lastError = result.conflict
      ? { code: "PORT_CONFLICT", message: result.message }
      : { code: "BRIDGE_UNAVAILABLE", message: `No Seeyable bridge is listening on 127.0.0.1:${port}.` };
    log(`[peer] ${lastError.code}: ${lastError.message}`);
    scheduleReconnect();
    return false;
  }

  function ensure() {
    if (closed) return Promise.resolve(false);
    if (ws && ws.readyState === WebSocket.OPEN) return Promise.resolve(true);
    if (!connecting) connecting = connectFlow().finally(() => { connecting = null; });
    return connecting;
  }

  return {
    ensure,
    isConnected: () => Boolean(ws && ws.readyState === WebSocket.OPEN && extensionConnected),
    isLinked: () => Boolean(ws && ws.readyState === WebSocket.OPEN),
    lastError: () => lastError,
    peerId: () => peerId,
    // Wait for an in-progress (bounded) join so a call right after
    // startup is not refused spuriously. This is the first send, never
    // a resend: nothing that already left this process is re-sent.
    ready: () => ensure().catch(() => false),
    async request(op, tabId, params = {}) {
      if (!ws || ws.readyState !== WebSocket.OPEN) await ensure().catch(() => false);
      return new Promise((resolve, reject) => {
        if (!ws || ws.readyState !== WebSocket.OPEN) {
          const e = lastError || { code: "BRIDGE_UNAVAILABLE", message: "Not connected to the shared Seeyable bridge." };
          reject(new BridgeError(e.code, `${e.message} Nothing was sent.`));
          return;
        }
        const id = `q${++seq}`;
        // The request's whole validity starts NOW, at issue. It travels
        // with the frame; the hub and bridge may only shorten it.
        const expiresAt = Date.now() + requestTimeoutMs;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new BridgeError("TIMEOUT", `The shared bridge did not answer ${op} within ${requestTimeoutMs} ms.`));
        }, requestTimeoutMs);
        pending.set(id, { resolve, reject, timer });
        if (!send(ws, { type: "request", id, op, tabId, params, expiresAt })) {
          clearTimeout(timer);
          pending.delete(id);
          reject(new BridgeError("BRIDGE_UNAVAILABLE", "Failed to send to the shared bridge; nothing was sent."));
        }
      });
    },
    async close() {
      closed = true;
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      if (beat) { clearInterval(beat); beat = null; }
      failPending(new BridgeError("BRIDGE_UNAVAILABLE", "MCP server is shutting down."));
      const sock = ws;
      ws = null;
      if (sock) {
        await new Promise((resolve) => {
          sock.once("close", resolve);
          try { sock.close(1000, "peer shutdown"); } catch { resolve(); }
          setTimeout(() => { try { sock.terminate(); } catch {} resolve(); }, 500).unref?.();
        });
      }
    },
  };
}
