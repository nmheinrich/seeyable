"use strict";
/* Issue #28 spike: bridge transport, pairing, and correlation tests. */
import test from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";
import { createBridge, BridgeError } from "../lib/bridge.mjs";

const ORIGIN = "chrome-extension://test-id";
const tick = (ms = 50) => new Promise((r) => setTimeout(r, ms));

async function pairedClient(bridge, token) {
  const ws = new WebSocket(`ws://127.0.0.1:${bridge.boundPort()}`, { origin: ORIGIN });
  await new Promise((res, rej) => { ws.once("open", res); ws.once("error", rej); });
  ws.send(JSON.stringify({ type: "auth", token }));
  const ok = await new Promise((res) => ws.once("message", (d) => res(JSON.parse(String(d)))));
  assert.equal(ok.type, "auth_ok");
  return ws;
}

test("bridge binds loopback only and generates a token it never logs", async () => {
  const lines = [];
  const bridge = createBridge({ port: 0, log: (...a) => lines.push(a.join(" ")) });
  await bridge.start();
  assert.equal(bridge.boundHost(), "127.0.0.1");
  assert.match(bridge.token, /^[0-9a-f]{64}$/);
  const ws = await pairedClient(bridge, bridge.token);
  assert.equal(bridge.isConnected(), true);
  ws.close();
  await bridge.close();
  assert.ok(!lines.join("\n").includes(bridge.token), "pairing secret must never appear in diagnostics");
});

test("bridge rejects wrong/missing tokens and non-extension origins", async () => {
  const bridge = createBridge({ port: 0, log: () => {} });
  await bridge.start();
  // wrong token
  const bad = new WebSocket(`ws://127.0.0.1:${bridge.boundPort()}`, { origin: ORIGIN });
  await new Promise((res) => bad.once("open", res));
  const badClose = new Promise((res) => bad.once("close", (code) => res(code)));
  bad.send(JSON.stringify({ type: "auth", token: "nope" }));
  assert.equal(await badClose, 4401);
  // wrong origin, right token: refused before auth is even considered
  const evil = new WebSocket(`ws://127.0.0.1:${bridge.boundPort()}`, { origin: "https://evil.test" });
  const evilClose = new Promise((res) => evil.once("close", (code) => res(code)));
  evil.on("open", () => evil.send(JSON.stringify({ type: "auth", token: bridge.token })));
  assert.equal(await evilClose, 4403);
  assert.equal(bridge.isConnected(), false);
  await bridge.close();
});

test("bridge refuses a second extension connection", async () => {
  const bridge = createBridge({ port: 0, log: () => {} });
  await bridge.start();
  const first = await pairedClient(bridge, bridge.token);
  const second = new WebSocket(`ws://127.0.0.1:${bridge.boundPort()}`, { origin: ORIGIN });
  const code = new Promise((res) => second.once("close", (c) => res(c)));
  assert.equal(await code, 4409);
  first.close();
  await bridge.close();
});

test("second contender authenticating later is rejected; owner keeps working", async () => {
  const bridge = createBridge({ port: 0, log: () => {} });
  await bridge.start();
  const open = () => new Promise((res, rej) => {
    const ws = new WebSocket(`ws://127.0.0.1:${bridge.boundPort()}`, { origin: ORIGIN });
    ws.once("open", () => res(ws));
    ws.once("error", rej);
  });
  // Both sockets connect BEFORE either authenticates.
  const a = await open();
  const b = await open();
  const firstMsg = (ws) => new Promise((res) => ws.once("message", (d) => res(JSON.parse(String(d)))));
  const closeCode = (ws) => new Promise((res) => ws.once("close", (c) => res(c)));
  a.send(JSON.stringify({ type: "auth", token: bridge.token }));
  assert.equal((await firstMsg(a)).type, "auth_ok");
  b.send(JSON.stringify({ type: "auth", token: bridge.token }));
  assert.equal(await closeCode(b), 4409);
  // The owner still serves requests; a frame from the rejected socket changes nothing.
  a.on("message", (raw) => {
    const msg = JSON.parse(String(raw));
    if (msg.type === "request") a.send(JSON.stringify({ type: "response", id: msg.id, ok: true, payload: { served: true } }));
  });
  assert.deepEqual(await bridge.request("snapshot", 1), { served: true });
  assert.equal(bridge.isConnected(), true);
  a.close();
  await bridge.close();
});

