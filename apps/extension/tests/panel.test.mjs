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
const voiceJs = readFileSync(join(here, "../lib/voice-commands.js"), "utf8");
const commandsJs = readFileSync(join(here, "../lib/command-resolver.js"), "utf8");
const overlayJs = readFileSync(join(here, "../lib/overlay.js"), "utf8");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tick = async () => { await sleep(0); await sleep(0); await sleep(0); };

function snap(elements, revision = 1, session = "doc-A", url = "https://example.test/form") {
  return {
    schemaVersion: 2, kind: "dom-aria", documentSessionId: session, revision,
    semanticHash: "abcd1234", fresh: true, url,
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
  const calls = { send: [], execute: 0, storage: 0, tabsCreated: [] };
  const listeners = { activated: [], updated: [] };
  const logs = [];
  win.console = { info: (...a) => logs.push(a.join(" ")), warn: () => {}, error: () => {} };
  if (opts.speechRecognition) win.SpeechRecognition = opts.speechRecognition;
  if (opts.speech) {
    win.speechSynthesis = opts.speech.synth;
    win.SpeechSynthesisUtterance = opts.speech.Utterance;
  }
  win.chrome = {
    tabs: {
      query: async () => [{ id: opts.tabId || 111, title: "Form" }],
      sendMessage: async (tabId, msg) => {
        calls.send.push({ tabId, msg });
        if (msg.type === "SEEYABLE_EXECUTE_ACTION") calls.execute += 1;
        return sendImpl(tabId, msg, calls);
      },
      create: async (props) => { calls.tabsCreated.push(props); return { id: 555 }; },
      onActivated: { addListener: (fn) => listeners.activated.push(fn) },
      onUpdated: { addListener: (fn) => listeners.updated.push(fn) },
    },
    scripting: {
      executeScript: opts.scripting || (async () => [{ result: null }]),
    },
    runtime: {
      sendMessage: async () => ({ ok: false, error: "no debugger" }),
      getURL: (path) => `chrome-extension://test/${path}`,
    },
    permissions: { contains: async () => false },
    storage: { local: { get: async () => { calls.storage += 1; return {}; }, set: async () => { calls.storage += 1; } } },
  };
  if (!win.navigator.clipboard) Object.defineProperty(win.navigator, "clipboard", { value: { writeText: async () => {} } });
  win.eval(voiceJs);
  win.eval(commandsJs); // local click/fill resolver (Issue #13)
  win.eval(overlayJs); // shared word-first label builder used by the panel
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
  assert.deepEqual(JSON.parse(JSON.stringify(captured.request)), { action: "fill", elementId: "el-1", documentSessionId: "doc-A", revision: 1, value: "Ada", source: "manual" });
  assert.match(panel.$("execResult").textContent, /verified/i);
  panel.dom.window.close();
});

test("targets: list shows every snapshot target in words; annotations stripped", async () => {
  const panel = makePanel(async (_t, msg) => {
    if (msg.type === "SEEYABLE_SNAPSHOT_DOM") {
      return { ok: true, snapshot: snap([el("el-1", "Full name"), el("el-2", "Nickname (placeholder only)")], 1, "doc-A") };
    }
    throw new Error("unexpected " + msg.type);
  });
  assert.match(panel.$("targetList").textContent, /Take a snapshot in Developer view/, "empty state before any snapshot");
  await takeSnapshot(panel);
  const items = [...panel.doc.querySelectorAll("#targetList .target")];
  assert.equal(items.length, 2, "every snapshot target stays discoverable");
  assert.match(items[0].textContent, /1 · Full name/);
  assert.match(items[1].textContent, /2 · Nickname/);
  assert.ok(!items[1].textContent.includes("placeholder only"), "display annotations are stripped from labels");
  assert.ok(!panel.$("targetList").textContent.includes("Ada"), "no values leak anywhere");
  assert.equal(panel.$("pageMeta").textContent, "example.test · 2 controls", "page meta uses snapshot metadata, no new permissions");
  panel.dom.window.close();
});

test("targets: activating an item highlights through the bound session; active shows full words", async () => {
  const longName = "A very long descriptive field name for notes use";
  let highlighted = null;
  const panel = makePanel(async (tabId, msg) => {
    if (msg.type === "SEEYABLE_SNAPSHOT_DOM") return { ok: true, snapshot: snap([el("el-1", "Full name"), el("el-2", longName)]) };
    if (msg.type === "SEEYABLE_HIGHLIGHT_ID") { highlighted = { tabId, ...msg }; return { ok: true, highlighted: msg.elementId }; }
    throw new Error("unexpected " + msg.type);
  });
  await takeSnapshot(panel);
  const items = [...panel.doc.querySelectorAll("#targetList .target")];
  assert.ok(items[1].textContent.length < longName.length + 10, "floating list label is the short form");
  assert.ok(!items[1].textContent.includes("descriptive field name for notes use"), "long label is shortened until active");
  items[1].click();
  await tick();
  assert.deepEqual(highlighted && { tabId: highlighted.tabId, elementId: highlighted.elementId, documentSessionId: highlighted.documentSessionId, revision: highlighted.revision }, { tabId: 111, elementId: "el-2", documentSessionId: "doc-A", revision: 1 });
  const active = panel.doc.querySelector('#targetList .target[aria-current="true"]');
  assert.ok(active, "active target is marked");
  assert.match(active.textContent, /descriptive field name for notes use/, "active item shows the full readable label");
  panel.dom.window.close();
});

test("targets: crowded-out ids are marked after show; counts stay truthful; discovery reveals the list", async () => {
  const panel = makePanel(async (_t, msg) => {
    if (msg.type === "SEEYABLE_SNAPSHOT_DOM") return { ok: true, snapshot: snap([el("el-1", "Full name"), el("el-2", "Nickname")]) };
    if (msg.type === "SEEYABLE_SHOW_TAGS") return { ok: true, shown: 1, total: 2, unplaced: ["el-2"], revision: 1, documentSessionId: "doc-A" };
    throw new Error("unexpected " + msg.type);
  });
  await takeSnapshot(panel);
  panel.$("btnTryShow").click();
  await tick(); await tick();
  // No stale precision: the chip reports visibility only and the status
  // carries no placed/listed counts (placement changes as the page moves).
  assert.equal(panel.$("tagsChip").textContent, "Tags: on");
  assert.ok(!/\d+ placed|\d+ more/.test(panel.$("status").textContent), "status must not present one-time placement counts as live");
  assert.match(panel.$("status").textContent, /Some word tags stay in the panel/);
  const items = [...panel.doc.querySelectorAll("#targetList .target")];
  assert.ok(!items[0].textContent.includes("Shown in panel"));
  assert.match(items[1].textContent, /Shown in panel/, "crowded-out target stays discoverable with a clear mark");
  // Discovery: the obvious control moves focus to the Targets heading.
  panel.$("btnViewTargets").click();
  assert.equal(panel.doc.activeElement.id, "targetsHeading", "View page targets reveals and focuses the Targets section");
  panel.dom.window.close();
});

test("targets: held confirmation marks its target from authoritative state", async () => {
  const panel = makePanel(async (_t, msg) => {
    if (msg.type === "SEEYABLE_SNAPSHOT_DOM") return { ok: true, snapshot: snap([el("el-1", "Submit survey", { role: "button", actionable: true })]) };
    if (msg.type === "SEEYABLE_HIGHLIGHT_ID") return { ok: true, highlighted: msg.elementId };
    if (msg.type === "SEEYABLE_EXECUTE_ACTION") {
      return { ok: false, error: { code: "CONFIRMATION_REQUIRED", message: "Held." }, confirmation: { challengeId: "cb1", elementId: "el-1", targetName: "Submit survey", action: "click", consequence: "Submits.", expiresAt: "soon" }, newSnapshotDiff: null, diffUnavailableReason: "awaiting human confirmation", documentSessionId: "doc-A", revision: 1 };
    }
    if (msg.type === "SEEYABLE_GET_ACTION_LOG") return { ok: true, entries: [] };
    throw new Error("unexpected " + msg.type);
  });
  await takeSnapshot(panel);
  panel.doc.querySelector("#targetList .target").click();
  await tick();
  selectTarget(panel, "el-1");
  panel.$("btnExecute").click();
  await tick(); await tick();
  assert.equal(panel.$("stateChip").textContent, "▲ Held — nothing sent");
  const item = panel.doc.querySelector("#targetList .target");
  assert.match(item.textContent, /▲ held/, "held mark comes from the confirmation, not a second registry");
  panel.dom.window.close();
});

test("targets: invalidation clears the visible list (no stale rows)", async () => {
  const panel = makePanel(async (_t, msg) => {
    if (msg.type === "SEEYABLE_SNAPSHOT_DOM") return { ok: true, snapshot: snap([el("el-1", "Original field")]) };
    throw new Error("unexpected " + msg.type);
  });
  await takeSnapshot(panel);
  assert.equal(panel.doc.querySelectorAll("#targetList .target").length, 1);
  assert.match(panel.doc.querySelector("#targetList .target").textContent, /Original field/);
  for (const fn of panel.listeners.activated) fn({ tabId: 999, windowId: 1 });
  await tick();
  assert.equal(panel.doc.querySelectorAll("#targetList .target").length, 0, "stale rows from the previous document must disappear");
  assert.match(panel.$("targetList").textContent, /Take a snapshot in Developer view/, "empty state comes back");
  panel.dom.window.close();
});

