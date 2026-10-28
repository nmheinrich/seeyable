# Feature 8 — Executor Actions

One reusable executor for single page actions, shared by every future
caller (voice, MCP, panels). All requests pass through the single entry
point `executor.execute(request)` in `apps/extension/lib/executor.js`;
mutation helpers are private. No plan runner, confirmation UI, or
action log is included in this milestone.

## Request / response contract

Request (JSON-serializable; `value` only where applicable):

```json
{ "action": "fill", "elementId": "el-12", "documentSessionId": "doc-…", "revision": 3, "value": "text" }
```

Actions: `click`, `fill`, `select`, `check`, `uncheck`, `scroll_to`,
`read`. Content-script integration:
`{type:"SEEYABLE_EXECUTE_ACTION", request:{…}}` (async response).

Response:

```json
{
  "ok": true,
  "result": { "verified": true },
  "newSnapshotDiff": { "added": [], "removed": [], "updated": [{ "id": "el-12", "changedFields": ["state"] }] },
  "diffUnavailableReason": null,
  "documentSessionId": "doc-…",
  "revision": 4
}
```

On failure: `ok:false`, `error:{code, message}` with a stable code
(`INVALID_REQUEST`, `UNKNOWN_ACTION`, `VALUE_REQUIRED`, `WRONG_SESSION`,
`SNAPSHOT_BASELINE_REQUIRED`,
`STALE_SNAPSHOT`, `STALE_REVISION`, `UNKNOWN_ID`, `STALE_TARGET`,
`TARGET_HIDDEN`, `TARGET_DISABLED`, `TARGET_READONLY`,
`INCOMPATIBLE_TARGET`, `OPTION_NOT_FOUND`, `OPTION_DISABLED`,
`UNSUPPORTED_MULTISELECT`, `UNSUPPORTED_RADIO_UNCHECK`,
`SENSITIVE_FIELD`, `CONSEQUENTIAL_BLOCKED`, `ACTION_NOT_VERIFIED`,
`ACTION_FAILED`), `newSnapshotDiff:null`, and a
`diffUnavailableReason` explaining why no diff is claimed — a missing
diff never means "no changes". DOM nodes and raw request objects are
never returned or logged. This contract is the candidate to move into
`packages/shared` schemas later; no workspace framework is created now.

## Validation (before any action)

1. Action name, ID shape, session, and integer revision are checked
   explicitly; missing session/revision never disables validation. A
   caller-received snapshot baseline must already exist: with no prior
   snapshot, or after explicit invalidation, requests reject
   (`SNAPSHOT_BASELINE_REQUIRED` / `STALE_SNAPSHOT`) — the executor's
   own pre-action snapshot never authorizes an ID or revision the
   caller never received.
2. Page changes are detected synchronously (`checkForChanges()`), not
   via the observer's debounce; a changed page rejects as
   `STALE_SNAPSHOT` instead of acting on old references.
3. The ID must belong to the referenced snapshot and resolve through
   the engine's original-node identity (`resolveNode`) — never a
   CSS-path lookup. Replaced, detached, or identity-changed nodes
   reject as stale. Hidden targets reject; effectively disabled
   targets reject for mutations (native semantics, including a
   disabled `<fieldset>` ancestor with its first-`<legend>` exception,
   plus ARIA disabled; select options inside disabled `<optgroup>`s
   likewise reject); read-only targets reject for value changes.
   These live checks use effective state, not just the node's own
   `disabled` property, and repeat after waits.
