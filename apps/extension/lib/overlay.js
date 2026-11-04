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

// Display-only annotations: authoring notes that ship inside accessible
// names (e.g. the demo fixture's "Nickname (placeholder only)") are
// stripped from floating tags and panel labels. The snapshot keeps the
// accessible name, its source, and the element identity untouched.
const DISPLAY_ANNOTATIONS = [/\(placeholder only\)\s*$/i];
function displayName(desc) {
  let name = (desc && desc.name ? String(desc.name) : "").trim();
  for (const re of DISPLAY_ANNOTATIONS) name = name.replace(re, "").trim();
  return name;
}

function truncateWords(text, cap) {
  if (text.length <= cap) return text;
  const cut = text.slice(0, cap - 1);
  const space = cut.lastIndexOf(" ");
  return (space > 8 ? cut.slice(0, space) : cut) + "…";
}

function buildTagLabel(desc, all, opts = {}) {
  const number = numberFromId(desc && desc.id);
  const name = displayName(desc);
  const role = (desc && desc.role) || "control";
  if (!name) return { text: `${role} ${number === null ? "" : number}`.trim(), number, uncertain: false };
  const peers = Array.isArray(all) ? all : [];
  const duplicate = name && peers.filter((e) => displayName(e) === name).length > 1;
  const needsQuestion = duplicate || /^\d+$/.test(name) || name.length <= 2;
  const question = (desc.question || "").trim();
  // Floating tags are short (~32 chars at a word boundary); the panel
  // list and the highlighted target use the full display label.
  const cap = opts.full ? Infinity : (opts.short === false ? 72 : 32);
  if (needsQuestion && question) {
    // Uncertain (proximity-inferred) context is marked, never presented
    // as verified.
    const marker = desc.questionCertain ? "" : " ?";
    return { text: truncateWords(`${question}${marker} · ${name}`, cap), number, uncertain: !desc.questionCertain };
  }
  // Field values (state) are deliberately never consulted for labels.
  return { text: truncateWords(name, cap), number, uncertain: false };
}

// Whitespace-first placement (pure): try above, below, right, then left
// of the target with a small gap. A spot must fit the viewport, must not
// cover the target's own box, and must not cover an already-placed badge.
// Returns the placed box or null when nothing fits — the caller omits the
// floating tag and leaves the label to the panel list. No collision
// engine, no pile-ups.
// One canonical box shape for all placement math: {left, top, width,
// height}. Rects arriving as {x, y} (getBoundingClientRect style) are
// normalized here so every comparison reads real coordinates — mixing
// the two shapes silently disabled neighbor exclusion in the past.
function toBox(b) {
  if (!b) return { left: 0, top: 0, width: 0, height: 0 };
  return {
    left: b.left !== undefined ? b.left : (b.x || 0),
    top: b.top !== undefined ? b.top : (b.y || 0),
    width: b.width || 0,
    height: b.height || 0,
  };
}
function boxesOverlap(a, b) {
  return a.left < b.left + b.width && a.left + a.width > b.left
    && a.top < b.top + b.height && a.top + a.height > b.top;
}
function chooseSpot(rect, size, viewport, placed, avoid, accept) {
  const gap = 4, margin = 2;
  const r = toBox(rect);
  const spots = [
    { left: r.left, top: r.top - size.height - gap },
    { left: r.left, top: r.top + r.height + gap },
    { left: r.left + r.width + gap, top: r.top },
    { left: r.left - size.width - gap, top: r.top },
  ];
  const vw = (viewport && viewport.width) || 0;
  const vh = (viewport && viewport.height) || 0;
  const target = { left: r.left, top: r.top, width: r.width, height: r.height };
  const others = (Array.isArray(avoid) ? avoid : []).map(toBox);
  const placedBoxes = (Array.isArray(placed) ? placed : []).map(toBox);
  for (const spot of spots) {
    const box = { left: Math.round(spot.left), top: Math.round(spot.top), width: size.width, height: size.height };
    if (vw && (box.left < margin || box.top < margin || box.left + box.width > vw - margin || box.top + box.height > vh - margin)) continue;
    if (boxesOverlap(box, target)) continue;
    if (placedBoxes.some((p) => boxesOverlap(box, p))) continue;
    // Never cover another control's box: labels and hit areas of
    // neighboring targets stay readable and clickable.
    if (others.some((o) => boxesOverlap(box, o))) continue;
    // Optional conservative clearance check (e.g. page text). When the
    // candidate cannot be verified clear, it is skipped like any other
    // obstruction; null means every spot failed.
    if (typeof accept === "function" && !accept(box)) continue;
    return box;
  }
  return null;
}

