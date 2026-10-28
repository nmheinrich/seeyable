"use strict";
/*
 * Seeyable executor: single entry point for all page actions.
 *
 * Every caller (side panel today; voice and MCP later) goes through
 * `execute(request)`. Lower-level mutation helpers stay private to this
 * module. DOM nodes never leave the content-script context, requests are
 * validated against the snapshot engine's original-node identity
 * (`resolveNode`), and consequential controls are blocked centrally —
 * no caller can mint an approval or bypass the guard in this milestone.
 *
 * Contract: docs/features/feature-08-executor.md
 */

const ACTIONS = new Set(["click", "fill", "select", "check", "uncheck", "scroll_to", "read"]);
const TEXT_FILL_TYPES = new Set(["", "text", "email", "search", "tel", "url"]);
const CONSEQUENTIAL_LABEL = /\b(submit|pay|buy|purchase|checkout|delete|remove|send|publish|place order|confirm order|buy now|pay now)\b/i;

function isConsequentialControl(node, descriptor) {
  if (!node) return false;
  const tag = node.tagName;
  const type = ((node.getAttribute && node.getAttribute("type")) || "").toLowerCase();
  // Native submit controls are consequential regardless of label.
  if (tag === "INPUT" && (type === "submit" || type === "image")) return true;
  if (tag === "BUTTON") {
    // Effective button type: missing/invalid type defaults to "submit" when
    // the button is form-associated — via an ancestor form OR the `form`
    // attribute (node.form covers both). Block submission regardless of
    // label or whether the button sits inside its form.
    const effectiveType = ["submit", "reset", "button"].includes(type) ? type : "submit";
    const associatedForm = node.form || (node.closest && node.closest("form"));
    if (effectiveType === "submit" && associatedForm) return true;
    if (type === "submit") return true;
  }
  const labels = [
    descriptor && descriptor.name,
    node.getAttribute && node.getAttribute("aria-label"),
    node.getAttribute && node.getAttribute("value"),
    node.getAttribute && node.getAttribute("title"),
    node.textContent,
  ].filter(Boolean).join(" ");
  return CONSEQUENTIAL_LABEL.test(labels.replace(/\s+/g, " ").trim());
}

