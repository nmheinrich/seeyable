"use strict";
/* Cross-chat startup: several REAL stdio server processes (as MCP desktop
 * clients launch them, one per chat) against one REAL shared bridge
 * process. The extension side is a scripted WebSocket client using the
 * extension's real protocol (mocked extension, real processes). */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = dirname(fileURLToPath(import.meta.url));
const SERVER = join(here, "../server.mjs");
const tick = (ms = 50) => new Promise((r) => setTimeout(r, ms));

async function freePort() {
  const s = createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
}

function listenerPids(port) {
  try {
    return execFileSync("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" }).trim().split("\n").filter(Boolean).map(Number);
  } catch { return []; }
}

async function startClient(port, env, name) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER, "--port", String(port)],
    env: { ...process.env, SEEYABLE_BRIDGE_IDLE_MS: "800", ...env },
    stderr: "ignore",
  });
  const client = new Client({ name, version: "0.0.0" }, { capabilities: {} });
  await client.connect(transport); // MCP initialize must succeed regardless of the bridge
  return client;
}

// Scripted extension: reconnects like the real worker, records frames.
function fakeExtension(port, token, { answer } = {}) {
  const ext = { frames: [], ws: null, stopped: false, paired: false };
  const reply = answer || ((m) => ({ ok: true, payload: { tabId: m.tabId, op: m.op } }));
  const connect = () => {
    if (ext.stopped) return;
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { origin: "chrome-extension://fake-ext" });
    ext.ws = ws;
    ws.on("open", () => ws.send(JSON.stringify({ type: "auth", token })));
    ws.on("message", (raw) => {
      const m = JSON.parse(String(raw));
      if (m.type === "auth_ok") { ext.paired = true; return; }
      if (m.type !== "request") return;
      ext.frames.push(m);
      const r = reply(m);
      if (r) setTimeout(() => ws.send(JSON.stringify({ type: "response", id: m.id, ...r })), r.delayMs || 0);
    });
    ws.on("error", () => {});
    ws.on("close", () => { ext.paired = false; setTimeout(connect, 100); });
  };
  connect();
  ext.stop = () => { ext.stopped = true; try { ext.ws.terminate(); } catch {} };
  ext.waitPaired = async () => { for (let i = 0; i < 100 && !ext.paired; i++) await tick(50); assert.equal(ext.paired, true, "fake extension paired"); };
  return ext;
}

async function snapshot(client, tabId) {
  return client.callTool({ name: "page_snapshot", arguments: { tabId } });
}

async function waitFor(fn, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await tick(100); }
  return false;
}

test("three concurrent stdio processes initialize, share one bridge, and survive each other closing", async () => {
  const port = await freePort();
  const stateDir = mkdtempSync(join(tmpdir(), "seeyable-mp-"));
  const env = { SEEYABLE_STATE_DIR: stateDir }; // no env token: the generated-file path
  // Startup contention: all three start at once.
  const [a, b, c] = await Promise.all([startClient(port, env, "chat-a"), startClient(port, env, "chat-b"), startClient(port, env, "chat-c")]);
  const tokenPath = join(stateDir, `bridge-${port}.token`);
  assert.equal(statSync(tokenPath).mode & 0o777, 0o600, "generated token file is owner-only");
  const token = readFileSync(tokenPath, "utf8").trim();
  const ext = fakeExtension(port, token);
  await ext.waitPaired();
  try {
    const pids = listenerPids(port);
    assert.equal(pids.length, 1, "exactly one listener on the port");
    const cmd = execFileSync("ps", ["-o", "command=", "-p", String(pids[0])], { encoding: "utf8" });
    assert.match(cmd, /bridge-daemon\.mjs/, "the listener is the shared bridge process, not a chat's process");

    for (const [client, tab] of [[a, 1], [b, 2], [c, 3]]) {
      assert.ok(await waitFor(async () => !(await snapshot(client, tab)).isError), `client for tab ${tab} gets snapshots`);
      const out = await snapshot(client, tab);
      assert.deepEqual(out.structuredContent, { tabId: tab, op: "snapshot" });
    }
    await a.close();
    await tick(200);
    assert.deepEqual((await snapshot(b, 22)).structuredContent, { tabId: 22, op: "snapshot" }, "b works after a closed");
    assert.deepEqual((await snapshot(c, 33)).structuredContent, { tabId: 33, op: "snapshot" }, "c works after a closed");
    await b.close();
    await tick(200);
    assert.deepEqual((await snapshot(c, 34)).structuredContent, { tabId: 34, op: "snapshot" }, "c works after b closed");
    assert.deepEqual(listenerPids(port), pids, "the same bridge process kept serving throughout");
  } finally {
    await Promise.allSettled([a.close(), b.close(), c.close()]);
    ext.stop();
  }
  assert.ok(await waitFor(() => listenerPids(port).length === 0, 5000), "the bridge exits after its idle window with no peers");
});

