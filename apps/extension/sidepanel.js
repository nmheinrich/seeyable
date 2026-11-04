"use strict";
/* Side panel controller — manual test harness.
 *
 * State ownership: execution is bound to one captured tab ID plus the
 * displayed snapshot's documentSessionId/revision. Every operation
 * captures its tab at start; tab switches, navigation, or generation
 * changes invalidate the selection and discard late responses. The
 * panel never implements page actions itself — it only calls the
 * content-script contracts (snapshot, overlay, highlight, executor).
 */

const $ = (id) => document.getElementById(id);
let lastJson = "{}";
let lastKind = null;

const state = {
  boundTabId: null,
  snapshot: null,       // displayed snapshot the user reviewed
  executorReady: false, // snapshot arrived through the content-script handler
  pending: false,       // execution (incl. post-action refresh) in flight
  acquiring: false,     // snapshot acquisition (initial/refresh/Show tags) in flight
  generation: 0,        // bumped on tab/document invalidation
  opSeq: 0,             // latest snapshot-acquisition operation
  opTabId: null,        // tab owning the in-flight acquisition, even pre-bind
  confirmation: null,   // held confirmation challenge (Feature #11), if any
};

/* Panel logic reads these flags, never display text, so wording can change
 * without changing behaviour. */
const VOICE_IDLE = "Voice: idle.";
const TRANSCRIPT_EMPTY = "Transcript: \u2014";
let statusWrites = 0;          // bumped by every setStatus
let statusIsError = false;
let voiceMessageQuiet = true;  // the voice line says nothing beyond idle
let transcriptEmpty = true;
let lastExecVerified = false;  // the latest execution result was verified
let statusAboutHold = false;   // the status line was written while an action was held
let statusFromOtherTab = false; // an error written before the active tab changed
let statusRepeatsPlan = false; // the status only repeats what the plan card says
let refocusInput = false;      // a request was sent from the input, which hides while working
let plannerRecovery = false;   // the last request needs the planner proxy: show the recovery card
let pageUnavailable = null;    // { kind: "restricted" | "reload", tabId } when this page cannot be operated
// Unknown counts as wanted: an agent may act on the page, so the panel must
// not name a target for Undo until it knows no bridge is in use.
let agentBridgeWanted = true;

function setStatus(text, isError, opts = {}) {
  const el = $("status");
  el.textContent = text;
  el.classList.toggle("error", Boolean(isError));
  statusWrites += 1;
  statusIsError = Boolean(isError);
  statusAboutHold = Boolean(state.confirmation);
  statusFromOtherTab = false;
  statusRepeatsPlan = Boolean(opts.repeatsPlan);
  console.info("[seeyable panel]", text);
  renderState();
}
function setExecStatus(text, isError) {
  const el = $("execStatus");
  el.textContent = text;
  el.classList.toggle("error", Boolean(isError));
  renderState();
}
// Host and path only: full URLs can be long and can carry sensitive query
// values. The complete URL stays in the snapshot JSON.
function pageLocation(url) {
  try { const u = new URL(url); return `${u.host}${u.pathname}`; } catch { return url || ""; }
}
function showJson(obj, metaText) {
  lastJson = JSON.stringify(obj, null, 2);
  $("output").textContent = lastJson;
  $("meta").textContent = metaText || "";
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function refreshTabInfo() {
  try {
    const tab = await activeTab();
    // Do not depend on tab.url/title being exposed; snapshot metadata is
    // the execution-relevant identity, this line is informational only.
    const label = tab && tab.title ? tab.title : tab ? "Current page" : "—";
    const bound = state.boundTabId !== null && tab && tab.id !== state.boundTabId ? " (execution bound to another tab)" : "";
    $("tabInfo").textContent = tab ? `${label}${bound}` : "—";
    renderPageMark(tab);
  } catch { /* panel may open before tabs settle */ }
}

/* --- Page mark: the site's own icon, or its first letter ------------------
 * Decoration only, from data the tabs permission already gives. The icon URL
 * is page-controlled, so it only ever reaches an <img>: no scripts run, and
 * other schemes (chrome:, file:, javascript:) fall back to the letter. */
function pageInitial(title, url) {
  const firstOf = (text) => {
    const found = String(text || "").match(/[\p{L}\p{N}]/u);
    return found ? found[0].toLocaleUpperCase() : "";
  };
  let host = "";
  try { host = new URL(url).hostname.replace(/^www\./, ""); } catch { /* no usable URL */ }
  return firstOf(title) || firstOf(host);
}
function usableFavicon(url) {
  return typeof url === "string" && /^(https?:|data:image\/)/i.test(url) ? url : "";
}
let wantedFavicon = "";
function renderPageMark(tab) {
  $("pageInitial").textContent = tab ? pageInitial(tab.title, tab.url) : "";
  const url = usableFavicon(tab && tab.favIconUrl);
  if (url === wantedFavicon) return; // already shown, loading, or known broken
  wantedFavicon = url;
  const img = $("pageFavicon");
  img.hidden = true;
  $("pageMark").classList.remove("has-icon");
  if (url) img.src = url;
  else img.removeAttribute("src");
}
$("pageFavicon").addEventListener("load", () => {
  // A slower icon from the previous tab must not land on this one.
  if (!wantedFavicon || $("pageFavicon").getAttribute("src") !== wantedFavicon) return;
  $("pageFavicon").hidden = false;
  $("pageMark").classList.add("has-icon");
});

/* --- Snapshot acquisition -------------------------------------------------
 * Primary path is the declared content script. The scripting fallback can
 * produce a viewable snapshot without the full message handler; such a
 * snapshot is marked executor-not-ready and is never used for execution. */
async function fetchSnapshot(tabId) {
  let contentError = null;
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: "SEEYABLE_SNAPSHOT_DOM" });
    if (res && res.ok) return { snapshot: res.snapshot, viaContentScript: true };
    if (res && !res.ok) throw new Error(res.error);
    throw new Error("Empty response from content script.");
  } catch (err) {
    contentError = err;
  }
  const missingReceiver = /Receiving end does not exist|Could not establish connection/i.test(contentError.message || "");
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => (typeof globalThis.__seeyable_snapshotDOM === "function" ? globalThis.__seeyable_snapshotDOM() : null),
    });
    if (result) return { snapshot: result, viaContentScript: false, contentError };
    await chrome.scripting.executeScript({ target: { tabId }, files: ["lib/snapshot-dom.js"] });
    const [{ result: second }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => globalThis.__seeyable_snapshotDOM(),
    });
    if (!second) throw new Error("DOM snapshot returned nothing via scripting injection.");
    return { snapshot: second, viaContentScript: false, contentError };
  } catch (scriptingError) {
    throw new Error(
      missingReceiver
        ? "The page has no Seeyable content-script connection (it may predate the extension load). Reload the tab, then reopen the panel. Snapshot and execution are unavailable until then."
        : `Cannot access contents of the page. Content script: ${contentError.message}. Scripting fallback: ${scriptingError.message}. Reload the tab and make sure it is a normal http(s) page.`
    );
  }
}

function numberFromId(id) {
  const m = /^el-(\d+)$/.exec(String(id || ""));
  return m ? m[1] : "?";
}

// Word-first labels share the overlay's display builder (lib/overlay.js):
// snapshot names minus display-only annotations, question context for
// duplicates, never values. The panel never invents labels.
function shortLabel(element, elements) {
  if (typeof globalThis.__seeyable_buildTagLabel === "function") {
    return globalThis.__seeyable_buildTagLabel(element, elements, { short: true }).text;
  }
  return (element.name || "").trim() || `${element.role || "control"} ${numberFromId(element.id)}`;
}
function fullLabel(element, elements) {
  if (typeof globalThis.__seeyable_buildTagLabel === "function") {
    return globalThis.__seeyable_buildTagLabel(element, elements, { full: true }).text;
  }
  const name = (element.name || "").trim() || `${element.role || "control"} ${numberFromId(element.id)}`;
  return element.question ? `${element.question} · ${name}` : name;
}

// Targets-list presentation state. The list is a view over the already
// bound snapshot (same session/revision/tab as manual execution) — never
// a second registry. unplacedIds mirrors the overlay's omit-no-fit
// report; activeTargetId is the last explicitly highlighted target.
let unplacedIds = new Set();
let activeTargetId = null;

function populateTargets(snapshot, preserveId) {
  const select = $("targetSelect");
  select.replaceChildren();
  // Explicit unselected placeholder: a <select> would otherwise silently
  // select its first option, substituting a target the user never chose.
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = snapshot ? "Select a target" : "Take a snapshot first";
  select.append(placeholder);
  if (!snapshot || !Array.isArray(snapshot.elements) || snapshot.elements.length === 0) {
    select.disabled = true;
    // Empty/invalid snapshots must clear the visible list too — a stale
    // row from a previous tab/document must never stay on screen.
    activeTargetId = null;
    renderTargets();
    updateExecuteEnabled();
    return;
  }
  for (const el of snapshot.elements) {
    const opt = document.createElement("option");
    opt.value = el.id;
    const name = (el.name || "").trim() || el.role || "control";
    const parts = [`${numberFromId(el.id)} · ${name}`];
    if (el.question) parts.push(`— ${el.question}${el.questionCertain ? "" : " ?"}`);
    if (el.state && el.state.disabled) parts.push("(disabled)");
    else if (el.state && el.state.readonly) parts.push("(readonly)");
    opt.textContent = parts.join(" ");
    select.append(opt);
  }
  select.disabled = false;
  // Preserve only the same ID (callers enforce the same-session rule);
  // anything else stays explicitly unselected and Execute stays disabled.
  select.value = preserveId && snapshot.elements.some((e) => e.id === preserveId) ? preserveId : "";
  activeTargetId = null; // a new snapshot invalidates the previous active mark
  renderTargets();
  updateExecuteEnabled();
}

/* --- Screens (Assist / Targets / Activity / Settings) ----------------------
 * Presentation only. The safety bar and nav sit outside the screens, so
 * Stop/Resume and Undo stay visible on every screen. Anything that needs a
 * decision (a plan to review, a choice, a held action) brings Assist back. */
function showScreen(name, opts = {}) {
  for (const screen of ["Assist", "Targets", "Activity", "Settings"]) {
    const el = $(`screen${screen}`);
    if (el) el.hidden = screen !== name;
  }
  for (const btn of document.querySelectorAll(".screen-nav button")) {
    if (btn.dataset.screen === name) btn.setAttribute("aria-current", "page");
    else btn.removeAttribute("aria-current");
  }
  if (name === "Activity" && typeof fetchActionLog === "function") void fetchActionLog();
  if (opts.focus) {
    const heading = { Assist: "commandHeading", Targets: "targetsHeading", Activity: "activityHeading", Settings: "settingsHeading" }[name];
    const el = $(heading);
    if (el && typeof el.focus === "function") el.focus();
  }
}
for (const btn of document.querySelectorAll(".screen-nav button")) {
  btn.addEventListener("click", () => showScreen(btn.dataset.screen, { focus: true }));
}
// Keep scroll padding equal to the safety bar's real height (its labels wrap
// at narrow widths and browser zoom), so the sticky bar never covers the
// control being focused or scrolled to — e.g. the gate's Cancel.
function syncSafetyHeight() {
  const bar = document.querySelector(".safety");
  if (bar) document.documentElement.style.setProperty("--safety-h", `${Math.ceil(bar.getBoundingClientRect().height)}px`);
}
{
  const bar = document.querySelector(".safety");
  if (bar && typeof ResizeObserver === "function") new ResizeObserver(syncSafetyHeight).observe(bar);
  window.addEventListener("resize", syncSafetyHeight);
  syncSafetyHeight();
}
// Discovery shortcut in the Ready view: open Targets and focus its heading.
{
  const viewBtn = $("btnViewTargets");
  if (viewBtn) viewBtn.addEventListener("click", () => showScreen("Targets", { focus: true }));
}

function targetMarks(element) {
  const marks = [];
  if (element.state && element.state.disabled) marks.push("(disabled)");
  else if (element.state && element.state.readonly) marks.push("(readonly)");
  if (unplacedIds.has(element.id)) marks.push("Shown in panel");
  if (state.confirmation && state.confirmation.elementId === element.id) marks.push("▲ held");
  return marks;
}

function renderTargets() {
  const list = $("targetList");
  if (!list) return;
  list.replaceChildren();
  const elements = state.snapshot && Array.isArray(state.snapshot.elements) ? state.snapshot.elements : [];
  if (elements.length === 0) {
    const empty = document.createElement("p");
    empty.className = "sub";
    empty.textContent = state.snapshot ? "No interactive controls in this snapshot." : "Take a snapshot in Developer view to see its targets here.";
    list.append(empty);
    return;
  }
  for (const element of elements) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "target";
    button.dataset.targetId = element.id;
    const isActive = element.id === activeTargetId;
    const label = isActive ? fullLabel(element, elements) : shortLabel(element, elements);
    const marks = targetMarks(element);
    button.textContent = `${numberFromId(element.id)} · ${label}`;
    for (const text of marks) {
      const mark = document.createElement("span");
      mark.className = "target-mark";
      mark.textContent = text;
      button.append(" ", mark);
    }
    if (isActive) button.setAttribute("aria-current", "true");
    button.addEventListener("click", () => highlightElementId(element.id));
    list.append(button);
  }
}

function selectedTargetId() {
  return $("targetSelect").value || null;
}

/* --- Product surface (presentation only) -----------------------------------
 * renderState derives the visible status chip and voice phase from the
 * panel's current activity and ownership flags. It never touches
 * ownership, locks, requests, or approval authority. The chip reports
 * activity and availability only: failures stay visible as the
 * persistent, styled, announced message in their own surface, next
 * to a chip that truthfully says the panel is ready for the next
 * command. There is no error pill. */
function renderState() {
  const view = currentView();
  const chip = $("stateChip");
  if (chip) {
    let cls = "";
    let label = "Ready";
    if (state.confirmation) { label = "\u25B2 Held \u2014 nothing sent"; cls = "is-held"; }
    else if (state.pending || commandPending) { label = state.pending || planProgress ? "\u25CF Acting" : "\u25CF Working"; cls = "is-acting"; }
    else if (pendingPlan) { label = "Review"; cls = "is-review"; }
    else if (view === "edit") { label = "Editing"; cls = "is-review"; }
    else if (view === "repair") { label = "Your choice"; cls = "is-review"; }
    else if (state.acquiring) { label = "\u25CF Working"; cls = "is-acting"; }
    else if (voicePhase === "listening") { label = "Listening"; cls = "is-listening"; }
    else if (voicePhase === "starting") { label = "Starting"; cls = "is-listening"; }
    else if (voicePhase === "finishing") { label = "Finishing"; cls = "is-listening"; }
    else if (gateClosed) { label = "Stopped"; cls = "is-error"; }
    else if (pageUnavailable) { label = "Unavailable"; }
    else if (view === "done" || lastExecVerified) { label = "\u25A0 Done"; cls = "is-success"; }
    chip.className = "chip" + (cls ? " " + cls : "");
    chip.textContent = label;
  }
  document.body.dataset.voice = voicePhase === "listening" ? "listening"
    : voicePhase === "starting" || voicePhase === "finishing" ? "finishing" : "idle";
  document.body.dataset.voiceError = voiceErrorUnresolved ? "true" : "false";
  document.body.dataset.voiceMsg = voiceMessageQuiet ? "quiet" : "shown";
  document.body.dataset.transcript = transcriptEmpty ? "empty" : "shown";
  document.body.dataset.view = view;
  document.body.dataset.statusQuiet = statusRepeatsPlan ? "true" : "false";
  document.body.dataset.gate = gateClosed ? "closed" : "open";
  const mode = $("modeLabel");
  if (mode) mode.textContent = VIEW_MODES[view] || "~ready";
  const heroHeading = $("commandHeading");
  if (heroHeading) heroHeading.textContent = voicePhase === "listening" ? "Listening"
    : voicePhase === "finishing" ? "Finishing"
    : view === "stopped" ? "Stopped."
    : view === "working" ? "Working\u2026"
    : view === "unavailable" ? UNAVAILABLE_COPY[pageUnavailable.kind].title
    : "Ready when you are.";
  const heroCopy = $("heroCopy");
  if (heroCopy) heroCopy.textContent = view === "stopped" ? STOPPED_COPY
    : view === "unavailable" ? UNAVAILABLE_COPY[pageUnavailable.kind].copy
    : READY_COPY;
  const recovering = plannerRecovery && view === "ready";
  document.body.dataset.recover = recovering ? "true" : "false";
  $("recoverBox").hidden = !recovering;
  if (recovering) $("recoverCopy").textContent = recoverCopy();
  $("btnReloadPage").hidden = !(view === "unavailable" && pageUnavailable.kind === "reload");
  $("btnUndo").textContent = undoLabel(view);
  renderExamples();
  // The input hides while working; give it back to whoever was typing.
  if (refocusInput && view !== "working" && view !== "acting" && voicePhase === "idle") {
    refocusInput = false;
    if (view === "ready" && (!document.activeElement || document.activeElement === document.body)) $("commandInput").focus();
  }
  const gateTalk = $("gateTalk");
  if (gateTalk) gateTalk.hidden = !state.confirmation;
  renderListenHints();
  renderProgress();
  placeSafety(view);
  if (typeof syncSafetyHeight === "function") syncSafetyHeight();
  if (typeof updateVoiceControls === "function") updateVoiceControls();
}

/* --- Main-card state (presentation only) -----------------------------------
 * One view name derived from state the panel already owns. It decides which
 * parts of the main card show (CSS reads body[data-view]); it never touches
 * ownership, locks, plan binding, or approval authority. */
const READY_COPY = "Say or type what you want done on this page. Plans are shown for review before anything changes, and Submit, Pay, Delete, and Send always stop for your approval.";
const STOPPED_COPY = "Nothing new will run until you resume. Anything waiting for approval was withdrawn, and nothing that was stopped will run again.";
const UNAVAILABLE_COPY = {
  restricted: {
    title: "Seeyable can\u2019t work on this page.",
    copy: "Chrome keeps pages like this one closed to extensions. Switch to a regular web page to continue.",
  },
  reload: {
    title: "This page needs a reload.",
    copy: "Seeyable can\u2019t reach this page yet, usually because it was opened before Seeyable was installed or updated. Reloading connects it, but anything you typed into the page may be lost.",
  },
};
const VIEW_MODES = {
  ready: "~ready", listening: "~listening", plan: "~plan", edit: "~edit", repair: "~you",
  gate: "~you", acting: "~working", working: "~working", done: "~done", stopped: "~stopped",
  unavailable: "~n/a",
};
function currentView() {
  if (state.confirmation) return "gate";
  if (voicePhase !== "idle") return "listening";
  if (pendingPlan) return "plan";
  if ($("planEditBox") && !$("planEditBox").hidden) return "edit";
  if (pendingClarification) return "repair";
  if (state.pending || commandPending) return planProgress ? "acting" : "working";
  if (gateClosed) return "stopped";
  if (pageUnavailable) return "unavailable";
  if (lastRun) return "done";
  return "ready";
}

/* Where Stop and Undo sit. Nothing can run in the idle views, so there they
 * stay with the task on Assist and leave the other screens alone. Anything in
 * progress, and any agent on the bridge (it can act at any moment), pins Stop
 * on every screen. Undo is not offered with an agent connected, because it
 * could reverse the agent's change, nor while Stopped, where the executor
 * refuses it. Only the place changes: same buttons, handlers and gate. */
function safetyPlacement(view) {
  if (agentBridgeWanted) return { slot: "Pinned", undo: false };
  switch (view) {
    case "ready":
    case "unavailable": return { slot: "Idle", undo: true };
    case "plan": return { slot: "Plan", undo: true };
    case "gate": return { slot: "Gate", undo: true };
    case "done": return { slot: "Result", undo: true, undoFirst: true };
    case "stopped": return { slot: "Hero", undo: false };
    // While talking, "Done talking" and Cancel own the moment; Stop reads like
    // a third way to finish and Undo would discard the speech. Hidden only if
    // nothing is running: a command can already be in flight while the
    // microphone winds down. Saying "undo that" still works.
    case "listening": {
      const running = state.pending || commandPending;
      return { slot: "Pinned", undo: running, stop: running };
    }
    default: return { slot: "Pinned", undo: true }; // listening, edit, repair, working, acting
  }
}
function placeSafety(view) {
  const { slot, undo, undoFirst, stop = true } = safetyPlacement(view);
  const controls = $("safetyControls");
  const stopBtn = $("btnStopExec");
  const undoBtn = $("btnUndo");
  const target = $(`safetySlot${slot}`);
  const first = undoFirst ? undoBtn : stopBtn;
  document.body.dataset.safety = slot === "Pinned" ? "pinned" : "inline";
  undoBtn.hidden = !undo;
  stopBtn.hidden = !stop;
  controls.hidden = !stop && !undo;
  if (controls.parentElement === target && controls.firstElementChild === first) return;
  // Moving an element drops its focus; keep keyboard users where they were.
  const focused = controls.contains(document.activeElement) ? document.activeElement : null;
  target.append(controls);
  controls.prepend(first);
  if (!focused) return;
  if (!focused.hidden && !focused.disabled && !target.closest("[hidden]")) focused.focus();
  else {
    const current = document.querySelector('.screen-nav [aria-current="page"]');
    if (current) current.focus();
  }
}

/* Step progress for the Acting card and the Completed list. Labels come
 * from the validated plan and the reviewed snapshot (the same words the
 * review showed); they live only in this view and are never logged. */
let planProgress = null; // { steps: [{ text, el, risky }], index }
let lastRun = null;      // { steps: [{ text, el, action, name, changed }] } after a verified plan

/* Undo wording. The executor reverses only its last recorded change, and a
 * verified no-op leaves the earlier record in place, so a target is named
 * only when the plan's last step really changed that target. An agent on the
 * bridge can act at any time, so its presence keeps the wording generic.
 * Presentation only: the executor still decides what can be undone. */
const UNDO_GENERIC = "Undo last change";
const UNDO_NOTE_GENERIC = "Undo restores the last change only. Clicks, and anything the page did in response, are not reversed.";
const REVERSIBLE_STEPS = new Set(["fill", "select", "check", "uncheck"]);
const UNDO_NAME_MAX = 28;
function lastStepIfReversible() {
  const last = lastRun && !agentBridgeWanted ? lastRun.steps[lastRun.steps.length - 1] : null;
  return last && last.changed && REVERSIBLE_STEPS.has(last.action) ? last : null;
}
function undoLabel(view) {
  const last = view === "done" ? lastStepIfReversible() : null;
  return last && last.name.length <= UNDO_NAME_MAX ? `Undo ${last.name}` : UNDO_GENERIC;
}
function undoNote(steps) {
  if (agentBridgeWanted) return UNDO_NOTE_GENERIC;
  const last = steps[steps.length - 1];
  if (last.action === "click") {
    return steps.length === 1
      ? "This was a click, so it can\u2019t be undone from here."
      : "This ended with a click, so these changes can\u2019t be undone from here.";
  }
  if (!lastStepIfReversible()) return UNDO_NOTE_GENERIC;
  const others = [...new Set(steps.slice(0, -1).map((step) => step.name))].filter((name) => name !== last.name);
  if (others.length === 0) return `Undo puts ${last.name} back as it was.`;
  if (others.length === 1) return `Undo reverts ${last.name} only. ${others[0]} stays as it is.`;
  if (others.length === 2) return `Undo reverts ${last.name} only. ${others[0]} and ${others[1]} stay as they are.`;
  return `Undo reverts ${last.name} only. The other ${others.length} changes stay as they are.`;
}

