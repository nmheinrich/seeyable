"use strict";
/* Side panel controller — snapshot spike UI. */

const $ = (id) => document.getElementById(id);
let lastJson = "{}";
let lastKind = null;

function setStatus(text, isError) {
  const el = $("status");
  el.textContent = text;
  el.classList.toggle("error", Boolean(isError));
  console.info("[seeyable panel]", text);
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
    $("tabInfo").textContent = tab ? `Active tab: ${tab.title || "(untitled)"} — ${tab.url || ""}` : "Active tab: —";
  } catch { /* panel may open before tabs settle */ }
}

// --- DOM/ARIA path: try content-script message, fall back to scripting injection ---
// The fallback covers pages where the content script did not run (e.g. extension
// reloaded without refreshing the tab).

async function snapshotViaDom() {
  const tab = await activeTab();
  if (!tab || tab.id === undefined) throw new Error("No active tab.");
  let contentError = null;
  // Content-script path (no host permission needed: the script is declared
  // in the manifest and injected at page load).
  try {
    const res = await chrome.tabs.sendMessage(tab.id, { type: "SEEYABLE_SNAPSHOT_DOM" });
    if (res && res.ok) return res.snapshot;
    if (res && !res.ok) throw new Error(res.error);
  } catch (err) {
    contentError = err;
    console.warn("[seeyable] content-script path failed, falling back to scripting:", err);
  }
  // Injection fallback for tabs loaded before the extension was (re)installed.
  // NOTE: chrome.scripting needs host access for the tab. Per chrome-extensions
  // guidance, `activeTab` is granted by the toolbar-action click that opened
  // this panel — it is NOT re-granted by clicks inside the panel — so this
  // fallback can still be refused. That refusal is reported actionably below
  // rather than as a raw platform error. A broader fix (tabs + scoped
  // host_permissions) is documented in CHROMEWEBSTORE.md as pending approval;
  // permissions are not broadened silently.
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        if (typeof globalThis.__seeyable_snapshotDOM === "function") return globalThis.__seeyable_snapshotDOM();
        return null;
      },
    });
    if (result) return result;
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["lib/snapshot-dom.js"] });
    const [{ result: second }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => globalThis.__seeyable_snapshotDOM(),
    });
    if (!second) throw new Error("DOM snapshot returned nothing via scripting injection (see page console).");
    return second;
  } catch (scriptingError) {
    throw new Error(
      `Cannot access contents of the page. Content script: ${contentError ? contentError.message : "no response"}. ` +
      `Scripting fallback: ${scriptingError.message}. ` +
      "Fix: reload the tab (so the declared content script injects), make sure the page is a normal http(s) page " +
      "(not chrome://, the Web Store, or a file:// page without file access), and open the panel from the toolbar icon."
    );
  }
}

// The standard build declares no `debugger` permission in any form (Chrome
// forbids it in `optional_permissions`), so there is nothing to request at
// runtime. CDP testing requires the debug variant; say so instead of failing.
async function hasDebuggerPermission() {
  try {
    return await chrome.permissions.contains({ permissions: ["debugger"] });
  } catch (err) {
    console.warn("[seeyable] debugger permission check failed:", err);
    return false;
  }
}

let lastSnapshotMeta = null; // { documentSessionId, revision } from the latest DOM snapshot

$("btnDom").addEventListener("click", async () => {
  setStatus("Running DOM/ARIA snapshot…");
  try {
    const snap = await snapshotViaDom();
    lastSnapshotMeta = { documentSessionId: snap.documentSessionId, revision: snap.revision };
    lastKind = "dom-aria";
    // Minimal freshness display (schema v2); layout and viewer are unchanged.
    const fresh = snap.fresh === false ? " · STALE" : "";
    showJson(snap, `${snap.elementCount} elements · rev ${snap.revision} · ${(snap.semanticHash || "").slice(0, 8)}${fresh} · ${snap.durationMs}ms · ${snap.url || ""}`);
    setStatus(`DOM/ARIA snapshot done: ${snap.elementCount} interactive elements (revision ${snap.revision}).`);
  } catch (err) {
    console.error(err);
    setStatus(`DOM snapshot failed: ${err.message || err}`, true);
  }
});

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
      kind: "cdp-axtree",
      tab: res.tab,
      capturedAt: new Date().toISOString(),
      durationMs: res.durationMs,
      nodeCount: simplifiedAll.length,
      interactiveCount: interactive.length,
      includeIgnored,
      nodes: interactive,
      raw: res.raw, // full fidelity; large — kept so nothing is lost in the spike
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
  setStatus("Copied JSON to clipboard.");
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
$("btnClear").addEventListener("click", () => { showJson({}, ""); setStatus("Cleared."); });

async function sendToTab(payload) {
  const tab = await activeTab();
  if (!tab || tab.id === undefined) throw new Error("No active tab.");
  return chrome.tabs.sendMessage(tab.id, payload);
}

$("btnShowTags").addEventListener("click", async () => {
  try {
    const res = await sendToTab({ type: "SEEYABLE_SHOW_TAGS" });
    if (res && res.ok) {
      lastSnapshotMeta = { documentSessionId: res.documentSessionId, revision: res.revision };
      setStatus(`Tags shown: ${res.shown} in viewport (${res.total} controls, revision ${res.revision}).`);
    } else setStatus(`Show tags failed: ${(res && res.error) || "no response"}`, true);
  } catch (err) { setStatus(`Show tags failed: ${err.message || err}`, true); }
});

$("btnHideTags").addEventListener("click", async () => {
  try {
    const res = await sendToTab({ type: "SEEYABLE_HIDE_TAGS" });
    if (res && res.ok) setStatus("Tags hidden. Highlighting by number still works.");
    else setStatus(`Hide tags failed: ${(res && res.error) || "no response"}`, true);
  } catch (err) { setStatus(`Hide tags failed: ${err.message || err}`, true); }
});

$("btnHighlight").addEventListener("click", async () => {
  const raw = $("highlightInput").value.trim();
  const num = raw.replace(/^el-/i, "");
  if (!/^\d+$/.test(num)) { setStatus("Enter a target number from a DOM snapshot (e.g. 22).", true); return; }
  if (!lastSnapshotMeta) { setStatus("Run a DOM/ARIA snapshot (or Show tags) first so the target session is known.", true); return; }
  try {
    const res = await sendToTab({
      type: "SEEYABLE_HIGHLIGHT_ID",
      elementId: `el-${num}`,
      documentSessionId: lastSnapshotMeta.documentSessionId,
      revision: lastSnapshotMeta.revision,
    });
    if (res && res.ok) setStatus(`Highlighted target ${num}.`);
    else setStatus(`Highlight failed: ${(res && res.error) || "no response"}`, true);
  } catch (err) {
    setStatus(`Highlight failed: ${err.message || err}`, true);
  }
});

refreshTabInfo();
chrome.tabs.onActivated.addListener(refreshTabInfo);
chrome.tabs.onUpdated.addListener((_id, info) => { if (info.title || info.url) refreshTabInfo(); });
