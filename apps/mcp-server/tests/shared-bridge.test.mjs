"use strict";
/* Shared bridge (cross-chat fix): one extension pairing, many MCP peers.
 * In-process: a real createBridge + hub on a loopback port, real peer
 * clients, and a scripted fake extension socket. No credentials, no
 * browser, no model calls. */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import WebSocket, { WebSocketServer } from "ws";
import { createBridge } from "../lib/bridge.mjs";
import { createPeerHub, createPeerClient, PEER_PATH, peerProof } from "../lib/shared-bridge.mjs";
import { toolHandlers } from "../lib/tools.mjs";

const ORIGIN = "chrome-extension://test-id";
const TOKEN = "a".repeat(64);
const tick = (ms = 50) => new Promise((r) => setTimeout(r, ms));
async function nextFrame(inbox, type) {
  for (let i = 0; i < 200; i++) {
    const at = inbox.findIndex((m) => m.type === type);
    if (at !== -1) return inbox.splice(at, 1)[0];
    await tick(10);
  }
  throw new Error(`no ${type} frame`);
}

// deliveryDelayMs holds each peer request frame before the hub sees it
// (a slow hop), without touching production code.
async function startHub({ requestTimeoutMs, deliveryDelayMs = 0 } = {}) {
  const hub = createPeerHub({ token: TOKEN });
  const onPeerConnection = deliveryDelayMs === 0 ? hub.handleConnection : (ws) => hub.handleConnection(new Proxy(ws, {
    get(t, k) {
      if (k === "on") {
        return (event, fn) => t.on(event, event !== "message" ? fn : (raw, ...rest) => {
          if (JSON.parse(String(raw)).type === "request") setTimeout(() => fn(raw, ...rest), deliveryDelayMs);
          else fn(raw, ...rest);
        });
      }
      const v = Reflect.get(t, k, t);
      return typeof v === "function" ? v.bind(t) : v;
    },
  }));
  const bridge = createBridge({ port: 0, token: TOKEN, requestTimeoutMs, peerPath: PEER_PATH, onPeerConnection, onExtensionChange: hub.broadcastStatus });
  hub.attach(bridge);
  await bridge.start();
  return { hub, bridge, port: bridge.boundPort() };
}

// Fake extension: records every request frame; `answer` decides replies.
async function fakeExtension(port, answer = (m) => ({ ok: true, payload: { op: m.op, tabId: m.tabId } })) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, { origin: ORIGIN });
  await new Promise((res, rej) => { ws.once("open", res); ws.once("error", rej); });
  const frames = [];
  const paired = new Promise((res) => ws.on("message", (raw) => { if (JSON.parse(String(raw)).type === "auth_ok") res(); }));
  ws.on("message", (raw) => {
    const m = JSON.parse(String(raw));
    if (m.type !== "request") return;
    m.receivedAt = Date.now();
    frames.push(m);
    const reply = answer(m);
    if (reply) ws.send(JSON.stringify({ type: "response", id: m.id, ...reply }));
  });
  ws.send(JSON.stringify({ type: "auth", token: TOKEN }));
  await paired; // wait for auth_ok itself, not a fixed delay (flaky under load)
  await tick(20);
  return { ws, frames };
}

async function peer(port, extra = {}) {
  const p = createPeerClient({ port, token: TOKEN, ...extra });
  assert.equal(await p.ensure(), true);
  return p;
}

test("root cause regression: a second bind rejects cleanly, no unhandled error", async () => {
  const a = createBridge({ port: 0 });
  await a.start();
  const b = createBridge({ port: a.boundPort() });
  await assert.rejects(b.start(), (e) => e.code === "EADDRINUSE");
  await tick();
  await a.close();
});

test("two peers share one extension pairing with isolated, colliding-id-safe routing", async () => {
  const { bridge, port } = await startHub();
  // The extension answers out of order: the first request waits.
  let held = null;
  const ext = await fakeExtension(port, (m) => {
    if (m.tabId === 1 && !held) { held = m; return null; }
    return { ok: true, payload: { tabId: m.tabId } };
  });
  const a = await peer(port);
  const b = await peer(port);
  assert.equal(a.isConnected(), true);
  assert.equal(b.isConnected(), true);
  // Both peers use local id q1 for their first request; results must not cross.
  const ra = a.request("snapshot", 1);
  await tick(30);
  const rb = b.request("snapshot", 2);
  assert.deepEqual(await rb, { tabId: 2 });
  ext.ws.send(JSON.stringify({ type: "response", id: held.id, ok: true, payload: { tabId: 1 } }));
  assert.deepEqual(await ra, { tabId: 1 });
  const ids = ext.frames.map((f) => f.id);
  assert.equal(new Set(ids).size, ids.length, "the extension sees globally unique bridge ids");
  assert.ok(ext.frames.every((f) => typeof f.expiresAt === "number"), "deadlines still travel with every frame");
  await a.close(); await b.close(); ext.ws.close(); await bridge.close();
});

