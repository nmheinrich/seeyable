"use strict";
/*
 * Issue #28 spike: loopback WebSocket bridge between this MCP server process
 * and the Seeyable extension's service worker.
 *
 * Security posture (thin but real):
 *  - The socket binds to 127.0.0.1 only; there is no external interface.
 *  - The extension must prove knowledge of a runtime pairing token as its
 *    first message. The token is compared with timingSafeEqual and never
 *    appears in diagnostics; it is displayed once at startup so the local
 *    operator can pair, and that deliberate display is its only output.
 *    A wrong/missing token closes the connection.
 *  - The Origin header must look like a chrome-extension:// page. This is
 *    defense-in-depth only, not authentication: the token is the auth.
 *  - One extension connection at a time; extras are refused.
 *  - Optional shared-bridge peers (local MCP stdio processes, see
 *    shared-bridge.mjs) use a separate path and must NOT carry an Origin
 *    header (browsers always send one, so no webpage can take the peer
 *    role); they authenticate there with an HMAC proof of the same token.
 *
 * Protocol (JSON text frames):
 *  ext -> srv  {"type":"auth","token":"..."}            first frame, then
 *  srv -> ext  {"type":"auth_ok"}
 *  srv -> ext  {"type":"request","id","op","tabId","params"}
 *  ext -> srv  {"type":"response","id","ok","payload"|"error"}
 *  ext -> srv  {"type":"ping","t"}  ->  srv -> ext {"type":"pong","t"}
 * (authenticated application heartbeat, ~20 s; keeps the extension
 * service worker inside Chrome's 30 s activity window and lets the
 * extension track connection health. Pings never trigger operations.)
 *
 * Requests are correlated by id with a timeout. A disconnect fails every
 * pending request and nothing is ever replayed automatically.
 */
import { createServer } from "http";
import { randomBytes, timingSafeEqual } from "crypto";
import { WebSocketServer } from "ws";

export const DEFAULT_PORT = 6123;
export const LOOPBACK_HOST = "127.0.0.1";
export const AUTH_TIMEOUT_MS = 5000;
export const DEFAULT_REQUEST_TIMEOUT_MS = 15000;

export function generatePairingToken() {
  return randomBytes(32).toString("hex");
}