test("targets: late highlight from document A cannot mark document B; newer beats older", async () => {
  const resolvers = [];
  let currentSnap = snap([el("el-1", "Original field")], 1, "doc-A", "https://a.example/form");
  const panel = makePanel(async (_t, msg) => {
    if (msg.type === "SEEYABLE_SNAPSHOT_DOM") return { ok: true, snapshot: currentSnap };
    if (msg.type === "SEEYABLE_HIGHLIGHT_ID") return new Promise((resolve) => resolvers.push(resolve));
    throw new Error("unexpected " + msg.type);
  });
  await takeSnapshot(panel);
  panel.doc.querySelector("#targetList .target").click(); // doc A highlight in flight
  assert.equal(resolvers.length, 1);
  for (const fn of panel.listeners.activated) fn({ tabId: 999, windowId: 1 }); // owner goes away
  await tick();
  currentSnap = snap([el("el-1", "Different field")], 1, "doc-B", "https://b.example/form");
  await takeSnapshot(panel);
  assert.match(panel.doc.querySelector("#targetList .target").textContent, /Different field/);
  resolvers.shift()({ ok: true, highlighted: "el-1" }); // A's late success
  await tick(); await tick();
  assert.equal(panel.$("status").textContent.includes("Highlighted target"), false, "obsolete success is discarded silently");
  assert.equal(panel.doc.querySelector('#targetList .target[aria-current="true"]'), null, "document B is not marked by A's response");
  // Newer selection wins over an older in-flight response.
  panel.doc.querySelector("#targetList .target").click();
  panel.doc.querySelector("#targetList .target").click();
  assert.equal(resolvers.length, 2);
  resolvers[1]({ ok: true, highlighted: "el-1" }); // newer resolves first
  await tick(); await tick();
  assert.ok(panel.doc.querySelector('#targetList .target[aria-current="true"]'), "newer response applies");
  resolvers[0]({ ok: true, highlighted: "el-1" }); // older resolves late
  await tick(); await tick();
  assert.match(panel.$("status").textContent, /Different field/, "status still describes the newer selection");
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

/* --- Feature 10: voice and typed commands -------------------------------- */

function makeSpeechMock() {
  const spoken = [];
  let cancels = 0;
  class Utterance { constructor(text) { this.text = text; } }
  return {
    spoken,
    cancels: () => cancels,
    Utterance,
    synth: { speak(u) { spoken.push(u.text); }, cancel() { cancels += 1; } },
  };
}

function makeRecognitionClass() {
  const instances = [];
  class FakeRecognition {
    constructor() { instances.push(this); }
    start() { this.started = true; }
    stop() { this.stopped = true; }
    abort() { this.aborted = true; }
    fireStart() { if (this.onstart) this.onstart(); }
    fireResult(text, isFinal) {
      if (!this.onresult) return;
      const result = [{ transcript: text }];
      result.isFinal = isFinal;
      this.onresult({ resultIndex: 0, results: [result] });
    }
    fireError(code) { if (this.onerror) this.onerror({ error: code }); }
    fireEnd() { if (this.onend) this.onend(); }
  }
  return { FakeRecognition, instances };
}

const tagImpl = async (_t, msg) => {
  if (msg.type === "SEEYABLE_SHOW_TAGS") return { ok: true, shown: 2, total: 3, revision: 1, documentSessionId: "doc-A" };
  if (msg.type === "SEEYABLE_HIDE_TAGS") return { ok: true, shown: 0, total: 3 };
  if (msg.type === "SEEYABLE_SNAPSHOT_DOM") return { ok: true, snapshot: snap([el("el-1", "Full name")]) };
  throw new Error("unexpected " + msg.type);
};
const tagCalls = (panel, type) => panel.calls.send.filter((c) => c.msg.type === type).length;

test("voice/typed parity: typed show/hide use the shared flows and speak only after ack", async () => {
  const speech = makeSpeechMock();
  const panel = makePanel(tagImpl, { speech });
  panel.$("commandInput").value = "  Show Tags! ";
  panel.$("btnSendCommand").click();
  await tick();
  assert.equal(tagCalls(panel, "SEEYABLE_SHOW_TAGS"), 1);
  assert.match(panel.$("status").textContent, /^Tags shown \(\d+ controls, revision \d+\)\.$/, "count-free message stays truthful without placement precision");
  assert.deepEqual(speech.spoken, ["Tags shown"]);
  panel.$("commandInput").value = "hide tags.";
  panel.$("btnSendCommand").click();
  await tick();
  assert.equal(tagCalls(panel, "SEEYABLE_HIDE_TAGS"), 1);
  assert.deepEqual(speech.spoken, ["Tags shown", "Tags hidden"]);
  assert.equal(panel.calls.execute, 0, "commands never reach the executor");
  panel.dom.window.close();
});

test("voice: interim never dispatches; final dispatches once despite duplicate callbacks", async () => {
  const speech = makeSpeechMock();
  const { FakeRecognition, instances } = makeRecognitionClass();
  const panel = makePanel(tagImpl, { speech, speechRecognition: FakeRecognition });
  panel.$("btnListen").click();
  await tick();
  assert.ok(!/listening/.test(panel.$("voiceState").textContent), "no listening state before recognition starts");
  instances[0].fireStart();
  assert.match(panel.$("voiceState").textContent, /listening/);
  instances[0].fireResult("hide ta", false);
  await tick();
  assert.equal(tagCalls(panel, "SEEYABLE_HIDE_TAGS"), 0, "interim transcripts must not dispatch");
  assert.match(panel.$("voiceTranscript").textContent, /Heard so far: hide ta/);
  instances[0].fireResult("hide tags", true);
  instances[0].fireResult("hide tags", true);
  await tick(); await tick();
  assert.equal(tagCalls(panel, "SEEYABLE_HIDE_TAGS"), 1, "exactly one dispatch per session");
  assert.deepEqual(speech.spoken, [], "no spoken feedback while recognition is still active");
  instances[0].fireEnd();
  assert.deepEqual(speech.spoken, ["Tags hidden"], "feedback is released once the microphone terminates");
  panel.dom.window.close();
});

/* --- Issue #13: local page-action commands ---------------------------------- */
function pageActionImpl(snapshot, onExecute) {
  return async (_t, msg) => {
    if (msg.type === "SEEYABLE_SNAPSHOT_DOM") return { ok: true, snapshot };
    if (msg.type === "SEEYABLE_EXECUTE_ACTION") {
      if (onExecute) return onExecute(msg.request);
      return {
        ok: true, result: { verified: true },
        newSnapshotDiff: { added: [], removed: [], updated: [] },
        documentSessionId: snapshot.documentSessionId, revision: snapshot.revision,
      };
    }
    if (msg.type === "SEEYABLE_CANCEL_CHALLENGE") return { ok: true };
    if (msg.type === "SEEYABLE_GET_ACTION_LOG") return { ok: true, entries: [] };
    throw new Error("unexpected " + msg.type);
  };
}
function sendTyped(panel, text) {
  panel.$("commandInput").value = text;
  panel.$("btnSendCommand").click();
}

test("page-action: typed click exact match executes once through the shared contract", async () => {
  const snapshot = snap([el("el-1", "Full name"), el("el-2", "Work email")]);
  const speech = makeSpeechMock();
  const panel = makePanel(pageActionImpl(snapshot), { speech });
  panel.win.fetch = async () => { throw new Error("network used by local resolution"); };
  sendTyped(panel, "click Full name");
  await tick(); await tick();
  const execs = panel.calls.send.filter((c) => c.msg.type === "SEEYABLE_EXECUTE_ACTION");
  assert.equal(execs.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(execs[0].msg.request)), {
    action: "click", elementId: "el-1", documentSessionId: "doc-A", revision: 1, source: "manual",
  });
  assert.match(panel.$("status").textContent, /Clicked Full name\. Completed and verified/);
  assert.deepEqual(speech.spoken, ["Clicked Full name."]);
  panel.dom.window.close();
});

test("page-action: typed fill preserves the value verbatim and never surfaces it", async () => {
  const snapshot = snap([el("el-7", "Short bio", { role: "textbox" })]);
  const speech = makeSpeechMock();
  const panel = makePanel(pageActionImpl(snapshot), { speech });
  sendTyped(panel, "fill Short bio with Ada Lovelace, Esq.!");
  await tick(); await tick();
  const execs = panel.calls.send.filter((c) => c.msg.type === "SEEYABLE_EXECUTE_ACTION");
  assert.equal(execs.length, 1);
  assert.equal(JSON.parse(JSON.stringify(execs[0].msg.request)).value, "Ada Lovelace, Esq.!");
  for (const text of [panel.$("status").textContent, panel.$("voiceState").textContent, speech.spoken.join(" ")]) {
    assert.ok(!text.includes("Ada"), "fill values stay out of status, voice state, and speech");
  }
  assert.deepEqual(speech.spoken, ["Filled Short bio."]);
  panel.dom.window.close();
});

test("page-action: clear fuzzy executes; weak matches execute nothing", async () => {
  const snapshot = snap([el("el-1", "Full name"), el("el-2", "Work email")]);
  const panel = makePanel(pageActionImpl(snapshot));
  sendTyped(panel, "click ful name");
  await tick(); await tick();
  assert.equal(panel.calls.execute, 1);
  sendTyped(panel, "click banana phone");
  await tick(); await tick();
  assert.equal(panel.calls.execute, 1, "weak match dispatches nothing");
  assert.match(panel.$("status").textContent, /No confident match/);
  panel.dom.window.close();
});

test("page-action: duplicate Continue clarifies; choice executes with stored binding", async () => {
  const snapshot = snap([
    el("el-10", "Continue", { question: "Shipping address", questionCertain: true, role: "button" }),
    el("el-11", "Continue", { question: "Payment method", questionCertain: true, role: "button" }),
  ]);
  const panel = makePanel(pageActionImpl(snapshot));
  sendTyped(panel, "click Continue");
  await tick(); await tick();
  assert.equal(panel.calls.execute, 0, "ambiguity executes nothing");
  assert.equal(panel.$("clarifyBox").hidden, false);
  const buttons = [...panel.$("clarifyChoices").querySelectorAll("button")];
  assert.equal(buttons.length, 2);
  assert.match(buttons[0].textContent, /Shipping address/);
  assert.match(buttons[1].textContent, /Payment method/);
  buttons[1].click();
  await tick(); await tick();
  assert.equal(panel.calls.execute, 1);
  const req = JSON.parse(JSON.stringify(panel.calls.send.find((c) => c.msg.type === "SEEYABLE_EXECUTE_ACTION").msg.request));
  assert.deepEqual(req, { action: "click", elementId: "el-11", documentSessionId: "doc-A", revision: 1, source: "manual" });
  assert.equal(panel.$("clarifyBox").hidden, true);
  panel.dom.window.close();
});

test("page-action: five exact matches are all reachable; option 5 dispatches its id once", async () => {
  const snapshot = snap(["1", "2", "3", "4", "5"].map((n, i) =>
    el(`el-${i + 1}`, n, { question: "How satisfied are you?", questionCertain: true, role: "radio" })));
  const panel = makePanel(pageActionImpl(snapshot));
  sendTyped(panel, "click How satisfied are you");
  await tick(); await tick();
  assert.equal(panel.calls.execute, 0, "ambiguity executes nothing");
  assert.match(panel.$("clarifyPrompt").textContent, /matches 5 controls/, "the prompt states the complete set");
  const buttons = [...panel.$("clarifyChoices").querySelectorAll("button")];
  assert.equal(buttons.length, 5, "no exact match is discarded to meet a cap");
  assert.match(buttons[4].textContent, /5 — How satisfied are you\?/, "words and context lead");
  assert.match(buttons[4].textContent, /\(#5\)$/, "the internal number is secondary");
  buttons[4].click();
  await tick(); await tick();
  assert.equal(panel.calls.execute, 1);
  const req = JSON.parse(JSON.stringify(panel.calls.send.find((c) => c.msg.type === "SEEYABLE_EXECUTE_ACTION").msg.request));
  assert.equal(req.elementId, "el-5", "the fifth option sends its own snapshot id");
  panel.dom.window.close();
});

test("page-action: compound, negated, and incomplete commands send nothing", async () => {
  const snapshot = snap([el("el-1", "Full name")]);
  const panel = makePanel(pageActionImpl(snapshot));
  for (const text of ["click Continue and submit", "don't click Full name", "never fill bio with x", "click", "fill Full name", "fill Full name with", "tap Full name"]) {
    sendTyped(panel, text);
    await tick();
  }
  assert.equal(panel.calls.send.length, 0, "rejected parses never touch the tab");
  assert.equal(panel.calls.execute, 0);
  assert.match(panel.$("status").textContent, /Supported commands/);
  panel.dom.window.close();
});

test("page-action: disabled exact match is rejected by the executor, not redirected", async () => {
  const snapshot = snap([
    el("el-5", "Save draft", { role: "button", state: { disabled: true }, actionable: false }),
    el("el-6", "Save draft copy", { role: "button" }),
  ]);
  const panel = makePanel(pageActionImpl(snapshot, () => ({
    ok: false, error: { code: "TARGET_DISABLED", message: "Target el-5 is disabled." },
    newSnapshotDiff: null, diffUnavailableReason: "rejected before dispatch",
    documentSessionId: "doc-A", revision: 1,
  })));
  sendTyped(panel, "click Save draft");
  await tick(); await tick();
  const execs = panel.calls.send.filter((c) => c.msg.type === "SEEYABLE_EXECUTE_ACTION");
  assert.equal(execs.length, 1);
  assert.equal(JSON.parse(JSON.stringify(execs[0].msg.request)).elementId, "el-5");
  assert.match(panel.$("status").textContent, /Could not click Save draft: TARGET_DISABLED/);
  panel.dom.window.close();
});

test("page-action: consequential click is held for human approval", async () => {
  const snapshot = snap([el("el-20", "Submit survey", { role: "button" })]);
  const speech = makeSpeechMock();
  const panel = makePanel(pageActionImpl(snapshot, () => ({
    ok: false,
    error: { code: "CONFIRMATION_REQUIRED", message: "Approval required." },
    confirmation: {
      challengeId: "ch-1", elementId: "el-20", action: "click", targetName: "Submit survey",
      consequence: "This submits the form.", expiresAt: "2099-01-01T00:00:00.000Z",
    },
    diffUnavailableReason: "awaiting human confirmation",
    documentSessionId: "doc-A", revision: 1,
  })), { speech });
  sendTyped(panel, "click Submit survey");
  await tick(); await tick();
  assert.equal(panel.calls.execute, 1, "one held request, zero activations");
  assert.equal(panel.$("confirmBox").hidden, false);
  assert.equal(panel.doc.activeElement.id, "confirmTitle", "focus moves to the confirmation heading, never Approve");
  assert.match(panel.$("status").textContent, /waiting for your approval/);
  assert.deepEqual(speech.spoken, ["Waiting for your approval."]);
  panel.dom.window.close();
});

test("page-action: stale clarification choices expire without executing", async () => {
  const snapshot = snap([
    el("el-10", "Continue", { question: "Shipping", questionCertain: true, role: "button" }),
    el("el-11", "Continue", { question: "Payment", questionCertain: true, role: "button" }),
  ]);
  const panel = makePanel(pageActionImpl(snapshot));
  sendTyped(panel, "click Continue");
  await tick(); await tick();
  const stale = [...panel.$("clarifyChoices").querySelectorAll("button")];
  for (const fn of panel.listeners.activated) fn({ tabId: 999, windowId: 1 }); // tab change invalidates
  await tick();
  assert.equal(panel.$("clarifyBox").hidden, true);
  stale[0].click(); // detached button: the guard must still hold
  await tick();
  assert.equal(panel.calls.execute, 0);
  assert.match(panel.$("status").textContent, /expired/);
  panel.dom.window.close();
});

test("page-action: a newer command invalidates pending clarification", async () => {
  const snapshot = snap([
    el("el-10", "Continue", { question: "Shipping", questionCertain: true, role: "button" }),
    el("el-11", "Continue", { question: "Payment", questionCertain: true, role: "button" }),
  ]);
  const panel = makePanel(pageActionImpl(snapshot));
  sendTyped(panel, "click Continue");
  await tick(); await tick();
  const stale = [...panel.$("clarifyChoices").querySelectorAll("button")];
  sendTyped(panel, "click banana phone"); // newer command supersedes
  await tick(); await tick();
  stale[0].click();
  await tick();
  assert.equal(panel.calls.execute, 0);
  assert.match(panel.$("status").textContent, /expired/);
  panel.dom.window.close();
});

test("page-action: voice final dispatches click once; duplicate finals dispatch once", async () => {
  const snapshot = snap([el("el-1", "Full name")]);
  const speech = makeSpeechMock();
  const { FakeRecognition, instances } = makeRecognitionClass();
  const panel = makePanel(pageActionImpl(snapshot), { speech, speechRecognition: FakeRecognition });
  panel.$("btnListen").click();
  await tick();
  instances[0].fireStart();
  instances[0].fireResult("click Full name", true);
  instances[0].fireResult("click Full name", true);
  await tick(); await tick();
  assert.equal(panel.calls.execute, 1);
  const req = JSON.parse(JSON.stringify(panel.calls.send.find((c) => c.msg.type === "SEEYABLE_EXECUTE_ACTION").msg.request));
  assert.equal(req.source, "voice");
  assert.deepEqual(speech.spoken, [], "no spoken feedback while recognition is still active");
  instances[0].fireEnd();
  assert.deepEqual(speech.spoken, ["Clicked Full name."]);
  panel.dom.window.close();
});

test("page-action: sensitive fill is blocked by the executor; value stays out of messages", async () => {
  const snapshot = snap([el("el-5", "Account PIN", { role: "textbox" })]);
  const speech = makeSpeechMock();
  const panel = makePanel(pageActionImpl(snapshot, () => ({
    ok: false, error: { code: "SENSITIVE_FIELD", message: "Target el-5 is a protected field; writes are blocked in this milestone." },
    newSnapshotDiff: null, diffUnavailableReason: "rejected before dispatch",
    documentSessionId: "doc-A", revision: 1,
  })), { speech });
  sendTyped(panel, "fill Account PIN with 1234");
  await tick(); await tick();
  assert.equal(panel.calls.execute, 1);
  assert.match(panel.$("status").textContent, /Could not fill Account PIN: SENSITIVE_FIELD/);
  assert.ok(!panel.$("status").textContent.includes("1234"), "rejected value is not echoed");
  assert.deepEqual(speech.spoken, [], "failures are not spoken as success");
  panel.dom.window.close();
});

test("page-action: paused executor surfaces honestly through commands", async () => {
  const snapshot = snap([el("el-1", "Full name")]);
  const panel = makePanel(pageActionImpl(snapshot, () => ({
    ok: false, error: { code: "EXECUTION_PAUSED", message: "Execution is paused." },
    newSnapshotDiff: null, diffUnavailableReason: "paused",
    documentSessionId: "doc-A", revision: 1,
  })));
  sendTyped(panel, "click Full name");
  await tick(); await tick();
  assert.equal(panel.calls.execute, 1, "one attempt, no replay around the pause");
  assert.match(panel.$("status").textContent, /EXECUTION_PAUSED/);
  panel.dom.window.close();
});

test("page-action: voice cancellation during held execution discards without replay", async () => {
  const snapshot = snap([el("el-1", "Full name")]);
  const speech = makeSpeechMock();
  const { FakeRecognition, instances } = makeRecognitionClass();
  let release;
  const held = new Promise((res) => { release = res; });
  const panel = makePanel(pageActionImpl(snapshot, () => held), { speech, speechRecognition: FakeRecognition });
  panel.$("btnListen").click();
  await tick();
  instances[0].fireStart();
  instances[0].fireResult("click Full name", true);
  await tick();
  assert.equal(panel.calls.execute, 1);
  panel.$("btnCancelListen").click(); // invalidates the in-flight interaction
  release({ ok: true, result: { verified: true }, newSnapshotDiff: null, documentSessionId: "doc-A", revision: 1 });
  await tick(); await tick();
  assert.equal(panel.calls.execute, 1, "no replay after cancellation");
  assert.match(panel.$("voiceState").textContent, /cancelled/);
  panel.dom.window.close();
});

test("page-action: tab change during held execution discards honestly without replay", async () => {
  const snapshot = snap([el("el-1", "Full name")]);
  let release;
  const held = new Promise((res) => { release = res; });
  const panel = makePanel(pageActionImpl(snapshot, () => held));
  sendTyped(panel, "click Full name");
  await tick();
  for (const fn of panel.listeners.activated) fn({ tabId: 999, windowId: 1 });
  release({ ok: true, result: { verified: true }, newSnapshotDiff: null, documentSessionId: "doc-A", revision: 1 });
  await tick(); await tick();
  assert.equal(panel.calls.execute, 1, "exactly one dispatch, never replayed");
  assert.match(panel.$("voiceState").textContent, /result was discarded/);
  panel.dom.window.close();
});

test("page-action: cancel during held execution revokes the late challenge; no approval appears", async () => {
  const snapshot = snap([el("el-20", "Submit survey", { role: "button" })]);
  let release;
  const held = new Promise((res) => { release = res; });
  const speech = makeSpeechMock();
  const panel = makePanel(pageActionImpl(snapshot, () => held), { speech });
  sendTyped(panel, "click Submit survey");
  await tick();
  assert.equal(panel.calls.execute, 1);
  panel.$("btnCancelListen").click(); // cancel while the executor holds the request
  release({
    ok: false,
    error: { code: "CONFIRMATION_REQUIRED", message: "Approval required." },
    confirmation: {
      challengeId: "ch-late", elementId: "el-20", action: "click", targetName: "Submit survey",
      consequence: "This submits the form.", expiresAt: "2099-01-01T00:00:00.000Z",
    },
    documentSessionId: "doc-A", revision: 1,
  });
  await tick(); await tick();
  assert.equal(panel.$("confirmBox").hidden, true, "cancelled command must never become approvable");
  const cancels = panel.calls.send.filter((c) => c.msg.type === "SEEYABLE_CANCEL_CHALLENGE");
  assert.equal(cancels.length, 1, "the late challenge is revoked through the trusted cancel route");
  assert.equal(cancels[0].msg.challengeId, "ch-late");
  assert.match(panel.$("voiceState").textContent, /cancelled/);
  assert.match(panel.$("voiceState").textContent, /may already have reached the page/, "honest about possible dispatch");
  assert.deepEqual(speech.spoken, [], "no approval prompt is spoken for a cancelled command");
  panel.dom.window.close();
});

function gateImpl(snapshot, gateState) {
  const inner = pageActionImpl(snapshot);
  return async (t, msg) => {
    if (msg.type === "SEEYABLE_GATE_CONTROL") {
      if (msg.command === "stop") { gateState.stopped = true; gateState.paused = false; }
      else if (msg.command === "pause") { gateState.paused = true; gateState.stopped = false; }
      else { gateState.paused = false; gateState.stopped = false; }
      return { ok: true, gate: { ...gateState } };
    }
    return inner(t, msg);
  };
}

test("page-action: Pause/Resume during snapshot acquisition dispatches nothing", async () => {
  let releaseSnap;
  const heldSnap = new Promise((res) => { releaseSnap = res; });
  const snapshot = snap([el("el-1", "Full name")]);
  const gateState = { paused: false, stopped: false };
  const panel = makePanel(async (t, msg) => {
    if (msg.type === "SEEYABLE_SNAPSHOT_DOM") { await heldSnap; return { ok: true, snapshot }; }
    return gateImpl(snapshot, gateState)(t, msg);
  });
  sendTyped(panel, "click Full name"); // no bound snapshot: acquisition starts
  await tick();
  assert.equal(panel.calls.send.filter((c) => c.msg.type === "SEEYABLE_SNAPSHOT_DOM").length, 1);
  panel.$("btnPauseExec").click();
  await tick();
  assert.equal(panel.$("btnPauseExec").textContent, "Resume");
  panel.$("btnPauseExec").click(); // Resume restores availability only
  await tick();
  assert.equal(panel.$("btnPauseExec").textContent, "Pause");
  releaseSnap();
  await tick(); await tick();
  assert.equal(panel.calls.execute, 0, "the older command must never revive after Resume");
  assert.match(panel.$("voiceState").textContent, /paused/);
  panel.dom.window.close();
});

test("page-action: Stop/Resume during snapshot acquisition dispatches nothing", async () => {
  let releaseSnap;
  const heldSnap = new Promise((res) => { releaseSnap = res; });
  const snapshot = snap([el("el-1", "Full name")]);
  const gateState = { paused: false, stopped: false };
  const panel = makePanel(async (t, msg) => {
    if (msg.type === "SEEYABLE_SNAPSHOT_DOM") { await heldSnap; return { ok: true, snapshot }; }
    return gateImpl(snapshot, gateState)(t, msg);
  });
  sendTyped(panel, "click Full name");
  await tick();
  panel.$("btnStopExec").click();
  await tick();
  assert.equal(panel.$("btnPauseExec").textContent, "Resume", "stopped gate offers Resume");
  panel.$("btnPauseExec").click();
  await tick();
  releaseSnap();
  await tick(); await tick();
  assert.equal(panel.calls.execute, 0, "Stop permanently invalidates the pending command");
  assert.match(panel.$("voiceState").textContent, /stopped/);
  panel.dom.window.close();
});

test("page-action: obsolete clarification callback cannot cross-wire a newer round", async () => {
  const snapshot = snap([
    el("el-1", "Email", { question: "Account", questionCertain: true }),
    el("el-2", "Email", { question: "Recovery", questionCertain: true }),
    el("el-3", "Comment", { question: "Visit", questionCertain: true }),
    el("el-4", "Comment", { question: "Staff", questionCertain: true }),
  ]);
  const panel = makePanel(pageActionImpl(snapshot));
  sendTyped(panel, "fill Email with first");
  await tick(); await tick();
  const oldButtons = [...panel.$("clarifyChoices").querySelectorAll("button")];
  assert.equal(oldButtons.length, 2);
  sendTyped(panel, "fill Comment with second"); // newer round supersedes the Email choices
  await tick(); await tick();
  assert.equal(panel.$("clarifyBox").hidden, false);
  assert.match(panel.$("clarifyPrompt").textContent, /Comment/);
  oldButtons[0].click(); // obsolete Email callback while Comment round is pending
  await tick();
  assert.equal(panel.calls.execute, 0, "an obsolete choice executes nothing");
  assert.equal(panel.$("clarifyBox").hidden, false, "the newer clarification stays visible");
  assert.match(panel.$("clarifyPrompt").textContent, /Comment/, "the newer clarification is unaltered");
  const current = [...panel.$("clarifyChoices").querySelectorAll("button")];
  assert.equal(current.length, 2);
  current[0].click(); // the valid current choice still works with ITS target and value
  await tick(); await tick();
  assert.equal(panel.calls.execute, 1);
  const req = JSON.parse(JSON.stringify(panel.calls.send.find((c) => c.msg.type === "SEEYABLE_EXECUTE_ACTION").msg.request));
  assert.deepEqual(req, { action: "fill", elementId: "el-3", documentSessionId: "doc-A", revision: 1, value: "second", source: "manual" });
  panel.dom.window.close();
});

test("page-action: command lock spans the post-action refresh; late refresh cannot reorder state", async () => {
  const rev1 = snap([el("el-1", "Full name")], 1);
  const rev2 = snap([el("el-1", "Full name")], 2);
  let releaseRefresh;
  const heldRefresh = new Promise((res) => { releaseRefresh = res; });
  let snapshots = 0;
  const panel = makePanel(async (_t, msg) => {
    if (msg.type === "SEEYABLE_SNAPSHOT_DOM") {
      snapshots += 1;
      if (snapshots === 1) return { ok: true, snapshot: rev1 };
      await heldRefresh;
      return { ok: true, snapshot: rev2 };
    }
    if (msg.type === "SEEYABLE_EXECUTE_ACTION") {
      return { ok: true, result: { verified: true }, newSnapshotDiff: { added: [], removed: [], updated: [] }, documentSessionId: "doc-A", revision: 1 };
    }
    if (msg.type === "SEEYABLE_GET_ACTION_LOG") return { ok: true, entries: [] };
    throw new Error("unexpected " + msg.type);
  });
  sendTyped(panel, "click Full name");
  await tick(); await tick();
  assert.equal(panel.calls.execute, 1, "command dispatched while its refresh is held");
  assert.equal(panel.$("btnSendCommand").disabled, true, "Send stays disabled through the refresh");
  // A second command during the held refresh: the disabled Send click is
  // dropped, and the Enter path hits the dispatch guard — nothing queues.
  panel.$("commandInput").value = "click Full name";
  panel.$("btnSendCommand").click();
  panel.$("commandInput").dispatchEvent(new panel.win.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  await tick();
  assert.equal(panel.calls.execute, 1, "exactly one dispatch until refresh completes");
  assert.match(panel.$("voiceState").textContent, /already running/);
  for (const fn of panel.listeners.activated) fn({ tabId: 999, windowId: 1 }); // tab change before release
  releaseRefresh();
  await tick(); await tick();
  assert.equal(panel.calls.execute, 1, "no replay");
  assert.equal(panel.$("targetSelect").options.length, 1, "the late refresh cannot restore the old tab's targets");
  assert.match(panel.$("voiceState").textContent, /discarded/);
  panel.dom.window.close();
});

test("commands: unknown, negated, and empty input execute nothing and list supported commands", async () => {
  const panel = makePanel(tagImpl, { speech: makeSpeechMock() });
  for (const text of ["don't show tags", "delete the page", "show tags please", ""]) {
    panel.$("commandInput").value = text;
    panel.$("btnSendCommand").click();
    await tick();
  }
  assert.equal(tagCalls(panel, "SEEYABLE_SHOW_TAGS"), 0);
  assert.equal(tagCalls(panel, "SEEYABLE_HIDE_TAGS"), 0);
  assert.equal(panel.calls.execute, 0);
  assert.match(panel.$("status").textContent, /Supported commands: "show tags", "hide tags", "click <target>", and "fill <target> with <value>"/);
  panel.dom.window.close();
});

test("commands: typed unsupported input shows one error; voice stays idle; no error pill", async () => {
  const panel = makePanel(tagImpl, { speech: makeSpeechMock() });
  panel.$("commandInput").value = "delete the page";
  panel.$("btnSendCommand").click();
  await tick();
  assert.match(panel.$("status").textContent, /Unsupported command/, "the one authoritative error message");
  assert.ok(panel.$("status").classList.contains("error"), "the error is styled as an error");
  assert.equal(panel.$("voiceState").textContent, "Voice: idle.", "no duplicate voice failure for typed input");
  assert.equal(panel.$("stateChip").textContent, "Ready", "available for the next command; the failure stays visible in status");
  assert.ok(!panel.$("stateChip").textContent.includes("Needs attention"), "no error pill");
  assert.equal(panel.calls.execute, 0);
  assert.equal(tagCalls(panel, "SEEYABLE_SHOW_TAGS"), 0);
  assert.equal(tagCalls(panel, "SEEYABLE_HIDE_TAGS"), 0);
  panel.dom.window.close();
});

test("voice: cancel discards the utterance; stop may finish it", async () => {
  const { FakeRecognition, instances } = makeRecognitionClass();
  const panel = makePanel(tagImpl, { speech: makeSpeechMock(), speechRecognition: FakeRecognition });
  panel.$("btnListen").click();
  await tick();
  instances[0].fireStart();
  const late = instances[0].onresult;
  panel.$("btnCancelListen").click();
  await tick();
  const result = [{ transcript: "show tags" }];
  result.isFinal = true;
  late({ resultIndex: 0, results: [result] });
  await tick();
  assert.equal(tagCalls(panel, "SEEYABLE_SHOW_TAGS"), 0, "cancelled utterance must not dispatch");
  assert.match(panel.$("voiceState").textContent, /cancelled/);

  panel.$("btnListen").click();
  await tick();
  instances[1].fireStart();
  panel.$("btnStopListen").click();
  instances[1].fireResult("show tags", true);
  await tick(); await tick();
  assert.equal(tagCalls(panel, "SEEYABLE_SHOW_TAGS"), 1, "stopped session may deliver its final utterance once");
  panel.dom.window.close();
});

test("voice: unsupported or denied recognition leaves typed commands working", async () => {
  const denied = makeRecognitionClass();
  const panel = makePanel(tagImpl, { speech: makeSpeechMock(), speechRecognition: denied.FakeRecognition });
  panel.$("btnListen").click();
  await tick();
  denied.instances[0].fireError("not-allowed");
  await tick();
  assert.match(panel.$("voiceState").textContent, /Microphone access was denied/);
  panel.$("commandInput").value = "show tags";
  panel.$("btnSendCommand").click();
  await tick();
  assert.equal(tagCalls(panel, "SEEYABLE_SHOW_TAGS"), 1, "typed fallback works after denial");

  const plain = makePanel(tagImpl, { speech: makeSpeechMock() });
  assert.equal(plain.$("btnListen").disabled, true, "unsupported recognition disables Start");
  assert.match(plain.$("voiceNote").textContent, /not available/);
  plain.$("commandInput").value = "hide tags";
  plain.$("btnSendCommand").click();
  await tick();
  assert.equal(tagCalls(plain, "SEEYABLE_HIDE_TAGS"), 1);
  panel.dom.window.close();
  plain.dom.window.close();
});

test("commands: busy operations refuse new commands without queueing", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const panel = makePanel(async (_t, msg) => {
    if (msg.type === "SEEYABLE_SHOW_TAGS") { await gate; return { ok: true, shown: 1, total: 1, revision: 1, documentSessionId: "doc-A" }; }
    if (msg.type === "SEEYABLE_SNAPSHOT_DOM") return { ok: true, snapshot: snap([el("el-1", "Full name")]) };
    throw new Error("unexpected " + msg.type);
  }, { speech: makeSpeechMock() });
  panel.$("commandInput").value = "show tags";
  panel.$("btnSendCommand").click();
  await tick(); await tick();
  panel.$("commandInput").value = "hide tags";
  panel.$("btnSendCommand").click(); // Send is disabled while a command runs
  panel.$("commandInput").dispatchEvent(new panel.win.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  await tick();
  assert.equal(tagCalls(panel, "SEEYABLE_SHOW_TAGS"), 1, "no duplicate or queued dispatch while busy");
  release();
  await tick(); await tick();
  assert.equal(tagCalls(panel, "SEEYABLE_HIDE_TAGS"), 0, "the refused command was not queued");
  panel.dom.window.close();
});

test("voice: tab change before the result discards the session; transcripts are not persisted or logged", async () => {
  const speech = makeSpeechMock();
  const { FakeRecognition, instances } = makeRecognitionClass();
  const panel = makePanel(tagImpl, { speech, speechRecognition: FakeRecognition });
  panel.$("btnListen").click();
  await tick();
  instances[0].fireStart();
  const late = instances[0].onresult;
  for (const fn of panel.listeners.activated) fn({ tabId: 999, windowId: 1 });
  const result = [{ transcript: "show tags" }];
  result.isFinal = true;
  late({ resultIndex: 0, results: [result] });
  await tick(); await tick();
  assert.equal(tagCalls(panel, "SEEYABLE_SHOW_TAGS"), 0, "a late transcript must not act after a tab change");
  assert.deepEqual(speech.spoken, []);
  assert.equal(panel.calls.storage, 0, "transcripts are never persisted");
  assert.ok(!panel.logs.join(" ").includes("show tags"), "raw utterances are never logged");
  assert.ok(!panel.$("output").textContent.includes("show tags"), "transcripts never enter snapshot copy/download output");
  panel.dom.window.close();
});

test("commands: tab change during dispatch discards the outcome and speaks no success", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const speech = makeSpeechMock();
  const panel = makePanel(async (_t, msg) => {
    if (msg.type === "SEEYABLE_SHOW_TAGS") { await gate; return { ok: true, shown: 1, total: 1, revision: 1, documentSessionId: "doc-A" }; }
    if (msg.type === "SEEYABLE_SNAPSHOT_DOM") return { ok: true, snapshot: snap([el("el-1", "Full name")]) };
    throw new Error("unexpected " + msg.type);
  }, { speech });
  panel.$("commandInput").value = "show tags";
  panel.$("btnSendCommand").click();
  await tick(); await tick();
  for (const fn of panel.listeners.activated) fn({ tabId: 999, windowId: 1 });
  release();
  await tick(); await tick();
  assert.deepEqual(speech.spoken, [], "discarded outcomes are never spoken as success");
  assert.match(panel.$("voiceState").textContent, /discarded/);
  panel.dom.window.close();
});

test("speech feedback: mute prevents speech; failed commands never speak success", async () => {
  const speech = makeSpeechMock();
  const panel = makePanel(async (_t, msg) => {
    if (msg.type === "SEEYABLE_SHOW_TAGS") return { ok: false, error: "Receiving end does not exist" };
    throw new Error("unexpected " + msg.type);
  }, { speech });
  panel.$("chkSpeak").checked = false;
  panel.$("chkSpeak").dispatchEvent(new panel.win.Event("change"));
  panel.$("commandInput").value = "show tags";
  panel.$("btnSendCommand").click();
  await tick(); await tick();
  assert.deepEqual(speech.spoken, [], "muted and failed outcomes produce no spoken success");
  assert.match(panel.$("status").textContent, /error|failed|Could not/i, "the failure surfaces once, in status");
  assert.equal(panel.$("voiceState").textContent, "Voice: idle.", "no duplicate voice failure");
  panel.$("btnStopSpeech").click();
  assert.ok(speech.cancels() >= 1, "Stop speech cancels synthesis");
  panel.dom.window.close();
});

test("microphone setup button opens the narrowly scoped setup page", async () => {
  const panel = makePanel(tagImpl, { speech: makeSpeechMock() });
  panel.$("btnMicSetup").click();
  await tick();
  assert.deepEqual(JSON.parse(JSON.stringify(panel.calls.tabsCreated)), [{ url: "chrome-extension://test/mic-setup.html" }]);
  panel.dom.window.close();
});

test("voice: cancel during a held command acknowledgment suppresses speech and presentation", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const speech = makeSpeechMock();
  const { FakeRecognition, instances } = makeRecognitionClass();
  const panel = makePanel(async (_t, msg) => {
    if (msg.type === "SEEYABLE_HIDE_TAGS") { await gate; return { ok: true, shown: 0, total: 3 }; }
    throw new Error("unexpected " + msg.type);
  }, { speech, speechRecognition: FakeRecognition });
  panel.$("btnListen").click();
  await tick();
  instances[0].fireStart();
  instances[0].fireResult("hide tags", true);
  await tick(); await tick();
  assert.equal(tagCalls(panel, "SEEYABLE_HIDE_TAGS"), 1, "the command was sent; cancel does not pretend otherwise");
  panel.$("btnCancelListen").click();
  await tick();
  release();
  await tick(); await tick();
  instances[0].fireEnd();
  await tick();
  assert.deepEqual(speech.spoken, [], "a cancelled interaction never speaks its late acknowledgment");
  assert.match(panel.$("voiceState").textContent, /cancelled/);
  assert.match(panel.$("voiceState").textContent, /may still have taken effect/);
  panel.dom.window.close();
});

test("commands: pending hide locks manual execution, snapshot, and overlay until it settles", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  let snapCount = 0;
  const panel = makePanel(async (_t, msg) => {
    if (msg.type === "SEEYABLE_SNAPSHOT_DOM") { snapCount += 1; return { ok: true, snapshot: snap([el("el-1", "Full name")], snapCount) }; }
    if (msg.type === "SEEYABLE_HIDE_TAGS") { await gate; return { ok: true, shown: 0, total: 3 }; }
    if (msg.type === "SEEYABLE_EXECUTE_ACTION") return { ok: true, result: { verified: true }, newSnapshotDiff: { added: [], removed: [], updated: [] }, documentSessionId: "doc-A", revision: 2 };
    throw new Error("unexpected " + msg.type);
  }, { speech: makeSpeechMock() });
  await takeSnapshot(panel);
  selectTarget(panel, "el-1");
  panel.$("commandInput").value = "hide tags";
  panel.$("btnSendCommand").click();
  await tick(); await tick();
  assert.equal(panel.$("btnExecute").disabled, true, "Execute is locked during a pending command");
  panel.$("btnExecute").click();
  panel.$("btnDom").click();
  panel.$("btnShowTags").click();
  await tick();
  assert.equal(panel.calls.execute, 0, "guarded handler sends no executor request during a command");
  assert.equal(snapCount, 1, "snapshot acquisition is locked during a command");
  assert.equal(tagCalls(panel, "SEEYABLE_SHOW_TAGS"), 0, "overlay dispatch is locked during a command");
  release();
  await tick(); await tick();
  assert.equal(panel.$("btnExecute").disabled, false, "lock is released after the command settles");
  panel.dom.window.close();
});

test("commands: hide without a bound snapshot retains tab ownership; reload invalidates its result", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const speech = makeSpeechMock();
  const panel = makePanel(async (_t, msg) => {
    if (msg.type === "SEEYABLE_HIDE_TAGS") { await gate; return { ok: true, shown: 0, total: 3 }; }
    throw new Error("unexpected " + msg.type);
  }, { speech });
  panel.$("commandInput").value = "hide tags";
  panel.$("btnSendCommand").click();
  await tick(); await tick();
  for (const fn of panel.listeners.updated) fn(111, { status: "loading" });
  release();
  await tick(); await tick();
  assert.deepEqual(speech.spoken, [], "reloaded tab: late hide acknowledgment is not spoken");
  assert.match(panel.$("voiceState").textContent, /discarded/);
  panel.dom.window.close();
});

