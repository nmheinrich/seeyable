"use strict";
/* Issue #28 lifecycle: the REAL lib/bridge-client.js in a VM with mocked
 * chrome/WebSocket/timers. Deterministic ownership tests, not UI mocks. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const clientJs = readFileSync(join(here, "../lib/bridge-client.js"), "utf8");
const flush = async (n = 10) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

function makeWorld() {
  const sockets = [];
  const timers = [];
  const intervals = [];
  let timerSeq = 0;
  const store = {};
  const world = {
    sessionGetImpl: async () => ({ ...store }),
    tabsGetImpl: null,
    sendMessageImpl: null,
    runtimeSendImpl: null,
    sessionSetImpl: null,
    tabsCalls: [],
    sentMessages: [],
    runtimeMessages: [],
    now: Date.now(),
  };
  const RealDate = Date;
  class FakeSocket {
    static OPEN = 1;
    static CONNECTING = 0;
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.handlers = {};
      this.sent = [];
      this.closed = null;
      sockets.push(this);
    }
    addEventListener(type, fn) { (this.handlers[type] = this.handlers[type] || []).push(fn); }
    send(data) { this.sent.push(String(data)); }
    close(code, reason) {
      if (this.closed) return;
      this.closed = { code, reason };
      this.readyState = 3;
      setImmediate(() => this.emit("close", { code })); // like a real socket
    }
    emit(type, event) { for (const fn of this.handlers[type] || []) fn(event || {}); }
  }
  const sandbox = {
    console: { info: () => {}, warn: () => {}, error: () => {} },
    WebSocket: FakeSocket,
    setTimeout: (fn, ms) => { const id = ++timerSeq; timers.push({ id, fn, ms }); return id; },
    clearTimeout: (id) => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); },
    setInterval: (fn, ms) => { const id = ++timerSeq; intervals.push({ id, fn, ms }); return id; },
    clearInterval: (id) => { const i = intervals.findIndex((t) => t.id === id); if (i >= 0) intervals.splice(i, 1); },
    Date: class extends RealDate { static now() { return world.now; } },
    chrome: {
      storage: {
        session: {
          get: (...a) => world.sessionGetImpl(...a),
          set: async (obj) => world.sessionSetImpl ? world.sessionSetImpl(obj) : Object.assign(store, obj),
          remove: async (keys) => { for (const k of [].concat(keys)) delete store[k]; },
        },
      },
      tabs: {
        get: async (id) => {
          world.tabsCalls.push(["get", id]);
          if (world.tabsGetImpl) return world.tabsGetImpl(id);
          if (id !== 7) throw new Error("No tab");
          return { id };
        },
        query: async () => [{ id: 7, title: "Demo", url: "http://x/" }],
        sendMessage: async (tabId, msg) => {
          world.tabsCalls.push(["send", tabId, msg]);
          world.sentMessages.push(msg);
          if (world.sendMessageImpl) return world.sendMessageImpl(tabId, msg);
          return { ok: true, snapshot: { kind: "dom-aria" } };
        },
      },
      runtime: {
        sendMessage: async (msg) => { world.runtimeMessages.push(msg); return world.runtimeSendImpl ? world.runtimeSendImpl(msg) : {}; },
      },
    },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(clientJs, sandbox);
  return {
    world, sockets, timers, intervals, store,
    api: {
      connect: sandbox.__seeyableBridgeConnect,
      disconnect: sandbox.__seeyableBridgeDisconnect,
      status: sandbox.__seeyableBridgeStatus,
      restore: sandbox.__seeyableBridgeMaybeReconnect,
    },
    fireTimers: async () => { const pending = timers.splice(0); for (const t of pending) await t.fn(); await flush(); },
  };
}

test("bridge-client: Disconnect during a held token read opens no socket", async () => {
  const t = makeWorld();
  let release;
  const held = new Promise((res) => { release = res; });
  t.world.sessionGetImpl = () => held;
  const connecting = t.api.connect({ token: "tok", port: 6123 });
  await flush();
  await t.api.disconnect();
  release({ bridgeToken: "tok" });
  await connecting;
  await flush();
  assert.equal(t.sockets.length, 0, "no WebSocket may be constructed after Disconnect won");
  assert.deepEqual(JSON.parse(JSON.stringify(t.api.status())), { ok: true, wanted: false, connected: false, port: 6123 });
  assert.equal(t.timers.length, 0, "no reconnect may be scheduled");
});

test("bridge-client: obsolete socket callbacks never authenticate or disturb ownership", async () => {
  const t = makeWorld();
  t.store.bridgeToken = "tok";
  await t.api.connect({ port: 6123 });
  await flush();
  assert.equal(t.sockets.length, 1);
  const stale = t.sockets[0];
  await t.api.disconnect();
  // Late open/message/close from the superseded socket must be inert.
  stale.readyState = 1;
  stale.emit("open");
  await flush();
  assert.deepEqual(stale.sent, [], "obsolete socket must not send auth");
  stale.emit("message", { data: JSON.stringify({ type: "request", id: "r1", op: "tabs", tabId: null }) });
  await flush();
  assert.deepEqual(t.world.tabsCalls, [], "obsolete socket must not drive tab APIs");
  stale.emit("close", { code: 1006 });
  await flush();
  assert.equal(t.timers.length, 0, "obsolete close must not schedule a reconnect");
  assert.equal(t.api.status().connected, false);
});

test("bridge-client: status reports paired only after auth_ok; requests wait for it", async () => {
  const t = makeWorld();
  t.store.bridgeToken = "tok";
  await t.api.connect({ port: 6123 });
  await flush();
  const sock = t.sockets[0];
  sock.readyState = 1;
  sock.emit("open");
  await flush();
  assert.equal(t.api.status().connected, false, "OPEN without auth_ok is not connected");
  sock.emit("message", { data: JSON.stringify({ type: "request", id: "r1", op: "tabs", tabId: null }) });
  await flush();
  assert.deepEqual(t.world.tabsCalls, [], "requests before auth_ok are not handled");
  sock.emit("message", { data: JSON.stringify({ type: "auth_ok" }) });
  await flush();
  assert.equal(t.api.status().connected, true);
  sock.emit("message", { data: JSON.stringify({ type: "request", id: "r2", op: "tabs", tabId: null }) });
  await flush();
  assert.ok(sock.sent.some((s) => s.includes('"r2"') && s.includes('"ok":true')), "paired socket answers requests");
});

test("bridge-client: wrong-token close leaves status disconnected and schedules a retry", async () => {
  const t = makeWorld();
  t.store.bridgeToken = "wrong";
  await t.api.connect({ port: 6123 });
  await flush();
  const sock = t.sockets[0];
  sock.readyState = 1;
  sock.emit("open");
  await flush();
  sock.emit("close", { code: 4401 }); // server rejected the token
  await flush();
  assert.deepEqual(JSON.parse(JSON.stringify(t.api.status())), { ok: true, wanted: true, connected: false, port: 6123 });
  assert.equal(t.timers.length, 1, "a current-socket drop schedules one reconnect");
  await t.api.disconnect();
  assert.equal(t.timers.length, 0, "disconnect clears the pending reconnect");
  assert.equal(t.sockets.length, 1, "no further socket is opened after disconnect");
});

test("bridge-client: identical repeated Connect preserves the paired socket", async () => {
  const t = makeWorld();
  t.store.bridgeToken = "tok";
  await t.api.connect({ token: "tok", port: 6123 });
  await flush();
  const sock = t.sockets[0];
  sock.readyState = 1;
  sock.emit("open");
  sock.emit("message", { data: JSON.stringify({ type: "auth_ok" }) });
  await flush();
  assert.equal(t.api.status().connected, true);
  await t.api.connect({ token: "tok", port: 6123 });
  await flush();
  assert.equal(t.sockets.length, 1, "repeat must not open a second socket");
  sock.emit("message", { data: JSON.stringify({ type: "request", id: "r1", op: "tabs", tabId: null }) });
  await flush();
  assert.ok(sock.sent.some((s) => s.includes('"r1"')), "existing socket still answers after identical repeat");
  assert.equal(t.api.status().connected, true);
});

test("bridge-client: changed credentials deliberately replace the connection", async () => {
  const t = makeWorld();
  t.store.bridgeToken = "old";
  await t.api.connect({ token: "old", port: 6123 });
  await flush();
  const first = t.sockets[0];
  first.readyState = 1;
  first.emit("open");
  first.emit("message", { data: JSON.stringify({ type: "auth_ok" }) });
  await flush();
  await t.api.connect({ token: "new", port: 6123 });
  await flush();
  assert.ok(first.closed, "old socket is closed on replacement");
  assert.equal(t.sockets.length, 2);
  assert.equal(t.api.status().connected, false, "old pairing is not reported as the new connection");
  first.emit("message", { data: JSON.stringify({ type: "request", id: "rx", op: "tabs", tabId: null }) });
  await flush();
  assert.ok(!first.sent.some((s) => s.includes('"rx"')), "superseded socket answers nothing");
  const second = t.sockets[1];
  second.readyState = 1;
  second.emit("open");
  second.emit("message", { data: JSON.stringify({ type: "auth_ok" }) });
  await flush();
  assert.equal(t.api.status().connected, true);
  assert.equal(t.store.bridgeToken, "new");
});

test("bridge-client: changed port replaces; Disconnect still wins over the repeat read", async () => {
  const t = makeWorld();
  t.store.bridgeToken = "tok";
  await t.api.connect({ token: "tok", port: 6123 });
  await flush();
  const first = t.sockets[0];
  first.readyState = 1;
  first.emit("open");
  first.emit("message", { data: JSON.stringify({ type: "auth_ok" }) });
  await flush();
  await t.api.connect({ token: "tok", port: 7000 });
  await flush();
  assert.ok(first.closed, "old socket is closed on port change");
  assert.equal(t.sockets[1].url, "ws://127.0.0.1:7000");
  // Disconnect during the identical-repeat token read wins: no new socket.
  let release;
  const held = new Promise((res) => { release = res; });
  t.world.sessionGetImpl = () => held;
  const second = t.sockets[1];
  second.readyState = 1;
  second.emit("open");
  second.emit("message", { data: JSON.stringify({ type: "auth_ok" }) });
  await flush();
  const repeat = t.api.connect({ token: "tok", port: 7000 });
  await flush();
  await t.api.disconnect();
  release({ bridgeToken: "tok" });
  await repeat;
  await flush();
  assert.equal(t.sockets.length, 2, "no socket may open after Disconnect won the repeat");
  assert.equal(t.api.status().wanted, false);
});

test("bridge-client: heartbeat pings while paired and pong keeps status healthy", async () => {
  const t = makeWorld();
  t.store.bridgeToken = "tok";
  await t.api.connect({ token: "tok", port: 6123 });
  await flush();
  const sock = t.sockets[0];
  sock.readyState = 1;
  sock.emit("open");
  await flush();
  assert.equal(t.intervals.length, 0, "no heartbeat before auth_ok");
  sock.emit("message", { data: JSON.stringify({ type: "auth_ok" }) });
  await flush();
  assert.equal(t.intervals.length, 1);
  assert.equal(t.intervals[0].ms, 20000);
  t.world.now += 20000;
  t.intervals[0].fn();
  assert.ok(sock.sent.some((s) => s.includes('"ping"')), "paired socket sends ping");
  assert.equal(t.api.status().connected, true);
  t.world.now += 1000;
  sock.emit("message", { data: JSON.stringify({ type: "pong", t: 1 }) });
  await flush();
  t.world.now += 44000; // 44 s since pong: still fresh
  assert.equal(t.api.status().connected, true);
});

test("bridge-client: stale heartbeat kills the socket and schedules recovery", async () => {
  const t = makeWorld();
  t.store.bridgeToken = "tok";
  await t.api.connect({ token: "tok", port: 6123 });
  await flush();
  const sock = t.sockets[0];
  sock.readyState = 1;
  sock.emit("open");
  sock.emit("message", { data: JSON.stringify({ type: "auth_ok" }) });
  await flush();
  t.world.now += 46000; // past the 45 s dead threshold without a pong
  assert.equal(t.api.status().connected, false, "dead socket is not reported as connected");
  t.intervals[0].fn();
  await flush();
  assert.ok(sock.closed, "stale connection is closed");
  assert.equal(t.timers.length, 1, "recovery is scheduled");
  assert.equal(t.intervals.length, 0, "dead heartbeat stops itself");
});

test("bridge-client: disconnect stops the heartbeat; superseded timers stay inert", async () => {
  const t = makeWorld();
  t.store.bridgeToken = "tok";
  await t.api.connect({ token: "tok", port: 6123 });
  await flush();
  const sock = t.sockets[0];
  sock.readyState = 1;
  sock.emit("open");
  sock.emit("message", { data: JSON.stringify({ type: "auth_ok" }) });
  await flush();
  const staleBeat = t.intervals[0].fn;
  await t.api.disconnect();
  assert.equal(t.intervals.length, 0, "disconnect clears the heartbeat");
  const sentBefore = sock.sent.length;
  staleBeat(); // a stray fire after disconnect must do nothing
  await flush();
  assert.equal(sock.sent.length, sentBefore, "stale heartbeat sends nothing");
  assert.equal(t.sockets.length, 1, "no new socket from a stale heartbeat");
  assert.equal(t.api.status().wanted, false);
});

test("bridge-client: restore runs once per lifetime and Disconnect wins over it", async () => {
  const t = makeWorld();
  t.store.bridgeToken = "tok";
  t.store.bridgeWanted = true;
  t.store.bridgePort = 6123;
  await t.api.restore();
  await t.api.restore();
  await flush();
  assert.equal(t.sockets.length, 1, "duplicate restores open one socket");
  // Held restore read + Disconnect: nothing further opens.
  const t2 = makeWorld();
  t2.store.bridgeToken = "tok";
  t2.store.bridgeWanted = true;
  let release;
  t2.world.sessionGetImpl = () => new Promise((res) => { release = () => res({ ...t2.store }); });
  const restoring = t2.api.restore();
  await flush();
  await t2.api.disconnect();
  release();
  await restoring;
  await flush();
  assert.equal(t2.sockets.length, 0, "explicit Disconnect overrides a pending restore");
  assert.equal(t2.api.status().wanted, false);
});

async function pairedWorld() {
  const t = makeWorld();
  t.store.bridgeToken = "tok";
  await t.api.connect({ token: "tok", port: 6123 });
  await flush();
  const sock = t.sockets[0];
  sock.readyState = 1;
  sock.emit("open");
  sock.emit("message", { data: JSON.stringify({ type: "auth_ok" }) });
  await flush();
  return { t, sock };
}
const responseFrames = (sock) => sock.sent.map((s) => JSON.parse(s)).filter((m) => m.type === "response");

test("bridge-client: execute reaches the shared executor as mcp; a hold hints the panel", async () => {
  const { t, sock } = await pairedWorld();
  t.world.sendMessageImpl = async () => ({
    ok: false,
    error: { code: "CONFIRMATION_REQUIRED", message: "Held." },
    confirmation: { challengeId: "ch-1", action: "click", elementId: "el-1" },
    newSnapshotDiff: null, documentSessionId: "doc-A", revision: 1,
  });
  sock.emit("message", { data: JSON.stringify({ type: "request", id: "e1", op: "execute", tabId: 7, params: { action: "click", elementId: "el-1", documentSessionId: "doc-A", revision: 1 } }) });
  await flush();
  assert.equal(t.world.sentMessages.length, 1);
  const forwarded = t.world.sentMessages[0];
  assert.equal(forwarded.type, "SEEYABLE_EXECUTE_ACTION");
  assert.equal(forwarded.request.source, "mcp", "audit source is set in trusted extension code");
  assert.equal(forwarded.request.action, "click");
  assert.ok(!("confirmed" in forwarded.request) && !("challengeId" in forwarded.request) && !("token" in forwarded.request), "no approval-shaped fields cross");
  const responses = responseFrames(sock);
  assert.equal(responses.length, 1);
  assert.equal(responses[0].ok, true, "the executor response is the bridge payload");
  assert.equal(responses[0].payload.error.code, "CONFIRMATION_REQUIRED");
  assert.deepEqual(JSON.parse(JSON.stringify(t.world.runtimeMessages)), [{ type: "SEEYABLE_MCP_CONFIRMATION_HINT", tabId: 7 }], "panel gets an unauthoritative hint only");
});

test("bridge-client: duplicate request frame dispatches exactly once", async () => {
  const { t, sock } = await pairedWorld();
  let executions = 0;
  t.world.sendMessageImpl = async () => { executions += 1; return { ok: true, result: { verified: true }, documentSessionId: "doc-A", revision: 2 }; };
  const frame = JSON.stringify({ type: "request", id: "dup-1", op: "execute", tabId: 7, params: { action: "fill", elementId: "el-1", documentSessionId: "doc-A", revision: 1, value: "Ada" } });
  sock.emit("message", { data: frame });
  sock.emit("message", { data: frame });
  await flush();
  assert.equal(executions, 1, "the same request id never dispatches twice");
  assert.equal(responseFrames(sock).length, 1);
});

test("bridge-client: malformed execute params are rejected before touching the tab", async () => {
  const { t, sock } = await pairedWorld();
  sock.emit("message", { data: JSON.stringify({ type: "request", id: "bad-1", op: "execute", tabId: 7, params: { action: "click", elementId: "not-an-id", documentSessionId: "doc-A", revision: 1 } }) });
  sock.emit("message", { data: JSON.stringify({ type: "request", id: "bad-2", op: "execute", tabId: 7, params: { action: "click", elementId: "el-1", documentSessionId: "doc-A", revision: 1, approved: true } }) });
  await flush();
  assert.deepEqual(t.world.sentMessages, [], "invalid params never reach the page");
  const responses = responseFrames(sock);
  assert.equal(responses.length, 2);
  assert.ok(responses.every((r) => r.ok === false && r.error.code === "INVALID_REQUEST"));
});

test("bridge-client: a superseded connection performs no mutation after tab lookup", async () => {
  const { t, sock } = await pairedWorld();
  let releaseGet;
  t.world.tabsGetImpl = () => new Promise((res) => { releaseGet = () => res({ id: 7 }); });
  sock.emit("message", { data: JSON.stringify({ type: "request", id: "own-1", op: "execute", tabId: 7, params: { action: "fill", elementId: "el-1", documentSessionId: "doc-A", revision: 1, value: "Ada" } }) });
  await flush();
  await t.api.disconnect(); // ownership moves on while the tab lookup is held
  releaseGet();
  await flush();
  assert.deepEqual(t.world.sentMessages, [], "nothing is forwarded once the connection is superseded");
});

test("bridge-client: expired frames never forward; expiry during lookup kills the mutation", async () => {
  const { t, sock } = await pairedWorld();
  const execFrame = (id, expiresAt) => JSON.stringify({
    type: "request", id, op: "execute", tabId: 7,
    params: { action: "click", elementId: "el-1", documentSessionId: "doc-A", revision: 1 },
    expiresAt,
  });
  // Already expired on arrival.
  sock.emit("message", { data: execFrame("exp-1", 1) });
  await flush();
  assert.deepEqual(t.world.sentMessages, [], "an expired frame never reaches the page");
  assert.equal(responseFrames(sock)[0].error.code, "REQUEST_EXPIRED");

  // Live on arrival, expires while the tab lookup is held (the exact
  // reviewer reproduction shape: connection stays current throughout).
  let release;
  t.world.tabsGetImpl = () => new Promise((r) => { release = () => r({ id: 7 }); });
  sock.emit("message", { data: execFrame("exp-2", new Date().getTime() + 30) });
  await flush();
  await new Promise((r) => setTimeout(r, 60)); // real time passes the deadline
  release();
  await flush();
  assert.deepEqual(t.world.sentMessages, [], "expiry during the pre-dispatch wait still forwards nothing");

  // A live frame forwards and carries its deadline into the executor.
  t.world.tabsGetImpl = null;
  let forwarded = null;
  t.world.sendMessageImpl = async (_tab, msg) => { forwarded = msg; return { ok: true, result: { verified: true }, documentSessionId: "doc-A", revision: 2 }; };
  const deadline = new Date().getTime() + 60000;
  sock.emit("message", { data: execFrame("exp-3", deadline) });
  await flush();
  assert.equal(forwarded.type, "SEEYABLE_EXECUTE_ACTION");
  assert.equal(forwarded.request.deadline, deadline, "the executor re-checks the same deadline at dispatch");
});

test("bridge-client: read_section forwards bounded params and returns the section", async () => {
  const { t, sock } = await pairedWorld();
  const section = { elementId: "el-1", heading: "Form", text: "Hello", truncated: false, charCount: 5, documentSessionId: "doc-A", revision: 1 };
  t.world.sendMessageImpl = async () => ({ ok: true, section });
  sock.emit("message", { data: JSON.stringify({ type: "request", id: "rs-1", op: "read_section", tabId: 7, params: { elementId: "el-1", documentSessionId: "doc-A", revision: 1, maxChars: 500 } }) });
  await flush();
  assert.equal(t.world.sentMessages[0].type, "SEEYABLE_READ_SECTION");
  assert.equal(t.world.sentMessages[0].maxChars, 500);
  const responses = responseFrames(sock);
  assert.deepEqual(responses[0].payload, section);
});

test("bridge-client: fired reconnect timer from a superseded generation does nothing", async () => {
  const t = makeWorld();
  t.store.bridgeToken = "tok";
  await t.api.connect({ port: 6123 });
  await flush();
  const sock = t.sockets[0];
  sock.readyState = 1;
  sock.emit("open");
  sock.emit("message", { data: JSON.stringify({ type: "auth_ok" }) });
  await flush();
  sock.emit("close", { code: 1006 });
  await flush();
  assert.equal(t.timers.length, 1);
  await t.api.disconnect(); // supersedes the generation; clears the timer
  await t.fireTimers(); // even if a stale timer callback ran, it must be inert
  assert.equal(t.sockets.length, 1, "stale timer must not open a new socket");
  assert.equal(t.api.status().wanted, false);
});


for (const failedChannel of ["runtime", "session", "both"]) {
  test(`bridge-client: a held action survives ${failedChannel} notification failure without replay`, async () => {
    const { t, sock } = await pairedWorld();
    const hold = { ok: false, error: { code: "CONFIRMATION_REQUIRED" }, confirmation: { challengeId: "private-challenge" } };
    t.world.sendMessageImpl = async () => hold;
    if (failedChannel !== "session") t.world.runtimeSendImpl = async () => { throw new Error("no runtime receiver"); };
    if (failedChannel !== "runtime") t.world.sessionSetImpl = async () => { throw new Error("storage unavailable"); };
    sock.emit("message", { data: JSON.stringify({ type: "request", id: "held", op: "execute", tabId: 7, params: { action: "click", elementId: "el-1", documentSessionId: "doc-A", revision: 1 } }) });
    await flush();
    assert.equal(t.world.sentMessages.length, 1, "notification failures never retry the executor");
    assert.deepEqual(JSON.parse(JSON.stringify(responseFrames(sock)[0].payload)), hold, "the executor's held response stays authoritative");
    assert.equal(t.world.runtimeMessages[0].type, "SEEYABLE_MCP_CONFIRMATION_HINT");
    if (failedChannel === "runtime") {
      assert.equal(t.store.mcpConfirmationHint.tabId, 7);
      assert.deepEqual(Object.keys(t.store.mcpConfirmationHint).sort(), ["nonce", "tabId"], "session fallback stores no challenge or action data");
    }
  });
}
