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
  const ready = Boolean(state.snapshot && state.executorReady && !state.pending && !state.acquiring && selectedTargetId());
  $("btnExecute").disabled = !ready;
  $("targetSelect").disabled = state.pending || !state.snapshot;
  $("actionSelect").disabled = state.pending;
  // Conflicting snapshot/binding operations stay locked through the
  // post-action refresh, not just until the executor responds.
  for (const id of ["btnDom", "btnRefresh", "btnShowTags", "btnHideTags", "btnHighlight"]) {
    const btn = $(id);
    if (btn) btn.disabled = state.pending;
  }
  updateValueEnabled();
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
  if (state.pending || state.acquiring) return; // mutually exclusive with execution/acquisition; no queue
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

$("btnShowTags").addEventListener("click", async () => {
  if (state.pending || state.acquiring) return;
  const gen = state.generation;
  const myOp = ++state.opSeq;
  state.acquiring = true;
  updateExecuteEnabled();
  try {
    const tab = await activeTab();
    if (!tab || tab.id === undefined) { setStatus("No active tab.", true); return; }
    if (gen !== state.generation || myOp !== state.opSeq) return;
    state.opTabId = tab.id;
    const res = await chrome.tabs.sendMessage(tab.id, { type: "SEEYABLE_SHOW_TAGS" });
    if (gen !== state.generation || myOp !== state.opSeq) return; // obsolete at stage 1
    if (res && res.ok) {
      if (!state.snapshot) {
        // Tags took their own snapshot; bind execution to the same tab/session.
        // Ownership (opTabId) is retained across this follow-up fetch.
        try {
          const { snapshot, viaContentScript } = await fetchSnapshot(tab.id);
          if (gen !== state.generation || myOp !== state.opSeq) return; // obsolete at stage 2
          bindSnapshot(tab.id, snapshot, viaContentScript);
          showJson(snapshot, `${snapshot.elementCount} elements · rev ${snapshot.revision} · ${snapshot.url || ""}`);
          lastKind = "dom-aria";
        } catch { /* tags still shown; execution binding stays unset */ }
      }
      if (gen !== state.generation || myOp !== state.opSeq) return;
      setStatus(`Tags shown: ${res.shown} in viewport (${res.total} controls, revision ${res.revision}).`);
    } else setStatus(`Show tags failed: ${(res && res.error) || "no response"}`, true);
  } catch (err) {
    if (gen === state.generation && myOp === state.opSeq) {
      setStatus(`Show tags failed: ${err.message || err}. Reload the tab if the extension was just reloaded.`, true);
    }
  } finally {
    if (myOp === state.opSeq) {
      state.acquiring = false;
      state.opTabId = null;
    }
    updateExecuteEnabled();
  }
});

$("btnHideTags").addEventListener("click", async () => {
  try {
    const res = await sendBound({ type: "SEEYABLE_HIDE_TAGS" });
    if (res && res.ok) setStatus("Tags hidden. Highlighting by number still works.");
    else setStatus(`Hide tags failed: ${(res && res.error) || "no response"}`, true);
  } catch (err) { setStatus(`Hide tags failed: ${err.message || err}`, true); }
});

$("btnHighlight").addEventListener("click", async () => {
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
  // Invalidate even when nothing is bound yet: an in-flight initial
  // snapshot for another tab must never populate or authorize.
  const ownedTab = state.boundTabId !== null ? state.boundTabId : state.opTabId;
  if (ownedTab !== null && info.tabId !== ownedTab) {
    invalidateExecution("Active tab changed. The previous execution selection was discarded; take a snapshot in this tab.");
  }
});
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.title || info.url) refreshTabInfo();
  const ownedTab = state.boundTabId !== null ? state.boundTabId : state.opTabId;
  if (ownedTab !== null && tabId === ownedTab && (info.status === "loading" || info.url)) {
    invalidateExecution("The tab navigated or reloaded. The previous execution selection was discarded; take a fresh snapshot.");
  }
});
updateExecuteEnabled();
