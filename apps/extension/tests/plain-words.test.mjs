"use strict";
/* Plain Words panel (replaces #29): screens, state-driven main card, step
 * progress, and the consolidated controls (talk button, Stop/Resume, Undo,
 * Tags toggle, speak prompts, Alt+S). Real panel code on jsdom with stubbed
 * tab messaging, recognition, and planner. Presentation and wiring only:
 * no genuine microphone, model, or browser evidence. */
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
const html = read("../sidepanel.html");
const scripts = ["../lib/voice-commands.js", "../lib/command-resolver.js", "../lib/plan-schema.js", "../lib/planner.js", "../lib/meta-voice.js", "../lib/overlay.js", "../sidepanel.js"].map(read);

const el = (id, name, extra = {}) => ({ id, role: "textbox", name, nameSource: "label", question: null, questionCertain: false, state: {}, actionable: true, tag: "input", cssPath: "input", ...extra });
const snap = (elements, revision = 1) => ({ schemaVersion: 2, kind: "dom-aria", documentSessionId: "doc-A", revision, semanticHash: `h${revision}`, fresh: true, url: "http://localhost:8080/", elementCount: elements.length, elements });
const base = [el("el-1", "Full name"), el("el-7", "Short bio"), el("el-20", "Submit survey", { role: "button", tag: "button" })];

function makeRecognitionClass() {
  const instances = [];
  class FakeRecognition {
    constructor() { instances.push(this); }
    start() { this.started = true; }
    stop() { this.stopped = true; }
    abort() { this.aborted = true; }
    fireStart() { if (this.onstart) this.onstart(); }
    fireFinal(text) { if (!this.onresult) return; const r = [{ transcript: text }]; r.isFinal = true; this.onresult({ resultIndex: 0, results: [r] }); }
    fireEnd() { if (this.onend) this.onend(); }
  }
  return { FakeRecognition, instances };
}

function makePanel({ activeTabs, speech, onExecute, plan, executeGate, recognition, undo, elements = base, tabsGet, snapshotError, scriptedSnapshot, sessionExtra } = {}) {
  const dom = new JSDOM(html, { url: "chrome-extension://test/sidepanel.html", runScripts: "dangerously", pretendToBeVisual: true });
  const win = dom.window;
  const calls = { send: [], execute: 0, fetch: 0 };
  const listeners = { activated: [], updated: [] };
  win.console = { info: () => {}, warn: () => {}, error: () => {} };
  if (recognition) win.SpeechRecognition = recognition.FakeRecognition;
  if (speech) { win.speechSynthesis = speech.synth; win.SpeechSynthesisUtterance = speech.Utterance; }
  win.fetch = async (_url, init) => {
    calls.fetch += 1;
    const body = JSON.parse(init.body);
    return { json: async () => ({ ok: true, plan: plan(body), repaired: false, documentSessionId: body.snapshot.documentSessionId, revision: body.snapshot.revision }) };
  };
  const session = { plannerToken: "t", plannerPort: 6124, ...sessionExtra };
  calls.reload = [];
  listeners.storage = [];
  win.chrome = {
    tabs: {
      query: async () => (activeTabs ? activeTabs() : [{ id: 111, title: "Demo survey" }]),
      sendMessage: async (tabId, msg) => {
        calls.send.push(msg);
        if (msg.type === "SEEYABLE_SNAPSHOT_DOM") {
          if (snapshotError && snapshotError()) throw new Error("Receiving end does not exist.");
          return { ok: true, snapshot: snap(elements) };
        }
        if (msg.type === "SEEYABLE_EXECUTE_ACTION") {
          calls.execute += 1;
          if (onExecute) return onExecute(msg.request);
          return { ok: true, result: { verified: true }, newSnapshotDiff: { added: [], removed: [], updated: [] }, documentSessionId: "doc-A", revision: 1 };
        }
        if (msg.type === "SEEYABLE_APPROVE_CHALLENGE") return { ok: true, result: { dispatched: true, verified: false }, newSnapshotDiff: null, diffUnavailableReason: "x", documentSessionId: "doc-A", revision: 1 };
        if (msg.type === "SEEYABLE_CANCEL_CHALLENGE") return { ok: true, cancelled: true };
        if (msg.type === "SEEYABLE_UNDO_LAST") return undo ? undo(msg) : { ok: false, error: { code: "NOTHING_TO_UNDO", message: "There is no change to undo in this page. Nothing was changed." } };
        if (msg.type === "SEEYABLE_GATE_CONTROL") return { ok: true, gate: { stopped: msg.command === "stop", paused: false } };
        if (msg.type === "SEEYABLE_GET_ACTION_LOG") return { ok: true, entries: [
          { timestamp: "2026-11-01T10:00:01.000Z", source: "voice", action: "fill", elementId: "el-7", targetName: "Short bio", decision: "verified", approved: false },
          { timestamp: "2026-11-01T10:00:05.000Z", source: "manual", action: "click", elementId: "el-20", targetName: "Submit survey", decision: "confirmation-required", approved: false },
        ] };
        if (msg.type === "SEEYABLE_SHOW_TAGS") return { ok: true, shown: 3, total: 3, unplaced: [], revision: 1, documentSessionId: "doc-A" };
        if (msg.type === "SEEYABLE_HIDE_TAGS") return { ok: true, shown: 0, total: 3 };
        if (msg.type === "SEEYABLE_TAG_STATE") return { ok: true, states: Object.keys(msg.states).length };
        throw new Error("unexpected " + msg.type);
      },
      create: async () => ({ id: 5 }),
      get: async (id) => (tabsGet ? tabsGet(id) : { id, url: "http://localhost/form", status: "complete" }),
      reload: async (id) => { calls.reload.push(id); },
      onActivated: { addListener: (fn) => listeners.activated.push(fn) },
      onUpdated: { addListener: (fn) => listeners.updated.push(fn) },
    },
    scripting: { executeScript: async () => [{ result: scriptedSnapshot ? snap(elements) : null }] },
    runtime: { sendMessage: async () => ({ ok: false }), getURL: (p) => `chrome-extension://test/${p}` },
    permissions: { contains: async () => false },
    storage: { onChanged: { addListener: (fn) => listeners.storage.push(fn) }, local: { get: async () => ({}), set: async () => {} }, session: { get: async (k) => Object.fromEntries([].concat(k).map((x) => [x, session[x]])), set: async () => {}, remove: async () => {} } },
  };
  for (const js of scripts) win.eval(js);
  const $ = (id) => win.document.getElementById(id);
  return { dom, win, doc: win.document, calls, listeners, $, view: () => win.document.body.dataset.view };
}
const twoFill = (body) => ({ version: "seeyable-plan-1", outcome: "steps", steps: [
  { action: "fill", elementId: "el-1", value: "Grace Hopper" },
  { action: "fill", elementId: "el-7", value: "Scientist" },
] });
async function typed(panel, text) {
  panel.$("commandInput").value = text;
  panel.$("btnSendCommand").click();
  await tick(); await tick(); await tick();
}

test("plain words: screens switch via the nav; safety stays outside every screen", async () => {
  const p = makePanel({ plan: twoFill });
  assert.equal(p.$("screenAssist").hidden, false);
  for (const name of ["Targets", "Activity", "Settings", "Assist"]) {
    p.doc.querySelector(`.screen-nav [data-screen="${name}"]`).click();
    await tick();
    for (const other of ["Assist", "Targets", "Activity", "Settings"]) {
      assert.equal(p.$(`screen${other}`).hidden, other !== name, `${name}: ${other}`);
    }
    assert.equal(p.doc.querySelector('.screen-nav [aria-current="page"]').dataset.screen, name);
    assert.ok(!p.$("screens").contains(p.$("gateStatus")), "the gate status is announced from every screen");
    assert.ok(p.$("screenAssist").contains(p.$("btnStopExec")), "idle, Stop stays with the task on Assist");
  }
  p.dom.window.close();
});

test("plain words: a plan to review brings Assist back from another screen", async () => {
  const p = makePanel({ plan: twoFill });
  p.doc.querySelector('.screen-nav [data-screen="Settings"]').click();
  await typed(p, "put Grace Hopper in Full name and Scientist in Short bio");
  assert.equal(p.$("screenAssist").hidden, false, "review is never hidden behind Settings");
  assert.equal(p.view(), "plan");
  assert.equal(p.$("modeLabel").textContent, "~plan");
  assert.equal(p.$("stateChip").className, "chip is-review", "review is neutral: brick is reserved for the safety gate");
  assert.doesNotMatch(p.$("stateChip").textContent, /▲/);
  p.dom.window.close();
});

test("plain words: acting shows done/now/next from the reviewed steps; a verified run becomes the Completed list", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  let n = 0;
  const p = makePanel({
    plan: twoFill,
    onExecute: async () => {
      n += 1;
      if (n === 2) await gate;
      return { ok: true, result: { verified: true }, newSnapshotDiff: { added: [], removed: [], updated: [] }, documentSessionId: "doc-A", revision: 1 };
    },
  });
  await typed(p, "put Grace Hopper in Full name and Scientist in Short bio");
  p.$("btnApprovePlan").click();
  await tick(); await tick(); await tick(); await tick();
  assert.equal(p.view(), "acting");
  assert.equal(p.$("progressBox").hidden, false);
  assert.match(p.$("progressLabel").textContent, /ACTING · 2 OF 2/);
  const items = [...p.$("progressSteps").children];
  assert.equal(items[0].className, "is-done");
  assert.equal(items[1].className, "is-now");
  assert.match(items[1].textContent, /Fill “Short bio” with “Scientist”/);
  assert.match(p.$("progressNow").textContent, /Short bio/);
  release();
  await tick(); await tick(); await tick(); await tick();
  assert.equal(p.view(), "done");
  assert.equal(p.$("progressBox").hidden, true);
  assert.equal(p.$("resultBox").hidden, false);
  assert.equal(p.$("resultTitle").textContent, "2 changes made.");
  assert.equal(p.$("resultSteps").children.length, 2);
  assert.ok(!p.$("status").textContent.includes("Scientist"), "values stay out of the status line");
  p.$("btnNewRequest").click();
  assert.equal(p.view(), "ready");
  assert.equal(p.doc.activeElement.id, "commandInput");
  p.dom.window.close();
});

test("plain words: a stopped or unverified run never shows the Completed list", async () => {
  const p = makePanel({
    plan: twoFill,
    onExecute: (req) => req.elementId === "el-7"
      ? { ok: false, error: { code: "TARGET_DISABLED", message: "Target el-7 is disabled." }, newSnapshotDiff: null, diffUnavailableReason: "x", documentSessionId: "doc-A", revision: 1 }
      : { ok: true, result: { verified: true }, newSnapshotDiff: { added: [], removed: [], updated: [] }, documentSessionId: "doc-A", revision: 1 },
  });
  await typed(p, "put Grace Hopper in Full name and Scientist in Short bio");
  p.$("btnApprovePlan").click();
  await tick(); await tick(); await tick(); await tick(); await tick();
  assert.match(p.$("status").textContent, /Stopped: step 2 failed/);
  assert.equal(p.$("resultBox").hidden, true, "no Done card for a partial run");
  assert.notEqual(p.view(), "done");
  p.dom.window.close();
});

