"use strict";
/* Planner client for the side panel (Issue #14). Classic script, no
 * dependencies beyond SeeyableVoice (normalization) and SeeyablePlan
 * (defensive validation before dispatch):
 *  - pruneSnapshot: deterministic, bounded projection of a production
 *    schema-v2 snapshot for model visibility (~60 elements max).
 *  - requestPlan: POST { transcript, snapshot, context } to the local
 *    planner proxy with pairing-token auth and a bounded timeout.
 *  - Correction-phrase detection for cached "no, the other one"
 *    resolution (zero model calls; the panel owns the cache).
 *  - Bounded conversation-context helpers (document-scoped, no values).
 *
 * Nothing here executes anything: plans come back to the panel, are
 * re-validated against the LIVE snapshot, and run step by step through
 * the same guarded pipeline as manual and fast-path commands.
 */

const PRUNE_MAX_ELEMENTS = 60;
const PLAN_PROXY_TIMEOUT_MS = 55000; // covers initial + one repair upstream call
const PLAN_PROXY_DEFAULT_PORT = 6124;
const CONTEXT_MAX_ENTRIES = 4;
// Native-dropdown choices are planner-visible but bounded: at most this
// many options per select, labels clipped to this length. Option VALUES
// are never clipped — the executor requires byte-exact values, so a
// clipped value could never dispatch. Choices beyond the cap are
// reported via optionsOmitted and are UNAVAILABLE to the planner: the
// model must never guess them, and validation rejects unlisted values.
const PRUNE_MAX_OPTIONS = 50;
const PRUNE_MAX_OPTION_LABEL = 80;

function pruneElementState(state) {
  const out = {};
  if (!state || typeof state !== "object") return out;
  for (const key of ["checked", "selected", "disabled", "expanded", "pressed", "required", "readonly", "invalid"]) {
    if (state[key] !== undefined && state[key] !== false && state[key] !== "") out[key] = state[key];
  }
  if (state.redacted === true) {
    // Engine-redacted (sensitive) fields: filled-ness is the only signal.
    out.redacted = true;
    if (state.filled !== undefined) out.filled = Boolean(state.filled);
    return out;
  }
  if (state.filled !== undefined) out.filled = Boolean(state.filled);
  else if (typeof state.value === "string" && state.value !== "") out.filled = true;
  // state.value (raw page text / selected option text) is NEVER forwarded.
  if (Array.isArray(state.options)) {
    const { options, omitted } = pruneSelectOptions(state.options);
    out.options = options;
    if (omitted > 0) out.optionsOmitted = omitted;
  }
  return out;
}

function pruneSelectOptions(options) {
  const list = Array.isArray(options) ? options : [];
  const kept = list.slice(0, PRUNE_MAX_OPTIONS).map((o) => {
    const label = String((o && o.label) ?? "");
    const out = {
      label: label.length > PRUNE_MAX_OPTION_LABEL ? label.slice(0, PRUNE_MAX_OPTION_LABEL) + "…" : label,
      value: String((o && o.value) ?? ""),
    };
    if (o && o.disabled === true) out.disabled = true;
    return out;
  });
  return { options: kept, omitted: Math.max(0, list.length - kept.length) };
}

// Deterministic bounded projection. Keeps stable ids, roles, names,
// question/form context, uncertainty, and redacted state; drops raw DOM,
// locators, geometry, and every raw value. Interactive elements ONLY:
// heading/landmark structural metadata is excluded (question context
// already carries the semantics inline). Selection order preserves
// actionable elements first, then other interactive ones (disabled or
// readonly: visible so the model can see they are unavailable, never
// preferred) — snapshot order within each tier.
function pruneSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object" || !Array.isArray(snapshot.elements)) {
    throw new Error("pruneSnapshot requires a production snapshot with elements");
  }
  const tiers = [[], []];
  let valid = 0;
  for (const element of snapshot.elements) {
    if (!element || typeof element.id !== "string") continue;
    valid += 1;
    if (element.role === "heading" || element.role === "landmark") continue; // structural: never model-visible
    tiers[element.actionable === true ? 0 : 1].push(element);
  }
  const ordered = [...tiers[0], ...tiers[1]];
  const kept = ordered.slice(0, PRUNE_MAX_ELEMENTS);
  return {
    documentSessionId: snapshot.documentSessionId,
    revision: snapshot.revision,
    truncated: { omitted: valid - kept.length },
    elements: kept.map((element) => {
      const pruned = {
        id: element.id,
        role: element.role || null,
        name: element.name || null,
        question: element.question || null,
        questionCertain: element.questionCertain === true,
        state: pruneElementState(element.state),
      };
      if (element.nameSource) pruned.nameSource = element.nameSource;
      if (element.tag) pruned.tag = element.tag;
      if (element.actionable === false) pruned.actionable = false;
      return pruned;
    }),
  };
}

function plannerError(code, message, status) {
  const err = new Error(message);
  err.code = code;
  // Numeric upstream HTTP status when the proxy reported one; undefined
  // otherwise. A bare number: safe to log and display.
  if (Number.isInteger(status)) err.status = status;
  return err;
}

