"use strict";
/*
 * Production DOM/ARIA snapshot engine for Seeyable.
 *
 * UI-independent: no chrome.* APIs, no side-panel code. The content script
 * (content.js) owns the per-document engine instance and the messaging;
 * this module can be reused from tests or future components unchanged.
 *
 * Contract: docs/snapshot-schema.md (schemaVersion 2).
 * Accessible-name priority: aria-label -> aria-labelledby -> associated
 * <label> -> element text/value -> placeholder -> title. The winning step
 * is reported as `nameSource`.
 */

const INTERACTIVE_ROLES = new Set([
  "button", "link", "textbox", "searchbox", "checkbox", "radio", "switch",
  "slider", "spinbutton", "combobox", "listbox", "option", "menuitem",
  "menuitemcheckbox", "menuitemradio", "tab", "treeitem",
]);
const IMPLICIT_ROLE = { BUTTON: "button", SELECT: "combobox", TEXTAREA: "textbox", SUMMARY: "button" };

function implicitRole(el) {
  const tag = el.tagName;
  if (tag === "A") return el.hasAttribute("href") ? "link" : null;
  if (tag === "INPUT") {
    const t = (el.getAttribute("type") || "text").toLowerCase();
    if (t === "hidden") return null;
    if (t === "checkbox") return "checkbox";
    if (t === "radio") return "radio";
    if (t === "range") return "slider";
    if (t === "number") return "spinbutton";
    if (t === "search") return "searchbox";
    if (t === "button" || t === "submit" || t === "reset" || t === "image") return "button";
    return "textbox";
  }
  return IMPLICIT_ROLE[tag] || null;
}
function explicitRole(el) {
  const raw = el.getAttribute && el.getAttribute("role");
  if (!raw) return null;
  return raw.trim().split(/\s+/)[0].toLowerCase() || null;
}
function roleOf(el) { return explicitRole(el) || implicitRole(el); }

const NONINTERACTIVE_ROLES = new Set(["img", "presentation", "none", "heading", "paragraph"]);

function isInteractive(el) {
  // An explicitly non-interactive role is never a target, even when the
  // element has an accessible name or tabindex (e.g. role="img").
  const explicit = explicitRole(el);
  if (explicit && NONINTERACTIVE_ROLES.has(explicit)) return false;
  const role = roleOf(el);
  if (role && INTERACTIVE_ROLES.has(role)) return true;
  if (el.isContentEditable) return true;
  const ti = el.getAttribute && el.getAttribute("tabindex");
  if (ti !== null && ti !== undefined && parseInt(ti, 10) >= 0 && el.tagName === "DIV" && el.hasAttribute("tabindex")) return true;
  return false;
}

function isVisible(el, view) {
  const doc = el.ownerDocument;
  const win = view || (doc && doc.defaultView);
  let node = el;
  while (node && node.nodeType === 1) {
    if (node.hidden) return false;
    if (node.getAttribute && node.getAttribute("aria-hidden") === "true") return false;
    if (win && win.getComputedStyle) {
      const cs = win.getComputedStyle(node);
      if (cs.display === "none" || cs.visibility === "hidden" || cs.visibility === "collapse") return false;
    }
    node = node.parentElement;
  }
  return true;
}

function cleanText(s) { return (s || "").replace(/\s+/g, " ").trim(); }
function textOf(el) {
  if (!el) return "";
  const t = "innerText" in el && el.innerText ? el.innerText : el.textContent;
  return cleanText(t);
}

function associatedLabelText(el) {
  const doc = el.ownerDocument;
  const id = el.getAttribute && el.getAttribute("id");
  if (id && doc && doc.querySelectorAll) {
    const labels = doc.querySelectorAll("label[for]");
    for (const lab of labels) if (lab.getAttribute("for") === id) {
      const t = cleanText(lab.textContent);
      if (t) return t;
    }
  }
  const wrap = el.closest ? el.closest("label") : null;
  if (wrap) {
    const t = cleanText(wrap.textContent);
    if (t) return t;
  }
  return "";
}

