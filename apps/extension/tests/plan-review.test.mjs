"use strict";
/* Issue #15: plan preview, review binding, edit replacement, voice review
 * authority, and undo — panel integration.
 *
 * Two harnesses:
 *  - "integrated": the real side panel (jsdom) talks to the REAL content
 *    script + snapshot engine + executor running on the pre-existing demo
 *    survey (a second jsdom), through a chrome.tabs.sendMessage shim that
 *    presents the trusted side-panel sender. Recognition and the planner
 *    proxy are STUBS: no microphone, no model, no network.
 *  - "stubbed tab": scripted tab responses, for races the real page cannot
 *    produce on demand.
 * Nothing here is genuine-microphone or genuine-model evidence. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(here, rel), "utf8");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tick = async () => { await sleep(0); await sleep(0); await sleep(0); };
async function waitFor(cond, what, ms = 3000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

const html = read("../sidepanel.html");
const panelScripts = ["../lib/voice-commands.js", "../lib/command-resolver.js", "../lib/plan-schema.js", "../lib/planner.js", "../lib/meta-voice.js", "../lib/overlay.js", "../sidepanel.js"].map(read);
const PAIRED = { plannerToken: "test-token", plannerPort: 6124 };
const PANEL_SENDER = { id: "test", url: "chrome-extension://test/sidepanel.html" };

function makeSessionStorage(initial = {}) {
  const data = { ...initial };
  return {
    get: async (keys) => Object.fromEntries([].concat(keys).map((k) => [k, data[k]])),
    set: async (obj) => { Object.assign(data, obj); },
    remove: async (keys) => { for (const k of [].concat(keys)) delete data[k]; },
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
    fireFinal(text) {
      if (!this.onresult) return;
      const result = [{ transcript: text }];
      result.isFinal = true;
      this.onresult({ resultIndex: 0, results: [result] });
    }
    fireEnd() { if (this.onend) this.onend(); }
  }
  return { FakeRecognition, instances };
}

function makeSpeech() {
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

function makePanel(sendImpl, opts = {}) {
  const dom = new JSDOM(html, { url: "chrome-extension://test/sidepanel.html", runScripts: "dangerously", pretendToBeVisual: true });
  const win = dom.window;
  const calls = { send: [], execute: 0, fetch: [], bodies: [] };
  const listeners = { activated: [], updated: [] };
  win.console = { info: () => {}, warn: () => {}, error: () => {} };
  if (opts.speechRecognition) win.SpeechRecognition = opts.speechRecognition;
  if (opts.speech) {
    win.speechSynthesis = opts.speech.synth;
    win.SpeechSynthesisUtterance = opts.speech.Utterance;
  }
  win.fetch = async (url, init) => {
    calls.fetch.push(url);
    const body = JSON.parse(init.body);
    calls.bodies.push(body);
    return opts.plan(body, calls);
  };
  win.chrome = {
    tabs: {
      query: async () => [{ id: 111, title: "Demo survey" }],
      sendMessage: async (tabId, msg) => {
        calls.send.push({ tabId, msg });
        if (msg.type === "SEEYABLE_EXECUTE_ACTION") calls.execute += 1;
        return sendImpl(tabId, msg, calls);
      },
      create: async () => ({ id: 555 }),
      onActivated: { addListener: (fn) => listeners.activated.push(fn) },
      onUpdated: { addListener: (fn) => listeners.updated.push(fn) },
    },
    scripting: { executeScript: async () => [{ result: null }] },
    runtime: { sendMessage: async () => ({ ok: false }), getURL: (p) => `chrome-extension://test/${p}` },
    permissions: { contains: async () => false },
    storage: { local: { get: async () => ({}), set: async () => {} }, session: makeSessionStorage(PAIRED) },
  };
  for (const js of panelScripts) win.eval(js);
  const $ = (id) => win.document.getElementById(id);
  return { dom, win, calls, listeners, $, sends: (type) => calls.send.filter((c) => c.msg.type === type) };
}

// The real content script on the demo survey.
function makeSurvey() {
  const dom = new JSDOM(read("../../demo-survey/index.html"), { url: "http://localhost:8080/", runScripts: "dangerously", pretendToBeVisual: true });
  const win = dom.window;
  let listener = null;
  win.chrome = { runtime: { id: "test", getURL: (p) => `chrome-extension://test/${p}`, onMessage: { addListener: (fn) => { listener = fn; } } } };
  win.console = { info: () => {}, warn: () => {}, error: () => {} };
  if (!win.crypto || !win.crypto.subtle) Object.defineProperty(win, "crypto", { value: globalThis.crypto, configurable: true });
  for (const f of ["../lib/snapshot-dom.js", "../lib/executor.js", "../lib/overlay.js", "../content.js"]) win.eval(read(f));
  // jsdom does not run form submission for synthetic clicks; observe the
  // activation of the Submit control itself instead.
  win.document.querySelector("button[type=submit]").addEventListener("click", (e) => { e.preventDefault(); win.__submitted = true; });
  const send = (_tabId, msg) => new Promise((resolve) => { listener(msg, PANEL_SENDER, resolve); });
  return { dom, win, doc: win.document, send };
}

const respond = (plan, body) => ({
  json: async () => ({ ok: true, plan, repaired: false, documentSessionId: body.snapshot.documentSessionId, revision: body.snapshot.revision }),
});
const idOf = (body, name) => body.snapshot.elements.find((e) => e.name === name).id;
// Stub planner: fills named fields with the values in the transcript's
// "put X in Y and Z in W" shape. A stand-in for the model, not the model.
function stubPlanner(body) {
  const steps = [];
  for (const part of body.transcript.replace(/[.]$/, "").split(/\s+(?:and|then)\s+/i)) {
    const m = /^(?:put\s+)?(.+?)\s+in\s+(full name|short bio|nickname)$/i.exec(part.trim());
    if (!m) continue;
    const field = { "full name": "Full name", "short bio": "Short bio", nickname: "Nickname (placeholder only)" }[m[2].toLowerCase()];
    steps.push({ action: "fill", elementId: idOf(body, field), value: m[1] });
  }
  if (/submit/i.test(body.transcript)) steps.push({ action: "click", elementId: idOf(body, "Submit survey") });
  return respond({ version: "seeyable-plan-1", outcome: "steps", say: "All done!", steps }, body);
}

async function say(panel, rec, text) {
  panel.$("btnListen").click();
  await tick();
  const session = rec.instances[rec.instances.length - 1];
  session.fireStart();
  session.fireFinal(text);
  session.fireEnd();
  return session;
}

/* --- Acceptance flow (stubbed recognition + stubbed planner, real executor) --- */

