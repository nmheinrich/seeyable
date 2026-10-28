# Feature 11 — Shared Executor Safety Gate

One fail-closed confirmation mechanism at the executor boundary, used
identically by the manual panel today and by future voice-planner and
MCP callers. Consequential activation requires deliberate human
approval in the extension UI. This document records the threat/trust
boundaries, contracts, token design, cancellation, redaction, and
limits. Classification, target validation, and ordinary-action
behavior from Feature #8 are unchanged; sensitive writes remain
blocked outright in this milestone.

## Contracts

Execution request (unchanged fields, one addition):

```json
{ "action": "click", "elementId": "el-19",
  "documentSessionId": "doc-…", "revision": 3,
  "value": "…", "source": "manual" }
```

`source` (`manual` | `voice` | `mcp`, anything else logged as
`unknown`) is caller-reported audit attribution only. It never
authorizes anything. Approval-shaped fields (`confirmed`, tokens,
challenge IDs) in an execute request are ignored by design — the
content script does not even forward them to the executor.

A consequential request that passes all other validation returns:

```json
{ "ok": false,
  "error": { "code": "CONFIRMATION_REQUIRED", "message": "…" },
  "confirmation": {
    "challengeId": "ch-…", "action": "click", "elementId": "el-19",
    "targetName": "Submit feedback", "targetQuestion": null,
    "evidence": "native-submit",
    "consequence": "This activates a form submission control. …",
    "pageUrl": "https://…", "documentSessionId": "doc-…",
    "revision": 3, "expiresAt": "…"
  },
  "newSnapshotDiff": null,
  "diffUnavailableReason": "awaiting human confirmation; nothing was performed",
  "documentSessionId": "doc-…", "revision": 3 }
```

Nothing has been executed at this point. The consequence text states
only what the page evidence supports; it never invents a recipient,
amount, or reversibility claim.

New panel→content messages (all sender-verified, below):

- `SEEYABLE_APPROVE_CHALLENGE { challengeId }` → the execution
  response for the stored request, or an approval-stage error:
  `APPROVAL_NOT_FOUND`, `APPROVAL_EXPIRED`, `APPROVAL_CONSUMED`,
  `APPROVAL_INVALIDATED`, `EXECUTION_PAUSED`, `EXECUTION_STOPPED`,
  `EXECUTION_BUSY`, `UNTRUSTED_APPROVAL`.
- `SEEYABLE_CANCEL_CHALLENGE { challengeId }` → `{ ok, cancelled }`.
- `SEEYABLE_GATE_CONTROL { command: "stop"|"pause"|"resume" }` →
  `{ ok, gate: { paused, stopped, pendingChallenges } }`.
- `SEEYABLE_GET_ACTION_LOG` → `{ ok, entries }`;
  `SEEYABLE_CLEAR_ACTION_LOG` → `{ ok, cleared }`.

## Trust boundary and token design

Approval authority lives in the executor closure inside the content
script of the exact tab/document — the same place the target node
lives. Challenges are stored in a private in-memory map there;
navigation destroys the context and every challenge with it, which is
what binds a challenge to its tab and document session structurally.

The panel never receives a token. **Approve once** sends only the
challenge ID over a dedicated message route. The content script
accepts approval, cancellation, gate control, and log access only
when browser-provided sender information proves the sender is the
side-panel document: `sender.id` equals the extension ID, `sender.tab`
is absent (tab/content-script senders always carry one), and
`sender.url` is exactly `chrome.runtime.getURL("sidepanel.html")`.
Page scripts cannot send runtime messages to a content script at all;
other extension pages (e.g. the microphone setup page) fail the URL
check; a service-worker relay would also fail it. Only the panel's
Approve/Cancel/Stop/Pause/Clear controls send these types — a voice
transcript saying "approve" is dispatched only as a show/hide-tags
command and can never reach this route.

Inside the executor, approving a challenge:

1. Checks existence, expiry (60 seconds, on an injectable clock;
   a challenge is valid only while `now() < expiresAt` — at the exact
   expiry instant it is already dead, and the deadline is rechecked
   again immediately before dispatch), prior consumption, gate state,
   and execution-busy state.