function labelledByText(el) {
  const ref = el.getAttribute && el.getAttribute("aria-labelledby");
  if (!ref) return "";
  const doc = el.ownerDocument;
  const parts = ref.trim().split(/\s+/).map((refId) => {
    const node = doc && doc.getElementById ? doc.getElementById(refId) : null;
    return node ? textOf(node) : "";
  }).filter(Boolean);
  return cleanText(parts.join(" "));
}

function computeAccessibleName(el) {
  const ariaLabel = cleanText(el.getAttribute && el.getAttribute("aria-label"));
  if (ariaLabel) return { name: ariaLabel, source: "aria-label" };
  const by = labelledByText(el);
  if (by) return { name: by, source: "aria-labelledby" };
  const labelText = associatedLabelText(el);
  if (labelText) return { name: labelText, source: "label" };
  if (el.tagName === "INPUT") {
    const t = (el.getAttribute("type") || "").toLowerCase();
    if (t === "button" || t === "submit" || t === "reset" || t === "image") {
      const v = cleanText(el.getAttribute("value") || el.getAttribute("alt"));
      if (v) return { name: v, source: "value" };
    }
  } else {
    const inner = textOf(el);
    if (inner) return { name: inner, source: "text" };
  }
  const ph = cleanText(el.getAttribute && el.getAttribute("placeholder"));
  if (ph) return { name: ph, source: "placeholder" };
  const title = cleanText(el.getAttribute && el.getAttribute("title"));
  if (title) return { name: title, source: "title" };
  return { name: "", source: "none" };
}

/* --- Sensitive-field classification (single, centralized implementation) --- */
const SENSITIVE_HINT = /(social[-\s]?security|\bssn\b|tax[-\s]?id|credit[-\s]?card|card[-\s]?number|\bcc[-\s]?number\b|\bcvv\b|\bcvc\b|security[-\s]?code|\bpin\b|password|passwd)/i;
const SENSITIVE_AUTOCOMPLETE = new Set(["cc-number", "cc-csc", "cc-exp", "cc-exp-month", "cc-exp-year"]);

function sensitiveInfo(el) {
  const type = ((el.getAttribute && el.getAttribute("type")) || "").toLowerCase();
  const autocomplete = ((el.getAttribute && el.getAttribute("autocomplete")) || "").toLowerCase();
  let sensitive = type === "password" || SENSITIVE_AUTOCOMPLETE.has(autocomplete);
  if (!sensitive) {
    const hints = [
      el.getAttribute && el.getAttribute("name"),
      el.getAttribute && el.getAttribute("id"),
      autocomplete,
      el.getAttribute && el.getAttribute("aria-label"),
      associatedLabelText(el),
    ].filter(Boolean).join(" ");
    sensitive = SENSITIVE_HINT.test(hints);
  }
  const filled = typeof el.value === "string" ? el.value.length > 0 : Boolean(el.checked);
  return { sensitive, filled };
}