test("acceptance (stubbed voice/model, real executor): mis-speak, edit by voice, approve, undo one fill", async () => {
  const survey = makeSurvey();
  survey.doc.getElementById("bio").value = "Actual prior bio, kept in full.";
  const rec = makeRecognitionClass();
  const speech = makeSpeech();
  const panel = makePanel(survey.send, { plan: stubPlanner, speechRecognition: rec.FakeRecognition, speech });
  const name = () => survey.doc.getElementById("full-name").value;
  const bio = () => survey.doc.getElementById("bio").value;

  // 1–2. Deliberate wrong value; preview appears; nothing changes.
  await say(panel, rec, "Put Grace Hopper in Full name and Pilot in Short bio.");
  await waitFor(() => !panel.$("planBox").hidden, "first preview");
  assert.equal(panel.calls.execute, 0);
  assert.equal(name(), "");
  assert.equal(bio(), "Actual prior bio, kept in full.");
  assert.match(panel.$("planSteps").textContent, /Fill “Full name” with “Grace Hopper”/);
  assert.match(panel.$("planSteps").textContent, /Fill “Short bio” with “Pilot”/);
  assert.match(panel.$("stateChip").textContent, /Review/);
  assert.ok(!panel.$("planBox").textContent.includes("All done"), "model prose is never shown as the plan");
  assert.equal(panel.$("btnExecute").disabled, true, "manual execution blocked while reviewing");
  const firstApprove = panel.$("btnApprovePlan").onclick;

  // 3–4. Voice edit with a complete replacement; old preview unusable.
  await say(panel, rec, "Edit plan: put Grace Hopper in Full name and Scientist in Short bio.");
  await waitFor(() => panel.calls.fetch.length === 2 && !panel.$("planBox").hidden, "replacement preview");
  assert.equal(panel.calls.bodies[1].transcript, "put Grace Hopper in Full name and Scientist in Short bio.", "the replacement request alone is planned");
  assert.match(panel.$("planSteps").textContent, /Scientist/);
  assert.doesNotMatch(panel.$("planSteps").textContent, /Pilot/);
  assert.match(panel.$("status").textContent, /Replacement plan ready for review/);
  firstApprove(); // a stale handle to the original preview
  await sleep(100);
  assert.equal(panel.calls.execute, 0, "the original preview can never run");
  assert.equal(bio(), "Actual prior bio, kept in full.");

  // 5–6. Approve by voice: both fills execute and verify.
  await say(panel, rec, "Approve plan.");
  await waitFor(() => /Completed 2 steps, all verified/.test(panel.$("status").textContent), "approved run");
  assert.equal(panel.calls.execute, 2);
  assert.equal(name(), "Grace Hopper");
  assert.equal(bio(), "Scientist");
  assert.equal(panel.calls.fetch.length, 2, "approval made no model call");

  // 7–8. Undo by voice: only Short bio returns to its actual prior value.
  await say(panel, rec, "Undo last change");
  await waitFor(() => /Undid the last change/.test(panel.$("status").textContent), "undo result");
  assert.equal(bio(), "Actual prior bio, kept in full.");
  assert.equal(name(), "Grace Hopper");
  assert.match(panel.$("status").textContent, /“Short bio” is back to its previous value/);
  assert.match(panel.$("status").textContent, /Only that change was reversed/);
  assert.equal(panel.calls.fetch.length, 2, "undo made no model call");
  assert.ok(!panel.$("status").textContent.includes("Actual prior bio"), "values stay out of status");
  // A duplicate undo does not walk further back.
  await say(panel, rec, "Undo last change");
  await waitFor(() => /no change to undo/.test(panel.$("status").textContent), "second undo refusal");
  assert.equal(name(), "Grace Hopper");
  assert.ok(!speech.spoken.some((t) => /approve/i.test(t)), "synthesized feedback never says an approval phrase");
  panel.dom.window.close();
  survey.dom.window.close();
});