test("concurrent requests from two processes are routed to their own caller", async () => {
  const port = await freePort();
  const env = { SEEYABLE_STATE_DIR: mkdtempSync(join(tmpdir(), "seeyable-mp-")), SEEYABLE_BRIDGE_TOKEN: "f".repeat(64) };
  const [a, b] = await Promise.all([startClient(port, env, "chat-a"), startClient(port, env, "chat-b")]);
  // Tab 1 answers slowly, tab 2 instantly: answers arrive out of order.
  const ext = fakeExtension(port, "f".repeat(64), { answer: (m) => ({ ok: true, delayMs: m.tabId === 1 ? 400 : 0, payload: { tabId: m.tabId } }) });
  await ext.waitPaired();
  try {
    assert.ok(await waitFor(async () => !(await snapshot(a, 9)).isError && !(await snapshot(b, 9)).isError));
    const results = await Promise.all([1, 2, 1, 2, 1, 2].map((tab, i) => snapshot(i % 2 ? b : a, tab)));
    results.forEach((r, i) => assert.equal(r.structuredContent.tabId, i % 2 ? 2 : 1));
    // Different callers, both with local ids q1..qN, never collide upstream.
    const ids = ext.frames.map((f) => f.id);
    assert.equal(new Set(ids).size, ids.length);
  } finally {
    await Promise.allSettled([a.close(), b.close()]);
    ext.stop();
  }
});

test("an unrelated port owner: MCP still initializes, tools report PORT_CONFLICT, nothing is sent or replaced", async () => {
  const seen = [];
  const other = createServer((req, res) => { seen.push({ url: req.url, headers: req.headers }); res.writeHead(200); res.end("someone else"); });
  await new Promise((r) => other.listen(0, "127.0.0.1", r));
  const port = other.address().port;
  const token = "e".repeat(64);
  const client = await startClient(port, { SEEYABLE_STATE_DIR: mkdtempSync(join(tmpdir(), "seeyable-mp-")), SEEYABLE_BRIDGE_TOKEN: token }, "chat-x");
  try {
    const tools = await client.listTools();
    assert.equal(tools.tools.length, 8);
    const snap = await snapshot(client, 1);
    assert.equal(snap.structuredContent.error.code, "PORT_CONFLICT");
    const click = await client.callTool({ name: "click", arguments: { tabId: 1, elementId: "el-1", documentSessionId: "d", revision: 1 } });
    assert.equal(click.structuredContent.status, "rejected");
    assert.equal(click.structuredContent.error.code, "PORT_CONFLICT");
    assert.ok(!JSON.stringify(seen).includes(token), "the token never reached the other service");
    assert.deepEqual(listenerPids(port), [process.pid], "the other service still owns its port");
  } finally {
    await client.close();
    await new Promise((r) => other.close(r));
  }
});

test("shared bridge crash: pending mutation is outcome_unknown, both clients recover, nothing is replayed", async () => {
  const port = await freePort();
  const token = "9".repeat(64);
  const env = { SEEYABLE_STATE_DIR: mkdtempSync(join(tmpdir(), "seeyable-mp-")), SEEYABLE_BRIDGE_TOKEN: token };
  const [a, b] = await Promise.all([startClient(port, env, "chat-a"), startClient(port, env, "chat-b")]);
  // Never answers execute (it is "in flight" when the bridge dies).
  const ext = fakeExtension(port, token, { answer: (m) => (m.op === "execute" ? null : { ok: true, payload: { tabId: m.tabId } }) });
  await ext.waitPaired();
  try {
    assert.ok(await waitFor(async () => !(await snapshot(a, 1)).isError && !(await snapshot(b, 1)).isError));
    const click = a.callTool({ name: "click", arguments: { tabId: 4, elementId: "el-4", documentSessionId: "d", revision: 1 } });
    assert.ok(await waitFor(() => ext.frames.some((f) => f.op === "execute"), 3000));
    const [pid] = listenerPids(port);
    process.kill(pid, "SIGKILL"); // abrupt failure, not a graceful close
    const res = await click;
    assert.equal(res.structuredContent.status, "outcome_unknown");
    assert.equal(res.structuredContent.error.code, "BRIDGE_UNAVAILABLE");
    // Recovery: a peer restarts the shared bridge; the extension re-pairs with the same token.
    assert.ok(await waitFor(async () => !(await snapshot(a, 5)).isError, 15000), "a recovers");
    assert.ok(await waitFor(async () => !(await snapshot(b, 6)).isError, 15000), "b recovers");
    const [newPid] = listenerPids(port);
    assert.notEqual(newPid, pid);
    assert.equal(ext.frames.filter((f) => f.op === "execute").length, 1, "the in-flight click was never replayed");
  } finally {
    await Promise.allSettled([a.close(), b.close()]);
    ext.stop();
  }
});