function stateOf(el, role) {
  const state = {};
  const disabled = Boolean(el.disabled) || (el.getAttribute && el.getAttribute("aria-disabled") === "true");
  if (disabled) state.disabled = true;
  if (["checkbox", "radio", "switch", "menuitemcheckbox", "menuitemradio"].includes(role)) {
    if (typeof el.checked === "boolean") state.checked = el.checked;
    const ac = el.getAttribute && el.getAttribute("aria-checked");
    if (ac !== null && ac !== undefined && ac !== "") state.checked = ac === "true" ? true : ac === "mixed" ? "mixed" : false;
  }
  const expanded = el.getAttribute && el.getAttribute("aria-expanded");
  if (expanded !== null && expanded !== undefined && expanded !== "") state.expanded = expanded === "true";
  const pressed = el.getAttribute && el.getAttribute("aria-pressed");
  if (pressed !== null && pressed !== undefined && pressed !== "") state.pressed = pressed === "true" ? true : pressed === "mixed" ? "mixed" : false;
  const selectedAttr = el.getAttribute && el.getAttribute("aria-selected");
  if (selectedAttr !== null && selectedAttr !== undefined && selectedAttr !== "") state.selected = selectedAttr === "true";
  if (el.tagName === "OPTION" && el.selected) state.selected = true;
  if (el.required || (el.getAttribute && el.getAttribute("aria-required") === "true")) state.required = true;
  if (el.readOnly || (el.getAttribute && el.getAttribute("aria-readonly") === "true")) state.readonly = true;
  const invalid = el.getAttribute && el.getAttribute("aria-invalid");
  if (invalid && invalid !== "false") state.invalid = invalid === "true" ? true : invalid;

  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
    const type = ((el.getAttribute && el.getAttribute("type")) || "").toLowerCase();
    const info = sensitiveInfo(el);
    if (info.sensitive) {
      // Never expose the raw value; filled-ness is the only signal released.
      state.redacted = true;
      state.filled = info.filled;
    } else if (tag === "SELECT") {
      const opt = el.options && el.selectedIndex >= 0 ? el.options[el.selectedIndex] : null;
      if (opt) state.value = cleanText(opt.textContent);
    } else if (type === "checkbox" || type === "radio") {
      // checked already conveys state.
    } else if (typeof el.value === "string" && el.value !== "") {
      state.value = el.value.length > 80 ? el.value.slice(0, 80) + "…" : el.value;
    }
  }
  return state;
}

function cssPath(el) {
  const parts = [];
  let node = el;
  while (node && node.nodeType === 1 && node.tagName !== "HTML") {
    let part = node.tagName.toLowerCase();
    if (node.id) { part += "#" + node.id; parts.unshift(part); break; }
    const parent = node.parentElement;
    if (parent) {
      const siblings = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
      if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
    }
    parts.unshift(part);
    node = node.parentElement;
  }
  return parts.join(" > ");
}

/* --- Question context: the prompt a control answers, kept separate from its name --- */
function headingBefore(scope, el) {
  if (!scope || !scope.querySelectorAll) return null;
  const headings = scope.querySelectorAll("h1, h2, h3, h4, h5, h6, [role='heading'], legend");
  let best = null;
  for (const h of headings) {
    if (h.compareDocumentPosition && (h.compareDocumentPosition(el) & 4)) best = h;
    else if (!h.compareDocumentPosition) best = h;
  }
  return best;
}

function questionOf(el) {
  // 1. Fieldset/legend — the standards-based group prompt.
  const fieldset = el.closest ? el.closest("fieldset") : null;
  if (fieldset) {
    const legend = fieldset.querySelector("legend");
    if (legend && textOf(legend)) return { question: textOf(legend), source: "fieldset-legend", certain: true };
  }
  // 2. ARIA group / radiogroup with its own accessible name.
  const group = el.closest ? el.closest("[role='radiogroup'], [role='group'], [role='listbox']") : null;
  if (group) {
    const named = cleanText(group.getAttribute("aria-label")) || labelledByText(group);
    if (named) return { question: named, source: "group-aria", certain: true };
    const h = headingBefore(group, el);
    if (h && textOf(h)) return { question: textOf(h), source: "group-heading", certain: false };
  }
  // Form-wide actions (Submit, Clear form, standalone buttons) have no
  // question unless a group relationship above already provided one.
  // Associating them with the last question by proximity fabricates a
  // relationship that does not exist; their context stays form-level.
  if (roleOf(el) === "button") return { question: null, source: null, certain: false };
  // 3. Heading inside a semantic container (section/form/listitem-like ancestor).
  let node = el.parentElement;
  for (let depth = 0; node && depth < 6; depth += 1, node = node.parentElement) {
    if (["SECTION", "ARTICLE", "FORM", "LI"].includes(node.tagName) || explicitRole(node) === "listitem") {
      const h = headingBefore(node, el);
      if (h && textOf(h)) return { question: textOf(h), source: "container-heading", certain: false };
      break;
    }
  }
  // 4. Any nearby heading in the closest section/form scope (proximity inference).
  const scope = (el.closest && el.closest("section, article, form, main")) || null;
  if (scope) {
    const h = headingBefore(scope, el);
    if (h && textOf(h)) return { question: textOf(h), source: "section-heading", certain: false };
  }
  return { question: null, source: null, certain: false };
}

