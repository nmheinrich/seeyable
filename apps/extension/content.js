"use strict";
/*
 * Content script for Seeyable snapshots and visual overlay.
 * Requires lib/snapshot-dom.js and lib/overlay.js to have run first
 * (see manifest content_scripts order).
 *
 * Owns the per-document snapshot engine session and the overlay controller.
 * Navigation/reload destroys this context (and the engine), which is what
 * invalidates prior references: a new document always gets a new
 * documentSessionId. DOM nodes never leave this context; messages carry
 * only IDs, session, revision, and plain results.
 *
 * Messages (see docs/features/feature-07-visual-overlay.md):
 *  - SEEYABLE_SNAPSHOT_DOM                            -> snapshot JSON (schema v2)
 *  - SEEYABLE_SNAPSHOT_STATUS                         -> { revision, semanticHash, fresh, ... }
 *  - SEEYABLE_RESOLVE_ID { elementId, revision }      -> reference validation (no actions)
 *  - SEEYABLE_SHOW_TAGS                               -> snapshot now and show numbered tags
 *  - SEEYABLE_HIDE_TAGS                               -> hide tags (highlight ring unaffected)
 *  - SEEYABLE_HIGHLIGHT_ID { elementId, documentSessionId, revision }
 *                                                     -> scroll validated node into view + ring
 *  - SEEYABLE_EXECUTE_ACTION { action, elementId, documentSessionId, revision, value }
 *                                                     -> single executor entry point (async response)
 */

console.info("[seeyable] content script ready:", location.href);

function engine() {
  return globalThis.__seeyable_getSnapshotEngine();
}

let executor = null;
function getExecutor() {
  if (!executor) {
    executor = globalThis.__seeyable_createExecutor({
      engine: engine(),
      internals: globalThis.__seeyable_snapshotInternals,
    });
  }
  return executor;
}

let overlay = null;
function getOverlay() {
  if (!overlay) {
    const eng = engine();
    overlay = globalThis.__seeyable_createOverlay({
      document,
      window,
      resolveNode: (id, revision) => eng.resolveNode(id, revision),
    });
  }
  return overlay;
}

try {
  const eng = engine();
  window.addEventListener("pagehide", () => {
    eng.invalidate("navigation");
    if (overlay) overlay.destroy();
  });
  console.info(`[seeyable] snapshot engine session ${eng.sessionId} observing`);
} catch (err) {
  console.warn("[seeyable] engine startup failed:", err);
}

function fail(sendResponse, err) {
  sendResponse({ ok: false, error: String(err && err.message ? err.message : err) });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message.type !== "string") return false;

  if (message.type === "SEEYABLE_SNAPSHOT_DOM") {
    try {
      const snapshot = globalThis.__seeyable_snapshotDOM();
      console.info(`[seeyable] DOM snapshot: ${snapshot.elementCount} elements rev ${snapshot.revision} ${snapshot.semanticHash} in ${snapshot.durationMs}ms`);
      sendResponse({ ok: true, snapshot });
    } catch (err) { console.error("[seeyable] DOM snapshot failed:", err); fail(sendResponse, err); }
    return false;
  }

  if (message.type === "SEEYABLE_SNAPSHOT_STATUS") {
    try { sendResponse({ ok: true, status: engine().getStatus() }); }
    catch (err) { fail(sendResponse, err); }
    return false;
  }

  if (message.type === "SEEYABLE_RESOLVE_ID") {
    try {
      const result = engine().resolve(message.elementId, message.revision);
      sendResponse({ ok: true, resolution: result });
    } catch (err) { fail(sendResponse, err); }
    return false;
  }

  if (message.type === "SEEYABLE_SHOW_TAGS") {
    try {
      const snapshot = globalThis.__seeyable_snapshotDOM();
      const result = getOverlay().show(snapshot.elements);
      sendResponse({ ok: true, shown: result.shown, total: result.total, revision: snapshot.revision, documentSessionId: snapshot.documentSessionId });
    } catch (err) { fail(sendResponse, err); }
    return false;
  }

  if (message.type === "SEEYABLE_HIDE_TAGS") {
    try {
      const result = getOverlay().hide();
      sendResponse({ ok: true, shown: result.shown, total: result.total });
    } catch (err) { fail(sendResponse, err); }
    return false;
  }

  if (message.type === "SEEYABLE_EXECUTE_ACTION") {
    // Single executor entry point. No action logic lives in messaging code,
    // and raw request objects are never logged (values may be user data).
    (async () => {
      try {
        const { action, elementId, documentSessionId, revision, value } = message.request || {};
        const response = await getExecutor().execute({ action, elementId, documentSessionId, revision, value });
        if (!response.ok) console.warn(`[seeyable] execute ${action} ${elementId}: ${response.error.code}`);
        sendResponse(response);
      } catch (err) { fail(sendResponse, err); }
    })();
    return true; // async sendResponse
  }

  if (message.type === "SEEYABLE_HIGHLIGHT_ID") {
    try {
      const eng = engine();
      const result = getOverlay().highlightById(
        message.elementId, message.documentSessionId, message.revision, eng.sessionId
      );
      if (result.status === "ok") {
        sendResponse({ ok: true, highlighted: result.id });
      } else if (result.status === "wrong-session") {
        sendResponse({ ok: false, error: `Wrong document session: expected ${eng.sessionId}, got ${message.documentSessionId || "(none)"}. Re-snapshot this tab.` });
      } else if (result.status === "unknown") {
        sendResponse({ ok: false, error: `Unknown element ID ${message.elementId} in this document session. Re-snapshot this tab.` });
      } else {
        sendResponse({ ok: false, error: `Stale reference ${message.elementId} (${result.reason || result.status}). Re-snapshot this tab; the original control is gone or changed.` });
      }
    } catch (err) { fail(sendResponse, err); }
    return false;
  }

  return false;
});