test("integrated: undo refuses an intervening manual edit and overwrites nothing", async () => {
  const survey = makeSurvey();
  const panel = makePanel(survey.send, { plan: stubPlanner });
  panel.$("commandInput").value = "put Grace Hopper in Full name and Scientist in Short bio";
  panel.$("btnSendCommand").click();
  await waitFor(() => !panel.$("planBox").hidden, "preview");
  panel.$("btnApprovePlan").click();
  await waitFor(() => /all verified/.test(panel.$("status").textContent), "run");
  survey.doc.getElementById("bio").value = "Typed by the person afterwards";
  panel.$("commandInput").value = "undo last change";
  panel.$("btnSendCommand").click();
  await waitFor(() => /Undo refused/.test(panel.$("status").textContent), "refusal");
  assert.match(panel.$("status").textContent, /edited since Seeyable changed “Short bio”/);
  assert.equal(survey.doc.getElementById("bio").value, "Typed by the person afterwards");
  panel.dom.window.close();
  survey.dom.window.close();
});

test("integrated: approving a plan does not approve its Submit step; the held step ends the sequence", async () => {
  const survey = makeSurvey();
  const panel = makePanel(survey.send, { plan: stubPlanner });
  panel.$("commandInput").value = "put Pioneer in Nickname then submit";
  panel.$("btnSendCommand").click();
  await waitFor(() => !panel.$("planBox").hidden, "preview");
  assert.match(panel.$("planSteps").textContent, /Click “Submit survey”.*own approval/);
  panel.$("btnApprovePlan").click();
  await waitFor(() => !panel.$("confirmBox").hidden, "held challenge");
  assert.equal(survey.doc.querySelector("[name=nickname]").value, "Pioneer");
  assert.equal(survey.win.__submitted, undefined, "the form was not submitted");
  assert.equal(panel.sends("SEEYABLE_APPROVE_CHALLENGE").length, 0, "plan approval sends no challenge approval");
  assert.match(panel.$("status").textContent, /Step 2 of 2 is held/);
  // Typed "approve this action" is not an approval route.
  panel.$("commandInput").value = "approve this action";
  panel.$("btnSendCommand").click();
  await tick();
  assert.equal(panel.sends("SEEYABLE_APPROVE_CHALLENGE").length, 0);
  assert.match(panel.$("status").textContent, /Use the Approve once button/);
  // "Approve plan" with only a challenge on screen approves nothing.
  panel.$("commandInput").value = "approve plan";
  panel.$("btnSendCommand").click();
  await tick();
  assert.equal(panel.sends("SEEYABLE_APPROVE_CHALLENGE").length, 0);
  assert.match(panel.$("status").textContent, /No plan is waiting/);
  // Cancel the held action: nothing is submitted and nothing replays.
  panel.$("btnCancelChallenge").click();
  await sleep(50);
  assert.equal(survey.win.__submitted, undefined);
  assert.match(panel.$("confirmStatus").textContent, /Cancelled/);
  panel.dom.window.close();
  survey.dom.window.close();
});

test("integrated: voice “Approve this action” approves only the displayed challenge, once", async () => {
  const survey = makeSurvey();
  const rec = makeRecognitionClass();
  const panel = makePanel(survey.send, { plan: stubPlanner, speechRecognition: rec.FakeRecognition });
  panel.$("commandInput").value = "click Submit survey";
  panel.$("btnSendCommand").click(); // local fast path: held by the executor
  await waitFor(() => !panel.$("confirmBox").hidden, "held challenge");
  // Once the displayed challenge is cancelled, the phrase approves nothing.
  panel.$("btnCancelChallenge").click();
  await sleep(30);
  panel.$("btnListen").click();
  await tick();
  const early = rec.instances[rec.instances.length - 1];
  early.fireStart();
  early.fireFinal("Approve this action");
  early.fireEnd();
  await tick();
  assert.equal(panel.sends("SEEYABLE_APPROVE_CHALLENGE").length, 0);
  assert.match(panel.$("status").textContent, /No action is waiting/);
  panel.$("commandInput").value = "click Submit survey";
  panel.$("btnSendCommand").click();
  await waitFor(() => !panel.$("confirmBox").hidden, "held again");
  const session = await say(panel, rec, "Approve this action.");
  session.fireFinal("Approve this action."); // duplicate final from the same session
  await waitFor(() => panel.sends("SEEYABLE_APPROVE_CHALLENGE").length === 1, "approval sent");
  await sleep(150);
  assert.equal(panel.sends("SEEYABLE_APPROVE_CHALLENGE").length, 1, "duplicate finals approve once");
  assert.equal(survey.win.__submitted, true, "the one displayed action ran, once");
  panel.dom.window.close();
  survey.dom.window.close();
});

/* --- Stubbed-tab races ---------------------------------------------------- */