function contextOf(el, question) {
  const bits = [];
  if (question) bits.push(`question: "${question}"`);
  const scope = (el.closest && (el.closest("section, article, form, fieldset, main, [role='region']"))) || el.ownerDocument.body;
  // Standalone buttons keep form-level context only (see questionOf).
  const best = question === null && roleOf(el) === "button" ? null : scope ? headingBefore(scope, el) : null;
  if (best && textOf(best) !== question) bits.push(`${best.tagName.toLowerCase()}: "${textOf(best)}"`);
  const fieldset = el.closest ? el.closest("fieldset") : null;
  if (fieldset) {
    const legend = fieldset.querySelector("legend");
    if (legend && textOf(legend) !== question) bits.push(`group: "${textOf(legend)}"`);
  }
  const form = el.closest ? el.closest("form") : null;
  if (form) {
    const label = cleanText(form.getAttribute("aria-label") || form.getAttribute("name") || form.getAttribute("id"));
    if (label) bits.push(`form: "${label}"`);
  }
  let node = el.parentElement;
  while (node) {
    const r = explicitRole(node) || implicitRole(node);
    const landmark = { HEADER: "banner", NAV: "navigation", MAIN: "main", FOOTER: "contentinfo", ASIDE: "complementary" }[node.tagName];
    const name = r || landmark;
    if (name && ["banner", "navigation", "main", "contentinfo", "complementary", "region", "form", "search"].includes(name)) {
      bits.push(`landmark: ${name}`);
      break;
    }
    node = node.parentElement;
  }
  return bits.join(" · ");
}

function structureOf(docRef, win) {
  const headings = [];
  const seenLandmarks = new Set();
  const landmarks = [];
  for (const el of Array.from(docRef.querySelectorAll("h1, h2, h3, h4, h5, h6, [role='heading']"))) {
    if (!isVisible(el, win)) continue;
    const level = el.tagName[0] === "H" ? Number(el.tagName[1]) : Number(el.getAttribute("aria-level") || 2);
    headings.push({ level, text: textOf(el) });
  }
  for (const el of Array.from(docRef.querySelectorAll("header, nav, main, footer, aside, [role='region'], [role='search']"))) {
    if (!isVisible(el, win)) continue;
    const role = explicitRole(el) || { HEADER: "banner", NAV: "navigation", MAIN: "main", FOOTER: "contentinfo", ASIDE: "complementary" }[el.tagName];
    if (!role || seenLandmarks.has(el)) continue;
    seenLandmarks.add(el);
    landmarks.push({ role, name: cleanText(el.getAttribute("aria-label")) || labelledByText(el) || "" });
  }
  return { headings, landmarks };
}

function identityFingerprint(el) {
  return [
    el.tagName.toLowerCase(),
    ((el.getAttribute && el.getAttribute("type")) || "").toLowerCase(),
    (el.getAttribute && el.getAttribute("id")) || "",
    (el.getAttribute && el.getAttribute("name")) || "",
    roleOf(el) || "",
  ].join("|");
}

