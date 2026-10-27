"use strict";
/*
 * CDP AXTree helpers for Seeyable (debug path).
 *
 * The raw Accessibility.getFullAXTree payload is verbose (every node carries
 * properties, sources, and childIds). `simplifyAxTree` flattens it into the
 * shape we compare against the DOM/ARIA snapshot:
 *   { nodeId, parentId, role, name, ignored, state, backendDOMNodeId, childIds }
 *
 * Mapping note: CDP nodes carry `backendDOMNodeId`, NOT a CSS selector.
 * Resolving one requires a second CDP round-trip on the DOM domain
 * (DOM.pushNodesByBackendIdsToFrontend / DOM.resolveNode). That asymmetry
 * vs. the DOM snapshot's cssPath is a core spike finding — see docs/spike/.
 */

function simplifyAxTree(raw) {
  const nodes = (raw && raw.nodes) || [];
  return nodes.map((node) => {
    const state = {};
    for (const prop of node.properties || []) {
      state[prop.name] = prop.value && "value" in prop.value ? prop.value.value : prop.value;
    }
    return {
      nodeId: node.nodeId,
      parentId: node.parentId !== undefined ? node.parentId : null,
      ignored: Boolean(node.ignored),
      role: node.role && node.role.value ? node.role.value : null,
      name: node.name && typeof node.name.value === "string" ? node.name.value : "",
      // Present only when Chrome can map the AX node to a DOM node.
      backendDOMNodeId: node.backendDOMNodeId !== undefined ? node.backendDOMNodeId : null,
      childIds: node.childIds || [],
      state,
    };
  });
}

function interactiveOnly(simplified, { includeIgnored = false } = {}) {
  const INTERACTIVE = new Set([
    "button", "link", "textbox", "searchbox", "checkbox", "radio", "switch",
    "slider", "spinbutton", "combobox", "listbox", "option", "menuitem",
    "menuitemcheckbox", "menuitemradio", "tab", "treeitem", "generic",
  ]);
  return simplified.filter((n) => (includeIgnored || !n.ignored) && INTERACTIVE.has(n.role));
}

if (typeof globalThis !== "undefined") {
  globalThis.__seeyable_simplifyAxTree = simplifyAxTree;
  globalThis.__seeyable_interactiveOnly = interactiveOnly;
}
if (typeof module !== "undefined" && module.exports) {
  module.exports = { simplifyAxTree, interactiveOnly };
}