const el = (id, name, extra = {}) => ({ id, role: "textbox", name, nameSource: "label", question: null, questionCertain: false, state: {}, actionable: true, tag: "input", cssPath: "input", ...extra });
const snap = (elements, revision = 1, session = "doc-A") => ({ schemaVersion: 2, kind: "dom-aria", documentSessionId: session, revision, semanticHash: `h${revision}`, fresh: true, url: "http://localhost:8080/", elementCount: elements.length, elements });
function tabStub({ snapshots, onExecute }) {
  let n = 0;
  return async (_t, msg) => {
    if (msg.type === "SEEYABLE_SNAPSHOT_DOM") { const s = snapshots[Math.min(n, snapshots.length - 1)]; n += 1; return { ok: true, snapshot: s }; }
    if (msg.type === "SEEYABLE_EXECUTE_ACTION") {
      if (onExecute) return onExecute(msg.request);
      return { ok: true, result: { verified: true }, newSnapshotDiff: { added: [], removed: [], updated: [] }, documentSessionId: "doc-A", revision: msg.request.revision };
    }
    if (msg.type === "SEEYABLE_GATE_CONTROL") return { ok: true, gate: { paused: msg.command === "pause", stopped: msg.command === "stop" } };
    if (msg.type === "SEEYABLE_CANCEL_CHALLENGE") return { ok: true, cancelled: true };
    if (msg.type === "SEEYABLE_GET_ACTION_LOG") return { ok: true, entries: [] };
    throw new Error("unexpected " + msg.type);
  };
}
const twoFill = (body) => respond({ version: "seeyable-plan-1", outcome: "steps", steps: [
  { action: "fill", elementId: "el-1", value: "Grace Hopper" },
  { action: "fill", elementId: "el-2", value: "Pilot" },
] }, body);
const base = [el("el-1", "Full name"), el("el-2", "Short bio")];
async function typed(panel, text) {
  panel.$("commandInput").value = text;
  panel.$("btnSendCommand").click();
  await tick(); await tick(); await tick();
}

test("review: Cancel by click and by voice executes nothing; stale callbacks stay inert", async () => {
  const rec = makeRecognitionClass();
  const panel = makePanel(tabStub({ snapshots: [snap(base)] }), { plan: twoFill, speechRecognition: rec.FakeRecognition });
  await typed(panel, "put Grace Hopper in Full name and Pilot in Short bio");
  assert.equal(panel.$("planBox").hidden, false);
  const staleApprove = panel.$("btnApprovePlan").onclick;
  panel.$("btnCancelPlan").click();
  await tick();
  assert.equal(panel.$("planBox").hidden, true);
  assert.match(panel.$("status").textContent, /Plan cancelled. Nothing was executed/);
  staleApprove();
  await tick(); await tick();
  assert.equal(panel.calls.execute, 0);
  assert.match(panel.$("status").textContent, /no longer available/);
  await typed(panel, "put Grace Hopper in Full name and Pilot in Short bio");
  await say(panel, rec, "cancel plan");
  await tick();
  assert.equal(panel.$("planBox").hidden, true);
  assert.equal(panel.calls.execute, 0);
  assert.equal(panel.calls.fetch.length, 2, "cancel makes no model call");
  panel.dom.window.close();
});

test("review: page changed after review is rejected — fresh review required, nothing runs", async () => {
  const changed = [el("el-1", "Full name"), el("el-2", "Short bio"), el("el-3", "Appeared")];
  const panel = makePanel(tabStub({ snapshots: [snap(base, 1), snap(changed, 2)] }), { plan: twoFill });
  await typed(panel, "put Grace Hopper in Full name and Pilot in Short bio");
  panel.$("btnApprovePlan").click();
  await tick(); await tick(); await tick();
  assert.equal(panel.calls.execute, 0, "no silent replan, no substituted target");
  assert.match(panel.$("status").textContent, /page changed after you reviewed this plan/);
  assert.equal(panel.$("planBox").hidden, true, "the stale preview is gone");
  assert.equal(panel.calls.fetch.length, 1, "no automatic replanning");
  panel.dom.window.close();
});

test("review: superseding request, tab change, and Stop each invalidate the preview", async () => {
  // Pause and Stop are one control now (merged Stop/Resume).
  for (const kind of ["supersede", "tab", "stop"]) {
    const panel = makePanel(tabStub({ snapshots: [snap(base)] }), { plan: twoFill });
    await typed(panel, "put Grace Hopper in Full name and Pilot in Short bio");
    const stale = panel.$("btnApprovePlan").onclick;
    if (kind === "supersede") await typed(panel, "show tags please now");
    if (kind === "tab") { for (const fn of panel.listeners.activated) fn({ tabId: 999 }); await tick(); }
    if (kind === "stop") { panel.$("btnStopExec").click(); await tick(); }
    if (kind === "supersede") {
      assert.equal(panel.calls.fetch.length, 2, "the newer request was planned");
      assert.match(panel.$("status").textContent, /^The earlier plan was discarded\. Plan ready/);
    } else {
      assert.equal(panel.$("planBox").hidden, true, kind);
    }
    if (kind === "stop") assert.match(panel.$("status").textContent, /Plan discarded — execution was stopped/);
    if (kind === "tab") assert.match(panel.$("status").textContent, /Active tab changed/);
    stale();
    await tick(); await tick();
    assert.equal(panel.calls.execute, 0, `${kind}: the old preview never runs`);
    panel.dom.window.close();
  }
});