/* Try chips and the input hint, built from a real field on this page. The
 * example is offered only if the on-device resolver would pick that exact
 * field, so it works without the planner. Page names are data: they reach
 * the DOM through textContent and the placeholder property only. Chips fill
 * the input and never send. */
const DEFAULT_PLACEHOLDER = "e.g. Fill in this form";
const EXAMPLE_NAME_MAX = 24;
const NOT_A_NAME_FIELD = /e-?mail|phone|tel\b|date|url|website|number|zip|postcode|amount|search|\bpin\b/i;
let exampleCache = { snapshot: undefined, command: null };
function exampleFillCommand() {
  const snapshot = state.snapshot;
  if (exampleCache.snapshot === snapshot) return exampleCache.command;
  let command = null;
  const api = globalThis.SeeyableCommands;
  const elements = snapshot && state.executorReady && Array.isArray(snapshot.elements) ? snapshot.elements : [];
  if (api) {
    for (const el of elements) {
      const st = (el && el.state) || {};
      if (!el || el.role !== "textbox" || st.disabled || st.readonly || st.redacted || st.value) continue;
      const name = String(el.name || "").replace(/[\s*]+$/, "").trim();
      if (!name || name.length > EXAMPLE_NAME_MAX || NOT_A_NAME_FIELD.test(name)) continue;
      const candidate = `Fill ${name} with Ada`;
      const parsed = api.parseLocalCommand(candidate);
      if (!parsed || parsed.kind !== "fill") continue;
      const matched = api.matchTarget(elements, parsed.target);
      if (matched.status === "match" && matched.element.id === el.id) { command = candidate; break; }
    }
  }
  exampleCache = { snapshot, command };
  return command;
}
let renderedExamples = null;
function renderExamples() {
  const fill = exampleFillCommand();
  const tags = $("tagsChip").getAttribute("aria-pressed") === "true" ? "Hide tags" : "Show tags";
  const key = `${fill}|${tags}`;
  if (key === renderedExamples) return;
  renderedExamples = key;
  $("commandInput").placeholder = fill || DEFAULT_PLACEHOLDER;
  $("tryChips").replaceChildren(...[fill, tags].filter(Boolean).map((text) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "try-chip";
    chip.textContent = text;
    chip.addEventListener("click", () => {
      $("commandInput").value = text;
      $("commandInput").focus();
    });
    return chip;
  }));
}
function recoverCopy() {
  const fill = exampleFillCommand();
  const example = fill ? `\u201C${fill.charAt(0).toLowerCase()}${fill.slice(1)}\u201D` : "\u201Cshow tags\u201D";
  return `Simple commands like ${example} work now. Longer requests need the planner proxy: start it, then paste its pairing token in Developer view.`;
}

/* Step states on the page's word tags (acting / done / held), sent as one
 * complete picture to the bound tab over the trusted-panel route. "done"
 * is only ever sent for steps the executor verified. Best effort: a
 * missing receiver never affects execution. */
let tagStates = {};
function sendTagStates(next, target) {
  tagStates = { ...next };
  const tabId = target ? target.tabId : state.boundTabId;
  const session = target ? target.session : state.snapshot && state.snapshot.documentSessionId;
  if (tabId === null || tabId === undefined || !session) return;
  try {
    const sent = chrome.tabs.sendMessage(tabId, { type: "SEEYABLE_TAG_STATE", documentSessionId: session, states: tagStates });
    if (sent && typeof sent.catch === "function") sent.catch(() => {});
  } catch { /* the page may not have the content script; presentation only */ }
}
// The target stands out in a step's words. All of it is page or request data,
// so it reaches the DOM as text only. In "Choose “x” in “Name”" the target is
// the last quoted part, and a value may repeat the name.
function fillStepText(tx, item) {
  const quoted = item.target ? `\u201C${item.target}\u201D` : "";
  const at = !quoted ? -1 : item.targetLast ? item.text.lastIndexOf(quoted) : item.text.indexOf(quoted);
  if (at < 0) { tx.textContent = item.text; return; }
  const strong = document.createElement("strong");
  strong.textContent = quoted;
  tx.append(item.text.slice(0, at), strong, item.text.slice(at + quoted.length));
}
function stepItem(item, status) {
  const li = document.createElement("li");
  const gl = document.createElement("span");
  gl.className = "gl";
  gl.setAttribute("aria-hidden", "true");
  gl.textContent = status === "done" ? "\u25A0" : status === "now" ? "\u25CF" : item.risky ? "\u25B2" : "\u25CB";
  const tx = document.createElement("span");
  tx.className = "tx";
  fillStepText(tx, item);
  if (item.note) {
    const planNote = document.createElement("span");
    planNote.className = "step-note";
    planNote.textContent = item.note;
    tx.append(planNote);
  }
  if (status === "next") {
    const note = document.createElement("span");
    note.className = "step-note";
    note.textContent = "next";
    tx.append(note);
  }
  const no = document.createElement("span");
  no.className = "no";
  no.textContent = numberFromId(item.el);
  no.setAttribute("aria-label", `target ${numberFromId(item.el)}`);
  li.className = status === "done" ? "is-done" : status === "now" ? "is-now" : item.risky ? "is-risky" : "";
  const sr = document.createElement("span");
  sr.className = "sr-only";
  sr.textContent = status === "done" ? "Done: " : status === "now" ? "Now: " : "";
  li.append(gl, sr, tx, no);
  return li;
}
function renderProgress() {
  const box = $("progressBox");
  if (!box) return;
  const show = Boolean(planProgress) && (state.pending || commandPending);
  box.hidden = !show;
  if (show) {
    const { steps, index } = planProgress;
    const at = Math.min(index, steps.length - 1);
    $("progressLabel").textContent = `\u25CF ACTING \u00B7 ${at + 1} OF ${steps.length}`;
    $("progressNow").textContent = steps[at].text;
    const list = $("progressSteps");
    list.replaceChildren(...steps.map((item, i) => stepItem(item, i < index ? "done" : i === index ? "now" : i === index + 1 ? "next" : "")));
  }
  const result = $("resultBox");
  if (!result) return;
  const showResult = Boolean(lastRun) && currentView() === "done";
  result.hidden = !showResult;
  if (showResult) {
    const n = lastRun.steps.length;
    $("resultTitle").textContent = `${n} change${n === 1 ? "" : "s"} made.`;
    $("resultSteps").replaceChildren(...lastRun.steps.map((item) => stepItem(item, "done")));
    $("resultUndoNote").textContent = undoNote(lastRun.steps);
  }
}

// Phrases that fit what is on screen while the microphone is live.
function renderListenHints() {
  const box = $("listenHints");
  if (!box) return;
  const live = voicePhase !== "idle";
  let label = "";
  let phrases = [];
  if (live && state.confirmation) { label = "For the held action, say"; phrases = ["Approve this action"]; }
  else if (live && pendingPlan) { label = "For the plan, say"; phrases = ["Approve plan", "Cancel plan", "Edit plan: \u2026your new request"]; }
  else if (live && lastRun) { label = "You can say"; phrases = ["Undo last change", "\u2026or a new request"]; }
  box.hidden = phrases.length === 0;
  if (phrases.length === 0) return;
  $("listenHintsLabel").textContent = label;
  $("listenHintsList").replaceChildren(...phrases.map((text, i) => {
    const li = document.createElement("li");
    if (i === 0) li.className = "main";
    li.textContent = `\u201C${text}\u201D`;
    return li;
  }));
}

function updateValueEnabled() {
  const action = $("actionSelect").value;
  $("valueInput").disabled = !(action === "fill" || action === "select") || state.pending;
}
function updateExecuteEnabled() {
  // A plan waiting for review blocks conflicting manual execution; the
  // review controls themselves need only the operation locks released.
  const ready = Boolean(state.snapshot && state.executorReady && !state.pending && !state.acquiring && !commandPending && !state.confirmation && !pendingPlan && selectedTargetId());
  $("btnExecute").disabled = !ready;
  $("targetSelect").disabled = state.pending || commandPending || Boolean(state.confirmation) || !state.snapshot;
  $("actionSelect").disabled = state.pending || commandPending || Boolean(state.confirmation);
  const approveBtn = $("btnApproveOnce");
  if (approveBtn) approveBtn.disabled = !state.confirmation || state.pending;
  const cancelBtn = $("btnCancelChallenge");
  if (cancelBtn) cancelBtn.disabled = !state.confirmation || state.pending;
  const reviewLocked = state.pending || state.acquiring || commandPending;
  for (const id of ["btnApprovePlan", "btnEditPlan", "btnCancelPlan"]) {
    const btn = $(id);
    if (btn) btn.disabled = !pendingPlan || reviewLocked;
  }
  for (const id of ["btnSubmitEdit", "btnDiscardEdit"]) {
    const btn = $(id);
    if (btn) btn.disabled = reviewLocked;
  }
  if ($("planEditInput")) $("planEditInput").disabled = commandPending;
  // Conflicting snapshot/binding operations stay locked through the
  // post-action refresh, not just until the executor responds.
  for (const id of ["btnDom", "btnRefresh", "btnShowTags", "btnHideTags", "btnHighlight", "btnCdp"]) {
    const btn = $(id);
    if (btn) btn.disabled = state.pending || commandPending;
  }
  // Targets-list highlighting shares the highlight lock exactly.
  const listLocked = state.pending || state.acquiring || commandPending;
  for (const item of document.querySelectorAll("#targetList .target")) {
    item.disabled = listLocked;
  }
  updateValueEnabled();
  if (typeof updateVoiceControls === "function") updateVoiceControls();
  renderState();
}

function bindSnapshot(tabId, snapshot, viaContentScript) {
  const previousId = selectedTargetId();
  const previousSession = state.snapshot ? state.snapshot.documentSessionId : null;
  const preserveId = previousSession && snapshot.documentSessionId === previousSession ? previousId : null;
  state.boundTabId = tabId;
  state.snapshot = snapshot;
  state.executorReady = viaContentScript;
  unplacedIds = new Set(); // a new binding invalidates the previous float report
  populateTargets(snapshot, preserveId);
  renderPageLine();
  if (selectedTargetId() !== preserveId) $("valueInput").value = "";
  // A hold placed by the MCP tools while the panel was elsewhere is
  // picked up when this tab's snapshot binds. Deferred one microtask so
  // the acquiring lock that wraps binding has cleared first.
  queueMicrotask(() => { void adoptPendingConfirmation(tabId); });
}

// Page identity from data already in hand (no new permissions): the
// tab title on the bold line, and domain plus control count from the
// bound snapshot on the meta line. Unbound shows the honest empty state.
function renderPageLine() {
  const meta = $("pageMeta");
  if (!meta) return;
  const snapshot = state.snapshot;
  if (snapshot && snapshot.url) {
    try {
      const domain = new URL(snapshot.url).hostname || snapshot.url;
      const count = Array.isArray(snapshot.elements) ? snapshot.elements.length : snapshot.elementCount;
      meta.textContent = `${domain} · ${count} controls`;
      return;
    } catch { /* fall through to the empty state */ }
  }
  meta.textContent = pageUnavailable ? "Seeyable can\u2019t reach this page" : "No snapshot yet";
}

function invalidateExecution(reason) {
  if (Object.keys(tagStates).length && state.boundTabId !== null && state.snapshot) {
    sendTagStates({}, { tabId: state.boundTabId, session: state.snapshot.documentSessionId });
  }
  state.generation += 1;
  cancelVoiceInteraction();
  clearClarification();
  setTagsChip("unknown");
  planProgress = null;
  lastRun = null;
  plannerRecovery = false;
  if (state.confirmation) {
    const held = state.confirmation;
    try {
      const sent = chrome.tabs.sendMessage(held.tabId, { type: "SEEYABLE_CANCEL_CHALLENGE", challengeId: held.challengeId });
      if (sent && typeof sent.catch === "function") sent.catch(() => {});
    } catch { /* the document is gone; its challenges died with it */ }
    clearConfirmation("The pending confirmation was discarded because the tab or document changed. If its action had already been dispatched to the page, it may still have taken effect; verify page state before continuing.", true, { restoreFocus: false });
  }
  pageUnavailable = null;
  state.opTabId = null;
  state.snapshot = null;
  state.executorReady = false;
  state.boundTabId = null;
  unplacedIds = new Set();
  activeTargetId = null;
  $("valueInput").value = "";
  populateTargets(null, null);
  renderPageLine();
  if (reason) setStatus(reason, true);
  updateExecuteEnabled();
}

/* --- Automatic snapshot acquisition (panel open / tab activation) ---------
 * Opening the panel or switching the active tab automatically binds a
 * fresh production snapshot for that tab, after which the existing
 * bind path discovers any authoritative pending confirmation. This is
 * read-only: it never reloads the page, toggles overlays, calls the
 * model, replays an action, or approves anything, and it preserves tag
 * visibility exactly. Only the LATEST tab intent is retained while an
 * operation owns the panel; lock-release drains revalidate ownership
 * before acquiring. Failures are reported once per intent — no
 * retries, no polling, no new permissions. */
let autoAcquireIntent = null; // { tabId, gen } awaiting automatic acquisition

function requestAutoSnapshot(tabId) {
  if (!Number.isInteger(tabId)) return;
  if (state.boundTabId === tabId && state.snapshot && state.executorReady) { autoAcquireIntent = null; return; }
  // The intent is stamped with the generation that submitted it; a
  // later activation/navigation supersedes it, and the drain refuses
  // to act on a stale stamp.
  autoAcquireIntent = { tabId, gen: state.generation };
  drainAutoAcquire();
}

function drainAutoAcquire() {
  if (autoAcquireIntent === null) return;
  if (autoAcquireIntent.gen !== state.generation) { autoAcquireIntent = null; return; } // superseded intent never acquires
  const tabId = autoAcquireIntent.tabId;
  if (state.boundTabId === tabId && state.snapshot && state.executorReady) { autoAcquireIntent = null; return; }
  if (state.pending || state.acquiring || commandPending || pendingPlan) return; // latest intent retained
  autoAcquireIntent = null;
  // Floating by design; a panel closing mid-acquisition must not turn
  // teardown races into unhandled rejections.
  void takeSnapshot("Loading this page", { auto: true, tabId }).catch(() => {});
}

/* Why this page cannot be operated, from the tab itself. A tab still loading
 * is never called unavailable: the "complete" update acquires again. Only
 * changes what is shown; the executor's own checks are untouched. */
const CLOSED_SCHEMES = /^(chrome|chrome-extension|chrome-search|chrome-untrusted|devtools|edge|about|view-source|file|data):/i;
function isClosedUrl(url) {
  if (CLOSED_SCHEMES.test(url)) return true;
  try {
    const u = new URL(url);
    return u.hostname === "chromewebstore.google.com"
      || (u.hostname === "chrome.google.com" && u.pathname.startsWith("/webstore"));
  } catch { return false; }
}
async function classifyUnavailable(tabId) {
  let tab = null;
  try { tab = await chrome.tabs.get(tabId); } catch { return null; }
  if (!tab) return null;
  const url = tab.url || tab.pendingUrl || "";
  if (url && isClosedUrl(url)) return { kind: "restricted", tabId };
  return tab.status === "complete" ? { kind: "reload", tabId } : null;
}
function applyUnavailable(found) {
  pageUnavailable = found;
  if (found) setTagsChip("off");
  renderPageLine();
  renderState();
}

async function takeSnapshot(originLabel, opts = {}) {
  if (state.pending || state.acquiring || commandPending) {
    // Automatic acquisition that cannot start yet keeps only its latest
    // tab intent; the lock-release drains retry it. Manual clicks keep
    // the existing no-queue behavior.
    if (opts.auto && Number.isInteger(opts.tabId)) autoAcquireIntent = { tabId: opts.tabId, gen: state.generation };
    return;
  }
  // Identity is captured BEFORE any asynchronous work (incl. tab lookup),
  // and ownership is retained until the whole acquisition settles.
  const gen = state.generation;
  const myOp = ++state.opSeq;
  let progressWrite = -1; // the status write holding this acquisition's progress text
  let snapshotTabId = Number.isInteger(opts.tabId) ? opts.tabId : null;
  state.acquiring = true;
  if (Number.isInteger(opts.tabId)) state.opTabId = opts.tabId;
  updateExecuteEnabled();
  try {
    const tab = Number.isInteger(opts.tabId) ? { id: opts.tabId } : await activeTab();
    if (!tab || tab.id === undefined) { setStatus("No active tab.", true); return; }
    if (gen !== state.generation || myOp !== state.opSeq) return;
    state.opTabId = tab.id;
    snapshotTabId = tab.id;
    // Automatic acquisitions are status-quiet about outcomes another
    // operation produced: when an error/discard status already stands,
    // the auto acquisition writes nothing at all (binding state is
    // visible in the targets, chips, and page line); otherwise it
    // writes its progress text and reports only if nothing else has
    // written since. Manual acquisition always reports.
    const quietAuto = Boolean(opts.auto) && statusIsError && !statusFromOtherTab;
    if (!quietAuto) { setStatus(`${originLabel}…`); progressWrite = statusWrites; }
    const statusUntouched = () => !opts.auto || statusWrites === progressWrite;
    const { snapshot, viaContentScript } = await fetchSnapshot(tab.id);
    if (gen !== state.generation || myOp !== state.opSeq) return; // invalidated or superseded
    try {
      bindSnapshot(tab.id, snapshot, viaContentScript);
      if (viaContentScript) applyUnavailable(null);
      lastKind = "dom-aria";
      const fresh = snapshot.fresh === false ? " · STALE" : "";
      showJson(snapshot, `${snapshot.elementCount} elements · rev ${snapshot.revision} · ${(snapshot.semanticHash || "").slice(0, 8)}${fresh} · ${pageLocation(snapshot.url)}`);
      if (!statusUntouched()) {
        // outcome of another operation stands
      } else if (viaContentScript) {
        setStatus(`Found ${snapshot.elementCount} controls on this page.`);
      } else {
        setExecStatus("Snapshot obtained through the scripting fallback; execution is disabled until the tab is reloaded.", true);
        setStatus("Seeyable can see this page but can\u2019t act on it yet. Reload the tab to connect it.", true);
        const found = await classifyUnavailable(tab.id);
        if (gen === state.generation && myOp === state.opSeq) applyUnavailable(found);
      }
    } catch (bindErr) {
      // Automatic acquisition runs unattended: if the panel is closing
      // while it settles, dropping the result quietly is correct.
      if (!opts.auto) throw bindErr;
    }
  } catch (err) {
    if (gen !== state.generation || myOp !== state.opSeq) return;
    // A failed refresh must not leave the previous snapshot execution-ready.
    if (state.snapshot) state.executorReady = false;
    console.error(err);
    const found = snapshotTabId === null ? null : await classifyUnavailable(snapshotTabId);
    if (gen !== state.generation || myOp !== state.opSeq) return;
    applyUnavailable(found);
    if (!opts.auto || statusWrites === progressWrite) {
      try {
        setExecStatus(`DOM snapshot failed: ${err.message || err}`, true);
        setStatus("Could not read this page.", true);
      } catch { if (!opts.auto) throw err; }
    }
  } finally {
    try {
      if (myOp === state.opSeq) {
        state.acquiring = false;
        state.opTabId = null;
      }
      updateExecuteEnabled();
      drainAutoAcquire();
      drainDeferredAdoption();
    } catch (finErr) { if (!opts.auto) throw finErr; }
  }
}

$("btnDom").addEventListener("click", () => takeSnapshot("Running DOM/ARIA snapshot"));
$("btnRefresh").addEventListener("click", () => takeSnapshot("Refreshing snapshot"));

/* --- CDP debug path (unchanged behavior) --- */
async function hasDebuggerPermission() {
  try { return await chrome.permissions.contains({ permissions: ["debugger"] }); }
  catch { return false; }
}

$("btnCdp").addEventListener("click", async () => {
  if (state.pending || state.acquiring || commandPending) { setStatus("Another panel operation is in progress. Wait for it to finish, then try again.", true); return; }
  const granted = await hasDebuggerPermission();
  if (!granted) {
    setStatus("CDP is unavailable in the standard build: it intentionally has no debugger permission. Reload the extension with manifest.debug.json (debug variant) to test the CDP AXTree path. The DOM/ARIA button works as-is.", true);
    return;
  }
  setStatus("Attaching debugger, fetching AXTree…");
  try {
    const res = await chrome.runtime.sendMessage({ type: "SEEYABLE_SNAPSHOT_CDP" });
    if (!res || !res.ok) throw new Error((res && res.error) || "CDP snapshot failed (no response). Is DevTools open on this tab? Close it and retry.");
    const simplifiedAll = globalThis.__seeyable_simplifyAxTree(res.raw);
    const includeIgnored = $("chkIgnored").checked;
    const interactive = globalThis.__seeyable_interactiveOnly(simplifiedAll, { includeIgnored });
    const payload = {
      kind: "cdp-axtree", tab: res.tab, capturedAt: new Date().toISOString(),
      durationMs: res.durationMs, nodeCount: simplifiedAll.length,
      interactiveCount: interactive.length, includeIgnored, nodes: interactive, raw: res.raw,
    };
    lastKind = "cdp-axtree";
    showJson(payload, `${interactive.length} interactive / ${simplifiedAll.length} AX nodes · ${res.durationMs}ms`);
    setStatus(`CDP snapshot done: ${interactive.length} interactive nodes (${simplifiedAll.length} total). Raw tree included under "raw".`);
  } catch (err) {
    console.error(err);
    setStatus(`CDP snapshot failed: ${err.message || err}`, true);
  }
});

/* --- MCP bridge pairing (Issue #28 spike) ----------------------------------
 * The token is transient: it is sent only to the extension's own service
 * worker (which forwards it over the loopback socket), kept in
 * chrome.storage.session, and the input is cleared after pairing. It is
 * never logged, never copied into snapshot output, and never sent to a
 * webpage. */