// AbortSignal.any with a manual fallback: jsdom (and any older runtime)
// lacks .any, and planner cancellation must work everywhere the panel runs.
// Returns { signal, dispose }: dispose removes fallback listeners so a
// settled request leaves nothing behind on caller-owned signals.
function combineSignals(signals) {
  const none = () => {};
  const live = (signals || []).filter(Boolean);
  if (live.length === 0) return { signal: undefined, dispose: none };
  if (live.length === 1) return { signal: live[0], dispose: none };
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.any === "function") {
    return { signal: AbortSignal.any(live), dispose: none };
  }
  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  if (!controller) return { signal: live[0], dispose: none };
  const cleanups = [];
  for (const signal of live) {
    if (signal.aborted) {
      try { controller.abort(signal.reason); } catch { controller.abort(); }
      break;
    }
    const forward = () => {
      try { controller.abort(signal.reason); } catch { controller.abort(); }
    };
    signal.addEventListener("abort", forward, { once: true });
    cleanups.push(() => {
      try { signal.removeEventListener("abort", forward); } catch { /* gone */ }
    });
  }
  return {
    signal: controller.signal,
    dispose: () => { for (const cleanup of cleanups) cleanup(); },
  };
}

// POST a planning request. Resolves to the proxy's parsed payload on
// transport success (callers still validate the plan); rejects with a
// coded, content-free error on transport/timeout/shape failures.
async function requestPlan({ baseUrl, token, transcript, snapshot, context, signal, fetchImpl, timeoutMs }) {
  const fetchFn = fetchImpl || (typeof fetch === "function" ? fetch : null);
  if (typeof fetchFn !== "function") throw plannerError("NO_FETCH", "No fetch implementation is available.");
  if (!token) throw plannerError("NO_TOKEN", "Pair the planner proxy first: paste its token into the Developer view.");
  const controller = new AbortController();
  // One deadline governs headers AND body: it stays armed until the full
  // response is consumed and validated, and the timer plus every listener
  // is released on all exits. Timeout vs cancellation is classified by
  // cause in both phases: a caller-aborted signal is CANCELLED, an
  // expired deadline with a live caller signal is TIMEOUT.
  let timer = null;
  let timedOut = false;
  let fireTimeout = null;
  const timeoutPromise = new Promise((_, reject) => { fireTimeout = reject; });
  timeoutPromise.catch(() => {}); // race losers must never warn as unhandled
  let onCallerAbort = null;
  const cancelPromise = new Promise((_, reject) => {
    if (!signal) return; // no caller signal: only the deadline governs
    if (signal.aborted) {
      reject(plannerError("CANCELLED", "The planner request was cancelled."));
      return;
    }
    onCallerAbort = () => reject(plannerError("CANCELLED", "The planner request was cancelled."));
    signal.addEventListener("abort", onCallerAbort, { once: true });
  });
  cancelPromise.catch(() => {});
  timer = setTimeout(() => {
    timedOut = true;
    try { controller.abort(); } catch { /* already settled */ }
    fireTimeout(plannerError("TIMEOUT", "The planner proxy did not answer in time."));
  }, timeoutMs || PLAN_PROXY_TIMEOUT_MS);
  const combined = combineSignals([signal, controller.signal]);
  const cleanup = () => {
    if (timer) { clearTimeout(timer); timer = null; }
    if (signal && onCallerAbort) {
      try { signal.removeEventListener("abort", onCallerAbort); } catch { /* gone */ }
      onCallerAbort = null;
    }
    combined.dispose();
  };
  const classifyAbort = () => (signal && signal.aborted ? "CANCELLED" : "TIMEOUT");
  try {
    let res;
    try {
      res = await fetchFn(`${String(baseUrl).replace(/\/+$/, "")}/v1/plan`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ transcript, snapshot, context: context || [] }),
        signal: combined.signal,
      });
    } catch (err) {
      if (err && err.name === "AbortError") {
        throw classifyAbort() === "CANCELLED"
          ? plannerError("CANCELLED", "The planner request was cancelled.")
          : plannerError("TIMEOUT", "The planner proxy did not answer in time.");
      }
      throw plannerError("UNREACHABLE", "Cannot reach the planner proxy. Start it with: node apps/planner-proxy/server.mjs");
    }
    let payload = null;
    try {
      // Headers alone do not stop the clock: the body read races the
      // same deadline and caller cancellation. Abort-aware bodies may
      // reject AbortError on their own; cause checks below classify those.
      payload = await Promise.race([res.json(), timeoutPromise, cancelPromise]);
    } catch (err) {
      if (signal && signal.aborted) throw plannerError("CANCELLED", "The planner request was cancelled.");
      if (timedOut) throw plannerError("TIMEOUT", "The planner proxy did not finish responding in time.");
      if (err && (err.code === "TIMEOUT" || err.code === "CANCELLED")) throw err;
      throw plannerError("BAD_PROXY", "The planner proxy returned an unreadable response.");
    }
    if (!payload || typeof payload !== "object" || typeof payload.ok !== "boolean") {
      throw plannerError("BAD_PROXY", "The planner proxy returned a malformed response.");
    }
    if (!payload.ok) {
      const code = payload.error && typeof payload.error.code === "string" ? payload.error.code : "PROXY_ERROR";
      const message = payload.error && typeof payload.error.message === "string"
        ? payload.error.message
        : "The planner proxy refused the request.";
      const status = payload.error && Number.isInteger(payload.error.status) ? payload.error.status : undefined;
      throw plannerError(code, message, status);
    }
    return payload;
  } finally {
    cleanup();
  }
}

