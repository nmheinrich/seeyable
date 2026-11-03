"use strict";
/*
 * Issue #19 tool definitions for the Seeyable MCP server.
 *
 * Each handler validates through a strict zod schema BEFORE any bridge
 * traffic: unknown fields (including approval-shaped ones such as
 * `approved`, `source`, `challengeId`, or a caller-chosen tab fallback)
 * are rejected by the schema itself. Every page tool takes an explicit
 * tabId plus the element binding (elementId, documentSessionId,
 * revision) from a prior page_snapshot — nothing is retargeted, and no
 * label-to-value conversion happens here: `select` takes the exact
 * underlying option value the snapshot exposed.
 *
 * Mutations forward to the bridge `execute` op, which the extension
 * routes into the ONE shared executor with audit source "mcp" set in
 * trusted extension code. Consequential actions return
 * held_for_approval (isError: the requested action did NOT complete)
 * and wait for a human decision in the Seeyable panel; there is no MCP
 * approval path, and nothing resumes automatically after approval.
 *
 * Result statuses: verified | dispatched_unverified |
 * held_for_approval | rejected | outcome_unknown. A bridge timeout or
 * disconnect on a mutation is outcome_unknown — it may have been
 * dispatched — and is never retried automatically.
 */
import { z } from "zod";
import { BridgeError } from "./bridge.mjs";

const tabId = z.number().int().describe("Tab id from list_tabs. Required; no active-tab fallback.");
const elementId = z.string().regex(/^el-[0-9]+$/).describe("Stable snapshot id, e.g. el-12.");
const documentSessionId = z.string().min(1).describe("documentSessionId from the snapshot this id belongs to.");
const revision = z.number().int().describe("Snapshot revision this id belongs to.");

const targetInput = { tabId, elementId, documentSessionId, revision };

export const MAX_FILL_CHARS = 10000;

function toolResult(payload, isError = false) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
    ...(isError ? { isError: true } : {}),
  };
}

function bridgeFailure(tool, args, err) {
  const code = err instanceof BridgeError ? err.code : "INTERNAL_ERROR";
  const message = err && err.message ? err.message : String(err);
  return toolResult({
    tool,
    status: "error",
    tabId: args && args.tabId !== undefined ? args.tabId : null,
    error: { code, message },
  }, true);
}

// Executor response -> MCP outcome. The executor is authoritative and
// honest: verified means it checked the final live state; dispatched
// means activation happened without a verifiable completion claim.
export function mapExecuteResult(tool, args, res) {
  const base = {
    tool,
    tabId: args.tabId,
    elementId: args.elementId,
    documentSessionId: res.documentSessionId !== undefined ? res.documentSessionId : args.documentSessionId,
    revision: res.revision !== undefined ? res.revision : args.revision,
    newSnapshotDiff: res.newSnapshotDiff !== undefined ? res.newSnapshotDiff : null,
    diffUnavailableReason: res.diffUnavailableReason !== undefined ? res.diffUnavailableReason : null,
  };
  if (res.ok) {
    if (res.result && res.result.verified) {
      return toolResult({ ...base, status: "verified", result: res.result });
    }
    if (res.result && res.result.dispatched) {
      return toolResult({ ...base, status: "dispatched_unverified", result: res.result });
    }
    return toolResult({ ...base, status: "dispatched_unverified", result: res.result || null });
  }
  const err = res.error && typeof res.error === "object" ? res.error : { code: "EXTENSION_ERROR", message: "Extension reported failure." };
  if (err.code === "CONFIRMATION_REQUIRED" && res.confirmation) {
    const c = res.confirmation;
    return toolResult({
      ...base,
      status: "held_for_approval",
      error: { code: err.code, message: err.message },
      // No challengeId: the identifier is approval routing material for
      // the trusted panel, not something an MCP client can act on.
      confirmation: {
        action: c.action, elementId: c.elementId, targetName: c.targetName,
        targetQuestion: c.targetQuestion, consequence: c.consequence,
        pageUrl: c.pageUrl, documentSessionId: c.documentSessionId,
        revision: c.revision, expiresAt: c.expiresAt,
        approval: "A person must approve or cancel this in the Seeyable side panel. It expires unexecuted if not approved; do not retry it as approved.",
      },
    }, true);
  }
  if (err.code === "ACTION_NOT_VERIFIED") {
    return toolResult({ ...base, status: "dispatched_unverified", error: { code: err.code, message: err.message } }, true);
  }
  return toolResult({ ...base, status: "rejected", error: { code: err.code || "EXTENSION_ERROR", message: err.message || "Extension reported failure." } }, true);
}