test("closing one peer leaves the other usable; its in-flight result is dropped", async () => {
  const { bridge, port } = await startHub();
  let first = true;
  const ext = await fakeExtension(port, (m) => { if (first) { first = false; return null; } return { ok: true, payload: { tabId: m.tabId } }; });
  const a = await peer(port);
  const b = await peer(port);
  const pendingA = assert.rejects(a.request("snapshot", 1), (e) => e.code === "BRIDGE_UNAVAILABLE");
  await tick(30);
  await a.close();
  await pendingA;
  ext.ws.send(JSON.stringify({ type: "response", id: ext.frames[0].id, ok: true, payload: { late: true } }));
  assert.deepEqual(await b.request("snapshot", 3), { tabId: 3 });
  assert.equal(bridge.isConnected(), true, "the extension pairing survives a chat closing");
  await b.close(); ext.ws.close(); await bridge.close();
});

test("extension disconnect fails every peer's pending work; reconnect replays nothing", async () => {
  const { bridge, port } = await startHub();
  const ext = await fakeExtension(port, () => null);
  const a = await peer(port);
  const b = await peer(port);
  // Handlers attach immediately: both reject together on the drop.
  const pa = assert.rejects(a.request("execute", 1, { action: "click", elementId: "el-1", documentSessionId: "d", revision: 1 }), (e) => e.code === "NO_EXTENSION");
  const pb = assert.rejects(b.request("snapshot", 2), (e) => e.code === "NO_EXTENSION");
  await tick(30);
  ext.ws.close();
  await pa;
  await pb;
  await tick(30);
  assert.equal(a.isConnected(), false, "status is pushed to peers");
  const ext2 = await fakeExtension(port);
  for (let i = 0; i < 40 && !a.isConnected(); i++) await tick(25);
  await tick(100);
  assert.equal(ext2.frames.length, 0, "nothing pending is resent to the new extension connection");
  assert.equal(a.isConnected(), true);
  assert.deepEqual(await a.request("snapshot", 5), { op: "snapshot", tabId: 5 });
  await a.close(); await b.close(); ext2.ws.close(); await bridge.close();
});

test("deadlines: an unanswered request times out per caller and the late answer is dropped", async () => {
  const { bridge, port } = await startHub({ requestTimeoutMs: 120 });
  const ext = await fakeExtension(port, () => null);
  const a = await peer(port);
  const b = await peer(port);
  await assert.rejects(a.request("snapshot", 1), (e) => e.code === "TIMEOUT");
  ext.ws.send(JSON.stringify({ type: "response", id: ext.frames[0].id, ok: true, payload: {} }));
  await tick();
  // Only a's request reached the extension; b is unaffected and still usable.
  assert.equal(ext.frames.length, 1);
  await assert.rejects(b.request("snapshot", 2), (e) => e.code === "TIMEOUT");
  await a.close(); await b.close(); ext.ws.close(); await bridge.close();
});

test("a mutation that loses the shared bridge mid-flight is outcome_unknown and never retried", async () => {
  const { bridge, port } = await startHub();
  const ext = await fakeExtension(port, () => null);
  const a = await peer(port);
  const click = toolHandlers(a).find((d) => d.name === "click");
  const out = click.handler({ tabId: 1, elementId: "el-1", documentSessionId: "d", revision: 1 });
  await tick(50);
  await bridge.close(); // the shared bridge process dies
  const res = await out;
  assert.equal(res.structuredContent.status, "outcome_unknown");
  assert.equal(ext.frames.length, 1, "dispatched once, never retried");
  await a.close();
});