function setBridgeStatus(text, isError) {
  const el = $("bridgeStatus");
  if (!el) return;
  el.textContent = text;
  el.classList.toggle("error", Boolean(isError));
}
$("btnBridgeConnect").addEventListener("click", async () => {
  const token = $("bridgeToken").value.trim();
  const port = Number($("bridgePort").value.trim());
  if (!token) { setBridgeStatus("Bridge: paste the pairing token the server printed, then connect.", true); return; }
  if (!Number.isInteger(port) || port < 1 || port > 65535) { setBridgeStatus("Bridge: port must be 1–65535.", true); return; }
  setBridgeStatus("Bridge: connecting to 127.0.0.1…");
  try {
    const res = await chrome.runtime.sendMessage({ type: "SEEYABLE_BRIDGE_CONNECT", token, port });
    $("bridgeToken").value = "";
    if (!res || !res.ok) throw new Error((res && res.error) || "No response from the service worker.");
    setBridgeStatus(`Bridge: pairing sent to the service worker on 127.0.0.1:${port}. Ask for status to confirm.`);
  } catch (err) {
    setBridgeStatus(`Bridge: connect failed: ${err.message || err}`, true);
  }
});
$("btnBridgeDisconnect").addEventListener("click", async () => {
  try {
    const res = await chrome.runtime.sendMessage({ type: "SEEYABLE_BRIDGE_DISCONNECT" });
    if (!res || !res.ok) throw new Error((res && res.error) || "No response from the service worker.");
    $("bridgeToken").value = "";
    setBridgeStatus("Bridge: disconnected; pairing token discarded.");
  } catch (err) {
    setBridgeStatus(`Bridge: disconnect failed: ${err.message || err}`, true);
  }
});
$("btnBridgeStatus").addEventListener("click", async () => {
  try {
    const res = await chrome.runtime.sendMessage({ type: "SEEYABLE_BRIDGE_STATUS" });
    if (!res || !res.ok) throw new Error((res && res.error) || "No response from the service worker.");
    setBridgeStatus(res.connected ? `Bridge: connected on 127.0.0.1:${res.port}.` : "Bridge: not connected.", !res.connected);
  } catch (err) {
    setBridgeStatus(`Bridge: status failed: ${err.message || err}`, true);
  }
});

/* --- Planner proxy pairing (Issue #14) -------------------------------------
 * Same transient-token discipline as the bridge: the token is sent only to
 * the loopback proxy as a Bearer credential, kept in chrome.storage.session,
 * and the input is cleared after pairing. It is never logged, never copied
 * into snapshot output, and never sent to a webpage. */
function setPlannerStatus(text, isError) {
  const el = $("plannerStatus");
  if (!el) return;
  el.textContent = text;
  el.classList.toggle("error", Boolean(isError));
}
async function plannerCredentials() {
  const stored = await chrome.storage.session.get(["plannerToken", "plannerPort"]);
  const port = Number(stored.plannerPort || 6124);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { token: "", port: 0, baseUrl: "" };
  }
  return { token: stored.plannerToken || "", port, baseUrl: `http://127.0.0.1:${port}` };
}
$("btnPlannerPair").addEventListener("click", async () => {
  const token = $("plannerToken").value.trim();
  const port = Number($("plannerPort").value.trim());
  if (!token) { setPlannerStatus("Planner: paste the pairing token the proxy printed, then pair.", true); return; }
  if (!Number.isInteger(port) || port < 1 || port > 65535) { setPlannerStatus("Planner: port must be 1–65535.", true); return; }
  try {
    await chrome.storage.session.set({ plannerToken: token, plannerPort: port });
    $("plannerToken").value = "";
    if (recognizer && typeof recognizer.resetMetaUnavailable === "function") recognizer.resetMetaUnavailable();
    setPlannerStatus(`Planner: paired on 127.0.0.1:${port}. Ask for status to confirm the model and key.`);
  } catch (err) {
    setPlannerStatus(`Planner: pairing failed: ${err.message || err}`, true);
  }
});
$("btnPlannerForget").addEventListener("click", async () => {
  try {
    await chrome.storage.session.remove(["plannerToken", "plannerPort"]);
    $("plannerToken").value = "";
    if (recognizer && typeof recognizer.resetMetaUnavailable === "function") recognizer.resetMetaUnavailable();
    setPlannerStatus("Planner: pairing discarded.");
  } catch (err) {
    setPlannerStatus(`Planner: forget failed: ${err.message || err}`, true);
  }
});
$("btnPlannerStatus").addEventListener("click", async () => {
  try {
    const plannerApi = globalThis.SeeyablePlanner;
    if (!plannerApi) throw new Error("Planner support is unavailable in this panel. Reload the extension.");
    const creds = await plannerCredentials();
    const res = await plannerApi.fetchProxyStatus({ baseUrl: creds.baseUrl, token: creds.token });
    const speech = res.speech
      ? ` Speech: ${res.speech.configured ? `configured (${res.speech.state})` : "not configured"}; browser recognition remains the fallback.`
      : " Speech: status unavailable; browser recognition remains the fallback.";
    setPlannerStatus(`Planner: model ${res.model}; API key ${res.keyConfigured ? "configured" : "MISSING — set MODEL_API_KEY for the proxy"}.${speech}`, !res.keyConfigured);
  } catch (err) {
    setPlannerStatus(`Planner: status failed: ${err.message || err}`, true);
  }
});

$("btnCopy").addEventListener("click", async () => {
  await navigator.clipboard.writeText(lastJson);
  setStatus("Copied snapshot JSON to clipboard.");
});
$("btnDownload").addEventListener("click", () => {
  const blob = new Blob([lastJson], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = lastKind ? `seeyable-${lastKind}-snapshot.json` : "seeyable-snapshot.json";
  a.click();
  URL.revokeObjectURL(url);
});
$("btnClear").addEventListener("click", () => { showJson({}, ""); setStatus("Snapshot output cleared."); });

/* --- Overlay controls (bound to the captured tab) --- */
async function sendBound(payload) {
  const tab = state.boundTabId !== null ? { id: state.boundTabId } : await activeTab();
  if (!tab || tab.id === undefined) throw new Error("No tab is bound. Take a snapshot first.");
  return chrome.tabs.sendMessage(tab.id, payload);
}

/* One header toggle replaces the tags chip, the Show/Hide buttons in the
 * main area, and the Try chips. It dispatches the same typed commands, so
 * it shares their locks, ownership, and spoken feedback. "unknown" (after
 * a tab/document change) reads as off: pressing it shows tags. */
function setTagsChip(value) {
  const chip = $("tagsChip");
  if (!chip) return;
  chip.textContent = `Tags: ${value}`;
  chip.setAttribute("aria-pressed", String(value === "on"));
}
$("tagsChip").addEventListener("click", async () => {
  const on = $("tagsChip").getAttribute("aria-pressed") === "true";
  await dispatchCommand(on ? "hide tags" : "show tags", "typed");
});

/* Show tags as a reusable flow: the manual button, typed commands, and
 * voice commands all run this exact code path (same ownership checks,
 * same snapshot acquisition). Returns an outcome object; callers own
 * presentation. Discarded outcomes mean the panel moved on mid-flight. */
async function runShowTags(opts = {}) {
  if (state.pending || state.acquiring || (commandPending && !opts.viaCommand)) {
    return { ok: false, message: "Another panel operation is in progress. Wait for it to finish, then try again." };
  }
  const gen = state.generation;
  const myOp = ++state.opSeq;
  state.acquiring = true;
  updateExecuteEnabled();
  try {
    const tab = await activeTab();
    if (!tab || tab.id === undefined) return { ok: false, message: "No active tab." };
    if (gen !== state.generation || myOp !== state.opSeq) return { ok: false, discarded: true, message: "" };
    state.opTabId = tab.id;
    const res = await chrome.tabs.sendMessage(tab.id, { type: "SEEYABLE_SHOW_TAGS" });
    if (gen !== state.generation || myOp !== state.opSeq) return { ok: false, discarded: true, message: "" };
    if (res && res.ok) {
      if (!state.snapshot) {
        // Tags took their own snapshot; bind execution to the same tab/session.
        // Ownership (opTabId) is retained across this follow-up fetch.
        try {
          const { snapshot, viaContentScript } = await fetchSnapshot(tab.id);
          if (gen !== state.generation || myOp !== state.opSeq) return { ok: false, discarded: true, message: "" };
          bindSnapshot(tab.id, snapshot, viaContentScript);
          showJson(snapshot, `${snapshot.elementCount} elements · rev ${snapshot.revision} · ${pageLocation(snapshot.url)}`);
          lastKind = "dom-aria";
        } catch { /* tags still shown; execution binding stays unset */ }
      }
      // Crowded-out targets (no whitespace for a floating tag) stay
      // discoverable in the Targets list, marked "Shown in panel".
      unplacedIds = new Set(Array.isArray(res.unplaced) ? res.unplaced : []);
      if (gen !== state.generation || myOp !== state.opSeq) return { ok: false, discarded: true, message: "" };
      // Visibility only: placement changes as the page scrolls/resizes
      // and the panel gets no live recount, so a number here would go
      // stale. The toggle states the durable fact (tags on), nothing more.
      setTagsChip("on");
      renderTargets(); // refresh "Shown in panel" marks from this show's report
      if (unplacedIds.size > 0) {
        return { ok: true, message: "Tags shown. Some word tags stay in the panel \u2014 see Targets." };
      }
      return { ok: true, message: "Tags shown." };
    }
    return { ok: false, message: `Show tags failed: ${(res && res.error) || "no response"}` };
  } catch (err) {
    if (gen === state.generation && myOp === state.opSeq) {
      return { ok: false, message: `Show tags failed: ${err.message || err}. Reload the tab if the extension was just reloaded.` };
    }
    return { ok: false, discarded: true, message: "" };
  } finally {
    if (myOp === state.opSeq) {
      state.acquiring = false;
      state.opTabId = null;
    }
    updateExecuteEnabled();
    drainAutoAcquire();
    drainDeferredAdoption();
  }
}

$("btnShowTags").addEventListener("click", async () => {
  const outcome = await runShowTags();
  if (outcome && !outcome.discarded && outcome.message) setStatus(outcome.message, !outcome.ok);
});

async function runHideTags(tabId, opts = {}) {
  if (state.pending || state.acquiring || (commandPending && !opts.viaCommand)) {
    return { ok: false, message: "Another panel operation is in progress. Wait for it to finish, then try again." };
  }
  state.acquiring = true; // shared lock: manual/typed/voice hide excludes other operations
  updateExecuteEnabled();
  try {
    const res = tabId !== undefined && tabId !== null
      ? await chrome.tabs.sendMessage(tabId, { type: "SEEYABLE_HIDE_TAGS" })
      : await sendBound({ type: "SEEYABLE_HIDE_TAGS" });
    if (res && res.ok) {
      setTagsChip("off");
      unplacedIds = new Set();
      renderTargets();
      return { ok: true, message: "Tags hidden. Highlighting by number still works." };
    }
    return { ok: false, message: `Hide tags failed: ${(res && res.error) || "no response"}` };
  } catch (err) {
    return { ok: false, message: `Hide tags failed: ${err.message || err}` };
  } finally {
    state.acquiring = false;
    updateExecuteEnabled();
    drainAutoAcquire();
    drainDeferredAdoption();
  }
}

$("btnHideTags").addEventListener("click", async () => {
  const outcome = await runHideTags();
  setStatus(outcome.message, !outcome.ok);
});

// One highlight flow for the Developer number box and the Targets list:
// the already-bound snapshot's session/revision plus the captured tab.
// No retargeting, no second registry.
// Highlight results are owned: each request captures its tab, document
// session, revision, and panel generation, plus a monotonic highlight
// sequence. A response applies only while all of those still match and
// no newer highlight has been requested — obsolete successes AND
// failures are discarded silently, so a late response from document A
// can never mark or report a different field that reuses el-N in
// document B.
let highlightSeq = 0;

async function highlightElementId(elementId) {
  if (state.pending || state.acquiring || commandPending) { setStatus("Another panel operation is in progress. Wait for it to finish, then try again.", true); return; }
  if (!/^el-\d+$/.test(elementId || "")) { setStatus("Enter a target number from a DOM snapshot (e.g. 22).", true); return; }
  if (!state.snapshot) { setStatus("Take a DOM/ARIA snapshot first so the target session is known.", true); return; }
  const owner = {
    seq: ++highlightSeq,
    tabId: state.boundTabId,
    session: state.snapshot.documentSessionId,
    revision: state.snapshot.revision,
    generation: state.generation,
  };
  const stillOwned = () => owner.seq === highlightSeq
    && state.boundTabId === owner.tabId
    && state.generation === owner.generation
    && Boolean(state.snapshot)
    && state.snapshot.documentSessionId === owner.session
    && state.snapshot.revision === owner.revision;
  let res = null;
  let err = null;
  try {
    res = await chrome.tabs.sendMessage(owner.tabId, {
      type: "SEEYABLE_HIGHLIGHT_ID",
      elementId,
      documentSessionId: owner.session,
      revision: owner.revision,
    });
  } catch (e) { err = e; }
  if (!stillOwned()) return; // obsolete result: discard silently
  if (err) { setStatus(`Highlight failed: ${err.message || err}`, true); return; }
  if (res && res.ok) {
    activeTargetId = elementId; // the target the page is now outlining
    renderTargets();
    const target = state.snapshot.elements.find((e) => e.id === elementId);
    const words = target ? fullLabel(target, state.snapshot.elements) : "";
    setStatus(`Highlighted target ${numberFromId(elementId)}${words ? ` — ${words}` : ""}.`);
  } else setStatus(`Highlight failed: ${(res && res.error) || "no response"}`, true);
}

$("btnHighlight").addEventListener("click", async () => {
  const raw = $("highlightInput").value.trim();
  const num = raw.replace(/^el-/i, "");
  if (!/^\d+$/.test(num)) { setStatus("Enter a target number from a DOM snapshot (e.g. 22).", true); return; }
  await highlightElementId(`el-${num}`);
});

/* --- Voice and typed commands (Features #10, #13) ---------------------------
 * One dispatcher for voice and typed input. Tag commands use the
 * shared show/hide flows; anchored click/fill commands resolve
 * locally (lib/command-resolver.js) and execute through the SAME
 * single-execution pipeline as manual execution — never a second
 * executor. Nothing is stored or logged: transcripts live only in
 * the visible transcript line until replaced or invalidated. */
const voiceApi = globalThis.SeeyableVoice || null;
let commandPending = false;
// Issue #15: the one AI-generated plan waiting for review, or null. It is
// a frozen object bound to its request, tab, document, revision,
// generation, and interaction; review callbacks close over it and do
// nothing once it is no longer the current one.
let pendingPlan = null;
// Remote-confirmation adoption ownership (Issue #19): per-tab lookup
// sequence plus at most one deferred discovery tab. Declared with the
// panel state because preview clearing (which can run early) drains it.
let adoptLookupSeq = 0;
const adoptLookupsInFlight = new Map(); // tabId -> seq
let deferredAdoptTabId = null;
// Voice review authority: what was displayed when the user started the
// current recognition session. Set only by Start listening.
let listenContext = null;
// Presentation-only mirror of the recognition lifecycle. This is the
// single source for microphone/voice phase in renderState — it is set
// only at authoritative transition points (handlers below), never
// inferred from user-facing sentences, so cancellation copy that
// mentions "listening" can never read as a live microphone.
let voicePhase = "idle"; // idle | starting | listening | finishing
// Presentation-only: a recognition error with no recovery yet. Set only
// on the authoritative recognition-error transition; cleared by a new
// start attempt, a live session, cancellation, or a successful command
// outcome. Never inferred from sentence text, so the intentional
// "Voice: idle — … cancelled" message does not trip it.
let voiceErrorUnresolved = false;
let interactionSeq = 0; // bumped whenever a voice/command interaction is invalidated
let voiceTabId = null;
let discardMessage = null; // why the latest interaction was invalidated, if stated
let pendingSpoken = null;  // feedback held until the microphone has terminated
let plannerAbortController = null; // aborts the in-flight planner fetch on invalidation
function abortPlannerFetch() {
  if (plannerAbortController) {
    try { plannerAbortController.abort(); } catch { /* already settled */ }
    plannerAbortController = null;
  }
}

const speechOutput = voiceApi
  ? voiceApi.createSpeechOutput({ speechSynthesis: window.speechSynthesis, SpeechSynthesisUtterance: window.SpeechSynthesisUtterance })
  : null;

function setVoiceState(text, isError) {
  const el = $("voiceState");
  if (!el) return;
  el.textContent = text;
  el.classList.toggle("error", Boolean(isError));
  voiceMessageQuiet = text === VOICE_IDLE;
  renderState();
}
function setTranscript(text) {
  const el = $("voiceTranscript");
  if (el) el.textContent = text === null ? TRANSCRIPT_EMPTY : text;
  transcriptEmpty = text === null;
}

function updateVoiceControls() {
  if (!$("btnListen")) return;
  const recActive = recognizer ? recognizer.isActive() : false;
  const panelBusy = state.pending || state.acquiring;
  $("btnListen").disabled = !recognizer || !recognizer.supported() || recActive || commandPending || panelBusy;
  $("btnStopListen").disabled = !recActive;
  $("btnCancelListen").disabled = !(recActive || commandPending);
  $("btnSendCommand").disabled = commandPending || panelBusy;
  $("commandInput").disabled = commandPending;
  // The tags toggle and Undo dispatch through the same typed flow and lock.
  if ($("tagsChip")) $("tagsChip").disabled = commandPending || panelBusy || Boolean(pageUnavailable);
  if ($("btnUndo")) $("btnUndo").disabled = commandPending || panelBusy;
  // Speak prompts are the same Start control, offered where an answer fits.
  for (const id of ["btnTalkPlan", "btnTalkGate", "btnTalkDone"]) {
    const btn = $(id);
    if (btn) btn.disabled = $("btnListen").disabled;
  }
}

// Spoken feedback is held while recognition is active: synthesis must
// never overlap an open microphone. It is released only when the
// recognition session has terminated (end or error) and only if the
// interaction that produced it is still current.
function speakFeedback(text) {
  if (!speechOutput || !text) return;
  if (recognizer && recognizer.isActive()) {
    pendingSpoken = { text, seq: interactionSeq };
    return;
  }
  speechOutput.say(text);
}
function flushPendingSpoken() {
  if (!pendingSpoken) return;
  if (recognizer && recognizer.isActive()) return;
  const held = pendingSpoken;
  pendingSpoken = null;
  if (held.seq === interactionSeq && speechOutput) speechOutput.say(held.text);
}

const metaVoiceApi = globalThis.SeeyableMetaVoice || null;

// Provider preflight happens before any microphone audio exists. A
// missing pair, missing speech configuration, or known rejected/failed
// upstream state makes this attempt use browser recognition. A status
// transport failure is also pre-capture, so the composite may fall back
// in the same intentional attempt. Once Meta capture begins, failures
// are not replayed into the browser provider.
async function speechProxyConfig() {
  try {
    const plannerApi = globalThis.SeeyablePlanner;
    if (!plannerApi || typeof plannerApi.fetchProxyStatus !== "function") return null;
    const creds = await plannerCredentials();
    if (!creds.token || !creds.baseUrl) return null;
    const status = await plannerApi.fetchProxyStatus({ baseUrl: creds.baseUrl, token: creds.token, timeoutMs: 2500 });
    const speech = status && status.speech;
    if (!speech || !speech.configured || speech.state === "unconfigured" || speech.state === "rejected" || speech.state === "failed") {
      return { eligible: false };
    }
    return {
      eligible: true,
      baseUrl: creds.baseUrl,
      token: creds.token,
      language: (navigator.language || "en-US").split(/[-_]/)[0],
    };
  } catch {
    return null;
  }
}

const recognitionHandlers = {
        onState: ({ state: recState }) => {
          // Any authoritative session transition supersedes a prior
          // recognition-error presentation.
          voiceErrorUnresolved = false;
          if (recState === "listening") {
            voicePhase = "listening";
            setVoiceState("Voice: listening… say one supported command.");
          } else if (!commandPending) {
            voiceTabId = null;
            voicePhase = "idle";
            setVoiceState(VOICE_IDLE);
          }
          updateVoiceControls();
          flushPendingSpoken(); // session ended: microphone is closed
        },
        onInterim: ({ text }) => { setTranscript(`Heard so far: ${text}`); },
        onFinal: ({ text, sessionId }) => {
          if (voiceStopMarkMs !== null) {
            lastFinalTiming = { ms: performance.now() - voiceStopMarkMs };
            voiceStopMarkMs = null;
          }
          setTranscript(text ? `Heard: ${text}` : "Heard: (no speech)");
          voicePhase = "finishing";
          // The one accepted utterance ends the session's purpose:
          // wind recognition down now; feedback waits for its end.
          if (recognizer) recognizer.stop();
          void dispatchCommand(text, "voice", { sessionId });
        },
        onError: ({ message }) => {
          voicePhase = "idle";
          voiceErrorUnresolved = true;
          setVoiceState(`Voice: error — ${message}`, true);
          updateVoiceControls();
          flushPendingSpoken(); // error also terminates the microphone
        },
};

const recognizer = metaVoiceApi && typeof metaVoiceApi.createProviderRecognitionController === "function"
  ? metaVoiceApi.createProviderRecognitionController({ window, handlers: recognitionHandlers, getSpeechConfig: speechProxyConfig })
  : voiceApi
    ? voiceApi.createRecognitionController({ window, handlers: recognitionHandlers })
    : null;

function cancelVoiceInteraction(reason) {
  interactionSeq += 1;
  abortPlannerFetch();
  voicePhase = "idle";
  voiceErrorUnresolved = false; // intentional cancellation is not a recognition failure
  discardMessage = reason || null;
  pendingSpoken = null;
  if (recognizer && recognizer.isActive()) recognizer.cancel();
  if (speechOutput) speechOutput.stop();
  voiceTabId = null;
  listenContext = null;
  pendingCorrection = null; // cached alternatives die with the interaction
  setTranscript(null);
  // A plan waiting for review is a pending command: it dies here too.
  if (discardPlanReview() && !commandPending && reason) {
    setStatus(`Plan discarded — ${reason} Nothing was executed.`, true);
  }
  if (reason) setVoiceState(`Voice: idle — ${reason}`, true);
  if (typeof updateVoiceControls === "function") updateVoiceControls();
}

function presentCommandHelp(prefix) {
  // One authoritative command-error message, announced once: the
  // status surface carries it. The voice area keeps only microphone
  // truth, so typed failures are never duplicated as voice failures.
  const fill = exampleFillCommand();
  const example = fill ? `\u201C${fill.charAt(0).toLowerCase()}${fill.slice(1)}\u201D, ` : "";
  const message = `${prefix}Try \u201Cshow tags\u201D, ${example}or a request.`;
  setStatus(message, true);
  settleVoiceAfterCommand();
}

// After a command completes, the voice area reports only whether the
// microphone is still winding down. Command outcomes — success or
// failure — live in the status surface; recognition errors keep
// their own distinct voice-area presentation via onError.
function settleVoiceAfterCommand() {
  if (recognizer && recognizer.isActive()) {
    voicePhase = "finishing";
    setVoiceState("Voice: finishing — waiting for the microphone to close…");
  } else {
    voicePhase = "idle";
    setVoiceState(VOICE_IDLE);
  }
}

/* --- Local page-action commands (Issue #13) -----------------------------------
 * Typed and voice click/fill commands resolve on-device against the
 * current production snapshot and execute through the SAME pipeline
 * as manual execution (runExecutionPipeline): same request contract,
 * same confirmation controller, same locks, no replay. No planner,
 * no model, no network beyond the tab message channel.
 *
 * Clarification choices are bound to tab, document session, revision,
 * element, generation, interaction sequence, and their own round
 * identity: each choice button closes over its immutable request, and
 * an obsolete callback from a superseded round executes nothing and
 * leaves any newer clarification untouched. Anything newer — another
 * command, a tab/document change, cancellation, Pause/Stop —
 * invalidates them, and a choice never refreshes or substitutes a
 * new target. */
let pendingClarification = null;

function clearClarification() {
  pendingClarification = null;
  const box = $("clarifyBox");
  if (box) box.hidden = true;
  const choices = $("clarifyChoices");
  if (choices) choices.replaceChildren();
}

async function ensureCommandSnapshot(tabId, gen, seq, opts = {}) {
  // Reuse is allowed only under the established freshness contract:
  // a snapshot bound to this exact tab with the executor ready. Plan
  // approval passes { fresh: true }: it must compare the LIVE page with
  // the reviewed state, never a cached copy.
  if (!opts.fresh && state.snapshot && state.boundTabId === tabId && state.executorReady) {
    return { snapshot: state.snapshot };
  }
  const myOp = ++state.opSeq; // supersedes any earlier acquisition
  state.opTabId = tabId;
  try {
    const { snapshot, viaContentScript } = await fetchSnapshot(tabId);
    if (gen !== state.generation || seq !== interactionSeq || myOp !== state.opSeq) {
      return { discarded: true };
    }
    bindSnapshot(tabId, snapshot, viaContentScript);
    showJson(snapshot, `${snapshot.elementCount} elements · rev ${snapshot.revision} · ${pageLocation(snapshot.url)}`);
    lastKind = "dom-aria";
    if (!viaContentScript) {
      return { error: "This page isn\u2019t ready for commands. Reload the tab and send the command again." };
    }
    return { snapshot };
  } catch (err) {
    if (gen !== state.generation || seq !== interactionSeq || myOp !== state.opSeq) return { discarded: true };
    setExecStatus(`Could not read the page: ${err.message || err}`, true);
    return { error: "Could not read this page. Reload the tab and send the command again." };
  } finally {
    if (myOp === state.opSeq) state.opTabId = null;
  }
}

function commandTargetName(element) {
  return (element && (element.name || element.role || element.id)) || "that control";
}

/* Plain words for executor refusals. Raw codes and diffs stay in the
 * Developer view; an unlisted code gets the honest fallback. */
const FAILURE_WORDS = {
  TARGET_DISABLED: "it\u2019s disabled right now",
  TARGET_READONLY: "it\u2019s read-only",
  TARGET_HIDDEN: "it\u2019s hidden right now",
  STALE_TARGET: "it\u2019s no longer on the page",
  UNKNOWN_ID: "it\u2019s no longer on the page",
  STALE_SNAPSHOT: "the page changed first, so I left it alone",
  STALE_REVISION: "the page changed first, so I left it alone",
  SNAPSHOT_BASELINE_REQUIRED: "the page changed first, so I left it alone",
  WRONG_SESSION: "the page changed first, so I left it alone",
  SENSITIVE_FIELD: "passwords and payment details are yours to enter",
  INCOMPATIBLE_TARGET: "that kind of control can\u2019t do this",
  OPTION_NOT_FOUND: "that choice isn\u2019t in the list",
  OPTION_DISABLED: "that choice is disabled",
  VALUE_REQUIRED: "no value was given",
  UNSUPPORTED_MULTISELECT: "lists with several choices aren\u2019t supported yet",
  UNSUPPORTED_RADIO_UNCHECK: "a radio button can\u2019t be cleared on its own",
  EXECUTION_STOPPED: "Seeyable is stopped, so press Resume first",
  EXECUTION_PAUSED: "Seeyable is stopped, so press Resume first",
  EXECUTION_BUSY: "another action is still running",
  EXECUTION_CANCELLED: "it was cancelled",
  DEADLINE_EXPIRED: "the page took too long to respond, so please check it",
  ACTION_FAILED: "something went wrong on the page, so please check it",
  ACTION_NOT_VERIFIED: "I can\u2019t confirm the page responded, so please check it",
};
function failureWords(error) {
  return FAILURE_WORDS[error && error.code] || "something went wrong, so please check the page (details in the Developer view)";
}

function presentPipelineOutcome(action, name, result) {
  // UI-neutral outcome shaping shared by direct and clarified dispatch.
  // Names are labels; fill values never appear in any message or speech.
  const VERBS = {
    click: ["Click", "Clicked"],
    fill: ["Fill", "Filled"],
    select: ["Select", "Selected"],
    check: ["Check", "Checked"],
    uncheck: ["Uncheck", "Unchecked"],
    scroll_to: ["Scroll to", "Scrolled to"],
    read: ["Read", "Read"],
  };
  const [pending, past] = VERBS[action] || ["Run", "Ran"];
  if (result.outcome === "held") {
    // Held means nothing ran yet: never past-tense the action.
    return {
      ok: true,
      message: "Held: waiting for your approval below. Nothing was executed.",
      spoken: "Waiting for your approval.",
      contextOutcome: "held for approval",
    };
  }
  if (result.outcome === "completed") {
    const response = result.response;
    if (!response.ok) {
      return { ok: false, message: `Could not ${action} ${name}: ${failureWords(response.error)}.`, contextOutcome: `failed: ${response.error.code}` };
    }
    if (isConfirmedOutcome(response)) {
      const said = response.result && response.result.alreadyInDesiredState
        ? `${name} was already set that way, so nothing needed changing.`
        : `${past} ${name}. Checked on the page.`;
      return { ok: true, message: said, spoken: `${past} ${name}.`, contextOutcome: "completed" };
    }
    return { ok: true, message: `${past} ${name}. I can\u2019t confirm the page responded, so please check it.`, spoken: "That may not have finished. Check the page.", contextOutcome: "completed unverified" };
  }
  if (result.outcome === "transport") {
    return { ok: false, message: `I lost contact with the page, so I can\u2019t tell whether ${name} changed. Please check it.`, contextOutcome: "transport failure" };
  }
  return { ok: false, message: "The page gave no usable answer, so nothing is confirmed. Please check it.", contextOutcome: "malformed response" };
}

async function runPageActionCommand(local, source, gen, seq) {
  const tab = state.boundTabId !== null ? { id: state.boundTabId } : await activeTab();
  if (gen !== state.generation || seq !== interactionSeq) return { ok: false, discarded: true, message: "" };
  if (!tab || tab.id === undefined) return { ok: false, message: "No active tab." };
  voiceTabId = tab.id;
  const ensured = await ensureCommandSnapshot(tab.id, gen, seq);
  if (ensured.discarded || gen !== state.generation || seq !== interactionSeq) {
    return { ok: false, discarded: true, message: "" };
  }
  if (ensured.error) return { ok: false, message: ensured.error };
  const snapshot = ensured.snapshot;
  const matched = globalThis.SeeyableCommands.matchTarget(snapshot.elements, local.target);
  if (matched.status === "none") {
    return { ok: false, message: `No confident match for “${local.target}”. Nothing was executed.`, contextOutcome: "no match" };
  }
  if (matched.status === "ambiguous") {
    renderClarification(local, matched.candidates, {
      tabId: tab.id, session: snapshot.documentSessionId, revision: snapshot.revision, gen, seq,
    });
    return {
      ok: true, clarify: true,
      message: `“${local.target}” matches ${matched.candidates.length} controls. Choose one — nothing was executed.`,
      spoken: `${matched.candidates.length} matches. Choose one.`,
      contextSummary: `${local.kind} ${local.target}`,
    };
  }
  const request = {
    action: local.kind,
    elementId: matched.element.id,
    documentSessionId: snapshot.documentSessionId,
    revision: snapshot.revision,
    value: local.kind === "fill" ? local.value : undefined,
    // Audit label only, never authority: typed input is a human at the
    // panel ("manual"); transcripts arrive as "voice".
    source: source === "voice" ? "voice" : "manual",
  };
  const result = await runExecutionPipeline(tab.id, request, gen, seq);
  if (gen !== state.generation || seq !== interactionSeq) {
    // Cancelled, superseded, or moved to another document while the
    // executor held the request. The pipeline already revoked any late
    // challenge; the dispatch itself may still have reached the page.
    return { ok: false, discarded: true, message: "", reached: true };
  }
  const presented = presentPipelineOutcome(local.kind, commandTargetName(matched.element), result);
  presented.contextSummary = `${local.kind} ${local.target}`; // parsed structure only; local.value never retained
  return presented;
}

let clarifySeq = 0; // identity for each clarification round; obsolete callbacks stay inert

function renderClarification(local, candidates, binding) {
  clearClarification();
  showScreen("Assist");
  // Each choice button closes over THIS clarification object — its own
  // request, value, and allowed candidate IDs. A newer command replaces
  // pendingClarification, and any callback from the older round then
  // finds its object is no longer current and does nothing: targets
  // and values from different commands can never be combined.
  const clarification = {
    ...binding,
    action: local.kind,
    value: local.value,
    clarId: ++clarifySeq,
    candidateIds: candidates.map((c) => c.elementId),
    candidateLabels: candidates.map((c) => ({ elementId: c.elementId, label: c.label })),
  };
  pendingClarification = clarification;
  $("clarifyPrompt").textContent = `“${local.target}” matches ${candidates.length} controls. Choose one:`;
  const box = $("clarifyChoices");
  for (const candidate of candidates) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = candidate.label;
    button.addEventListener("click", () => runClarifiedChoice(candidate.elementId, clarification));
    box.append(button);
  }
  $("clarifyBox").hidden = false;
}