test("speech: starting recognition cancels existing spoken feedback", async () => {
  const speech = makeSpeechMock();
  const { FakeRecognition, instances } = makeRecognitionClass();
  const panel = makePanel(tagImpl, { speech, speechRecognition: FakeRecognition });
  panel.$("commandInput").value = "show tags";
  panel.$("btnSendCommand").click();
  await tick(); await tick();
  assert.deepEqual(speech.spoken, ["Tags shown"]);
  const cancelsBefore = speech.cancels();
  panel.$("btnListen").click();
  await tick();
  assert.ok(speech.cancels() > cancelsBefore, "listening must cancel prior speech so it is not transcribed");
  instances[0].fireStart();
  assert.match(panel.$("voiceState").textContent, /listening/);
  panel.dom.window.close();
});

test("speech: Stop speech before recognition end drops held feedback without reversing the command", async () => {
  const speech = makeSpeechMock();
  const { FakeRecognition, instances } = makeRecognitionClass();
  const panel = makePanel(tagImpl, { speech, speechRecognition: FakeRecognition });
  panel.$("btnListen").click();
  await tick();
  instances[0].fireStart();
  instances[0].fireResult("hide tags", true); // acknowledged immediately; onend held
  await tick(); await tick();
  assert.equal(tagCalls(panel, "SEEYABLE_HIDE_TAGS"), 1, "the page command completed");
  assert.deepEqual(speech.spoken, [], "feedback is held while recognition remains active");
  assert.match(panel.$("voiceState").textContent, /finishing/, "microphone must not be reported idle before it terminates");
  assert.equal(panel.$("btnStopListen").disabled, false, "Stop listening stays available while recognition is active");
  panel.$("btnStopSpeech").click();
  instances[0].fireEnd();
  await tick();
  assert.deepEqual(speech.spoken, [], "stopped held feedback must never speak after onend");
  assert.match(panel.$("status").textContent, /Tags hidden/, "the completed overlay command is not reversed or hidden from the user");
  assert.match(panel.$("voiceState").textContent, /Voice: idle/, "state returns to idle once recognition has actually ended");
  panel.dom.window.close();
});