/* --- Collection --- */
function collectElements(docRef, win, assignId, includeRect) {
  const all = Array.from(docRef.querySelectorAll("*"));
  const elements = [];
  let candidates = 0;
  let excludedHidden = 0;
  for (const el of all) {
    // Overlay UI (badges/ring) must never snapshot itself.
    if (el.closest && el.closest("[data-seeyable-overlay]")) continue;
    if (!isInteractive(el)) continue;
    candidates += 1;
    if (!isVisible(el, win)) { excludedHidden += 1; continue; }
    const role = roleOf(el) || "generic";
    const { name, source } = computeAccessibleName(el);
    const q = questionOf(el);
    const state = stateOf(el, role);
    const disabled = Boolean(state.disabled);
    const readonly = Boolean(state.readonly);
    const actionable = !disabled && !readonly;
    const rect = includeRect && typeof el.getBoundingClientRect === "function"
      ? (() => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) }; })()
      : null;
    let inViewport = true;
    if (rect && win && win.innerHeight && (rect.width > 0 || rect.height > 0)) {
      // `rect` is stored as {x, y, width, height}; edges must be derived.
      // (Reading rect.top/bottom/left/right here always yielded undefined
      // and classified every laid-out control as offscreen.)
      inViewport = rect.y + rect.height > 0 && rect.x + rect.width > 0 &&
        rect.y < win.innerHeight && rect.x < (win.innerWidth || 0);
    }
    elements.push({
      id: assignId(el),
      role, name, nameSource: source,
      question: q.question, questionSource: q.source, questionCertain: q.certain,
      context: contextOf(el, q.question),
      state,
      actionable,
      actionableReason: actionable ? null : disabled ? "disabled" : "readonly",
      inViewport,
      tag: el.tagName.toLowerCase(),
      domId: (el.getAttribute && el.getAttribute("id")) || null,
      testId: (el.getAttribute && (el.getAttribute("data-testid") || el.getAttribute("data-test-id"))) || null,
      cssPath: cssPath(el),
      rect,
    });
  }
  return { elements, diagnostics: { candidateCount: candidates, excludedHidden, includedCount: elements.length } };
}

/* --- Semantic normalization, hash, delta (addendum) ---
 * Only IDs, roles, names, question contexts and relevant states are compared.
 * Timestamps, rectangles, locators and raw sensitive values (never present;
 * redacted state carries only `filled`) are excluded by construction. */
function normalizeElements(elements) {
  return elements.map((e) => {
    const state = {};
    for (const key of Object.keys(e.state || {}).sort()) state[key] = e.state[key];
    return [e.id, e.role, e.name, e.question || "", state];
  }).sort((a, b) => String(a[0]).localeCompare(String(b[0]), undefined, { numeric: true }));
}
function semanticHash(normalized) {
  const text = JSON.stringify(normalized);
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, "0") + (h1 >>> 0).toString(16).padStart(8, "0");
}
const SEMANTIC_FIELDS = ["role", "name", "question", "state"];
function diffNormalized(prev, next) {
  const before = new Map((prev || []).map((row) => [row[0], row]));
  const after = new Map((next || []).map((row) => [row[0], row]));
  const added = []; const removed = []; const updated = [];
  for (const id of after.keys()) if (!before.has(id)) added.push(id);
  for (const [id, row] of before) {
    if (!after.has(id)) { removed.push(id); continue; }
    const other = after.get(id);
    const changedFields = [];
    for (let i = 0; i < SEMANTIC_FIELDS.length; i += 1) {
      if (JSON.stringify(row[i + 1]) !== JSON.stringify(other[i + 1])) changedFields.push(SEMANTIC_FIELDS[i]);
    }
    if (changedFields.length) updated.push({ id, changedFields });
  }
  return { added, removed, updated };
}

