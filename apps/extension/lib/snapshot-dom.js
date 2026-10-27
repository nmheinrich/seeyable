"use strict";
/*
 * DOM/ARIA snapshot for Seeyable.
 *
 * Self-contained: no imports, no build step. Loaded as a content script
 * (before content.js) and also injectable via chrome.scripting.executeScript.
 * For Node-based sample generation it is exported via the guard at the bottom.
 *
 * Accessible-name priority (per spike spec, simplified vs. full AccName):
 *   1. aria-label
 *   2. aria-labelledby (resolved id refs, space-joined)
 *   3. associated <label> (label[for=id], else wrapping <label>)
 *   4. inner text (element text; value for input[type=button|submit|reset])
 *   5. placeholder
 *   6. title
 * The winning step is reported as `nameSource` so label quality can be judged.
 */

const INTERACTIVE_ROLES = new Set([
  "button", "link", "textbox", "searchbox", "checkbox", "radio", "switch",
  "slider", "spinbutton", "combobox", "listbox", "option", "menuitem",
  "menuitemcheckbox", "menuitemradio", "tab", "treeitem",
]);

const IMPLICIT_ROLE = {
  BUTTON: "button",
  SELECT: "combobox",
  TEXTAREA: "textbox",
  SUMMARY: "button",
};

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
    return "textbox"; // text, email, password, tel, url, date, ...
  }
  return IMPLICIT_ROLE[tag] || null;
}

function explicitRole(el) {
  const raw = el.getAttribute && el.getAttribute("role");
  if (!raw) return null;
  const first = raw.trim().split(/\s+/)[0].toLowerCase();
  return first || null;
}

function roleOf(el) {
  return explicitRole(el) || implicitRole(el);
}

function isInteractive(el) {
  if (roleOf(el) && INTERACTIVE_ROLES.has(roleOf(el))) return true;
  if (el.isContentEditable) return true;
  const ti = el.getAttribute && el.getAttribute("tabindex");
  if (ti !== null && ti !== undefined && parseInt(ti, 10) >= 0 && roleOf(el)) return true;
  // tabindex-only interactive (e.g. <div tabindex="0" role="button"> covered above;
  // plain focusable divs without role are included so coverage gaps are visible).
  if (ti !== null && ti !== undefined && parseInt(ti, 10) >= 0 && el.tagName === "DIV" && el.hasAttribute("tabindex")) return true;
  return false;
}

function isVisible(el, view) {
  if (el.hidden) return false;
  const doc = el.ownerDocument;
  const win = view || (doc && doc.defaultView);
  // Walk up: hidden attr, aria-hidden, or display:none/visibility:hidden on
  // the element or any ancestor hides the whole subtree.
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
  if (typeof el.getBoundingClientRect === "function") {
    const r = el.getBoundingClientRect();
    // jsdom returns 0x0 rects; only treat as hidden when a layout engine exists.
    const hasLayout = r.width > 0 || r.height > 0 || (el.offsetParent !== null);
    void hasLayout;
    // In a real browser, 0x0 + no offsetParent means not rendered. In jsdom
    // everything is 0x0, so we rely on computed style above instead of rect size.
    if (win && win.getComputedStyle && el.offsetParent === null && el.tagName !== "BODY") {
      const cs2 = win.getComputedStyle(el);
      if (cs2.position !== "fixed" && r.width === 0 && r.height === 0 && win.document && win.document.documentElement && win.document.documentElement.clientWidth > 0) {
        return false;
      }
    }
  }
  return true;
}

function cleanText(s) {
  return (s || "").replace(/\s+/g, " ").trim();
}

function textOf(el) {
  if (!el) return "";
  // Prefer innerText when available (respects visibility), fall back to textContent.
  const t = "innerText" in el && el.innerText ? el.innerText : el.textContent;
  return cleanText(t);
}

function associatedLabelText(el) {
  const doc = el.ownerDocument;
  const id = el.getAttribute && el.getAttribute("id");
  if (id && doc && doc.querySelector) {
    // Escape id for selector use without CSS.escape dependency in all contexts.
    const labels = doc.querySelectorAll("label[for]");
    for (const lab of labels) {
      if (lab.getAttribute("for") === id) {
        const t = cleanText(lab.textContent);
        if (t) return t;
      }
    }
  }
  const wrap = el.closest ? el.closest("label") : null;
  if (wrap) {
    // Clone-free approach: label text minus the control's own text/value.
    const cloneText = cleanText(wrap.textContent);
    if (cloneText) return cloneText;
  }
  return "";
}

function computeAccessibleName(el) {
  // 1. aria-label
  const ariaLabel = cleanText(el.getAttribute && el.getAttribute("aria-label"));
  if (ariaLabel) return { name: ariaLabel, source: "aria-label" };

  // 2. aria-labelledby
  const labelledby = el.getAttribute && el.getAttribute("aria-labelledby");
  if (labelledby) {
    const doc = el.ownerDocument;
    const parts = labelledby.trim().split(/\s+/).map((refId) => {
      const ref = doc && doc.getElementById ? doc.getElementById(refId) : null;
      return ref ? textOf(ref) : "";
    }).filter(Boolean);
    const joined = cleanText(parts.join(" "));
    if (joined) return { name: joined, source: "aria-labelledby" };
  }

  // 3. associated <label>
  const labelText = associatedLabelText(el);
  if (labelText) return { name: labelText, source: "label" };

  // 4. inner text / value
  const tag = el.tagName;
  if (tag === "INPUT") {
    const t = (el.getAttribute("type") || "").toLowerCase();
    if (t === "button" || t === "submit" || t === "reset" || t === "image") {
      const v = cleanText(el.getAttribute("value") || el.getAttribute("alt"));
      if (v) return { name: v, source: "value" };
    }
  } else {
    const inner = textOf(el);
    if (inner) return { name: inner, source: "text" };
  }

  // 5. placeholder
  const ph = cleanText(el.getAttribute && el.getAttribute("placeholder"));
  if (ph) return { name: ph, source: "placeholder" };

  // 6. title
  const title = cleanText(el.getAttribute && el.getAttribute("title"));
  if (title) return { name: title, source: "title" };

  return { name: "", source: "none" };
}

