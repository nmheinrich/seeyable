"use strict";
/*
 * Content script for Seeyable snapshots.
 * Requires lib/snapshot-dom.js to have run first (see manifest content_scripts order).
 *
 * Owns the per-document snapshot engine session. Navigation/reload destroys
 * this context (and the engine), which is what invalidates prior references:
 * a new document always gets a new documentSessionId.
 *
 * Messages:
 *  - { type: "SEEYABLE_SNAPSHOT_DOM" }                       -> snapshot JSON (schema v2)
 *  - { type: "SEEYABLE_SNAPSHOT_STATUS" }                    -> { revision, semanticHash, fresh, ... }
 *  - { type: "SEEYABLE_RESOLVE_ID", elementId, revision }    -> safe reference validation for a future executor
 *  - { type: "SEEYABLE_HIGHLIGHT", cssPath }                 -> flash-outline an element (debug probe)
 */

console.info("[seeyable] content script ready:", location.href);

function engine() {
  return globalThis.__seeyable_getSnapshotEngine();
}

try {
  const eng = engine();
  window.addEventListener("pagehide", () => {
    // Document is going away; any outstanding references must not resolve.
    eng.invalidate("navigation");
  });
  console.info(`[seeyable] snapshot engine session ${eng.sessionId} observing`);
} catch (err) {
  console.warn("[seeyable] engine startup failed:", err);
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message.type !== "string") return false;

  if (message.type === "SEEYABLE_SNAPSHOT_DOM") {
    try {
      const snapshot = globalThis.__seeyable_snapshotDOM();
      console.info(`[seeyable] DOM snapshot: ${snapshot.elementCount} elements rev ${snapshot.revision} ${snapshot.semanticHash} in ${snapshot.durationMs}ms`);
      sendResponse({ ok: true, snapshot });
    } catch (err) {
      console.error("[seeyable] DOM snapshot failed:", err);
      sendResponse({ ok: false, error: String(err && err.message ? err.message : err) });
    }
    return false;
  }

  if (message.type === "SEEYABLE_SNAPSHOT_STATUS") {
    try {
      sendResponse({ ok: true, status: engine().getStatus() });
    } catch (err) {
      sendResponse({ ok: false, error: String(err && err.message ? err.message : err) });
    }
    return false;
  }

  if (message.type === "SEEYABLE_RESOLVE_ID") {
    try {
      // Validation only — no executor actions are performed here.
      const result = engine().resolve(message.elementId, message.revision);
      sendResponse({ ok: true, resolution: result });
    } catch (err) {
      sendResponse({ ok: false, error: String(err && err.message ? err.message : err) });
    }
    return false;
  }

  if (message.type === "SEEYABLE_HIGHLIGHT") {
    try {
      const el = document.querySelector(message.cssPath);
      if (!el) {
        sendResponse({ ok: false, error: `No element matches ${message.cssPath}` });
        return false;
      }
      const prev = el.style.outline;
      el.style.outline = "3px solid #e8590c";
      el.scrollIntoView({ block: "center", behavior: "smooth" });
      setTimeout(() => { el.style.outline = prev; }, 1600);
      sendResponse({ ok: true, matched: `${el.tagName.toLowerCase()}${el.id ? "#" + el.id : ""}` });
    } catch (err) {
      sendResponse({ ok: false, error: String(err && err.message ? err.message : err) });
    }
    return false;
  }
  return false;
});