test("plain words: one talk control — Start becomes Done talking + Cancel while live", async () => {
  const rec = makeRecognitionClass();
  const p = makePanel({ plan: twoFill, recognition: rec });
  assert.equal(p.doc.body.dataset.voice, "idle");
  p.$("btnListen").click();
  await tick();
  rec.instances[0].fireStart();
  assert.equal(p.doc.body.dataset.voice, "listening", "CSS swaps Start for Done talking from this state");
  assert.equal(p.$("btnStopListen").disabled, false);
  assert.equal(p.$("btnCancelListen").disabled, false);
  assert.equal(p.view(), "listening");
  rec.instances[0].fireEnd();
  await tick();
  assert.equal(p.doc.body.dataset.voice, "idle");
  p.dom.window.close();
});

test("plain words: speak prompt on the plan starts a bound session; listening shows plan phrases", async () => {
  const rec = makeRecognitionClass();
  const p = makePanel({ plan: twoFill, recognition: rec });
  await typed(p, "put Grace Hopper in Full name and Scientist in Short bio");
  assert.equal(p.$("btnTalkPlan").disabled, false);
  p.$("btnTalkPlan").click();
  await tick();
  const s = rec.instances[rec.instances.length - 1];
  s.fireStart();
  assert.equal(p.$("listenHints").hidden, false);
  assert.equal(p.$("listenHintsLabel").textContent, "For the plan, say");
  assert.match(p.$("listenHintsList").textContent, /Approve plan/);
  assert.equal(p.$("planBox").hidden, false, "the plan stays visible while listening");
  s.fireFinal("Approved plan.");
  s.fireEnd();
  await tick(); await tick(); await tick(); await tick();
  assert.equal(p.calls.execute, 2, "a session started from the speak prompt approves the shown plan once");
  assert.equal(p.calls.fetch, 1, "no model call to approve");
  p.dom.window.close();
});

test("plain words: gate speak prompt approves only by voice; plan phrases never approve the gate", async () => {
  const rec = makeRecognitionClass();
  const p = makePanel({
    plan: twoFill,
    recognition: rec,
    onExecute: () => ({ ok: false, error: { code: "CONFIRMATION_REQUIRED", message: "Approval required." },
      confirmation: { challengeId: "ch-1", elementId: "el-20", action: "click", targetName: "Submit survey", consequence: "Submits.", expiresAt: "2099-01-01T00:00:00.000Z" }, documentSessionId: "doc-A", revision: 1 }),
  });
  await typed(p, "click Submit survey");
  assert.equal(p.view(), "gate");
  assert.equal(p.$("gateTalk").hidden, false);
  p.$("btnTalkGate").click();
  await tick();
  let s = rec.instances[rec.instances.length - 1];
  s.fireStart();
  assert.equal(p.$("listenHintsLabel").textContent, "For the held action, say");
  s.fireFinal("go ahead"); s.fireEnd();
  await tick(); await tick();
  assert.equal(p.calls.send.filter((m) => m.type === "SEEYABLE_APPROVE_CHALLENGE").length, 0, "plan aliases never approve a held action");
  p.$("btnTalkGate").click();
  await tick();
  s = rec.instances[rec.instances.length - 1];
  s.fireStart(); s.fireFinal("Approve this action."); s.fireEnd();
  await tick(); await tick(); await tick();
  assert.equal(p.calls.send.filter((m) => m.type === "SEEYABLE_APPROVE_CHALLENGE").length, 1);
  p.dom.window.close();
});

test("plain words: Alt+S starts talking outside text fields only", async () => {
  const rec = makeRecognitionClass();
  const p = makePanel({ plan: twoFill, recognition: rec });
  const press = (target, extra = {}) => {
    const e = new p.win.KeyboardEvent("keydown", { altKey: true, code: "KeyS", key: "ß", bubbles: true, cancelable: true, ...extra });
    target.dispatchEvent(e);
    return e;
  };
  p.$("commandInput").focus();
  const inField = press(p.$("commandInput"));
  await tick();
  assert.equal(rec.instances.length, 0, "typing in a text field is never taken over");
  assert.equal(inField.defaultPrevented, false, "Option+S still types ß");
  press(p.$("commandInput").ownerDocument.body, { ctrlKey: true });
  await tick();
  assert.equal(rec.instances.length, 0, "other modifier combos are ignored");
  p.doc.querySelector('.screen-nav [data-screen="Targets"]').click();
  const ok = press(p.doc.body);
  await tick();
  assert.equal(ok.defaultPrevented, true);
  assert.equal(rec.instances.length, 1, "Alt+S starts the same session as the mic button");
  assert.equal(p.$("screenAssist").hidden, false, "and returns to Assist");
  p.dom.window.close();
});

test("plain words: Undo button uses the undo command path and shows the honest refusal", async () => {
  let undos = 0;
  const p = makePanel({ plan: twoFill, undo: () => { undos += 1; return { ok: false, error: { code: "NOTHING_TO_UNDO", message: "There is no change to undo in this page. Nothing was changed." } }; } });
  assert.equal(p.$("btnUndo").disabled, false, "always offered");
  p.$("btnUndo").click();
  await tick(); await tick(); await tick();
  assert.equal(undos, 1);
  assert.match(p.$("status").textContent, /no change to undo/);
  assert.equal(p.calls.fetch, 0, "undo needs no model call");
  p.dom.window.close();
});

test("plain words: Tags toggle reflects state with aria-pressed and replaces the Try chips", async () => {
  const p = makePanel({ plan: twoFill });
  assert.equal(p.$("btnTryShow"), null);
  assert.equal(p.$("tagsChip").tagName, "BUTTON");
  p.$("tagsChip").click();
  await tick(); await tick();
  assert.equal(p.$("tagsChip").getAttribute("aria-pressed"), "true");
  assert.equal(p.$("tagsChip").textContent, "Tags: on");
  p.$("tagsChip").click();
  await tick(); await tick();
  assert.equal(p.$("tagsChip").getAttribute("aria-pressed"), "false");
  assert.equal(p.calls.send.filter((m) => m.type === "SEEYABLE_SHOW_TAGS").length, 1);
  assert.equal(p.calls.send.filter((m) => m.type === "SEEYABLE_HIDE_TAGS").length, 1);
  p.dom.window.close();
});

test("plain words: Stop shows the Stopped view and Resume returns to Ready", async () => {
  const p = makePanel({ plan: twoFill });
  p.$("btnStopExec").click();
  await tick(); await tick();
  assert.equal(p.view(), "stopped");
  assert.equal(p.$("commandHeading").textContent, "Stopped.");
  assert.match(p.$("heroCopy").textContent, /Nothing new will run until you resume/);
  assert.equal(p.$("modeLabel").textContent, "~stopped");
  p.$("btnStopExec").click();
  await tick(); await tick();
  assert.equal(p.view(), "ready");
  assert.equal(p.$("commandHeading").textContent, "Ready when you are.");
  p.dom.window.close();
});

test("plain words: activity lists the executor log in plain words without values", async () => {
  const p = makePanel({ plan: twoFill });
  await typed(p, "show tags"); // binds a tab for the log
  p.doc.querySelector('.screen-nav [data-screen="Activity"]').click();
  await tick(); await tick();
  const rows = [...p.$("activityList").querySelectorAll(".activity-row")];
  assert.equal(rows.length, 2);
  assert.match(rows[0].textContent, /click “Submit survey” · by you/);
  assert.match(rows[0].textContent, /held for your approval/);
  assert.match(rows[1].textContent, /fill “Short bio” · by voice/);
  assert.match(rows[1].textContent, /done, verified/);
  p.dom.window.close();
});

test("plain words: one announcer per outcome — execution results announce once", () => {
  const p = makePanel({ plan: twoFill });
  assert.equal(p.$("execStatus").getAttribute("role"), null, "#latestResult already announces the execution outcome");
  assert.equal(p.$("latestResult").getAttribute("aria-live"), "polite");
  assert.equal(p.$("confirmBox").getAttribute("role"), "alertdialog");
  assert.equal(p.$("confirmBox").getAttribute("aria-labelledby"), "confirmTitle");
  for (const id of ["progressBox", "resultBox", "listenHints"]) {
    assert.equal(p.$(id).getAttribute("aria-live"), null, `${id} is not a live region`);
  }
  p.dom.window.close();
});

test("plain words: page tag states follow the run — acting, then done only when verified", async () => {
  const p = makePanel({ plan: twoFill });
  await typed(p, "put Grace Hopper in Full name and Scientist in Short bio");
  assert.equal(p.calls.send.filter((m) => m.type === "SEEYABLE_TAG_STATE").length, 0, "review paints nothing on the page");
  p.$("btnApprovePlan").click();
  await tick(); await tick(); await tick(); await tick(); await tick();
  const states = p.calls.send.filter((m) => m.type === "SEEYABLE_TAG_STATE").map((m) => JSON.parse(JSON.stringify(m.states)));
  assert.deepEqual(states, [
    { "el-1": "acting" },
    { "el-1": "done", "el-7": "acting" },
    { "el-1": "done", "el-7": "done" },
  ]);
  assert.ok(p.calls.send.filter((m) => m.type === "SEEYABLE_TAG_STATE").every((m) => m.documentSessionId === "doc-A"));
  p.dom.window.close();
});

test("plain words: a failed step clears tag states; a held step is marked held; Stop clears", async () => {
  const fail = makePanel({
    plan: twoFill,
    onExecute: (req) => req.elementId === "el-7"
      ? { ok: false, error: { code: "TARGET_DISABLED", message: "x" }, newSnapshotDiff: null, diffUnavailableReason: "x", documentSessionId: "doc-A", revision: 1 }
      : { ok: true, result: { verified: true }, newSnapshotDiff: { added: [], removed: [], updated: [] }, documentSessionId: "doc-A", revision: 1 },
  });
  await typed(fail, "put Grace Hopper in Full name and Scientist in Short bio");
  fail.$("btnApprovePlan").click();
  await tick(); await tick(); await tick(); await tick(); await tick();
  const last = fail.calls.send.filter((m) => m.type === "SEEYABLE_TAG_STATE").pop();
  assert.deepEqual(JSON.parse(JSON.stringify(last.states)), {}, "no done tag for an unfinished run");
  fail.dom.window.close();

  const held = makePanel({
    plan: twoFill,
    onExecute: () => ({ ok: false, error: { code: "CONFIRMATION_REQUIRED", message: "Approval required." },
      confirmation: { challengeId: "ch-1", elementId: "el-20", action: "click", targetName: "Submit survey", consequence: "Submits.", expiresAt: "2099-01-01T00:00:00.000Z", documentSessionId: "doc-A" }, documentSessionId: "doc-A", revision: 1 }),
  });
  await typed(held, "click Submit survey");
  let sent = held.calls.send.filter((m) => m.type === "SEEYABLE_TAG_STATE").pop();
  assert.deepEqual(JSON.parse(JSON.stringify(sent.states)), { "el-20": "held" });
  held.$("btnStopExec").click();
  await tick(); await tick();
  sent = held.calls.send.filter((m) => m.type === "SEEYABLE_TAG_STATE").pop();
  assert.deepEqual(JSON.parse(JSON.stringify(sent.states)), {}, "Stop withdraws the held mark with the approval");
  held.dom.window.close();
});