/* --- Feature 11: safety gate panel --------------------------------------- */

const confirmationResponse = {
  ok: false,
  error: { code: "CONFIRMATION_REQUIRED", message: "click on \"Submit feedback\" is consequential" },
  confirmation: {
    challengeId: "ch-test-1", action: "click", elementId: "el-1", targetName: "Submit feedback",
    targetQuestion: null, evidence: "native-submit", consequence: "This activates a form submission control.",
    pageUrl: "https://example.test/form", documentSessionId: "doc-A", revision: 1,
    expiresAt: "2026-10-28T12:01:00.000Z",
  },
  newSnapshotDiff: null, diffUnavailableReason: "awaiting human confirmation; nothing was performed",
  documentSessionId: "doc-A", revision: 1,
};

function gatePanel({ approveImpl, cancelImpl } = {}) {
  let snapCount = 0;
  const sent = [];
  const panel = makePanel(async (_t, msg) => {
    sent.push(msg.type);
    if (msg.type === "SEEYABLE_SNAPSHOT_DOM") { snapCount += 1; return { ok: true, snapshot: snap([el("el-1", "Submit feedback")], snapCount) }; }
    if (msg.type === "SEEYABLE_EXECUTE_ACTION") return JSON.parse(JSON.stringify(confirmationResponse));
    if (msg.type === "SEEYABLE_APPROVE_CHALLENGE") return approveImpl ? approveImpl(msg) : { ok: true, result: { dispatched: true, verified: true }, newSnapshotDiff: { added: [], removed: [], updated: [] }, documentSessionId: "doc-A", revision: 2 };
    if (msg.type === "SEEYABLE_CANCEL_CHALLENGE") return cancelImpl ? cancelImpl(msg) : { ok: true, cancelled: true };
    if (msg.type === "SEEYABLE_GET_ACTION_LOG") return { ok: true, entries: [{ timestamp: "2026-10-28T12:00:00.000Z", source: "manual", action: "click", elementId: "el-1", targetName: "Submit feedback", decision: "confirmation-required", approved: false }] };
    if (msg.type === "SEEYABLE_CLEAR_ACTION_LOG") return { ok: true, cleared: true };
    if (msg.type === "SEEYABLE_GATE_CONTROL") return { ok: true, gate: msg.command === "stop" ? { stopped: true, paused: false } : msg.command === "pause" ? { paused: true, stopped: false } : { paused: false, stopped: false } };
    throw new Error("unexpected " + msg.type);
  });
  return { panel, sent, snapCount: () => snapCount };
}

