# Feature #14 — Muse Spark planner via planner-proxy

Status: **complete and accepted — Product Owner confirmed the full canonical
Act 1 script typed then spoken on the corrected implementation, 2026-10-31.
Speech recognition remains imperfect and requires clear pronunciation.**
Automated plumbing evidence below uses a stub upstream; genuine-model
evidence is separately identified and human-reported.

Baseline: `30dae2b`. The Product Owner authorized definition of the canonical
four-sentence Act 1 reference on 2026-10-31. It is now defined in
`docs/act-1-demo-script.md`; the Product Owner subsequently confirmed its
complete ordered typed and spoken runs passed. Earlier headed smoke results
are separate evidence.

## Architecture and trust boundaries

```
typed / final voice transcript
  → fast path (#13: show/hide/click/fill, zero network) — unchanged
  → anything else → side panel prunes the snapshot (~60 elements)
    → POST { transcript, pruned snapshot, context } to 127.0.0.1:6124
      → planner proxy validates, calls Meta Chat Completions once
        (+ at most one repair), validates the plan
    → panel re-validates against the LIVE snapshot
      → steps run sequentially through runExecutionPipeline
```

- `MODEL_API_KEY` lives ONLY in the proxy process (env). It never
  appears in the extension, repository, screenshots, logs, or errors.
- Proxy binds loopback only; the upstream destination is fixed
  server-side. Callers authenticate with a runtime pairing token
  (Bearer, timing-safe compare); the `chrome-extension://` origin
  check is defense-in-depth, not authentication. Chrome omits Origin
  on extension GETs, so an absent origin proceeds to the mandatory
  token check; an explicitly foreign origin is still rejected.
- The proxy PLANS ONLY. It cannot click, fill, approve, or reach the
  page. Every step runs through the existing executor, live target
  validation, and the human-confirmation gate.
- Model output is never execution authority: schema + semantic
  validation in the proxy, defensive re-validation in the panel
  against current ids, per-step identity/meaning rechecks, and the
  executor's own guards all stand between a plan and the page.

## API, model, protocol

Verified against the official docs (fetched 2026-10-30):

- https://dev.meta.ai/docs/protocols/chat-completions
- https://dev.meta.ai/docs/structured-output

**Chat Completions** (`POST https://api.meta.ai/v1/chat/completions`,
OpenAI-compatible) was chosen over Responses: planner calls are
single-shot turns with no reasoning continuity or tool loops, which the
docs call out as the Chat Completions case. Structured output uses
`response_format: { type: "json_schema", json_schema: { name:
"SeeyablePlan", schema } }` (constrained decoding); generated text is
read at `choices[0].message.content`, non-streaming. No Responses
parameters are mixed in. Auth is `Bearer $MODEL_API_KEY`.

Model: `muse-spark-1.3` default, explicit and configurable via
`SEEYABLE_MODEL`. No silent substitution; `/v1/status` and the panel
pairing check report the configured model. `reasoning_effort` and
temperature are left at server defaults (deliberately unset, not tuned).

## Plan schema (`packages/shared/plan-schema.js`)

Single source of truth; the extension loads a byte-identical mirror at
`apps/extension/lib/plan-schema.js` (MV3 cannot load outside its root),
with a sync test failing loudly on drift.

- `version: "seeyable-plan-1"`, `outcome: steps | clarify | unsupported`.
- `steps[1..20]`: `{ action: click|fill|select|check|uncheck,
  elementId: el-N, value?, note? }`. Values required for fill/select
  (non-empty for select), forbidden otherwise, capped at 2000 chars.
  `scroll_to`/`read` are excluded: the executor scrolls targets itself,
  and plans act rather than read.
- `clarify`: `{ question, action?, value?, choices[1..12]? }`. Choices
  share one top-level action and reuse the existing clarification UI
  and single-action dispatch; a bare question asks with zero execution.
- `unsupported`: `{ reason }` — an explicit no-plan outcome, never
  forced steps.
- Optional `say` (≤280 chars): one short status line, spoken only via
  the existing user-toggled speech output. The developer prompt forbids
  page content, values, and reasoning in it.
- `additionalProperties: false` everywhere: approval flags, tokens,
  selectors, URLs, and any unknown field are rejected.

