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

function setStatus(text, isError) {
  const el = $("status");
  el.textContent = text;
  el.classList.toggle("error", Boolean(isError));
  console.info("[seeyable panel]", text);
  renderState();
}
function setExecStatus(text, isError) {
  const el = $("execStatus");
  el.textContent = text;
  el.classList.toggle("error", Boolean(isError));
  renderState();
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
  } catch { /* panel may open before tabs settle */ }
}

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

// Discovery shortcut next to the main interaction: move keyboard focus
// (and scroll) to the Targets heading so the list is one activation away.
{
  const viewBtn = $("btnViewTargets");
  if (viewBtn) viewBtn.addEventListener("click", () => {
    const heading = $("targetsHeading");
    if (heading) heading.focus();
  });
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
    button.textContent = `${numberFromId(element.id)} · ${label}${marks.length ? ` ${marks.join(" ")}` : ""}`;
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
 * panel's current DOM text and ownership flags. It never touches
 * ownership, locks, requests, or approval authority. */
function renderState() {
  const chip = $("stateChip");
  if (chip) {
    const statusEl = $("status");
    const execText = $("execResult") ? $("execResult").textContent : "";
    const voice = $("voiceState") ? $("voiceState").textContent : "";
    let cls = "";
    let label = "Ready";
    if (state.confirmation) { label = "\u25B2 Held \u2014 nothing sent"; cls = "is-held"; }
    else if (state.pending || commandPending) { label = "\u25CF Acting"; cls = "is-acting"; }
    else if (state.acquiring) { label = "\u25CF Working"; cls = "is-acting"; }
    else if (voicePhase === "listening") { label = "Listening"; cls = "is-listening"; }
    else if (voicePhase === "starting") { label = "Starting"; cls = "is-listening"; }
    else if (voicePhase === "finishing") { label = "Finishing"; cls = "is-listening"; }
    else if (gateClosed) { label = /paused/i.test(($("gateStatus") || {}).textContent || "") ? "Paused" : "Stopped"; cls = "is-error"; }
    else if ((statusEl && statusEl.classList.contains("error"))
      || ($("execStatus") && $("execStatus").classList.contains("error"))
      || (/^Failed/.test(execText))
      || (($("confirmStatus") && $("confirmStatus").classList.contains("error"))
        && !/^Completed and verified/.test(execText))
      || voiceErrorUnresolved) { label = "\u00D7 Needs attention"; cls = "is-error"; }
    else if (/^Completed and verified/.test(execText)) { label = "\u25A0 Done"; cls = "is-success"; }
    chip.className = "chip" + (cls ? " " + cls : "");
    chip.textContent = label;
  }
  document.body.dataset.voice = voicePhase === "listening" ? "listening"
    : voicePhase === "starting" || voicePhase === "finishing" ? "finishing" : "idle";
  document.body.dataset.voiceError = voiceErrorUnresolved ? "true" : "false";
  const voiceEl = $("voiceState");
  document.body.dataset.voiceMsg = voiceEl && voiceEl.textContent === "Voice: idle." ? "quiet" : "shown";
  const transcriptEl = $("voiceTranscript");
  document.body.dataset.transcript = !transcriptEl || /^Transcript:/.test(transcriptEl.textContent) ? "empty" : "shown";
  const heroHeading = $("commandHeading");
  if (heroHeading) heroHeading.textContent = voicePhase === "listening" ? "Listening"
    : voicePhase === "finishing" ? "Finishing" : "Ready when you are.";
  if (typeof updateVoiceControls === "function") updateVoiceControls();
}

function updateValueEnabled() {
  const action = $("actionSelect").value;
  $("valueInput").disabled = !(action === "fill" || action === "select") || state.pending;
}
function updateExecuteEnabled() {
  const ready = Boolean(state.snapshot && state.executorReady && !state.pending && !state.acquiring && !commandPending && !state.confirmation && selectedTargetId());
  $("btnExecute").disabled = !ready;
  $("targetSelect").disabled = state.pending || commandPending || Boolean(state.confirmation) || !state.snapshot;
  $("actionSelect").disabled = state.pending || commandPending || Boolean(state.confirmation);
  const approveBtn = $("btnApproveOnce");
  if (approveBtn) approveBtn.disabled = !state.confirmation || state.pending;
  const cancelBtn = $("btnCancelChallenge");
  if (cancelBtn) cancelBtn.disabled = !state.confirmation || state.pending;
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
  meta.textContent = "No snapshot yet";
}

function invalidateExecution(reason) {
  state.generation += 1;
  cancelVoiceInteraction();
  const tagsChip = $("tagsChip");
  if (tagsChip) tagsChip.textContent = "Tags: unknown";
  if (state.confirmation) {
    const held = state.confirmation;
    try {
      const sent = chrome.tabs.sendMessage(held.tabId, { type: "SEEYABLE_CANCEL_CHALLENGE", challengeId: held.challengeId });
      if (sent && typeof sent.catch === "function") sent.catch(() => {});
    } catch { /* the document is gone; its challenges died with it */ }
    clearConfirmation("The pending confirmation was discarded because the tab or document changed. If its action had already been dispatched to the page, it may still have taken effect; verify page state before continuing.", true, { restoreFocus: false });
  }
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

async function takeSnapshot(originLabel) {
  if (state.pending || state.acquiring || commandPending) return; // mutually exclusive with execution/acquisition/commands; no queue
  // Identity is captured BEFORE any asynchronous work (incl. tab lookup),
  // and ownership is retained until the whole acquisition settles.
  const gen = state.generation;
  const myOp = ++state.opSeq;
  state.acquiring = true;
  updateExecuteEnabled();
  try {
    const tab = await activeTab();
    if (!tab || tab.id === undefined) { setStatus("No active tab.", true); return; }
    if (gen !== state.generation || myOp !== state.opSeq) return;
    state.opTabId = tab.id;
    setStatus(`${originLabel}…`);
    const { snapshot, viaContentScript } = await fetchSnapshot(tab.id);
    if (gen !== state.generation || myOp !== state.opSeq) return; // invalidated or superseded
    bindSnapshot(tab.id, snapshot, viaContentScript);
    lastKind = "dom-aria";
    const fresh = snapshot.fresh === false ? " · STALE" : "";
    showJson(snapshot, `${snapshot.elementCount} elements · rev ${snapshot.revision} · ${(snapshot.semanticHash || "").slice(0, 8)}${fresh} · ${snapshot.url || ""}`);
    if (viaContentScript) {
      setStatus(`Found ${snapshot.elementCount} controls on this page.`);
    } else {
      setStatus("Snapshot obtained through the scripting fallback. Execution is disabled: reload the tab and reopen the panel so the full content script is available.", true);
    }
  } catch (err) {
    if (gen !== state.generation || myOp !== state.opSeq) return;
    // A failed refresh must not leave the previous snapshot execution-ready.
    if (state.snapshot) state.executorReady = false;
    console.error(err);
    setStatus(`DOM snapshot failed: ${err.message || err}`, true);
  } finally {
    if (myOp === state.opSeq) {
      state.acquiring = false;
      state.opTabId = null;
    }
    updateExecuteEnabled();
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
          showJson(snapshot, `${snapshot.elementCount} elements · rev ${snapshot.revision} · ${snapshot.url || ""}`);
          lastKind = "dom-aria";
        } catch { /* tags still shown; execution binding stays unset */ }
      }
      // Crowded-out targets (no whitespace for a floating tag) stay
      // discoverable in the Targets list, marked "Shown in panel".
      unplacedIds = new Set(Array.isArray(res.unplaced) ? res.unplaced : []);
      if (gen !== state.generation || myOp !== state.opSeq) return { ok: false, discarded: true, message: "" };
      const chip = $("tagsChip");
      // Visibility only: placement changes as the page scrolls/resizes
      // and the panel gets no live recount, so a number here would go
      // stale. The chip states the durable fact (tags on), nothing more.
      if (chip) chip.textContent = "Tags: on";
      renderTargets(); // refresh "Shown in panel" marks from this show's report
      if (unplacedIds.size > 0) {
        return { ok: true, message: `Tags shown (${res.total} controls, revision ${res.revision}). Some word tags stay in the panel \u2014 see Targets.` };
      }
      return { ok: true, message: `Tags shown (${res.total} controls, revision ${res.revision}).` };
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
      const chip = $("tagsChip");
      if (chip) chip.textContent = "Tags: off";
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

/* --- Voice and typed commands (Feature #10) --------------------------------
 * One dispatcher for voice and typed input. Commands only show/hide
 * tags through the shared flows above — never the executor. Nothing is
 * stored or logged: transcripts live only in the visible transcript
 * line until replaced or invalidated. */
const voiceApi = globalThis.SeeyableVoice || null;
let commandPending = false;
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

const speechOutput = voiceApi
  ? voiceApi.createSpeechOutput({ speechSynthesis: window.speechSynthesis, SpeechSynthesisUtterance: window.SpeechSynthesisUtterance })
  : null;

function setVoiceState(text, isError) {
  const el = $("voiceState");
  if (!el) return;
  el.textContent = text;
  el.classList.toggle("error", Boolean(isError));
  renderState();
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
  // Suggestion chips dispatch through the same typed flow and lock.
  for (const id of ["btnTryShow", "btnTryHide"]) {
    const btn = $(id);
    if (btn) btn.disabled = commandPending || panelBusy;
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

const recognizer = voiceApi
  ? voiceApi.createRecognitionController({
      window,
      handlers: {
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
            setVoiceState("Voice: idle.");
          }
          updateVoiceControls();
          flushPendingSpoken(); // session ended: microphone is closed
        },
        onInterim: ({ text }) => { $("voiceTranscript").textContent = `Heard so far: ${text}`; },
        onFinal: ({ text }) => {
          $("voiceTranscript").textContent = text ? `Heard: ${text}` : "Heard: (no speech)";
          voicePhase = "finishing";
          // The one accepted utterance ends the session's purpose:
          // wind recognition down now; feedback waits for its end.
          if (recognizer) recognizer.stop();
          void dispatchCommand(text, "voice");
        },
        onError: ({ message }) => {
          voicePhase = "idle";
          voiceErrorUnresolved = true;
          setVoiceState(`Voice: error — ${message}`, true);
          updateVoiceControls();
          flushPendingSpoken(); // error also terminates the microphone
        },
      },
    })
  : null;

function cancelVoiceInteraction(reason) {
  interactionSeq += 1;
  voicePhase = "idle";
  voiceErrorUnresolved = false; // intentional cancellation is not a recognition failure
  discardMessage = reason || null;
  pendingSpoken = null;
  if (recognizer && recognizer.isActive()) recognizer.cancel();
  if (speechOutput) speechOutput.stop();
  voiceTabId = null;
  const transcript = $("voiceTranscript");
  if (transcript) transcript.textContent = "Transcript: —";
  if (reason) setVoiceState(`Voice: idle — ${reason}`, true);
  if (typeof updateVoiceControls === "function") updateVoiceControls();
}

function presentCommandHelp(prefix) {
  const message = `${prefix}Supported commands: "show tags" and "hide tags".`;
  setVoiceState(`Voice: error — ${message}`, true);
  setStatus(message, true);
}

async function dispatchCommand(rawText, source) {
  if (!voiceApi) return;
  if (commandPending) {
    setVoiceState("Voice: error — a command is already running; nothing was queued.", true);
    return;
  }
  if (state.pending || state.acquiring) {
    setVoiceState("Voice: error — another panel operation is in progress. Wait for it to finish, then send the command again.", true);
    return;
  }
  // Typed submission safely resolves any live recognition first:
  // the speech session is cancelled and its utterance discarded.
  if (source === "typed" && recognizer && recognizer.isActive()) recognizer.cancel();

  const resolved = voiceApi.resolveCommand(rawText);
  if (resolved.kind === "empty") {
    presentCommandHelp(source === "voice" ? "No command was heard. " : "No command was entered. ");
    return;
  }
  if (resolved.kind === "unknown") {
    presentCommandHelp("Unsupported command. ");
    return;
  }

  const gen = state.generation;
  const seq = interactionSeq;
  commandPending = true;
  updateExecuteEnabled(); // command dispatch holds the shared panel lock
  updateVoiceControls();
  setVoiceState(resolved.kind === "show-tags" ? "Voice: acting — showing tags…" : "Voice: acting — hiding tags…");
  let outcome = null;
  try {
    if (resolved.kind === "show-tags") {
      outcome = await runShowTags({ viaCommand: true });
    } else {
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
    }
  } catch (err) {
    outcome = { ok: false, message: `Command failed: ${err.message || err}` };
  } finally {
    commandPending = false;
    if (!(recognizer && recognizer.isActive())) voiceTabId = null;
    updateExecuteEnabled();
  }

  if (!outcome || outcome.discarded || gen !== state.generation || seq !== interactionSeq) {
    // The interaction moved on (tab/document change, cancellation):
    // never present or speak the late result as acting on this page.
    voicePhase = recognizer && recognizer.isActive() ? "finishing" : "idle";
    const reason = discardMessage;
    discardMessage = null;
    pendingSpoken = null;
    setVoiceState(reason
      ? `Voice: idle — ${reason}`
      : "Voice: idle — the tab or document changed while the command was running; its result was discarded.", true);
    updateVoiceControls();
    return;
  }
  discardMessage = null;
  voicePhase = recognizer && recognizer.isActive() ? "finishing" : "idle";
  setStatus(outcome.message, !outcome.ok);
  if (outcome.ok) {
    // A completed command is recovery from any prior recognition error.
    voiceErrorUnresolved = false;
    // While recognition is still winding down, say so — the
    // microphone has not closed yet and must not be reported idle.
    setVoiceState(recognizer && recognizer.isActive()
      ? "Voice: finishing — waiting for the microphone to close…"
      : "Voice: idle.");
    // Spoken success only after the page acknowledged the command,
    // and only once any active microphone has terminated.
    speakFeedback(resolved.spoken);
  } else {
    setVoiceState(`Voice: error — ${outcome.message}`, true);
  }
  updateVoiceControls();
}

$("btnListen").addEventListener("click", async () => {
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
  let tab = null;
  try { tab = await activeTab(); } catch { /* start is refused below if ownership changed */ }
  if (gen !== state.generation || seq !== interactionSeq) return;
  voiceTabId = tab && tab.id !== undefined ? tab.id : null;
  $("voiceTranscript").textContent = "Transcript: —";
  voicePhase = "starting";
  voiceErrorUnresolved = false; // a new attempt supersedes the prior error presentation
  setVoiceState("Voice: starting the microphone…");
  recognizer.start();
  updateVoiceControls();
});

$("btnStopListen").addEventListener("click", () => {
  voicePhase = "finishing";
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
  const text = $("commandInput").value;
  $("commandInput").value = "";
  await dispatchCommand(text, "typed");
});
// Suggestion chips offer only the two supported commands, dispatched
// through the same shared typed flow (same locks, same ownership).
for (const [buttonId, command] of [["btnTryShow", "show tags"], ["btnTryHide", "hide tags"]]) {
  const chip = $(buttonId);
  if (chip) chip.addEventListener("click", async () => {
    $("commandInput").value = "";
    await dispatchCommand(command, "typed");
  });
}
$("commandInput").addEventListener("keydown", async (event) => {
  if (event.key !== "Enter") return;
  event.preventDefault();
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
  $("voiceNote").textContent = "Recognition uses the browser Web Speech service, which may process audio outside this device. Seeyable stores no audio or transcripts and never adds them to snapshot output.";
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
function renderExecution(lines, response) {
  const parts = [...lines];
  if (response) parts.push("", JSON.stringify(response, null, 2));
  $("execResult").textContent = parts.join("\n");
  const latest = $("latestResult");
  if (latest) latest.textContent = lines.length ? `Latest result: ${lines[0]}` : "";
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
    state.pending = false;
    setExecStatus("The tab or document changed while the action was running. It may have completed on the page, but its response was discarded. Take a fresh snapshot and verify page state before acting again.", true);
    updateExecuteEnabled();
    return;
  }

  if (transportError) {
    renderExecution([
      `Transport failure: ${transportError.message || transportError}`,
      "The request may or may not have reached the page; nothing about the outcome is implied.",
      "Execution is paused. Refresh the snapshot, verify page state, then intentionally execute again.",
    ], null);
    setExecStatus("Transport failure — outcome unknown. Execution paused until you refresh the snapshot.", true);
    state.pending = false;
    state.executorReady = false; // require a successful refresh/snapshot to re-enable
    updateExecuteEnabled();
    return;
  }
  if (!response || typeof response.ok !== "boolean") {
    renderExecution(["Malformed executor response. Outcome unknown; refresh the snapshot before any further action."], null);
    setExecStatus("Malformed executor response. Execution paused.", true);
    state.pending = false;
    state.executorReady = false;
    updateExecuteEnabled();
    return;
  }

  if (!response.ok && response.error && response.error.code === "CONFIRMATION_REQUIRED" && response.confirmation) {
    // A held action, not an ordinary failure: nothing ran, the reviewed
    // request stays fixed, and no snapshot refresh (or replay) follows.
    // The human decides in the Safety gate section.
    renderExecution([
      "Confirmation required — nothing was executed. Review the pending action in the Safety gate section, then Approve once or Cancel.",
      `Diff unavailable: ${response.diffUnavailableReason || "awaiting human confirmation"}.`,
    ], response);
    setExecStatus("Confirmation required. Nothing was executed.", false);
    showConfirmation(response.confirmation, tabId);
    state.pending = false;
    updateExecuteEnabled();
    void fetchActionLog(tabId);
    return;
  }

  const diffLine = response.newSnapshotDiff
    ? `Diff: +${response.newSnapshotDiff.added.length} added, -${response.newSnapshotDiff.removed.length} removed, ${response.newSnapshotDiff.updated.length} updated.`
    : `Diff unavailable: ${response.diffUnavailableReason || "not provided"}.`;
  renderExecution([describeOutcome(response), diffLine], response);
  setExecStatus(describeOutcome(response), !response.ok);
  updateExecuteEnabled();

  // Fresh snapshot from the same captured tab; result above is preserved.
  // The operation lock is held through this refresh and released only
  // afterward, on success, failure, or invalidation alike.
  try {
    await refreshAfterExecution(tabId, gen, request.documentSessionId);
  } finally {
    state.pending = false;
    updateExecuteEnabled();
  }
  void fetchActionLog(tabId);
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

let confirmFocusReturn = null;
let confirmFocusMoved = false;

function showConfirmation(confirmation, tabId) {
  state.confirmation = { challengeId: confirmation.challengeId, tabId, expiresAt: confirmation.expiresAt, elementId: confirmation.elementId };
  confirmFocusReturn = document.activeElement && document.contains(document.activeElement)
    ? document.activeElement : null;
  confirmFocusMoved = false;
  const lines = [
    `Page: ${confirmation.pageUrl || "(current page)"}`,
    `Action: ${confirmation.action} on “${confirmation.targetName || confirmation.elementId}” (${confirmation.elementId})`,
  ];
  if (confirmation.targetQuestion) lines.push(`Question context: ${confirmation.targetQuestion}`);
  lines.push(confirmation.consequence || "This action is consequential.");
  lines.push(`Approval expires: ${confirmation.expiresAt}. Approving runs exactly this action once; it cannot be replayed.`);
  $("confirmText").textContent = lines.join("\n");
  $("confirmBox").hidden = false;
  renderTargets(); // mark the held target in the list from authoritative state
  const title = $("confirmTitle");
  if (title && typeof title.focus === "function") {
    title.focus();
    confirmFocusMoved = document.activeElement === title;
  }
  setConfirmStatus("Waiting for your decision. Nothing has been executed.");
  updateExecuteEnabled();
}

function clearConfirmation(statusText, isError, opts) {
  state.confirmation = null;
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

$("btnApproveOnce").addEventListener("click", async () => {
  if (!state.confirmation || state.pending) return;
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
  renderExecution([describeOutcome(response), diffLine], response);
  setExecStatus(describeOutcome(response), !response.ok);
  if (!response.ok && response.error && APPROVAL_STAGE_CODES.has(response.error.code)) {
    // The approval itself failed; nothing was dispatched.
    setConfirmStatus(`Approval did not run: ${response.error.code} — ${response.error.message}`, true);
    state.pending = false;
    updateExecuteEnabled();
    void fetchActionLog(tabId);
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
    $("btnPauseExec").textContent = gateClosed ? "Resume" : "Pause";
    setGateStatus(res.gate.stopped
      ? "Gate: stopped. Execution and approvals are blocked until Resume."
      : res.gate.paused
        ? "Gate: paused. New execution is blocked and pending approvals were revoked; Resume replays nothing."
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

$("btnStopExec").addEventListener("click", async () => {
  // Executor Stop also silences voice: no late transcript may start
  // another command after stopping. "Stop listening" is separate.
  cancelVoiceInteraction("execution was stopped; listening and any pending voice interaction were discarded.");
  await sendGateCommand("stop");
});
$("btnPauseExec").addEventListener("click", async () => {
  await sendGateCommand(gateClosed ? "resume" : "pause");
});

function renderActionLog(entries) {
  $("actionLog").textContent = entries && entries.length
    ? entries.map((e) => `${e.timestamp} · ${e.source} · ${e.action} · ${e.elementId || "—"}${e.targetName ? ` “${e.targetName}”` : ""} · ${e.decision}${e.approved ? " · approved" : ""}`).join("\n")
    : "No log entries yet.";
}

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
chrome.tabs.onActivated.addListener((info) => {
  refreshTabInfo();
  if ((recognizer && recognizer.isActive()) || commandPending || (speechOutput && speechOutput.isSpeaking())) {
    cancelVoiceInteraction("listening and pending command results were discarded because the active tab changed.");
  }
  // Invalidate even when nothing is bound yet: an in-flight initial
  // snapshot for another tab must never populate or authorize.
  const ownedTab = state.boundTabId !== null ? state.boundTabId : state.opTabId;
  if (ownedTab !== null && info.tabId !== ownedTab) {
    invalidateExecution("Active tab changed. The previous execution selection was discarded; take a snapshot in this tab.");
  }
});
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.title || info.url) refreshTabInfo();
  if ((info.status === "loading" || info.url) && voiceTabId !== null && tabId === voiceTabId) {
    cancelVoiceInteraction("listening was discarded because the tab navigated or reloaded.");
  }
  const ownedTab = state.boundTabId !== null ? state.boundTabId : state.opTabId;
  if (ownedTab !== null && tabId === ownedTab && (info.status === "loading" || info.url)) {
    invalidateExecution("The tab navigated or reloaded. The previous execution selection was discarded; take a fresh snapshot.");
  }
});
renderTargets(); // empty state until the first snapshot binds
updateExecuteEnabled();