async function executeViaBridge(bridge, tool, args) {
  // Shared bridge: let an in-progress join finish (bounded) first.
  if (typeof bridge.ready === "function") await bridge.ready();
  if (typeof bridge.isConnected === "function" && !bridge.isConnected()) {
    // A shared-bridge link failure (e.g. PORT_CONFLICT) is reported as
    // itself; a linked bridge without a paired extension is NO_EXTENSION.
    const why = typeof bridge.lastError === "function" ? bridge.lastError() : null;
    return toolResult({
      tool, status: "rejected", tabId: args.tabId, elementId: args.elementId,
      error: why
        ? { code: why.code, message: `${why.message} Nothing was sent.` }
        : { code: "NO_EXTENSION", message: "No extension is connected. Pair the extension, then retry; nothing was sent." },
    }, true);
  }
  let res;
  try {
    res = await bridge.request("execute", args.tabId, {
      action: tool,
      elementId: args.elementId,
      documentSessionId: args.documentSessionId,
      revision: args.revision,
      ...(tool === "click" ? {} : { value: args.value }),
    });
  } catch (err) {
    // Timeout/disconnect: the request may already have reached the page.
    // Report uncertainty; never retry a mutation automatically.
    const code = err instanceof BridgeError ? err.code : "INTERNAL_ERROR";
    return toolResult({
      tool, status: "outcome_unknown", tabId: args.tabId, elementId: args.elementId,
      documentSessionId: args.documentSessionId, revision: args.revision,
      error: { code, message: `${err && err.message ? err.message : err} The action may already have been dispatched; verify page state with a fresh snapshot before deciding whether to re-issue it.` },
    }, true);
  }
  if (!res || typeof res.ok !== "boolean") {
    return toolResult({
      tool, status: "outcome_unknown", tabId: args.tabId, elementId: args.elementId,
      error: { code: "MALFORMED_RESPONSE", message: "The extension returned a malformed executor response; the outcome is unknown. Verify page state with a fresh snapshot." },
    }, true);
  }
  return mapExecuteResult(tool, args, res);
}

export function toolHandlers(bridge) {
  const mutation = (tool) => ({
    handler: async (args) => executeViaBridge(bridge, tool, args),
  });
  const defs = [
    {
      name: "list_tabs",
      description: "List open browser tabs (id, title, URL) so the caller can pick an explicit tabId. Never guesses a tab.",
      inputSchema: z.object({}).strict(),
      handler: async (args) => {
        try {
          const tabs = await bridge.request("tabs", null);
          return toolResult({ tabs });
        } catch (err) { return bridgeFailure("list_tabs", args, err); }
      },
    },
    {
      name: "page_snapshot",
      description: "Return the production DOM/ARIA snapshot (schema v2, redacted, with dropdown option metadata) from the explicitly chosen tab. No canned data.",
      inputSchema: z.object({ tabId }).strict(),
      handler: async (args) => {
        try {
          const snapshot = await bridge.request("snapshot", args.tabId);
          return toolResult(snapshot);
        } catch (err) { return bridgeFailure("page_snapshot", args, err); }
      },
    },
    {
      name: "highlight",
      description: "Highlight one snapshot target by its stable id on the explicitly chosen tab (scrolls into view, draws the ring). Read-only: never activates the target.",
      inputSchema: z.object({ ...targetInput }).strict(),
      handler: async (args) => {
        try {
          const result = await bridge.request("highlight", args.tabId, {
            elementId: args.elementId, documentSessionId: args.documentSessionId, revision: args.revision,
          });
          return toolResult({
            tool: "highlight", status: "highlighted", tabId: args.tabId,
            elementId: args.elementId, highlighted: result.highlighted,
            documentSessionId: args.documentSessionId, revision: args.revision,
          });
        } catch (err) { return bridgeFailure("highlight", args, err); }
      },
    },
    {
      name: "highlight_target",
      description: "Compatibility alias of highlight (Issue #28 name). Same guarded, read-only behavior.",
      inputSchema: z.object({ ...targetInput }).strict(),
      handler: null, // wired to highlight below
    },
    {
      name: "click",
      description: "Click one snapshot target through Seeyable's shared guarded executor. Consequential controls (Submit/Pay/Delete/Send/Publish and native submits) are held for human approval in the Seeyable panel and dispatch nothing until approved.",
      inputSchema: z.object({ ...targetInput }).strict(),
      ...mutation("click"),
    },
    {
      name: "fill",
      description: "Fill one text target through the shared guarded executor with the exact value given. Sensitive (password/payment) writes are rejected by the executor; the final value is verified against the live page.",
      inputSchema: z.object({ ...targetInput, value: z.string().max(MAX_FILL_CHARS).describe("Exact text to place in the field; empty string clears it.") }).strict(),
      ...mutation("fill"),
    },
    {
      name: "select",
      description: "Select one native dropdown option through the shared guarded executor. `value` must be the exact underlying option value exposed in the snapshot's state.options — labels are never converted here.",
      inputSchema: z.object({ ...targetInput, value: z.string().max(MAX_FILL_CHARS).describe("Exact option value from the snapshot (state.options[].value), never the visible label.") }).strict(),
      ...mutation("select"),
    },
    {
      name: "read_section",
      description: "Read bounded, read-only text of the section enclosing one snapshot target (nearest section/article/fieldset/form/main/aside or ARIA group-like ancestor; the parent element otherwise). Excludes hidden content, scripts/styles, overlays, and form-control subtrees, so control values are never returned. Truncation is reported.",
      inputSchema: z.object({
        ...targetInput,
        maxChars: z.number().int().min(100).max(8000).optional().describe("Maximum characters of section text (default 4000, hard cap 8000)."),
      }).strict(),
      handler: async (args) => {
        try {
          const section = await bridge.request("read_section", args.tabId, {
            elementId: args.elementId, documentSessionId: args.documentSessionId, revision: args.revision,
            ...(args.maxChars !== undefined ? { maxChars: args.maxChars } : {}),
          });
          return toolResult({ tool: "read_section", status: "ok", tabId: args.tabId, ...section });
        } catch (err) { return bridgeFailure("read_section", args, err); }
      },
    },
  ];
  // Compatibility alias: identical schema and handler as `highlight`.
  const highlight = defs.find((d) => d.name === "highlight");
  defs.find((d) => d.name === "highlight_target").handler = highlight.handler;
  return defs;
}