Validation is shape AND semantics: every id must exist in the exact
element list supplied (pruned snapshot at the proxy, live snapshot in
the panel). Unknown ids, actions, oversized plans, and malformed output
are rejected — never retargeted or substituted. Select steps are
additionally checked against the model-visible choices: the value must
match exactly one listed option value (`UNKNOWN_OPTION`), that option
must be enabled (`OPTION_DISABLED`), and its visible label must be
unambiguous (`AMBIGUOUS_OPTION`, including duplicate values). Elements
without option metadata skip the option checks; the executor's live
exact-value check stays final. Error details name locations, never
values.

## Repair policy: one attempt, then ask

On invalid model output (unparseable JSON, shape failure, or semantic
failure), the proxy makes at most ONE repair call with the same
snapshot plus bounded validation feedback (codes and step locations,
no values; the invalid output itself is not re-sent). If the repair is
still invalid, the proxy returns `PLAN_INVALID` and the panel asks the
user to rephrase or pick a target manually. No retries beyond one, no
silent substitution. Upstream calls carry a 20 s timeout each; the
panel fetch times out at 55 s and is also aborted on cancel, tab
change, newer commands, Stop, or Pause.

## Pruning policy (`lib/planner.js`)

Deterministic projection of a production schema-v2 snapshot:

- Keeps: stable `id`, `role`, `name`, `nameSource`, `question`,
  `questionCertain`, `tag`, `actionable`, and redacted state
  (`checked/selected/disabled/expanded/pressed/required/readonly/
  invalid`, plus `filled` derived WITHOUT the text). Native-select
  `options` travel bounded: at most 50 choices per select as
  `{ label, value, disabled? }`, labels clipped to 80 chars, values
  NEVER clipped (exactness is dispatch authority); beyond-cap choices
  are counted in `optionsOmitted` and are unavailable to the planner.
- Drops: raw DOM, `cssPath`, `rect`, and every raw `value` (page text
  and selected-option text alike). Engine-redacted (sensitive) fields
  keep only `redacted` + `filled` and expose no options.
- Selection: interactive elements ONLY — heading/landmark structural
  metadata is excluded (question context already carries the semantics).
  Actionable elements first (snapshot order), then other interactive
  elements (disabled/readonly: visible so the model sees they are
  unavailable, never preferred). Cap: 60 elements; the remainder is
  reported as `truncated: { omitted: N }` and the model is instructed
  that omitted ids cannot be referenced.
- Binding: `documentSessionId` + `revision` travel with the projection
  and are echoed back; a binding mismatch in the panel rejects the plan.

Page labels and values are UNTRUSTED DATA, stated in the fixed
server-side developer prompt: they cannot change the rules, grant
approval, or authorize anything. Fill values may come only from the
user's own words, copied verbatim. Select values are the one
exception: a `select` step MUST use the EXACT `value` string of one
of the target's listed `options`, chosen by matching the visible
label the user named — never lowercased, trimmed, re-spelled, or
guessed, with truncated-away options unavailable. Unclear verbs or
mangled transcripts (including feel/Phil-style misrecognitions) must
clarify, never guess a mutating step.

## Execution lifecycle (panel)

1. Fast path first: #13 grammar stays local with zero proxy calls
   (proven by test). Corrections stay local too.
2. Anything else captures tab/document identity, acquires a fresh
   snapshot under the existing locks, prunes, and POSTs with the
   pairing token. Unpaired → the old help text plus a pairing hint,
   with zero tab messages.
3. The plan is re-validated against the live snapshot; binding must
   match; invented ids fail closed with zero dispatches.