test("gate: confirmation is held without refresh; Approve once runs it and then refreshes", async () => {
  const { panel, sent, snapCount } = gatePanel({});
  await takeSnapshot(panel);
  selectTarget(panel, "el-1");
  panel.$("btnExecute").click();
  await tick(); await tick();
  assert.equal(panel.$("confirmBox").hidden, false, "confirmation UI is shown");
  assert.match(panel.$("confirmText").textContent, /Submit feedback/);
  assert.match(panel.$("confirmText").textContent, /form submission control/);
  assert.equal(snapCount(), 1, "confirmation-required must not trigger the post-action refresh/replay path");
  assert.equal(panel.$("btnExecute").disabled, true, "the reviewed request stays fixed while approval is pending");
  panel.$("btnApproveOnce").click();
  await tick(); await tick(); await tick();
  assert.ok(sent.includes("SEEYABLE_APPROVE_CHALLENGE"), "approval travels the dedicated route with only the challenge id");
  assert.match(panel.$("execResult").textContent, /verified/);
  assert.equal(panel.$("confirmBox").hidden, true);
  assert.equal(snapCount(), 2, "the approved execution is followed by the usual same-tab refresh");
  panel.dom.window.close();
});

test("gate: Cancel revokes the challenge and executes nothing further", async () => {
  const { panel, sent } = gatePanel({});
  await takeSnapshot(panel);
  selectTarget(panel, "el-1");
  panel.$("btnExecute").click();
  await tick(); await tick();
  panel.$("btnCancelChallenge").click();
  await tick(); await tick();
  assert.ok(sent.includes("SEEYABLE_CANCEL_CHALLENGE"));
  assert.ok(!sent.includes("SEEYABLE_APPROVE_CHALLENGE"));
  assert.equal(panel.$("confirmBox").hidden, true);
  assert.match(panel.$("confirmStatus").textContent, /revoked; nothing was executed/);
  panel.dom.window.close();
});