async function runClarifiedChoice(elementId, clarification) {
  const choice = clarification || pendingClarification;
  if (!choice || choice !== pendingClarification) {
    // Obsolete callback from a superseded clarification round: execute
    // nothing, and leave the newer clarification visible and valid.
    // Only when nothing is pending at all is the round truly expired.
    if (!pendingClarification) {
      setStatus("That choice expired — the tab, document, or command changed. Send the command again.", true);
    }
    return;
  }
  clearClarification();
  if (commandPending || state.pending || state.acquiring) {
    setStatus("Another operation is in progress. Send the command again after it finishes.", true);
    return;
  }
  const snapshot = state.snapshot;
  const valid = choice
    && choice.gen === state.generation
    && choice.seq === interactionSeq
    && snapshot && state.boundTabId === choice.tabId
    && snapshot.documentSessionId === choice.session
    && snapshot.revision === choice.revision
    && Array.isArray(choice.candidateIds) && choice.candidateIds.includes(elementId)
    && Array.isArray(snapshot.elements) && snapshot.elements.some((e) => e && e.id === elementId);
  if (!valid) {
    setStatus("That choice expired — the tab, document, or command changed. Send the command again.", true);
    return;
  }
  const element = snapshot.elements.find((e) => e.id === elementId);
  if (choice.origin === "planner") {
    // A model clarification supplies the action and value; the human
    // picked only the target. Its resolved step is an AI-generated plan
    // like any other, so it enters review instead of executing (#15).
    presentClarifiedPlan(choice, elementId, snapshot);
    return;
  }
  const request = {
    action: choice.action,
    elementId,
    documentSessionId: choice.session,
    revision: choice.revision,
    value: (choice.action === "fill" || choice.action === "select") ? choice.value : undefined,
    source: "manual", // a deliberate panel choice by the human operator
  };
  const gen = state.generation;
  commandPending = true;
  updateExecuteEnabled();
  updateVoiceControls();
  try {
    const result = await runExecutionPipeline(choice.tabId, request, gen, choice.seq);
    if (gen !== state.generation) {
      setStatus("The tab or document changed while the action was running. Its response was discarded; verify page state before acting again.", true);
      return;
    }
    if (choice.seq !== interactionSeq) {
      // Cancelled or superseded while the executor held the request.
      // The pipeline already revoked any late challenge; the dispatch
      // itself may still have reached the page.
      setStatus("The choice was cancelled or superseded while running. Its response was discarded; it may already have reached the page, so check page state before continuing.", true);
      return;
    }
    const presented = presentPipelineOutcome(choice.action, commandTargetName(element), result);
    setStatus(presented.message, !presented.ok);
    settleVoiceAfterCommand();
    if (presented.ok && presented.spoken) speakFeedback(presented.spoken);
    cacheCorrectionAlternatives(choice, elementId, result);
  } finally {
    commandPending = false;
    updateExecuteEnabled();
    updateVoiceControls();
    drainAutoAcquire();
    drainDeferredAdoption();
  }
}

/* --- Planner commands (Issue #14) ------------------------------------------
 * Anything beyond the #13 fast-path grammar is planned by the local
 * planner proxy (Muse Spark via Chat Completions) and executed step by
 * step through the SAME guarded pipeline: same request contract, same
 * confirmation controller, same locks, no replay. The proxy plans only;
 * the panel validates every plan against the LIVE snapshot, re-snapshots
 * after every step, and stops on any failure, unverified outcome, stale
 * identity, or held consequential step. Model output is never authority.
 *
 * Cached corrections ("no, the other one") resolve locally from validated
 * clarification alternatives with zero model calls. */

/* Bounded conversation context for the planner: structured { summary,
 * outcome } entries built from separated action/target/outcome parts —
 * raw transcripts are never retained because values can hide anywhere
 * in free text. Document-scoped, values never included. Reset whenever
 * the tab or document session changes. */
let plannerContextKey = null;
let plannerContextEntries = [];
function plannerContextFor(tabId, session) {
  const key = `${tabId} ${session}`;
  if (plannerContextKey !== key) {
    plannerContextKey = key;
    plannerContextEntries = [];
  }
  return plannerContextEntries;
}
function recordPlannerContext(tabId, session, summary, outcome) {
  if (tabId === null || tabId === undefined || !session) return;
  const plannerApi = globalThis.SeeyablePlanner;
  if (!plannerApi) return;
  plannerContextEntries = plannerApi.appendContext(plannerContextFor(tabId, session), summary, outcome);
}

/* Cached correction alternatives from the last validated clarification
 * round. Single use, bound to tab/session/sequence: any newer command,
 * tab/document change, cancellation, or Pause/Stop invalidates it. */
let pendingCorrection = null;
function cacheCorrectionAlternatives(choice, chosenId, result) {
  pendingCorrection = null;
  if (!choice || !result) return;
  if (result.outcome !== "completed" && result.outcome !== "held") return;
  if (!Array.isArray(choice.candidateIds) || choice.candidateIds.length < 2) return;
  const labels = new Map((choice.candidateLabels || []).map((c) => [c.elementId, c.label]));
  const alternatives = choice.candidateIds
    .filter((id) => id !== chosenId)
    .map((id) => ({ elementId: id, label: labels.get(id) || id }));
  if (alternatives.length === 0) return;
  let prior = "ran";
  if (result.outcome === "held") prior = "is waiting for approval";
  else if (result.response && !result.response.ok) prior = `failed (${result.response.error.code})`;
  else if (result.response && result.response.result && result.response.result.verified === true) prior = "completed and verified";
  else if (result.response && result.response.result && result.response.result.alreadyInDesiredState) prior = "was already done";
  else prior = "ran but is unverified";
  pendingCorrection = {
    candidates: alternatives,
    action: choice.action,
    value: choice.value,
    tabId: choice.tabId,
    session: choice.session,
    seq: choice.seq,
    chosenLabel: labels.get(chosenId) || chosenId,
    prior,
  };
}
function takeCorrectionRequest(rawText) {
  const plannerApi = globalThis.SeeyablePlanner;
  if (!plannerApi || !plannerApi.isCorrectionRequest(rawText)) return null;
  const entry = pendingCorrection;
  pendingCorrection = null; // consumed whether usable or not; a new choice re-caches
  if (!entry) return { valid: false };
  const snapshot = state.snapshot;
  if (entry.seq !== interactionSeq || !snapshot || state.boundTabId !== entry.tabId
    || snapshot.documentSessionId !== entry.session || !Array.isArray(entry.candidates)) {
    return { valid: false };
  }
  const usable = entry.candidates.filter((c) => snapshot.elements.some((e) => e && e.id === c.elementId));
  if (usable.length === 0) return { valid: false };
  return { valid: true, entry: { ...entry, candidates: usable } };
}

async function runCorrectionCommand(correction, source, gen, seq) {
  const entry = correction.entry;
  const tab = state.boundTabId !== null ? { id: state.boundTabId } : await activeTab();
  if (gen !== state.generation || seq !== interactionSeq) return { ok: false, discarded: true, message: "" };
  if (!tab || tab.id === undefined || tab.id !== entry.tabId) {
    return { ok: false, message: "The correction belongs to another tab. Nothing was executed." };
  }
  voiceTabId = tab.id;
  // A model-derived alternative becomes a preview bound to the live page.
  const ensured = await ensureCommandSnapshot(tab.id, gen, seq, { fresh: entry.origin === "planner" });
  if (ensured.discarded || gen !== state.generation || seq !== interactionSeq) {
    return { ok: false, discarded: true, message: "" };
  }
  if (ensured.error) return { ok: false, message: ensured.error };
  const snapshot = ensured.snapshot;
  if (snapshot.documentSessionId !== entry.session) {
    return { ok: false, message: "The page changed since that choice. Nothing was executed; send the command again." };
  }
  const usable = entry.candidates.filter((c) => snapshot.elements.some((e) => e && e.id === c.elementId));
  if (usable.length === 0) {
    return { ok: false, message: "The alternative is no longer on the page. Nothing was executed." };
  }
  const priorNote = `Earlier choice “${entry.chosenLabel}” ${entry.prior}.`;
  // Model-derived alternatives (Issue #15) keep their origin: a choice from
  // them enters review, and a single alternative becomes a NEW preview —
  // never execution. Local alternatives keep the #13/#14 behavior.
  const fromPlanner = entry.origin === "planner";
  if (usable.length > 1) {
    renderClarification({ kind: entry.action, target: `the other one (was “${entry.chosenLabel}”)`, value: entry.value },
      usable, {
        tabId: tab.id, session: snapshot.documentSessionId, revision: snapshot.revision, gen, seq,
        ...(fromPlanner ? { origin: "planner", requestText: entry.requestText, source: entry.source } : {}),
      });
    return {
      ok: true, clarify: true,
      message: `${priorNote} ${usable.length} alternatives remain — choose one. Nothing was executed.`,
      spoken: `${usable.length} alternatives. Choose one.`,
      contextSummary: `correction choice (${usable.length} alternatives)`,
      contextOutcome: "correction offered choices",
    };
  }
  if (fromPlanner) {
    const plannerApi = globalThis.SeeyablePlanner;
    const planApi = globalThis.SeeyablePlan;
    const step = { action: entry.action, elementId: usable[0].elementId };
    if (entry.action === "fill" || entry.action === "select") step.value = entry.value;
    const plan = { version: "seeyable-plan-1", outcome: "steps", steps: [step] };
    const validation = planApi && plannerApi ? planApi.validatePlan(plan, snapshot.elements) : { ok: false, errors: [{ code: "UNAVAILABLE" }] };
    if (!validation.ok) {
      return { ok: false, message: `${priorNote} The alternative cannot become a safe plan (${validation.errors[0].code}). Nothing was executed.`, contextSummary: "correction request", contextOutcome: "correction rejected" };
    }
    presentPlanPreview(plan, {
      tabId: tab.id, session: snapshot.documentSessionId, revision: snapshot.revision,
      semanticHash: snapshot.semanticHash || null, gen, seq,
      pruned: plannerApi.pruneSnapshot(snapshot), source: entry.source, requestText: entry.requestText,
    });
    return {
      ok: true, preview: true,
      message: `${priorNote} Alternative “${usable[0].label}”: plan ready for review: 1 step. Nothing has changed on the page yet — approve, edit, or cancel it.`,
      spoken: "Plan ready for review.",
      contextSummary: `correction to ${usable[0].label}`,
      contextOutcome: "correction previewed; awaiting review",
    };
  }
  const target = snapshot.elements.find((e) => e.id === usable[0].elementId);
  const request = {
    action: entry.action,
    elementId: usable[0].elementId,
    documentSessionId: snapshot.documentSessionId,
    revision: snapshot.revision,
    value: (entry.action === "fill" || entry.action === "select") ? entry.value : undefined,
    source: source === "voice" ? "voice" : "manual",
  };
  const result = await runExecutionPipeline(tab.id, request, gen, seq);
  if (gen !== state.generation || seq !== interactionSeq) {
    return { ok: false, discarded: true, message: "", reached: true };
  }
  const presented = presentPipelineOutcome(entry.action, commandTargetName(target), result);
  return {
    ...presented,
    message: `${priorNote} Alternative “${usable[0].label}”: ${presented.message.charAt(0).toLowerCase()}${presented.message.slice(1)}`,
    contextSummary: `correction to ${usable[0].label}`,
    contextOutcome: presented.ok ? "correction ran alternative" : "correction failed",
  };
}

function plannerFailureMessage(err) {
  const code = err && err.code;
  if (code === "NO_TOKEN" || code === "UNREACHABLE") {
    // The recovery card carries the instructions; status says what happened.
    return { ok: false, recover: true, message: "Unsupported command. That request needs the planner proxy." };
  }
  if (code === "NO_API_KEY") return { ok: false, message: `Planner unavailable: ${err.message}` };
  if (code === "PLAN_INVALID") {
    return { ok: false, message: "The planner could not produce a safe plan. Nothing was executed. Try rephrasing or pick a target manually." };
  }
  if (code === "TIMEOUT" || code === "MODEL_TIMEOUT") {
    return { ok: false, message: "The planner did not answer in time. Nothing was executed." };
  }
  if (code === "MODEL_AUTH" || code === "MODEL_FORBIDDEN" || code === "MODEL_NOT_FOUND"
    || code === "MODEL_RATE_LIMITED" || code === "MODEL_UNAVAILABLE" || code === "MODEL_ERROR") {
    // Upstream HTTP failures: the proxy composed a safe, status-bearing
    // message (codes above are the complete known set — nothing else
    // passes through verbatim). Nothing was planned, let alone run.
    return { ok: false, message: `${err.message} Nothing was executed.` };
  }
  if (code === "BAD_PROXY" || code === "PROXY_ERROR" || code === "BAD_REQUEST" || code === "BODY_TOO_LARGE") {
    return { ok: false, message: "The planner request failed. Nothing was executed." };
  }
  return { ok: false, message: `Planner failed: ${(err && err.message) || err}` };
}

function planStopMessage(done, total, reason) {
  // Names only, never values: done holds accessible names of verified steps.
  const progress = done.length === 0
    ? "Nothing was executed."
    : `Completed ${done.length} of ${total} first: ${done.join("; ")}.`;
  return `Stopped: ${reason}. ${progress} Check the page before continuing.`;
}

