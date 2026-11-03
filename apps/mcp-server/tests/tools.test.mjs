"use strict";
/* Issue #19 tool contracts: strict schemas, outcome mapping, and a real
 * stdio round trip against the actual server (no extension paired, so
 * page tools take the honest NO_EXTENSION path). No credentials, no
 * model calls. */
import test from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { toolHandlers, mapExecuteResult } from "../lib/tools.mjs";
import { BridgeError } from "../lib/bridge.mjs";

const here = dirname(fileURLToPath(import.meta.url));

function fakeBridge(responder, { connected = true } = {}) {
  const calls = [];
  return {
    calls,
    isConnected: () => connected,
    async request(op, tabId, params) {
      calls.push({ op, tabId, params });
      return responder(op, params);
    },
  };
}
const defs = (bridge) => Object.fromEntries(toolHandlers(bridge).map((d) => [d.name, d]));
const TARGET = { tabId: 7, elementId: "el-3", documentSessionId: "doc-A", revision: 2 };

test("tools: the eight names are present and highlight_target aliases highlight", () => {
  const d = defs(fakeBridge(() => ({})));
  assert.deepEqual(Object.keys(d).sort(), ["click", "fill", "highlight", "highlight_target", "list_tabs", "page_snapshot", "read_section", "select"]);
  assert.equal(d.highlight_target.handler, d.highlight.handler, "alias shares the guarded handler");
  assert.deepEqual(d.highlight_target.inputSchema.shape, d.highlight.inputSchema.shape);
});

test("schemas: unknown and approval-shaped fields are rejected before any bridge traffic", async () => {
  const bridge = fakeBridge(() => { throw new Error("must not be called"); });
  const d = defs(bridge);
  for (const extra of [{ approved: true }, { source: "manual" }, { challengeId: "ch-1" }, { confirmed: true }, { token: "x" }]) {
    assert.equal(d.fill.inputSchema.safeParse({ ...TARGET, value: "x", ...extra }).success, false, JSON.stringify(extra));
  }
  assert.equal(d.click.inputSchema.safeParse({ ...TARGET, value: "x" }).success, false, "click takes no value");
  assert.equal(d.click.inputSchema.safeParse(TARGET).success, true);
  assert.equal(d.read_section.inputSchema.safeParse({ ...TARGET, selector: "#x" }).success, false, "no CSS selectors");
  assert.equal(d.list_tabs.inputSchema.safeParse({ tabId: 1 }).success, false);
  // Handlers are never reached with bad shapes in production (the SDK
  // validates first); the same strictness is asserted here directly.
  assert.equal(bridge.calls.length, 0);
});

test("fill: verified executor result maps to verified with the exact value forwarded", async () => {
  const bridge = fakeBridge(() => ({ ok: true, result: { verified: true }, newSnapshotDiff: { added: [], removed: [], updated: [] }, diffUnavailableReason: null, documentSessionId: "doc-A", revision: 3 }));
  const out = await defs(bridge).fill.handler({ ...TARGET, value: "Ada" });
  assert.equal(out.isError, undefined);
  assert.equal(out.structuredContent.status, "verified");
  assert.equal(out.structuredContent.revision, 3, "the post-action revision is reported for the next call");
  assert.deepEqual(bridge.calls[0], { op: "execute", tabId: 7, params: { action: "fill", elementId: "el-3", documentSessionId: "doc-A", revision: 2, value: "Ada" } });
  assert.match(out.content[0].text, /"status": "verified"/, "text compatibility carries the same payload");
});

test("click: dispatched activation is not dressed up as verified completion", async () => {
  const bridge = fakeBridge(() => ({ ok: true, result: { dispatched: true, verified: false, note: "no observable change" }, newSnapshotDiff: null, diffUnavailableReason: "x", documentSessionId: "doc-A", revision: 2 }));
  const out = await defs(bridge).click.handler(TARGET);
  assert.equal(out.structuredContent.status, "dispatched_unverified");
  assert.deepEqual(bridge.calls[0].params, { action: "click", elementId: "el-3", documentSessionId: "doc-A", revision: 2 }, "no value is invented for click");
});

test("select: the exact snapshot option value is forwarded untouched", async () => {
  const bridge = fakeBridge(() => ({ ok: true, result: { verified: true, selectedValue: "pm" }, documentSessionId: "doc-A", revision: 3 }));
  const out = await defs(bridge).select.handler({ ...TARGET, value: "pm" });
  assert.equal(out.structuredContent.status, "verified");
  assert.equal(bridge.calls[0].params.value, "pm", "no label conversion in the bridge");
});

test("held: consequential click waits for the panel, with no approval material for the client", async () => {
  const bridge = fakeBridge(() => ({
    ok: false,
    error: { code: "CONFIRMATION_REQUIRED", message: "Held." },
    confirmation: {
      challengeId: "ch-secret-routing", action: "click", elementId: "el-3", targetName: "Submit feedback",
      targetQuestion: null, consequence: "Submits.", pageUrl: "https://example.test/form",
      documentSessionId: "doc-A", revision: 2, expiresAt: "2026-01-01T00:01:00.000Z",
    },
    newSnapshotDiff: null, diffUnavailableReason: "awaiting human confirmation", documentSessionId: "doc-A", revision: 2,
  }));
  const out = await defs(bridge).click.handler(TARGET);
  assert.equal(out.isError, true, "a held action must not read as success");
  assert.equal(out.structuredContent.status, "held_for_approval");
  assert.match(out.structuredContent.confirmation.approval, /side panel/);
  assert.ok(!JSON.stringify(out).includes("ch-secret-routing"), "challenge ids never reach MCP clients");
});