/* --- Engine: per-document session with stable identity + invalidation --- */
function createSnapshotEngine(doc, view, options = {}) {
  const docRef = doc || (typeof document !== "undefined" ? document : null);
  if (!docRef) throw new Error("createSnapshotEngine: no document available");
  const win = view || docRef.defaultView || (typeof window !== "undefined" ? window : null);
  const debounceMs = options.debounceMs !== undefined ? options.debounceMs : 250;
  const onInvalidate = typeof options.onInvalidate === "function" ? options.onInvalidate : null;

  const sessionId = `doc-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
  let counter = 0;
  const byElement = new WeakMap();
  const byId = new Map();
  let revision = 0;
  let lastHash = null;
  let lastNormalized = null;
  let lastDelta = null;
  let fresh = false;
  let observer = null;
  let timer = null;
  let listening = false;

  function assignId(el) {
    let id = byElement.get(el);
    if (id) return id;
    counter += 1;
    id = `el-${counter}`;
    byElement.set(el, id);
    const ref = typeof WeakRef !== "undefined" ? new WeakRef(el) : null;
    byId.set(id, { ref, el: ref ? null : el, fingerprint: identityFingerprint(el) });
    return id;
  }

  function buildNormalized() {
    // Cheap semantic pass: no geometry needed for change detection.
    let n = 0;
    const assign = (el) => byElement.get(el) || `tmp-${(n += 1)}`;
    // Use real IDs where assigned; unassigned new controls get a positional
    // placeholder here and a permanent ID on the next full snapshot. To keep
    // `added` deltas meaningful, assign permanent IDs during checks as well.
    void assign;
    const { elements } = collectElements(docRef, win, assignId, false);
    return { elements, normalized: normalizeElements(elements) };
  }

  function snapshot() {
    const started = Date.now();
    const { elements, diagnostics } = collectElements(docRef, win, assignId, true);
    const normalized = normalizeElements(elements);
    const hash = semanticHash(normalized);
    if (hash !== lastHash) revision += 1;
    lastHash = hash;
    lastNormalized = normalized;
    fresh = true;
    lastDelta = null;
    return {
      schemaVersion: 2,
      kind: "dom-aria",
      documentSessionId: sessionId,
      revision,
      semanticHash: hash,
      fresh: true,
      url: docRef.location ? docRef.location.href : null,
      title: docRef.title || null,
      capturedAt: new Date().toISOString(),
      durationMs: Date.now() - started,
      elementCount: elements.length,
      structure: structureOf(docRef, win),
      diagnostics,
      elements,
    };
  }

  function resolve(id, expectedRevision) {
    if (expectedRevision !== undefined && expectedRevision !== null && expectedRevision !== revision) {
      return { id, status: "stale", reason: "revision-mismatch", revision, documentSessionId: sessionId };
    }
    if (!fresh && lastHash !== null) {
      return { id, status: "stale", reason: "snapshot-invalidated", revision, documentSessionId: sessionId };
    }
    const record = byId.get(id);
    if (!record) return { id, status: "unknown", reason: "not-in-session", revision, documentSessionId: sessionId };
    const el = record.ref ? record.ref.deref() : record.el;
    if (!el || !el.isConnected) return { id, status: "stale", reason: "detached-or-replaced", revision, documentSessionId: sessionId };
    if (identityFingerprint(el) !== record.fingerprint) {
      return { id, status: "stale", reason: "identity-changed", revision, documentSessionId: sessionId };
    }
    return { id, status: "ok", revision, documentSessionId: sessionId, cssPath: cssPath(el), tag: el.tagName.toLowerCase() };
  }

  // Internal only (content-script context): same validation as resolve(),
  // but returns the validated live node so callers can measure/highlight the
  // original element. Never expose the node across messaging boundaries,
  // and never substitute a cssPath lookup for this identity check.
  function resolveNode(id, expectedRevision) {
    const result = resolve(id, expectedRevision);
    if (result.status !== "ok") return { ...result, node: null };
    const record = byId.get(id);
    const el = record.ref ? record.ref.deref() : record.el;
    if (!el || !el.isConnected) {
      return { id, status: "stale", reason: "detached-or-replaced", revision, documentSessionId: sessionId, node: null };
    }
    return { ...result, node: el };
  }

  function checkForChanges() {
    if (lastNormalized === null) return { changed: false, reason: "no-baseline" };
    const { normalized } = buildNormalized();
    const hash = semanticHash(normalized);
    if (hash === lastHash) return { changed: false, semanticHash: hash, revision };
    const delta = diffNormalized(lastNormalized, normalized);
    revision += 1;
    fresh = false;
    lastDelta = delta;
    // Keep the new hash/normalized as pending truth; full snapshot() resyncs.
    if (onInvalidate) onInvalidate({ revision, semanticHash: hash, delta, reason: "semantic-change" });
    return { changed: true, semanticHash: hash, revision, delta };
  }

  function scheduleCheck() {
    if (timer !== null && win && win.clearTimeout) win.clearTimeout(timer);
    if (!win || !win.setTimeout) { checkForChanges(); return; }
    timer = win.setTimeout(() => { timer = null; checkForChanges(); }, debounceMs);
  }

  const RELEVANT_ATTRS = ["aria-label", "aria-labelledby", "aria-checked", "aria-expanded", "aria-selected", "aria-disabled", "aria-required", "aria-invalid", "aria-hidden", "hidden", "type", "role", "placeholder", "title", "disabled", "checked", "value", "for"];
  function startObserving() {
    if (observer || !win) return false;
    const MO = win.MutationObserver || (typeof MutationObserver !== "undefined" ? MutationObserver : null);
    if (!MO || !docRef.documentElement) return false;
    observer = new MO((records) => {
      // Seeyable's own highlight writes only `style`, which is not observed,
      // so no self-feedback filter is needed beyond the attribute allowlist.
      if (records && records.length) scheduleCheck();
    });
    observer.observe(docRef.documentElement, {
      subtree: true, childList: true, characterData: true,
      attributes: true, attributeFilter: RELEVANT_ATTRS,
    });
    if (!listening && docRef.addEventListener) {
      // Live value/checked changes do not always mutate attributes.
      docRef.addEventListener("input", scheduleCheck, true);
      docRef.addEventListener("change", scheduleCheck, true);
      docRef.addEventListener("click", scheduleCheck, true);
      listening = true;
    }
    return true;
  }
  function stopObserving() {
    if (observer) { observer.disconnect(); observer = null; }
    if (timer !== null && win && win.clearTimeout) { win.clearTimeout(timer); timer = null; }
  }
  function invalidate(reason) {
    revision += 1;
    fresh = false;
    if (onInvalidate) onInvalidate({ revision, semanticHash: lastHash, delta: lastDelta, reason: reason || "invalidated" });
    return getStatus();
  }
  function getStatus() {
    return { documentSessionId: sessionId, revision, semanticHash: lastHash, fresh, lastDelta };
  }
  function getLastDelta() { return lastDelta; }

  return { snapshot, resolve, resolveNode, checkForChanges, startObserving, stopObserving, invalidate, getStatus, getLastDelta, sessionId };
}

/* Default per-document engine so repeated panel calls keep stable IDs. */
const defaultEngines = new WeakMap();
function getDefaultEngine(docRef, win) {
  let engine = defaultEngines.get(docRef);
  if (!engine) {
    engine = createSnapshotEngine(docRef, win);
    engine.startObserving();
    defaultEngines.set(docRef, engine);
  }
  return engine;
}
function buildDomSnapshot(doc, view) {
  const docRef = doc || (typeof document !== "undefined" ? document : null);
  if (!docRef) throw new Error("buildDomSnapshot: no document available");
  const win = view || docRef.defaultView || (typeof window !== "undefined" ? window : null);
  return getDefaultEngine(docRef, win).snapshot();
}

if (typeof globalThis !== "undefined") {
  // Internal helpers shared with sibling content-script modules (executor).
  globalThis.__seeyable_snapshotInternals = { normalizeElements, semanticHash, diffNormalized, sensitiveInfo, isVisible, computeAccessibleName };
  globalThis.__seeyable_createSnapshotEngine = createSnapshotEngine;
  globalThis.__seeyable_snapshotDOM = function __seeyable_snapshotDOM() { return buildDomSnapshot(); };
  globalThis.__seeyable_getSnapshotEngine = function __seeyable_getSnapshotEngine() {
    return getDefaultEngine(document, window);
  };
}
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    buildDomSnapshot, createSnapshotEngine, computeAccessibleName, roleOf,
    normalizeElements, semanticHash, diffNormalized, sensitiveInfo, questionOf, isVisible,
  };
}
