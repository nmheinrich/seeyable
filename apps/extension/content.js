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
 *  - SEEYABLE_TAG_STATE { documentSessionId, states } -> step states on word tags
 *                                                     (trusted side panel only)
 *  - SEEYABLE_UNDO_LAST { documentSessionId, source } -> restore the last reversible change
 *                                                     (trusted side panel only; Issue #15)
 *  - SEEYABLE_GET_PENDING_CONFIRMATION               -> authoritative pending challenge
 *                                                     (trusted side panel only; Issue #19)
 *  - SEEYABLE_READ_SECTION { elementId, documentSessionId, revision, maxChars }
 *                                                     -> bounded visible text of the target's
 *                                                     enclosing section (Issue #19)
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

/* --- Bounded section reading (Issue #19) -----------------------------------
 * Enclosing-section rule: the target's nearest ancestor sectioning
 * container — a SECTION, ARTICLE, FIELDSET, FORM, MAIN, or ASIDE element,
 * or an element with role group/radiogroup/region/form/search. Without
 * one, the target's parent element is the section. Only visible text is
 * returned: script/style/noscript/template subtrees, Seeyable overlay UI,
 * hidden subtrees, and form-control subtrees (input/textarea/select —
 * where control values live) are excluded, so the snapshot engine's
 * sensitive-field policy holds: control values are never read here.
 * Output is capped; truncation is reported, never silent. This is a
 * bounded prose extract, not a guarantee about secrets a page prints as
 * ordinary text. */
const SECTION_TAGS = new Set(["SECTION", "ARTICLE", "FIELDSET", "FORM", "MAIN", "ASIDE"]);
const SECTION_ROLES = new Set(["group", "radiogroup", "region", "form", "search"]);
const READ_SECTION_DEFAULT_CHARS = 4000;
const READ_SECTION_MAX_CHARS = 8000;
const READ_SECTION_MAX_NODES = 2000;

function cleanSectionText(s) { return (s || "").replace(/\s+/g, " ").trim(); }

function sectionOf(node) {
  let cur = node.parentElement;
  while (cur) {
    const role = ((cur.getAttribute && cur.getAttribute("role")) || "").trim().split(/\s+/)[0].toLowerCase();
    if (SECTION_TAGS.has(cur.tagName) || SECTION_ROLES.has(role)) return cur;
    cur = cur.parentElement;
  }
  return node.parentElement || node;
}

// A subtree root whose rendered text is a CONTROL VALUE, not page prose:
// native value-bearing controls, anything contenteditable (custom
// editable controls included), and custom controls the snapshot
// engine's centralized classifier marks sensitive (e.g. a
// role="textbox" labelled "Card number"). Text under such a root never
// reaches a section read — the same policy snapshots apply to values.
function isExcludedSectionRoot(el, internals) {
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  const editable = el.getAttribute && el.getAttribute("contenteditable");
  if (editable !== null && editable !== undefined && String(editable).toLowerCase() !== "false") return true;
  if (el.isContentEditable) return true;
  if (internals && typeof internals.sensitiveInfo === "function") {
    const role = ((el.getAttribute && el.getAttribute("role")) || "").trim().split(/\s+/)[0].toLowerCase();
    if (role === "textbox" || role === "searchbox" || role === "combobox" || role === "spinbutton") {
      try { if (internals.sensitiveInfo(el).sensitive) return true; } catch { /* classifier is best-effort here */ }
    }
  }
  return false;
}

// True when any element from `el` up to (and including) `boundary` is
// such a root or non-prose markup.
function insideExcludedSection(el, boundary, internals) {
  for (let cur = el; cur; cur = cur.parentElement) {
    if (cur.closest && cur === el && cur.closest("script, style, noscript, template, [data-seeyable-overlay]")) return true;
    if (isExcludedSectionRoot(cur, internals)) return true;
    if (cur === boundary) break;
  }
  return false;
}

function sectionHeadingOf(section, internals) {
  if (!section) return null;
  const aria = cleanSectionText(section.getAttribute && section.getAttribute("aria-label"));
  if (aria) return aria;
  const win = section.ownerDocument && section.ownerDocument.defaultView;
  const visible = (el) => !internals || typeof internals.isVisible !== "function" || internals.isVisible(el, win);
  if (section.tagName === "FIELDSET") {
    const legend = Array.from(section.children || []).find((c) => c.tagName === "LEGEND");
    if (legend && visible(legend)) {
      const text = sectionTextOf(legend, 200, internals).text;
      if (text) return text;
    }
  }
  if (section.querySelectorAll) {
    for (const heading of section.querySelectorAll("h1, h2, h3, h4, h5, h6")) {
      if (!visible(heading)) continue; // hidden headings are not section metadata
      const text = sectionTextOf(heading, 200, internals).text;
      if (text) return text;
    }
  }
  return null;
}

function sectionTextOf(section, maxChars, internals) {
  const win = section.ownerDocument && section.ownerDocument.defaultView;
  const NF = (win && win.NodeFilter) || (typeof NodeFilter !== "undefined" ? NodeFilter : null);
  if (!NF || !section.ownerDocument.createTreeWalker) return { text: "", truncated: false };
  const walker = section.ownerDocument.createTreeWalker(section, NF.SHOW_TEXT, {
    acceptNode(textNode) {
      const parent = textNode.parentElement;
      if (!parent) return NF.FILTER_REJECT;
      if (insideExcludedSection(parent, section, internals)) return NF.FILTER_REJECT;
      if (internals && typeof internals.isVisible === "function" && !internals.isVisible(parent, win)) return NF.FILTER_REJECT;
      return NF.FILTER_ACCEPT;
    },
  });
  const parts = [];
  let chars = 0;
  let visited = 0;
  let truncated = false;
  let node;
  while ((node = walker.nextNode())) {
    visited += 1;
    if (visited > READ_SECTION_MAX_NODES) { truncated = true; break; }
    const text = cleanSectionText(node.textContent);
    if (!text) continue;
    if (chars + text.length + 1 > maxChars) { truncated = true; break; }
    parts.push(text);
    chars += text.length + 1;
  }
  const joined = parts.join(" ");
  if (joined.length > maxChars) {
    truncated = true;
    return { text: joined.slice(0, maxChars), truncated };
  }
  return { text: joined, truncated };
}

/* Approval authority (Feature #11) is accepted only from the trusted
 * side-panel page, verified from browser-provided sender information:
 * the sender must be this extension, must not be a tab (content
 * scripts and pages have sender.tab / page URLs), and its URL must be
 * exactly the side-panel document. Page scripts cannot send runtime
 * messages to a content script at all, and no execute() request field
 * can substitute for this check. Speech transcripts never reach here:
 * only the panel's Approve control sends these message types. */
function isTrustedPanelSender(sender) {
  try {
    if (!sender || sender.tab) return false;
    if (!sender.id || sender.id !== chrome.runtime.id) return false;
    return sender.url === chrome.runtime.getURL("sidepanel.html");
  } catch {
    return false;
  }
}
function rejectUntrusted(sendResponse, what) {
  sendResponse({
    ok: false,
    error: { code: "UNTRUSTED_APPROVAL", message: `${what} is only accepted from the Seeyable side panel. Nothing was approved or changed.` },
    newSnapshotDiff: null,
    diffUnavailableReason: "untrusted approval source rejected",
    documentSessionId: engine().sessionId,
    revision: engine().getStatus().revision,
  });
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
      sendResponse({ ok: true, shown: result.shown, total: result.total, unplaced: result.unplaced || [], revision: snapshot.revision, documentSessionId: snapshot.documentSessionId });
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
        const { action, elementId, documentSessionId, revision, value, source, deadline } = message.request || {};
        // Only these fields cross into the executor. Approval-shaped
        // fields (confirmed, tokens, challenge ids) are deliberately
        // dropped here: approval travels the verified route below. A
        // numeric deadline (bridge-carried request validity) is the one
        // extra field, re-checked by the executor before dispatch.
        const response = await getExecutor().execute({ action, elementId, documentSessionId, revision, value, source, deadline });
        if (!response.ok) console.warn(`[seeyable] execute ${action} ${elementId}: ${response.error.code}`);
        sendResponse(response);
      } catch (err) { fail(sendResponse, err); }
    })();
    return true; // async sendResponse
  }

  if (message.type === "SEEYABLE_APPROVE_CHALLENGE") {
    if (!isTrustedPanelSender(_sender)) { rejectUntrusted(sendResponse, "Approval"); return false; }
    (async () => {
      try { sendResponse(await getExecutor().approveChallenge(message.challengeId)); }
      catch (err) { fail(sendResponse, err); }
    })();
    return true; // async sendResponse
  }

  if (message.type === "SEEYABLE_CANCEL_CHALLENGE") {
    if (!isTrustedPanelSender(_sender)) { rejectUntrusted(sendResponse, "Cancellation"); return false; }
    try { sendResponse({ ok: true, ...getExecutor().cancelChallenge(message.challengeId) }); }
    catch (err) { fail(sendResponse, err); }
    return false;
  }

  if (message.type === "SEEYABLE_GET_PENDING_CONFIRMATION") {
    // Issue #19: an MCP-originated hold lives in this document's executor,
    // not in whichever caller triggered it. The panel retrieves the
    // authoritative pending challenge here so it can show the existing
    // confirmation card; approval itself still travels the route above.
    if (!isTrustedPanelSender(_sender)) { rejectUntrusted(sendResponse, "Pending confirmation lookup"); return false; }
    try { sendResponse({ ok: true, confirmation: getExecutor().getPendingConfirmation() }); }
    catch (err) { fail(sendResponse, err); }
    return false;
  }

  if (message.type === "SEEYABLE_UNDO_LAST") {
    // Undo (Issue #15) restores page state, so it takes the same
    // trusted-panel-only route as approval. Only the document session
    // and an audit label cross; the record itself never leaves the
    // executor.
    if (!isTrustedPanelSender(_sender)) { rejectUntrusted(sendResponse, "Undo"); return false; }
    (async () => {
      try { sendResponse(await getExecutor().undoLastChange({ documentSessionId: message.documentSessionId, source: message.source })); }
      catch (err) { fail(sendResponse, err); }
    })();
    return true; // async sendResponse
  }

  if (message.type === "SEEYABLE_GATE_CONTROL") {
    if (!isTrustedPanelSender(_sender)) { rejectUntrusted(sendResponse, "Gate control"); return false; }
    try {
      const executor = getExecutor();
      const gate = message.command === "stop" ? executor.stopExecution()
        : message.command === "pause" ? executor.pauseExecution()
        : message.command === "resume" ? executor.resumeExecution()
        : null;
      if (!gate) { sendResponse({ ok: false, error: { code: "INVALID_REQUEST", message: "Unknown gate command." } }); return false; }
      sendResponse({ ok: true, gate });
    } catch (err) { fail(sendResponse, err); }
    return false;
  }

  if (message.type === "SEEYABLE_GET_ACTION_LOG") {
    if (!isTrustedPanelSender(_sender)) { rejectUntrusted(sendResponse, "Action log access"); return false; }
    try { sendResponse({ ok: true, entries: getExecutor().getActionLog() }); }
    catch (err) { fail(sendResponse, err); }
    return false;
  }

  if (message.type === "SEEYABLE_CLEAR_ACTION_LOG") {
    if (!isTrustedPanelSender(_sender)) { rejectUntrusted(sendResponse, "Action log clearing"); return false; }
    try { sendResponse({ ok: true, ...getExecutor().clearActionLog() }); }
    catch (err) { fail(sendResponse, err); }
    return false;
  }

  if (message.type === "SEEYABLE_TAG_STATE") {
    // Step states on word tags (acting / done / held). Presentation only,
    // but a fake "done" or "held" would mislead the person, so only the
    // trusted side panel may set them, and only for this document.
    if (!isTrustedPanelSender(_sender)) { rejectUntrusted(sendResponse, "Tag state"); return false; }
    try {
      if (message.documentSessionId !== engine().sessionId) {
        sendResponse({ ok: false, error: "Wrong document session. Tag states were not changed." });
        return false;
      }
      sendResponse({ ok: true, ...getOverlay().setTargetStates(message.states || {}) });
    } catch (err) { fail(sendResponse, err); }
    return false;
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

  if (message.type === "SEEYABLE_READ_SECTION") {
    try {
      const eng = engine();
      const readError = (code, text) => sendResponse({ ok: false, error: { code, message: text } });
      if (message.documentSessionId !== eng.sessionId) {
        readError("WRONG_SESSION", "Wrong document session. Take a fresh snapshot of this tab first.");
        return false;
      }
      // Read against current truth only: a semantic page change since the
      // caller's snapshot (which also covers option edits, via state)
      // rejects instead of reading a moved target.
      const changed = eng.checkForChanges();
      if (changed && changed.changed) {
        readError("STALE_SNAPSHOT", "The page changed since that snapshot. Take a fresh snapshot, then read again.");
        return false;
      }
      const resolved = eng.resolveNode(message.elementId, message.revision);
      if (resolved.status === "unknown") {
        readError("UNKNOWN_TARGET", `Unknown element ID ${message.elementId} in this document session. Re-snapshot this tab.`);
        return false;
      }
      if (resolved.status !== "ok" || !resolved.node) {
        readError("STALE_TARGET", `Stale reference ${message.elementId} (${resolved.reason || resolved.status}). Re-snapshot this tab; the original control is gone or changed.`);
        return false;
      }
      const maxChars = Number.isInteger(message.maxChars)
        ? Math.min(Math.max(message.maxChars, 1), READ_SECTION_MAX_CHARS)
        : READ_SECTION_DEFAULT_CHARS;
      const snapshot = eng.snapshot();
      const descriptor = (snapshot.elements || []).find((e) => e && e.id === message.elementId) || null;
      const section = sectionOf(resolved.node);
      const { text, truncated } = sectionTextOf(section, maxChars, globalThis.__seeyable_snapshotInternals);
      sendResponse({
        ok: true,
        section: {
          elementId: message.elementId,
          name: descriptor ? descriptor.name || null : null,
          question: descriptor ? descriptor.question || null : null,
          documentSessionId: eng.sessionId,
          revision: snapshot.revision,
          sectionTag: section.tagName ? section.tagName.toLowerCase() : null,
          heading: sectionHeadingOf(section, globalThis.__seeyable_snapshotInternals),
          text,
          truncated,
          charCount: text.length,
        },
      });
    } catch (err) { fail(sendResponse, err); }
    return false;
  }

  return false;
});