test("gate: expired approval is shown as a dead end requiring a fresh request", async () => {
  const { panel } = gatePanel({
    approveImpl: () => ({ ok: false, error: { code: "APPROVAL_EXPIRED", message: "The confirmation expired before approval." }, newSnapshotDiff: null, diffUnavailableReason: "x", documentSessionId: "doc-A", revision: 1 }),
  });
  await takeSnapshot(panel);
  selectTarget(panel, "el-1");
  panel.$("btnExecute").click();
  await tick(); await tick();
  panel.$("btnApproveOnce").click();
  await tick(); await tick();
  assert.match(panel.$("confirmStatus").textContent, /APPROVAL_EXPIRED/);
  assert.equal(panel.$("confirmBox").hidden, true);
  panel.dom.window.close();
});

test("gate: tab change revokes a pending confirmation", async () => {
  const { panel, sent } = gatePanel({});
  await takeSnapshot(panel);
  selectTarget(panel, "el-1");
  panel.$("btnExecute").click();
  await tick(); await tick();
  assert.equal(panel.$("confirmBox").hidden, false);
  for (const fn of panel.listeners.activated) fn({ tabId: 999, windowId: 1 });
  await tick();
  assert.equal(panel.$("confirmBox").hidden, true, "pending confirmation is discarded on tab change");
  assert.ok(sent.includes("SEEYABLE_CANCEL_CHALLENGE"), "revocation is sent to the owning tab");
  panel.dom.window.close();
});