const OVERLAY_CSS = `
  :host { all: initial; }
  .layer { position: fixed; inset: 0; pointer-events: none; z-index: 2147483647; }
  .badge {
    position: fixed; display: flex; align-items: center; max-width: 240px;
    background: #141414; color: #F2F2EE; border: 1px solid rgba(242, 242, 238, 0.9);
    font: 12px/1.3 "Jost", system-ui, sans-serif; padding: 3px 4px 3px 10px;
    border-radius: 999px;
    transition: opacity 120ms ease;
  }
  .badge .word { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .badge .num {
    flex: 0 0 auto; display: inline-flex; align-items: center; justify-content: center;
    min-width: 22px; height: 22px; margin-left: 6px; padding: 0 4px;
    font: 11px/1 "DM Mono", ui-monospace, monospace;
    border: 1px solid rgba(242, 242, 238, 0.9); border-radius: 999px;
  }
  .ring {
    position: fixed; display: none; pointer-events: none; border-radius: 6px;
    border: 3px solid #F2F2EE; box-shadow: 0 0 0 2px #141414, inset 0 0 0 1px #141414;
    transition: opacity 120ms ease;
  }
  /* Step states (Plain Words). Colour AND glyph AND word, never colour
     alone; theme-independent because tags sit on other people's pages.
     amber = acting now, sage = verified done, brick = held by the gate. */
  .badge .glyph { flex: 0 0 auto; margin-right: 6px; font: 11px/1 "DM Mono", ui-monospace, monospace; }
  .badge.state-acting { background: #F2B33D; color: #141414; border: 2px solid #141414; }
  .badge.state-acting .num { background: #141414; color: #F2B33D; border-color: #141414; }
  .badge.state-done { background: #D9E6D8; color: #2E4E37; border: 1px solid #2E4E37; }
  .badge.state-done .num { background: #2E4E37; color: #D9E6D8; border-color: #2E4E37; }
  .badge.state-held { background: #B3401F; color: #FFFFFF; border: 2px solid #141414; }
  .badge.state-held .num { background: #FFFFFF; color: #B3401F; border-color: #FFFFFF; }
  .state-ring {
    position: fixed; display: none; pointer-events: none; border-radius: 6px;
    border: 3px solid #F2B33D; box-shadow: 0 0 0 2px #141414;
  }
  .state-ring.state-held { border-color: #B3401F; box-shadow: 0 0 0 2px #FFFFFF, 0 0 0 4px #141414; }
  @media (prefers-reduced-motion: reduce) {
    .badge, .ring { transition: none; }
  }
  @media (forced-colors: active) {
    .badge { background: Canvas; color: CanvasText; border-color: CanvasText; forced-color-adjust: none; }
    .badge.state-acting, .badge.state-held, .badge.state-done { background: Canvas; color: CanvasText; border: 2px solid CanvasText; }
    .ring, .state-ring { border-color: Highlight; box-shadow: 0 0 0 2px CanvasText; }
  }
`;

// Step states shown on tags. Only these three exist; anything else is
// ignored. "done" is sent by the panel only for verified steps.
const TAG_STATES = { acting: { glyph: "\u25CF", word: "" }, done: { glyph: "\u25A0", word: "" }, held: { glyph: "\u25B2", word: " \u00B7 held" } };
const DONE_FADE_MS = 4000;

function visibleOverflow(value) {
  return value !== "auto" && value !== "scroll" && value !== "hidden";
}