test("duplicate request ids from one peer are forwarded once; unknown ops are refused", async () => {
  const { bridge, port } = await startHub();
  const ext = await fakeExtension(port);
  const raw = new WebSocket(`ws://127.0.0.1:${port}${PEER_PATH}`);
  const inbox = [];
  raw.on("message", (d) => inbox.push(JSON.parse(String(d))));
  await new Promise((r) => raw.once("open", r));
  const hello = await nextFrame(inbox, "hello");
  const nonce = "b".repeat(32);
  raw.send(JSON.stringify({ type: "peer_auth", protocol: 1, nonce, proof: peerProof(TOKEN, "peer", hello.nonce, nonce) }));
  const ok = await nextFrame(inbox, "peer_ok");
  assert.equal(ok.type, "peer_ok");
  assert.equal(ok.proof, peerProof(TOKEN, "hub", hello.nonce, nonce), "the hub proves the token back");
  const frame = JSON.stringify({ type: "request", id: "x1", op: "execute", tabId: 1, params: { action: "click", elementId: "el-1", documentSessionId: "d", revision: 1 }, expiresAt: Date.now() + 5000 });
  raw.send(frame); raw.send(frame);
  raw.send(JSON.stringify({ type: "request", id: "x2", op: "approve", tabId: 1, params: {}, expiresAt: Date.now() + 5000 }));
  await tick(120);
  assert.equal(ext.frames.length, 1, "duplicate delivery never dispatches twice");
  const responses = inbox.filter((m) => m.type === "response");
  assert.equal(responses.filter((m) => m.id === "x1").length, 1);
  assert.equal(responses.find((m) => m.id === "x2").error.code, "INVALID_REQUEST", "no approval op exists for peers");
  raw.close(); ext.ws.close(); await bridge.close();
});

test("peer path: wrong token is refused, and web origins cannot take the peer role", async () => {
  const { bridge, port } = await startHub();
  const wrong = createPeerClient({ port, token: "c".repeat(64) });
  assert.equal(await wrong.ensure(), false);
  assert.equal(wrong.lastError().code, "PORT_CONFLICT");
  await assert.rejects(wrong.request("tabs", null), (e) => e.code === "PORT_CONFLICT" && /Nothing was sent/.test(e.message));
  await wrong.close();
  const web = new WebSocket(`ws://127.0.0.1:${port}${PEER_PATH}`, { origin: "https://evil.test" });
  assert.equal(await new Promise((r) => web.once("close", (c) => r(c))), 4403);
  assert.equal(bridge.isConnected(), false);
  await bridge.close();
});

test("unrelated port owners are never trusted, never sent a request or the token, never replaced", async () => {
  // 1) Plain HTTP service.
  const seen = [];
  const http = createServer((req, res) => { seen.push(req.url); res.writeHead(200); res.end("not seeyable"); });
  await new Promise((r) => http.listen(0, "127.0.0.1", r));
  let spawned = 0;
  const p1 = createPeerClient({ port: http.address().port, token: TOKEN, spawnHub: () => { spawned++; } });
  assert.equal(await p1.ensure(), false);
  assert.equal(p1.lastError().code, "PORT_CONFLICT");
  assert.equal(spawned, 0, "an occupied port never triggers a competing listener");
  await p1.close();
  await new Promise((r) => http.close(r));

  // 2) A WebSocket impostor that mimics the hello but cannot prove the token.
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise((r) => wss.once("listening", r));
  const received = [];
  wss.on("connection", (ws) => {
    ws.send(JSON.stringify({ type: "hello", protocol: 1, nonce: "d".repeat(32) }));
    ws.on("message", (d) => {
      received.push(String(d));
      ws.send(JSON.stringify({ type: "peer_ok", proof: "0".repeat(64), peerId: "fake", extensionConnected: true }));
    });
  });
  const p2 = createPeerClient({ port: wss.address().port, token: TOKEN });
  assert.equal(await p2.ensure(), false);
  assert.equal(p2.lastError().code, "PORT_CONFLICT");
  await assert.rejects(p2.request("snapshot", 1), (e) => e.code === "PORT_CONFLICT");
  assert.ok(!received.join("").includes(TOKEN), "the token itself never crosses the peer socket");
  assert.ok(received.every((f) => JSON.parse(f).type === "peer_auth"), "no request reaches an unauthenticated service");
  await p2.close();
  await new Promise((r) => wss.close(r));
});

test("no listener: the peer starts the shared bridge once and joins it", async () => {
  const probe = createBridge({ port: 0 });
  await probe.start();
  const port = probe.boundPort();
  await probe.close();
  let hub = null;
  let spawns = 0;
  const p = createPeerClient({ port, token: TOKEN, spawnHub: () => {
    spawns++;
    // Simulate the detached process coming up shortly after.
    setTimeout(async () => {
      const h = createPeerHub({ token: TOKEN });
      hub = createBridge({ port, token: TOKEN, peerPath: PEER_PATH, onPeerConnection: h.handleConnection, onExtensionChange: h.broadcastStatus });
      h.attach(hub);
      await hub.start();
    }, 300);
  } });
  assert.equal(await p.ensure(), true);
  assert.equal(spawns, 1);
  assert.equal(p.isConnected(), false, "linked but no extension paired yet");
  await assert.rejects(p.request("snapshot", 1), (e) => e.code === "NO_EXTENSION");
  await p.close();
  await hub.close();
});