function stateOf(el, role) {
  const state = {};
  const disabled = Boolean(el.disabled) || (el.getAttribute && el.getAttribute("aria-disabled") === "true");
  if (disabled) state.disabled = true;

  if (role === "checkbox" || role === "radio" || role === "switch" || role === "menuitemcheckbox" || role === "menuitemradio") {
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

  // Current value — redacted for password / payment-like fields (safety rule).
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
    const type = (el.getAttribute && (el.getAttribute("type") || "")).toLowerCase();
    const hint = [el.getAttribute && el.getAttribute("name"), el.getAttribute && el.getAttribute("id"), el.getAttribute && el.getAttribute("autocomplete")].filter(Boolean).join(" ").toLowerCase();
    const sensitive = type === "password" || /(cc-|card|cvv|cvc|expiry|exp-)/.test(hint);
    if (sensitive) {
      state.value = "[REDACTED]";
    } else if (tag === "SELECT") {
      const opt = el.options && el.selectedIndex >= 0 ? el.options[el.selectedIndex] : null;
      if (opt) state.value = cleanText(opt.textContent);
    } else if ((type === "checkbox" || type === "radio")) {
      // checked already conveys state; the "on"/value attr is not a user value.
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
    if (node.id) {
      part += "#" + node.id;
      parts.unshift(part);
      break;
    }
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

function contextOf(el) {
  const bits = [];
  // Nearest heading (preceding in document order within the closest section/form).
  const scope = (el.closest && (el.closest("section, article, form, fieldset, main, [role='region']"))) || el.ownerDocument.body;
  if (scope && scope.querySelectorAll) {
    const headings = scope.querySelectorAll("h1, h2, h3, h4, h5, h6, legend");
    // Pick the last heading that precedes el in document order.
    let best = null;
    for (const h of headings) {
      // h.compareDocumentPosition(el) & 4 (FOLLOWING): el comes after h.
      if (h.compareDocumentPosition && (h.compareDocumentPosition(el) & 4)) best = h;
      else if (!h.compareDocumentPosition) best = h;
    }
    if (best) bits.push(`${best.tagName.toLowerCase()}: "${textOf(best)}"`);
  }
  const fieldset = el.closest ? el.closest("fieldset") : null;
  if (fieldset) {
    const legend = fieldset.querySelector("legend");
    if (legend) bits.push(`group: "${textOf(legend)}"`);
  }
  const form = el.closest ? el.closest("form") : null;
  if (form) {
    const label = cleanText(form.getAttribute("aria-label") || form.getAttribute("name") || form.getAttribute("id"));
    if (label) bits.push(`form: "${label}"`);
  }
  // Landmark ancestor.
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

function buildDomSnapshot(doc, view) {
  // Note: do not name the local `document` — `const document = ... typeof document`
  // is a TDZ ReferenceError when called with no args (the content-script path).
  const docRef = doc || (typeof document !== "undefined" ? document : null);
  if (!docRef) throw new Error("buildDomSnapshot: no document available");
  const win = view || docRef.defaultView || (typeof window !== "undefined" ? window : null);
  const started = Date.now();
  const all = Array.from(docRef.querySelectorAll("*"));
  const elements = [];
  let n = 0;
  for (const el of all) {
    if (!isInteractive(el)) continue;
    if (!isVisible(el, win)) continue;
    const role = roleOf(el) || "generic";
    const { name, source } = computeAccessibleName(el);
    const rect = typeof el.getBoundingClientRect === "function"
      ? (() => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) }; })()
      : null;
    n += 1;
    elements.push({
      id: `el-${n}`,
      role,
      name,
      nameSource: source,
      state: stateOf(el, role),
      context: contextOf(el),
      // --- mapping back to the real DOM element (spike question #4) ---
      tag: el.tagName.toLowerCase(),
      domId: (el.getAttribute && el.getAttribute("id")) || null,
      testId: (el.getAttribute && (el.getAttribute("data-testid") || el.getAttribute("data-test-id"))) || null,
      cssPath: cssPath(el),
      rect,
    });
  }
  return {
    kind: "dom-aria",
    url: docRef.location ? docRef.location.href : null,
    title: docRef.title || null,
    capturedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    elementCount: elements.length,
    elements,
  };
}

// Content-script / injected-page global.
if (typeof globalThis !== "undefined") {
  globalThis.__seeyable_snapshotDOM = function __seeyable_snapshotDOM() {
    return buildDomSnapshot();
  };
}
// Node export for sample generation / tests (no effect in the browser).
if (typeof module !== "undefined" && module.exports) {
  module.exports = { buildDomSnapshot, computeAccessibleName, roleOf };
}
