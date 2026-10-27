"use strict";
/*
 * Visual overlay for Seeyable: numbered word tags + target ring.
 *
 * Separate overlay layer (shadow DOM host). It never modifies target
 * elements, never intercepts pointer events, and stays out of the page's
 * accessibility tree (aria-hidden host, shadow content). Snapshot code
 * excludes [data-seeyable-overlay] subtrees, and all geometry is measured
 * live from validated DOM nodes — snapshot rectangles are never trusted
 * for placement.
 *
 * Identity comes only from snapshot schema-v2 IDs (`el-N`): the displayed
 * number is N parsed from the ID. No second identity system is created.
 */

function numberFromId(id) {
  const match = /^el-(\d+)$/.exec(String(id || ""));
  return match ? match[1] : null;
}

function buildTagLabel(desc, all) {
  const number = numberFromId(desc && desc.id);
  const name = (desc && desc.name ? String(desc.name) : "").trim();
  const role = (desc && desc.role) || "control";
  if (!name) return { text: `${role} ${number === null ? "" : number}`.trim(), number, uncertain: false };
  const peers = Array.isArray(all) ? all : [];
  const duplicate = name && peers.filter((e) => (e.name || "").trim() === name).length > 1;
  const needsQuestion = duplicate || /^\d+$/.test(name) || name.length <= 2;
  const question = (desc.question || "").trim();
  if (needsQuestion && question) {
    // Uncertain (proximity-inferred) context is marked, never presented
    // as verified. Compact truncation keeps the distinguishing end.
    const marker = desc.questionCertain ? "" : " ?";
    const text = `${question}${marker} · ${name}`;
    return { text: text.length > 72 ? text.slice(0, 71) + "…" : text, number, uncertain: !desc.questionCertain };
  }
  // Field values (state) are deliberately never consulted for labels.
  return { text: name.length > 72 ? name.slice(0, 71) + "…" : name, number, uncertain: false };
}

const OVERLAY_CSS = `
  :host { all: initial; }
  .layer { position: fixed; inset: 0; pointer-events: none; z-index: 2147483647; }
  .badge {
    position: fixed; display: flex; align-items: baseline; max-width: 240px;
    background: #141414; color: #F2F2EE; border: 1px solid #F2F2EE;
    font: 12px/1.3 system-ui, sans-serif; padding: 3px 7px; border-radius: 4px;
    transition: opacity 120ms ease;
  }
  .badge .word { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .badge .num { flex: 0 0 auto; opacity: 0.62; margin-left: 6px; font-size: 11px; }
  .badge.compact .word { display: none; }
  .badge.compact .num { margin-left: 0; opacity: 1; }
  .ring {
    position: fixed; display: none; pointer-events: none; border-radius: 6px;
    border: 3px solid #F2F2EE; box-shadow: 0 0 0 2px #141414, inset 0 0 0 1px #141414;
    transition: opacity 120ms ease;
  }
  @media (prefers-reduced-motion: reduce) {
    .badge, .ring { transition: none; }
  }
  @media (forced-colors: active) {
    .badge { background: Canvas; color: CanvasText; border-color: CanvasText; forced-color-adjust: none; }
    .ring { border-color: Highlight; box-shadow: 0 0 0 2px CanvasText; }
  }
`;