// Select steps revalidate against CURRENT dropdown choices immediately
// before dispatch. The executor's exact-value check stays final, but the
// panel stops earlier with a planning-level explanation when the planned
// choice vanished, is disabled, turned ambiguous, or the list changed at
// all since planning. Pruned options are clipped and capped, so the live
// list is canonicalized through the same projection before the
// changed-compare; the exact-match checks use the full live list.
// Elements without option metadata skip these checks. Value-free.
function selectStopReason(step, i, total, was, target) {
  const liveOpts = target && target.state && Array.isArray(target.state.options) ? target.state.options : null;
  if (!liveOpts) return null;
  const at = `step ${i + 1}/${total}`;
  const matches = liveOpts.filter((o) => o && o.value === step.value);
  if (matches.length === 0) {
    return {
      message: `step ${i + 1} targets a dropdown choice that is no longer listed`,
      contextOutcome: `stopped: option gone at ${at}`,
    };
  }
  if (matches[0].disabled === true) {
    return {
      message: `step ${i + 1} targets a dropdown choice that is now disabled`,
      contextOutcome: `stopped: option disabled at ${at}`,
    };
  }
  if (matches.length > 1 || liveOpts.some((o) => o && o !== matches[0] && o.label === matches[0].label)) {
    return {
      message: `step ${i + 1} targets a dropdown label that matches more than one choice — say which one`,
      contextOutcome: `stopped: option ambiguous at ${at}`,
    };
  }
  const prunedOpts = was && was.state && Array.isArray(was.state.options) ? was.state.options : null;
  const canonicalize = globalThis.SeeyablePlanner && globalThis.SeeyablePlanner.pruneSelectOptions;
  if (prunedOpts && typeof canonicalize === "function") {
    const liveCanon = canonicalize(liveOpts);
    const prunedCanon = { options: prunedOpts, omitted: (was.state && was.state.optionsOmitted) || 0 };
    if (JSON.stringify(liveCanon) !== JSON.stringify(prunedCanon)) {
      return {
        message: `step ${i + 1} targets a dropdown whose options changed since planning`,
        contextOutcome: `stopped: options changed at ${at}`,
      };
    }
  }
  return null;
}

// Value-free plan summary for retained context: validated actions with
// target NAMES from the pruned snapshot. Step values are never included.
function planSummaryOf(plan, pruned) {
  const prunedById = new Map(pruned.elements.map((e) => [e.id, e]));
  return plan.steps.map((s) => {
    const was = prunedById.get(s.elementId);
    return `${s.action} ${was ? commandTargetName(was) : s.elementId}`;
  }).join("; ");
}

// Progress presentation wraps the unchanged sequential runner: the Acting
// card shows done/now/next from the same validated steps, and a fully
// verified run becomes the Completed list. Execution is not affected.
async function runPlanSteps(plan, opts) {
  const elements = state.snapshot && Array.isArray(state.snapshot.elements) ? state.snapshot.elements : opts.pruned.elements;
  planProgress = {
    index: 0,
    steps: plan.steps.map((step) => {
      const element = elements.find((e) => e && e.id === step.elementId)
        || opts.pruned.elements.find((e) => e.id === step.elementId);
      const described = describePlanStep(step, element, elements);
      return {
        text: described.text, target: described.target, targetLast: described.targetLast, el: step.elementId, risky: Boolean(described.note),
        action: step.action, name: commandTargetName(element).replace(/[\s*]+$/, ""), changed: false,
      };
    }),
  };
  lastRun = null;
  plannerRecovery = false;
  renderState();
  try {
    const outcome = await runPlanStepsInner(plan, opts);
    const verified = Boolean(outcome && outcome.ok && !outcome.held && /^completed/.test(outcome.contextOutcome || ""));
    if (verified) {
      lastRun = { steps: planProgress.steps };
      sendTagStates(Object.fromEntries(plan.steps.map((st) => [st.elementId, "done"])));
    } else if (outcome && outcome.held) {
      // Earlier steps verified; the held step is marked by showConfirmation.
      const held = {};
      for (let d = 0; d < planProgress.index; d++) held[plan.steps[d].elementId] = "done";
      sendTagStates({ ...held, ...Object.fromEntries(Object.entries(tagStates).filter(([, st]) => st === "held")) });
    } else {
      sendTagStates({});
    }
    return outcome;
  } finally {
    planProgress = null;
  }
}

async function runPlanStepsInner(plan, { tabId, source, gen, seq, pruned }) {
  const total = plan.steps.length;
  const prunedById = new Map(pruned.elements.map((e) => [e.id, e]));
  const planSummary = planSummaryOf(plan, pruned);
  const done = [];
  for (let i = 0; i < total; i++) {
    const step = plan.steps[i];
    if (gen !== state.generation || seq !== interactionSeq) {
      return { ok: false, discarded: true, message: "", reached: done.length > 0 };
    }
    const live = state.snapshot;
    if (!live || state.boundTabId !== tabId || live.documentSessionId !== pruned.documentSessionId) {
      return { ok: false, discarded: true, message: "", reached: done.length > 0 };
    }
    const target = live.elements.find((e) => e && e.id === step.elementId);
    const was = prunedById.get(step.elementId);
    if (!target) {
      return {
        ok: false,
        message: planStopMessage(done, total, `step ${i + 1}\u2019s target is no longer on the page`),
        contextSummary: planSummary,
        contextOutcome: `stopped: target gone at step ${i + 1}/${total}`,
      };
    }
    if (!was || was.name !== target.name || was.role !== target.role || (was.question || null) !== (target.question || null)) {
      return {
        ok: false,
        message: planStopMessage(done, total, `step ${i + 1} (“${commandTargetName(was)}”) changed since planning`),
        contextSummary: planSummary,
        contextOutcome: `stopped: target changed at step ${i + 1}/${total}`,
      };
    }
    if (step.action === "select" && typeof step.value === "string") {
      const optionStop = selectStopReason(step, i, total, was, target);
      if (optionStop) {
        return {
          ok: false,
          message: planStopMessage(done, total, optionStop.message),
          contextSummary: planSummary,
          contextOutcome: optionStop.contextOutcome,
        };
      }
    }
    if (planProgress) planProgress.index = i;
    const stepStates = {};
    for (let d = 0; d < i; d++) stepStates[plan.steps[d].elementId] = "done";
    stepStates[step.elementId] = "acting";
    sendTagStates(stepStates);
    setStatus(`Step ${i + 1} of ${total}: ${step.action} ${commandTargetName(target)}…`);
    const request = {
      action: step.action,
      elementId: step.elementId,
      documentSessionId: live.documentSessionId,
      revision: live.revision,
      value: step.value,
      source: source === "voice" ? "voice" : "manual",
    };
    const result = await runExecutionPipeline(tabId, request, gen, seq);
    if (gen !== state.generation || seq !== interactionSeq) {
      return { ok: false, discarded: true, message: "", reached: true };
    }
    if (result.outcome === "discarded") return { ok: false, discarded: true, message: "", reached: true };
    if (result.outcome === "held") {
      // The sequence pauses here: the human decides on THIS step alone in
      // the Safety gate. Later steps are dropped, never auto-continued —
      // one approval runs one action, and re-issue replays nothing.
      const presented = presentPipelineOutcome(step.action, commandTargetName(target), result);
      const rest = total - i - 1;
      return {
        ok: true, held: true,
        message: `${presented.message} Step ${i + 1} of ${total} is held; ${
          rest === 0 ? "it was the last step." : `${rest} later step${rest === 1 ? " was" : "s were"} not run — send the command again to continue after deciding.`}`,
        spoken: presented.spoken,
        contextSummary: planSummary,
        contextOutcome: `held at step ${i + 1}/${total}`,
      };
    }
    if (result.outcome === "transport" || result.outcome === "malformed") {
      return {
        ok: false,
        message: planStopMessage(done, total, `I lost contact with the page at step ${i + 1}`),
        contextSummary: planSummary,
        contextOutcome: `stopped: transport at step ${i + 1}/${total}`,
      };
    }
    const response = result.response;
    if (!response.ok) {
      return {
        ok: false,
        message: planStopMessage(done, total, `step ${i + 1} failed on ${commandTargetName(target)}: ${failureWords(response.error)}`),
        contextSummary: planSummary,
        contextOutcome: `stopped: ${response.error.code} at step ${i + 1}/${total}`,
      };
    }
    if (isConfirmedOutcome(response)) {
      done.push(commandTargetName(target));
      if (planProgress) planProgress.steps[i].changed = isVerifiedResult(response);
      continue;
    }
    return {
      ok: false,
      message: planStopMessage(done, total, `step ${i + 1} could not be verified on the page`),
      contextSummary: planSummary,
      contextOutcome: `stopped: unverified at step ${i + 1}/${total}`,
    };
  }
  return {
    ok: true,
    message: `Completed ${total} step${total === 1 ? "" : "s"}, all verified: ${done.join("; ")}.`,
    spoken: plan.say || `Done. ${total} step${total === 1 ? "" : "s"} completed.`,
    contextSummary: planSummary,
    contextOutcome: `completed ${total}/${total} verified`,
  };
}

/* Content-free timing diagnostics for the planning path. Every line is
 * `[seeyable-timing] id=… source=… stage=… ms=…` plus only counts and
 * error codes — never transcripts, values, snapshot content, keys, or
 * tokens. The id travels to the proxy as X-Seeyable-Timing-Id so panel
 * and proxy lines correlate. Timings are also recorded on failures. */
let timingSeqNo = 0;
let voiceStopMarkMs = null;
let lastFinalTiming = null;

function startTiming(source) {
  const id = `cmd-${++timingSeqNo}`;
  const started = performance.now();
  return {
    id,
    log(stage, ms, extra = "") {
      try { console.info(`[seeyable-timing] id=${id} source=${source} stage=${stage} ms=${Math.round(ms)}${extra}`); } catch { /* diagnostics are best-effort */ }
    },
    since() { return performance.now() - started; },
  };
}

async function runPlannerCommand(rawText, source, gen, seq, opts = {}) {
  const plannerApi = globalThis.SeeyablePlanner;
  const planApi = globalThis.SeeyablePlan;
  if (!plannerApi || !planApi) {
    return { ok: false, message: "Planner support is unavailable in this panel. Reload the extension." };
  }
  const tab = state.boundTabId !== null ? { id: state.boundTabId } : await activeTab();
  if (gen !== state.generation || seq !== interactionSeq) return { ok: false, discarded: true, message: "" };
  if (!tab || tab.id === undefined) return { ok: false, message: "No active tab." };
  // Fail fast when unpaired: no snapshot, no tab messages — the same
  // help as the old unsupported branch plus the pairing hint.
  const creds = await plannerCredentials();
  if (gen !== state.generation || seq !== interactionSeq) return { ok: false, discarded: true, message: "" };
  if (!creds.token) return plannerFailureMessage({ code: "NO_TOKEN" });
  voiceTabId = tab.id;
  setStatus("Planning…");
  const timing = opts.timing || null;
  // Plans are made — and reviewed — against the LIVE page, never a cached
  // copy: a person may have typed since the last snapshot, and a preview
  // bound to a stale revision could only ever be refused at approval.
  const snapshotStarted = performance.now();
  const ensured = await ensureCommandSnapshot(tab.id, gen, seq, { fresh: true });
  if (timing) timing.log("snapshot", performance.now() - snapshotStarted, ensured.error ? " outcome=error" : ensured.discarded ? " outcome=discarded" : "");
  if (ensured.discarded || gen !== state.generation || seq !== interactionSeq) {
    return { ok: false, discarded: true, message: "" };
  }
  if (ensured.error) return { ok: false, message: ensured.error };
  const snapshot = ensured.snapshot;
  let pruned;
  try {
    pruned = plannerApi.pruneSnapshot(snapshot);
  } catch (err) {
    return { ok: false, message: `Could not prepare the page for planning: ${err.message || err}` };
  }
  const context = plannerContextFor(tab.id, snapshot.documentSessionId).slice();
  plannerAbortController = new AbortController();
  let payload;
  const requestStarted = performance.now();
  if (timing) {
    const approxBytes = JSON.stringify({ transcript: rawText, snapshot: pruned, context }).length;
    timing.log("request-sent", 0, ` elements=${pruned.elements.length} approxBytes=${approxBytes}`);
  }
  try {
    payload = await plannerApi.requestPlan({
      baseUrl: creds.baseUrl,
      token: creds.token,
      transcript: rawText,
      snapshot: pruned,
      context,
      signal: plannerAbortController.signal,
      timingId: timing ? timing.id : undefined,
    });
    if (timing) timing.log("proxy-response", performance.now() - requestStarted);
  } catch (err) {
    if (timing) timing.log("proxy-error", performance.now() - requestStarted, ` code=${err && err.code ? err.code : "ERROR"}`);
    plannerAbortController = null;
    if (gen !== state.generation || seq !== interactionSeq) return { ok: false, discarded: true, message: "" };
    return plannerFailureMessage(err);
  }
  plannerAbortController = null;
  if (gen !== state.generation || seq !== interactionSeq) return { ok: false, discarded: true, message: "" };
  // Defensive re-validation against the LIVE snapshot: only ids present
  // right now, in this document, may run — never the plan's word alone.
  const live = state.snapshot;
  if (!live || state.boundTabId !== tab.id || live.documentSessionId !== snapshot.documentSessionId) {
    return { ok: false, discarded: true, message: "" };
  }
  if (payload.documentSessionId !== snapshot.documentSessionId || payload.revision !== snapshot.revision) {
    return {
      ok: false,
      message: "The plan was made for a different page state. Nothing was executed; send the command again.",
      contextSummary: "plan request",
      contextOutcome: "plan binding mismatch",
    };
  }
  const validationStarted = performance.now();
  const validation = planApi.validatePlan(payload.plan, live.elements);
  if (timing) timing.log("panel-validation", performance.now() - validationStarted, ` ok=${validation.ok}`);
  if (!validation.ok) {
    return {
      ok: false,
      message: `The planner returned an unsafe plan (${validation.errors[0].code}). Nothing was executed. Try rephrasing.`,
      contextSummary: "plan request",
      contextOutcome: "plan rejected by panel validation",
    };
  }
  const plan = payload.plan;
  if (plan.outcome === "unsupported") {
    // The model-written reason is NOT retained: it may echo request
    // content. The category alone is the useful history.
    return { ok: false, message: `No safe plan: ${plan.reason}`, contextSummary: "unsupported request", contextOutcome: "unsupported request" };
  }
  if (plan.outcome === "clarify") {
    if (!plan.choices) {
      return {
        ok: true, clarify: true,
        message: `${plan.question} Nothing was executed.`,
        contextSummary: "clarify request",
        contextOutcome: "clarification requested",
      };
    }
    renderClarification({ kind: plan.action, target: plan.question, value: plan.value },
      plan.choices.map((c) => ({ elementId: c.elementId, label: c.label })),
      { tabId: tab.id, session: live.documentSessionId, revision: live.revision, gen, seq, origin: "planner", requestText: rawText, source });
    return {
      ok: true, clarify: true,
      message: `“${plan.question}” — choose one of ${plan.choices.length}. Nothing was executed.`,
      spoken: `${plan.choices.length} matches. Choose one.`,
      contextSummary: `clarify request (${plan.choices.length} choices)`,
      contextOutcome: "clarification requested",
    };
  }
  // Issue #15: a validated step plan never runs directly. It becomes the
  // one pending preview, bound to this request, tab, document, revision,
  // and interaction; only an explicit approval runs it.
  const previewStarted = performance.now();
  presentPlanPreview(plan, {
    tabId: tab.id, session: live.documentSessionId, revision: live.revision,
    semanticHash: live.semanticHash || null, gen, seq, pruned, source, requestText: rawText,
  });
  if (timing) timing.log("preview-rendered", performance.now() - previewStarted, ` totalMs=${Math.round(timing.since())}`);
  const n = plan.steps.length;
  return {
    ok: true, preview: true,
    plainPlanReady: !opts.edited,
    message: `${opts.edited ? "Replacement plan" : "Plan"} ready for review: ${n} step${n === 1 ? "" : "s"}. Nothing has changed on the page yet — approve, edit, or cancel it.${opts.edited ? " The earlier plan was discarded and can no longer run." : ""}`,
    spoken: "Plan ready for review.",
    contextSummary: planSummaryOf(plan, pruned),
    contextOutcome: "previewed; awaiting review",
  };
}

/* --- Plan review, voice review authority, undo (Issue #15) ------------------
 * Every validated AI-generated step plan — including one resolved from a
 * model clarification — waits here as ONE frozen preview before anything
 * touches the page. The preview is rendered deterministically from the
 * validated plan (never from model prose) and is bound to its request,
 * tab, document session, revision, generation, and interaction. Approve,
 * Edit, and Cancel close over that exact object: once it is replaced,
 * edited, cancelled, superseded, or invalidated, its callbacks do nothing.
 *
 * Waiting for review is its own state (pendingPlan): the network lock
 * (commandPending) is released so the review controls work, while manual
 * execution stays blocked. Approval re-reads the live page and requires
 * the reviewed session and revision; a changed page needs a fresh review
 * — never a silent replan or substituted target. Approving a plan never
 * approves a consequential step: the executor still holds it for its own
 * single-action confirmation, and the sequence ends there.
 *
 * Voice review phrases resolve locally with zero model calls. Approval by
 * voice is accepted only from the final result of the active recognition
 * session that the user started (Start listening) while that exact plan
 * or challenge was displayed, once, and never while synthesized speech
 * is playing. Page content, model output, and speech feedback have no
 * route into this decision. */
let planSeq = 0;
let planFocusReturn = null;

function frozenCopy(value) {
  const copy = JSON.parse(JSON.stringify(value));
  const freeze = (v) => {
    if (v && typeof v === "object") {
      Object.freeze(v);
      for (const key of Object.keys(v)) freeze(v[key]);
    }
    return v;
  };
  return freeze(copy);
}

const CONSEQUENTIAL_HINT = /\b(submit|pay|buy|purchase|checkout|delete|remove|send|publish|place order|confirm order)\b/i;
const SELECTION_HINT_ROLES = new Set(["radio", "checkbox", "option"]);
// Preview hint only — the executor decides, for every caller. It mirrors
// the executor's rule with snapshot data: committing controls (and buttons
// or links given a selection role) are judged by their whole label; a
// selection control's name may shed only a trailing, demonstrably
// incidental reference to its structurally certain question/row context
// ("…, response for Checkout experience"). Context anywhere else is kept,
// so ambiguous cases are hinted as held.
const REFERENCE_INTRO_HINT = /(?:^|[^\p{L}\p{N}])(?:for|of|about|regarding|concerning|on)\s*[:,]?\s*$/iu;
function previewMayHold(element) {
  if (!element) return false;
  const squash = (t) => String(t || "").replace(/\s+/g, " ").trim();
  const whole = squash(element.name).replace(/[\s.]+$/, "");
  const tag = String(element.tag || "").toLowerCase();
  const selection = SELECTION_HINT_ROLES.has(element.role) && !["button", "a", "summary"].includes(tag);
  if (!selection || !element.question || !element.questionCertain) return CONSEQUENTIAL_HINT.test(whole);
  const phrases = new Set([squash(element.question)]);
  for (const part of element.question.split(/\s*[:,;·|–—]\s*|\s+-\s+/)) {
    if (squash(part).split(" ").length >= 2) phrases.add(squash(part));
  }
  for (const phrase of [...phrases].sort((a, b) => b.length - a.length)) {
    if (!phrase || !whole.toLowerCase().endsWith(phrase.toLowerCase())) continue;
    const before = whole.slice(0, whole.length - phrase.length);
    if (/[\p{L}\p{N}]$/u.test(before) || !REFERENCE_INTRO_HINT.test(before)) continue;
    if (!/[\p{L}\p{N}]/u.test(before.replace(REFERENCE_INTRO_HINT, ""))) continue;
    return CONSEQUENTIAL_HINT.test(before);
  }
  return CONSEQUENTIAL_HINT.test(whole);
}
function quotedValue(value) {
  const text = String(value);
  return text.length > 160 ? `“${text.slice(0, 160)}…” (${text.length} characters in total)` : `“${text}”`;
}
// Plain-English, deterministic step text from the validated plan and the
// reviewed snapshot. Page labels are untrusted data and are only ever
// set through textContent.
function describePlanStep(step, element, elements) {
  return {
    ...describePlanStepWords(step, element, elements),
    target: element ? fullLabel(element, elements) : step.elementId,
    targetLast: step.action === "select",
  };
}
function describePlanStepWords(step, element, elements) {
  const name = element ? fullLabel(element, elements) : step.elementId;
  const isProtected = Boolean(element && element.state && element.state.redacted);
  if (step.action === "fill") {
    if (isProtected) return { text: `Fill “${name}” with a protected value (hidden)` };
    return { text: step.value === "" ? `Clear “${name}”` : `Fill “${name}” with ${quotedValue(step.value)}` };
  }
  if (step.action === "select") {
    const options = element && element.state && Array.isArray(element.state.options) ? element.state.options : [];
    const option = options.find((o) => o && o.value === step.value);
    return { text: `Choose ${quotedValue(option ? option.label : step.value)} in “${name}”` };
  }
  const note = previewMayHold(element) ? "This will stop and ask for its own approval." : null;
  if (step.action === "check") {
    return { text: element && element.role === "radio" ? `Select “${name}”` : `Turn on “${name}”`, note };
  }
  if (step.action === "uncheck") return { text: `Turn off “${name}”`, note };
  return { text: `Click “${name}”`, note };
}

function clearPlanPreview() {
  const had = pendingPlan !== null;
  pendingPlan = null;
  const box = $("planBox");
  if (!box) return had;
  const focusWasInside = box.contains(document.activeElement);
  box.hidden = true;
  $("planSteps").replaceChildren();
  $("planFrom").hidden = true;
  $("planFromText").textContent = "";
  for (const id of ["btnApprovePlan", "btnEditPlan", "btnCancelPlan"]) $(id).onclick = null;
  if (focusWasInside && planFocusReturn && document.contains(planFocusReturn) && typeof planFocusReturn.focus === "function") {
    planFocusReturn.focus();
  }
  planFocusReturn = null;
  if (typeof updateExecuteEnabled === "function") updateExecuteEnabled();
  // A plan review no longer owns the panel: run any confirmation
  // discovery that was deferred behind it (approve/cancel/edit and
  // supersede/invalidate all clear the preview through here).
  if (had && typeof drainDeferredAdoption === "function") { drainAutoAcquire(); drainDeferredAdoption(); }
  return had;
}
function closePlanEdit() {
  const box = $("planEditBox");
  if (!box || box.hidden) return false;
  box.hidden = true;
  $("planEditInput").value = "";
  return true;
}
// Invalidates the preview AND any open edit. Returns whether anything
// was discarded; callers decide what the status surface says.
function discardPlanReview() {
  const hadPlan = clearPlanPreview();
  const hadEdit = closePlanEdit();
  return hadPlan || hadEdit;
}