async function fetchProxyStatus({ baseUrl, token, fetchImpl, timeoutMs }) {
  const fetchFn = fetchImpl || (typeof fetch === "function" ? fetch : null);
  if (typeof fetchFn !== "function") throw plannerError("NO_FETCH", "No fetch implementation is available.");
  if (!token) throw plannerError("NO_TOKEN", "Pair the planner proxy first.");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || 8000);
  try {
    const res = await fetchFn(`${String(baseUrl).replace(/\/+$/, "")}/v1/status`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    const payload = await res.json().catch(() => null);
    if (!res.ok || !payload || payload.ok !== true) {
      const code = payload && payload.error && payload.error.code ? payload.error.code : "PROXY_ERROR";
      // Authentication rejection must read differently from a dead proxy:
      // the fix for the former is re-pairing, for the latter starting it.
      if (code === "UNAUTHORIZED") {
        throw plannerError(code, "Pairing token rejected. Paste the current token the proxy printed, then pair again.");
      }
      if (code === "FORBIDDEN") {
        throw plannerError(code, "The proxy refused this page. Pair from the extension panel.");
      }
      throw plannerError(code, "The planner proxy refused the status check.");
    }
    return payload;
  } catch (err) {
    if (err && err.code) throw err;
    if (err && err.name === "AbortError") throw plannerError("TIMEOUT", "The planner proxy did not answer in time.");
    throw plannerError("UNREACHABLE", "Cannot reach the planner proxy.");
  } finally {
    clearTimeout(timer);
  }
}

// Cached-correction trigger phrases. Exact normalized matches only — a
// correction must never misfire on an unrelated sentence, and these
// phrases never reach the model (zero additional calls by construction).
const CORRECTION_PHRASES = [
  "no, the other one",
  "no the other one",
  "the other one",
  "not that one, the other one",
  "not that one the other one",
];

function normalizePlannerText(text) {
  const voice = typeof globalThis !== "undefined" ? globalThis.SeeyableVoice : null;
  if (voice && typeof voice.normalizeCommandText === "function") return voice.normalizeCommandText(text);
  return String(text == null ? "" : text).toLowerCase().trim().replace(/\s+/g, " ").replace(/[.!?,;:]+$/, "").trim();
}

function isCorrectionRequest(text) {
  return CORRECTION_PHRASES.includes(normalizePlannerText(text));
}

// Bounded conversation context. Entries are { summary, outcome } —
// structured, bounded descriptions carrying action/target/outcome
// information ONLY. Raw transcripts are NEVER retained: values can hide
// anywhere in free text, so no regex stripping is attempted — the panel
// builds each summary from separated structure (parsed action + target
// label, planned step names, outcome codes) instead. Document-scoped:
// the panel resets the list whenever the tab or document session changes.
//
// This concerns PREVIOUS turns only. The CURRENT request's transcript is
// sent verbatim because the user explicitly issued it for planning.
const CONTEXT_MAX_SUMMARY = 300;
const CONTEXT_MAX_OUTCOME = 200;
function appendContext(entries, summary, outcome) {
  const list = Array.isArray(entries) ? entries.slice() : [];
  list.push({
    summary: String(summary == null ? "" : summary).slice(0, CONTEXT_MAX_SUMMARY),
    outcome: String(outcome == null ? "" : outcome).slice(0, CONTEXT_MAX_OUTCOME),
  });
  while (list.length > CONTEXT_MAX_ENTRIES) list.shift();
  return list;
}

const SeeyablePlanner = {
  PRUNE_MAX_ELEMENTS,
  PLAN_PROXY_TIMEOUT_MS,
  PLAN_PROXY_DEFAULT_PORT,
  CONTEXT_MAX_ENTRIES,
  CONTEXT_MAX_SUMMARY,
  CONTEXT_MAX_OUTCOME,
  CORRECTION_PHRASES,
  PRUNE_MAX_OPTIONS,
  PRUNE_MAX_OPTION_LABEL,
  pruneSnapshot,
  pruneElementState,
  pruneSelectOptions,
  requestPlan,
  fetchProxyStatus,
  isCorrectionRequest,
  normalizePlannerText,
  appendContext,
};

if (typeof globalThis !== "undefined") globalThis.SeeyablePlanner = SeeyablePlanner;
if (typeof module !== "undefined" && module.exports) module.exports = SeeyablePlanner;