test("review: delayed planner response after an edit cannot overwrite the newer interaction", async () => {
  let releaseFirst;
  const first = new Promise((r) => { releaseFirst = r; });
  let calls = 0;
  const panel = makePanel(tabStub({ snapshots: [snap(base)] }), {
    plan: async (body) => {
      calls += 1;
      if (calls === 2) { await first; return twoFill(body); } // the edit's replan is slow
      return twoFill(body);
    },
  });
  await typed(panel, "put Grace Hopper in Full name and Pilot in Short bio");
  panel.$("btnEditPlan").click();
  assert.equal(panel.$("planBox").hidden, true, "Edit invalidates the original at once");
  assert.equal(panel.$("planEditBox").hidden, false);
  assert.equal(panel.$("planEditInput").value, "put Grace Hopper in Full name and Pilot in Short bio", "editing starts from the request");
  assert.equal(panel.win.document.activeElement, panel.$("planEditInput"), "focus moves into the labelled edit field");
  panel.$("planEditInput").value = "fill Short bio with Scientist"; // fast-path shaped on purpose
  panel.$("btnSubmitEdit").click();
  await tick();
  assert.equal(panel.calls.fetch.length, 2, "an edit is always planned, never fast-pathed");
  panel.$("btnCancelListen").click(); // supersede the slow replan
  releaseFirst();
  await tick(); await tick(); await tick();
  assert.equal(panel.$("planBox").hidden, true, "the late response shows no preview");
  assert.equal(panel.calls.execute, 0, "editing never executes either plan");
  assert.match(panel.$("status").textContent, /Command discarded/);
  panel.dom.window.close();
});

test("review: voice approval needs the session started while this plan was shown; speech output is silenced first", async () => {
  const rec = makeRecognitionClass();
  const speech = makeSpeech();
  const panel = makePanel(tabStub({ snapshots: [snap(base)] }), { plan: twoFill, speechRecognition: rec.FakeRecognition, speech });
  // Listening starts BEFORE the plan exists; its final cannot approve.
  panel.$("btnListen").click();
  await tick();
  const early = rec.instances[0];
  early.fireStart();
  await typed(panel, "put Grace Hopper in Full name and Pilot in Short bio"); // typed cancels that session
  early.fireFinal("approve plan"); // obsolete session callback
  await tick();
  assert.equal(panel.$("planBox").hidden, false);
  assert.equal(panel.calls.execute, 0, "an obsolete session's final supplies nothing");
  // Synthesized feedback is stopped before any session starts, so speech
  // output can never be transcribed into an approval.
  const cancelsBefore = speech.cancels();
  panel.$("btnListen").click();
  await tick();
  assert.ok(speech.cancels() > cancelsBefore, "Start listening silences synthesis first");
  rec.instances[rec.instances.length - 1].fireStart();
  rec.instances[rec.instances.length - 1].fireEnd(); // no speech: nothing heard
  await tick();
  assert.ok(!speech.spoken.some((t) => /approve|cancel plan|edit plan/i.test(t)), "spoken feedback never contains a review phrase");
  // A proper session approves exactly once despite duplicate finals.
  const s3 = await say(panel, rec, "approve plan");
  s3.fireFinal("approve plan");
  await tick(); await tick(); await tick(); await tick();
  assert.equal(panel.calls.execute, 2, "one approval, two steps — never four");
  assert.equal(panel.calls.fetch.length, 1, "approval needs no model call");
  panel.dom.window.close();
});

test("review: edit phrases are contextual; empty replacement keeps the plan", async () => {
  const rec = makeRecognitionClass();
  const panel = makePanel(tabStub({ snapshots: [snap(base)] }), { plan: twoFill, speechRecognition: rec.FakeRecognition });
  await say(panel, rec, "edit plan: put Ada in Full name");
  await tick();
  assert.match(panel.$("status").textContent, /No plan is waiting to edit/);
  assert.equal(panel.calls.fetch.length, 0, "no plan, no model call");
  await typed(panel, "put Grace Hopper in Full name and Pilot in Short bio");
  await say(panel, rec, "edit plan");
  await tick();
  assert.equal(panel.$("planBox").hidden, false, "an empty edit does not discard the plan");
  assert.match(panel.$("status").textContent, /complete replacement request/);
  panel.dom.window.close();
});

test("review: model clarification choice enters review instead of executing", async () => {
  const panel = makePanel(tabStub({ snapshots: [snap(base)] }), {
    plan: (body) => respond({ version: "seeyable-plan-1", outcome: "clarify", question: "Which field?", action: "fill", value: "Pilot",
      choices: [{ elementId: "el-1", label: "Full name" }, { elementId: "el-2", label: "Short bio" }] }, body),
  });
  await typed(panel, "put Pilot in the name-ish thing");
  [...panel.$("clarifyChoices").querySelectorAll("button")][1].click();
  await tick();
  assert.equal(panel.calls.execute, 0);
  assert.equal(panel.$("planBox").hidden, false);
  assert.match(panel.$("planSteps").textContent, /Fill “Short bio” with “Pilot”/);
  panel.dom.window.close();
});