4. After scrolling and the bounded wait, validation repeats in full:
   semantic freshness is rechecked synchronously (not via the
   observer's debounce), identity is re-resolved, and live visibility,
   disabled/readonly, sensitivity, consequential, and compatibility
   checks all run again immediately before dispatch. A page that
   changed during the wait (for example a control renamed to a
   consequential label, or made read-only) rejects instead of being
   silently refreshed into validity. Exactly one activation path runs
   per request; nothing is retried or replayed.

## Action behavior

- `click`: one `node.click()` on the validated control. Result reports
  `dispatched`; `verified` is true only when the semantic diff shows an
  observable change. A harmless click with no control-state change
  reports dispatched without claiming downstream completion, and a node
  that leaves the document is reported as unverified.
- `fill`: native `HTMLInputElement`/`HTMLTextAreaElement` value setter
  plus bubbling `input`/`change`, so controlled inputs observe the
  change; empty string clears. Text-like inputs and textareas only.
- `select`: native single-select by exact option value; missing or
  disabled options and multi-selects reject without guessing.
- `check`/`uncheck`: explicit desired state, idempotent. Native
  checkbox/radio activate normally (radio group behavior preserved);
  explicitly unchecking a radio is unsupported. ARIA
  checkbox/radio/switch activate through the page's own behavior and
  the resulting `aria-checked` is verified — it is never assigned
  directly.
- `scroll_to`: scrolls into view (nested containers included, reduced
  motion respected) and reports whether the target is in the viewport.
- `read`: returns the control's snapshot descriptor and current state
  under the existing redaction rules; not page extraction.

Post-action: bounded settle, fresh snapshot, semantic diff via the
schema-v2 normalization. Filled values, selections, and checked states
are verified against the final live state after settling (asynchronous
ARIA changes within the bounded settle are included, and the
already-in-desired-state path is verified the same way — no path
skips final verification, and a lost state is never retried into
place). If the page reset or overrode the requested state, the result is
`ACTION_NOT_VERIFIED` with the post-action diff preserved — a failed
outcome does not mean nothing changed. For clicks, a target that left
the document is reported dispatched but never verified.

## Safety boundary (this milestone)

> Superseded for consequential activation by Feature #11
> (`docs/features/feature-11-shared-safety-gate.md`): the blanket
> `CONSEQUENTIAL_BLOCKED` behavior below is now a held
> `CONFIRMATION_REQUIRED` challenge requiring single-use human
> approval. Classification, sensitive-field blocking, and all other
> executor behavior described here are unchanged.

- **Consequential guard (central, executor-side)**: native submit
  controls — including buttons whose effective type defaults to submit
  through form association, whether via an ancestor form or the `form`
  attribute, regardless of label or placement — and controls whose accessible name/value/text matches submit,
  pay/buy, checkout, delete/remove, send, or publish patterns are
  blocked for `click`/`check`/`uncheck` with `CONSEQUENTIAL_BLOCKED`.
  Ambiguous consequential activation is blocked rather than guessed.
  There is no `confirmed` flag, token, or test bypass: every caller,
  including tests and content-script messages, is blocked equally.
- **Sensitive fields**: writes to password/payment/government-ID and
  similarly classified fields (the snapshot engine's centralized
  `sensitiveInfo`) reject as `SENSITIVE_FIELD`. Reads, snapshots,
  diffs, and errors never expose protected values; rejected fill values
  are not echoed. Classification is heuristic — see the schema doc for
  its limits; it is not a guarantee of complete intent or sensitivity
  detection.
- The later safety-gate feature is expected to add human approval and
  single-use tokens at this same `execute()` boundary without changing
  callers.

## Supported controls and limits

Native controls and ARIA widgets reachable through a single activation
or native value semantics, as above. Not supported: custom ARIA
combobox automation, multi-select, radio unchecking, non-text input
types for `fill` (dates, numbers, files, colors), shadow-DOM or
cross-origin-frame targets, and any consequential activation until the
safety gate exists. Website compatibility is therefore deliberately
not universal.

## Verification

- Automated: `npm --prefix apps/extension test` (executor suite covers
  every action, incompatible targets, controlled-input events,
  idempotence and radio groups, conditional-appearance diffs,
  pre-debounce change detection, session/revision/unknown/replacement
  rejection, consequential blocking with handler flags, sensitive
  redaction across all returned data, and single-activation counting).
- Browser: the demo survey and `tests/fixtures/executor-form.html`
  through the real `SEEYABLE_EXECUTE_ACTION` message path, including a
  controlled input whose page listener must observe the fill.
