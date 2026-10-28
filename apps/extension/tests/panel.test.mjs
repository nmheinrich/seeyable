// Feature 9: manual test panel — mocked Chrome messaging, real panel code.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, "../sidepanel.html"), "utf8");
const panelJs = readFileSync(join(here, "../sidepanel.js"), "utf8");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tick = async () => { await sleep(0); await sleep(0); await sleep(0); };

function snap(elements, revision = 1, session = "doc-A") {
  return {
    schemaVersion: 2, kind: "dom-aria", documentSessionId: session, revision,
    semanticHash: "abcd1234", fresh: true, url: "https://example.test/form",
    elementCount: elements.length, elements,
  };
}
const el = (id, name, extra = {}) => ({
  id, role: "textbox", name, nameSource: "label", question: null, questionCertain: false,
  state: {}, actionable: true, tag: "input", cssPath: "input", ...extra,
});

function makePanel(sendImpl, opts = {}) {
  const dom = new JSDOM(html, { url: "chrome-extension://test/sidepanel.html", runScripts: "dangerously", pretendToBeVisual: true });
  const win = dom.window;
  const calls = { send: [], execute: 0, storage: 0 };
  const listeners = { activated: [], updated: [] };
  const logs = [];
  win.console = { info: (...a) => logs.push(a.join(" ")), warn: () => {}, error: () => {} };
  win.chrome = {
    tabs: {
      query: async () => [{ id: opts.tabId || 111, title: "Form" }],
      sendMessage: async (tabId, msg) => {
        calls.send.push({ tabId, msg });
        if (msg.type === "SEEYABLE_EXECUTE_ACTION") calls.execute += 1;
        return sendImpl(tabId, msg, calls);
      },
      onActivated: { addListener: (fn) => listeners.activated.push(fn) },
      onUpdated: { addListener: (fn) => listeners.updated.push(fn) },
    },
    scripting: {
      executeScript: opts.scripting || (async () => [{ result: null }]),
    },
    runtime: { sendMessage: async () => ({ ok: false, error: "no debugger" }) },
    permissions: { contains: async () => false },
    storage: { local: { get: async () => { calls.storage += 1; return {}; }, set: async () => { calls.storage += 1; } } },
  };
  if (!win.navigator.clipboard) Object.defineProperty(win.navigator, "clipboard", { value: { writeText: async () => {} } });
  win.eval(panelJs);
  const doc = win.document;
  return { dom, win, doc, calls, listeners, logs, $: (id) => doc.getElementById(id) };
}

async function takeSnapshot(panel) {
  panel.$("btnDom").click();
  await tick();
}
function selectTarget(panel, id) {
  panel.$("targetSelect").value = id;
  panel.$("targetSelect").dispatchEvent(new panel.win.Event("change"));
}

test("selection: snapshot populates targets; execute sends the exact payload", async () => {
  let captured = null;
  const panel = makePanel(async (_t, msg) => {
    if (msg.type === "SEEYABLE_SNAPSHOT_DOM") return { ok: true, snapshot: snap([el("el-1", "Full name"), el("el-2", "Nickname")]) };
    if (msg.type === "SEEYABLE_EXECUTE_ACTION") { captured = msg; return { ok: true, result: { verified: true }, newSnapshotDiff: { added: [], removed: [], updated: [{ id: "el-1", changedFields: ["state"] }] }, diffUnavailableReason: null, documentSessionId: "doc-A", revision: 2 }; }
    throw new Error("unexpected " + msg.type);
  });
  await takeSnapshot(panel);
  const opts = [...panel.$("targetSelect").options];
  assert.equal(opts.length, 3, "placeholder plus two targets");
  assert.equal(opts[0].value, "", "first option is the explicit unselected placeholder");
  assert.match(opts[1].textContent, /1 · Full name/);
  assert.equal(panel.$("btnExecute").disabled, true, "nothing is selected until the user chooses");
  selectTarget(panel, "el-1");
  panel.$("actionSelect").value = "fill";
  panel.$("actionSelect").dispatchEvent(new panel.win.Event("change"));
  assert.equal(panel.$("valueInput").disabled, false);
  panel.$("valueInput").value = "Ada";
  panel.$("btnExecute").click();
  await tick();
  assert.deepEqual(JSON.parse(JSON.stringify(captured.request)), { action: "fill", elementId: "el-1", documentSessionId: "doc-A", revision: 1, value: "Ada" });
  assert.match(panel.$("execResult").textContent, /verified/i);
  panel.dom.window.close();
});