test("gate: Stop and Pause controls drive the executor gate and update state", async () => {
  const { panel, sent } = gatePanel({});
  panel.$("btnStopExec").click();
  await tick(); await tick();
  assert.ok(sent.includes("SEEYABLE_GATE_CONTROL"));
  assert.match(panel.$("gateStatus").textContent, /stopped/i);
  assert.equal(panel.$("btnPauseExec").textContent, "Resume");
  panel.$("btnPauseExec").click(); // gateClosed -> resume
  await tick(); await tick();
  assert.match(panel.$("gateStatus").textContent, /Gate: open/);
  assert.equal(panel.$("btnPauseExec").textContent, "Pause");
  panel.dom.window.close();
});

test("gate: action log renders safe entries and Clear empties it", async () => {
  const { panel, sent } = gatePanel({});
  panel.$("btnRefreshLog").click();
  await tick(); await tick();
  assert.match(panel.$("actionLog").textContent, /confirmation-required/);
  assert.match(panel.$("actionLog").textContent, /Submit feedback/);
  panel.$("btnClearLog").click();
  await tick(); await tick();
  assert.ok(sent.includes("SEEYABLE_CLEAR_ACTION_LOG"));
  assert.match(panel.$("actionLog").textContent, /No log entries yet/);
  panel.dom.window.close();
});

test("gate: cancel that arrives after dispatch reports too-late, not revocation", async () => {
  const { panel } = gatePanel({ cancelImpl: () => ({ ok: true, cancelled: false, dispatched: true }) });
  await takeSnapshot(panel);
  selectTarget(panel, "el-1");
  panel.$("btnExecute").click();
  await tick(); await tick();
  panel.$("btnCancelChallenge").click();
  await tick(); await tick();
  assert.match(panel.$("confirmStatus").textContent, /Too late to cancel/);
  assert.match(panel.$("confirmStatus").textContent, /already dispatched/);
  panel.dom.window.close();
});

/* --- Issue #29: Plain Words presentation --------------------------------- */

test("surface: developer controls live in the collapsible Developer view; safety stays in the main flow", () => {
  const panel = makePanel(async () => { throw new Error("unexpected"); });
  const dev = panel.$("developerView");
  assert.ok(dev, "Developer view exists");
  for (const id of ["btnDom", "btnRefresh", "btnCdp", "btnCopy", "btnDownload", "btnClear", "output",
    "btnShowTags", "btnHideTags", "highlightInput", "btnHighlight",
    "targetSelect", "actionSelect", "valueInput", "btnExecute", "execStatus", "execResult",
    "actionLog", "btnRefreshLog", "btnClearLog"]) {
    assert.ok(dev.contains(panel.$(id)), `${id} stays usable inside Developer view`);
  }
  for (const id of ["stateChip", "tagsChip", "status", "latestResult", "voiceState", "commandInput",
    "confirmBox", "confirmTitle", "confirmText", "btnApproveOnce", "btnCancelChallenge",
    "confirmStatus", "btnStopExec", "btnPauseExec", "gateStatus"]) {
    assert.ok(!dev.contains(panel.$(id)), `${id} stays visible with Developer view closed`);
  }
  panel.dom.window.close();
});

test("surface: reference composition — discovery and safety precede the long target list", () => {
  const panel = makePanel(async () => { throw new Error("unexpected"); });
  const doc = panel.doc;
  assert.equal(doc.getElementById("commandHeading").textContent, "Ready when you are.");
  const before = (a, b) => Boolean(doc.getElementById(a).compareDocumentPosition(doc.getElementById(b)) & 4);
  assert.ok(before("btnViewTargets", "targetList"), "View page targets sits in the primary area, before the list");
  assert.ok(before("btnStopExec", "targetList"), "Stop/Pause come before the long target list");
  assert.ok(before("confirmBox", "targetList"), "pending confirmation is presented ahead of the target list");
  const settings = doc.getElementById("voiceSettings");
  assert.equal(settings.open, false, "voice/microphone settings start collapsed");
  for (const id of ["btnMicSetup", "chkSpeak", "btnStopSpeech", "voiceNote"]) {
    assert.ok(settings.contains(panel.$(id)), `${id} lives in the secondary settings area`);
  }
  assert.ok(!settings.contains(panel.$("btnStopListen")), "Stop listening stays in the primary area");
  assert.ok(!settings.contains(panel.$("btnCancelListen")), "Cancel listening stays in the primary area");
  panel.dom.window.close();
});

test("bridge: pairing UI lives in Developer view, sends token+port once, and clears the input", async () => {
  const panel = makePanel(async () => { throw new Error("unexpected"); });
  const dev = panel.$("developerView");
  for (const id of ["bridgeToken", "bridgePort", "btnBridgeConnect", "btnBridgeDisconnect", "btnBridgeStatus", "bridgeStatus"]) {
    assert.ok(dev.contains(panel.$(id)), `${id} lives in Developer view`);
  }
  const sent = [];
  panel.win.chrome.runtime.sendMessage = async (msg) => { sent.push(msg); return { ok: true }; };
  panel.$("bridgeToken").value = "tok-123";
  panel.$("bridgePort").value = "6123";
  panel.$("btnBridgeConnect").click();
  await tick();
  assert.deepEqual(JSON.parse(JSON.stringify(sent)), [{ type: "SEEYABLE_BRIDGE_CONNECT", token: "tok-123", port: 6123 }]);
  assert.equal(panel.$("bridgeToken").value, "", "token input is cleared after pairing");
  assert.match(panel.$("bridgeStatus").textContent, /127\.0\.0\.1:6123/);
  panel.dom.window.close();
});

test("surface: state chip and tags chip follow real operations", async () => {
  const panel = makePanel(tagImpl, { speech: makeSpeechMock() });
  assert.match(panel.$("stateChip").textContent, /Ready/);
  assert.equal(panel.$("tagsChip").textContent, "Tags: off");
  panel.$("commandInput").value = "show tags";
  panel.$("btnSendCommand").click();
  await tick(); await tick();
  assert.match(panel.$("tagsChip").textContent, /Tags: on/);
  panel.$("commandInput").value = "hide tags";
  panel.$("btnSendCommand").click();
  await tick(); await tick();
  assert.equal(panel.$("tagsChip").textContent, "Tags: off");
  panel.dom.window.close();
});

