"use strict";
/*
 * Seeyable executor: single entry point for all page actions.
 *
 * Every caller (side panel today; voice and MCP later) goes through
 * `execute(request)`. Lower-level mutation helpers stay private to this
 * module. DOM nodes never leave the content-script context, requests are
 * validated against the snapshot engine's original-node identity
 * (`resolveNode`). Consequential controls require human confirmation
 * through the shared safety gate (Feature #11): execute() returns a
 * confirmation challenge, and the stored request can only be run by
 * approveChallenge(), which trusted extension routing calls after an
 * intentional panel approval. No caller-supplied field can mint or
 * substitute approval. See docs/features/feature-11-shared-safety-gate.md.
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
  const now = options.now || (() => Date.now());
  const challengeTtlMs = options.challengeTtlMs !== undefined ? options.challengeTtlMs : 60000;

  /* --- Shared safety gate state (Feature #11) ---
   * Challenges and their approval capabilities live only in this
   * closure, per document: navigation destroys them, and no token ever
   * crosses a messaging boundary. Approval is single-use, short-lived,
   * and bound to the exact stored request and live page state. */
  const gate = { paused: false, stopped: false, generation: 0 };
  const challenges = new Map();
  const activeGrants = new Map(); // challengeId -> in-flight approval grant
  const actionLog = [];
  const LOG_LIMIT = 100;
  let executionBusy = false;
  let logTargetName = null;

  function sanitizeSource(source) {
    return ["manual", "voice", "mcp"].includes(source) ? source : "unknown";
  }
  function logEvent(entry) {
    actionLog.push({ timestamp: new Date(now()).toISOString(), approved: false, ...entry });
    if (actionLog.length > LOG_LIMIT) actionLog.splice(0, actionLog.length - LOG_LIMIT);
  }
  // Private binding uses Web Crypto SHA-256 over the structured
  // submission representation. There is deliberately no weaker
  // fallback: if a secure primitive is unavailable in this context,
  // consequential confirmation fails closed (SECURE_BINDING_UNAVAILABLE)
  // rather than minting a challenge bound by a guessable digest or ID.
  function secureCrypto() {
    const c = globalThis.crypto;
    return c && c.subtle && typeof c.subtle.digest === "function" && typeof c.getRandomValues === "function" ? c : null;
  }
  function utf8Bytes(text) {
    if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(String(text));
    const bytes = [];
    for (const ch of String(text)) {
      const cp = ch.codePointAt(0);
      if (cp < 0x80) bytes.push(cp);
      else if (cp < 0x800) bytes.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
      else if (cp < 0x10000) bytes.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
      else bytes.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    }
    return new Uint8Array(bytes);
  }
  async function sha256Hex(text) {
    const cryptoApi = secureCrypto();
    if (!cryptoApi) {
      const err = new Error("Web Crypto SHA-256 is unavailable in this context.");
      err.code = "SECURE_BINDING_UNAVAILABLE";
      throw err;
    }
    const digest = await cryptoApi.subtle.digest("SHA-256", utf8Bytes(text));
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  }
  function randomId() {
    const cryptoApi = secureCrypto();
    if (!cryptoApi) return null;
    const bytes = new Uint8Array(16);
    cryptoApi.getRandomValues(bytes);
    return "ch-" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }
  function secureUnavailableFailure() {
    return failure("SECURE_BINDING_UNAVAILABLE", "A collision-resistant binding (Web Crypto SHA-256) is unavailable in this context, so consequential actions cannot be safely confirmed here. Nothing was executed.", engine.getStatus(), "secure binding primitive unavailable");
  }
  // Private digest of the effective submission the reviewed action
  // would produce. The semantic hash deliberately excludes raw values,
  // so it cannot prove a form's contents are unchanged; this digest
  // can. It covers the associated form's destination/method, the
  // submitter's override attributes, and every form-associated control
  // (including controls associated from outside the form via the
  // `form` attribute), their names, values, checked/selected state,
  // and disabled state. It is computed over live values (including
  // protected ones) but only the digest is kept, and only inside this
  // closure — never in challenges, logs, or responses. Entries are
  // JSON-encoded arrays, never ambiguous string concatenation.
  function attr(el, name) {
    return (el && el.getAttribute && el.getAttribute(name)) || "";
  }
  function submissionRepresentation(node) {
    const form = node.form || (node.closest && node.closest("form"));
    if (!form) {
      return ["no-form", node.tagName, attr(node, "type"),
        typeof node.value === "string" ? node.value : "", Boolean(node.checked)];
    }
    const submission = [
      "form",
      typeof form.action === "string" ? form.action : attr(form, "action"),
      typeof form.method === "string" ? form.method.toLowerCase() : attr(form, "method").toLowerCase(),
      typeof form.enctype === "string" ? form.enctype : attr(form, "enctype"),
      attr(form, "target"),
      // Submitter overrides on the reviewed control itself.
      attr(node, "formaction"), attr(node, "formmethod"), attr(node, "formenctype"),
      attr(node, "formtarget"), node.hasAttribute && node.hasAttribute("formnovalidate") ? "1" : "",
    ];
    // All controls associated with this form, in document order —
    // including external ones bound through the `form` attribute.
    const doc = node.ownerDocument;
    const fields = doc && doc.querySelectorAll
      ? Array.from(doc.querySelectorAll("input, select, textarea, button")).filter((f) => f.form === form)
      : Array.from(form.querySelectorAll ? form.querySelectorAll("input, select, textarea, button") : []);
    for (const field of fields) {
      const entry = [
        field.tagName,
        attr(field, "name"),
        attr(field, "type").toLowerCase(),
        field.disabled ? "1" : "0",
        field.checked ? "1" : "0",
      ];
      if (field.tagName === "SELECT") {
        entry.push(Array.from(field.selectedOptions || []).map((o) => o.value));
      } else {
        entry.push(typeof field.value === "string" ? field.value : "");
      }
      submission.push(entry);
    }
    return submission;
  }
  async function computeBinding(request, descriptor, node, snapshotLike) {
    const submissionJson = JSON.stringify(submissionRepresentation(node));
    const targetJson = JSON.stringify([
      node.tagName,
      ((node.getAttribute && node.getAttribute("type")) || "").toLowerCase(),
      (node.getAttribute && node.getAttribute("id")) || "",
      (node.getAttribute && node.getAttribute("name")) || "",
      descriptor.role || "",
      descriptor.name || "",
    ]);
    const [submissionDigest, targetDigest] = await Promise.all([sha256Hex(submissionJson), sha256Hex(targetJson)]);
    return {
      sessionId: request.documentSessionId,
      revision: snapshotLike.revision,
      semanticHash: snapshotLike.semanticHash || null,
      elementId: request.elementId,
      action: request.action,
      value: request.value === undefined ? null : request.value,
      target: targetDigest,
      payload: submissionDigest,
    };
  }
  function bindingMatches(a, b) {
    return a.sessionId === b.sessionId && a.revision === b.revision
      && a.semanticHash === b.semanticHash && a.elementId === b.elementId
      && a.action === b.action && a.value === b.value
      && a.target === b.target && a.payload === b.payload;
  }
  function purgeExpired() {
    const t = now();
    for (const [id, c] of challenges) if (t > c.expiresAt) challenges.delete(id);
  }
  function revokeAllChallenges(decision) {
    for (const c of challenges.values()) {
      if (!c.consumed) logEvent({ source: "manual", action: c.request.action, elementId: c.request.elementId, targetName: c.targetName, decision });
    }
    challenges.clear();
  }
  function getGateStatus() {
    return {
      paused: gate.paused,
      stopped: gate.stopped,
      generation: gate.generation,
      pendingChallenges: Array.from(challenges.values()).filter((c) => !c.consumed).length,
    };
  }

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

  async function executePipeline(request, approvalGrant) {
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
    if (gate.stopped) return failure("EXECUTION_STOPPED", "Execution is stopped at the safety gate. Use Resume in the panel to reopen it; nothing was executed and nothing will be replayed automatically.");
    if (gate.paused) return failure("EXECUTION_PAUSED", "Execution is paused at the safety gate. Resume in the panel to continue; this request was not executed and will not be replayed automatically.");
    const admissionGeneration = gate.generation;

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
    logTargetName = descriptor.name || null;

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
          return { challenge: true }; // grant binding is verified asynchronously at the call sites
        }
      }
      return null;
    }

    // Verifies the approval grant against a freshly hashed binding.
    // Ordering: the submission representation is serialized
    // synchronously, hashed asynchronously, then re-serialized and
    // compared exactly — so a page change during the hashing wait is
    // detected. The verified serialization is remembered and compared
    // once more, synchronously, immediately before dispatch; no
    // unchecked wait remains between final validation and activation.
    let verifiedSubmissionJson = null;
    async function verifyApprovalBinding() {
      const submissionJson = JSON.stringify(submissionRepresentation(node));
      let liveBinding;
      try {
        liveBinding = await computeBinding(request, descriptor, node, preSnapshot);
      } catch (err) {
        if (err && err.code === "SECURE_BINDING_UNAVAILABLE") return secureUnavailableFailure();
        throw err;
      }
      if (JSON.stringify(submissionRepresentation(node)) !== submissionJson) {
        return failure("APPROVAL_INVALIDATED", "The page changed while the approval was being verified. The approval is revoked. Review a fresh snapshot and request confirmation again.", engine.getStatus());
      }
      if (!bindingMatches(approvalGrant.binding, liveBinding)) {
        return failure("APPROVAL_INVALIDATED", "The approved action no longer matches the live page: the target, the submission contents, or the page state changed after approval. The approval is revoked. Review a fresh snapshot and request confirmation again.", engine.getStatus());
      }
      verifiedSubmissionJson = submissionJson;
      return null;
    }

    async function issueChallenge() {
      purgeExpired();
      if (!secureCrypto()) return secureUnavailableFailure();
      const challengeId = randomId();
      if (!challengeId) return secureUnavailableFailure();
      const expiresAt = now() + challengeTtlMs;
      const nativeSubmit = (() => {
        const tag = node.tagName;
        const type = ((node.getAttribute && node.getAttribute("type")) || "").toLowerCase();
        if (tag === "INPUT" && (type === "submit" || type === "image")) return true;
        if (tag === "BUTTON") {
          const effectiveType = ["submit", "reset", "button"].includes(type) ? type : "submit";
          return effectiveType === "submit" && Boolean(node.form || (node.closest && node.closest("form")));
        }
        return false;
      })();
      let binding;
      try {
        binding = await computeBinding(request, descriptor, node, preSnapshot);
      } catch (err) {
        if (err && err.code === "SECURE_BINDING_UNAVAILABLE") return secureUnavailableFailure();
        throw err;
      }
      const changedDuringIssue = engine.checkForChanges();
      if (changedDuringIssue && changedDuringIssue.changed) {
        return failure("STALE_SNAPSHOT", "The page changed while the confirmation was being prepared. Re-snapshot and try again.", engine.getStatus(), "page changed while issuing confirmation");
      }
      challenges.set(challengeId, {
        request: {
          action, elementId, documentSessionId, revision,
          value: value === undefined ? undefined : value,
          source: sanitizeSource(request.source),
        },
        binding,
        targetName: descriptor.name || null,
        expiresAt,
        consumed: false,
      });
      return {
        ok: false,
        error: {
          code: "CONFIRMATION_REQUIRED",
          message: `${action} on "${descriptor.name}" is consequential and requires human confirmation in the Seeyable panel. Nothing was executed.`,
        },
        confirmation: {
          challengeId,
          action,
          elementId,
          targetName: descriptor.name || null,
          targetQuestion: descriptor.question || null,
          evidence: nativeSubmit ? "native-submit" : "consequential-label",
          consequence: nativeSubmit
            ? "This activates a form submission control. What it sends, to whom, and whether it can be undone cannot be determined from the page."
            : "This activates a control whose label indicates a consequential action (such as submit, pay, delete, send, or publish). Its downstream effect, recipient, and reversibility cannot be determined from the page.",
          pageUrl: preSnapshot.url || null,
          documentSessionId,
          revision,
          expiresAt: new Date(expiresAt).toISOString(),
        },
        newSnapshotDiff: null,
        diffUnavailableReason: "awaiting human confirmation; nothing was performed",
        documentSessionId,
        revision,
      };
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
    if (safetyFailure && safetyFailure.challenge) {
      if (!approvalGrant) return issueChallenge();
      const bindingFailure = await verifyApprovalBinding();
      if (bindingFailure) return bindingFailure;
    } else if (safetyFailure) return safetyFailure;
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
    if (lateSafetyFailure && lateSafetyFailure.challenge) {
      if (!approvalGrant) return issueChallenge();
      const bindingFailure = await verifyApprovalBinding();
      if (bindingFailure) return bindingFailure;
    } else if (lateSafetyFailure) return lateSafetyFailure;
    const lateCompatFailure = validateCompatibility();
    if (lateCompatFailure) return lateCompatFailure;
    // Final validity checks immediately before dispatch. Cancellation
    // is operation-scoped: a Stop/Pause at any point during this
    // operation permanently invalidates it, even if Resume has since
    // reopened the gate for new requests. The approval deadline is
    // likewise rechecked here — a challenge is valid only while
    // now() < expiresAt. An already-dispatched action cannot be
    // recalled; this check is the last point where that is possible.
    if (approvalGrant && approvalGrant.revoked) {
      return failure("APPROVAL_CANCELLED", "This approval was cancelled while the action was being prepared. Nothing was dispatched.", engine.getStatus(), "approval cancelled before dispatch");
    }
    if (admissionGeneration !== gate.generation) {
      return failure("EXECUTION_CANCELLED", "This operation was cancelled by Stop or Pause while it was being prepared. Nothing was dispatched, and Resume does not revive it.", engine.getStatus(), "cancelled before dispatch");
    }
    if (approvalGrant && now() >= approvalGrant.expiresAt) {
      return failure("APPROVAL_EXPIRED", "The confirmation expired before the action could be dispatched. Nothing was executed; request a new confirmation.", engine.getStatus(), "approval expired before dispatch");
    }
    if (approvalGrant && verifiedSubmissionJson !== JSON.stringify(submissionRepresentation(node))) {
      return failure("APPROVAL_INVALIDATED", "The submission changed while the approved action was being prepared. Nothing was dispatched; the approval is revoked.", engine.getStatus(), "submission changed before dispatch");
    }
    if (gate.stopped) return failure("EXECUTION_STOPPED", "Execution was stopped while preparing the action. Nothing was dispatched.", engine.getStatus(), "stopped before dispatch");
    if (gate.paused) return failure("EXECUTION_PAUSED", "Execution was paused while preparing the action. Nothing was dispatched, and the request will not be replayed.", engine.getStatus(), "paused before dispatch");

    // Complete synchronous final validation. This runs after the last
    // asynchronous operation (binding hashing, waits) and nothing
    // after it awaits, so no page change can slip between this check
    // and activation. It repeats semantic freshness, original-node
    // resolution (identity + connectedness), and the full live safety
    // and compatibility validation — disabling, hiding, detaching, or
    // replacing the target while hashing was in flight is rejected
    // here rather than dispatched.
    {
      const changedNow = engine.checkForChanges();
      if (changedNow && changedNow.changed) {
        return failure("STALE_SNAPSHOT", "The page changed while the action was being prepared. Re-snapshot before acting.", engine.getStatus(), "page changed during final validation");
      }
      const finalResolved = engine.resolveNode(elementId, preSnapshot.revision);
      if (finalResolved.status !== "ok" || finalResolved.node !== node || !node.isConnected) {
        return failure("STALE_TARGET", `Target ${elementId} is no longer the reviewed control. Re-snapshot before acting.`, engine.getStatus());
      }
      const finalSafety = validateLiveSafety();
      if (finalSafety && !finalSafety.challenge) return finalSafety;
      const finalCompat = validateCompatibility();
      if (finalCompat) return finalCompat;
    }

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
        if (approvalGrant) approvalGrant.dispatched = true; // dispatch boundary
        node.click();
        result = { dispatched: true };
      } else if (action === "fill") {
        if (approvalGrant) approvalGrant.dispatched = true; // dispatch boundary
        setNativeValue(node, value, win);
        dispatchValueEvents(node, win);
        result = { dispatched: true }; // final retention verified after settling
      } else if (action === "select") {
        if (approvalGrant) approvalGrant.dispatched = true; // dispatch boundary
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
          if (approvalGrant) approvalGrant.dispatched = true; // dispatch boundary
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

  /* --- Public surface -----------------------------------------------------
   * execute() is the only caller-facing action entry. approveChallenge,
   * cancelChallenge, and the gate controls are approval authority: in
   * production only content-script routing may call them, and only
   * after verifying the message came from the trusted side panel (see
   * content.js). They are not reachable from any execute() request
   * field — forged `confirmed`/token fields are ignored by design. */
  function decisionFor(res) {
    if (res && res.confirmation) return "confirmation-required";
    if (res && res.ok) {
      if (res.result && res.result.verified) return "verified";
      if (res.result && res.result.dispatched) return "dispatched-unverified";
      if (res.result && res.result.alreadyInDesiredState) return "already-in-desired-state";
      return "completed";
    }
    return (res && res.error && res.error.code) || "failed";
  }

  async function runExclusive(request, approvalGrant) {
    if (executionBusy) {
      return failure("EXECUTION_BUSY", "Another execution is already in progress. Concurrent executions are rejected, not queued.");
    }
    executionBusy = true;
    logTargetName = null;
    try {
      const res = await executePipeline(request || {}, approvalGrant);
      logEvent({
        source: sanitizeSource(request && request.source),
        action: (request && request.action) || null,
        elementId: (request && request.elementId) || null,
        targetName: (res && res.confirmation && res.confirmation.targetName) || logTargetName,
        decision: decisionFor(res),
        approved: Boolean(approvalGrant),
      });
      return res;
    } finally {
      executionBusy = false;
    }
  }

  async function execute(request) {
    return runExclusive(request, null);
  }

  async function approveChallenge(challengeId) {
    // Look up before purging so an expired challenge reports EXPIRED
    // rather than NOT_FOUND.
    const record = challenges.get(challengeId);
    if (!record) {
      logEvent({ source: "manual", action: "approve", elementId: null, targetName: null, decision: "APPROVAL_NOT_FOUND" });
      return failure("APPROVAL_NOT_FOUND", "No pending confirmation matches that approval. It may have expired, been cancelled, been revoked, or never existed in this document.");
    }
    if (now() >= record.expiresAt) {
      challenges.delete(challengeId);
      logEvent({ source: "manual", action: record.request.action, elementId: record.request.elementId, targetName: record.targetName, decision: "APPROVAL_EXPIRED" });
      return failure("APPROVAL_EXPIRED", "The confirmation expired before approval. Review the page, then execute the action again to request a new confirmation.");
    }
    if (record.consumed) {
      logEvent({ source: "manual", action: record.request.action, elementId: record.request.elementId, targetName: record.targetName, decision: "APPROVAL_CONSUMED" });
      return failure("APPROVAL_CONSUMED", "That approval was already used. Approvals are single-use and a consumed action is never replayed.");
    }
    if (gate.stopped || gate.paused) {
      challenges.delete(challengeId);
      logEvent({ source: "manual", action: record.request.action, elementId: record.request.elementId, targetName: record.targetName, decision: gate.stopped ? "EXECUTION_STOPPED" : "EXECUTION_PAUSED" });
      return failure(gate.stopped ? "EXECUTION_STOPPED" : "EXECUTION_PAUSED", "The safety gate is closed, so the pending approval was revoked. Resume in the panel and request confirmation again.");
    }
    if (executionBusy) {
      return failure("EXECUTION_BUSY", "Another execution is already in progress. The approval was not consumed; approve again once it finishes.");
    }
    // Atomic consumption: marked before any asynchronous work, so a
    // concurrent approval of the same challenge cannot also run. A
    // consumed action is never retried, even if its outcome is
    // uncertain — the execution response reports what happened.
    record.consumed = true;
    logEvent({ source: "manual", action: record.request.action, elementId: record.request.elementId, targetName: record.targetName, decision: "approved" });
    const grant = { binding: record.binding, challengeId, expiresAt: record.expiresAt, revoked: false, dispatched: false };
    activeGrants.set(challengeId, grant);
    try {
      return await runExclusive(record.request, grant);
    } finally {
      activeGrants.delete(challengeId);
    }
  }

  function cancelChallenge(challengeId) {
    // In-flight first: an approval already consumed but not yet
    // dispatched can still be cancelled by revoking its grant, which
    // the pre-dispatch check honors. Once dispatched, no cancellation
    // is claimed — the result reports what already happened.
    const grant = activeGrants.get(challengeId);
    if (grant && grant.dispatched) {
      // Past the dispatch boundary: the page action already ran and
      // cannot be recalled. Report that honestly instead of claiming
      // a revocation that did not happen.
      const record = challenges.get(challengeId);
      logEvent({ source: "manual", action: record ? record.request.action : "approve", elementId: record ? record.request.elementId : null, targetName: record ? record.targetName : null, decision: "approval-cancel-too-late" });
      return { cancelled: false, dispatched: true };
    }
    if (grant && !grant.revoked) {
      grant.revoked = true;
      const record = challenges.get(challengeId);
      logEvent({ source: "manual", action: record ? record.request.action : "approve", elementId: record ? record.request.elementId : null, targetName: record ? record.targetName : null, decision: "approval-cancelled" });
      return { cancelled: true };
    }
    const record = challenges.get(challengeId);
    if (!record || record.consumed) return { cancelled: false };
    challenges.delete(challengeId);
    logEvent({ source: "manual", action: record.request.action, elementId: record.request.elementId, targetName: record.targetName, decision: "approval-cancelled" });
    return { cancelled: true };
  }

  function stopExecution() {
    gate.stopped = true;
    gate.generation += 1; // permanently invalidates undispatched in-flight work
    revokeAllChallenges("approval-revoked-stop");
    logEvent({ source: "manual", action: "gate-stop", elementId: null, targetName: null, decision: "stopped" });
    return getGateStatus();
  }
  function pauseExecution() {
    gate.paused = true;
    gate.generation += 1; // permanently invalidates undispatched in-flight work
    revokeAllChallenges("approval-revoked-pause");
    logEvent({ source: "manual", action: "gate-pause", elementId: null, targetName: null, decision: "paused" });
    return getGateStatus();
  }
  function resumeExecution() {
    // Resume only reopens admission. It replays nothing: requests that
    // were paused, stopped, or revoked stay dead by design.
    gate.paused = false;
    gate.stopped = false;
    logEvent({ source: "manual", action: "gate-resume", elementId: null, targetName: null, decision: "resumed" });
    return getGateStatus();
  }

  function getActionLog() {
    return actionLog.map((entry) => ({ ...entry }));
  }
  function clearActionLog() {
    actionLog.length = 0;
    return { cleared: true };
  }

  return {
    execute,
    approveChallenge,
    cancelChallenge,
    stopExecution,
    pauseExecution,
    resumeExecution,
    getGateStatus,
    getActionLog,
    clearActionLog,
  };
}

if (typeof globalThis !== "undefined") {
  globalThis.__seeyable_createExecutor = createExecutor;
  globalThis.__seeyable_isConsequentialControl = isConsequentialControl;
}
if (typeof module !== "undefined" && module.exports) {
  module.exports = { createExecutor, isConsequentialControl, ACTIONS };
}