test("review: preview shows protected and long values safely", async () => {
  const elements = [el("el-1", "Account PIN", { state: { redacted: true, filled: true } }), el("el-2", "Short bio")];
  const long = "L".repeat(400);
  const panel = makePanel(tabStub({ snapshots: [snap(elements)] }), {
    plan: (body) => respond({ version: "seeyable-plan-1", outcome: "steps", steps: [
      { action: "fill", elementId: "el-1", value: "9999" },
      { action: "fill", elementId: "el-2", value: long },
    ] }, body),
  });
  await typed(panel, "put 9999 in Account PIN and a long bio");
  const text = panel.$("planSteps").textContent;
  assert.ok(!text.includes("9999"), "protected values are never displayed");
  assert.match(text, /protected value \(hidden\)/);
  assert.match(text, /400 characters in total/);
  panel.dom.window.close();
});

test("review: a plan that appears mid-session cannot be approved by that session", async () => {
  // Reachable path: listening starts with nothing to review, then a click
  // on a model clarification choice creates a plan while the microphone
  // is still open. That session never saw this plan, so its "approve
  // plan" is refused; a session started after the plan appeared works.
  const rec = makeRecognitionClass();
  const panel = makePanel(tabStub({ snapshots: [snap(base)] }), {
    plan: (body) => respond({ version: "seeyable-plan-1", outcome: "clarify", question: "Which field?", action: "fill", value: "Pilot",
      choices: [{ elementId: "el-1", label: "Full name" }, { elementId: "el-2", label: "Short bio" }] }, body),
    speechRecognition: rec.FakeRecognition,
  });
  await typed(panel, "put Pilot in the name-ish thing");
  panel.$("btnListen").click();
  await tick();
  const session = rec.instances[rec.instances.length - 1];
  session.fireStart();
  [...panel.$("clarifyChoices").querySelectorAll("button")][1].click();
  await tick();
  assert.equal(panel.$("planBox").hidden, false, "plan appeared while listening");
  session.fireFinal("approve plan");
  session.fireEnd();
  await tick(); await tick();
  assert.equal(panel.calls.execute, 0, "that session's approval is refused");
  assert.match(panel.$("status").textContent, /approval was not accepted/);
  assert.equal(panel.$("planBox").hidden, false, "the plan is still waiting");
  await say(panel, rec, "approve plan");
  await tick(); await tick(); await tick(); await tick();
  assert.equal(panel.calls.execute, 1, "a session started while the plan was shown approves it");
  panel.dom.window.close();
});

/* --- Review finding 3: model-derived cached corrections ----------------- */

const clarifyTwo = (body) => respond({ version: "seeyable-plan-1", outcome: "clarify", question: "Which field?", action: "fill", value: "Pilot",
  choices: [{ elementId: idOf(body, "Full name"), label: "Full name" }, { elementId: idOf(body, "Short bio"), label: "Short bio" }] }, body);

test("integrated correction: model choice → preview → approve → “the other one” → NEW preview, no extra model call", async () => {
  const survey = makeSurvey();
  const panel = makePanel(survey.send, { plan: clarifyTwo });
  const name = () => survey.doc.getElementById("full-name").value;
  const bio = () => survey.doc.getElementById("bio").value;
  panel.$("commandInput").value = "put Pilot in the name-ish field";
  panel.$("btnSendCommand").click();
  await waitFor(() => !panel.$("clarifyBox").hidden, "clarification");
  [...panel.$("clarifyChoices").querySelectorAll("button")][0].click();
  await waitFor(() => !panel.$("planBox").hidden, "choice preview");
  const firstApprove = panel.$("btnApprovePlan").onclick;
  panel.$("btnApprovePlan").click();
  await waitFor(() => /Completed 1 step, all verified/.test(panel.$("status").textContent), "first run");
  assert.equal(name(), "Pilot");
  panel.$("commandInput").value = "no, the other one";
  panel.$("btnSendCommand").click();
  await waitFor(() => !panel.$("planBox").hidden, "correction preview");
  assert.equal(panel.calls.fetch.length, 1, "the cached alternative needs no model call");
  assert.match(panel.$("status").textContent, /Earlier choice “Full name” completed and verified\. Alternative “Short bio”: plan ready for review/);
  assert.match(panel.$("planSteps").textContent, /Fill “Short bio” with “Pilot”/);
  assert.equal(bio(), "", "no page mutation before the correction preview is approved");
  assert.equal(panel.calls.execute, 1);
  firstApprove(); // an obsolete handle to the first preview
  await sleep(80);
  assert.equal(panel.calls.execute, 1, "the old plan is never revived");
  panel.$("btnApprovePlan").click();
  await waitFor(() => panel.calls.execute === 2 && /all verified/.test(panel.$("status").textContent), "correction run");
  assert.equal(bio(), "Pilot");
  assert.equal(name(), "Pilot", "the correction does not undo the earlier choice");
  assert.equal(panel.calls.fetch.length, 1);
  // The correction itself is single use and does not re-cache.
  panel.$("commandInput").value = "the other one";
  panel.$("btnSendCommand").click();
  await waitFor(() => panel.calls.fetch.length === 2, "falls through to the planner");
  panel.dom.window.close();
  survey.dom.window.close();
});

const clarifyThree = (body) => respond({ version: "seeyable-plan-1", outcome: "clarify", question: "Which?", action: "fill", value: "Pilot",
  choices: [{ elementId: "el-1", label: "Full name" }, { elementId: "el-2", label: "Short bio" }, { elementId: "el-3", label: "Nickname" }] }, body);