test("empty-string fill is sent as a real value; value input only for fill/select", async () => {
  let captured = null;
  const panel = makePanel(async (_t, msg) => {
    if (msg.type === "SEEYABLE_SNAPSHOT_DOM") return { ok: true, snapshot: snap([el("el-1", "Full name")]) };
    if (msg.type === "SEEYABLE_EXECUTE_ACTION") { captured = msg; return { ok: true, result: { verified: true }, newSnapshotDiff: { added: [], removed: [], updated: [] }, documentSessionId: "doc-A", revision: 1 }; }
    throw new Error("unexpected");
  });
  await takeSnapshot(panel);
  selectTarget(panel, "el-1");
  panel.$("actionSelect").value = "click";
  panel.$("actionSelect").dispatchEvent(new panel.win.Event("change"));
  assert.equal(panel.$("valueInput").disabled, true);
  panel.$("actionSelect").value = "fill";
  panel.$("actionSelect").dispatchEvent(new panel.win.Event("change"));
  assert.equal(panel.$("valueInput").disabled, false);
  panel.$("btnExecute").click();
  await tick();
  assert.equal(captured.request.value, "");
  panel.dom.window.close();
});

test("duplicate dispatch is prevented while an action is pending", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const panel = makePanel(async (_t, msg) => {
    if (msg.type === "SEEYABLE_SNAPSHOT_DOM") return { ok: true, snapshot: snap([el("el-1", "Full name")]) };
    if (msg.type === "SEEYABLE_EXECUTE_ACTION") { await gate; return { ok: true, result: { dispatched: true, verified: false }, newSnapshotDiff: { added: [], removed: [], updated: [] }, documentSessionId: "doc-A", revision: 1 }; }
    throw new Error("unexpected");
  });
  await takeSnapshot(panel);
  selectTarget(panel, "el-1");
  panel.$("btnExecute").click();
  await tick();
  panel.$("btnExecute").click();
  panel.$("btnExecute").dispatchEvent(new panel.win.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await tick();
  assert.equal(panel.calls.execute, 1, "rapid re-activation must not dispatch twice");
  release();
  await tick();
  assert.match(panel.$("execResult").textContent, /NOT verified/);
  assert.ok(!/completed successfully/i.test(panel.$("execResult").textContent), "verified:false must not read as success");
  panel.dom.window.close();
});

test("stale failure is shown without retry; result survives the automatic refresh", async () => {
  const panel = makePanel(async (_t, msg) => {
    if (msg.type === "SEEYABLE_SNAPSHOT_DOM") return { ok: true, snapshot: snap([el("el-1", "Full name")], panel.__rev || 1) };
    if (msg.type === "SEEYABLE_EXECUTE_ACTION") return { ok: false, error: { code: "STALE_TARGET", message: "Target el-1 is stale." }, newSnapshotDiff: null, diffUnavailableReason: "page changed", documentSessionId: "doc-A", revision: 2 };
    throw new Error("unexpected");
  });
  await takeSnapshot(panel);
  selectTarget(panel, "el-1");
  panel.$("btnExecute").click();
  await tick();
  assert.equal(panel.calls.execute, 1, "no automatic retry after a stale failure");
  assert.match(panel.$("execResult").textContent, /STALE_TARGET/);
  assert.match(panel.$("execResult").textContent, /Diff unavailable: page changed/);
  panel.dom.window.close();
});