function safeEqualHex(a, b) {
  const ab = Buffer.from(String(a || ""), "utf8");
  const bb = Buffer.from(String(b || ""), "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export class BridgeError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * @param {object} opts
 * @param {number} [opts.port] - loopback port to bind.
 * @param {string} [opts.token] - pairing token; generated when omitted.
 * @param {number} [opts.requestTimeoutMs]
 * @param {(...args) => void} [opts.log] - diagnostics sink (stderr in prod).
 * @param {(ws, req) => void} [opts.onPeerConnection] - shared-bridge peer
 *   handler for connections on opts.peerPath (no Origin header allowed).
 * @param {string} [opts.peerPath]
 * @param {(connected: boolean) => void} [opts.onExtensionChange]
 */
export function createBridge(opts = {}) {
  const port = opts.port ?? DEFAULT_PORT;
  const token = opts.token ?? generatePairingToken();
  const requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const log = opts.log ?? (() => {});
  const onExtensionChange = opts.onExtensionChange ?? (() => {});
  const httpServer = createServer((_req, res) => {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("seeyable bridge: websocket only\n");
  });
  const wss = new WebSocketServer({ server: httpServer, maxPayload: 16 * 1024 * 1024 });
  // ws re-emits http server errors (e.g. EADDRINUSE) on the
  // WebSocketServer; without a listener that became an unhandled 'error'
  // that killed the process even though start() rejects with it.
  wss.on("error", (err) => log(`[bridge] server error: ${err && err.code ? err.code : err}`));

  let client = null; // the one authenticated extension socket
  let seq = 0;
  const pending = new Map(); // id -> { resolve, reject, timer, op }
  const sockets = new Set(); // every open socket, authenticated or not
  let started = false;
  let closed = false;

  function failPending(err) {
    for (const [id, p] of pending) {
      clearTimeout(p.timer);
      pending.delete(id);
      p.reject(err);
    }
  }

  function detach(ws, reason) {
    if (client === ws) {
      client = null;
      log(`[bridge] extension detached (${reason}); failing ${pending.size} pending request(s), no replay`);
      failPending(new BridgeError("NO_EXTENSION", `Extension disconnected (${reason}). Reconnect and retry; nothing was replayed.`));
      try { onExtensionChange(false); } catch {}
    }
  }

  wss.on("connection", (ws, req) => {
    sockets.add(ws);
    ws.on("close", () => sockets.delete(ws));
    if (opts.onPeerConnection && opts.peerPath && String(req.url || "").split("?")[0] === opts.peerPath) {
      if (req.headers.origin !== undefined) {
        log("[bridge] refused peer connection carrying an Origin header");
        ws.close(4403, "peer role is not available to web origins");
        return;
      }
      opts.onPeerConnection(ws, req);
      return;
    }
    const origin = String(req.headers.origin || "");
    if (!origin.startsWith("chrome-extension://")) {
      log(`[bridge] refused connection with non-extension origin ${JSON.stringify(origin.slice(0, 80))}`);
      ws.close(4403, "extension origin required");
      return;
    }
    if (client) {
      log("[bridge] refused second extension connection");
      ws.close(4409, "one extension connection at a time");
      return;
    }
    let authed = false;
    const authTimer = setTimeout(() => {
      if (!authed) { log("[bridge] auth timeout"); try { ws.close(4401, "authentication required"); } catch {} }
    }, AUTH_TIMEOUT_MS);

    ws.on("message", (raw) => {
      let msg;
      try { msg = JSON.parse(String(raw)); } catch { ws.close(4400, "invalid JSON"); return; }
      if (!authed) {
        if (msg && msg.type === "auth" && safeEqualHex(msg.token, token)) {
          // Ownership is enforced here, atomically at authentication:
          // the connection-time check cannot see contenders that have
          // not authenticated yet, so a second authed contender must be
          // rejected without disturbing the current owner.
          if (client && client !== ws) {
            clearTimeout(authTimer);
            log("[bridge] rejected second authenticated contender");
            ws.close(4409, "one extension connection at a time");
            return;
          }
          authed = true;
          clearTimeout(authTimer);
          client = ws;
          log("[bridge] extension authenticated");
          ws.send(JSON.stringify({ type: "auth_ok" }));
          try { onExtensionChange(true); } catch {}
        } else {
          clearTimeout(authTimer);
          log("[bridge] rejected wrong or missing pairing token");
          ws.close(4401, "bad pairing token");
        }
        return;
      }
      if (ws !== client) return; // superseded socket: never touches ownership or pending work
      if (msg && msg.type === "ping") {
        try { ws.send(JSON.stringify({ type: "pong", t: msg.t ?? null })); } catch {}
        return;
      }
      if (msg && msg.type === "response" && typeof msg.id === "string") {
        const p = pending.get(msg.id);
        if (!p) { log(`[bridge] dropped late response for ${msg.id}`); return; } // late/duplicate: ignore
        clearTimeout(p.timer);
        pending.delete(msg.id);
        if (msg.ok) p.resolve(msg.payload);
        else {
          const err = msg.error && typeof msg.error === "object" ? msg.error : { message: String(msg.error || "unknown") };
          p.reject(new BridgeError(err.code || "EXTENSION_ERROR", err.message || "Extension reported failure."));
        }
        return;
      }
      log(`[bridge] ignored unexpected frame from extension: ${(msg && msg.type) || typeof msg}`);
    });
    ws.on("close", () => { clearTimeout(authTimer); detach(ws, "socket closed"); });
    ws.on("error", () => { clearTimeout(authTimer); detach(ws, "socket error"); });
  });

  return {
    token,
    boundPort: () => (started ? httpServer.address().port : null),
    boundHost: () => (started ? httpServer.address().address : null),
    isConnected: () => client !== null && client.readyState === 1,
    async start() {
      if (started) return;
      await new Promise((resolve, reject) => {
        httpServer.once("error", reject);
        // Loopback only: never 0.0.0.0. The address is asserted in tests.
        httpServer.listen(port, LOOPBACK_HOST, () => {
          httpServer.off("error", reject);
          resolve();
        });
      });
      started = true;
      log(`[bridge] listening on ${LOOPBACK_HOST}:${httpServer.address().port}`);
    },
    async close() {
      if (closed) return;
      closed = true;
      failPending(new BridgeError("NO_EXTENSION", "Bridge is shutting down."));
      client = null;
      // Terminate every tracked socket — authenticated or still waiting
      // on auth — so shutdown never depends on peer cooperation.
      for (const ws of [...sockets]) {
        try { ws.terminate(); } catch {}
        sockets.delete(ws);
      }
      await new Promise((resolve) => wss.close(() => httpServer.close(() => resolve())));
      started = false;
    },
    /**
     * Send one request to the connected extension and await its response.
     * Never retries; callers decide whether a retry is safe.
     *
     * opts.expiresAt is an upstream deadline supplied by trusted
     * transport code (the shared-bridge hub passes the one its peer set
     * at issue time). It can only SHORTEN this side's own validity,
     * never extend it; an already-expired request is refused unsent.
     */
    request(op, tabId, params = {}, opts = {}) {
      return new Promise((resolve, reject) => {
        if (!client || client.readyState !== 1) {
          reject(new BridgeError("NO_EXTENSION", "No extension is connected. Pair the extension, then retry."));
          return;
        }
        const now = Date.now();
        const upstream = Number.isFinite(opts.expiresAt) ? opts.expiresAt : Infinity;
        // Bounded request validity travels with the frame: the extension
        // enforces expiresAt before forwarding and the executor
        // re-checks it at its final dispatch boundary, so a request
        // this side has already timed out can never mutate the page
        // afterwards.
        const expiresAt = Math.min(now + requestTimeoutMs, upstream);
        if (expiresAt <= now) {
          reject(new BridgeError("REQUEST_EXPIRED", "The request deadline expired before it reached the extension; nothing was dispatched."));
          return;
        }
        const id = `r${now.toString(36)}-${++seq}`;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new BridgeError("TIMEOUT", `Extension did not answer ${op} before its deadline (${expiresAt - now} ms).`));
        }, expiresAt - now);
        pending.set(id, { resolve, reject, timer, op });
        client.send(JSON.stringify({ type: "request", id, op, tabId, params, expiresAt }), (err) => {
          if (err) {
            clearTimeout(timer);
            pending.delete(id);
            reject(new BridgeError("NO_EXTENSION", "Failed to send to the extension; it may have disconnected."));
          }
        });
      });
    },
  };
}