/* --- Issue #16 blocker: concise, usable confirmation card --------------- */

const LONG_NAME = "Very satisfied, response for Checkout experience including the returns desk, gift wrapping, loyalty sign-up, and the parking validation stamp at the front counter";
const LONG_URL = "https://docs.google.com/forms/d/e/1FAIpQLSdExampleExampleExampleExampleExampleExample/viewform?usp=sf_link&entry.123456789=__other_option__&hl=en";
function heldPanel(extra = {}) {
  return makePanel({
    plan: twoFill,
    onExecute: () => ({ ok: false, error: { code: "CONFIRMATION_REQUIRED", message: "Approval required." },
      confirmation: { challengeId: "ch-long", elementId: "el-20", action: "click", targetName: extra.name || LONG_NAME, targetQuestion: extra.question || null,
        consequence: "This activates a form submission control. What it sends, to whom, and whether it can be undone cannot be determined from the page.",
        pageUrl: LONG_URL, documentSessionId: "doc-A", revision: 1, expiresAt: "2099-01-01T12:00:00.000Z" }, documentSessionId: "doc-A", revision: 1 }),
  });
}

test("#16 card: short heading, one readable target line, page title/domain; full facts in Details", async () => {
  const p = heldPanel({ question: "Rate your visit" });
  await typed(p, "click Submit survey");
  const title = p.$("confirmTitle");
  assert.equal(title.textContent.replace(/^\u25B2 /, ""), "Approve this action?", "the heading never carries the target name");
  assert.equal(title.querySelector("[aria-hidden='true']").textContent, "\u25B2 ", "the glyph is decorative");
  assert.equal(p.$("btnApproveOnce").textContent, "Approve once", "a clean accessible name; the spoken phrase is shown by the voice prompt");
  assert.equal(p.$("confirmSummary").textContent, `Click “${LONG_NAME}”`, "the full target is kept, in body text");
  assert.equal(p.$("confirmQuestion").textContent, "Question: Rate your visit");
  assert.equal(p.$("confirmPage").textContent, "On Demo survey · docs.google.com", "title and domain, not the full URL");
  assert.ok(!p.$("confirmPage").textContent.includes("/forms/"));
  assert.match(p.$("confirmCopy").textContent, /^Nothing has run yet\. Approving runs this one action once\. The approval expires at /);
  assert.equal(p.$("confirmDetails").open, false, "diagnostics are optional and start closed");
  assert.ok(p.$("confirmText").textContent.includes(LONG_URL), "the full URL is in Details, unshortened");
  assert.match(p.$("confirmText").textContent, /\(el-20\)/);
  assert.match(p.$("confirmText").textContent, /form submission control/);
  assert.equal(p.doc.activeElement.id, "confirmTitle", "focus lands on the heading, never on Approve");
  assert.deepEqual(p.$("confirmBox").getAttribute("aria-describedby").split(" "), ["confirmSummary", "confirmCopy"]);
  p.dom.window.close();
});

test("#16 card: decisions come before diagnostics; voice approval prompt stays", async () => {
  const p = heldPanel();
  await typed(p, "click Submit survey");
  const order = (a, b) => Boolean(p.$(a).compareDocumentPosition(p.$(b)) & 4);
  assert.ok(order("btnApproveOnce", "confirmDetails"), "Approve once precedes Details");
  assert.ok(order("btnCancelChallenge", "confirmDetails"), "Cancel precedes Details");
  assert.ok(order("confirmSummary", "btnApproveOnce"), "the action is described before the buttons");
  assert.equal(p.$("gateTalk").hidden, false, "Approve by voice remains available");
  assert.ok(order("btnCancelChallenge", "btnStopExec"), "Stop sits below the gate decision");
  assert.ok(order("btnStopExec", "gateTalk"), "and above Approve by voice");
  assert.equal(p.$("confirmBox").contains(p.$("btnStopExec")), false, "Stop is not part of the alertdialog");
  p.dom.window.close();
});

test("#16 card: no repeated copy and no earlier success next to a held action", async () => {
  const p = heldPanel();
  p.$("latestResult").textContent = "Latest result: Completed and verified against live page state.";
  await typed(p, "click Submit survey");
  assert.equal(p.$("latestResult").textContent, "", "an earlier verified result is cleared while this action is held");
  assert.equal(p.$("resultBox").hidden, true);
  assert.equal(p.$("confirmStatus").textContent, "", "the card already says nothing has run");
  assert.match(p.$("status").textContent, /waiting for your approval/);
  assert.ok(!p.$("status").textContent.includes(LONG_NAME), "the status line does not repeat the long target");
  assert.match(p.$("stateChip").textContent, /Held/);
  p.dom.window.close();
});

test("#16 card: shortened presentation never shortens the approved request", async () => {
  const p = heldPanel();
  await typed(p, "click Submit survey");
  p.$("btnApproveOnce").click();
  await tick(); await tick(); await tick();
  const approvals = p.calls.send.filter((m) => m.type === "SEEYABLE_APPROVE_CHALLENGE");
  assert.equal(approvals.length, 1);
  assert.deepEqual(Object.keys(approvals[0]).sort(), ["challengeId", "type"], "approval carries only the challenge id; binding stays in the executor");
  assert.equal(approvals[0].challengeId, "ch-long");
  p.dom.window.close();
});

test("#16 preview: a click on a survey radio with 'Checkout' in its name is not marked as needing approval", async () => {
  const radioName = "Satisfied, response for Checkout experience";
  const p = makePanel({
    plan: () => ({ version: "seeyable-plan-1", outcome: "steps", steps: [{ action: "click", elementId: "el-1" }] }),
  });
  // Re-label the first snapshot element as a survey radio for this test.
  base[0] = el("el-1", radioName, { role: "radio", tag: "div", question: "Checkout experience", questionCertain: true });
  try {
    await typed(p, "select satisfied for checkout experience");
    assert.match(p.$("planSteps").textContent, /Click “Satisfied, response for Checkout experience”/);
    assert.doesNotMatch(p.$("planSteps").textContent, /ask for its own approval/);
    assert.equal(p.$("planSteps").querySelector(".step-note"), null);
  } finally {
    base[0] = el("el-1", "Full name");
    p.dom.window.close();
  }
});

test("#16 preview: hints follow the executor rule — committing selection labels and role-disguised buttons are marked", async () => {
  const cases = [
    [el("el-1", "Delete all saved responses", { role: "checkbox", tag: "input" }), "check", true],
    [el("el-1", "Delete draft", { role: "checkbox", tag: "button" }), "click", true],
    [el("el-1", "Pay now", { role: "radio", tag: "div", question: "Payment", questionCertain: true }), "check", true],
    [el("el-1", "Very satisfied, response for Checkout experience", { role: "radio", tag: "div", question: "Rate your visit: Checkout experience", questionCertain: true }), "check", false],
    [el("el-1", "Very satisfied, response for Checkout experience", { role: "radio", tag: "div", question: "Checkout experience", questionCertain: false }), "click", true],
    [el("el-1", "Email me product updates", { role: "checkbox", tag: "input" }), "check", false],
    [el("el-1", "Pay now (required)", { role: "checkbox", tag: "input", question: "Pay now", questionCertain: true }), "check", true],
    [el("el-1", "Delete all saved responses now", { role: "checkbox", tag: "div", question: "Delete all saved responses", questionCertain: true }), "click", true],
    [el("el-1", "Send notification immediately", { role: "checkbox", tag: "input", question: "Send notification", questionCertain: true }), "check", true],
  ];
  for (const [element, action, expectHint] of cases) {
    const p = makePanel({ plan: () => ({ version: "seeyable-plan-1", outcome: "steps", steps: [{ action, elementId: "el-1" }] }) });
    base[0] = element;
    try {
      await typed(p, "do the reviewed thing please");
      const hinted = /ask for its own approval/.test(p.$("planSteps").textContent);
      assert.equal(hinted, expectHint, `${element.name} (${element.tag} ${element.role}, ${action})`);
    } finally {
      base[0] = el("el-1", "Full name");
      p.dom.window.close();
    }
  }
});