test("conditional targets appear and disappear across refresh; selection never substitutes", async () => {
  let phase = 0;
  const panel = makePanel(async (_t, msg) => {
    if (msg.type === "SEEYABLE_SNAPSHOT_DOM") {
      phase += 1;
      if (phase === 1) return { ok: true, snapshot: snap([el("el-1", "Toggle")], 1) };
      if (phase === 2) return { ok: true, snapshot: snap([el("el-1", "Toggle"), el("el-2", "Follow-up details")], 2) };
      return { ok: true, snapshot: snap([el("el-1", "Toggle")], 3) };
    }
    if (msg.type === "SEEYABLE_EXECUTE_ACTION") return { ok: true, result: { verified: true }, newSnapshotDiff: { added: ["el-2"], removed: [], updated: [] }, documentSessionId: "doc-A", revision: 2 };
    throw new Error("unexpected");
  });
  await takeSnapshot(panel);
  selectTarget(panel, "el-1");
  panel.$("btnExecute").click();
  await tick();
  assert.ok([...panel.$("targetSelect").options].some((o) => o.textContent.includes("Follow-up details")), "revealed control becomes selectable");
  selectTarget(panel, "el-2");
  panel.$("actionSelect").value = "fill";
  panel.$("actionSelect").dispatchEvent(new panel.win.Event("change"));
  panel.$("valueInput").value = "for el-2 only";
  panel.$("btnRefresh").click();
  await tick();
  assert.ok(![...panel.$("targetSelect").options].some((o) => o.value === "el-2"), "removed control leaves the selector");
  assert.equal(panel.$("targetSelect").value, "", "no replacement target may be selected by default");
  assert.equal(panel.$("valueInput").value, "", "the removed target's entered value must be cleared");
  assert.equal(panel.$("btnExecute").disabled, true, "Execute stays disabled until a deliberate selection");
  panel.dom.window.close();
});

test("tab change discards the selection and ignores a late response", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const panel = makePanel(async (_t, msg) => {
    if (msg.type === "SEEYABLE_SNAPSHOT_DOM") return { ok: true, snapshot: snap([el("el-1", "Full name")]) };
    if (msg.type === "SEEYABLE_EXECUTE_ACTION") { await gate; return { ok: true, result: { verified: true }, newSnapshotDiff: { added: [], removed: [], updated: [] }, documentSessionId: "doc-A", revision: 1 }; }
    throw new Error("unexpected");
  });
  await takeSnapshot(panel);
  selectTarget(panel, "el-1");
  panel.$("btnExecute").click();
  await tick();
  for (const fn of panel.listeners.activated) fn({ tabId: 999, windowId: 1 });
  release();
  await tick();
  assert.equal(panel.$("btnExecute").disabled, true, "late response must not re-authorize execution");
  assert.ok(!/Completed and verified/.test(panel.$("execResult").textContent), "late success must not overwrite current state");
  panel.dom.window.close();
});

test("missing receiver: fallback snapshot is viewable but execution stays disabled with guidance", async () => {
  const panel = makePanel(
    async (_t, msg) => {
      if (msg.type === "SEEYABLE_SNAPSHOT_DOM") throw new Error("Could not establish connection. Receiving end does not exist.");
      throw new Error("unexpected");
    },
    { scripting: async () => [{ result: snap([el("el-1", "Full name")]) }] }
  );
  await takeSnapshot(panel);
  assert.equal(panel.$("targetSelect").options.length, 2, "placeholder plus fallback target still populates for inspection");
  assert.equal(panel.$("btnExecute").disabled, true);
  assert.match(panel.$("status").textContent, /Execution is disabled/);
  panel.dom.window.close();
});

