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
const scripts = ["../lib/voice-commands.js", "../lib/command-resolver.js", "../lib/plan-schema.js", "../lib/planner.js", "../lib/overlay.js", "../sidepanel.js"].map(read);

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

function makePanel({ onExecute, plan, executeGate, recognition, undo } = {}) {
  const dom = new JSDOM(html, { url: "chrome-extension://test/sidepanel.html", runScripts: "dangerously", pretendToBeVisual: true });
  const win = dom.window;
  const calls = { send: [], execute: 0, fetch: 0 };
  const listeners = { activated: [], updated: [] };
  win.console = { info: () => {}, warn: () => {}, error: () => {} };
  if (recognition) win.SpeechRecognition = recognition.FakeRecognition;
  win.fetch = async (_url, init) => {
    calls.fetch += 1;
    const body = JSON.parse(init.body);
    return { json: async () => ({ ok: true, plan: plan(body), repaired: false, documentSessionId: body.snapshot.documentSessionId, revision: body.snapshot.revision }) };
  };
  const session = { plannerToken: "t", plannerPort: 6124 };
  win.chrome = {
    tabs: {
      query: async () => [{ id: 111, title: "Demo survey" }],
      sendMessage: async (tabId, msg) => {
        calls.send.push(msg);
        if (msg.type === "SEEYABLE_SNAPSHOT_DOM") return { ok: true, snapshot: snap(base) };
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
      onActivated: { addListener: (fn) => listeners.activated.push(fn) },
      onUpdated: { addListener: (fn) => listeners.updated.push(fn) },
    },
    scripting: { executeScript: async () => [{ result: null }] },
    runtime: { sendMessage: async () => ({ ok: false }), getURL: (p) => `chrome-extension://test/${p}` },
    permissions: { contains: async () => false },
    storage: { local: { get: async () => ({}), set: async () => {} }, session: { get: async (k) => Object.fromEntries([].concat(k).map((x) => [x, session[x]])), set: async () => {}, remove: async () => {} } },
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
    assert.ok(!p.$("screens").contains(p.$("btnStopExec")), "Stop is reachable on every screen");
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
  assert.ok(!p.$("screens").contains(p.$("btnStopExec")), "the safety bar is outside the scrolling card area");
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