function presentPlanPreview(plan, binding) {
  discardPlanReview();
  showScreen("Assist");
  const preview = frozenCopy({
    id: ++planSeq,
    plan,
    pruned: binding.pruned,
    tabId: binding.tabId,
    session: binding.session,
    revision: binding.revision,
    semanticHash: binding.semanticHash || null,
    gen: binding.gen,
    seq: binding.seq,
    source: binding.source,
    requestText: binding.requestText || "",
    // Validated alternatives of the clarification round this one-step
    // plan came from (model-derived only), so "the other one" keeps
    // working after approval. Null for ordinary and correction plans.
    correction: binding.correction || null,
  });
  pendingPlan = preview;
  const elements = state.snapshot && Array.isArray(state.snapshot.elements) ? state.snapshot.elements : preview.pruned.elements;
  const list = $("planSteps");
  list.replaceChildren();
  let hasProtectedStep = false;
  for (const step of preview.plan.steps) {
    const element = elements.find((e) => e && e.id === step.elementId)
      || preview.pruned.elements.find((e) => e.id === step.elementId);
    const described = describePlanStep(step, element, elements);
    if (element && element.state && element.state.redacted) hasProtectedStep = true;
    list.append(stepItem({ ...described, el: step.elementId, risky: Boolean(described.note) }, ""));
  }
  const n = preview.plan.steps.length;
  $("planIntro").textContent = `${n} step${n === 1 ? "" : "s"}, in order`;
  // "From" shows the person's own words back. A protected step hides its value
  // in the list, so the words that may contain it are not shown either.
  const showFrom = Boolean(preview.requestText) && !hasProtectedStep;
  $("planFrom").hidden = !showFrom;
  $("planFromText").textContent = showFrom ? `\u201C${preview.requestText}\u201D` : "";
  // Each control acts on THIS preview only; a later preview reassigns them.
  $("btnApprovePlan").onclick = () => { void approvePendingPlan(preview, "manual"); };
  $("btnEditPlan").onclick = () => openPlanEdit(preview);
  $("btnCancelPlan").onclick = () => cancelPendingPlan(preview, "manual");
  planFocusReturn = document.activeElement && document.contains(document.activeElement) ? document.activeElement : null;
  $("planBox").hidden = false;
  const title = $("planTitle");
  if (title && typeof title.focus === "function") title.focus();
  updateExecuteEnabled();
  return preview;
}

function presentClarifiedPlan(choice, elementId, snapshot) {
  const plannerApi = globalThis.SeeyablePlanner;
  const planApi = globalThis.SeeyablePlan;
  const step = { action: choice.action, elementId };
  if (choice.action === "fill" || choice.action === "select") step.value = choice.value;
  const plan = { version: "seeyable-plan-1", outcome: "steps", steps: [step] };
  const validation = planApi ? planApi.validatePlan(plan, snapshot.elements) : { ok: false, errors: [{ code: "UNAVAILABLE" }] };
  if (!plannerApi || !validation.ok) {
    setStatus(`That choice cannot become a safe plan (${validation.errors[0].code}). Nothing was executed.`, true);
    return;
  }
  presentPlanPreview(plan, {
    tabId: choice.tabId, session: choice.session, revision: choice.revision,
    semanticHash: snapshot.semanticHash || null, gen: choice.gen, seq: choice.seq,
    pruned: plannerApi.pruneSnapshot(snapshot), source: choice.source, requestText: choice.requestText,
    correction: {
      candidateIds: choice.candidateIds,
      candidateLabels: choice.candidateLabels,
      action: choice.action,
      value: choice.value,
      chosenId: elementId,
    },
  });
  setStatus("Plan ready for review: 1 step. Nothing has changed on the page yet — approve, edit, or cancel it.", false, { repeatsPlan: true });
}

function previewStillBound(preview) {
  return preview.gen === state.generation
    && preview.seq === interactionSeq
    && state.boundTabId === preview.tabId
    && Boolean(state.snapshot)
    && state.snapshot.documentSessionId === preview.session;
}

async function approvePendingPlan(preview, source) {
  if (!preview || preview !== pendingPlan) {
    // Obsolete callback: run nothing and leave any newer preview intact.
    if (!pendingPlan) setStatus("That plan is no longer available — it was edited, cancelled, replaced, or the page changed. Nothing was executed.", true);
    return;
  }
  if (commandPending || state.pending || state.acquiring) {
    setStatus("Another operation is in progress. The plan is still waiting for review.", true);
    return;
  }
  const valid = previewStillBound(preview);
  clearPlanPreview(); // single use: consumed whatever happens next
  if (!valid) {
    setStatus("That plan expired — the tab, document, or request changed. Nothing was executed; send the request again.", true);
    return;
  }
  interactionSeq += 1; // approval starts a new interaction; the preview's is over
  const gen = state.generation;
  const seq = interactionSeq;
  commandPending = true;
  updateExecuteEnabled();
  updateVoiceControls();
  setStatus("Approved — checking the page still matches what you reviewed…");
  let outcome = null;
  try {
    outcome = await runApprovedPlan(preview, source, gen, seq);
  } catch (err) {
    outcome = { ok: false, message: `Plan failed: ${err.message || err}` };
  } finally {
    commandPending = false;
    if (!(recognizer && recognizer.isActive())) voiceTabId = null;
    updateExecuteEnabled();
  }
  finishCommandOutcome(outcome, { gen, seq, acting: true, fallbackSummary: "approved plan" });
  cachePlannerCorrection(preview, outcome, gen, seq);
}

async function runApprovedPlan(preview, source, gen, seq) {
  const planApi = globalThis.SeeyablePlan;
  voiceTabId = preview.tabId;
  const summary = planSummaryOf(preview.plan, preview.pruned);
  const ensured = await ensureCommandSnapshot(preview.tabId, gen, seq, { fresh: true });
  if (ensured.discarded || gen !== state.generation || seq !== interactionSeq) return { ok: false, discarded: true, message: "" };
  if (ensured.error) return { ok: false, refused: true, message: `${ensured.error} Nothing was executed.`, contextSummary: summary, contextOutcome: "approval refused: page unreadable" };
  const live = ensured.snapshot;
  if (live.documentSessionId !== preview.session || live.revision !== preview.revision
    || (preview.semanticHash && live.semanticHash !== preview.semanticHash)) {
    return {
      ok: false, refused: true,
      message: "The page changed after you reviewed this plan. Nothing was executed — send the request again for a fresh review.",
      contextSummary: summary,
      contextOutcome: "approval refused: page changed since review",
    };
  }
  const validation = planApi.validatePlan(preview.plan, live.elements);
  if (!validation.ok) {
    return {
      ok: false, refused: true,
      message: `The reviewed plan no longer fits the page (${validation.errors[0].code}). Nothing was executed — send the request again.`,
      contextSummary: summary,
      contextOutcome: "approval refused: plan no longer valid",
    };
  }
  return runPlanSteps(preview.plan, { tabId: preview.tabId, source, gen, seq, pruned: preview.pruned });
}

/* A model-derived choice keeps its round's validated alternatives across
 * review: once its preview is approved and actually attempted, the
 * remaining alternatives are cached exactly like a local choice — bound
 * to this tab, document, and the approval's interaction, single use.
 * Resolving them later produces a NEW preview, never execution. */
function cachePlannerCorrection(preview, outcome, gen, seq) {
  const c = preview.correction;
  if (!c || !outcome || outcome.discarded || outcome.refused) return;
  if (gen !== state.generation || seq !== interactionSeq) return;
  if (!Array.isArray(c.candidateIds) || c.candidateIds.length < 2) return;
  const labels = new Map((c.candidateLabels || []).map((x) => [x.elementId, x.label]));
  const alternatives = c.candidateIds.filter((id) => id !== c.chosenId)
    .map((id) => ({ elementId: id, label: labels.get(id) || id }));
  if (alternatives.length === 0) return;
  pendingCorrection = {
    origin: "planner",
    candidates: alternatives,
    action: c.action,
    value: c.value,
    tabId: preview.tabId,
    session: preview.session,
    seq,
    chosenLabel: labels.get(c.chosenId) || c.chosenId,
    prior: outcome.held ? "is waiting for approval" : outcome.ok ? "completed and verified" : "did not complete",
    requestText: preview.requestText,
    source: preview.source,
  };
}

function cancelPendingPlan(preview, source) {
  if (!preview || preview !== pendingPlan) {
    if (!pendingPlan) setStatus("No plan is waiting for review. Nothing was cancelled.", true);
    return;
  }
  const summary = planSummaryOf(preview.plan, preview.pruned);
  const tabId = preview.tabId;
  const session = preview.session;
  clearPlanPreview();
  recordPlannerContext(tabId, session, summary, "cancelled at review");
  setStatus("Plan cancelled. Nothing was executed.");
  settleVoiceAfterCommand();
  if (source === "voice") speakFeedback("Plan cancelled.");
}

function openPlanEdit(preview) {
  if (!preview || preview !== pendingPlan) {
    if (!pendingPlan) setStatus("That plan is no longer available to edit. Send a new request.", true);
    return;
  }
  if (commandPending || state.pending || state.acquiring) return;
  const text = preview.requestText;
  clearPlanPreview(); // the original is unusable from this moment
  $("planEditInput").value = text;
  $("planEditBox").hidden = false;
  $("planEditInput").focus();
  setStatus("Editing the plan. The earlier plan was discarded; nothing was executed.");
  updateExecuteEnabled();
}

async function submitPlanEdit() {
  const text = $("planEditInput").value;
  if (!text.trim()) {
    setStatus("Write the complete replacement request first. Nothing was executed.", true);
    return;
  }
  closePlanEdit();
  await dispatchCommand(text, "typed", { forcePlanner: true, edited: true });
}
$("btnSubmitEdit").addEventListener("click", () => { void submitPlanEdit(); });
$("planEditInput").addEventListener("keydown", (event) => {
  // IME-safe: Enter that confirms a composition must not submit.
  if (event.key !== "Enter" || event.isComposing) return;
  event.preventDefault();
  void submitPlanEdit();
});
$("btnDiscardEdit").addEventListener("click", () => {
  if (closePlanEdit()) setStatus("Edit discarded. Nothing was executed.");
  updateExecuteEnabled();
});

// True only for the final result of the active session that the user
// started while the given plan/challenge was displayed — once.
function voiceReviewAuthorized(meta, kind, id) {
  const ctx = listenContext;
  if (!recognizer || !meta || meta.sessionId === undefined || meta.sessionId === null) return false;
  if (!ctx || ctx.used || ctx.sessionId !== meta.sessionId || recognizer.sessionId !== meta.sessionId) return false;
  if (speechOutput && speechOutput.isSpeaking()) return false;
  const shown = kind === "plan" ? ctx.planId : ctx.challengeId;
  if (shown === null || shown !== id) return false;
  ctx.used = true;
  return true;
}

function handleReviewCommand(review, source, meta) {
  const done = (text, isError) => { setStatus(text, isError); settleVoiceAfterCommand(); updateVoiceControls(); };
  if (review.kind === "approve-plan") {
    if (!pendingPlan) return done("No plan is waiting for review. Nothing was approved.", true);
    if (source === "voice" && !voiceReviewAuthorized(meta, "plan", pendingPlan.id)) {
      return done("That approval was not accepted: start listening while this plan is shown, then say “Approve plan”. Nothing was executed; the plan is still waiting.", true);
    }
    settleVoiceAfterCommand();
    void approvePendingPlan(pendingPlan, source === "voice" ? "voice" : "manual");
    return;
  }
  if (review.kind === "cancel-plan") {
    if (!pendingPlan) return done("No plan is waiting for review. Nothing was cancelled.", true);
    cancelPendingPlan(pendingPlan, source);
    return;
  }
  if (review.kind === "approve-action") {
    // Consequential approval stays on its own authority: the Approve once
    // button, or this phrase spoken in a user-started session bound to
    // the exact challenge on screen. Typed text never approves it.
    if (source !== "voice") return done("Use the Approve once button, or say “Approve this action” while listening. Nothing was approved.", true);
    if (!state.confirmation) return done("No action is waiting for approval. Nothing was approved.", true);
    if (!voiceReviewAuthorized(meta, "challenge", state.confirmation.challengeId)) {
      return done("That approval was not accepted: start listening while this action is shown, then say “Approve this action”. Nothing was approved.", true);
    }
    settleVoiceAfterCommand();
    void approveHeldChallenge(state.confirmation.challengeId);
  }
}

/* Undo (Issue #15): asks the executor, over the trusted panel route, to
 * restore the single last reversible change. The panel holds no undo
 * data; the executor verifies the live page and reports names only. */
async function runUndoCommand(source, gen, seq) {
  const tab = state.boundTabId !== null ? { id: state.boundTabId } : await activeTab();
  if (gen !== state.generation || seq !== interactionSeq) return { ok: false, discarded: true, message: "" };
  if (!tab || tab.id === undefined) return { ok: false, message: "No active tab." };
  voiceTabId = tab.id;
  const ensured = await ensureCommandSnapshot(tab.id, gen, seq);
  if (ensured.discarded || gen !== state.generation || seq !== interactionSeq) return { ok: false, discarded: true, message: "" };
  if (ensured.error) return { ok: false, message: ensured.error };
  const session = ensured.snapshot.documentSessionId;
  let response = null;
  let transportError = null;
  try {
    response = await chrome.tabs.sendMessage(tab.id, { type: "SEEYABLE_UNDO_LAST", documentSessionId: session, source: source === "voice" ? "voice" : "manual" });
  } catch (err) { transportError = err; }
  if (gen !== state.generation || seq !== interactionSeq) return { ok: false, discarded: true, message: "", reached: true };
  const base = { contextSummary: "undo last change" };
  if (transportError) {
    state.executorReady = false;
    return { ...base, ok: false, message: "I lost contact with the page during undo, so I can\u2019t tell what changed. Please check it.", contextOutcome: "transport failure" };
  }
  if (!response || typeof response.ok !== "boolean") {
    state.executorReady = false;
    return { ...base, ok: false, message: "The page gave no usable answer to undo, so nothing is confirmed. Please check it.", contextOutcome: "malformed response" };
  }
  const code = response.error && response.error.code;
  if (response.ok || code === "UNDO_NOT_VERIFIED" || code === "ACTION_FAILED") {
    await refreshAfterExecution(tab.id, gen, session); // the page may have changed
  }
  void fetchActionLog(tab.id);
  if (gen !== state.generation || seq !== interactionSeq) return { ok: false, discarded: true, message: "", reached: true };
  if (!response.ok) return { ...base, ok: false, message: response.error.message, contextOutcome: `undo refused: ${code}` };
  const r = response.result || {};
  const name = r.targetName || "the control";
  const what = r.restoredTargetName
    ? `“${r.restoredTargetName}” is selected again instead of “${name}”`
    : `“${name}” is back to its previous ${r.undoneAction === "fill" ? "value" : r.undoneAction === "select" ? "choice" : "state"}`;
  return {
    ...base,
    ok: true,
    message: `Undid the last change: ${what} (verified). Only that change was reversed — earlier changes, and anything the page did in response, stay as they are.`,
    spoken: `Undone: ${name}.`,
    contextOutcome: "undone and verified",
  };
}

/* One presentation for command outcomes, shared by dispatched commands
 * and plan approval. */
function finishCommandOutcome(outcome, { gen, seq, acting, fallbackSummary, fallbackSpoken, notePrefix }) {
  if (!outcome || outcome.discarded || gen !== state.generation || seq !== interactionSeq) {
    // The interaction moved on (tab/document change, cancellation):
    // never present or speak the late result as acting on this page.
    // A request that already reached the executor may still have run;
    // say so instead of implying cancellation reversed it.
    const reason = discardMessage;
    discardMessage = null;
    pendingSpoken = null;
    const late = outcome && outcome.reached
      ? " It may already have reached the page, so check page state before continuing."
      : "";
    // One authoritative surface for the discard outcome: #status presents
    // it (never the late result, never a success claim), replacing any
    // obsolete planning/progress text ("Planning…", "Step 2 of 4…").
    // #voiceState reports microphone lifecycle only via the shared
    // settling helper, so the two role="status" regions never announce
    // the same outcome twice. The status write re-renders the chip,
    // which shows Paused while the executor gate is closed. Dispatch is
    // single-flight — every command entry holds commandPending and every
    // status-writing panel operation is locked out until it settles — so
    // this write cannot overwrite a newer command's status.
    setStatus(reason
      ? `Command discarded — ${reason}${late}`
      : `Command discarded — the tab or document changed while it was running; its result was discarded.${late}`, true);
    settleVoiceAfterCommand();
    updateVoiceControls();
    drainAutoAcquire();
    if (state.boundTabId !== null) void adoptPendingConfirmation(state.boundTabId);
    return;
  }
  discardMessage = null;
  // Acting commands (fast path, planner, correction, undo) append one
  // bounded, value-free { summary, outcome } entry to the document-scoped
  // planner context. Summaries come from separated structure (parsed
  // action + target label, planned step names) — never the raw
  // transcript. Discarded commands record nothing: their outcome is unknown.
  if (acting && state.snapshot && state.boundTabId !== null) {
    recordPlannerContext(state.boundTabId, state.snapshot.documentSessionId,
      outcome.contextSummary || fallbackSummary,
      outcome.contextOutcome || (outcome.clarify ? "clarification requested" : outcome.ok ? "completed" : "failed"));
  }
  if (outcome.recover) plannerRecovery = true;
  setStatus(`${notePrefix || ""}${outcome.message}`, !outcome.ok, { repeatsPlan: Boolean(outcome.plainPlanReady) && !notePrefix });
  if (outcome.ok) {
    // A completed command is recovery from any prior recognition error.
    voiceErrorUnresolved = false;
    // Spoken success only after the page acknowledged the command,
    // and only once any active microphone has terminated.
    const spoken = outcome.spoken || fallbackSpoken;
    if (spoken) speakFeedback(spoken);
  }
  settleVoiceAfterCommand();
  updateVoiceControls();
  drainAutoAcquire();
  if (state.boundTabId !== null) void adoptPendingConfirmation(state.boundTabId);
}

async function dispatchCommand(rawText, source, meta = {}) {
  if (!voiceApi) return;
  if (commandPending) {
    setVoiceState("Voice: error — a command is already running; nothing was queued.", true);
    return;
  }
  if (state.pending || state.acquiring) {
    setVoiceState("Voice: error — another panel operation is in progress. Wait for it to finish, then send the command again.", true);
    return;
  }
  const timing = startTiming(source);
  if (source === "voice" && lastFinalTiming) {
    timing.log("stop-to-final", lastFinalTiming.ms);
    lastFinalTiming = null;
  }
  // Review and undo phrases resolve locally before anything else, against
  // what is on screen now; approval and cancellation run no model call.
  const review = !meta.forcePlanner && voiceApi.resolveReviewCommand ? voiceApi.resolveReviewCommand(rawText) : null;
  if (review && (review.kind === "approve-plan" || review.kind === "cancel-plan" || review.kind === "approve-action")) {
    if (source === "typed" && recognizer && recognizer.isActive()) recognizer.cancel();
    handleReviewCommand(review, source, meta);
    return;
  }
  // Approval-like speech that is not an exact approval phrase never
  // supersedes a plan under review: the plan stays, nothing runs, no
  // planner call. This is retention only — it authorizes nothing.
  if (!review && !meta.forcePlanner && pendingPlan && voiceApi.isApprovalLike && voiceApi.isApprovalLike(rawText)) {
    if (source === "typed" && recognizer && recognizer.isActive()) recognizer.cancel();
    setStatus("Not approved — that wording is not a supported approval, so nothing ran and the plan is still waiting. Say “Approve plan” (or “Approve”, “Go ahead”), “Cancel plan”, or “Edit plan: …”.", true);
    settleVoiceAfterCommand();
    updateVoiceControls();
    return;
  }
  let text = rawText;
  let forcePlanner = Boolean(meta.forcePlanner);
  let edited = Boolean(meta.edited);
  if (review && review.kind === "edit-plan") {
    // "Edit plan: <request>" replaces the displayed plan's request. It is
    // always planned and previewed again — never fast-pathed, never run.
    if (!pendingPlan) {
      setStatus("No plan is waiting to edit. Say or type the request on its own. Nothing was executed.", true);
      settleVoiceAfterCommand();
      return;
    }
    if (!review.replacement) {
      setStatus("Say the complete replacement request after “Edit plan”. The current plan is still waiting for review.", true);
      settleVoiceAfterCommand();
      return;
    }
    text = review.replacement;
    forcePlanner = true;
    edited = true;
  }
  const isUndo = Boolean(review && review.kind === "undo");
  const plannerApi = globalThis.SeeyablePlanner || null;
  // Cached corrections resolve against the CURRENT sequence, so the cache
  // is taken (consumed) before this command bumps it.
  const correction = plannerApi && !forcePlanner && !isUndo ? takeCorrectionRequest(text) : null;
  // A new command invalidates any pending clarification choices and any
  // plan waiting for review (Issue #15: a superseding request).
  interactionSeq += 1;
  if (!state.confirmation) setConfirmStatus("");
  clearClarification();
  lastRun = null;
  plannerRecovery = false;
  const supersededPlan = discardPlanReview() && !edited;
  // Typed submission safely resolves any live recognition first:
  // the speech session is cancelled and its utterance discarded.
  if (source === "typed" && recognizer && recognizer.isActive()) recognizer.cancel();

  const resolved = forcePlanner || isUndo ? { kind: "unknown", normalized: voiceApi.normalizeCommandText(text) } : voiceApi.resolveCommand(text);
  if (resolved.kind === "empty") {
    presentCommandHelp(source === "voice" ? "No command was heard. " : "No command was entered. ");
    return;
  }
  // Local fast path (Issue #13): anchored click/fill resolved on-device
  // against the current snapshot. No planner, no network, no guessing.
  const commandsApi = globalThis.SeeyableCommands || null;
  const local = resolved.kind === "unknown" && commandsApi && !forcePlanner && !isUndo ? commandsApi.parseLocalCommand(text) : null;
  const isPageAction = Boolean(local && (local.kind === "click" || local.kind === "fill"));
  const isCorrection = Boolean(correction && correction.valid);
  // Issue #14: anything the fast path cannot shape goes to the planner
  // instead of the old unsupported branch — compounds included. Cached
  // corrections stay fully local (zero model calls).
  const isPlanner = Boolean(plannerApi) && !isUndo && !isCorrection && resolved.kind === "unknown" && !isPageAction;
  if (resolved.kind === "unknown" && !isPageAction && !isCorrection && !isPlanner && !isUndo) {
    presentCommandHelp(local && local.reason ? `Unsupported command — ${local.reason}. ` : "Unsupported command. ");
    return;
  }

  const gen = state.generation;
  const seq = interactionSeq;
  commandPending = true;
  updateExecuteEnabled(); // command dispatch holds the shared panel lock
  updateVoiceControls();
  if (source !== "voice") setVoiceState(VOICE_IDLE);
  else setVoiceState(isUndo ? "Voice: acting — undoing the last change…"
    : !isPageAction && !isPlanner && !isCorrection
      ? (resolved.kind === "show-tags" ? "Voice: acting — showing tags…" : "Voice: acting — hiding tags…")
      : isPlanner ? (edited ? "Voice: acting — planning your edit…" : "Voice: acting — planning…")
      : isCorrection ? "Voice: acting — trying the other one…"
      : `Voice: acting — ${local.kind === "click" ? "clicking" : "filling"} “${local.target}”…`);
  let outcome = null;
  try {
    if (resolved.kind === "show-tags") {
      outcome = await runShowTags({ viaCommand: true });
    } else if (isUndo) {
      outcome = await runUndoCommand(source, gen, seq);
    } else if (!isPageAction && !isPlanner && !isCorrection) {
      // Capture and retain the target tab now — even with no bound
      // snapshot — so a mid-dispatch switch cannot retarget the
      // command, and navigation/reload of that tab invalidates it.
      const tab = state.boundTabId !== null ? { id: state.boundTabId } : await activeTab();
      if (gen !== state.generation || seq !== interactionSeq) outcome = { ok: false, discarded: true, message: "" };
      else if (!tab || tab.id === undefined) outcome = { ok: false, message: "No active tab." };
      else {
        voiceTabId = tab.id;
        outcome = await runHideTags(tab.id, { viaCommand: true });
      }
    } else if (isCorrection) {
      outcome = await runCorrectionCommand(correction, source, gen, seq);
    } else if (isPlanner) {
      outcome = await runPlannerCommand(text, source, gen, seq, { edited, timing });
    } else {
      outcome = await runPageActionCommand(local, source, gen, seq);
    }
  } catch (err) {
    outcome = { ok: false, message: `Command failed: ${err.message || err}` };
  } finally {
    commandPending = false;
    if (!(recognizer && recognizer.isActive())) voiceTabId = null;
    updateExecuteEnabled();
  }

  finishCommandOutcome(outcome, {
    gen, seq,
    acting: isPageAction || isPlanner || isCorrection || isUndo,
    fallbackSummary: isPlanner ? "plan request" : isCorrection ? "correction request" : isUndo ? "undo last change" : local ? `${local.kind} ${local.target}` : "command",
    fallbackSpoken: resolved.spoken,
    notePrefix: supersededPlan ? "The earlier plan was discarded. " : "",
  });
}