test("refresh failure after execution retains the result and disables execution", async () => {
  let snapCount = 0;
  const panel = makePanel(async (_t, msg) => {
    if (msg.type === "SEEYABLE_SNAPSHOT_DOM") {
      snapCount += 1;
      if (snapCount > 1) throw new Error("connection lost");
      return { ok: true, snapshot: snap([el("el-1", "Full name")]) };
    }
    if (msg.type === "SEEYABLE_EXECUTE_ACTION") return { ok: true, result: { verified: true }, newSnapshotDiff: { added: [], removed: [], updated: [{ id: "el-1", changedFields: ["state"] }] }, documentSessionId: "doc-A", revision: 2 };
    throw new Error("unexpected");
  });
  await takeSnapshot(panel);
  selectTarget(panel, "el-1");
  panel.$("btnExecute").click();
  await tick();
  assert.match(panel.$("execResult").textContent, /Completed and verified/, "result must be retained");
  assert.equal(panel.$("btnExecute").disabled, true);
  assert.match(panel.$("meta").textContent, /Snapshot unavailable/);
  panel.dom.window.close();
});

test("initial snapshot in flight: tab switch before binding discards the late snapshot", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const panel = makePanel(async (_t, msg) => {
    if (msg.type === "SEEYABLE_SNAPSHOT_DOM") { await gate; return { ok: true, snapshot: snap([el("el-1", "Full name")]) }; }
    throw new Error("unexpected");
  });
  panel.$("btnDom").click();
  await tick();
  for (const fn of panel.listeners.activated) fn({ tabId: 999, windowId: 1 });
  release();
  await tick();
  assert.equal(panel.$("targetSelect").value, "", "obsolete snapshot must not populate a selection");
  assert.equal(panel.$("btnExecute").disabled, true);
  panel.dom.window.close();
});

test("lock through refresh: exactly one dispatch until the post-action refresh completes", async () => {
  let releaseRefresh;
  const refreshGate = new Promise((r) => { releaseRefresh = r; });
  let snapCount = 0;
  const panel = makePanel(async (_t, msg) => {
    if (msg.type === "SEEYABLE_SNAPSHOT_DOM") {
      snapCount += 1;
      if (snapCount > 1) await refreshGate; // post-action refresh held open
      return { ok: true, snapshot: snap([el("el-1", "Full name")], snapCount) };
    }
    if (msg.type === "SEEYABLE_EXECUTE_ACTION") return { ok: true, result: { verified: true }, newSnapshotDiff: { added: [], removed: [], updated: [] }, documentSessionId: "doc-A", revision: 2 };
    throw new Error("unexpected");
  });
  await takeSnapshot(panel);
  selectTarget(panel, "el-1");
  panel.$("btnExecute").click();
  await tick(); await tick();
  assert.equal(panel.$("btnExecute").disabled, true, "Execute stays locked while refresh is pending");
  panel.$("btnExecute").click();
  await tick();
  assert.equal(panel.calls.execute, 1, "no second dispatch until refresh completes");
  releaseRefresh();
  await tick(); await tick();
  assert.match(panel.$("execResult").textContent, /Completed and verified/, "first result is preserved");
  panel.dom.window.close();
});

test("show tags: ownership retained through follow-up snapshot; tab switch discards it", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const panel = makePanel(async (_t, msg) => {
    if (msg.type === "SEEYABLE_SHOW_TAGS") return { ok: true, shown: 1, total: 1, revision: 1, documentSessionId: "doc-A" };
    if (msg.type === "SEEYABLE_SNAPSHOT_DOM") { await gate; return { ok: true, snapshot: snap([el("el-1", "Full name")]) }; }
    throw new Error("unexpected " + msg.type);
  });
  panel.$("btnShowTags").click();
  await tick(); await tick(); // SHOW_TAGS done, follow-up snapshot held
  for (const fn of panel.listeners.activated) fn({ tabId: 999, windowId: 1 });
  release();
  await tick(); await tick();
  assert.equal(panel.$("targetSelect").value, "", "old tab targets must not populate after a tab switch");
  assert.equal(panel.$("targetSelect").options.length, 1, "only the unselected placeholder remains");
  assert.equal(panel.$("btnExecute").disabled, true);
  panel.dom.window.close();
});

