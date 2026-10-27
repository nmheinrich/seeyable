"use strict";
/*
 * Content script for Seeyable snapshots.
 * Requires lib/snapshot-dom.js to have run first (see manifest content_scripts order).
 *
 * Messages:
 *  - { type: "SEEYABLE_SNAPSHOT_DOM" }            -> DOM/ARIA snapshot JSON
 *  - { type: "SEEYABLE_HIGHLIGHT", cssPath }      -> flash-outline an element
 *    (used to test how hard a snapshot entry maps back to a real DOM node)
 */

console.info("[seeyable] content script ready:", location.href);

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message.type !== "string") return false;

  if (message.type === "SEEYABLE_SNAPSHOT_DOM") {
    try {
      const snapshot = globalThis.__seeyable_snapshotDOM();
      console.info(`[seeyable] DOM snapshot: ${snapshot.elementCount} elements in ${snapshot.durationMs}ms`);
      sendResponse({ ok: true, snapshot });
    } catch (err) {
      console.error("[seeyable] DOM snapshot failed:", err);
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