// One start path for the main microphone, the speak prompts, and Alt+S:
// the same checks, the same session, the same review binding.
async function startListening() {
  if (!recognizer || !recognizer.supported()) {
    setVoiceState("Voice: error — speech recognition is not supported in this browser. Typed commands remain available.", true);
    return;
  }
  if (commandPending || state.pending || state.acquiring) {
    setVoiceState("Voice: error — another panel operation is in progress. Wait for it to finish, then try again.", true);
    return;
  }
  if (recognizer.isActive()) return; // repeated Start clicks are ignored
  if (speechOutput) speechOutput.stop(); // never transcribe our own feedback
  const gen = state.generation;
  const seq = interactionSeq;
  // Review authority is bound to what the user was looking at when they
  // intentionally pressed Start. Provider selection and microphone
  // permission may resolve later; a plan or held challenge that appears
  // during that delay must not retroactively become approvable by this
  // session, so both identities are captured here, before any await.
  const planIdAtStart = pendingPlan ? pendingPlan.id : null;
  const challengeIdAtStart = state.confirmation ? state.confirmation.challengeId : null;
  let tab = null;
  try { tab = await activeTab(); } catch { /* start is refused below if ownership changed */ }
  if (gen !== state.generation || seq !== interactionSeq) return;
  voiceTabId = tab && tab.id !== undefined ? tab.id : null;
  setTranscript(null);
  voicePhase = "starting";
  voiceErrorUnresolved = false; // a new attempt supersedes the prior error presentation
  setVoiceState("Voice: starting the microphone…");
  // Provider selection may be asynchronous (proxy status before any
  // capture). If ownership moved while it resolved, cancel whatever was
  // started and let no late session become review authority.
  const started = await recognizer.start();
  if (gen !== state.generation || seq !== interactionSeq) {
    if (started && recognizer.isActive()) recognizer.cancel();
    updateVoiceControls();
    return;
  }
  // Voice review authority is bound to this user-started session and to
  // the plan/challenge captured at Start above — never to one that
  // appeared while provider selection or permission was in flight.
  listenContext = started ? {
    sessionId: recognizer.sessionId,
    planId: planIdAtStart,
    challengeId: challengeIdAtStart,
    used: false,
  } : null;
  if (!started && !recognizer.isActive() && !voiceErrorUnresolved) {
    // A Start that never began (including Stop pressed during provider
    // selection, whose idle event may already have settled the phase)
    // settles back to truthful idle rather than leaving stale
    // starting/finishing text behind. A recognition error keeps its own
    // message (voiceErrorUnresolved) and is not overwritten here.
    voicePhase = "idle";
    setVoiceState(VOICE_IDLE);
  }
  updateVoiceControls();
}
$("btnListen").addEventListener("click", () => { void startListening(); });
for (const id of ["btnTalkPlan", "btnTalkGate", "btnTalkDone"]) {
  const btn = $(id);
  if (btn) btn.addEventListener("click", () => { void startListening(); });
}
// Alt+S starts talking while the panel has focus — never while a text
// field has focus, so typing (including Option+S "ß" on macOS) is never
// taken over. Panel-only: this listens on Seeyable's own page, not the
// web page, and adds no browser-wide shortcut.
document.addEventListener("keydown", (event) => {
  if (!event.altKey || event.ctrlKey || event.metaKey || event.code !== "KeyS" || event.repeat) return;
  const target = event.target;
  if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable)) return;
  if ($("btnListen").disabled || currentView() === "unavailable") return;
  event.preventDefault();
  showScreen("Assist");
  void startListening();
});

$("btnStopListen").addEventListener("click", () => {
  voicePhase = "finishing";
  voiceStopMarkMs = performance.now(); // Stop → final-transcript timing origin
  // Stop finishes the current utterance: a final result may still
  // arrive once and dispatch; the session then returns to idle.
  if (recognizer) recognizer.stop();
  setVoiceState("Voice: finishing the current utterance…");
  updateVoiceControls();
});

$("btnCancelListen").addEventListener("click", () => {
  // Cancel discards the utterance and invalidates any pending command
  // interaction, so a late acknowledgment is neither presented nor
  // spoken. A command already sent to the page may still have taken
  // effect there; that is stated, not hidden.
  cancelVoiceInteraction("listening and any pending command were cancelled. A command already sent to the page may still have taken effect; verify the page before continuing.");
});

$("btnSendCommand").addEventListener("click", async () => {
  refocusInput = true;
  const text = $("commandInput").value;
  $("commandInput").value = "";
  await dispatchCommand(text, "typed");
});
// Undo button: the same path as the spoken/typed "undo last change".
// Always offered; when nothing can be undone the executor says so.
$("btnUndo").addEventListener("click", async () => {
  await dispatchCommand("undo last change", "typed");
});
$("btnRecoverDeveloper").addEventListener("click", () => {
  plannerRecovery = false;
  setStatus("");
  $("developerView").open = true;
  showScreen("Settings");
  renderState();
  $("plannerHeading").focus();
});
// The extension's own Reload: a click on this button only, on the tab the
// panel found unreachable. Nothing is approved or replayed afterwards.
$("btnReloadPage").addEventListener("click", () => {
  if (!pageUnavailable || pageUnavailable.kind !== "reload") return;
  void chrome.tabs.reload(pageUnavailable.tabId);
});
void (async () => {
  try {
    const stored = await chrome.storage.session.get(["bridgeWanted"]);
    agentBridgeWanted = Boolean(stored && stored.bridgeWanted);
    renderState();
  } catch { /* stays generic */ }
})();
if (chrome.storage.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "session" || !("bridgeWanted" in changes)) return;
    agentBridgeWanted = Boolean(changes.bridgeWanted.newValue);
    renderState();
  });
}
$("btnNewRequest").addEventListener("click", () => {
  lastRun = null;
  plannerRecovery = false;
  renderState();
  $("commandInput").focus();
});
$("commandInput").addEventListener("keydown", async (event) => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  refocusInput = true;
  const text = $("commandInput").value;
  $("commandInput").value = "";
  await dispatchCommand(text, "typed");
});

$("chkSpeak").addEventListener("change", () => {
  if (speechOutput) speechOutput.setEnabled($("chkSpeak").checked);
});
$("btnStopSpeech").addEventListener("click", () => {
  // Stop speech silences current synthesis AND drops feedback still
  // held for microphone termination. The completed page command is
  // unaffected — nothing here cancels or reverses it.
  pendingSpoken = null;
  if (speechOutput) speechOutput.stop();
});
$("btnMicSetup").addEventListener("click", async () => {
  try {
    const url = chrome.runtime.getURL("mic-setup.html");
    if (chrome.tabs && typeof chrome.tabs.create === "function") await chrome.tabs.create({ url });
    else window.open(url, "_blank");
    setVoiceState("Voice: idle — complete the microphone setup in the opened tab, then return here and start listening again.");
  } catch (err) {
    setVoiceState(`Voice: error — could not open microphone setup: ${err.message || err}`, true);
  }
});

window.addEventListener("beforeunload", () => {
  interactionSeq += 1;
  if (recognizer && recognizer.isActive()) recognizer.cancel();
  if (speechOutput) speechOutput.stop();
});

if (!recognizer || !recognizer.supported()) {
  $("btnListen").disabled = true;
  $("voiceNote").textContent = "Speech recognition is not available in this browser, so voice input is disabled; typed commands remain fully available. Browser speech recognition may process audio outside this device — Seeyable stores no audio or transcripts.";
} else {
  $("voiceNote").textContent = metaVoiceApi
    ? "Voice input prefers Meta transcription when the planner proxy is paired and speech is configured; otherwise it uses browser recognition. The selected provider may process audio outside this device. Seeyable stores no audio or transcripts and never adds them to snapshot output."
    : "Recognition uses the browser Web Speech service, which may process audio outside this device. Seeyable stores no audio or transcripts and never adds them to snapshot output.";
}
if (speechOutput && !speechOutput.supported()) {
  $("voiceNote").textContent += " Spoken feedback is unavailable in this browser; visible feedback still works.";
}
updateVoiceControls();

/* --- Manual execution ------------------------------------------------------
 * Executes exactly the displayed snapshot's selection, once. After any
 * completed executor response the snapshot is refreshed from the same
 * captured tab; the execution result is preserved independently. Nothing
 * is retried automatically, and entered values are never persisted or
 * logged. */
function renderExecution(lines, response, verified = false) {
  lastExecVerified = verified;
  const parts = [...lines];
  if (response) parts.push("", JSON.stringify(response, null, 2));
  $("execResult").textContent = parts.join("\n");
  const latest = $("latestResult");
  if (latest) latest.textContent = lines.length ? `Latest result: ${lines[0]}` : "";
}

function isVerifiedResult(response) {
  const r = (response && response.ok && response.result) || {};
  return r.verified === true && !r.alreadyInDesiredState;
}
function isConfirmedOutcome(response) {
  const r = (response && response.ok && response.result) || {};
  return Boolean(r.alreadyInDesiredState) || r.verified === true;
}
function describeOutcome(response) {
  if (!response.ok) return `Failed: ${response.error.code} — ${response.error.message}`;
  const r = response.result || {};
  if (r.alreadyInDesiredState) return "Already in the desired state (verified after settling).";
  if (r.verified === true) return "Completed and verified against live page state.";
  if (r.dispatched) return "Activation dispatched — outcome NOT verified. This is not a confirmed completion.";
  return "Completed (see response details).";
}

async function refreshAfterExecution(tabId, gen, previousSession) {
  const myOp = ++state.opSeq; // supersedes any earlier acquisition
  state.opTabId = tabId;
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: "SEEYABLE_SNAPSHOT_DOM" });
    if (gen !== state.generation || myOp !== state.opSeq) return;
    if (!res || !res.ok) throw new Error((res && res.error) || "no response");
    const previousId = selectedTargetId();
    state.snapshot = res.snapshot;
    state.executorReady = true;
    state.boundTabId = tabId;
    const sameSession = previousSession && res.snapshot.documentSessionId === previousSession;
    populateTargets(res.snapshot, sameSession ? previousId : null);
    if (!sameSession || selectedTargetId() !== previousId) $("valueInput").value = "";
    lastKind = "dom-aria";
    showJson(res.snapshot, `${res.snapshot.elementCount} elements · rev ${res.snapshot.revision} · ${(res.snapshot.semanticHash || "").slice(0, 8)} · ${res.snapshot.url || ""}`);
  } catch (err) {
    if (gen !== state.generation || myOp !== state.opSeq) return;
    state.snapshot = null;
    state.executorReady = false;
    populateTargets(null, null);
    showJson({}, "Snapshot unavailable — reload the tab and take a fresh snapshot.");
    setStatus(`Execution finished, but the snapshot refresh failed: ${err.message || err}. Execution is disabled until a fresh snapshot succeeds.`, true);
  }
}

/* --- Shared single-execution pipeline ----------------------------------------
 * One orchestration for manual panel execution AND local voice/typed
 * commands (Issue #13). Sends exactly one SEEYABLE_EXECUTE_ACTION and
 * routes every outcome — discard, transport failure, malformed,
 * held-for-confirmation, completed — through the same confirmation
 * controller, refresh, and log fetch. Returns a UI-neutral outcome;
 * each caller presents it in its own surface.
 *
 * The caller owns the operation lock (state.pending for manual,
 * commandPending for commands) across the whole call, INCLUDING the
 * post-action snapshot refresh.
 *
 * ownerSeq carries command interaction ownership: commands pass the
 * interaction sequence captured at dispatch; manual execution passes
 * null (voice cancellation must not discard a manual run). Ownership
 * is rechecked before applying results, creating confirmation,
 * refreshing, or returning anything presentable. A late challenge
 * for a cancelled command is revoked through the trusted cancel
 * route and never becomes approvable. */
async function runExecutionPipeline(tabId, request, gen, ownerSeq = null) {
  let response = null;
  let transportError = null;
  try {
    response = await chrome.tabs.sendMessage(tabId, { type: "SEEYABLE_EXECUTE_ACTION", request });
  } catch (err) {
    transportError = err;
  }
  if (gen !== state.generation) {
    // Tab/document changed while in flight. The action may already have
    // been sent and may finish; report that honestly, but never let the
    // late response overwrite current state or authorize anything.
    return { outcome: "discarded" };
  }
  if (ownerSeq !== null && ownerSeq !== interactionSeq) {
    // The owning command was cancelled or superseded while awaiting
    // the executor. Revoke a late-created challenge so it can never
    // be approved here; anything already dispatched may still have
    // taken effect, which the caller reports honestly.
    if (response && !response.ok && response.error && response.error.code === "CONFIRMATION_REQUIRED" && response.confirmation) {
      try {
        await chrome.tabs.sendMessage(tabId, { type: "SEEYABLE_CANCEL_CHALLENGE", challengeId: response.confirmation.challengeId });
      } catch { /* revocation is best-effort; the challenge also expires */ }
      void fetchActionLog(tabId);
      return { outcome: "discarded", revoked: true };
    }
    return { outcome: "discarded" };
  }
  if (transportError) {
    state.executorReady = false; // require a successful refresh/snapshot to re-enable
    return { outcome: "transport", transportError };
  }
  if (!response || typeof response.ok !== "boolean") {
    state.executorReady = false;
    return { outcome: "malformed" };
  }
  if (!response.ok && response.error && response.error.code === "CONFIRMATION_REQUIRED" && response.confirmation) {
    // A held action, not an ordinary failure: nothing ran, the reviewed
    // request stays fixed, and no snapshot refresh (or replay) follows.
    // The human decides on the held action in the main card.
    showConfirmation(response.confirmation, tabId);
    void fetchActionLog(tabId);
    return { outcome: "held", response };
  }
  if (ownerSeq !== null && ownerSeq !== interactionSeq) return { outcome: "discarded" };
  // Fresh snapshot from the same captured tab; the caller's result
  // presentation is preserved. Refresh runs before returning so the
  // caller's lock covers it; failures mark execution disabled.
  await refreshAfterExecution(tabId, gen, request.documentSessionId);
  void fetchActionLog(tabId);
  // Raw codes and diffs live here; the status line stays in plain words.
  $("execResult").textContent = [describeOutcome(response), executionDiffLine(response), "", JSON.stringify(response, null, 2)].join("\n");
  return { outcome: "completed", response };
}

function executionDiffLine(response) {
  return response.newSnapshotDiff
    ? `Diff: +${response.newSnapshotDiff.added.length} added, -${response.newSnapshotDiff.removed.length} removed, ${response.newSnapshotDiff.updated.length} updated.`
    : `Diff unavailable: ${response.diffUnavailableReason || "not provided"}.`;
}

$("btnExecute").addEventListener("click", async () => {
  if (state.pending) return; // duplicate dispatch guard (rapid click / Enter)
  if (state.acquiring) { setExecStatus("A snapshot acquisition is in progress. Wait for it to finish, review the snapshot, then execute.", true); return; }
  if (commandPending) { setExecStatus("A voice/typed command is in progress. Wait for it to finish, review the snapshot, then execute.", true); return; }
  if (!state.snapshot || !state.executorReady) {
    setExecStatus("Take a DOM/ARIA snapshot through the content script before executing.", true);
    return;
  }
  const elementId = selectedTargetId();
  if (!elementId) { setExecStatus("Choose a target from the snapshot first.", true); return; }
  const action = $("actionSelect").value;
  const needsValue = action === "fill" || action === "select";
  const value = needsValue ? $("valueInput").value : undefined;
  const tabId = state.boundTabId;
  const gen = state.generation;
  const request = {
    action, elementId,
    documentSessionId: state.snapshot.documentSessionId,
    revision: state.snapshot.revision,
    value,
    source: "manual",
  };

  state.pending = true;
  updateExecuteEnabled();
  setExecStatus(`Executing ${action} on ${elementId}…`);
  try {
    const result = await runExecutionPipeline(tabId, request, gen);
    if (result.outcome === "discarded") {
      setExecStatus("The tab or document changed while the action was running. It may have completed on the page, but its response was discarded. Take a fresh snapshot and verify page state before acting again.", true);
    } else if (result.outcome === "transport") {
      renderExecution([
        `Transport failure: ${result.transportError.message || result.transportError}`,
        "The request may or may not have reached the page; nothing about the outcome is implied.",
        "Execution is paused. Refresh the snapshot, verify page state, then intentionally execute again.",
      ], null);
      setExecStatus("Transport failure — outcome unknown. Execution paused until you refresh the snapshot.", true);
    } else if (result.outcome === "malformed") {
      renderExecution(["Malformed executor response. Outcome unknown; refresh the snapshot before any further action."], null);
      setExecStatus("Malformed executor response. Execution paused.", true);
    } else if (result.outcome === "held") {
      renderExecution([
        "Confirmation required — nothing was executed. Review the held action in the main card, then Approve once or Cancel.",
        `Diff unavailable: ${result.response.diffUnavailableReason || "awaiting human confirmation"}.`,
      ], result.response);
      setExecStatus("Confirmation required. Nothing was executed.", false);
    } else {
      renderExecution([describeOutcome(result.response), executionDiffLine(result.response)], result.response, isVerifiedResult(result.response));
      setExecStatus(describeOutcome(result.response), !result.response.ok);
    }
  } finally {
    state.pending = false;
    updateExecuteEnabled();
    // The manual-operation lock has cleared: run any confirmation
    // discovery deferred behind it (e.g. an MCP hold hinted mid-refresh).
    drainAutoAcquire();
    drainDeferredAdoption();
  }
});

$("targetSelect").addEventListener("change", () => {
  $("valueInput").value = ""; // entered values do not follow a new target
  updateExecuteEnabled();
});
$("actionSelect").addEventListener("change", updateValueEnabled);

/* --- Safety gate: confirmation, Stop/Pause, action log (Feature #11) -----
 * The panel never mints approval. Approve sends only a challenge ID
 * over the sender-verified route; the executor (content script) holds
 * the capability, revalidates, and consumes it atomically. The
 * reviewed request is never reconstructed from current controls. */
let gateClosed = false; // paused or stopped, for the Pause/Resume label

function setGateStatus(text, isError) {
  const el = $("gateStatus");
  el.textContent = text;
  el.classList.toggle("error", Boolean(isError));
  renderState();
}
function setConfirmStatus(text, isError) {
  const el = $("confirmStatus");
  el.textContent = text || "";
  el.classList.toggle("error", Boolean(isError));
  renderState();
}