test("panel logic reads state flags, never display text", () => {
  const source = readFileSync(new URL("../sidepanel.js", import.meta.url), "utf8");
  for (const pattern of [
    /\$\("status"\)\.textContent\s*[=!]==/,
    /\$\("status"\)\.classList\.contains/,
    /\.textContent\s*===\s*"Voice:/,
    /\^Transcript:/,
    /\^Completed and verified/,
    /detail\.startsWith\(/,
  ]) {
    assert.ok(!pattern.test(source), `display text used as logic: ${pattern}`);
  }
});

test("source: a long snapshot URL wraps instead of widening the screen", () => {
  const css = read("../sidepanel.css");
  assert.match(css, /\.meta \{[^}]*overflow-wrap: anywhere/);
  assert.match(css, /\.toolbar \.meta \{ flex: 1 1 100%/);
});

const heldResponse = (expiresAt) => ({
  ok: false, error: { code: "CONFIRMATION_REQUIRED", message: "Approval required." },
  confirmation: { challengeId: "ch-1", elementId: "el-20", action: "click", targetName: "Submit survey", consequence: "Submits.", expiresAt },
  documentSessionId: "doc-A", revision: 1,
});

test("plain words: cancelling a hold removes the held notice and reports the outcome once", async () => {
  const p = makePanel({ plan: twoFill, onExecute: () => heldResponse("2099-01-01T00:00:00.000Z") });
  await typed(p, "click Submit survey");
  assert.equal(p.view(), "gate");
  assert.match(p.$("status").textContent, /^Held/);
  p.$("btnCancelChallenge").click();
  await tick(); await tick();
  assert.notEqual(p.view(), "gate");
  assert.equal(p.$("status").textContent, "", "nothing still claims an action is held");
  assert.match(p.$("confirmStatus").textContent, /Cancelled/);
  await typed(p, "show tags");
  assert.equal(p.$("confirmStatus").textContent, "", "the next command clears the old outcome");
  p.dom.window.close();
});

test("plain words: Stop clears an old gate outcome", async () => {
  const p = makePanel({ plan: twoFill, onExecute: () => heldResponse("2099-01-01T00:00:00.000Z") });
  await typed(p, "click Submit survey");
  p.$("btnCancelChallenge").click();
  await tick(); await tick();
  p.$("btnStopExec").click();
  await tick(); await tick();
  assert.equal(p.$("confirmStatus").textContent, "");
  p.dom.window.close();
});

test("plain words: the gate counts down for sight and announces once", async () => {
  const p = makePanel({ plan: twoFill, onExecute: () => heldResponse(new Date(Date.now() + 60000).toISOString()) });
  await typed(p, "click Submit survey");
  const countdown = p.$("confirmCountdown");
  assert.equal(countdown.hidden, false);
  assert.match(countdown.textContent, /^Expires in [01]:\d\d$/);
  assert.equal(countdown.getAttribute("aria-hidden"), "true", "the ticking text is never announced");
  assert.equal(countdown.getAttribute("role"), null);
  assert.match(p.$("confirmCopy").querySelector(".sr-only").textContent, /about a minute/);
  assert.ok(!p.$("confirmBox").getAttribute("aria-describedby").includes("confirmCountdown"));
  p.$("btnCancelChallenge").click();
  await tick(); await tick();
  assert.equal(countdown.hidden, true);
  p.dom.window.close();
});

test("plain words: an expired countdown says so and leaves refusal to the executor", async () => {
  const p = makePanel({ plan: twoFill, onExecute: () => heldResponse(new Date(Date.now() - 1000).toISOString()) });
  await typed(p, "click Submit survey");
  assert.match(p.$("confirmCountdown").textContent, /expired/);
  assert.equal(p.$("confirmBox").hidden, false, "the card stays until the person acts");
  assert.equal(p.calls.send.filter((m) => m.type === "SEEYABLE_APPROVE_CHALLENGE").length, 0);
  p.dom.window.close();
});

test("plain words: an error from another tab gives way to a good snapshot, a discarded plan does not", async () => {
  const p = makePanel({ plan: twoFill });
  await typed(p, "click qqqqqq");
  assert.ok(p.$("status").classList.contains("error"), "starts from a real error");
  for (const fn of p.listeners.activated) fn({ tabId: 222 });
  await tick(); await tick(); await tick();
  assert.match(p.$("status").textContent, /^Found \d+ controls/, "the old tab's error is gone");
  assert.ok(!p.$("status").classList.contains("error"));
  p.dom.window.close();

  const q = makePanel({ plan: twoFill });
  await typed(q, "put Grace Hopper in Full name and Pilot in Short bio");
  assert.equal(q.view(), "plan");
  for (const fn of q.listeners.activated) fn({ tabId: 222 });
  await tick(); await tick(); await tick();
  assert.match(q.$("status").textContent, /Active tab changed/, "losing a plan stays reported");
  q.dom.window.close();
});

// Replaces one tab reply on an already built panel.
function answer(p, type, reply) {
  const original = p.win.chrome.tabs.sendMessage;
  p.win.chrome.tabs.sendMessage = async (tabId, msg) => (msg.type === type ? reply(msg) : original(tabId, msg));
}

test("plain words: Activity uses local time, plain words and names, and never implies success", async () => {
  const p = makePanel({ plan: twoFill });
  const stamp = "2026-11-04T03:24:13.000Z";
  answer(p, "SEEYABLE_GET_ACTION_LOG", () => ({ ok: true, entries: [
    { timestamp: stamp, source: "manual", action: "click", elementId: "el-20", targetName: null, decision: "EXECUTION_STOPPED" },
    { timestamp: stamp, source: "manual", action: "gate-resume", elementId: null, targetName: null, decision: "resumed" },
    { timestamp: stamp, source: "mcp", action: "fill", elementId: "el-99", targetName: null, decision: "SOME_NEW_CODE" },
  ] }));
  await typed(p, "show tags");
  p.doc.querySelector('.screen-nav [data-screen="Activity"]').click();
  await tick(); await tick();
  const rows = [...p.$("activityList").querySelectorAll(".activity-row")].reverse();
  const local = new Date(stamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  assert.equal(rows[0].querySelector(".when").textContent, local);
  assert.match(rows[0].textContent, /click “Submit survey”/, "a missing log name falls back to the snapshot");
  assert.match(rows[0].textContent, /not run, Seeyable was stopped/);
  assert.ok(!/EXECUTION_STOPPED/.test(rows[0].textContent));
  assert.match(rows[1].textContent, /Resume/);
  assert.ok(!/gate-resume/.test(rows[1].textContent));
  assert.match(rows[2].textContent, /fill target 99 · by an assistant/);
  assert.match(rows[2].textContent, /did not complete/);
  p.dom.window.close();
});

test("plain words: the snapshot line shows host and path, not the query string", async () => {
  const p = makePanel({ plan: twoFill });
  answer(p, "SEEYABLE_SNAPSHOT_DOM", () => ({ ok: true, snapshot: {
    ...snap(base), url: "https://docs.google.com/forms/d/e/abc/viewform?usp=pp_url&secret=1",
  } }));
  p.$("btnDom").click();
  await tick(); await tick(); await tick();
  assert.match(p.$("meta").textContent, /docs\.google\.com\/forms\/d\/e\/abc\/viewform$/);
  assert.ok(!p.$("meta").textContent.includes("secret"));
  p.dom.window.close();
});

/* --- Slice 2: words, recovery, examples, unavailable page, clearer undo --- */
const fills = (...ids) => () => ({ version: "seeyable-plan-1", outcome: "steps", steps: ids.map((id) => (
  id === "el-20" ? { action: "click", elementId: id } : { action: "fill", elementId: id, value: "x" }
)) });
const verified = { ok: true, result: { verified: true }, newSnapshotDiff: { added: [], removed: [], updated: [] }, documentSessionId: "doc-A", revision: 1 };
const fourFields = [el("el-1", "Full name"), el("el-2", "Nickname"), el("el-3", "City"), el("el-7", "Short bio"), el("el-20", "Save draft", { role: "button", tag: "button" })];
async function runPlan(p) {
  await typed(p, "please do these things in order");
  assert.equal(p.view(), "plan");
  p.$("btnApprovePlan").click();
  await tick(); await tick(); await tick(); await tick();
}

test("undo words: Done names the last target and says what stays, for a plan ending in a fill", async () => {
  const p = makePanel({ plan: fills("el-1", "el-7") });
  await tick();
  assert.equal(p.$("btnUndo").textContent, "Undo last change", "generic before anything ran");
  await typed(p, "please do these things in order");
  assert.equal(p.view(), "plan");
  assert.equal(p.$("btnUndo").textContent, "Undo last change", "generic during review");
  p.$("btnApprovePlan").click();
  await tick(); await tick(); await tick(); await tick();
  assert.equal(p.view(), "done");
  assert.equal(p.$("btnUndo").textContent, "Undo Short bio");
  assert.equal(p.$("resultUndoNote").textContent, "Undo reverts Short bio only. Full name stays as it is.");
  p.dom.window.close();
});

test("undo words: the Done note covers one step, several steps, and a plan ending in a click", async () => {
  const cases = [
    { ids: ["el-7"], label: "Undo Short bio", note: "Undo puts Short bio back as it was." },
    { ids: ["el-1", "el-2", "el-7"], label: "Undo Short bio", note: "Undo reverts Short bio only. Full name and Nickname stay as they are." },
    { ids: ["el-1", "el-2", "el-3", "el-7"], label: "Undo Short bio", note: "Undo reverts Short bio only. The other 3 changes stay as they are." },
    { ids: ["el-1", "el-20"], label: "Undo last change", note: "This ended with a click, so these changes can’t be undone from here." },
    { ids: ["el-20"], label: "Undo last change", note: "This was a click, so it can’t be undone from here." },
  ];
  for (const c of cases) {
    const p = makePanel({ plan: fills(...c.ids), elements: fourFields });
    await tick();
    await runPlan(p);
    assert.equal(p.view(), "done", c.ids.join());
    assert.equal(p.$("btnUndo").textContent, c.label, c.ids.join());
    assert.equal(p.$("resultUndoNote").textContent, c.note, c.ids.join());
    p.dom.window.close();
  }
});

test("undo words: a last step that changed nothing names no target, because the executor would undo an earlier change", async () => {
  let n = 0;
  const p = makePanel({
    plan: fills("el-1", "el-7"),
    onExecute: () => { n += 1; return n === 2 ? { ...verified, result: { alreadyInDesiredState: true } } : verified; },
  });
  await tick();
  await runPlan(p);
  assert.equal(p.view(), "done");
  assert.equal(p.$("btnUndo").textContent, "Undo last change");
  assert.match(p.$("resultUndoNote").textContent, /^Undo restores the last change only/);
  p.dom.window.close();
});

test("undo words: a very long name keeps the generic button label", async () => {
  const long = "What is the full name you would like us to use";
  const p = makePanel({ plan: fills("el-7"), elements: [el("el-7", long)] });
  await tick();
  await runPlan(p);
  assert.equal(p.$("btnUndo").textContent, "Undo last change");
  p.dom.window.close();
});

test("undo words: the name is dropped by a new command, Stop, a tab change, and New request", async () => {
  const leave = {
    "new command": async (p) => { await typed(p, "show tags"); },
    stop: async (p) => { p.$("btnStopExec").click(); await tick(); await tick(); },
    "tab change": async (p) => { for (const fn of p.listeners.activated) fn({ tabId: 222 }); await tick(); await tick(); },
    "new request": async (p) => { p.$("btnNewRequest").click(); await tick(); },
  };
  for (const [name, act] of Object.entries(leave)) {
    const p = makePanel({ plan: fills("el-1", "el-7") });
    await tick();
    await runPlan(p);
    assert.equal(p.$("btnUndo").textContent, "Undo Short bio", name);
    await act(p);
    assert.equal(p.$("btnUndo").textContent, "Undo last change", name);
    assert.notEqual(p.view(), "done", name);
    p.dom.window.close();
  }
});

test("undo words: an agent bridge keeps everything generic, whether wanted at the start or connected later", async () => {
  const wanted = makePanel({ plan: fills("el-1", "el-7"), sessionExtra: { bridgeWanted: true } });
  await tick();
  await runPlan(wanted);
  assert.equal(wanted.view(), "done");
  assert.equal(wanted.$("btnUndo").textContent, "Undo last change");
  assert.match(wanted.$("resultUndoNote").textContent, /^Undo restores the last change only/);
  wanted.dom.window.close();

  const later = makePanel({ plan: fills("el-1", "el-7") });
  await tick();
  await runPlan(later);
  assert.equal(later.$("btnUndo").textContent, "Undo Short bio");
  for (const fn of later.listeners.storage) fn({ bridgeWanted: { newValue: true } }, "session");
  await tick();
  assert.equal(later.$("btnUndo").textContent, "Undo last change", "connecting an agent drops the name");
  for (const fn of later.listeners.storage) fn({ bridgeWanted: {} }, "session");
  await tick();
  assert.equal(later.$("btnUndo").textContent, "Undo Short bio", "disconnecting restores it while Done stands");
  later.dom.window.close();
});

test("undo phrases: each accepted phrase reaches undo with no planner call; near-misses never do", async () => {
  for (const phrase of ["undo last change", "Undo the last change.", "undo that", "Undo it"]) {
    let undos = 0;
    const p = makePanel({ plan: twoFill, undo: () => { undos += 1; return { ok: false, error: { code: "NOTHING_TO_UNDO", message: "There is no change to undo." } }; } });
    await tick();
    await typed(p, phrase);
    assert.equal(undos, 1, phrase);
    assert.equal(p.calls.fetch, 0, phrase);
    p.dom.window.close();
  }
  for (const phrase of ["don't undo that", "undo that please", "please undo it", "undo", "and do that", "undo everything"]) {
    let undos = 0;
    const p = makePanel({ plan: twoFill, undo: () => { undos += 1; return { ok: true, result: {} }; } });
    await tick();
    await typed(p, phrase);
    assert.equal(undos, 0, phrase);
    p.dom.window.close();
  }
});

test("undo phrases: during plan review the new phrases behave exactly like “undo last change” and never run the plan", async () => {
  for (const phrase of ["undo last change", "undo that", "undo it"]) {
    let undos = 0;
    const p = makePanel({ plan: twoFill, undo: () => { undos += 1; return { ok: false, error: { code: "NOTHING_TO_UNDO", message: "There is no change to undo." } }; } });
    await tick();
    await typed(p, "please do these things in order");
    assert.equal(p.view(), "plan", phrase);
    await typed(p, phrase);
    assert.equal(undos, 1, phrase);
    assert.equal(p.calls.execute, 0, `${phrase}: nothing in the plan ran`);
    assert.notEqual(p.view(), "plan", `${phrase}: the plan under review is discarded, as before`);
    p.dom.window.close();
  }
});

test("undo phrases: a held action stays held and is never approved by an undo phrase", async () => {
  for (const phrase of ["undo last change", "undo that", "undo it"]) {
    let undos = 0;
    const p = makePanel({
      plan: twoFill,
      onExecute: () => heldResponse("2099-01-01T00:00:00.000Z"),
      undo: () => { undos += 1; return { ok: false, error: { code: "NOTHING_TO_UNDO", message: "There is no change to undo." } }; },
    });
    await tick();
    await typed(p, "click Submit survey");
    assert.equal(p.view(), "gate", phrase);
    await typed(p, phrase);
    assert.equal(undos, 1, phrase);
    assert.equal(p.view(), "gate", `${phrase}: still held`);
    assert.equal(p.calls.send.filter((m) => m.type === "SEEYABLE_APPROVE_CHALLENGE").length, 0, phrase);
    p.dom.window.close();
  }
});

test("words: an unverified click says so in plain words and never claims a check", async () => {
  const p = makePanel({
    plan: twoFill,
    onExecute: () => ({ ok: true, result: { dispatched: true, verified: false }, newSnapshotDiff: null, diffUnavailableReason: "x", documentSessionId: "doc-A", revision: 1 }),
    elements: fourFields,
  });
  await tick();
  await typed(p, "click Save draft");
  assert.equal(p.$("status").textContent, "Clicked Save draft. I can’t confirm the page responded, so please check it.");
  assert.match(p.$("execResult").textContent, /NOT verified/, "the raw outcome stays in the Developer view");
  p.dom.window.close();
});

test("words: already-set values and a lost connection are told honestly", async () => {
  const same = makePanel({ plan: twoFill, onExecute: () => ({ ...verified, result: { alreadyInDesiredState: true } }), elements: fourFields });
  await tick();
  await typed(same, "fill Short bio with x");
  assert.match(same.$("status").textContent, /Short bio was already set that way/);
  same.dom.window.close();
  const lost = makePanel({ plan: twoFill, onExecute: () => { throw new Error("gone"); }, elements: fourFields });
  await tick();
  await typed(lost, "fill Short bio with x");
  assert.match(lost.$("status").textContent, /lost contact with the page, so I can.t tell whether Short bio changed/);
  lost.dom.window.close();
});

test("recovery: an unpaired request shows the card, opens Developer view, and clears on the next command", async () => {
  const p = makePanel({ plan: twoFill, sessionExtra: { plannerToken: undefined, plannerPort: undefined } });
  await tick();
  assert.equal(p.$("recoverBox").hidden, true);
  await typed(p, "please fill this form");
  assert.equal(p.calls.fetch, 0);
  assert.equal(p.$("recoverBox").hidden, false);
  assert.equal(p.doc.body.dataset.recover, "true");
  assert.equal(p.$("recoverTitle").textContent.includes("I can’t plan that yet"), true);
  assert.match(p.$("recoverCopy").textContent, /Simple commands like .fill Full name with Ada. work now/);
  assert.doesNotMatch(p.$("status").textContent, /`|node apps|server\.mjs/, "no command line in the status");
  p.$("btnRecoverDeveloper").click();
  await tick();
  assert.equal(p.$("screenSettings").hidden, false);
  assert.equal(p.$("developerView").open, true);
  assert.equal(p.doc.activeElement, p.$("plannerHeading"));
  assert.equal(p.$("status").textContent, "", "the handled error does not linger");
  assert.equal(p.$("recoverBox").hidden, true);
  p.dom.window.close();

  const q = makePanel({ plan: twoFill, sessionExtra: { plannerToken: undefined, plannerPort: undefined } });
  await tick();
  await typed(q, "please fill this form");
  assert.equal(q.$("recoverBox").hidden, false);
  await typed(q, "show tags");
  assert.equal(q.$("recoverBox").hidden, true, "a working command clears it");
  await typed(q, "please fill this form");
  q.$("btnStopExec").click();
  await tick(); await tick();
  assert.equal(q.$("recoverBox").hidden, true, "Stop clears it");
  q.dom.window.close();
});

test("examples: chips come from a real field, only fill the input, and the example runs with no planner", async () => {
  const p = makePanel({ plan: twoFill });
  await tick(); await tick();
  assert.equal(p.$("commandInput").placeholder, "Fill Full name with Ada");
  const chips = [...p.$("tryChips").querySelectorAll("button")];
  assert.deepEqual(chips.map((c) => c.textContent), ["Fill Full name with Ada", "Show tags"]);
  const sent = p.calls.send.length;
  chips[0].click();
  await tick(); await tick();
  assert.equal(p.$("commandInput").value, "Fill Full name with Ada");
  assert.equal(p.doc.activeElement, p.$("commandInput"));
  assert.ok(p.calls.send.slice(sent).every((m) => m.type !== "SEEYABLE_EXECUTE_ACTION"), "a chip never sends");
  assert.equal(p.calls.execute, 0);
  p.$("btnSendCommand").click();
  await tick(); await tick(); await tick();
  assert.equal(p.calls.execute, 1);
  assert.equal(p.calls.fetch, 0, "works without the planner");
  assert.equal(p.calls.send.find((m) => m.type === "SEEYABLE_EXECUTE_ACTION").request.elementId, "el-1");
  p.dom.window.close();
});

test("examples: never offered for Submit, secrets, unsuitable, filled, or look-alike fields", async () => {
  const none = [
    el("el-1", "Password", { state: { redacted: true } }),
    el("el-2", "Disabled one", { state: { disabled: true } }),
    el("el-3", "Locked one", { state: { readonly: true } }),
    el("el-4", "Already filled", { state: { value: "mine" } }),
    el("el-5", "Work email"),
    el("el-6", "A label that is much too long to read as an example"),
    el("el-7", "Twin"), el("el-8", "Twin"),
    el("el-20", "Submit survey", { role: "button", tag: "button" }),
  ];
  const p = makePanel({ plan: twoFill, elements: none });
  await tick(); await tick();
  assert.equal(p.$("commandInput").placeholder, "e.g. Fill in this form");
  assert.deepEqual([...p.$("tryChips").querySelectorAll("button")].map((c) => c.textContent), ["Show tags"]);
  assert.doesNotMatch(p.$("tryChips").textContent, /Submit/);
  p.dom.window.close();
});

test("examples: page names are data, never markup", async () => {
  const p = makePanel({ plan: twoFill, elements: [el("el-1", "<b>Nick</b>")] });
  await tick(); await tick();
  const chip = p.$("tryChips").querySelector("button");
  assert.equal(chip.querySelector("b"), null);
  assert.equal(chip.textContent, "Fill <b>Nick</b> with Ada");
  p.dom.window.close();
});

test("unavailable: a closed page explains itself with no Reload, no mic path, and safety and nav intact", async () => {
  for (const url of ["chrome://newtab/", "about:blank", "chrome-extension://abc/page.html", "https://chromewebstore.google.com/detail/x", "https://chrome.google.com/webstore/detail/x"]) {
    const rec = makeRecognitionClass();
    const p = makePanel({ plan: twoFill, recognition: rec, snapshotError: () => true, tabsGet: (id) => ({ id, url, status: "complete" }) });
    await tick(); await tick(); await tick();
    assert.equal(p.view(), "unavailable", url);
    assert.equal(p.$("modeLabel").textContent, "~n/a", url);
    assert.equal(p.$("stateChip").textContent, "Unavailable", url);
    assert.match(p.$("commandHeading").textContent, /can.t work on this page/, url);
    assert.equal(p.$("btnReloadPage").hidden, true, `${url}: Reload cannot help`);
    assert.equal(p.$("tagsChip").textContent, "Tags: off", url);
    assert.equal(p.$("tagsChip").disabled, true, url);
    assert.equal(p.$("btnStopExec").disabled, false, url);
    assert.equal(p.$("btnUndo").disabled, false, url);
    const alt = new p.win.KeyboardEvent("keydown", { altKey: true, code: "KeyS", bubbles: true, cancelable: true });
    p.doc.body.dispatchEvent(alt);
    await tick();
    assert.equal(rec.instances.length, 0, `${url}: Alt+S starts nothing`);
    p.dom.window.close();
  }
  const css = read("../sidepanel.css");
  assert.match(css, /body\[data-view="unavailable"\] #btnListen, body\[data-view="unavailable"\] \.request-label, body\[data-view="unavailable"\] #voiceState \{ display: none; \}/);
});

test("unavailable: an ordinary page without the content script offers Reload, then recovers after it", async () => {
  let broken = true;
  const p = makePanel({ plan: twoFill, snapshotError: () => broken });
  await tick(); await tick(); await tick();
  assert.equal(p.view(), "unavailable");
  assert.match(p.$("commandHeading").textContent, /needs a reload/);
  assert.match(p.$("heroCopy").textContent, /anything you typed into the page may be lost/);
  assert.equal(p.$("btnReloadPage").hidden, false);
  p.$("btnReloadPage").click();
  await tick();
  assert.deepEqual(p.calls.reload, [111], "only the click reloads, and only this tab");
  broken = false;
  for (const fn of p.listeners.updated) fn(111, { status: "loading" });
  await tick();
  assert.notEqual(p.view(), "unavailable");
  for (const fn of p.listeners.updated) fn(111, { status: "complete" });
  await tick(); await tick(); await tick();
  assert.equal(p.view(), "ready");
  assert.equal(p.$("tagsChip").disabled, false);
  assert.equal(p.$("targetSelect").options.length, 4, "the page is bound again");
  p.dom.window.close();
});

test("unavailable: a slow-loading page is never called unavailable; the finished load decides", async () => {
  let broken = true;
  let status = "loading";
  const p = makePanel({ plan: twoFill, snapshotError: () => broken, tabsGet: (id) => ({ id, url: "https://slow.example/", status }) });
  await tick(); await tick(); await tick();
  assert.equal(p.view(), "ready", "still loading: no verdict");
  broken = false;
  status = "complete";
  for (const fn of p.listeners.updated) fn(111, { status: "complete" });
  await tick(); await tick(); await tick();
  assert.equal(p.view(), "ready");
  assert.equal(p.$("targetSelect").options.length, 4);
  p.dom.window.close();
});

test("unavailable: a viewable page without the executor is treated as needing a reload", async () => {
  const p = makePanel({ plan: twoFill, snapshotError: () => true, scriptedSnapshot: true });
  await tick(); await tick(); await tick();
  assert.equal(p.view(), "unavailable");
  assert.equal(p.$("btnReloadPage").hidden, false);
  p.dom.window.close();
});

test("unavailable: a held action outranks the unavailable view", async () => {
  const p = makePanel({ plan: twoFill, snapshotError: () => true, scriptedSnapshot: true });
  answer(p, "SEEYABLE_GET_PENDING_CONFIRMATION", () => ({ ok: true, confirmation: { ...heldResponse("2099-01-01T00:00:00.000Z").confirmation, documentSessionId: "doc-A" } }));
  await tick(); await tick(); await tick(); await tick();
  assert.equal(p.view(), "gate");
  p.dom.window.close();
});

test("navigation: a finished load binds the shown tab once, and leaves other tabs alone", async () => {
  const p = makePanel({ plan: twoFill });
  await tick(); await tick();
  const count = () => p.calls.send.filter((m) => m.type === "SEEYABLE_SNAPSHOT_DOM").length;
  const before = count();
  for (const fn of p.listeners.updated) fn(111, { status: "complete" });
  await tick(); await tick();
  assert.equal(count(), before, "already bound: nothing to do");
  for (const fn of p.listeners.updated) fn(999, { status: "complete" });
  await tick(); await tick();
  assert.equal(count(), before, "a background tab is ignored");
  for (const fn of p.listeners.updated) fn(111, { status: "loading" });
  await tick();
  for (const fn of p.listeners.updated) fn(111, { status: "complete" });
  await tick(); await tick(); await tick();
  assert.equal(count(), before + 1, "a reload binds the fresh page");
  assert.match(p.$("status").textContent, /^Found \d+ controls/, "the reload notice does not linger when nothing was lost");
  p.dom.window.close();
});

/* --- Slice 3: where Stop and Undo sit, one test per row of the decision --- */
const before = (p, a, b) => Boolean(p.$(a).compareDocumentPosition(p.$(b)) & 4);
const pinned = (p) => p.$("safetySlotPinned").contains(p.$("btnStopExec"));
const onOtherScreens = (p) => pinned(p) && !p.$("screens").contains(p.$("btnStopExec"));

test("placement: idle with no agent sits below the listen button, on Assist only", async () => {
  const p = makePanel({ plan: twoFill });
  await tick(); await tick();
  assert.equal(p.view(), "ready");
  assert.equal(p.doc.body.dataset.safety, "inline");
  assert.ok(p.$("safetySlotIdle").contains(p.$("btnStopExec")));
  assert.equal(p.$("btnUndo").hidden, false);
  assert.ok(before(p, "btnListen", "btnStopExec"), "below the listen button");
  assert.ok(before(p, "btnStopExec", "btnUndo"), "Tab reaches Stop then Undo");
  assert.ok(before(p, "btnUndo", "commandInput"), "and then the request input");
  for (const name of ["Targets", "Activity", "Settings"]) {
    p.doc.querySelector(`.screen-nav [data-screen="${name}"]`).click();
    await tick();
    assert.ok(p.$("screenAssist").hidden && p.$("screenAssist").contains(p.$("btnStopExec")), `${name}: not shown`);
  }
  p.dom.window.close();
});

test("placement: while talking with nothing running, Stop is hidden and Done talking and Cancel remain", async () => {
  const rec = makeRecognitionClass();
  const p = makePanel({ plan: twoFill, recognition: rec });
  await tick(); await tick();
  assert.equal(p.$("btnStopExec").textContent, "Stop actions");
  p.$("btnListen").click();
  await tick();
  rec.instances[0].fireStart();
  await tick();
  assert.equal(p.view(), "listening");
  assert.equal(p.$("btnStopExec").hidden, true);
  assert.equal(p.$("btnUndo").hidden, true);
  assert.equal(p.$("safetyControls").hidden, true, "nothing is left pinned");
  assert.equal(p.$("btnStopListen").disabled, false, "Done talking works");
  assert.equal(p.$("btnCancelListen").disabled, false, "Cancel works");
  p.$("btnCancelListen").click();
  await tick(); await tick();
  assert.equal(p.$("btnStopExec").hidden, false, "Stop returns when talking ends");
  assert.equal(p.$("btnUndo").hidden, false, "and so does Undo");
  assert.equal(p.$("safetyControls").hidden, false);
  p.dom.window.close();
});

test("placement: a command running while the microphone winds down shows Stop at once, and it works", async () => {
  const rec = makeRecognitionClass();
  let release;
  const gate = new Promise((r) => { release = r; });
  const p = makePanel({ plan: twoFill, recognition: rec, onExecute: async () => { await gate; return verified; } });
  await tick(); await tick();
  p.$("btnListen").click();
  await tick();
  rec.instances[0].fireStart();
  await tick();
  rec.instances[0].fireFinal("fill Full name with Ada");
  await tick(); await tick();
  assert.equal(p.calls.execute, 1, "the command is running");
  assert.equal(p.view(), "listening", "the microphone has not closed yet");
  assert.equal(p.$("btnStopExec").hidden, false, "Stop is available during the action");
  assert.equal(p.$("safetyControls").hidden, false);
  assert.equal(p.$("btnUndo").hidden, false);
  assert.equal(p.$("btnUndo").disabled, true, "Undo shows but waits while acting");
  assert.ok(onOtherScreens(p));
  p.$("btnStopExec").click();
  await tick();
  assert.ok(p.calls.send.some((m) => m.type === "SEEYABLE_GATE_CONTROL" && m.command === "stop"));
  release();
  rec.instances[0].fireEnd();
  await tick(); await tick(); await tick();
  p.dom.window.close();
});

test("placement: with Undo hidden while talking, saying undo that still reaches undo", async () => {
  const rec = makeRecognitionClass();
  let undos = 0;
  const p = makePanel({ plan: twoFill, recognition: rec, undo: () => { undos += 1; return { ok: false, error: { code: "NOTHING_TO_UNDO", message: "There is no change to undo." } }; } });
  await tick(); await tick();
  p.$("btnListen").click();
  await tick();
  rec.instances[0].fireStart();
  await tick();
  assert.equal(p.$("btnUndo").hidden, true);
  rec.instances[0].fireFinal("undo that");
  rec.instances[0].fireEnd();
  await tick(); await tick(); await tick();
  assert.equal(undos, 1);
  assert.equal(p.calls.fetch, 0);
  p.dom.window.close();
});

test("placement: with an agent connected, Stop stays pinned while talking", async () => {
  const rec = makeRecognitionClass();
  const p = makePanel({ plan: twoFill, recognition: rec, sessionExtra: { bridgeWanted: true } });
  await tick(); await tick();
  p.$("btnListen").click();
  await tick();
  rec.instances[0].fireStart();
  await tick();
  assert.equal(p.view(), "listening");
  assert.equal(p.$("btnStopExec").hidden, false);
  assert.ok(onOtherScreens(p));
  assert.equal(p.$("btnUndo").hidden, true);
  p.dom.window.close();
});

test("placement: planning and acting pin Stop on every screen, Undo disabled; Stop still works from there", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const p = makePanel({ plan: fills("el-1", "el-7"), onExecute: async () => { await gate; return verified; } });
  await tick(); await tick();
  await typed(p, "please do these things in order");
  p.$("btnApprovePlan").click();
  await tick(); await tick();
  assert.equal(p.view(), "acting");
  assert.ok(onOtherScreens(p));
  assert.equal(p.$("btnUndo").disabled, true);
  p.doc.querySelector('.screen-nav [data-screen="Settings"]').click();
  await tick();
  assert.equal(p.$("screenSettings").hidden, false);
  assert.ok(onOtherScreens(p), "still reachable on Settings");
  p.$("btnStopExec").click();
  await tick();
  assert.ok(p.calls.send.some((m) => m.type === "SEEYABLE_GATE_CONTROL" && m.command === "stop"));
  release();
  await tick(); await tick(); await tick();
  assert.equal(p.view(), "stopped");
  p.dom.window.close();
});

test("placement: plan review sits below the plan controls and above the voice prompt", async () => {
  const p = makePanel({ plan: twoFill });
  await tick(); await tick();
  await typed(p, "please do these things in order");
  assert.equal(p.view(), "plan");
  assert.ok(p.$("planBox").contains(p.$("btnStopExec")));
  assert.ok(before(p, "btnCancelPlan", "btnStopExec"));
  assert.ok(before(p, "btnUndo", "btnTalkPlan"));
  p.dom.window.close();
});

test("placement: edit and which-one choices keep Stop pinned", async () => {
  const p = makePanel({ plan: twoFill });
  await tick(); await tick();
  await typed(p, "please do these things in order");
  p.$("btnEditPlan").click();
  await tick();
  assert.equal(p.view(), "edit");
  assert.ok(onOtherScreens(p));
  p.dom.window.close();
  const q = makePanel({ plan: twoFill, elements: [el("el-1", "Twin"), el("el-2", "Twin")] });
  await tick(); await tick();
  await typed(q, "fill Twin with x");
  assert.equal(q.view(), "repair");
  assert.ok(onOtherScreens(q));
  q.dom.window.close();
});

test("placement: Done puts Undo by the result, Stop below it, on Assist only", async () => {
  const p = makePanel({ plan: fills("el-1", "el-7") });
  await tick(); await tick();
  await runPlan(p);
  assert.equal(p.view(), "done");
  assert.ok(p.$("resultBox").contains(p.$("btnUndo")));
  assert.ok(before(p, "resultUndoNote", "btnUndo"), "the note explains the button that follows");
  assert.ok(before(p, "btnUndo", "btnStopExec"), "Tab reaches Undo before Stop");
  assert.ok(before(p, "btnStopExec", "btnNewRequest"));
  assert.equal(p.doc.body.dataset.safety, "inline");
  p.dom.window.close();
});

test("placement: Stopped makes Resume the card's main action, with no Undo and a header chip elsewhere", async () => {
  const p = makePanel({ plan: twoFill });
  await tick(); await tick();
  p.$("btnStopExec").focus();
  p.$("btnStopExec").click();
  await tick(); await tick();
  assert.equal(p.view(), "stopped");
  assert.equal(p.$("btnStopExec").textContent, "Resume");
  assert.ok(p.$("safetySlotHero").contains(p.$("btnStopExec")));
  assert.ok(before(p, "heroCopy", "btnStopExec"));
  assert.ok(before(p, "btnStopExec", "btnListen"), "Resume comes first");
  assert.equal(p.$("btnUndo").hidden, true, "the executor refuses Undo while stopped");
  assert.equal(p.doc.activeElement, p.$("btnStopExec"), "focus follows the moved button");
  p.doc.querySelector('.screen-nav [data-screen="Settings"]').click();
  await tick();
  assert.equal(p.$("stateChip").textContent, "Stopped", "the header says so on other screens");
  assert.ok(!p.$("screens").contains(p.$("stateChip")));
  p.doc.querySelector('.screen-nav [data-screen="Assist"]').click();
  await tick();
  p.$("btnStopExec").click();
  await tick(); await tick();
  assert.equal(p.view(), "ready");
  assert.equal(p.$("btnStopExec").textContent, "Stop actions");
  assert.equal(p.$("btnUndo").hidden, false);
  assert.ok(p.$("safetySlotIdle").contains(p.$("btnStopExec")));
  p.dom.window.close();
});

test("placement: an agent on the bridge pins Stop in every state with no Undo, and Disconnect restores it live", async () => {
  const p = makePanel({ plan: fills("el-1", "el-7"), sessionExtra: { bridgeWanted: true } });
  await tick(); await tick();
  assert.ok(onOtherScreens(p), "ready");
  assert.equal(p.$("btnUndo").hidden, true);
  await typed(p, "please do these things in order");
  assert.equal(p.view(), "plan");
  assert.ok(onOtherScreens(p), "plan");
  p.$("btnApprovePlan").click();
  await tick(); await tick(); await tick(); await tick();
  assert.equal(p.view(), "done");
  assert.ok(onOtherScreens(p), "done");
  assert.equal(p.$("btnUndo").hidden, true);
  p.$("btnStopExec").click();
  await tick(); await tick();
  assert.equal(p.view(), "stopped");
  assert.ok(onOtherScreens(p), "stopped: Resume stays pinned");
  p.$("btnStopExec").click();
  await tick(); await tick();
  for (const fn of p.listeners.storage) fn({ bridgeWanted: {} }, "session");
  await tick();
  assert.ok(p.$("safetySlotIdle").contains(p.$("btnStopExec")), "Disconnect moves it back");
  assert.equal(p.$("btnUndo").hidden, false);
  for (const fn of p.listeners.storage) fn({ bridgeWanted: { newValue: true } }, "session");
  await tick();
  assert.ok(onOtherScreens(p), "Connect pins it at once");
  p.dom.window.close();
});

test("placement: an agent's hold keeps Stop pinned, and it stays usable with no Undo", async () => {
  const p = makePanel({ plan: twoFill, sessionExtra: { bridgeWanted: true } });
  answer(p, "SEEYABLE_GET_PENDING_CONFIRMATION", () => ({ ok: true, confirmation: { ...heldResponse("2099-01-01T00:00:00.000Z").confirmation, documentSessionId: "doc-A" } }));
  await tick(); await tick(); await tick();
  assert.equal(p.view(), "gate");
  assert.ok(onOtherScreens(p));
  assert.equal(p.$("btnUndo").hidden, true);
  p.dom.window.close();
});

test("placement: until the bridge state is known, Stop is pinned", async () => {
  const p = makePanel({ plan: twoFill });
  assert.ok(onOtherScreens(p), "before the first read answers");
  assert.equal(p.$("btnUndo").hidden, true);
  await tick();
  assert.ok(!pinned(p), "then it moves to the task");
  p.dom.window.close();
});

test("placement: unavailable page keeps Stop and Undo with the card, and a focused button that leaves view hands focus to the nav", async () => {
  const p = makePanel({ plan: twoFill, snapshotError: () => true, tabsGet: (id) => ({ id, url: "chrome://newtab/", status: "complete" }) });
  await tick(); await tick(); await tick();
  assert.equal(p.view(), "unavailable");
  assert.ok(p.$("safetySlotIdle").contains(p.$("btnStopExec")));
  assert.equal(p.$("btnUndo").hidden, false);
  p.dom.window.close();

  let release;
  const gate = new Promise((r) => { release = r; });
  const q = makePanel({ plan: fills("el-7"), onExecute: async () => { await gate; return verified; } });
  await tick(); await tick();
  await typed(q, "please do these things in order");
  q.$("btnApprovePlan").click();
  await tick(); await tick();
  q.doc.querySelector('.screen-nav [data-screen="Settings"]').click();
  await tick();
  q.$("btnStopExec").focus();
  release();
  await tick(); await tick(); await tick(); await tick();
  assert.equal(q.view(), "done");
  assert.equal(q.$("screenAssist").hidden, true);
  assert.equal(q.doc.activeElement.dataset.screen, "Settings", "focus is not lost when the button leaves this screen");
  q.dom.window.close();
});

/* --- Slice 4: plan review layout, header, Stopped, smaller fixes --- */
test("plan review: says nothing changed once, shows the request, and bolds targets with number dots", async () => {
  const p = makePanel({ plan: twoFill });
  await tick(); await tick();
  await typed(p, "put Grace in the name and bio");
  assert.equal(p.view(), "plan");
  assert.match(p.$("planTitle").textContent, /nothing changed/);
  assert.equal(p.$("planIntro").textContent, "2 steps, in order");
  assert.equal(p.$("stateChip").textContent, "Review");
  assert.match(p.$("status").textContent, /Nothing has changed/, "screen readers still hear the outcome");
  assert.equal(p.doc.body.dataset.statusQuiet, "true", "and it is not shown a second time");
  assert.equal(p.$("planFrom").hidden, false);
  assert.equal(p.$("planFromText").textContent, "“put Grace in the name and bio”");
  const rows = [...p.$("planSteps").children];
  assert.equal(rows[0].querySelector("strong").textContent, "“Full name”");
  assert.equal(rows[0].querySelector(".no").textContent, "1");
  assert.equal(rows[1].querySelector(".no").textContent, "7");
  assert.match(rows[1].querySelector(".tx").textContent, /^Fill “Short bio” with “Scientist”$/);
  assert.equal(p.doc.activeElement, p.$("planTitle"), "focus is on the title, never Approve");
  assert.ok(p.$("planBox").querySelector(".say-more"), "voice help is folded");
  assert.equal(p.$("planBox").querySelector(".say-more").open, false);
  assert.match(p.$("planBox").querySelector(".say-more").textContent, /Approve plan/);
  assert.ok(!p.$("planBox").querySelector(".say-more").contains(p.$("btnTalkPlan")), "the talk button stays out");
  p.$("btnCancelPlan").click();
  await tick();
  assert.equal(p.$("planFrom").hidden, true);
  assert.equal(p.$("planFromText").textContent, "", "the words do not linger");
  p.dom.window.close();
});

test("plan review: a status with more to say stays visible", async () => {
  const p = makePanel({ plan: twoFill });
  await tick(); await tick();
  await typed(p, "please do these things in order");
  assert.equal(p.doc.body.dataset.statusQuiet, "true");
  await typed(p, "something else entirely please");
  assert.match(p.$("status").textContent, /^The earlier plan was discarded/);
  assert.equal(p.doc.body.dataset.statusQuiet, "false", "the discarded plan is reported on screen");
  await typed(p, "go ahead with this somehow approved maybe");
  p.dom.window.close();

  const q = makePanel({ plan: twoFill });
  await tick(); await tick();
  await typed(q, "please do these things in order");
  q.$("btnEditPlan").click();
  await tick();
  q.$("planEditInput").value = "a different request";
  q.$("btnSubmitEdit").click();
  await tick(); await tick(); await tick();
  assert.equal(q.view(), "plan");
  assert.equal(q.doc.body.dataset.statusQuiet, "false", "an edited plan's status stays visible");
  q.dom.window.close();
});

test("plan review: a protected step hides the request, so a spoken secret is never echoed", async () => {
  const secret = [el("el-1", "Full name"), el("el-2", "Password", { state: { redacted: true } })];
  const p = makePanel({ elements: secret, plan: () => ({ version: "seeyable-plan-1", outcome: "steps", steps: [{ action: "fill", elementId: "el-2", value: "hunter2" }] }) });
  await tick(); await tick();
  await typed(p, "my password is hunter2 so please enter it");
  assert.equal(p.view(), "plan");
  assert.equal(p.$("planFrom").hidden, true);
  assert.ok(!p.$("planBox").textContent.includes("hunter2"));
  p.dom.window.close();
});

test("plan review: request and names are data, and a value equal to the name does not move the bold", async () => {
  const p = makePanel({
    elements: [el("el-1", "<i>Name</i>"), el("el-2", "Role", { role: "combobox", tag: "select", state: { options: [{ value: "Role", label: "Role" }] } })],
    plan: () => ({ version: "seeyable-plan-1", outcome: "steps", steps: [
      { action: "fill", elementId: "el-1", value: "x" },
      { action: "select", elementId: "el-2", value: "Role" },
    ] }),
  });
  await tick(); await tick();
  await typed(p, "<b>bold</b> request please now");
  assert.equal(p.$("planFromText").querySelector("b"), null);
  assert.match(p.$("planFromText").textContent, /<b>bold<\/b>/);
  const rows = [...p.$("planSteps").children];
  assert.equal(rows[0].querySelector("i"), null);
  const tx = rows[1].querySelector(".tx");
  assert.equal(tx.textContent, "Choose “Role” in “Role”");
  assert.ok(tx.innerHTML.endsWith("<strong>“Role”</strong>"), "the target is the last quoted part");
  p.dom.window.close();
});

test("plan review: a step that will ask for approval keeps its note", async () => {
  const p = makePanel({ plan: () => ({ version: "seeyable-plan-1", outcome: "steps", steps: [{ action: "click", elementId: "el-20" }] }) });
  await tick(); await tick();
  await typed(p, "please send in the survey now");
  const row = p.$("planSteps").children[0];
  assert.match(row.querySelector(".step-note").textContent, /stop and ask for its own approval/);
  assert.ok(row.classList.contains("is-risky"));
  p.dom.window.close();
});

test("header: the chip and mode follow the view", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const p = makePanel({ plan: fills("el-1", "el-7"), onExecute: async () => { await gate; return verified; } });
  await tick(); await tick();
  assert.equal(p.$("stateChip").textContent, "Ready");
  await typed(p, "please do these things in order");
  p.$("btnApprovePlan").click();
  await tick(); await tick();
  assert.equal(p.view(), "acting");
  assert.match(p.$("stateChip").textContent, /Acting/);
  assert.equal(p.$("modeLabel").textContent, "~working");
  release();
  await tick(); await tick(); await tick(); await tick();
  assert.equal(p.view(), "done");
  assert.match(p.$("stateChip").textContent, /Done/, "Done, not Ready, after a verified plan");
  assert.equal(p.$("stateChip").className, "chip is-success");
  p.$("btnNewRequest").click();
  await tick();
  assert.equal(p.$("stateChip").textContent, "Ready", "and it does not outlast the Done view");
  p.dom.window.close();

  const q = makePanel({ plan: twoFill, elements: [el("el-1", "Twin"), el("el-2", "Twin")] });
  await tick(); await tick();
  await typed(q, "fill Twin with x");
  assert.equal(q.view(), "repair");
  assert.equal(q.$("stateChip").textContent, "Your choice", "never Ready while a choice waits");
  q.dom.window.close();

  const r = makePanel({ plan: twoFill });
  await tick(); await tick();
  await typed(r, "please do these things in order");
  r.$("btnEditPlan").click();
  await tick();
  assert.equal(r.view(), "edit");
  assert.equal(r.$("stateChip").textContent, "Editing");
  r.dom.window.close();
});

test("header: planning reads Working, not Acting, because nothing is touching the page", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const p = makePanel({ plan: twoFill });
  const fetchOriginal = p.win.fetch;
  p.win.fetch = async (...args) => { await gate; return fetchOriginal(...args); };
  await tick(); await tick();
  p.$("commandInput").value = "please do these things in order";
  p.$("btnSendCommand").click();
  await tick(); await tick();
  assert.equal(p.view(), "working");
  assert.match(p.$("stateChip").textContent, /Working/);
  assert.equal(p.$("modeLabel").textContent, "~working");
  assert.equal(p.$("voiceState").textContent, "Voice: idle.", "a typed request is not a voice event");
  release();
  await tick(); await tick(); await tick();
  p.dom.window.close();
});

test("voice line: says acting for spoken commands only", async () => {
  const rec = makeRecognitionClass();
  let release;
  const gate = new Promise((r) => { release = r; });
  const p = makePanel({ plan: twoFill, recognition: rec, onExecute: async () => { await gate; return verified; } });
  await tick(); await tick();
  p.$("btnListen").click();
  await tick();
  rec.instances[0].fireStart();
  await tick();
  rec.instances[0].fireFinal("fill Full name with Ada");
  await tick();
  assert.match(p.$("voiceState").textContent, /^Voice: acting/);
  release();
  rec.instances[0].fireEnd();
  await tick(); await tick(); await tick();
  assert.equal(p.$("voiceState").textContent, "Voice: idle.");
  p.dom.window.close();
});

test("stopped: the card carries the message, and screen readers still get the rest", async () => {
  const p = makePanel({ plan: twoFill, onExecute: () => heldResponse("2099-01-01T00:00:00.000Z") });
  await tick(); await tick();
  await typed(p, "click Submit survey");
  p.$("btnStopExec").click();
  await tick(); await tick();
  assert.equal(p.view(), "stopped");
  assert.match(p.$("gateStatus").textContent, /stopped/);
  assert.equal(p.$("gateStatus").getAttribute("role"), "status");
  assert.match(p.$("confirmStatus").textContent, /revoked/);
  const css = read("../sidepanel.css");
  assert.match(css, /^\.gate-status:not\(\.error\) \{/m, "shown only when Stop or Resume failed");
  assert.match(css, /body\[data-view="stopped"\] #confirmStatus \{/);
  p.dom.window.close();
});

test("smaller fixes: no input while working; marks are separate; leftover labels are gone", async () => {
  const css = read("../sidepanel.css");
  assert.match(css, /body\[data-view="working"\] \.request-label, body\[data-view="acting"\] \.request-label \{ display: none; \}/);
  const page = read("../sidepanel.html");
  assert.doesNotMatch(page, /Stop\/Pause/);
  assert.doesNotMatch(page, /local spike/);
  assert.doesNotMatch(page, /voiceProviderNote/, "one voice note, not two");
  const p = makePanel({ plan: twoFill, elements: [el("el-1", "Full name", { state: { disabled: true } })] });
  await tick(); await tick();
  const row = p.$("targetList").querySelector("button");
  assert.equal(row.querySelector(".target-mark").textContent, "(disabled)");
  assert.match(row.textContent, /^1 · Full name \(disabled\)$/);
  p.dom.window.close();
});

test("smaller fixes: a required asterisk leaves display text only, and matching still works", async () => {
  const p = makePanel({ plan: fills("el-1"), elements: [el("el-1", "Full name *")] });
  await tick(); await tick();
  assert.equal(p.$("tryChips").querySelector("button").textContent, "Fill Full name with Ada");
  assert.doesNotMatch(p.$("targetList").textContent, /\*/);
  await runPlan(p);
  assert.equal(p.$("btnUndo").textContent, "Undo Full name");
  const snapshotCall = p.calls.send.find((m) => m.type === "SEEYABLE_EXECUTE_ACTION");
  assert.equal(snapshotCall.request.elementId, "el-1");
  p.dom.window.close();
  const q = makePanel({ plan: twoFill, elements: [el("el-1", "Full name *")] });
  await tick(); await tick();
  await typed(q, "fill Full name with Ada");
  assert.equal(q.calls.execute, 1, "the resolver still finds the real field");
  assert.equal(q.calls.fetch, 0);
  q.dom.window.close();
});

test("tab change while feedback is playing: speech stops, with no false alarm and no hidden loss", async () => {
  const makeSpeech = () => {
    const spoken = [];
    let cancels = 0;
    class Utterance { constructor(text) { this.text = text; } }
    return { spoken, cancels: () => cancels, Utterance, synth: { speak(u) { spoken.push(u.text); }, cancel() { cancels += 1; } } };
  };
  // Nothing to lose: speech just stops and no red line appears.
  const speech = makeSpeech();
  const rec = makeRecognitionClass();
  const p = makePanel({ plan: twoFill, recognition: rec, speech, onExecute: async () => verified });
  await tick(); await tick();
  p.$("btnListen").click();
  await tick();
  rec.instances[0].fireStart();
  rec.instances[0].fireFinal("fill Full name with Ada");
  rec.instances[0].fireEnd();
  await tick(); await tick(); await tick();
  assert.ok(speech.spoken.length > 0, "feedback really played");
  const cancelsBefore = speech.cancels();
  for (const fn of p.listeners.activated) fn({ tabId: 222 });
  await tick(); await tick(); await tick();
  assert.ok(speech.cancels() > cancelsBefore, "speech stopped");
  assert.ok(!p.$("status").classList.contains("error"), "no red line for speech alone");
  assert.doesNotMatch(p.$("status").textContent, /discarded/);
  p.dom.window.close();

  // A plan under review is lost by the switch: that must still be reported.
  const speech2 = makeSpeech();
  const rec2 = makeRecognitionClass();
  const q = makePanel({ plan: twoFill, recognition: rec2, speech: speech2 });
  await tick(); await tick();
  q.$("btnListen").click();
  await tick();
  rec2.instances[0].fireStart();
  rec2.instances[0].fireFinal("put Grace Hopper in Full name and Pilot in Short bio");
  rec2.instances[0].fireEnd();
  await tick(); await tick(); await tick();
  assert.equal(q.view(), "plan");
  assert.ok(speech2.spoken.length > 0, "the plan was read out");
  for (const fn of q.listeners.activated) fn({ tabId: 222 });
  await tick(); await tick(); await tick();
  assert.notEqual(q.view(), "plan", "the old tab's plan is gone");
  assert.match(q.$("status").textContent, /Active tab changed/, "and the loss is reported");
  q.dom.window.close();
});

/* --- Slice 5: page mark and manifest --- */
const markOf = (p) => ({
  letter: p.$("pageInitial").textContent,
  shown: !p.$("pageFavicon").hidden && p.$("pageMark").classList.contains("has-icon"),
  src: p.$("pageFavicon").getAttribute("src"),
});
const fire = (p, type) => p.$("pageFavicon").dispatchEvent(new p.win.Event(type));

test("page mark: the letter comes from the title, then the host, and is never page markup", async () => {
  for (const [tab, letter] of [
    [{ id: 111, title: "demo survey" }, "D"],
    [{ id: 111, title: "— Émile's page" }, "É"],
    [{ id: 111, title: "" , url: "https://www.example.org/x" }, "E"],
    [{ id: 111, title: "<b>x</b>" }, "B"],
    [{ id: 111, title: "🙂" }, ""],
  ]) {
    const p = makePanel({ plan: twoFill, activeTabs: () => [tab] });
    await tick(); await tick();
    assert.equal(markOf(p).letter, letter, JSON.stringify(tab));
    assert.equal(p.$("pageMark").querySelector("b"), null);
    p.dom.window.close();
  }
});

test("page mark: an icon shows only once it has loaded, and a broken one leaves the letter", async () => {
  let icon = "https://site.example/a.png";
  const p = makePanel({ plan: twoFill, activeTabs: () => [{ id: 111, title: "Site", favIconUrl: icon }] });
  await tick(); await tick();
  assert.equal(markOf(p).src, icon);
  assert.equal(markOf(p).shown, false, "no broken image while loading");
  fire(p, "load");
  assert.equal(markOf(p).shown, true);
  // A refresh with the same URL does not reset or flash it.
  for (const fn of p.listeners.updated) fn(111, { title: "Site 2" });
  await tick(); await tick();
  assert.equal(markOf(p).shown, true);
  // A new icon replaces it, and it can arrive after the page's first update.
  icon = "https://site.example/b.png";
  for (const fn of p.listeners.updated) fn(111, { favIconUrl: icon });
  await tick(); await tick();
  assert.equal(markOf(p).src, icon);
  assert.equal(markOf(p).shown, false);
  fire(p, "error");
  assert.equal(markOf(p).shown, false);
  assert.equal(markOf(p).letter, "S");
  const settled = p.calls.send.length;
  for (const fn of p.listeners.updated) fn(111, { title: "Site 3" });
  await tick(); await tick();
  assert.equal(markOf(p).src, icon, "a known broken icon is not retried on every refresh");
  assert.equal(p.calls.send.length, settled, "the icon never touches page messaging");
  p.dom.window.close();
});

test("page mark: a tab without an icon drops the last tab's icon, and a late load cannot bring it back", async () => {
  let tab = { id: 111, title: "Site", favIconUrl: "https://site.example/a.png" };
  const p = makePanel({ plan: twoFill, activeTabs: () => [tab] });
  await tick(); await tick();
  fire(p, "load");
  tab = { id: 222, title: "Other" };
  for (const fn of p.listeners.activated) fn({ tabId: 222 });
  await tick(); await tick(); await tick();
  assert.deepEqual(markOf(p), { letter: "O", shown: false, src: null });
  fire(p, "load");
  assert.equal(markOf(p).shown, false, "the old icon's late load is ignored");
  p.dom.window.close();
});

test("page mark: only web and inline image icons load, without a referrer", async () => {
  for (const [url, ok] of [
    ["https://a.example/i.ico", true], ["http://127.0.0.1:1/i.png", true], ["data:image/png;base64,AA", true],
    ["chrome://theme/icon", false], ["file:///etc/passwd", false], ["javascript:alert(1)", false],
    ["data:text/html,<script>1</script>", false], [" ", false], [42, false],
  ]) {
    const p = makePanel({ plan: twoFill, activeTabs: () => [{ id: 111, title: "Site", favIconUrl: url }] });
    await tick(); await tick();
    assert.equal(markOf(p).src, ok ? url : null, String(url));
    assert.equal(p.$("pageFavicon").getAttribute("referrerpolicy"), "no-referrer");
    assert.equal(p.$("pageFavicon").getAttribute("alt"), "");
    p.dom.window.close();
  }
});

test("manifest: the description fits Chrome's limit, says what ships, and adds no permissions", () => {
  const manifest = JSON.parse(read("../manifest.json"));
  assert.ok(manifest.description.length <= 132, String(manifest.description.length));
  assert.match(manifest.description, /voice/);
  assert.match(manifest.description, /approval/);
  assert.deepEqual(manifest.permissions, ["activeTab", "scripting", "sidePanel", "storage", "tabs"]);
  assert.deepEqual(manifest.host_permissions, ["http://127.0.0.1:6123/*", "http://127.0.0.1:6124/*"]);
});