const CLICK = { action: "click", elementId: "el-1", documentSessionId: "d", revision: 1 };

test("deadline survives a slow peer->hub hop: expired on arrival means zero execute frames", async () => {
  const { bridge, port } = await startHub({ deliveryDelayMs: 150 });
  const ext = await fakeExtension(port, () => ({ ok: true, payload: { ok: true, result: { verified: true } } }));
  const a = await peer(port, { requestTimeoutMs: 60 });
  const click = toolHandlers(a).find((d) => d.name === "click");
  const out = await click.handler({ tabId: 1, ...CLICK, elementId: "el-1" });
  assert.equal(out.structuredContent.status, "outcome_unknown", "the caller timed out; the outcome stays honestly unknown");
  assert.equal(out.structuredContent.error.code, "TIMEOUT");
  await tick(250); // the delayed frame has now reached the hub
  assert.equal(ext.frames.length, 0, "an expired request never reaches the extension, so it can never dispatch");
  await a.close(); ext.ws.close(); await bridge.close();
});

test("deadline: a live request over the same slow hop succeeds and keeps its ORIGINAL expiry", async () => {
  const { bridge, port } = await startHub({ deliveryDelayMs: 150 });
  const ext = await fakeExtension(port, () => ({ ok: true, payload: { ok: true, result: { verified: true } } }));
  const a = await peer(port, { requestTimeoutMs: 2000 });
  const before = Date.now();
  const out = await toolHandlers(a).find((d) => d.name === "click").handler({ tabId: 1, ...CLICK });
  assert.equal(out.structuredContent.status, "verified");
  assert.equal(ext.frames.length, 1);
  const { expiresAt: forwarded, receivedAt } = ext.frames[0];
  // The peer stamped issue + 2000 at least 150 ms (the slow hop) before
  // the extension received the frame. A deadline restarted downstream
  // would land at or after receivedAt + 2000; the original lands earlier.
  assert.ok(forwarded >= before + 2000, "the deadline is the peer's 2000 ms window, not the bridge default");
  assert.ok(forwarded <= receivedAt + 2000 - 140, "the hub never restarts or extends the issue-time deadline");
  await a.close(); ext.ws.close(); await bridge.close();
});

test("deadline: the bridge clamps far-future expiry and refuses missing or past expiry", async () => {
  const { bridge, port } = await startHub({ requestTimeoutMs: 300 });
  const ext = await fakeExtension(port);
  const raw = new WebSocket(`ws://127.0.0.1:${port}${PEER_PATH}`);
  const inbox = [];
  raw.on("message", (d) => inbox.push(JSON.parse(String(d))));
  await new Promise((r) => raw.once("open", r));
  const hello = await nextFrame(inbox, "hello");
  const nonce = "e".repeat(32);
  raw.send(JSON.stringify({ type: "peer_auth", protocol: 1, nonce, proof: peerProof(TOKEN, "peer", hello.nonce, nonce) }));
  await nextFrame(inbox, "peer_ok");
  const sentAt = Date.now();
  raw.send(JSON.stringify({ type: "request", id: "far", op: "snapshot", tabId: 1, params: {}, expiresAt: sentAt + 3600000 }));
  raw.send(JSON.stringify({ type: "request", id: "none", op: "execute", tabId: 1, params: CLICK }));
  raw.send(JSON.stringify({ type: "request", id: "past", op: "execute", tabId: 1, params: CLICK, expiresAt: sentAt - 1 }));
  await tick(150);
  assert.equal(ext.frames.length, 1, "only the live request is forwarded");
  assert.ok(ext.frames[0].expiresAt <= Date.now() + 300, "an over-long deadline is clamped to the bridge's own window");
  const by = (id) => inbox.find((m) => m.type === "response" && m.id === id);
  assert.equal(by("none").error.code, "INVALID_REQUEST");
  assert.equal(by("past").error.code, "REQUEST_EXPIRED");
  assert.equal(by("far").ok, true);
  raw.close(); ext.ws.close(); await bridge.close();
});