// A badge must not float for a target that its own scroll container
// has scrolled (or clipped) out of view: walk the ancestors for the
// nearest clipping container and require overlap with its visible
// region on every clipped axis. Viewport exclusion is handled
// separately in refresh().
function clippedByScroller(docRef, win, node, rect) {
  let ancestor = node.parentElement;
  while (ancestor && ancestor !== docRef.body && ancestor !== docRef.documentElement) {
    let overflowX = "";
    let overflowY = "";
    try {
      const cs = win && win.getComputedStyle ? win.getComputedStyle(ancestor) : null;
      if (cs) { overflowX = cs.overflowX || ""; overflowY = cs.overflowY || ""; }
    } catch { /* unstyled context (tests): fall back to inline style */ }
    if (!overflowX && ancestor.style) overflowX = ancestor.style.overflowX || ancestor.style.overflow || "";
    if (!overflowY && ancestor.style) overflowY = ancestor.style.overflowY || ancestor.style.overflow || "";
    const clipX = !visibleOverflow(overflowX);
    const clipY = !visibleOverflow(overflowY);
    if ((clipX || clipY) && ancestor.getBoundingClientRect) {
      const s = ancestor.getBoundingClientRect();
      const outsideX = rect.x + rect.width <= s.x || rect.x >= s.x + s.width;
      const outsideY = rect.y + rect.height <= s.y || rect.y >= s.y + s.height;
      if ((clipX && outsideX) || (clipY && outsideY)) return true;
    }
    ancestor = ancestor.parentElement;
  }
  return false;
}

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
  let omitted = []; // valid targets with no whitespace for a floating tag
  let placedById = new Map(); // id -> placed box, for tests/diagnostics
  let highlightedId = null;
  let highlightedNode = null;
  let stateRing = null;
  let targetStates = new Map(); // id -> "acting" | "done" | "held"
  let doneTimer = null;
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
    stateRing = docRef.createElement("div");
    stateRing.className = "state-ring";
    shadow.append(style, badgeLayer, ring, stateRing);
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

  // Conservative rendered-content check for candidate spots. Control
  // rectangles alone miss the labels, legends, and plain text around a
  // target, so each candidate is sampled on a 3x3 grid with the
  // browser's own hit test. A point counts as occupied when the hit
  // element is interactive (or inside an interactive element/label),
  // carries direct rendered text, or renders shadow text. Bare
  // background and empty containers count as clear. Limits, honestly:
  // text falling strictly between sample points can be missed, and in
  // non-layout environments (no hit test) geometry checks alone
  // govern — production Chrome always hit-tests.
  function hitIsRenderedContent(el) {
    if (!el) return false; // nothing rendered at that point
    const tag = el.tagName || "";
    if (tag === "HTML" || tag === "BODY") return false;
    if (typeof el.closest === "function"
      && el.closest("a, button, input, select, textarea, label, summary, [role='button'], [role='link'], [contenteditable]")) return true;
    if (el.shadowRoot && el.shadowRoot.textContent && el.shadowRoot.textContent.trim()) return true;
    for (const node of el.childNodes || []) {
      if (node.nodeType === 3 && node.textContent && node.textContent.trim()) return true;
    }
    return false;
  }

  function spotClearOfPageContent(box) {
    if (!docRef || typeof docRef.elementFromPoint !== "function") return true;
    const xs = [box.left + 2, Math.round(box.left + box.width / 2), box.left + box.width - 2];
    const ys = [box.top + 2, Math.round(box.top + box.height / 2), box.top + box.height - 2];
    for (const y of ys) {
      for (const x of xs) {
        let el = null;
        try { el = docRef.elementFromPoint(Math.round(x), Math.round(y)); }
        catch { return false; } // cannot verify clear: treat as occupied
        if (hitIsRenderedContent(el)) return false;
      }
    }
    return true;
  }

  function setBadgeLabel(badge, desc, full) {
    const label = buildTagLabel(desc, Array.from(descriptors.values()), full ? { full: true } : { short: true });
    const word = badge.querySelector(".word");
    const num = badge.querySelector(".num");
    const glyph = badge.querySelector(".glyph");
    const tagState = TAG_STATES[targetStates.get(desc.id)] ? targetStates.get(desc.id) : null;
    badge.className = tagState ? `badge state-${tagState}` : "badge";
    if (glyph) glyph.textContent = tagState ? TAG_STATES[tagState].glyph : "";
    if (glyph) glyph.hidden = !tagState;
    const wordText = label.text + (tagState ? TAG_STATES[tagState].word : "");
    label.text = wordText;
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
    refreshStateRing();
    if (!tagsVisible) return;
    const vw = win && win.innerWidth ? win.innerWidth : 0;
    const vh = win && win.innerHeight ? win.innerHeight : 0;
    const seen = new Set();
    const placed = [];
    const unplaced = [];
    // The explicitly highlighted target is placed first (placement
    // order only). Every badge, highlighted or not, must find a spot
    // that is clear of controls, placed badges, and rendered page
    // content; crowded-out targets are omitted and stay discoverable
    // in the panel's target list instead of piling up.
    // First pass: resolve every descriptor to its live box. Second-pass
    // placement avoids all of these, so a floating tag never covers a
    // neighboring control's box either.
    const live = [];
    for (const [id, desc] of descriptors) {
      const resolved = resolveNode(id);
      if (!resolved || resolved.status !== "ok" || !resolved.node) continue; // invalid target: omit tag
      const node = resolved.node;
      const r = node.getBoundingClientRect ? node.getBoundingClientRect() : null;
      if (!r || (r.width === 0 && r.height === 0)) continue;
      const rx = r.x !== undefined ? r.x : r.left || 0;
      const ry = r.y !== undefined ? r.y : r.top || 0;
      if (clippedByScroller(docRef, win, node, { x: rx, y: ry, width: r.width, height: r.height })) continue;
      // Exclude fully offscreen controls on BOTH axes: no edge badges.
      if (vw && (rx + r.width <= 0 || rx >= vw)) continue;
      if (vh && (ry + r.height <= 0 || ry >= vh)) continue;
      live.push({ id, desc, rect: { x: rx, y: ry, width: r.width, height: r.height } });
    }
    // Placement ORDER only: the highlighted target, then targets with a
    // step state. No exemption from the clearance rules for either.
    const rank = (t) => (t.id === highlightedId ? 0 : targetStates.has(t.id) ? 1 : 2);
    const ordered = live.sort((a, b) => rank(a) - rank(b));
    for (const { id, desc, rect } of ordered) {
      const rx = rect.x;
      const ry = rect.y;
      seen.add(id);
      let badge = badgeLayer.querySelector(`[data-target-id="${id}"]`);
      if (!badge) {
        badge = docRef.createElement("div");
        badge.className = "badge";
        badge.setAttribute("data-target-id", id);
        const glyph = docRef.createElement("span");
        glyph.className = "glyph";
        glyph.hidden = true;
        const word = docRef.createElement("span");
        word.className = "word";
        const num = docRef.createElement("span");
        num.className = "num";
        badge.append(glyph, word, num);
        badgeLayer.append(badge);
      }
      // Always refresh text from the current descriptor (labels change).
      const isActive = id === highlightedId;
      const label = setBadgeLabel(badge, desc, isActive);
      const size = badgeSize(badge, label);
      // Neighboring controls' boxes are off-limits too, so a tag never
      // covers another target's box; the content check additionally
      // keeps it off rendered labels and text. The explicitly
      // highlighted target gets NO exemption: safe placement first,
      // and when nothing is safe it keeps its ring and its full label
      // in the panel instead of text forced over the page.
      const neighbors = live.filter((t) => t.id !== id).map((t) => t.rect);
      const box = chooseSpot(rect, size, { width: vw, height: vh }, placed, neighbors, spotClearOfPageContent);
      if (!box) {
        badge.remove();
        unplaced.push(id);
        continue;
      }
      badge.style.left = `${box.left}px`;
      badge.style.top = `${box.top}px`;
      placed.push({ ...box, id });
    }
    omitted = unplaced;
    placedById = new Map(placed.map((p) => [p.id, p]));
    for (const badge of Array.from(badgeLayer.children)) {
      if (!seen.has(badge.getAttribute("data-target-id"))) badge.remove();
    }
  }

  // With tags off, only the element being acted on (or held) is outlined.
  // The ring follows the same identity revalidation as the highlight ring.
  function refreshStateRing() {
    if (!stateRing) return;
    let id = null;
    let kind = null;
    for (const [tid, st] of targetStates) {
      if (st === "held") { id = tid; kind = "held"; break; }
      if (st === "acting" && !id) { id = tid; kind = "acting"; }
    }
    const resolved = id ? resolveNode(id) : null;
    if (!id || tagsVisible || !resolved || resolved.status !== "ok" || !resolved.node || !resolved.node.getBoundingClientRect) {
      stateRing.style.display = "none";
      return;
    }
    const r = resolved.node.getBoundingClientRect();
    stateRing.className = `state-ring state-${kind}`;
    stateRing.style.display = "block";
    stateRing.style.left = `${Math.round((r.x !== undefined ? r.x : r.left) - 6)}px`;
    stateRing.style.top = `${Math.round((r.y !== undefined ? r.y : r.top) - 6)}px`;
    stateRing.style.width = `${Math.round(r.width + 12)}px`;
    stateRing.style.height = `${Math.round(r.height + 12)}px`;
  }

  // A person should see what they are asked to approve. Scrolls only when
  // the target is not fully in view, so a visible page is left undisturbed.
  function bringHeldTargetIntoView(id) {
    const resolved = resolveNode(id);
    const node = resolved && resolved.status === "ok" ? resolved.node : null;
    if (!node || !node.getBoundingClientRect || !node.scrollIntoView) return;
    const r = node.getBoundingClientRect();
    const height = (win && win.innerHeight) || 0;
    const width = (win && win.innerWidth) || 0;
    if (r.top >= 0 && r.left >= 0 && r.bottom <= height && r.right <= width) return;
    node.scrollIntoView({ block: "center", inline: "center", behavior: reducedMotion() ? "auto" : "smooth" });
    if (win && win.setTimeout) win.setTimeout(() => refresh(), 400);
  }

  // Replaces all step states at once (the panel sends the whole picture
  // for its current step). Unknown ids or states are dropped; "done"
  // states clear themselves after DONE_FADE_MS. Placement is unchanged:
  // a state never forces a tag onto the page.
  function setTargetStates(states) {
    const next = new Map();
    for (const [id, st] of Object.entries(states || {})) {
      if (/^el-\d+$/.test(id) && TAG_STATES[st]) next.set(id, st);
    }
    const newlyHeld = [...next].find(([id, st]) => st === "held" && targetStates.get(id) !== "held");
    targetStates = next;
    if (newlyHeld) bringHeldTargetIntoView(newlyHeld[0]);
    if (doneTimer !== null && win && win.clearTimeout) win.clearTimeout(doneTimer);
    doneTimer = null;
    if ([...next.values()].some((st) => st === "done") && win && win.setTimeout) {
      doneTimer = win.setTimeout(() => {
        doneTimer = null;
        for (const [id, st] of targetStates) if (st === "done") targetStates.delete(id);
        refresh();
      }, DONE_FADE_MS);
    }
    if (next.size > 0) ensureHost();
    refresh();
    return { states: next.size };
  }

  function show(elements) {
    ensureHost();
    descriptors = new Map((elements || []).map((e) => [e.id, e]));
    tagsVisible = true;
    refresh();
    return { shown: badgeLayer ? badgeLayer.children.length : 0, total: descriptors.size, unplaced: [...omitted] };
  }

  function hide() {
    tagsVisible = false;
    omitted = [];
    placedById = new Map();
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
    if (doneTimer !== null && win && win.clearTimeout) win.clearTimeout(doneTimer);
    doneTimer = null;
    targetStates = new Map();
    omitted = [];
    placedById = new Map();
    stopMutationObserver();
    if (settleTimer !== null && win && win.clearTimeout) win.clearTimeout(settleTimer);
    settleTimer = null;
    clearHighlight();
    descriptors = new Map();
    tagsVisible = false;
    if (host) host.remove();
    host = null; badgeLayer = null; ring = null; stateRing = null;
  }

  function visibleBadgeText(badge) {
    return badge.textContent;
  }

  function getState() {
    return {
      tagsVisible,
      badgeCount: badgeLayer ? badgeLayer.children.length : 0,
      badgeTexts: badgeLayer ? Array.from(badgeLayer.children).map((b) => visibleBadgeText(b)) : [],
      badges: badgeLayer ? Array.from(badgeLayer.children).map((b) => { const box = placedById.get(b.getAttribute("data-target-id")) || { width: 0, height: 0 }; return { id: b.getAttribute("data-target-id"), text: visibleBadgeText(b), left: b.style.left, top: b.style.top, width: box.width, height: box.height }; }) : [],
      unplaced: [...omitted],
      highlightedId,
      ringVisible: Boolean(ring && ring.style.display === "block"),
      targetStates: Object.fromEntries(targetStates),
      stateRingVisible: Boolean(stateRing && stateRing.style.display === "block"),
      badgeStates: badgeLayer ? Object.fromEntries(Array.from(badgeLayer.children).map((b) => [b.getAttribute("data-target-id"), (b.className.match(/state-(\w+)/) || [])[1] || null])) : {},
      hostPresent: Boolean(host),
    };
  }

  return { show, hide, highlightById, highlightNode, clearHighlight, setTargetStates, refresh, scheduleRefresh, destroy, getState };
}

if (typeof globalThis !== "undefined") {
  globalThis.__seeyable_createOverlay = createOverlayController;
  globalThis.__seeyable_buildTagLabel = buildTagLabel;
  globalThis.__seeyable_displayName = displayName;
  globalThis.__seeyable_chooseSpot = chooseSpot;
  globalThis.__seeyable_numberFromId = numberFromId;
}
if (typeof module !== "undefined" && module.exports) {
  module.exports = { createOverlayController, buildTagLabel, displayName, chooseSpot, numberFromId };
}
