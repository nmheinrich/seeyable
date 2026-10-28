# Feature 9 — Manual Execution Test Panel

A minimal side-panel debugging harness: snapshot → choose a target by
its stable number → choose one executor action → execute once → inspect
the real executor response and the refreshed snapshot. It is an
engineering test interface, not the consumer UI, and it performs no
page actions itself — every action goes through the existing
`SEEYABLE_EXECUTE_ACTION` executor contract (Feature #8).

## Behavior

- **Targets** come only from the displayed DOM/ARIA snapshot. Each
  option shows the stable number (parsed from `el-N`), the accessible
  name (or role fallback), question context when present, an
  uncertainty marker (`?`) for proximity-inferred questions, and
  `(disabled)` / `(readonly)` markers. Page-derived strings are
  rendered as text, never HTML. Field values never appear in labels.
- **Actions**: `click`, `fill`, `select`, `check`, `uncheck`,
  `scroll_to`, `read`. The value input is enabled only for `fill` and
  `select`; for `select`, enter the exact native option value (no
  label guessing). Empty-string fill is supported.
- **Results** render in a dedicated execution-result area, separate
  from the snapshot JSON (which stays available for copy/download):
  the real response, failure codes and messages, diffs (including
  diffs returned after failed outcomes), missing-diff explanations,
  and outcome wording that distinguishes verified completion from
  dispatched-but-unverified and already-in-desired-state. A transport
  failure is reported as outcome-unknown, never as "nothing happened".
- **Pending**: while an action runs, execution and conflicting
  controls are disabled; rapid clicks or keyboard re-activation cannot
  dispatch twice. Nothing is queued or retried automatically — after a
  stale failure, a human must intentionally click Execute again.

## State ownership

Execution is bound to one captured tab ID plus the displayed
snapshot's `documentSessionId` and `revision`:

- Every operation captures its tab at start and owns an operation
  sequence number from that moment — including initial snapshots and
  Show-tags acquisition, before anything is bound and retained until
  the complete multi-stage acquisition settles. No step re-queries
  a possibly different active tab mid-flight, and superseded
  operations cannot overwrite newer state. Snapshot acquisition and
  execution are mutually exclusive (no queue): Execute is disabled
  and refuses while an acquisition owns the panel, and acquisition
  refuses while an execution (including its post-action refresh) is
  pending, so an older refresh can never overwrite post-action state.
- Tab switches and navigation/reload invalidate in-flight operations
  at any stage (generation counter), clear the entered value, and
  disable execution. A late response from another tab/document is
  discarded and cannot overwrite current state or authorize anything.
  An action already sent may still finish on the page; the panel
  reports that honestly instead of claiming it was cancelled.
- The target selector has an explicit unselected placeholder. A
  selection survives a refresh only when the same ID exists in the
  same document session; otherwise nothing is selected, the entered
  value is cleared, and Execute stays disabled until a person
  deliberately selects a target. The browser's default first option
  is never a substitute.
- Execution (including result processing and the post-action
  refresh) holds one lock: Execute and conflicting snapshot/binding
  controls stay disabled until the refresh settles, and the lock is
  released on success, failure, or invalidation. A failed snapshot
  refresh never leaves the previous snapshot execution-ready.
- After each completed executor response, the panel fetches a fresh
  snapshot from the same captured tab and preserves the selection only
  if the same ID still exists in the same document session (a
  similarly named replacement is never substituted). The execution
  result is preserved independently; if the refresh fails, the result
  stays readable, the snapshot is marked unavailable, and execution
  stays disabled until a fresh snapshot succeeds.
- A snapshot obtained through the scripting fallback (missing
  content-script receiver) is viewable but explicitly
  execution-disabled, with reload/reopen guidance. Execution readiness
  requires the full content-script handler.
- Entered values are transient: never persisted, never logged, cleared
  when the target or document session changes, and absent from
  copy/download output (which contains only snapshot JSON).

## Safety limits (unchanged executor boundary)

Consequential activation (submit/pay/delete/send/publish and native
submit semantics) remains blocked inside the executor until the later
safety-gate feature; sensitive writes remain blocked; reads and
snapshots remain redacted; stale references fail closed. The panel
adds no confirmation buttons, approval flags, unsafe mode, or direct
form submission. Supported demo-survey operations from the panel are
therefore the non-sensitive, non-consequential subset: text fills,
native select, checkbox/radio, read, and scroll. The survey's Submit
demonstrates the executor block, its password field rejects writes,
and its numeric rating input rejects `fill` (unsupported type) —
these are honest executor restrictions, not panel gaps.

## Verification

Automated: `npm --prefix apps/extension test` includes
`tests/panel.test.mjs` (mocked Chrome messaging; snapshot-backed
selection with exact payload, empty-string fill, duplicate-dispatch
prevention, structured result retention across refresh, stale failure
without retry, conditional targets appearing/disappearing, tab-change
and late-response handling, missing receiver, refresh failure, safe
text rendering, and no value persistence/logging).

Manual/headed steps: load the standard extension, serve `apps/` over
HTTP, open the demo survey, take a snapshot, and from the panel —
fill Full name, select a role by exact value, check SMS updates,
read the Account PIN (redacted), scroll to Short bio, and attempt
Submit (expect `CONSEQUENTIAL_BLOCKED`). Then open
`tests/fixtures/executor-form.html` and repeat: controlled-input fill
(mirror updates), a Likert check, conditional reveal then fill of the
revealed field, one harmless click (counter shows exactly 1), and
scroll_to the deep field. Switch tabs mid-flow and confirm the
selection is discarded. Test only non-consequential checkbox/radio/text
operations on a disposable Google Form and never submit.

Acceptance evidence (2026-10-28): independent full suite 57/57 passing.
The Product Owner confirmed headed fixture checks for controlled fill,
conditional reveal/fill, keyboard-only single activation, tab switching,
blocked Submit, redacted read, nested scroll, and reload recovery. The
snapshot-context regression was corrected and the Password question
spot-check passed. Live Google Forms question associations were reviewed;
the Product Owner confirmed checkbox, radio, and synthetic text-fill
operations through the panel. These checks do not establish universal
Google Forms widget compatibility. Original demo-survey panel evidence
remains headless; see docs/status.md for evidence boundaries.