test("overlap: manual refresh and execution cannot overlap; older refresh cannot overwrite rev 2", async () => {
  let releaseRefresh;
  const refreshGate = new Promise((r) => { releaseRefresh = r; });
  let snapCount = 0;
  const panel = makePanel(async (_t, msg) => {
    if (msg.type === "SEEYABLE_SNAPSHOT_DOM") {
      snapCount += 1;
      if (snapCount === 2) await refreshGate; // manual refresh held
      return { ok: true, snapshot: snap([el("el-1", "Full name")], snapCount >= 3 ? 2 : 1) };
    }
    if (msg.type === "SEEYABLE_EXECUTE_ACTION") return { ok: true, result: { verified: true }, newSnapshotDiff: { added: [], removed: [], updated: [] }, documentSessionId: "doc-A", revision: 2 };
    throw new Error("unexpected " + msg.type);
  });
  await takeSnapshot(panel);
  selectTarget(panel, "el-1");
  panel.$("btnRefresh").click();
  await tick(); await tick();
  panel.$("btnExecute").click();
  await tick();
  assert.equal(panel.calls.execute, 0, "execution must not start while acquisition owns the panel");
  releaseRefresh();
  await tick(); await tick();
  selectTarget(panel, "el-1");
  panel.$("btnExecute").click();
  await tick(); await tick(); await tick();
  assert.equal(panel.calls.execute, 1);
  assert.equal(JSON.parse(panel.$("output").textContent).revision, 2, "post-action state must not be overwritten by the older refresh");
  panel.dom.window.close();
});

test("failed acquisition releases locks while keeping execution disabled", async () => {
  let snapCount = 0;
  const panel = makePanel(async (_t, msg) => {
    if (msg.type === "SEEYABLE_SNAPSHOT_DOM") {
      snapCount += 1;
      if (snapCount > 1) throw new Error("connection lost");
      return { ok: true, snapshot: snap([el("el-1", "Full name")]) };
    }
    throw new Error("unexpected " + msg.type);
  });
  await takeSnapshot(panel);
  selectTarget(panel, "el-1");
  panel.$("btnRefresh").click();
  await tick(); await tick();
  assert.equal(panel.$("btnRefresh").disabled, false, "acquisition lock must be released after failure");
  assert.equal(panel.$("btnExecute").disabled, true, "failed refresh must not leave the old snapshot execution-ready");
  panel.dom.window.close();
});

test("page strings render as text; entered values are neither persisted nor logged", async () => {
  const panel = makePanel(async (_t, msg) => {
    if (msg.type === "SEEYABLE_SNAPSHOT_DOM") return { ok: true, snapshot: snap([el("el-1", "<img src=x onerror=alert(1)>")]) };
    if (msg.type === "SEEYABLE_EXECUTE_ACTION") return { ok: true, result: { verified: true }, newSnapshotDiff: { added: [], removed: [], updated: [] }, documentSessionId: "doc-A", revision: 1 };
    throw new Error("unexpected");
  });
  await takeSnapshot(panel);
  assert.equal(panel.$("targetSelect").querySelector("img"), null, "page-derived markup must not parse as HTML");
  panel.$("actionSelect").value = "fill";
  panel.$("actionSelect").dispatchEvent(new panel.win.Event("change"));
  panel.$("valueInput").value = "SecretValue123";
  panel.$("btnExecute").click();
  await tick();
  assert.equal(panel.calls.storage, 0, "panel must not persist anything");
  assert.ok(!panel.logs.join(" ").includes("SecretValue123"), "entered values must not reach the console");
  assert.ok(!panel.$("output").textContent.includes("SecretValue123"), "entered values must not enter copy/download JSON");
  panel.dom.window.close();
});