function createOverlayController(options) {
  const docRef = options.document;
  const win = options.window || docRef.defaultView;
  const resolveNode = options.resolveNode;
  if (!docRef || typeof resolveNode !== "function") {
    throw new Error("createOverlayController requires { document, resolveNode }");
  }

  let host = null;
  let badgeLayer = null;
  let ring = null;
  let descriptors = new Map();
  let tagsVisible = false;
  let highlightedId = null;
  let highlightedNode = null;
  let rafPending = false;
  let settleTimer = null;
  let listening = false;
  let mutationObserver = null;
  let mutationTimer = null;
  const mutationDebounceMs = options.mutationDebounceMs !== undefined ? options.mutationDebounceMs : 300;

  function reducedMotion() {
    try { return Boolean(win && win.matchMedia && win.matchMedia("(prefers-reduced-motion: reduce)").matches); }
    catch { return false; }
  }

  function ensureHost() {
    if (host) return host;
    host = docRef.createElement("div");
    host.setAttribute("data-seeyable-overlay", "");
    host.setAttribute("aria-hidden", "true");
    const shadow = host.attachShadow({ mode: "open" });
    const style = docRef.createElement("style");
    style.textContent = OVERLAY_CSS;
    badgeLayer = docRef.createElement("div");
    badgeLayer.className = "layer";
    ring = docRef.createElement("div");
    ring.className = "ring";
    shadow.append(style, badgeLayer, ring);
    (docRef.body || docRef.documentElement).append(host);
    startListening();
    startMutationObserver();
    return host;
  }

  // Relevant page changes (control added/removed, label or layout-affecting
  // attribute changed) schedule one debounced refresh. Overlay content lives
  // in shadow DOM, which this observer cannot see, and snapshot exclusion
  // covers the host — so overlay rendering cannot feed back into this loop.
  // The default delay exceeds the engine's invalidation debounce so stale
  // targets are already marked stale when refresh revalidates them.
  function startMutationObserver() {
    if (mutationObserver || !win) return;
    const MO = win.MutationObserver || (typeof MutationObserver !== "undefined" ? MutationObserver : null);
    if (!MO || !docRef.documentElement) return;
    mutationObserver = new MO((records) => {
      const relevant = (records || []).some((rec) => {
        const target = rec.target;
        return !(target && target.closest && target.closest("[data-seeyable-overlay]"));
      });
      if (!relevant) return;
      if (mutationTimer !== null && win.clearTimeout) win.clearTimeout(mutationTimer);
      mutationTimer = win.setTimeout(() => { mutationTimer = null; scheduleRefresh(); }, mutationDebounceMs);
    });
    mutationObserver.observe(docRef.documentElement, {
      subtree: true, childList: true, characterData: true,
      attributes: true,
      attributeFilter: ["aria-label", "aria-labelledby", "aria-checked", "aria-expanded", "aria-selected", "aria-disabled", "aria-hidden", "hidden", "style", "class", "type", "role", "disabled", "checked"],
    });
  }
  function stopMutationObserver() {
    if (mutationObserver) { mutationObserver.disconnect(); mutationObserver = null; }
    if (mutationTimer !== null && win && win.clearTimeout) { win.clearTimeout(mutationTimer); mutationTimer = null; }
  }

  function scheduleRefresh() {
    if (rafPending) return;
    rafPending = true;
    const run = () => { rafPending = false; refresh(); };
    if (win && win.requestAnimationFrame) win.requestAnimationFrame(run);
    else run();
  }

  function onViewportChange() { scheduleRefresh(); }
  function startListening() {
    if (listening || !win || !win.addEventListener) return;
    // Capture-phase scroll catches nested scroll containers, not just the document.
    win.addEventListener("scroll", onViewportChange, true);
    win.addEventListener("resize", onViewportChange);
    listening = true;
  }
  function stopListening() {
    if (!listening || !win || !win.removeEventListener) return;
    win.removeEventListener("scroll", onViewportChange, true);
    win.removeEventListener("resize", onViewportChange);
    listening = false;
  }

  function badgeSize(badge, label) {
    const w = badge.offsetWidth || 0;
    const h = badge.offsetHeight || 0;
    if (w > 0 && h > 0) return { width: w, height: h };
    // Headless/no-layout fallback: estimate from label length (tests, jsdom).
    const chars = (label ? label.text.length : 4) + (label && label.number ? String(label.number).length + 1 : 0);
    return { width: Math.min(240, Math.max(28, Math.round(16 + chars * 6.5))), height: 22 };
  }

  function placeBadge(badge, rect, label) {
    const vw = win && win.innerWidth ? win.innerWidth : 0;
    const vh = win && win.innerHeight ? win.innerHeight : 0;
    const size = badgeSize(badge, label);
    let left = rect.x;
    let top = rect.y >= size.height + 4 ? rect.y - size.height - 2 : rect.y + rect.height + 4;
    if (vw) left = Math.max(0, Math.min(left, Math.max(0, vw - size.width)));
    if (vh) top = Math.max(0, Math.min(top, Math.max(0, vh - size.height)));
    badge.style.left = `${Math.round(left)}px`;
    badge.style.top = `${Math.round(top)}px`;
    return { left, top, width: size.width, height: size.height };
  }

  function setBadgeLabel(badge, desc) {
    const label = buildTagLabel(desc, Array.from(descriptors.values()));
    const word = badge.querySelector(".word");
    const num = badge.querySelector(".num");
    const wordText = label.text;
    const numText = label.number === null ? "" : String(label.number);
    if (word && word.textContent !== wordText) word.textContent = wordText;
    if (num && num.textContent !== numText) num.textContent = numText;
    return label;
  }

  function refresh() {
    if (!host) return;
    if (ring && highlightedId) {
      // Revalidate identity, not just attachment: a replaced or stale node
      // must lose its ring without waiting for a scroll.
      const resolved = resolveNode(highlightedId);
      if (!resolved || resolved.status !== "ok" || !resolved.node || resolved.node !== highlightedNode) {
        ring.style.display = "none";
        highlightedNode = null;
        highlightedId = null;
      } else {
        const r = highlightedNode.getBoundingClientRect();
        ring.style.display = "block";
        ring.style.left = `${Math.round(r.x - 4)}px`;
        ring.style.top = `${Math.round(r.y - 4)}px`;
        ring.style.width = `${Math.round(r.width + 8)}px`;
        ring.style.height = `${Math.round(r.height + 8)}px`;
      }
    }
    if (!tagsVisible) return;
    const vw = win && win.innerWidth ? win.innerWidth : 0;
    const vh = win && win.innerHeight ? win.innerHeight : 0;
    const seen = new Set();
    const placed = [];
    for (const [id, desc] of descriptors) {
      const resolved = resolveNode(id);
      if (!resolved || resolved.status !== "ok" || !resolved.node) continue; // invalid target: omit tag
      const node = resolved.node;
      const r = node.getBoundingClientRect ? node.getBoundingClientRect() : null;
      if (!r || (r.width === 0 && r.height === 0)) continue;
      const rx = r.x !== undefined ? r.x : r.left || 0;
      const ry = r.y !== undefined ? r.y : r.top || 0;
      // Exclude fully offscreen controls on BOTH axes: no edge badges.
      if (vw && (rx + r.width <= 0 || rx >= vw)) continue;
      if (vh && (ry + r.height <= 0 || ry >= vh)) continue;
      seen.add(id);
      let badge = badgeLayer.querySelector(`[data-target-id="${id}"]`);
      if (!badge) {
        badge = docRef.createElement("div");
        badge.className = "badge";
        badge.setAttribute("data-target-id", id);
        const word = docRef.createElement("span");
        word.className = "word";
        const num = docRef.createElement("span");
        num.className = "num";
        badge.append(word, num);
        badgeLayer.append(badge);
      }
      // Always refresh text from the current descriptor (labels change).
      const label = setBadgeLabel(badge, desc);
      badge.classList.remove("compact");
      let box = placeBadge(badge, { x: rx, y: ry, width: r.width, height: r.height }, label);
      // Compact fallback for tightly spaced controls: if this badge would
      // cover an already-placed badge, shrink to the number alone so the
      // number stays readable. Deliberately simple; no collision engine.
      const overlaps = placed.some((p) => box.left < p.left + p.width && box.left + box.width > p.left && box.top < p.top + p.height && box.top + box.height > p.top);
      if (overlaps) {
        badge.classList.add("compact");
        box = placeBadge(badge, { x: rx, y: ry, width: r.width, height: r.height }, { text: "", number: label.number });
      }
      placed.push(box);
    }
    for (const badge of Array.from(badgeLayer.children)) {
      if (!seen.has(badge.getAttribute("data-target-id"))) badge.remove();
    }
  }

  function show(elements) {
    ensureHost();
    descriptors = new Map((elements || []).map((e) => [e.id, e]));
    tagsVisible = true;
    refresh();
    return { shown: badgeLayer ? badgeLayer.children.length : 0, total: descriptors.size };
  }

  function hide() {
    tagsVisible = false;
    if (badgeLayer) badgeLayer.replaceChildren();
    return { shown: 0, total: descriptors.size };
  }

  function highlightNode(node, id) {
    ensureHost();
    highlightedNode = node;
    highlightedId = id;
    if (node.scrollIntoView) {
      node.scrollIntoView({ block: "center", inline: "center", behavior: reducedMotion() ? "auto" : "smooth" });
    }
    scheduleRefresh();
    if (win && win.setTimeout) {
      if (settleTimer !== null && win.clearTimeout) win.clearTimeout(settleTimer);
      settleTimer = win.setTimeout(() => { settleTimer = null; refresh(); }, 400);
    }
    refresh();
    return { status: "ok", id };
  }

  function highlightById(id, documentSessionId, revision, expectedSessionId) {
    if (expectedSessionId && documentSessionId !== expectedSessionId) {
      return { status: "wrong-session", id, reason: "documentSessionId mismatch" };
    }
    const resolved = resolveNode(id, revision);
    if (!resolved || resolved.status !== "ok" || !resolved.node) {
      return { status: (resolved && resolved.status) || "unknown", id, reason: (resolved && resolved.reason) || "not resolvable" };
    }
    return highlightNode(resolved.node, id);
  }

  function clearHighlight() {
    highlightedNode = null;
    highlightedId = null;
    if (ring) ring.style.display = "none";
  }

  function destroy() {
    stopListening();
    stopMutationObserver();
    if (settleTimer !== null && win && win.clearTimeout) win.clearTimeout(settleTimer);
    settleTimer = null;
    clearHighlight();
    descriptors = new Map();
    tagsVisible = false;
    if (host) host.remove();
    host = null; badgeLayer = null; ring = null;
  }

  function visibleBadgeText(badge) {
    const num = badge.querySelector(".num");
    if (badge.classList.contains("compact")) return num ? num.textContent : "";
    return badge.textContent;
  }

  function getState() {
    return {
      tagsVisible,
      badgeCount: badgeLayer ? badgeLayer.children.length : 0,
      badgeTexts: badgeLayer ? Array.from(badgeLayer.children).map((b) => visibleBadgeText(b)) : [],
      badges: badgeLayer ? Array.from(badgeLayer.children).map((b) => ({ id: b.getAttribute("data-target-id"), text: visibleBadgeText(b), compact: b.classList.contains("compact"), left: b.style.left, top: b.style.top })) : [],
      highlightedId,
      ringVisible: Boolean(ring && ring.style.display === "block"),
      hostPresent: Boolean(host),
    };
  }

  return { show, hide, highlightById, highlightNode, clearHighlight, refresh, scheduleRefresh, destroy, getState };
}

if (typeof globalThis !== "undefined") {
  globalThis.__seeyable_createOverlay = createOverlayController;
  globalThis.__seeyable_buildTagLabel = buildTagLabel;
  globalThis.__seeyable_numberFromId = numberFromId;
}
if (typeof module !== "undefined" && module.exports) {
  module.exports = { createOverlayController, buildTagLabel, numberFromId };
}