test("outcomes: rejected, unverified-after-dispatch, timeout-unknown, and no-extension are distinct", async () => {
  const rejected = await defs(fakeBridge(() => ({ ok: false, error: { code: "STALE_TARGET", message: "gone" }, documentSessionId: "doc-A", revision: 2 }))).click.handler(TARGET);
  assert.equal(rejected.structuredContent.status, "rejected");
  assert.equal(rejected.isError, true);

  const unverified = await defs(fakeBridge(() => ({ ok: false, error: { code: "ACTION_NOT_VERIFIED", message: "not retained" }, newSnapshotDiff: { added: [], removed: [], updated: [] }, documentSessionId: "doc-A", revision: 3 }))).fill.handler({ ...TARGET, value: "x" });
  assert.equal(unverified.structuredContent.status, "dispatched_unverified", "dispatch happened; the outcome is reported honestly");
  assert.ok(unverified.structuredContent.newSnapshotDiff, "the post-action diff survives the failure");

  const timedOut = await defs(fakeBridge(() => { throw new BridgeError("TIMEOUT", "Extension did not answer execute within 15000 ms."); })).fill.handler({ ...TARGET, value: "x" });
  assert.equal(timedOut.structuredContent.status, "outcome_unknown");
  assert.match(timedOut.structuredContent.error.message, /may already have been dispatched/);

  const absentBridge = fakeBridge(() => { throw new Error("must not send"); }, { connected: false });
  const absent = await defs(absentBridge).click.handler(TARGET);
  assert.equal(absent.structuredContent.status, "rejected");
  assert.equal(absent.structuredContent.error.code, "NO_EXTENSION");
  assert.equal(absentBridge.calls.length, 0, "nothing is sent to a missing extension");
});

test("snapshot, highlight, read_section: pass-through shapes and bound forwarding", async () => {
  const snapshot = { documentSessionId: "doc-A", revision: 2, elements: [{ id: "el-3" }] };
  const bridge = fakeBridge((op) => {
    if (op === "snapshot") return snapshot;
    if (op === "highlight") return { highlighted: "el-3" };
    if (op === "read_section") return { elementId: "el-3", heading: "Form", text: "Hello", truncated: false, charCount: 5, documentSessionId: "doc-A", revision: 2 };
    throw new Error("unexpected " + op);
  });
  const d = defs(bridge);
  const snap = await d.page_snapshot.handler({ tabId: 7 });
  assert.deepEqual(snap.structuredContent, snapshot, "the production snapshot crosses untouched");
  const hi = await d.highlight.handler(TARGET);
  assert.equal(hi.structuredContent.status, "highlighted");
  const read = await d.read_section.handler({ ...TARGET, maxChars: 500 });
  assert.equal(read.structuredContent.status, "ok");
  assert.equal(read.structuredContent.text, "Hello");
  assert.deepEqual(bridge.calls.find((c) => c.op === "read_section").params, { elementId: "el-3", documentSessionId: "doc-A", revision: 2, maxChars: 500 });
});

test("mapExecuteResult keeps executor error codes for stale and disabled targets", () => {
  const out = mapExecuteResult("fill", TARGET, { ok: false, error: { code: "TARGET_DISABLED", message: "disabled" }, documentSessionId: "doc-A", revision: 2 });
  assert.equal(out.structuredContent.status, "rejected");
  assert.equal(out.structuredContent.error.code, "TARGET_DISABLED");
});

test("stdio: real server lists eight tools, rejects extra fields, and reports NO_EXTENSION", async () => {
  const port = 6200 + (process.pid % 300);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(here, "../server.mjs"), "--port", String(port)],
    // Isolated state dir and a short idle so the shared bridge process
    // this starts exits by itself after the test.
    env: { ...process.env, SEEYABLE_BRIDGE_TOKEN: "tools-test-token", SEEYABLE_STATE_DIR: mkdtempSync(join(tmpdir(), "seeyable-tools-")), SEEYABLE_BRIDGE_IDLE_MS: "500" },
    stderr: "ignore",
  });
  const client = new Client({ name: "seeyable-tools-test", version: "0.0.0" }, { capabilities: {} });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map((t) => t.name).sort(),
      ["click", "fill", "highlight", "highlight_target", "list_tabs", "page_snapshot", "read_section", "select"]);
    const fillTool = listed.tools.find((t) => t.name === "fill");
    assert.equal(fillTool.inputSchema.additionalProperties, false, "advertised schemas are closed");

    const forged = await client.callTool({ name: "fill", arguments: { ...TARGET, value: "x", approved: true } });
    assert.equal(forged.isError, true, "approval-shaped input is rejected by the schema");
    assert.match(JSON.stringify(forged), /approved|Unrecognized|unknown/i);

    const noExt = await client.callTool({ name: "page_snapshot", arguments: { tabId: 7 } });
    assert.equal(noExt.isError, true);
    assert.equal(noExt.structuredContent.error.code, "NO_EXTENSION");
    const noExtClick = await client.callTool({ name: "click", arguments: TARGET });
    assert.equal(noExtClick.structuredContent.status, "rejected");
    assert.equal(noExtClick.structuredContent.error.code, "NO_EXTENSION", "pre-dispatch absence is honest: nothing was sent");
  } finally {
    await client.close().catch(() => {});
  }
});
