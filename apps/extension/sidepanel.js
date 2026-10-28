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
};

function setStatus(text, isError) {
  const el = $("status");
  el.textContent = text;
  el.classList.toggle("error", Boolean(isError));
  console.info("[seeyable panel]", text);
}
function setExecStatus(text, isError) {
  const el = $("execStatus");
  el.textContent = text;
  el.classList.toggle("error", Boolean(isError));
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
    const label = tab && tab.title ? tab.title : tab ? `Tab ${tab.id}` : "—";
    const bound = state.boundTabId !== null && tab && tab.id !== state.boundTabId ? " (execution bound to another tab)" : "";
    $("tabInfo").textContent = tab ? `Active tab: ${label}${bound}` : "Active tab: —";
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
  updateExecuteEnabled();
}

function selectedTargetId() {
  return $("targetSelect").value || null;
}

function updateValueEnabled() {
  const action = $("actionSelect").value;
  $("valueInput").disabled = !(action === "fill" || action === "select") || state.pending;
}
function updateExecuteEnabled() {
  const ready = Boolean(state.snapshot && state.executorReady && !state.pending && !state.acquiring && !commandPending && selectedTargetId());
  $("btnExecute").disabled = !ready;
  $("targetSelect").disabled = state.pending || commandPending || !state.snapshot;
  $("actionSelect").disabled = state.pending || commandPending;
  // Conflicting snapshot/binding operations stay locked through the
  // post-action refresh, not just until the executor responds.
  for (const id of ["btnDom", "btnRefresh", "btnShowTags", "btnHideTags", "btnHighlight", "btnCdp"]) {
    const btn = $(id);
    if (btn) btn.disabled = state.pending || commandPending;
  }
  updateValueEnabled();
  if (typeof updateVoiceControls === "function") updateVoiceControls();
}

function bindSnapshot(tabId, snapshot, viaContentScript) {
  const previousId = selectedTargetId();
  const previousSession = state.snapshot ? state.snapshot.documentSessionId : null;
  const preserveId = previousSession && snapshot.documentSessionId === previousSession ? previousId : null;
  state.boundTabId = tabId;
  state.snapshot = snapshot;
  state.executorReady = viaContentScript;
  populateTargets(snapshot, preserveId);
  if (selectedTargetId() !== preserveId) $("valueInput").value = "";
}

function invalidateExecution(reason) {
  state.generation += 1;
  cancelVoiceInteraction();
  state.opTabId = null;
  state.snapshot = null;
  state.executorReady = false;
  state.boundTabId = null;
  $("valueInput").value = "";
  populateTargets(null, null);
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
      setStatus(`DOM/ARIA snapshot done: ${snapshot.elementCount} interactive elements (revision ${snapshot.revision}).`);
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
      if (gen !== state.generation || myOp !== state.opSeq) return { ok: false, discarded: true, message: "" };
      return { ok: true, message: `Tags shown: ${res.shown} in viewport (${res.total} controls, revision ${res.revision}).` };
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
    if (res && res.ok) return { ok: true, message: "Tags hidden. Highlighting by number still works." };
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

$("btnHighlight").addEventListener("click", async () => {
  if (state.pending || state.acquiring || commandPending) { setStatus("Another panel operation is in progress. Wait for it to finish, then try again.", true); return; }
  const raw = $("highlightInput").value.trim();
  const num = raw.replace(/^el-/i, "");
  if (!/^\d+$/.test(num)) { setStatus("Enter a target number from a DOM snapshot (e.g. 22).", true); return; }
  if (!state.snapshot) { setStatus("Take a DOM/ARIA snapshot first so the target session is known.", true); return; }
  try {
    const res = await chrome.tabs.sendMessage(state.boundTabId, {
      type: "SEEYABLE_HIGHLIGHT_ID",
      elementId: `el-${num}`,
      documentSessionId: state.snapshot.documentSessionId,
      revision: state.snapshot.revision,
    });
    if (res && res.ok) setStatus(`Highlighted target ${num}.`);
    else setStatus(`Highlight failed: ${(res && res.error) || "no response"}`, true);
  } catch (err) {
    setStatus(`Highlight failed: ${err.message || err}`, true);
  }
});

/* --- Voice and typed commands (Feature #10) --------------------------------
 * One dispatcher for voice and typed input. Commands only show/hide
 * tags through the shared flows above — never the executor. Nothing is
 * stored or logged: transcripts live only in the visible transcript
 * line until replaced or invalidated. */
const voiceApi = globalThis.SeeyableVoice || null;
let commandPending = false;
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
          if (recState === "listening") {
            setVoiceState("Voice: listening… say one supported command.");
          } else if (!commandPending) {
            voiceTabId = null;
            setVoiceState("Voice: idle.");
          }
          updateVoiceControls();
          flushPendingSpoken(); // session ended: microphone is closed
        },
        onInterim: ({ text }) => { $("voiceTranscript").textContent = `Heard so far: ${text}`; },
        onFinal: ({ text }) => {
          $("voiceTranscript").textContent = text ? `Heard: ${text}` : "Heard: (no speech)";
          // The one accepted utterance ends the session's purpose:
          // wind recognition down now; feedback waits for its end.
          if (recognizer) recognizer.stop();
          void dispatchCommand(text, "voice");
        },
        onError: ({ message }) => {
          setVoiceState(`Voice: error — ${message}`, true);
          updateVoiceControls();
          flushPendingSpoken(); // error also terminates the microphone
        },
      },
    })
  : null;

function cancelVoiceInteraction(reason) {
  interactionSeq += 1;
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
  setStatus(outcome.message, !outcome.ok);
  if (outcome.ok) {
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
  setVoiceState("Voice: starting the microphone…");
  recognizer.start();
  updateVoiceControls();
});

$("btnStopListen").addEventListener("click", () => {
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
});

$("targetSelect").addEventListener("change", () => {
  $("valueInput").value = ""; // entered values do not follow a new target
  updateExecuteEnabled();
});
$("actionSelect").addEventListener("change", updateValueEnabled);

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
updateExecuteEnabled();
