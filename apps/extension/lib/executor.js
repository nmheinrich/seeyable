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

  /* --- Undo record (Issue #15) ---
   * At most ONE record: the last change this executor made in this
   * document. It holds the live node reference and the complete live
   * prior/post state captured immediately around the mutation — never
   * snapshot or model data. It lives only in this closure: it is never
   * logged, returned, persisted, or sent anywhere. A reversible record
   * is replaced by the next executor change; a non-reversible or
   * uncertain change replaces it with a barrier, so undo never skips
   * backward past it. Sensitive targets are never captured. */
  let lastChange = null;

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

  /* --- Undo capture/restore helpers (Issue #15) --- */
  function inputType(node) {
    return ((node.getAttribute && node.getAttribute("type")) || "").toLowerCase();
  }
  // Native radio group: same name, same form owner, same tree. Members
  // associated through the `form` attribute are included via form.elements.
  function radioGroup(node) {
    if (!node.name) return [node];
    const pool = node.form
      ? Array.from(node.form.elements || [])
      : Array.from((node.getRootNode && node.getRootNode().querySelectorAll)
        ? node.getRootNode().querySelectorAll("input") : []).filter((r) => !r.form);
    return pool.filter((r) => r.tagName === "INPUT" && inputType(r) === "radio" && r.name === node.name);
  }
  function selectedOption(node) {
    return node.selectedIndex >= 0 && node.options ? node.options[node.selectedIndex] || null : null;
  }
  // Dropdown state is recorded by MEANING, not just node identity: the
  // option node, its index, and the value/label/text it had at capture
  // time, plus the select's mode. Mutating an option node afterwards
  // cannot rewrite this history. Values stay inside this closure.
  function selectState(node) {
    const option = selectedOption(node);
    return {
      option,
      index: node.selectedIndex,
      value: option ? option.value : null,
      label: option ? option.label : null,
      text: option ? option.text : null,
      multiple: Boolean(node.multiple),
    };
  }
  // The choice list's structure: every option's group, value, label, and
  // text, in order. Availability is checked separately (and explicitly)
  // for the restoration choice, exactly as forward select does.
  function selectStructure(node) {
    return JSON.stringify(Array.from(node.options || []).map((o) => {
      const group = o.parentElement && o.parentElement.tagName === "OPTGROUP" ? o.parentElement.label : null;
      return [group, o.value, o.label, o.text];
    }));
  }
  function optionUnavailable(option) {
    const group = option.parentElement && option.parentElement.tagName === "OPTGROUP" ? option.parentElement : null;
    return Boolean(option.disabled || (group && group.disabled));
  }
  // Radio members by meaning: name, value, and accessible name at capture.
  function radioMeaning(members) {
    return JSON.stringify(members.map((m) => [m.name, m.value,
      internals.computeAccessibleName ? internals.computeAccessibleName(m).name : ""]));
  }
  // Complete live state immediately before the mutation. Returns null
  // when the action is not reversible here (protected field, multiselect).
  function captureBefore(action, node, role) {
    if (internals.sensitiveInfo(node).sensitive) return null;
    if (action === "fill") return { kind: "value", prior: node.value };
    if (action === "select") {
      if (node.multiple) return null;
      return { kind: "select", prior: selectState(node), structure: selectStructure(node) };
    }
    if (action === "check" || action === "uncheck") {
      const type = node.tagName === "INPUT" ? inputType(node) : "";
      if (type === "checkbox") return { kind: "checkbox", prior: Boolean(node.checked) };
      if (type === "radio") {
        const members = radioGroup(node);
        return { kind: "radio", members, meaning: radioMeaning(members), prior: members.map((m) => Boolean(m.checked)) };
      }
      // An ARIA radio cannot be deselected by activating it again, and
      // its group is page-defined: not representable, so not reversible.
      if (role === "radio" || role === "menuitemradio") return null;
      return { kind: "aria", prior: ariaChecked(node) };
    }
    return null;
  }
  function currentState(capture, node) {
    if (capture.kind === "value") return node.value;
    if (capture.kind === "select") return selectState(node);
    if (capture.kind === "checkbox") return Boolean(node.checked);
    if (capture.kind === "radio") return capture.members.map((m) => Boolean(m.checked));
    return ariaChecked(node);
  }
  function sameState(capture, a, b) {
    if (capture.kind === "radio") return a.length === b.length && a.every((v, i) => v === b[i]);
    if (capture.kind === "select") {
      return a.option === b.option && a.index === b.index && a.value === b.value
        && a.label === b.label && a.text === b.text && a.multiple === b.multiple;
    }
    return a === b;
  }
  function priorState(capture) {
    return capture.prior;
  }
  function setBarrier(action, targetName, reason) {
    lastChange = { kind: "barrier", action, targetName: targetName || null, reason };
  }
  // After a verified mutation: record it only if the live state actually
  // changed. A verified no-op leaves the earlier record in place — it
  // changed nothing, so the last change is still the earlier one, and
  // restoration re-verifies that record's post-state anyway.
  function recordChange(action, elementId, descriptor, node, capture) {
    const post = currentState(capture, node);
    if (sameState(capture, priorState(capture), post)) return;
    lastChange = {
      kind: "reversible",
      action,
      elementId,
      session: engine.sessionId,
      node,
      targetName: descriptor.name || null,
      capture,
      post,
    };
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
    // Undo capture happens here, after the last validation and
    // immediately before the mutation, from the live node. Approved
    // (consequential) actions are never reversible.
    const undoCapture = isMutation && action !== "click" && !approvalGrant ? captureBefore(action, node, descriptor.role) : null;
    let mutationDispatched = false;
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
        mutationDispatched = true;
        node.click();
        result = { dispatched: true };
      } else if (action === "fill") {
        if (approvalGrant) approvalGrant.dispatched = true; // dispatch boundary
        mutationDispatched = true;
        setNativeValue(node, value, win);
        dispatchValueEvents(node, win);
        result = { dispatched: true }; // final retention verified after settling
      } else if (action === "select") {
        if (approvalGrant) approvalGrant.dispatched = true; // dispatch boundary
        mutationDispatched = true;
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
          mutationDispatched = true;
          node.click();
          result = { dispatched: true, pendingDesired: desired, pendingNative: isNative };
        }
      }
    } catch (err) {
      if (mutationDispatched) setBarrier(action, descriptor.name, "dispatch threw; outcome uncertain");
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
        if (mutationDispatched) setBarrier(action, descriptor.name, "outcome not verified");
        return failureWithDiff(
          "ACTION_NOT_VERIFIED",
          action === "check" || action === "uncheck"
            ? `The desired ${action} state was not retained after settling; the control may not respond to synthetic activation or the page overrode it.`
            : "The requested value was not retained after settling; the page may have reset or overridden it.",
          postSnapshot, diff, diffUnavailableReason
        );
      }
      if (mutationDispatched) {
        if (undoCapture) recordChange(action, elementId, descriptor, node, undoCapture);
        else setBarrier(action, descriptor.name, approvalGrant ? "approved consequential action" : "not reversible here");
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
      // Clicks and their downstream page effects are never reversible.
      setBarrier(action, descriptor.name, "click");
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

  /* --- Undo (Issue #15) ----------------------------------------------------
   * Restores the single last reversible change, through the same
   * serialization and gate as execute(). The record must still describe
   * the live page: same document, same original node at the same id,
   * same accessible name, still safe to write, and the CURRENT state
   * equal to the recorded post-action state. An intervening manual edit,
   * changed choice, replaced node, or reshaped radio group refuses and
   * retires the record — undo never overwrites what someone else did.
   * The record is consumed before any asynchronous work, so a duplicate
   * request cannot repeat it. Responses carry names, never values. */
  function undoFailure(code, message, status) {
    return { ...failure(code, message, status, "nothing was restored"), undo: true };
  }
  async function performUndo(record) {
    const node = record.node;
    const capture = record.capture;
    const name = record.targetName || record.elementId;
    const stale = (why) => undoFailure("UNDO_STALE", `Undo refused: “${name}” ${why}. Nothing was changed.`);
    const conflict = (why) => undoFailure("UNDO_CONFLICT", `Undo refused: ${why} since Seeyable changed “${name}”. Nothing was overwritten.`);
    const doc = node.ownerDocument;
    const win = doc && doc.defaultView;
    const admissionGeneration = gate.generation;
    const preSnapshot = engine.snapshot();
    // Restoration target for radios: the member that was checked before.
    let priorMember = null;
    // Live group identity AND meaning: same member nodes, all connected,
    // in the same order, with the same name/value/accessible name.
    function radioGroupIntact() {
      const members = radioGroup(node);
      return members.length === capture.members.length
        && members.every((m, i) => m === capture.members[i] && m.isConnected)
        && radioMeaning(members) === capture.meaning;
    }
    // Post-settle verification against the LIVE page, never history alone:
    // the target must still be the same connected control at its id with
    // the same name, the restored state must hold, and the group or list
    // that gives that state its meaning must be unchanged.
    function liveRestorationHolds() {
      if (!node.isConnected) return false;
      const resolved = engine.resolveNode(record.elementId);
      if (resolved.status !== "ok" || resolved.node !== node) return false;
      const liveName = internals.computeAccessibleName ? internals.computeAccessibleName(node).name : record.targetName;
      if ((liveName || null) !== record.targetName) return false;
      if (capture.kind === "radio" && !radioGroupIntact()) return false;
      if (capture.kind === "select" && (node.multiple || selectStructure(node) !== capture.structure)) return false;
      return sameState(capture, currentState(capture, node), priorState(capture));
    }
    function validate() {
      if (record.session !== engine.sessionId) return stale("belongs to another document");
      if (!node.isConnected) return stale("was removed or replaced");
      const resolved = engine.resolveNode(record.elementId);
      if (resolved.status !== "ok" || resolved.node !== node) return stale("is no longer the same control");
      const liveName = internals.computeAccessibleName ? internals.computeAccessibleName(node).name : record.targetName;
      if ((liveName || null) !== record.targetName) return stale("was relabelled");
      if (!internals.isVisible(node, win)) return stale("is no longer visible");
      if (effectiveDisabled(node)) return stale("is now disabled");
      if (internals.sensitiveInfo(node).sensitive) return stale("is now a protected field");
      if (capture.kind === "value" || capture.kind === "select") {
        if (node.readOnly || (node.getAttribute && node.getAttribute("aria-readonly") === "true")) return stale("is now read-only");
      }
      if (isConsequentialControl(node, { name: liveName })) return stale("now looks consequential");
      if (capture.kind === "radio" && !radioGroupIntact()) return conflict("the radio group changed");
      if (capture.kind === "select") {
        if (node.multiple) return stale("now allows several choices");
        if (selectStructure(node) !== capture.structure) return conflict("its list of choices changed");
      }
      if (!sameState(capture, currentState(capture, node), record.post)) {
        return conflict(capture.kind === "value" ? "the field was edited"
          : capture.kind === "select" ? "the dropdown choice changed"
          : "the control's state changed");
      }
      if (capture.kind === "select") {
        const prior = capture.prior;
        if (!prior.option) return undoFailure("UNDO_UNSUPPORTED", `Undo refused: “${name}” had no selected choice before, which cannot be restored safely. Nothing was changed.`);
        // The structure check above already pins every option's value,
        // label, and text; the restoration choice must also be the very
        // same node at the very same position, and still available —
        // forward select's disabled-option/optgroup rule, applied again.
        if (!node.options || node.options[prior.index] !== prior.option
          || prior.option.value !== prior.value || prior.option.label !== prior.label || prior.option.text !== prior.text) {
          return conflict("its previous choice changed");
        }
        if (optionUnavailable(prior.option)) return stale("cannot return to its previous choice, which is now unavailable");
      }
      if (capture.kind === "radio") {
        const index = capture.prior.indexOf(true);
        if (index < 0) {
          return undoFailure("UNDO_UNSUPPORTED", `Undo refused: no option in the “${name}” group was selected before, and clearing a radio group cannot be done safely. Nothing was changed.`);
        }
        priorMember = capture.members[index];
        if (!priorMember.isConnected || !internals.isVisible(priorMember, win) || effectiveDisabled(priorMember)) {
          return stale("cannot return to its previous option, which is no longer available");
        }
        const priorName = internals.computeAccessibleName ? internals.computeAccessibleName(priorMember).name : "";
        if (isConsequentialControl(priorMember, { name: priorName })) return stale("cannot return to an option that looks consequential");
      }
      return null;
    }
    const early = validate();
    if (early) return early;
    scrollNode(node, win);
    if (settleMs > 0) await sleep(Math.min(settleMs, 50));
    // Synchronous final validation: nothing awaits between here and dispatch.
    if (admissionGeneration !== gate.generation) {
      return undoFailure("EXECUTION_CANCELLED", "Undo was cancelled by Stop or Pause before anything was restored. Resume does not revive it.");
    }
    if (gate.stopped || gate.paused) return undoFailure(gate.stopped ? "EXECUTION_STOPPED" : "EXECUTION_PAUSED", "The safety gate closed before anything was restored.");
    const late = validate();
    if (late) return late;
    try {
      if (capture.kind === "value") {
        setNativeValue(node, capture.prior, win);
        dispatchValueEvents(node, win);
      } else if (capture.kind === "select") {
        node.selectedIndex = capture.prior.index; // verified: same node, same meaning
        dispatchValueEvents(node, win);
      } else if (capture.kind === "radio") {
        priorMember.click();
      } else {
        node.click(); // checkbox / ARIA toggle: one activation, as forward
      }
    } catch (err) {
      setBarrier("undo", record.targetName, "undo dispatch threw; outcome uncertain");
      return undoFailure("ACTION_FAILED", `Undo failed while restoring “${name}”; its state is uncertain. Check the page.`);
    }
    if (settleMs > 0) await sleep(settleMs);
    let postSnapshot = null;
    let diff = null;
    let diffUnavailableReason = null;
    try {
      postSnapshot = engine.snapshot();
      diff = internals.diffNormalized(internals.normalizeElements(preSnapshot.elements), internals.normalizeElements(postSnapshot.elements));
    } catch (err) {
      diffUnavailableReason = `post-undo snapshot unavailable: ${err && err.message ? err.message : err}`;
    }
    if (!liveRestorationHolds()) {
      // Something was dispatched but the prior state does not hold on the
      // live page (overridden, removed, replaced, regrouped, relabelled):
      // the outcome is uncertain, so nothing earlier may be undone past
      // it, and nothing is retried.
      setBarrier("undo", record.targetName, "undo not verified");
      return { ...failureWithDiff("UNDO_NOT_VERIFIED", `Undo was dispatched but “${name}” could not be verified back in its previous state on the live page — it may have been overridden, removed, replaced, or regrouped. Check the page.`, postSnapshot, diff, diffUnavailableReason), undo: true };
    }
    const restoredName = priorMember && priorMember !== node && internals.computeAccessibleName
      ? internals.computeAccessibleName(priorMember).name || null : null;
    return {
      ok: true,
      undo: true,
      result: {
        verified: true,
        restored: true,
        undoneAction: record.action,
        elementId: record.elementId,
        targetName: record.targetName,
        restoredTargetName: restoredName,
        scope: "last-change-only",
      },
      newSnapshotDiff: diff,
      diffUnavailableReason,
      documentSessionId: postSnapshot ? postSnapshot.documentSessionId : engine.sessionId,
      revision: postSnapshot ? postSnapshot.revision : engine.getStatus().revision,
    };
  }

  async function undoLastChange(request) {
    const req = request || {};
    const source = sanitizeSource(req.source);
    if (gate.stopped) return undoFailure("EXECUTION_STOPPED", "Execution is stopped at the safety gate. Resume before undoing; nothing was changed.");
    if (gate.paused) return undoFailure("EXECUTION_PAUSED", "Execution is paused at the safety gate. Resume before undoing; nothing was changed.");
    if (typeof req.documentSessionId !== "string" || req.documentSessionId !== engine.sessionId) {
      return undoFailure("WRONG_SESSION", "Undo was requested for another document. Nothing was changed.");
    }
    if (executionBusy) {
      return undoFailure("EXECUTION_BUSY", "Another execution is in progress. Undo was not attempted; try again once it finishes.");
    }
    const record = lastChange;
    if (!record) {
      logEvent({ source, action: "undo", elementId: null, targetName: null, decision: "NOTHING_TO_UNDO" });
      return undoFailure("NOTHING_TO_UNDO", "There is no change to undo in this page. Nothing was changed.");
    }
    if (record.kind === "barrier") {
      logEvent({ source, action: "undo", elementId: null, targetName: record.targetName, decision: "UNDO_NOT_REVERSIBLE" });
      const what = record.action === "click" ? `the click on “${record.targetName || "a control"}”`
        : record.action === "undo" ? "the previous undo, whose outcome was uncertain"
        : `the ${record.action} of “${record.targetName || "a control"}” (${record.reason})`;
      return undoFailure("UNDO_NOT_REVERSIBLE", `The last action — ${what} — cannot be undone, and earlier changes are not undone past it. Nothing was changed.`);
    }
    // Atomic consumption before any asynchronous work: a duplicate or
    // concurrent undo finds nothing to repeat.
    lastChange = null;
    executionBusy = true;
    try {
      const res = await performUndo(record);
      logEvent({
        source,
        action: "undo",
        elementId: record.elementId,
        targetName: record.targetName,
        decision: res.ok ? "verified" : (res.error && res.error.code) || "failed",
      });
      return res;
    } finally {
      executionBusy = false;
    }
  }

  /* --- Public surface -----------------------------------------------------
   * execute() is the only caller-facing action entry. approveChallenge,
   * cancelChallenge, and the gate controls are approval authority: in
   * production only content-script routing may call them, and only
   * after verifying the message came from the trusted side panel (see
   * content.js). They are not reachable from any execute() request
   * field — forged `confirmed`/token fields are ignored by design.
   * undoLastChange is routed the same trusted-panel-only way (Issue #15);
   * it is not exposed to MCP. */
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
    undoLastChange,
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