test("surface: held confirmation shows a held chip and focuses its title, not Approve", async () => {
  const { panel } = gatePanel({});
  panel.$("btnSendCommand").focus();
  await takeSnapshot(panel);
  selectTarget(panel, "el-1");
  panel.$("btnExecute").click();
  await tick(); await tick();
  assert.equal(panel.$("developerView").open, false, "confirmation is visible with Developer view closed");
  assert.match(panel.$("stateChip").textContent, /Held/);
  assert.ok(panel.$("stateChip").className.includes("is-held"));
  assert.equal(panel.dom.window.document.activeElement.id, "confirmTitle", "focus moves to the confirmation heading, not Approve");
  panel.$("btnCancelChallenge").click();
  await tick(); await tick();
  assert.equal(panel.dom.window.document.activeElement.id, "btnSendCommand", "focus is restored after cancellation");
  panel.dom.window.close();
});

test("surface: latest result mirrors the execution outcome in the main flow", async () => {
  const { panel } = gatePanel({});
  await takeSnapshot(panel);
  assert.equal(panel.$("latestResult").textContent, "");
  selectTarget(panel, "el-1");
  panel.$("btnExecute").click();
  await tick(); await tick();
  assert.match(panel.$("latestResult").textContent, /^Latest result:/);
  assert.match(panel.$("latestResult").textContent, /Confirmation required/);
  panel.dom.window.close();
});

test("surface: human approval and execution outcome are verbally distinct", async () => {
  const { panel } = gatePanel({
    approveImpl: () => ({ ok: false, error: { code: "STALE_SNAPSHOT", message: "The page changed." }, newSnapshotDiff: null, diffUnavailableReason: "x", documentSessionId: "doc-A", revision: 1 }),
  });
  await takeSnapshot(panel);
  selectTarget(panel, "el-1");
  panel.$("btnExecute").click();
  await tick(); await tick();
  panel.$("btnApproveOnce").click();
  await tick(); await tick();
  assert.match(panel.$("confirmStatus").textContent, /Human approval was supplied and consumed/);
  assert.match(panel.$("confirmStatus").textContent, /did not complete/);
  panel.dom.window.close();
});

/* --- Issue #29 correction: explicit presentation state ------------------ */

test("surface: listening lifecycle drives the chip from the lifecycle, not sentences", async () => {
  const speech = makeSpeechMock();
  const { FakeRecognition, instances } = makeRecognitionClass();
  const panel = makePanel(tagImpl, { speech, speechRecognition: FakeRecognition });
  panel.$("btnListen").click();
  await tick();
  assert.equal(panel.$("stateChip").textContent, "Starting", "startup is its own phase, not Finishing and not Ready");
  assert.equal(panel.dom.window.document.body.dataset.voice, "finishing");
  instances[0].fireStart();
  assert.equal(panel.$("stateChip").textContent, "Listening");
  assert.ok(panel.$("stateChip").className.includes("is-listening"));
  assert.equal(panel.dom.window.document.body.dataset.voice, "listening");
  instances[0].fireEnd();
  await tick();
  assert.equal(panel.$("stateChip").textContent, "Ready");
  assert.equal(panel.dom.window.document.body.dataset.voice, "idle");
  panel.dom.window.close();
});

test("surface: cancelled listening never reads as a live microphone, even after snapshot and failure", async () => {
  const speech = makeSpeechMock();
  const { FakeRecognition, instances } = makeRecognitionClass();
  const calls = { send: [] };
  const panel = makePanel(async (t, msg) => {
    calls.send.push(msg.type);
    if (msg.type === "SEEYABLE_SNAPSHOT_DOM") return { ok: true, snapshot: snap([el("el-1", "Full name")]) };
    if (msg.type === "SEEYABLE_EXECUTE_ACTION") {
      return { ok: false, error: { code: "ACTION_FAILED", message: "boom" }, newSnapshotDiff: null, diffUnavailableReason: "x", documentSessionId: "doc-A", revision: 1 };
    }
    return tagImpl(t, msg);
  }, { speech, speechRecognition: FakeRecognition });
  panel.$("btnListen").click();
  await tick();
  instances[0].fireStart();
  assert.equal(panel.dom.window.document.body.dataset.voice, "listening");
  panel.$("btnCancelListen").click();
  await tick();
  assert.match(panel.$("voiceState").textContent, /cancelled/);
  assert.equal(panel.$("stateChip").textContent, "Ready", "cancellation copy mentioning listening must not set a Listening chip");
  assert.equal(panel.dom.window.document.body.dataset.voice, "idle");
  await takeSnapshot(panel);
  assert.notEqual(panel.$("stateChip").textContent, "Listening", "a fresh snapshot must not resurrect Listening");
  assert.notEqual(panel.dom.window.document.body.dataset.voice, "listening");
  selectTarget(panel, "el-1");
  panel.$("btnExecute").click();
  await tick(); await tick();
  assert.match(panel.$("execResult").textContent, /ACTION_FAILED/, "the failure stays visible in its result surface");
  assert.equal(panel.$("stateChip").textContent, "Ready", "available for the next command; no error pill hides the failure");
  assert.equal(panel.dom.window.document.body.dataset.voice, "idle", "failure must not leave a stale Listening phase");
  panel.dom.window.close();
});

test("surface: verified completion, unverified dispatch, and gate states read honestly", async () => {
  const { panel } = gatePanel({});
  await takeSnapshot(panel);
  selectTarget(panel, "el-1");
  panel.$("btnExecute").click();
  await tick(); await tick();
  assert.match(panel.$("latestResult").textContent, /Confirmation required/);
  assert.match(panel.$("stateChip").textContent, /Held/);
  panel.$("btnApproveOnce").click();
  await tick(); await tick(); await tick();
  assert.match(panel.$("stateChip").textContent, /Done/, "consumed approval with verified outcome reads Done");
  panel.$("btnStopExec").click();
  await tick(); await tick();
  assert.match(panel.$("stateChip").textContent, /Stopped/);
  assert.equal(panel.dom.window.document.body.dataset.voice, "idle");
  panel.dom.window.close();
});

test("surface: denied recognition stays visible and recoverable with no error pill", async () => {
  const speech = makeSpeechMock();
  const { FakeRecognition, instances } = makeRecognitionClass();
  const panel = makePanel(tagImpl, { speech, speechRecognition: FakeRecognition });
  panel.$("btnListen").click();
  await tick();
  assert.equal(panel.$("stateChip").textContent, "Starting");
  instances[0].fireError("not-allowed");
  await tick();
  assert.match(panel.$("voiceState").textContent, /Microphone access was denied/, "the denial stays visible in the voice surface");
  assert.ok(panel.$("voiceState").classList.contains("error"));
  assert.equal(panel.$("stateChip").textContent, "Ready", "available; the failure is the visible message, not a pill");
  assert.equal(panel.dom.window.document.body.dataset.voice, "idle", "an error is not an active microphone");
  assert.equal(panel.$("btnListen").disabled, false, "a new attempt can recover immediately");
  panel.dom.window.close();
});

test("surface: voice-error presentation clears on recovery, cancellation stays Ready", async () => {
  const speech = makeSpeechMock();
  const { FakeRecognition, instances } = makeRecognitionClass();
  const panel = makePanel(tagImpl, { speech, speechRecognition: FakeRecognition });
  // Denial stays visible in the voice surface with no pill; a new
  // start attempt supersedes the error presentation.
  panel.$("btnListen").click();
  await tick();
  instances[0].fireError("not-allowed");
  await tick();
  assert.match(panel.$("voiceState").textContent, /Microphone access was denied/);
  assert.equal(panel.$("stateChip").textContent, "Ready");
  panel.$("btnListen").click();
  await tick();
  assert.equal(panel.$("stateChip").textContent, "Starting", "a new attempt supersedes the prior error");
  // Denial, then a live session clears it. A stale onstart from the
  // terminated session must stay ignored; only the new session counts.
  instances[1].fireError("not-allowed");
  await tick();
  assert.match(panel.$("voiceState").textContent, /Microphone access was denied/);
  instances[1].fireStart();
  assert.match(panel.$("voiceState").textContent, /Microphone access was denied/, "onstart from a terminated session is ignored");
  panel.$("btnListen").click();
  await tick();
  instances[2].fireStart();
  assert.equal(panel.$("stateChip").textContent, "Listening");
  // Denial on the live session, then a successful typed command clears it.
  instances[2].fireError("not-allowed");
  await tick();
  assert.match(panel.$("voiceState").textContent, /Microphone access was denied/);
  panel.$("commandInput").value = "show tags";
  panel.$("btnSendCommand").click();
  await tick(); await tick(); await tick();
  assert.equal(panel.$("voiceState").textContent, "Voice: idle.");
  assert.equal(panel.$("stateChip").textContent, "Ready", "a completed command is recovery from the error");
  assert.equal(panel.dom.window.document.body.dataset.voice, "idle");
  panel.dom.window.close();
});

test("surface: typed-command completion settles to Ready, never stuck acting", async () => {
  const panel = makePanel(tagImpl, { speech: makeSpeechMock() });
  panel.$("commandInput").value = "show tags";
  panel.$("btnSendCommand").click();
  await tick(); await tick(); await tick();
  assert.match(panel.$("stateChip").textContent, /Ready/);
  assert.equal(panel.dom.window.document.body.dataset.voice, "idle");
  panel.dom.window.close();
});