const three = [el("el-1", "Full name"), el("el-2", "Short bio"), el("el-3", "Nickname")];

test("correction: several model alternatives offer choices; the chosen one enters review; obsolete buttons stay inert", async () => {
  const panel = makePanel(tabStub({ snapshots: [snap(three)] }), { plan: clarifyThree });
  await typed(panel, "put Pilot somewhere");
  const firstRound = [...panel.$("clarifyChoices").querySelectorAll("button")];
  firstRound[0].click();
  await tick();
  panel.$("btnApprovePlan").click();
  await tick(); await tick(); await tick(); await tick();
  assert.equal(panel.calls.execute, 1);
  await typed(panel, "no, the other one");
  assert.equal(panel.calls.fetch.length, 1, "no model call");
  const round = [...panel.$("clarifyChoices").querySelectorAll("button")];
  assert.deepEqual(round.map((b) => b.textContent), ["Short bio", "Nickname"]);
  assert.match(panel.$("status").textContent, /2 alternatives remain/);
  firstRound[2].click(); // a button from the superseded round
  await tick(); await tick();
  assert.equal(panel.$("planBox").hidden, true, "obsolete round creates nothing");
  assert.equal(panel.calls.execute, 1);
  round[1].click();
  await tick();
  assert.equal(panel.calls.execute, 1, "the resolved choice is reviewed, not run");
  assert.match(panel.$("planSteps").textContent, /Fill “Nickname” with “Pilot”/);
  panel.$("btnApprovePlan").click();
  await tick(); await tick(); await tick(); await tick();
  assert.equal(panel.calls.execute, 2);
  const last = panel.sends("SEEYABLE_EXECUTE_ACTION").pop().msg.request;
  assert.equal(last.elementId, "el-3");
  assert.equal(last.value, "Pilot", "value from the same round, never combined with another");
  panel.dom.window.close();
});

test("correction: navigation, Stop/Resume, cancellation of the choice preview, and a superseding request invalidate the model cache", async () => {
  for (const kind of ["tab", "stop-resume", "supersede", "cancel-preview"]) {
    const panel = makePanel(tabStub({ snapshots: [snap(base)] }), { plan: (body) => respond({ version: "seeyable-plan-1", outcome: "clarify", question: "Which?", action: "fill", value: "Pilot",
      choices: [{ elementId: "el-1", label: "Full name" }, { elementId: "el-2", label: "Short bio" }] }, body) });
    await typed(panel, "put Pilot somewhere");
    [...panel.$("clarifyChoices").querySelectorAll("button")][0].click();
    await tick();
    if (kind === "cancel-preview") {
      panel.$("btnCancelPlan").click(); // never approved: nothing to correct
    } else {
      panel.$("btnApprovePlan").click();
      await tick(); await tick(); await tick(); await tick();
    }
    const executedBefore = panel.calls.execute;
    if (kind === "tab") { for (const fn of panel.listeners.activated) fn({ tabId: 999 }); await tick(); }
    if (kind === "stop-resume") { panel.$("btnStopExec").click(); await tick(); panel.$("btnStopExec").click(); await tick(); }
    if (kind === "supersede") await typed(panel, "hide tags");
    const fetches = panel.calls.fetch.length;
    await typed(panel, "no, the other one");
    await tick(); await tick();
    assert.equal(panel.calls.fetch.length, fetches + 1, `${kind}: stale cache falls through to an ordinary planner request`);
    assert.equal(panel.calls.execute, executedBefore, `${kind}: nothing executes`);
    panel.dom.window.close();
  }
});

test("integrated: a manual edit before the request does not make its own preview stale", async () => {
  // Browser-found defect: planning reused the panel's cached snapshot, so
  // a person typing between commands produced a preview bound to an old
  // revision that approval could only refuse.
  const survey = makeSurvey();
  const panel = makePanel(survey.send, { plan: stubPlanner });
  panel.$("commandInput").value = "put Ada in Full name";
  panel.$("btnSendCommand").click();
  await waitFor(() => !panel.$("planBox").hidden, "first preview");
  panel.$("btnApprovePlan").click();
  await waitFor(() => /all verified/.test(panel.$("status").textContent), "first run");
  survey.doc.getElementById("bio").value = "Typed by the person"; // changes the semantic state
  panel.$("commandInput").value = "put Grace Hopper in Full name";
  panel.$("btnSendCommand").click();
  await waitFor(() => !panel.$("planBox").hidden, "second preview");
  panel.$("btnApprovePlan").click();
  await waitFor(() => /all verified|changed after you reviewed/.test(panel.$("status").textContent), "second run");
  assert.match(panel.$("status").textContent, /Completed 1 step, all verified/);
  assert.equal(survey.doc.getElementById("full-name").value, "Grace Hopper");
  assert.equal(survey.doc.getElementById("bio").value, "Typed by the person");
  panel.dom.window.close();
  survey.dom.window.close();
});

/* --- Headed finding: "Approve plan" heard as "approved plan" ------------- */