function createExecutor(options) {
  const engine = options.engine;
  const internals = options.internals;
  if (!engine || !internals) throw new Error("createExecutor requires { engine, internals }");
  const settleMs = options.settleMs !== undefined ? options.settleMs : 40;
  const sleep = options.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));

  function failure(code, message, status, diffUnavailableReason) {
    const s = status || engine.getStatus();
    return {
      ok: false,
      error: { code, message },
      newSnapshotDiff: null,
      diffUnavailableReason: diffUnavailableReason || "action was not performed",
      documentSessionId: s.documentSessionId || engine.sessionId,
      revision: s.revision,
    };
  }

  function failureWithDiff(code, message, postSnapshot, diff, diffUnavailableReason) {
    // Dispatch happened: preserve whatever diff was obtainable. A failed
    // outcome does not mean nothing changed.
    return {
      ok: false,
      error: { code, message },
      newSnapshotDiff: diff || null,
      diffUnavailableReason: diff ? null : diffUnavailableReason || "post-action snapshot unavailable",
      documentSessionId: postSnapshot ? postSnapshot.documentSessionId : engine.sessionId,
      revision: postSnapshot ? postSnapshot.revision : engine.getStatus().revision,
    };
  }

  function reducedMotion(win) {
    try { return Boolean(win && win.matchMedia && win.matchMedia("(prefers-reduced-motion: reduce)").matches); }
    catch { return false; }
  }

  function scrollNode(node, win) {
    try {
      if (node.scrollIntoView) {
        node.scrollIntoView({ block: "center", inline: "center", behavior: reducedMotion(win) ? "auto" : "smooth" });
      }
    } catch { /* scrolling is best-effort; verification reports the outcome */ }
  }

  function inViewport(node, win) {
    if (!node.getBoundingClientRect || !win) return false;
    const r = node.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    const vh = win.innerHeight || 0;
    const vw = win.innerWidth || 0;
    return r.bottom > 0 && r.right > 0 && r.top < vh && r.left < vw;
  }

  function dispatchValueEvents(node, win) {
    const E = win && win.Event;
    const IE = win && win.InputEvent;
    if (IE) node.dispatchEvent(new IE("input", { bubbles: true, composed: true }));
    else if (E) node.dispatchEvent(new E("input", { bubbles: true }));
    if (E) node.dispatchEvent(new E("change", { bubbles: true }));
  }

  function setNativeValue(node, value, win) {
    const ctor = node.tagName === "TEXTAREA" ? "HTMLTextAreaElement"
      : node.tagName === "SELECT" ? "HTMLSelectElement" : "HTMLInputElement";
    const proto = win && win[ctor] && win[ctor].prototype;
    const setter = proto && Object.getOwnPropertyDescriptor(proto, "value");
    if (setter && setter.set) setter.set.call(node, value);
    else node.value = value;
  }

  // Effective native disabled: own state, ARIA state, or a disabled
  // <fieldset> ancestor — except descendants of that fieldset's first
  // <legend> child, which remain enabled per native semantics.
  function effectiveDisabled(node) {
    if (!node) return false;
    if (node.disabled) return true;
    if (node.getAttribute && node.getAttribute("aria-disabled") === "true") return true;
    let ancestor = node.parentElement;
    while (ancestor) {
      if (ancestor.tagName === "FIELDSET" && ancestor.disabled) {
        const firstLegend = Array.from(ancestor.children || []).find((c) => c.tagName === "LEGEND");
        if (!(firstLegend && firstLegend.contains(node))) return true;
      }
      ancestor = ancestor.parentElement;
    }
    return false;
  }

  function ariaChecked(node) {
    const v = node.getAttribute && node.getAttribute("aria-checked");
    return v === "true" ? true : v === "mixed" ? "mixed" : v === "false" ? false : null;
  }

  async function execute(request) {
    // --- Request shape validation (explicit; nothing defaults silently) ---
    if (!request || typeof request !== "object") return failure("INVALID_REQUEST", "Request must be an object.");
    const { action, elementId, documentSessionId, revision, value } = request;
    if (!ACTIONS.has(action)) return failure("UNKNOWN_ACTION", `Unsupported action: ${String(action)}`);
    if (typeof elementId !== "string" || !/^el-\d+$/.test(elementId)) return failure("INVALID_REQUEST", "elementId must be a snapshot ID such as el-12.");
    if (typeof documentSessionId !== "string" || documentSessionId === "") return failure("INVALID_REQUEST", "documentSessionId is required.");
    if (!Number.isInteger(revision)) return failure("INVALID_REQUEST", "revision is required and must be an integer.");
    if ((action === "fill" || action === "select") && typeof value !== "string") {
      return failure("VALUE_REQUIRED", `${action} requires a string value.`);
    }

    // --- Session, freshness, revision (synchronous; no debounce reliance) ---
    if (documentSessionId !== engine.sessionId) {
      return failure("WRONG_SESSION", "documentSessionId does not match the active document. Re-snapshot this tab.");
    }
    // A caller-received snapshot baseline must exist. Without one, taking a
    // pre-action snapshot here would silently authorize an ID/revision the
    // caller never received. An explicitly invalidated snapshot is likewise
    // not refreshed into validity.
    const baseline = engine.getStatus();
    if (!baseline || baseline.semanticHash === null || baseline.semanticHash === undefined) {
      return failure("SNAPSHOT_BASELINE_REQUIRED", "No snapshot has been taken for this document. Take a snapshot and use its documentSessionId, revision, and element IDs.", baseline || undefined);
    }
    if (baseline.fresh === false) {
      return failure("STALE_SNAPSHOT", "The referenced snapshot was invalidated. Re-snapshot before acting.", baseline, "snapshot invalidated before the action ran");
    }
    const detected = engine.checkForChanges();
    if (detected && detected.changed) {
      return failure("STALE_SNAPSHOT", "The page changed since the referenced snapshot. Re-snapshot before acting.", engine.getStatus(), "page changed before the action ran");
    }
    const status = engine.getStatus();
    if (revision !== status.revision) {
      return failure("STALE_REVISION", `Revision ${revision} does not match current revision ${status.revision}. Re-snapshot before acting.`, status);
    }

    const preSnapshot = engine.snapshot();
    const descriptor = preSnapshot.elements.find((e) => e.id === elementId);
    if (!descriptor) return failure("UNKNOWN_ID", `Element ${elementId} is not part of the referenced snapshot.`, engine.getStatus());

    let resolved = engine.resolveNode(elementId, preSnapshot.revision);
    if (resolved.status === "unknown") return failure("UNKNOWN_ID", `Unknown element ID ${elementId} in this document session.`, engine.getStatus());
    if (resolved.status !== "ok" || !resolved.node) {
      return failure("STALE_TARGET", `Target ${elementId} is stale (${resolved.reason || resolved.status}). Re-snapshot before acting.`, engine.getStatus());
    }
    const node = resolved.node;
    const doc = node.ownerDocument;
    const win = doc && doc.defaultView;

    // Live safety/compatibility validation. This runs before scrolling AND
    // again immediately before dispatch: identity alone does not establish
    // that an action is still safe after an asynchronous wait.
    const isValueAction = action === "fill" || action === "select";
    const isMutation = action !== "read" && action !== "scroll_to";
    function validateLiveSafety() {
      if (!internals.isVisible(node, win)) return failure("TARGET_HIDDEN", `Target ${elementId} is not visible.`, engine.getStatus());
      const liveDisabled = effectiveDisabled(node);
      const liveReadonly = Boolean(node.readOnly) || (node.getAttribute && node.getAttribute("aria-readonly") === "true");
      if (isMutation && liveDisabled) return failure("TARGET_DISABLED", `Target ${elementId} is disabled.`, engine.getStatus());
      if (isValueAction && liveReadonly) return failure("TARGET_READONLY", `Target ${elementId} is read-only.`, engine.getStatus());
      if (isValueAction && internals.sensitiveInfo(node).sensitive) {
        return failure("SENSITIVE_FIELD", `Target ${elementId} is a protected field; writes are blocked in this milestone.`, engine.getStatus());
      }
      if (action === "click" || action === "check" || action === "uncheck") {
        const liveName = internals.computeAccessibleName ? internals.computeAccessibleName(node).name : descriptor.name;
        if (isConsequentialControl(node, { ...descriptor, name: liveName })) {
          return failure("CONSEQUENTIAL_BLOCKED", "Consequential actions (submit, pay, delete, send, publish, and similar) are blocked until the safety-gate feature provides human approval. No approval can be supplied through this interface in this milestone.", engine.getStatus());
        }
      }
      return null;
    }

    // --- Compatibility (recomputed live on each call) ---
    function validateCompatibility() {
    const tag = node.tagName;
    const inputType = ((node.getAttribute && node.getAttribute("type")) || "").toLowerCase();
    const role = descriptor.role;
    if (action === "fill") {
      const okFill = tag === "TEXTAREA" || (tag === "INPUT" && TEXT_FILL_TYPES.has(inputType));
      if (!okFill) return failure("INCOMPATIBLE_TARGET", `fill is not supported for ${tag.toLowerCase()}${inputType ? `[type=${inputType}]` : ""} (role ${role}).`, engine.getStatus());
    }
    if (action === "select") {
      if (tag !== "SELECT") return failure("INCOMPATIBLE_TARGET", `select requires a native <select>, got ${tag.toLowerCase()} (role ${role}).`, engine.getStatus());
      if (node.multiple) return failure("UNSUPPORTED_MULTISELECT", "Multi-select controls are not supported in this milestone.", engine.getStatus());
      const option = Array.from(node.options || []).find((o) => o.value === value);
      if (!option) return failure("OPTION_NOT_FOUND", "No option with that exact value exists.", engine.getStatus());
      const optgroup = option.parentElement && option.parentElement.tagName === "OPTGROUP" ? option.parentElement : null;
      if (option.disabled || (optgroup && optgroup.disabled)) {
        return failure("OPTION_DISABLED", "The requested option is disabled (directly or through its optgroup).", engine.getStatus());
      }
    }
    if (action === "check" || action === "uncheck") {
      const nativeCheckable = tag === "INPUT" && (inputType === "checkbox" || inputType === "radio");
      const ariaCheckable = ["checkbox", "radio", "switch"].includes(role) && ariaChecked(node) !== null;
      if (!nativeCheckable && !ariaCheckable) {
        return failure("INCOMPATIBLE_TARGET", `${action} requires a checkbox, radio, or switch, got role ${role}.`, engine.getStatus());
      }
      if (action === "uncheck" && (inputType === "radio" || role === "radio")) {
        return failure("UNSUPPORTED_RADIO_UNCHECK", "A radio cannot be explicitly unchecked; select another option in its group instead.", engine.getStatus());
      }
    }
    if (action === "click") {
      const clickable = ["button", "link", "option", "tab", "menuitem", "menuitemcheckbox", "menuitemradio", "switch", "checkbox", "radio"].includes(role) || tag === "BUTTON" || tag === "A" || tag === "SUMMARY";
      if (!clickable) return failure("INCOMPATIBLE_TARGET", `click is not supported for role ${role}. Use the action matching this control type.`, engine.getStatus());
    }
    return null;
    }

    const safetyFailure = validateLiveSafety();
    if (safetyFailure) return safetyFailure;
    const compatFailure = validateCompatibility();
    if (compatFailure) return compatFailure;

    // --- Scroll, then FULLY revalidate after the asynchronous wait ---
    // Semantic freshness is checked synchronously (not via the observer's
    // debounce), identity is re-resolved, and live safety + compatibility
    // are repeated immediately before dispatch. A changed page rejects;
    // the request is never silently refreshed into validity.
    scrollNode(node, win);
    if (settleMs > 0) await sleep(Math.min(settleMs, 50));
    const changedDuringWait = engine.checkForChanges();
    if (changedDuringWait && changedDuringWait.changed) {
      return failure("STALE_SNAPSHOT", "The page changed while preparing the action. Re-snapshot before acting.", engine.getStatus(), "page changed during the pre-dispatch wait");
    }
    resolved = engine.resolveNode(elementId, preSnapshot.revision);
    if (resolved.status !== "ok" || resolved.node !== node) {
      return failure("STALE_TARGET", `Target ${elementId} changed while scrolling. Re-snapshot before acting.`, engine.getStatus());
    }
    const lateSafetyFailure = validateLiveSafety();
    if (lateSafetyFailure) return lateSafetyFailure;
    const lateCompatFailure = validateCompatibility();
    if (lateCompatFailure) return lateCompatFailure;

    // --- Perform exactly one activation path; never retry ---
    let result;
    try {
      if (action === "scroll_to") {
        result = { scrolled: true, inViewport: inViewport(node, win), verified: inViewport(node, win) };
        if (!result.verified && node.getBoundingClientRect) {
          const r = node.getBoundingClientRect();
          if (r.width === 0 && r.height === 0) result = { scrolled: true, inViewport: false, verified: false, note: "Target has no measurable geometry to verify scrolling." };
        }
      } else if (action === "read") {
        result = { element: descriptor };
      } else if (action === "click") {
        node.click();
        result = { dispatched: true };
      } else if (action === "fill") {
        setNativeValue(node, value, win);
        dispatchValueEvents(node, win);
        result = { dispatched: true }; // final retention verified after settling
      } else if (action === "select") {
        setNativeValue(node, value, win);
        dispatchValueEvents(node, win);
        result = { dispatched: true }; // final retention verified after settling
      } else if (action === "check" || action === "uncheck") {
        const desired = action === "check";
        const isNative = node.tagName === "INPUT" && ["checkbox", "radio"].includes(((node.getAttribute && node.getAttribute("type")) || "").toLowerCase());
        const current = isNative ? Boolean(node.checked) : ariaChecked(node);
        if (current === desired) {
          // No activation, but final state is still verified after settling
          // below: the page may change it during the settle window.
          result = { dispatched: false, pendingDesired: desired, pendingNative: isNative, alreadyInDesiredState: true };
        } else {
          node.click();
          result = { dispatched: true, pendingDesired: desired, pendingNative: isNative };
        }
      }
    } catch (err) {
      return failure("ACTION_FAILED", `Action failed: ${err && err.message ? err.message : err}`, engine.getStatus(), "action dispatch threw");
    }

    // --- Settle, fresh snapshot, semantic diff, outcome verification ---
    if (settleMs > 0) await sleep(settleMs);
    let postSnapshot = null;
    let diff = null;
    let diffUnavailableReason = null;
    try {
      postSnapshot = engine.snapshot();
      diff = internals.diffNormalized(
        internals.normalizeElements(preSnapshot.elements),
        internals.normalizeElements(postSnapshot.elements)
      );
    } catch (err) {
      diffUnavailableReason = `post-action snapshot unavailable: ${err && err.message ? err.message : err}`;
    }

    // Final outcome verification against LIVE state after settling.
    if (action === "fill" || action === "select" || (result && result.pendingDesired !== undefined)) {
      const finalResolved = postSnapshot ? engine.resolveNode(elementId) : { status: "unavailable", node: null };
      let retained = false;
      if (finalResolved.status === "ok" && finalResolved.node === node && node.isConnected) {
        if (action === "fill" || action === "select") retained = node.value === value;
        else {
          const finalState = result.pendingNative ? Boolean(node.checked) : ariaChecked(node);
          retained = finalState === result.pendingDesired;
        }
      }
      if (!retained) {
        return failureWithDiff(
          "ACTION_NOT_VERIFIED",
          action === "check" || action === "uncheck"
            ? `The desired ${action} state was not retained after settling; the control may not respond to synthetic activation or the page overrode it.`
            : "The requested value was not retained after settling; the page may have reset or overridden it.",
          postSnapshot, diff, diffUnavailableReason
        );
      }
      if (action === "fill") result = { verified: true };
      else if (action === "select") result = { verified: true, selectedValue: node.value };
      else {
        const wasAlready = Boolean(result.alreadyInDesiredState);
        result = { verified: true, checked: result.pendingDesired };
        if (wasAlready) result.alreadyInDesiredState = true;
      }
    }

    if (action === "click") {
      const changed = diff ? (diff.added.length + diff.removed.length + diff.updated.length) > 0 : false;
      result = {
        dispatched: true,
        verified: changed && node.isConnected,
        note: !node.isConnected
          ? "Activation dispatched; the original node left the document, so downstream completion is not verified."
          : changed
            ? "Activation dispatched with an observable page change."
            : "Activation dispatched; no observable state change was detected, and downstream completion is not claimed.",
      };
    }
    if (action === "read" && postSnapshot) {
      const current = postSnapshot.elements.find((e) => e.id === elementId);
      if (current) result = { element: current };
    }

    return {
      ok: true,
      result,
      newSnapshotDiff: diff,
      diffUnavailableReason,
      documentSessionId: postSnapshot ? postSnapshot.documentSessionId : engine.sessionId,
      revision: postSnapshot ? postSnapshot.revision : engine.getStatus().revision,
    };
  }

  return { execute };
}

if (typeof globalThis !== "undefined") {
  globalThis.__seeyable_createExecutor = createExecutor;
  globalThis.__seeyable_isConsequentialControl = isConsequentialControl;
}
if (typeof module !== "undefined" && module.exports) {
  module.exports = { createExecutor, isConsequentialControl, ACTIONS };
}