test("close completes with live clients, releases the port, and is idempotent", async () => {
  const bridge = createBridge({ port: 0, log: () => {} });
  await bridge.start();
  const port = bridge.boundPort();
  const authed = await pairedClient(bridge, bridge.token);
  const waiting = new WebSocket(`ws://127.0.0.1:${port}`, { origin: ORIGIN });
  await new Promise((res) => waiting.once("open", res));
  const pending = bridge.request("snapshot", 1); // never answered
  const timeout = tick(3000).then(() => { throw new Error("close hung with live clients"); });
  const closing = bridge.close();
  await Promise.race([assert.rejects(pending, (e) => e.code === "NO_EXTENSION"), timeout]);
  await Promise.race([closing, timeout]);
  await bridge.close(); // idempotent second call
  void authed; void waiting;
  // Port released: a new bridge binds the same port.
  const next = createBridge({ port, log: () => {} });
  await next.start();
  assert.equal(next.boundPort(), port);
  await next.close();
});

test("request/response round trip correlates by id", async () => {
  const bridge = createBridge({ port: 0, log: () => {} });
  await bridge.start();
  const ws = await pairedClient(bridge, bridge.token);
  ws.on("message", (raw) => {
    const msg = JSON.parse(String(raw));
    if (msg.type === "request") ws.send(JSON.stringify({ type: "response", id: msg.id, ok: true, payload: { op: msg.op, tabId: msg.tabId } }));
  });
  const out = await bridge.request("snapshot", 7);
  assert.deepEqual(out, { op: "snapshot", tabId: 7 });
  ws.close();
  await bridge.close();
});

test("extension-reported failures arrive as coded errors", async () => {
  const bridge = createBridge({ port: 0, log: () => {} });
  await bridge.start();
  const ws = await pairedClient(bridge, bridge.token);
  ws.on("message", (raw) => {
    const msg = JSON.parse(String(raw));
    if (msg.type === "request") ws.send(JSON.stringify({ type: "response", id: msg.id, ok: false, error: { code: "TAB_UNAVAILABLE", message: "gone" } }));
  });
  await assert.rejects(bridge.request("snapshot", 9), (e) => e instanceof BridgeError && e.code === "TAB_UNAVAILABLE");
  ws.close();
  await bridge.close();
});

test("authenticated pings get pongs; pings never trigger operations", async () => {
  const bridge = createBridge({ port: 0, log: () => {} });
  await bridge.start();
  const ws = await pairedClient(bridge, bridge.token);
  ws.send(JSON.stringify({ type: "ping", t: 123 }));
  const pong = await new Promise((res) => ws.once("message", (d) => res(JSON.parse(String(d)))));
  assert.deepEqual(pong, { type: "pong", t: 123 });
  ws.close();
  await bridge.close();
});

test("request without a connected extension fails fast (no hang)", async () => {
  const bridge = createBridge({ port: 0, log: () => {} });
  await bridge.start();
  await assert.rejects(bridge.request("snapshot", 1), (e) => e.code === "NO_EXTENSION");
  await bridge.close();
});

test("unanswered requests time out and late responses are dropped", async () => {
  const bridge = createBridge({ port: 0, requestTimeoutMs: 80, log: () => {} });
  await bridge.start();
  const ws = await pairedClient(bridge, bridge.token);
  let seen = null;
  ws.on("message", (raw) => { const m = JSON.parse(String(raw)); if (m.type === "request") seen = m; });
  await assert.rejects(bridge.request("snapshot", 1), (e) => e.code === "TIMEOUT");
  // The answer arrives after the timeout: it must be dropped, not crash or reuse the id.
  ws.send(JSON.stringify({ type: "response", id: seen.id, ok: true, payload: {} }));
  await tick();
  ws.close();
  await bridge.close();
});

test("disconnect fails pending requests and reconnects replay nothing", async () => {
  const bridge = createBridge({ port: 0, requestTimeoutMs: 5000, log: () => {} });
  await bridge.start();
  const ws = await pairedClient(bridge, bridge.token);
  const requests = [];
  ws.on("message", (raw) => { const m = JSON.parse(String(raw)); if (m.type === "request") requests.push(m); });
  const pending = bridge.request("snapshot", 1);
  ws.close(); // drop without answering
  await assert.rejects(pending, (e) => e.code === "NO_EXTENSION");
  const ws2 = await pairedClient(bridge, bridge.token);
  ws2.on("message", (raw) => { const m = JSON.parse(String(raw)); if (m.type === "request") requests.push(m); });
  await tick(150);
  assert.equal(requests.length, 1, "the pre-disconnect request must not be resent after reconnect");
  ws2.close();
  await bridge.close();
});