2. Marks the record consumed **before** any asynchronous work, so
   concurrent approvals cannot both run. A consumed action is never
   retried, even when its outcome is uncertain.
3. Re-runs the full Feature #8 pipeline for the *stored* request —
   session, baseline freshness, revision, original-node identity,
   visibility, effective disabled/readonly, sensitivity, and
   compatibility are all revalidated live, including immediately
   before dispatch. Approval never overrides a stale, replaced,
   disabled, incompatible, or sensitive target.
4. Verifies a private binding before dispatch: document session,
   snapshot revision and semantic hash, element ID, action, exact
   value, a target fingerprint, and a SHA-256 digest of the
   **effective submission**: the associated form's destination (`action`) and
   `method`/`enctype`/`target`, the submitter's override attributes
   (`formaction`, `formmethod`, `formenctype`, `formtarget`,
   `formnovalidate`), and every form-associated control — including
   controls associated from outside the form via the `form`
   attribute — with name, type, disabled, checked/selected, and value
   state, JSON-encoded without ambiguous concatenation. The semantic
   hash deliberately excludes raw values, so this digest exists to
   catch submission changes the hash cannot see (e.g. one filled
   password value swapped for another, a changed form destination, or
   a changed externally-associated hidden field). Only the digest is
   kept, only inside the closure — never in challenges, responses, or
   logs. A mismatch fails with `APPROVAL_INVALIDATED` and revokes the
   approval. Page-script interception that leaves no DOM trace (e.g.
   rewriting a `FormData` object inside a `formdata` event handler)
   cannot be bound this way and is a documented blind spot; what is
   bound is everything the DOM submission configuration states.

   Binding mechanics: the digest is Web Crypto SHA-256 over the
   JSON-encoded structured representation (an earlier 32-bit FNV
   digest was replaced: a page that can observe behavior could
   collision-search 32 bits, so it was not a sound sole comparison).
   Note on evidence: the specific colliding value pair reported
   during review was not independently reproduced under this
   codebase's serialization (the pair's digests differ here); the
   replacement rests on the primitive's weakness, and the regression
   test guards the behavior — a submission change after confirmation
   must invalidate approval — regardless of any particular pair.
   Hashing is asynchronous, so the ordering is explicit: the
   representation is serialized synchronously, hashed, then
   re-serialized and compared exactly (a change during the hashing
   wait invalidates), and the verified serialization is compared
   once more — synchronously, in the same run-to-completion block as
   the final revocation/expiry/generation checks — immediately
   before dispatch. After that final asynchronous verification, a
   complete synchronous final validation runs as the last block
   before activation — semantic freshness (`checkForChanges`),
   original-node resolution (identity and connectedness), visibility,
   effective disabled/readonly and sensitivity state, and action
   compatibility are all repeated, and nothing after that block
   awaits. Disabling, hiding, detaching, or replacing the target
   while the final hash was in flight is therefore rejected at
   dispatch instead of being activated. No unchecked wait remains
   between final validation and activation. If Web Crypto (or secure
   random for challenge IDs) is unavailable in the page context, consequential
   confirmation fails closed with `SECURE_BINDING_UNAVAILABLE`; no
   weaker hash or ID fallback is used. Non-secure page contexts
   without `crypto.subtle` therefore cannot confirm consequential
   actions in this milestone.

Executions are serialized: a second concurrent `execute()` is
rejected with `EXECUTION_BUSY`, never queued, so nothing can race
approval consumption.

## Panel behavior

The confirmation box shows the page URL, the action and target
name/ID, question context when known, the evidence-based consequence,
and the expiry. While a confirmation is pending, the reviewed request
is frozen: target/action/value controls and Execute are disabled, and
confirmation-required responses do **not** trigger the automatic
post-action snapshot refresh or any replay. Approve runs the stored
request (its response then gets the usual same-tab refresh); Cancel
revokes the challenge. Tab/document changes revoke the pending
challenge and discard late responses. Expired/stale/cancelled states
are shown as dead ends that require a fresh intentional Execute.

## Stop/Pause

Executor-level, not UI-only:

- **Stop** latches the gate closed, revokes all pending approvals,
  and is checked again immediately before dispatch, so an action
  stopped during its pre-dispatch wait never activates. The panel's
  Stop also terminates active recognition and speech (distinct from
  "Stop listening"), so no late transcript can start a command.
- **Pause** blocks new execution (`EXECUTION_PAUSED`) and cancels
  pending approvals. **Resume** only reopens admission; it replays
  nothing — paused/stopped/revoked requests stay dead.
- Cancellation is **operation-scoped**: Stop and Pause bump a
  monotonic cancellation generation, and every admitted operation
  captures it at admission. Immediately before dispatch, an operation
  whose generation no longer matches fails with
  `EXECUTION_CANCELLED` — even if Resume has since reopened the gate.
  Resume admits new requests only; it cannot revive undispatched
  work. (Requests admitted while the gate is closed still report
  `EXECUTION_STOPPED`/`EXECUTION_PAUSED`; `EXECUTION_CANCELLED` is
  specifically "admitted, then cancelled in flight.")
- Cancelling a challenge whose approval was already consumed but not
  yet dispatched revokes the in-flight grant itself
  (`APPROVAL_CANCELLED` at the pre-dispatch check); removing the
  pending record alone would not suffice. The dispatch boundary is
  marked explicitly on the grant at the moment of activation: a
  cancellation arriving after it returns
  `{ cancelled: false, dispatched: true }`, logs
  `approval-cancel-too-late` (never `approval-cancelled`), and the
  panel states it was too late to recall the action — including the
  tab-switch wording, which no longer implies a dispatched action
  never ran. Outcome-unknown transport handling is unchanged.
- An action already dispatched when Stop lands may finish on the
  page and generally cannot be undone; results keep the honest
  dispatched-vs-verified distinction.

There is no plan runner yet. The gate contract is what a future
sequential runner consumes: run a step through `execute()`, stop the
run on any non-ok outcome (a confirmation challenge halts for a
human), and check gate state between steps. The automated tests
demonstrate exactly this with a small handwritten sequential harness.

## Action log and privacy

In-memory, bounded to the last 100 entries per document. Each entry
is exactly `{ timestamp, source, action, elementId, targetName,
decision, approved }` — decisions include confirmation-required,
approved, approval-cancelled/expired/consumed/invalidated,
blocked/stale error codes, stopped/paused, gate transitions, and
dispatched-unverified vs verified outcomes. The panel renders the log
as text with Refresh and Clear controls.

Never logged or returned: raw request values, protected field values,
transcripts, challenge IDs in log entries, or any token (none crosses
a boundary). Snapshots, reads, challenges, responses, and logs reuse
the central redaction; serialized prospective MCP/proxy payloads are
tested to contain no protected values. Page-controlled strings enter
the log only as accessible target names rendered as text, and error
reporting logs codes rather than raw messages.

## Limitations

- Consequential classification remains heuristic (native submit
  semantics plus label patterns). It is not comprehensive intent
  detection; a consequential control with an innocuous label and no
  submit semantics can pass, and a benign "Remove from list" can be
  held. Fail-closed applies to what is classified.
- The private SHA-256 binding covers DOM-observable submission data;
  it never leaves the content-script closure and cannot establish what
  arbitrary page code will do with that data after activation.
- Sender verification trusts the side-panel document. Anything that
  can already execute script in that document is inside the trust
  boundary by definition; page content is always outside it.
- `source` attribution is unauthenticated for future transports and
  must never become an authorization input.
- Stop cannot recall events already dispatched to the page.
- Headed local-fixture acceptance passed on 2026-10-28: confirmation,
  keyboard approval via Tab/Enter, Delete cancellation with a matching log
  entry, Pause blocking and Resume no-replay, Stop/Resume no-replay, and
  stale approval after manually changing a field (STALE_SNAPSHOT).
  The Product Owner confirmed these results; the full suite passed 120/120
  during independent review. Timing-sensitive expiry/replay/race cases
  have automated rather than separate headed evidence. Live Google Forms,
  Marketplace, and other real consequential targets were not used.

The log's approved flag records the human decision, not successful
activation: STALE_SNAPSHOT with approved:true is a rejected approved
attempt. Issue #29 should distinguish these concepts more clearly.