const CONFIRM_COUNTDOWN_MAX_MS = 10 * 60 * 1000;
let confirmCountdownTimer = null;
function stopCountdownTimer() {
  if (confirmCountdownTimer !== null) clearInterval(confirmCountdownTimer);
  confirmCountdownTimer = null;
}
function stopConfirmCountdown() {
  stopCountdownTimer();
  const el = $("confirmCountdown");
  if (el) el.hidden = true;
}
function renderConfirmCountdown(expiresAt) {
  const el = $("confirmCountdown");
  const left = Math.ceil((expiresAt - Date.now()) / 1000);
  if (left <= 0) {
    el.textContent = "This approval has expired. Cancel and ask again.";
    stopCountdownTimer();
    return;
  }
  el.textContent = `Expires in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
}
function startConfirmCountdown(expiresAt) {
  stopCountdownTimer();
  const el = $("confirmCountdown");
  if (!el) return;
  el.hidden = false;
  confirmCountdownTimer = setInterval(() => renderConfirmCountdown(expiresAt), 1000);
  renderConfirmCountdown(expiresAt);
}

let confirmFocusReturn = null;
let confirmFocusMoved = false;

function showConfirmation(confirmation, tabId) {
  state.confirmation = { challengeId: confirmation.challengeId, tabId, expiresAt: confirmation.expiresAt, elementId: confirmation.elementId };
  confirmFocusReturn = document.activeElement && document.contains(document.activeElement)
    ? document.activeElement : null;
  confirmFocusMoved = false;
  showScreen("Assist"); // a held action is always shown where it can be decided
  if (confirmation.elementId) {
    const next = Object.fromEntries(Object.entries(tagStates).filter(([, st]) => st === "done"));
    next[confirmation.elementId] = "held";
    sendTagStates(next, { tabId, session: confirmation.documentSessionId || (state.snapshot && state.snapshot.documentSessionId) });
  }
  // Presentation only: every line below is derived from the executor's
  // confirmation. The approved request and its binding live in the
  // executor and are referenced by challenge id alone, so shortening what
  // is shown here cannot shorten or alter what is approved.
  const target = confirmation.targetName || confirmation.elementId;
  const verb = confirmation.action ? confirmation.action.charAt(0).toUpperCase() + confirmation.action.slice(1) : "Run";
  $("confirmSummary").textContent = `${verb} \u201C${target}\u201D`;
  $("confirmQuestion").textContent = confirmation.targetQuestion ? `Question: ${confirmation.targetQuestion}` : "";
  $("confirmQuestion").hidden = !confirmation.targetQuestion;
  $("confirmPage").textContent = confirmationPageLine(confirmation.pageUrl);
  const expires = new Date(confirmation.expiresAt);
  const expiresText = Number.isNaN(expires.getTime()) ? "" : ` The approval expires at ${expires.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}.`;
  const copy = $("confirmCopy");
  const expiresAt = expires.getTime();
  if (expiresAt - Date.now() <= CONFIRM_COUNTDOWN_MAX_MS) {
    // A live countdown for sight; one description for screen readers, so
    // nothing is announced every second. The executor enforces the expiry.
    copy.textContent = "Nothing has run yet. Approving runs this one action once. ";
    const spoken = document.createElement("span");
    spoken.className = "sr-only";
    spoken.textContent = "The approval expires in about a minute.";
    copy.append(spoken);
    startConfirmCountdown(expiresAt);
  } else {
    stopConfirmCountdown();
    copy.textContent = `Nothing has run yet. Approving runs this one action once.${expiresText}`;
  }
  // Full, unshortened facts for anyone who wants them.
  const lines = [
    `Page: ${confirmation.pageUrl || "(current page)"}`,
    `Action: ${confirmation.action} on “${target}” (${confirmation.elementId})`,
  ];
  if (confirmation.targetQuestion) lines.push(`Question context: ${confirmation.targetQuestion}`);
  lines.push(confirmation.consequence || "This action is consequential.");
  lines.push(`Approval expires: ${confirmation.expiresAt}. Approving runs exactly this action once; it cannot be replayed.`);
  $("confirmText").textContent = lines.join("\n");
  $("confirmDetails").open = false;
  // A previous verified result must not read as success for this held
  // action: the latest-result line belongs to the earlier action.
  $("latestResult").textContent = "";
  lastRun = null;
  plannerRecovery = false;
  $("confirmBox").hidden = false;
  renderTargets(); // mark the held target in the list from authoritative state
  const title = $("confirmTitle");
  if (title && typeof title.focus === "function") {
    title.focus();
    confirmFocusMoved = document.activeElement === title;
  }
  setConfirmStatus(""); // the card itself says nothing has run; no duplicate line
  updateExecuteEnabled();
}

// "Page title · domain" for the card; the full URL stays in Details. The
// domain comes from the executor's confirmation; the title is the bound
// tab's title shown in the page card.
function confirmationPageLine(pageUrl) {
  let host = "";
  try { host = pageUrl ? new URL(pageUrl).hostname : ""; } catch { host = ""; }
  const title = (($("tabInfo") && $("tabInfo").textContent) || "").replace(/ \(execution bound to another tab\)$/, "").trim();
  const parts = [title && title !== "Current page" && title !== "—" ? title : "", host].filter(Boolean);
  return parts.length ? `On ${parts.join(" \u00B7 ")}` : "On the current page";
}

function clearConfirmation(statusText, isError, opts) {
  state.confirmation = null;
  stopConfirmCountdown();
  // "Held: waiting…" stops being true the moment the hold ends. The outcome
  // is reported once, in confirmStatus.
  if (statusAboutHold) setStatus("");
  if (Object.values(tagStates).includes("held")) {
    sendTagStates(Object.fromEntries(Object.entries(tagStates).filter(([, st]) => st !== "held")));
  }
  $("confirmBox").hidden = true;
  renderTargets();
  if (statusText !== undefined) setConfirmStatus(statusText, isError);
  if (confirmFocusMoved && (!opts || opts.restoreFocus !== false)) {
    confirmFocusMoved = false;
    if (confirmFocusReturn && document.contains(confirmFocusReturn) &&
        typeof confirmFocusReturn.focus === "function") {
      confirmFocusReturn.focus();
    }
    confirmFocusReturn = null;
  } else if (!opts || opts.restoreFocus !== false) {
    confirmFocusReturn = null;
  }
  updateExecuteEnabled();
}

const APPROVAL_STAGE_CODES = new Set([
  "APPROVAL_NOT_FOUND", "APPROVAL_EXPIRED", "APPROVAL_CONSUMED", "APPROVAL_INVALIDATED",
  "APPROVAL_CANCELLED", "EXECUTION_CANCELLED",
  "UNTRUSTED_APPROVAL", "EXECUTION_PAUSED", "EXECUTION_STOPPED", "EXECUTION_BUSY",
]);

/* --- Remote (MCP) confirmation adoption (Issue #19) -------------------------
 * A held action can originate outside this panel (the local MCP tools).
 * The executor in that tab's document stays authoritative: the panel
 * asks it for the pending challenge over the trusted route and shows
 * the existing card. The service worker's runtime hint only prompts
 * this lookup — it carries no authority — and binding a snapshot
 * re-checks, so a hold is also picked up when the panel was closed at
 * hold time. Adoption never displaces an operation already in flight,
 * a plan under review, or a confirmation already shown. */
// Lookup ownership is per tab and generation-scoped, never a single
// global flag: an in-flight lookup for tab A neither suppresses
// discovery for the newly bound tab B nor may populate the card once
// it is obsolete. A monotonically increasing sequence supersedes older
// lookups for the same tab. When discovery is deferred because an
// operation or a plan review owns the panel, the tab is remembered
// and retried when that blocker clears (see drainDeferredAdoption) —
// no polling, and focus moves only once the blocker has ended.
// (State variables live with the other panel state declarations.)
function adoptionBlocked() {
  return Boolean(state.confirmation || state.pending || state.acquiring || commandPending || pendingPlan);
}

async function adoptPendingConfirmation(tabId) {
  if (!Number.isInteger(tabId) || tabId !== state.boundTabId) {
    if (deferredAdoptTabId === tabId) deferredAdoptTabId = null;
    return;
  }
  if (adoptionBlocked()) { deferredAdoptTabId = tabId; return; }
  const seq = ++adoptLookupSeq;
  const gen = state.generation;
  adoptLookupsInFlight.set(tabId, seq);
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: "SEEYABLE_GET_PENDING_CONFIRMATION" });
    const stillCurrent = state.boundTabId === tabId && gen === state.generation
      && adoptLookupsInFlight.get(tabId) === seq;
    if (!stillCurrent) return; // obsolete lookup: discard; the newer tab/lookup owns discovery
    if (adoptionBlocked()) { deferredAdoptTabId = tabId; return; }
    if (res && res.ok && res.confirmation) {
      if (state.snapshot && res.confirmation.documentSessionId !== state.snapshot.documentSessionId) return;
      if (deferredAdoptTabId === tabId) deferredAdoptTabId = null;
      showConfirmation(res.confirmation, tabId);
    }
  } catch { /* content script unavailable; the hold still waits in the executor */ } finally {
    if (adoptLookupsInFlight.get(tabId) === seq) adoptLookupsInFlight.delete(tabId);
  }
}

// Runs a discovery that was deferred behind an operation or plan
// review once that blocker has cleared. Stale tabs are forgotten.
function drainDeferredAdoption() {
  if (deferredAdoptTabId === null) return;
  const tabId = deferredAdoptTabId;
  deferredAdoptTabId = null;
  if (tabId !== state.boundTabId) return;
  void adoptPendingConfirmation(tabId); // re-defers itself if still blocked
}

// The click and the bound voice phrase (Issue #15) share this one path:
// it approves only the challenge it was given, and only while that exact
// challenge is still the one displayed. Expiry, fingerprint binding,
// consumption, and final-dispatch validation stay in the executor.
async function approveHeldChallenge(expectedChallengeId) {
  if (!state.confirmation || state.pending || commandPending) return;
  if (!expectedChallengeId || state.confirmation.challengeId !== expectedChallengeId) return;
  const { challengeId, tabId } = state.confirmation;
  const gen = state.generation;
  const previousSession = state.snapshot ? state.snapshot.documentSessionId : null;
  state.pending = true;
  updateExecuteEnabled();
  setConfirmStatus("Approving once…");
  let response = null;
  let transportError = null;
  try {
    response = await chrome.tabs.sendMessage(tabId, { type: "SEEYABLE_APPROVE_CHALLENGE", challengeId });
  } catch (err) {
    transportError = err;
  }
  if (gen !== state.generation) {
    state.pending = false;
    setExecStatus("The tab or document changed while approval was running. Its response was discarded; verify page state before acting again.", true);
    updateExecuteEnabled();
    return;
  }
  clearConfirmation(undefined);
  if (transportError) {
    renderExecution([
      `Approval transport failure: ${transportError.message || transportError}`,
      "The approval may or may not have been consumed; the action may have run. Verify page state, then take a fresh snapshot before acting again.",
    ], null);
    setExecStatus("Approval transport failure — outcome unknown. Execution paused until you refresh the snapshot.", true);
    state.pending = false;
    state.executorReady = false;
    updateExecuteEnabled();
    return;
  }
  if (!response || typeof response.ok !== "boolean") {
    renderExecution(["Malformed approval response. Outcome unknown; refresh the snapshot before any further action."], null);
    setExecStatus("Malformed approval response. Execution paused.", true);
    state.pending = false;
    state.executorReady = false;
    updateExecuteEnabled();
    return;
  }
  const diffLine = response.newSnapshotDiff
    ? `Diff: +${response.newSnapshotDiff.added.length} added, -${response.newSnapshotDiff.removed.length} removed, ${response.newSnapshotDiff.updated.length} updated.`
    : `Diff unavailable: ${response.diffUnavailableReason || "not provided"}.`;
  renderExecution([describeOutcome(response), diffLine], response, isVerifiedResult(response));
  setExecStatus(describeOutcome(response), !response.ok);
  if (!response.ok && response.error && APPROVAL_STAGE_CODES.has(response.error.code)) {
    // The approval itself failed; nothing was dispatched.
    setConfirmStatus(`Approval did not run: ${response.error.code} — ${response.error.message}`, true);
    state.pending = false;
    updateExecuteEnabled();
    void fetchActionLog(tabId);
    void adoptPendingConfirmation(tabId); // surface any further waiting hold
    return;
  }
  setConfirmStatus(response.ok ? "Approved action finished. See the execution result above." : "Human approval was supplied and consumed; the action itself did not complete (see its code above). Request a fresh confirmation to try again.", !response.ok);
  try {
    await refreshAfterExecution(tabId, gen, previousSession);
  } finally {
    state.pending = false;
    updateExecuteEnabled();
  }
  void fetchActionLog(tabId);
  void adoptPendingConfirmation(tabId); // surface any further waiting hold
}
$("btnApproveOnce").addEventListener("click", () => {
  void approveHeldChallenge(state.confirmation && state.confirmation.challengeId);
});

$("btnCancelChallenge").addEventListener("click", async () => {
  if (!state.confirmation || state.pending) return;
  const { challengeId, tabId } = state.confirmation;
  clearConfirmation("Cancelling…");
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: "SEEYABLE_CANCEL_CHALLENGE", challengeId });
    if (res && res.cancelled === false && res.dispatched) {
      setConfirmStatus("Too late to cancel: the action was already dispatched to the page and cannot be recalled. Verify the page state before continuing.", true);
    } else {
      setConfirmStatus("Cancelled. The pending approval was revoked; nothing was executed by it.");
    }
  } catch {
    setConfirmStatus("Cancelled in the panel. The challenge also expires on its own within a minute; nothing was approved here.");
  }
  void fetchActionLog(tabId);
  void adoptPendingConfirmation(tabId); // surface any further waiting hold
});

async function gateTabId() {
  if (state.boundTabId !== null) return state.boundTabId;
  if (state.opTabId !== null) return state.opTabId;
  const tab = await activeTab();
  return tab && tab.id !== undefined ? tab.id : null;
}

async function sendGateCommand(command) {
  const tabId = await gateTabId();
  if (tabId === null) { setGateStatus("No tab is available for gate control. Open a normal page tab first.", true); return; }
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: "SEEYABLE_GATE_CONTROL", command });
    if (!res || !res.ok) {
      setGateStatus(`Gate ${command} failed: ${(res && res.error && res.error.message) || "no response"}. Reload the tab if the extension was just reloaded.`, true);
      return;
    }
    gateClosed = Boolean(res.gate.paused || res.gate.stopped);
    $("btnStopExec").textContent = gateClosed ? "Resume" : "Stop actions";
    setGateStatus(gateClosed
      ? "Gate: stopped. New actions and approvals are blocked, and pending approvals were withdrawn. Resume replays nothing."
      : "Gate: open.");
    if ((command === "stop" || command === "pause") && state.confirmation) {
      clearConfirmation(command === "stop"
        ? "Stopped: the pending approval was revoked. Nothing further will run from it."
        : "Paused: the pending approval was revoked. Resume replays nothing; request confirmation again.", true);
    }
  } catch (err) {
    setGateStatus(`Gate ${command} failed: ${err.message || err}. Reload the tab if the extension was just reloaded.`, true);
  }
  void fetchActionLog(tabId);
}

/* One Stop/Resume control (merged Stop and Pause). Stopping closes the
 * executor gate with `stop` and does every panel-side cleanup that Stop and
 * Pause each did before: live listening is cancelled (no late transcript
 * may start a command), the current interaction is invalidated, the planner
 * request is aborted, choices, cached corrections, and any plan under review
 * are discarded, and pending approvals are revoked by the executor. The
 * discard outcome is presented once, in #status; the voice line keeps
 * reporting the microphone only. Resume reopens the gate and replays
 * nothing. The executor's separate `pause` command is kept, unused here. */
const STOP_REASON = "execution was stopped; pending page commands, choices, and listening were discarded.";
$("btnStopExec").addEventListener("click", async () => {
  if (!state.confirmation) setConfirmStatus("");
  if (gateClosed) {
    await sendGateCommand("resume");
    return;
  }
  const hadPlan = discardPlanReview();
  cancelVoiceInteraction(); // bumps the interaction, aborts the planner, cancels listening
  discardMessage = STOP_REASON;
  pendingCorrection = null;
  clearClarification();
  lastRun = null;
  plannerRecovery = false;
  sendTagStates({});
  if (hadPlan && !commandPending) {
    setStatus("Plan discarded — execution was stopped. Nothing was executed, and Resume does not bring it back.", true);
  }
  await sendGateCommand("stop");
});

// Activity shows the same executor log entries in plain words, newest
// first. Entries carry names and decisions only; values never appear.
const DECISION_WORDS = {
  verified: "done, verified",
  "dispatched-unverified": "sent, not verified",
  "already-in-desired-state": "already set",
  completed: "done",
  "confirmation-required": "held for your approval",
  approved: "approved by you",
  "approval-cancelled": "approval cancelled",
  "approval-cancel-too-late": "too late to cancel",
  "approval-revoked-stop": "approval withdrawn by Stop",
  "approval-revoked-pause": "approval withdrawn by Pause",
  stopped: "stopped", paused: "paused", resumed: "resumed",
  EXECUTION_STOPPED: "not run, Seeyable was stopped",
  EXECUTION_PAUSED: "not run, Seeyable was paused",
  EXECUTION_CANCELLED: "cancelled before it ran",
  NOTHING_TO_UNDO: "nothing to undo",
  UNDO_NOT_REVERSIBLE: "cannot be undone",
  UNDO_CONFLICT: "not undone, it changed since",
  UNDO_STALE: "not undone, it changed since",
  UNDO_UNSUPPORTED: "cannot be undone",
  UNDO_NOT_VERIFIED: "undo sent, not verified",
  APPROVAL_EXPIRED: "approval expired",
  APPROVAL_NOT_FOUND: "approval no longer available",
  APPROVAL_CONSUMED: "approval already used",
  STALE_SNAPSHOT: "not run, the page changed",
};
const ACTION_WORDS = { "gate-stop": "Stop", "gate-resume": "Resume", "gate-pause": "Pause", undo: "Undo", scroll_to: "scroll to" };
// Unknown error codes read as "did not complete", never as success.
function decisionWords(decision) {
  if (DECISION_WORDS[decision]) return DECISION_WORDS[decision];
  return /^[A-Z_]+$/.test(decision || "") ? "did not complete" : decision;
}
function activityTime(timestamp) {
  const when = new Date(timestamp);
  return Number.isNaN(when.getTime()) ? "" : when.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
function activityTarget(entry) {
  if (entry.targetName) return ` \u201C${entry.targetName}\u201D`;
  if (!entry.elementId) return "";
  const known = state.snapshot && state.snapshot.elements.find((el) => el.id === entry.elementId);
  return known && known.name ? ` \u201C${known.name}\u201D` : ` target ${numberFromId(entry.elementId)}`;
}
function renderActivity(entries) {
  const list = $("activityList");
  if (!list) return;
  if (!entries || entries.length === 0) {
    const empty = document.createElement("p");
    empty.className = "sub";
    empty.textContent = "No activity yet.";
    list.replaceChildren(empty);
    return;
  }
  list.replaceChildren(...entries.slice().reverse().map((e) => {
    const row = document.createElement("div");
    row.className = "activity-row";
    const when = document.createElement("span");
    when.className = "when";
    when.textContent = activityTime(e.timestamp);
    const what = document.createElement("span");
    what.className = "what";
    what.textContent = `${ACTION_WORDS[e.action] || e.action}${activityTarget(e)} · ${e.source === "voice" ? "by voice" : e.source === "mcp" ? "by an assistant" : "by you"}`;
    const decision = document.createElement("span");
    decision.className = "decision";
    decision.textContent = decisionWords(e.decision);
    row.append(when, what, decision);
    return row;
  }));
}
function renderActionLog(entries) {
  $("actionLog").textContent = entries && entries.length
    ? entries.map((e) => `${e.timestamp} · ${e.source} · ${e.action} · ${e.elementId || "—"}${e.targetName ? ` “${e.targetName}”` : ""} · ${e.decision}${e.approved ? " · approved" : ""}`).join("\n")
    : "No log entries yet.";
  renderActivity(entries);
}
$("btnActivityRefresh").addEventListener("click", () => void fetchActionLog());

async function fetchActionLog(tabIdHint) {
  try {
    const tabId = tabIdHint !== undefined && tabIdHint !== null ? tabIdHint : await gateTabId();
    if (tabId === null || tabId === undefined) return;
    const res = await chrome.tabs.sendMessage(tabId, { type: "SEEYABLE_GET_ACTION_LOG" });
    if (res && res.ok) renderActionLog(res.entries);
  } catch { /* log becomes available once the content script connects */ }
}

$("btnRefreshLog").addEventListener("click", () => void fetchActionLog());
$("btnClearLog").addEventListener("click", async () => {
  const tabId = await gateTabId();
  if (tabId === null) { setGateStatus("No tab is available to clear the log.", true); return; }
  try {
    await chrome.tabs.sendMessage(tabId, { type: "SEEYABLE_CLEAR_ACTION_LOG" });
    renderActionLog([]);
  } catch (err) {
    setGateStatus(`Clear log failed: ${err.message || err}`, true);
  }
});

/* --- Tab/document ownership --- */
refreshTabInfo();
// Issue #19: the bridge service worker hints when an MCP action was held
// in some tab. The hint is unauthoritative (tab id only); adoption
// re-fetches the pending challenge over the trusted route.
if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onMessage
    && typeof chrome.runtime.onMessage.addListener === "function") {
  chrome.runtime.onMessage.addListener((message) => {
    if (message && message.type === "SEEYABLE_MCP_CONFIRMATION_HINT" && Number.isInteger(message.tabId)) {
      void adoptPendingConfirmation(message.tabId);
    }
    return false;
  });
}
chrome.tabs.onActivated.addListener((info) => {
  refreshTabInfo();
  // Speech that is only playing discards nothing: it just stops. Anything
  // else on the old tab is reported by the invalidation below.
  if ((recognizer && recognizer.isActive()) || commandPending) {
    cancelVoiceInteraction("listening and pending command results were discarded because the active tab changed.");
  } else if (speechOutput && speechOutput.isSpeaking()) {
    speechOutput.stop();
  }
  // Invalidate even when nothing is bound yet: an in-flight initial
  // snapshot for another tab must never populate or authorize. The
  // generation bump happens whenever the active tab differs from
  // anything the panel owns or is acquiring, so late responses for a
  // previous tab are always discarded; the explanatory status is only
  // shown when there was state to discard.
  const ownedTab = state.boundTabId !== null ? state.boundTabId : state.opTabId;
  if (info.tabId !== ownedTab) {
    // Work the switch throws away must stay reported; a plain error from the
    // other tab says nothing about this one, so a good snapshot may replace it.
    const discardedWork = Boolean(pendingPlan || pendingClarification || state.confirmation
      || commandPending || !$("planEditBox").hidden);
    invalidateExecution(ownedTab !== null || state.snapshot
      ? "Active tab changed. Anything waiting on the previous tab was discarded."
      : null);
    statusFromOtherTab = statusIsError && !discardedWork;
  }
  // Automatically bind a fresh snapshot for the newly active tab
  // (read-only; discovers any pending confirmation via the bind path).
  // Rapid switches retain only the latest intent.
  requestAutoSnapshot(info.tabId);
});
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.title || info.url || info.favIconUrl) refreshTabInfo();
  if ((info.status === "loading" || info.url) && voiceTabId !== null && tabId === voiceTabId) {
    cancelVoiceInteraction("listening was discarded because the tab navigated or reloaded.");
  }
  const ownedTab = state.boundTabId !== null ? state.boundTabId : state.opTabId;
  if (pageUnavailable && pageUnavailable.tabId === tabId && (info.status === "loading" || info.url)) {
    applyUnavailable(null);
  }
  if (ownedTab !== null && tabId === ownedTab && (info.status === "loading" || info.url)) {
    const discardedWork = Boolean(pendingPlan || pendingClarification || state.confirmation
      || commandPending || !$("planEditBox").hidden);
    invalidateExecution("The page navigated or reloaded, so anything waiting on it was discarded.");
    statusFromOtherTab = statusIsError && !discardedWork;
  }
  // A finished load in the tab being shown binds it (the same read-only
  // automatic path as switching tabs), so the panel never stays on an
  // unavailable or stale view after a navigation.
  if (info.status === "complete") {
    const gen = state.generation;
    void activeTab().then((tab) => {
      if (tab && tab.id === tabId && gen === state.generation) requestAutoSnapshot(tabId);
    }).catch(() => {});
  }
});
renderTargets(); // empty state until the first snapshot binds
updateExecuteEnabled();
// Panel open: automatically acquire the active tab's snapshot (same
// read-only auto path as tab activation; deduplicated against manual
// acquisition by the shared locks and the bound-tab check). Ownership
// is captured BEFORE the asynchronous lookup: a newer activation,
// navigation, or acquisition supersedes this intent, and its late
// result is discarded without submitting any intent at all.
void (async () => {
  const startupGen = state.generation;
  const startupOp = state.opSeq;
  try {
    const tab = await activeTab();
    if (startupGen !== state.generation || startupOp !== state.opSeq) return; // superseded while looking up
    if (state.boundTabId !== null || state.snapshot) return; // a newer binding already owns the panel
    if (tab && Number.isInteger(tab.id)) requestAutoSnapshot(tab.id);
  } catch { /* the tab line already reports unavailability */ }
})();