test("integrated: spoken “approved plan” approves the displayed plan once, with no extra model call", async () => {
  const survey = makeSurvey();
  const rec = makeRecognitionClass();
  const panel = makePanel(survey.send, { plan: stubPlanner, speechRecognition: rec.FakeRecognition });
  await say(panel, rec, "Put Grace Hopper in Full name and Scientist in Short bio.");
  await waitFor(() => !panel.$("planBox").hidden, "preview");
  const session = await say(panel, rec, "Approved plan.");
  session.fireFinal("Approved plan."); // duplicate final from the same session
  await waitFor(() => /Completed 2 steps, all verified/.test(panel.$("status").textContent), "approved run");
  await sleep(100);
  assert.equal(panel.calls.execute, 2, "one approval → the two steps once, never twice");
  assert.equal(panel.calls.fetch.length, 1, "the alias needed no model call");
  assert.equal(survey.doc.getElementById("full-name").value, "Grace Hopper");
  panel.dom.window.close();
  survey.dom.window.close();
});

test("aliases: each approves once; duplicate finals and a stale session cannot approve", async () => {
  for (const phrase of ["approve", "approved", "approved the plan", "go ahead"]) {
    const rec = makeRecognitionClass();
    const panel = makePanel(tabStub({ snapshots: [snap(base)] }), {
      plan: (body) => respond({ version: "seeyable-plan-1", outcome: "clarify", question: "Which field?", action: "fill", value: "Pilot",
        choices: [{ elementId: "el-1", label: "Full name" }, { elementId: "el-2", label: "Short bio" }] }, body),
      speechRecognition: rec.FakeRecognition,
    });
    await typed(panel, "put Pilot in the name-ish thing");
    // Stale: this session started before the plan existed.
    panel.$("btnListen").click();
    await tick();
    const stale = rec.instances[rec.instances.length - 1];
    stale.fireStart();
    [...panel.$("clarifyChoices").querySelectorAll("button")][0].click();
    await tick();
    stale.fireFinal(phrase);
    stale.fireEnd();
    await tick(); await tick();
    assert.equal(panel.calls.execute, 0, `${phrase}: stale session refused`);
    assert.equal(panel.$("planBox").hidden, false, `${phrase}: plan still waiting`);
    const s = await say(panel, rec, phrase);
    s.fireFinal(phrase);
    await tick(); await tick(); await tick(); await tick();
    assert.equal(panel.calls.execute, 1, `${phrase}: exactly one execution`);
    assert.equal(panel.calls.fetch.length, 1, `${phrase}: no model call`);
    panel.dom.window.close();
  }
});

test("aliases never approve a held consequential challenge", async () => {
  const survey = makeSurvey();
  const rec = makeRecognitionClass();
  const panel = makePanel(survey.send, { plan: stubPlanner, speechRecognition: rec.FakeRecognition });
  panel.$("commandInput").value = "click Submit survey";
  panel.$("btnSendCommand").click();
  await waitFor(() => !panel.$("confirmBox").hidden, "held challenge");
  for (const phrase of ["approve plan", "approved plan", "approve", "approved", "go ahead", "approved the plan"]) {
    await say(panel, rec, phrase);
    await tick(); await tick();
    assert.match(panel.$("status").textContent, /No plan is waiting for review\. Nothing was approved/, phrase);
  }
  await sleep(100);
  assert.equal(panel.sends("SEEYABLE_APPROVE_CHALLENGE").length, 0, "zero approval messages");
  assert.equal(survey.win.__submitted, undefined);
  assert.equal(panel.$("confirmBox").hidden, false, "the challenge still waits for its own approval");
  assert.equal(panel.calls.fetch.length, 0, "never sent to the planner");
  panel.dom.window.close();
  survey.dom.window.close();
});

test("unrecognized approval-like speech keeps the same usable preview and runs nothing", async () => {
  const rec = makeRecognitionClass();
  const panel = makePanel(tabStub({ snapshots: [snap(base)] }), { plan: twoFill, speechRecognition: rec.FakeRecognition });
  await typed(panel, "put Grace Hopper in Full name and Pilot in Short bio");
  const handle = panel.$("btnApprovePlan").onclick;
  const steps = panel.$("planSteps").textContent;
  for (const phrase of ["do not approve", "not approved", "approve later", "go ahead and submit", "approved plan and delete"]) {
    await say(panel, rec, phrase);
    await tick(); await tick();
    assert.equal(panel.$("planBox").hidden, false, `${phrase}: preview kept`);
    assert.equal(panel.$("btnApprovePlan").onclick, handle, `${phrase}: the very same preview`);
    assert.equal(panel.$("planSteps").textContent, steps);
    assert.match(panel.$("status").textContent, /Not approved .* plan is still waiting/, phrase);
  }
  await typed(panel, "approve later"); // typed path behaves the same
  assert.equal(panel.$("planBox").hidden, false);
  assert.equal(panel.calls.execute, 0, "nothing executed");
  assert.equal(panel.calls.fetch.length, 1, "nothing forwarded to the planner");
  // The kept preview is still usable by a proper approval.
  await say(panel, rec, "approve plan");
  await tick(); await tick(); await tick(); await tick();
  assert.equal(panel.calls.execute, 2);
  // A normal, non-approval request still supersedes a preview.
  await typed(panel, "put Ada in Full name and Pilot in Short bio");
  assert.equal(panel.calls.fetch.length, 2, "ordinary requests still supersede");
  panel.dom.window.close();
});
