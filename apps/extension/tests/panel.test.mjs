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
  assert.match(panel.$("status").textContent, /Tags shown: 2 in viewport/);
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
  assert.match(panel.$("voiceState").textContent, /Supported commands: "show tags" and "hide tags"/);
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
  assert.match(panel.$("voiceState").textContent, /error/i);
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