4. Steps run SEQUENTIALLY through `runExecutionPipeline` (same
   contract, confirmation controller, refresh, log fetch). After every
   step the panel re-snapshots and revalidates the next target's
   identity AND meaning (name/role/question) against current state,
   using the current revision. Stop conditions: failure, unverified
   outcome, vanished/changed target, transport loss, or ownership
   change. Partial progress is reported honestly ("Completed 1 of 3
   first: …").
5. A consequential step enters the existing human-confirmation gate and
   the sequence STOPS there: the human decides on that step alone;
   later steps are dropped, never auto-continued; approval runs one
   action and replays nothing. Cancellation/rejection stops
   continuation.
6. Newly appeared conditional targets absent from the planned snapshot
   stop the sequence with an explicit message — a fresh command
   re-plans; ids are never invented mid-run.
7. Select steps revalidate against CURRENT dropdown choices
   immediately before dispatch: a vanished, disabled, or ambiguous
   choice — or any option-list change since planning — stops the
   sequence with a planning-level explanation and runs no later
   steps. The executor's live exact-value check stays final.
8. Ownership: `commandPending` spans model request + all steps;
   gen/seq rechecks precede every fetch and every dispatch; late model
   responses after cancel/tab-change/Pause/Stop are discarded (the
   fetch is also aborted); Resume revives nothing; no queues, no
   replays. A discarded command replaces obsolete main-status
   planning/progress text ("Planning…", "Step N of M…") with the
   discard outcome on #status alone — never a success claim, never a
   "nothing executed" claim when a step may have reached the page —
   while #voiceState reports microphone lifecycle only; the chip
   shows Paused while the gate is closed.

Spoken feedback follows existing rules (page acknowledgment first,
microphone terminated, user toggle). Completion is announced only for
verified steps — never for plan generation or mere dispatch.

## Cached corrections ("no, the other one")

After any validated clarification choice runs (completed or held), the
panel caches the round's remaining alternatives with their originating
request, tab, document, value, labels, and interaction identity —
single use. The exact phrases `no, the other one` / `the other one`
(plus two `not that one` variants; exact normalized match only, never
substring) resolve LOCALLY: one unambiguous cached alternative
executes through the pipeline at the current revision; several present
accessible choices; none/stale falls through to the planner as an
ordinary request. The cache dies on any newer command, tab/document
change, cancellation, or Pause/Stop. Corrections never undo a
completed action or replay a sequence; the message states what the
earlier choice did ("Earlier choice … completed and verified;
Alternative …: …").

## Conversation context

Each acting command appends one bounded `{ summary ≤300, outcome ≤200 }`
entry to a document-scoped, in-memory list (max 4, oldest dropped).
Summaries are built from separated structure — parsed action plus
target label for fast-path commands, validated step actions plus
target names for plans, choice counts for clarification — and NEVER
from raw transcripts: values can hide anywhere in free text, so no
regex stripping is attempted, and the proxy rejects any history entry
carrying a `transcript` field. This concerns retained history only;
the CURRENT request's transcript is sent verbatim because the user
explicitly issued it for planning. Context travels only to the paired
proxy, is never logged, and resets on tab/document change.

## Canonical Act 1 acceptance script

See `docs/act-1-demo-script.md` for the agreed four sentences, reset steps,
expected results, and evidence rules. Defined on 2026-10-31; it replaces
the earlier provisional demonstration script and does not claim future
#15 features. First exact-script run (Product Owner, genuine model):
sentence 1 (multi-field fill) PASS, sentence 2 (dropdown + toggles +
digest) FAIL at step 1 — the plan carried a non-value for the Your-role
dropdown and the executor honestly returned OPTION_NOT_FOUND with
nothing executed — sentence 3 (bio replacement) PASS, sentence 4
(Submit held and cancelled) PASS. Recorded as PARTIALLY PASSED, not
complete. The sentence-2 cause (no option metadata in the planner
projection, plus a prompt rule demanding verbatim select values) is
corrected in this change; the Product Owner will rerun sentence 2
against the genuine model. That rerun has now PASSED: the Product Owner
reported "Completed 4 steps, all verified: Your role; Email updates;
SMS updates; Monthly digest." Thus all four sentences have individually
passed, across the first run and retry. The Product Owner subsequently
confirmed the complete ordered script passed typed then spoken on the
corrected implementation. Issue #14 is accepted as of 2026-10-31. Voice
recognition remains imperfect; clear pronunciation is needed for the demo.

## Verification

- `npm --prefix packages/shared test` — 11/11 (contract + mirror sync +
  select option checks: exact mapping, unlisted/disabled/ambiguous
  rejection, executor-deferral without metadata).
- `npm --prefix apps/planner-proxy test` — 15/15 (auth, limits,
  one-repair-then-stop, timeouts, safe errors, raw-history rejection,
  stalled-body deadline, disconnect-aborts-upstream, absent-Origin
  token enforcement, upstream status categories, select UNKNOWN_OPTION
  repair; stub upstream).
- `npm --prefix apps/extension test` — 231/231 (190 prior + 33
  planner + 8 select-options: prune/redaction/cap, client
  auth/timeout/codes, correction exactness, context bounds, fast-path
  zero-call, unpaired help, sequential fresh revisions,
  failure/unverified/vanished/renamed stops, held + single approval,
  invented-id rejection, planner clarify/unsupported, cancel/tab/pause
  invalidation of slow models, cached correction + multi-choice +
  stale fall-through, pairing UI, context travel/reset, mangled-verb ask-not-guess, value-free history, body-deadline/cancel classification, cancel-during-body lock release, status auth-vs-connection errors, upstream status diagnostics, pause-discard status/chip, resume-no-replay, obsolete-after-resume ownership, engine option capture + redaction + hash invalidation, prune option bounds/omission, exact-value panel dispatch, changed/vanished/disabled/ambiguous option stops).
- `npm --prefix apps/mcp-server test` — 11/11 (untouched).
- Stub-model headless E2E (`/tmp/spike-run/planner-e2e.mjs`, 13/13):
  real proxy + real extension + scripted upstream. Two-step plan
  verified with values on the page and out of panel text; upstream
  received model + `json_schema` + developer prompt + 20-element
  pruned snapshot with binding and no locators/geometry/values;
  invented-id plan rejected after exactly one repair; submit step
  held with the card visible and the form unsubmitted; proxy stderr
  carried no transcripts/values (token printed exactly once, by
  design). Screenshot: `/tmp/spike-run/plain-evidence/planner-stub-panel.png`
  (post-run Safety state). THIS IS NOT LIVE-AI EVIDENCE.
- Genuine-model headed smoke checks: Product Owner confirmed on 2026-10-31.
  Typed two-field fill (Ada Lovelace / Engineer), typed Nickname Pioneer +
  Submit held and cancelled, and spoken two-field fill (Grace Hopper /
  scientist) passed on the demo survey. Pause during planning discarded
  the command; final presentation retest replaced Planning with the single
  main-status discard outcome; Resume restored availability with no late
  field changes or replay. Local Email/SMS clarification and cached correction
  also passed, but are local-path rather than additional AI-planning evidence.
  Key configured only in the proxy; no credential is recorded here.
  The full canonical Act 1 ordered typed and spoken runs subsequently
  passed, as confirmed by the Product Owner. See the acceptance-script
  section for the earlier dropdown failure and correction.

## Planning latency diagnostics (Issue #30 follow-up)

The Product Owner reported roughly a minute between finishing speech
and a plan preview, with “Planning…” visible. Content-free timing
diagnostics now separate the stages; they log only durations, counts,
and error codes — never transcripts, values, snapshot content, keys, or
tokens.

Panel (side-panel DevTools console), one id per command:

```text
[seeyable-timing] id=cmd-N source=voice stage=stop-to-final ms=…
[seeyable-timing] id=cmd-N source=… stage=snapshot ms=…
[seeyable-timing] id=cmd-N source=… stage=request-sent ms=0 elements=… approxBytes=…
[seeyable-timing] id=cmd-N source=… stage=proxy-response ms=…
[seeyable-timing] id=cmd-N source=… stage=panel-validation ms=… ok=true
[seeyable-timing] id=cmd-N source=… stage=preview-rendered ms=… totalMs=…
```

Proxy (its stderr/terminal), correlated by the same id (sent as the
`X-Seeyable-Timing-Id` header; the proxy's own `#N` is also present):

```text
[planner-proxy] #N timing=cmd-N plan receipt ms=… bodyBytes=… elements=…
[planner-proxy] #N timing=cmd-N upstream call=1 headersMs=… bodyMs=… totalMs=… ok=true
[planner-proxy] #N timing=cmd-N validate call=1 ms=… ok=true codes=-
[planner-proxy] #N timing=cmd-N repair call=2 reason=…        (only if call 1 was invalid)
[planner-proxy] #N timing=cmd-N upstream call=2 …              (the repair call)
[planner-proxy] #N timing=cmd-N upstream failure code=… status=… ms=…  (failures)
```

What the stages isolate:

- `stop-to-final`: Stop listening → final transcript (Meta
  transcription upload + upstream, or browser recognition). Typed
  commands have no such line.
- `snapshot`: the mandatory fresh snapshot. `plan receipt`: panel →
  proxy delivery and body read. `upstream call=k`: one model call,
  split into time-to-headers and full-body consumption. `validate`:
  schema/semantic validation. A `repair call=2` line means the first
  plan was invalid and a second model call was made. `proxy-response`:
  panel send → full response consumed. `preview-rendered`: response →
  preview on screen.

Known structural facts (measured with stubs, not live): request and
validation overhead are sub-millisecond-to-milliseconds at demo scale;
each upstream call dominates in the stub experiment. A repair adds a
second model call; its duration need not equal the first. Two calls near
the 20 s limit total roughly 40 s, below the panel's 55 s request budget.
Transcription precedes that panel request and does not consume its timeout.
Do not attribute a minute-long wait or a panel timeout to repair without
the correlated live timings.

Product Owner-supplied live logs subsequently showed successful two-step
plans at 5,122 ms and 7,243 ms without repair, and a separate initial
model call timing out at 20,005 ms before response headers. Speech calls
were separately reported at 3,943 ms and 1,583 ms. These observations
establish variable upstream latency, not a proven root cause or a latency
guarantee; none showed a repair call.

No bottleneck was changed on stub evidence alone: timeouts were not
raised, fresh snapshots and validation/preview were not weakened, and
the model was not changed. If live lines show frequent repairs, the
follow-up decision (repair policy, prompt/schema tightening, or model
timeout budget) belongs to the Product Owner with those numbers.

### Headed rerun (Product Owner)

Use the demo survey, same small two-field request typed and spoken:
“Put Grace Hopper in Full name and Scientist in Short bio.”

1. Start the proxy in a terminal so its stderr stays visible. Reload
   the extension. Open the side panel's DevTools console.
2. Typed: send the request. Copy the `[seeyable-timing]` panel lines
   and the proxy lines with the same `timing=cmd-N`.
3. Spoken: Start listening, say the same sentence, Stop. Copy the same
   lines (they include `stop-to-final`).
4. Note whether a `repair call=2` line appears, each
   `upstream call totalMs`, and the `stop-to-final ms`. Share only
   those lines — they contain no request content by construction.

## Limitations and disagreements

- Genuine-model smoke checks passed as reported above, but broader plan
  quality, measured latency, and live repair behavior remain unverified.
  Web Speech initially mangled the voice request; clearer pronunciation
  succeeded. Automated mock suites remain plumbing/guard evidence.
- `say` speaks model-generated text through the existing toggle. It is
  length-capped, constrained by the developer prompt to brief status,
  and always shown visibly first — but a compromised or confused model
  could still utter odd status lines. It cannot exfiltrate or execute.
- Held steps end the sequence rather than suspending it: after the
  human decides, remaining steps require a fresh command. Auto-
  continuation would execute beyond a single-action approval; the
  re-issue cost is the safer trade.
- Planner clarify resolves one action and ends; multi-step ambiguity
  mid-plan is not continued automatically.
- Voice "fill" misrecognition (feel/Phil) is unchanged; the planner
  asks rather than guesses on unclear verbs, but reliable voice fill
  is still not established.
- Plan preview/editing, voice approval, and undo were added by #15
  (`docs/features/feature-15-plan-review-undo.md`): validated step plans
  now wait for review instead of running at once, and model clarification
  choices enter review. Step execution after approval is this pipeline,
  unchanged.
  No #29 styling work was done.

## Capacity experiment checkpoint — 2026-11-04

The owner confirmed the larger request worked after reloading the
extension, resolving the reported panel SCHEMA rejection in that rerun,
and approved the current build for demo use. Exact generated action count,
request coverage, and per-step outcomes were not provided. This is an
owner-reported larger-request pass, not evidence of a complete 20-step
live run or guaranteed omission-free planning. The 20-step contract and
12-distinct-target runner are separately covered by automated tests.
Latency remains variable; no timeout increase or performance fix is claimed.
