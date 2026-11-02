# Feature #15 — Plan preview, confirmation, and undo

Status: **complete and accepted for the core mouse-free workflow — Product
Owner confirmed genuine-microphone and genuine Muse Spark acceptance on
2026-10-31. Speech recognition remains imperfect; supplementary headed safety
probes below are not claimed.** Baseline: `d3c53b4`. No #29 visual refinement
was done; the review card reuses existing Plain Words classes.

Issue requirement: plan preview card with plain-English steps; Approve /
Edit / Cancel by click or voice; previous values stored before execution
so fill/select/check can be undone. Done when, in one mouse-free run, a
deliberate mis-speak is repaired by voice and a fill is undone.

## What changed

| File | Change |
|---|---|
| `apps/extension/lib/executor.js` | Private single undo record: live capture immediately before dispatch, barrier on non-reversible/uncertain changes, `undoLastChange()` with full revalidation, serialization, gate, events, and final verification. |
| `apps/extension/content.js` | `SEEYABLE_UNDO_LAST`, accepted only from the trusted side-panel sender (same check as approval). |
| `apps/extension/lib/voice-commands.js` | `resolveReviewCommand()`: exact review phrases and the anchored `Edit plan: <request>` form. |
| `apps/extension/sidepanel.js` | Pending-plan review state, deterministic step rendering, binding/approval/edit/cancel, voice review authority, “Approve this action” route, undo dispatch, shared outcome presentation. |
| `apps/extension/sidepanel.html`, `sidepanel.css` | Review card and labelled edit field inside the commands card; one copy line; small list/button rules using existing tokens. |
| `apps/extension/tests/undo.test.mjs` (new), `tests/plan-review.test.mjs` (new), `tests/voice.test.mjs`, `tests/planner.test.mjs`, `package.json` | New regressions; 12 existing planner tests now approve the preview before asserting execution (their intent is unchanged). |

## State and ownership

```
request ─▶ planner (bounded request/repair, unchanged)
        ─▶ validated against the live snapshot (unchanged)
        ─▶ pendingPlan  (frozen; commandPending RELEASED)
              ├─ Approve ─▶ fresh live snapshot; same session + revision + hash?
              │             └─ yes: runPlanSteps (shared pipeline, unchanged)
              │             └─ no:  "page changed after you reviewed" — nothing runs
              ├─ Edit    ─▶ preview invalidated now ─▶ replacement request
              │             ─▶ ALWAYS planned (never fast-pathed) ─▶ new preview
              └─ Cancel / newer request / tab or document change /
                 Pause / Stop / Cancel listening / panel unload ─▶ discarded
```

- `pendingPlan` is one frozen object: plan, pruned snapshot, request text,
  tab, document session, revision, semantic hash, generation, and
  interaction sequence. Approve/Edit/Cancel are reassigned per preview and
  close over that object; an obsolete handle finds it is no longer current
  and does nothing (and never overwrites a newer preview's status).
- Waiting for review is its own state. The network/operation lock is
  released so the review controls work; manual Execute stays disabled; any
  newer command supersedes (and says “The earlier plan was discarded.”).
- Approval consumes the preview first (single use), starts a new
  interaction, re-reads the live page, and requires the reviewed session,
  revision, and hash. Per-step identity/meaning and dropdown rechecks
  from #14 still run before every step. No silent replan, no substitution.
- Rendering is deterministic from the validated plan: `Fill “Full name”
  with “Grace Hopper”`, `Choose “Designer” in “Your role”`, `Turn on/off`,
  `Select` (radio), `Click`. Labels and values are set via `textContent`.
  Protected targets show “a protected value (hidden)”; values over 160
  characters are clipped with their total length. Model `say` text is
  never shown in the review and never spoken for it.
- Model clarifications: choosing a target from a **model** clarification
  produces a one-step preview instead of executing, because the action and
  value came from the model. The preview carries that round's validated
  alternatives (ids, labels, action, value, chosen id). Once the preview is
  approved and its step attempted (completed, held, or failed — not a
  refused approval), the remaining alternatives are cached exactly like a
  local choice: bound to tab, document, and the approval's interaction,
  single use. “No, the other one” then needs **no model call**: one
  remaining alternative becomes a **new preview** (never execution);
  several are offered as choices whose resolution again enters review.
  The correction itself does not re-cache (same as local). Any newer
  command, tab/document change, Cancel listening, Pause/Stop, or a choice
  preview cancelled before approval leaves nothing to correct; stale
  entries fall through to an ordinary planner request. Local (#13)
  clarifications and corrections are unchanged (they execute directly).
- Planning reads the live page first (fresh snapshot), as do model-derived
  corrections, so a preview is never bound to a revision older than the
  page the person is looking at. (Found in the headless browser run: a
  manual edit between commands made the next preview unapprovable.)
- Context: the preview records one value-free entry (“previewed; awaiting
  review”); approval records the execution outcome; cancel records
  “cancelled at review”.

## Voice and trust boundaries

Local, zero-model phrases (exact normalized match — case, whitespace, and
trailing punctuation only — never substring, fuzzy, or model-interpreted):

- **Plan approval:** “approve plan”, “approve the plan”, “approved plan”,
  “approved the plan”, “approve”, “approved”, “go ahead”. The “approved…”
  and short forms were added after the headed run, where Web Speech heard
  “Approve plan” as “approved plan”. They approve the PLAN only.
- “Cancel plan”, “Undo last change” (plus “the” variants), “Approve this
  action” (consequential challenge only), and “Edit plan: <complete
  replacement request>”
(anchored; spoken form without a colon accepted; trailing punctuation kept
because it may belong to a dictated value). “Edit plan” uses the existing
planner request/repair path and only ever yields a new preview.

- **Approval-like but unsupported wording keeps the plan.** While a plan is
  under review, speech or typed text that mentions approval or “go ahead”
  but is not an exact phrase above — “do not approve”, “not approved”,
  “approve later”, “go ahead and submit”, “approved plan and delete” —
  executes nothing, is not sent to the planner, keeps the very same
  preview, and explains the supported choices. This detector
  (`isApprovalLike`) is separate from, and never consulted by,
  authorization. Ordinary requests still supersede the preview, and
  Edit/Cancel work as before. With no plan displayed, such text follows the
  normal request path.
- **Plan approval by voice** (every alias) is accepted only from the final result of the
  active recognition session that the user started with Start listening
  **while that exact plan was displayed**, once per session, and not while
  synthesized speech is playing. Starting a session already silences
  speech, and spoken feedback is held until the microphone closes
  (unchanged), so feedback cannot be transcribed. Spoken feedback never
  contains a review phrase. Typed “approve plan” in the panel's own input
  is also accepted (it is the human at the panel, like the button).
- **Consequential approval stays separate.** Approving a plan never sends
  `SEEYABLE_APPROVE_CHALLENGE`; the executor still holds Submit/Pay/
  Delete/Send/Publish and the sequence ends at the held step. “Approve this
  action” is accepted **only by voice**, only from a session started while
  that exact challenge was shown, and calls the same `approveHeldChallenge`
  path as the Approve once button — the executor's expiry, fingerprint
  binding, atomic consumption, and final-dispatch validation are reused
  untouched. Typed “approve this action” is refused (smallest authority
  surface: the button already exists). No plan-approval alias (“approve”,
  “approved”, “go ahead”, …) ever approves a challenge: with only a
  challenge displayed they answer “No plan is waiting for review. Nothing
  was approved.” and send no approval message. Approval runs one action; later steps never resume.
- Page content and model output cannot supply approval: phrases are matched
  on the user's own transcript before any planning, and edit replacements
  are planned into a preview, never executed.
- No new MCP tools. The undo route is trusted-panel-only.

## Undo storage, restoration, and invalidation

- **Storage:** at most one record, in the executor closure for this
  document. Captured from the live node immediately before dispatch, after
  final validation: full `value` (fill); for a dropdown the selected
  `<option>` node **plus its index, value, label, and text at that moment**,
  the select mode, and the whole choice list's structure (each option's
  group, value, label, text) — immutable copies, so mutating an option node
  later cannot rewrite history; `checked` (checkbox); every native radio
  group member's `checked` plus the group's meaning (each member's name,
  value, accessible name); or `aria-checked` (ARIA switch/checkbox). Never from snapshots,
  pruned data, or model context. Never logged, persisted, returned, or sent
  to the planner. Protected (password/payment) targets are never captured;
  their writes are blocked anyway.
- **Recording:** a verified change that actually altered state replaces
  the record. A verified no-op (already in the desired state, same value)
  leaves the earlier record. Clicks, approved consequential actions,
  dispatched-but-unverified or thrown actions, ARIA radios, and
  multiselects replace it with a **barrier**: undo then refuses and never
  skips backward past it.
- **Restoration:** `undoLastChange({ documentSessionId })` requires an open
  gate, the same document, and no other execution in flight. The record is
  consumed before any asynchronous work (duplicates find nothing). It then
  requires: original node still connected and still resolving at its id;
  same accessible name; visible, enabled, writable, not protected, not
  consequential; radio group membership unchanged; and the **current state
  equal to the recorded post-action state** — otherwise `UNDO_CONFLICT`
  (intervening edit/changed choice) or `UNDO_STALE` (replaced/relabelled/
  hidden/other document). Dropdowns additionally require: single-choice
  mode; an identical choice-list structure (any changed value, label,
  text, order, or option set refuses); the current selection equal to the
  recorded post-state by node AND meaning (so a renamed selected option is
  a conflict); the restoration choice being the same node at the same
  index with its original value/label/text; and that choice — and its
  optgroup — not disabled, exactly as forward select requires. Never a
  guessed replacement option. Validation repeats synchronously after the
  scroll wait, with Stop/Pause generation checks, then restores through the
  native value setter + input/change events, the verified `selectedIndex`
  + events, or one activation (checkbox/ARIA toggle; the previously
  selected radio member).
- **Final verification is against the live page, not history:** after
  settling, the target must still be connected and resolve at its id with
  the same accessible name; a radio group is re-resolved live and must
  have the same connected members, order, and meaning; a dropdown must keep
  its mode and structure; and the prior state must hold. Otherwise —
  including a restoration target removed, replaced, or regrouped by a page
  handler — the result is `UNDO_NOT_VERIFIED` (dispatched, unverified), a
  barrier blocks older undo, and nothing is retried.
- **Scope honesty:** results name the target, never values, and say that
  only the last change was reversed — earlier changes and anything the
  page did in response stay. A radio with no previously selected member,
  or a select with no prior selection, refuses (`UNDO_UNSUPPORTED`).

## Evidence

Automated (deterministic; no microphone, no model, no network):

- Headed-finding follow-up (approval aliases): `npm --prefix apps/extension
  test` **279/279** (+1 phrase test: aliases and negative/compound
  rejection; +4 panel tests: integrated spoken “approved plan” → one
  execution with no model call and duplicate final ignored; each alias
  refused from a stale session and approving exactly once; aliases with
  only a held Submit → zero approval messages; five unsupported
  approval-like phrases keep the same usable preview with nothing run or
  planned). Removing the retention fails 1 test; removing the “approved
  plan” alias fails 3. Headless Chrome stub-model typed E2E **32/32**
  (adds “approve later” keeping the plan and “Approved plan.” approving).
- Previously: `npm --prefix apps/extension test` — **274/274** (231 prior, 12 of them
  updated to approve first and one context test given an extra doc-A
  snapshot because planning now reads the live page; +25 executor undo,
  +17 panel review, +1 phrase). Review-finding follow-up (2026-10-31):
  before the fix, the 8 new dropdown/radio/relabel reproductions failed
  (undo selected a disabled or re-valued option and reported verified;
  missed a renamed current option; reported verified with Weekly removed
  and zero radios checked); after it, all pass. Removing the correction
  cache or routing model corrections straight to execution fails 2 tests;
  reverting fresh planning fails 1.
  - `tests/undo.test.mjs` (real engine + executor): full-value undo beyond
    any truncation, single consumption, concurrent duplicates, manual-edit
    refusal, select restore and changed-choice refusal, checkbox
    check/uncheck, radio previous-member restore, empty-group refusal,
    radio conflict, replaced node and wrong document, click barrier,
    sensitive never captured, approved-consequential barrier, no-op keeps
    record, pause/resume, unverified restore barrier, ARIA switch restore
    and ARIA-radio refusal, trusted routing (page sender rejected); dropdown
    disabled/re-valued previous option, renamed current option, disabled
    optgroup, changed labels/structure/mode, and valid restoration; radio
    target removed, replaced, or regrouped during restoration; fill target
    relabelled during restoration.
  - `tests/plan-review.test.mjs`: the acceptance flow with **stubbed
    recognition and stubbed planner against the real content script +
    executor on the demo survey** (mis-speak → preview → voice edit →
    stale original inert → voice approve → voice undo of Short bio only →
    duplicate undo refused); manual-edit undo refusal; plan approval not
    granting Submit (and typed/plan phrases not approving a challenge);
    voice “Approve this action” once despite duplicate finals; cancel by
    click and voice; stale preview after a page change; superseding
    request / tab change / Pause / Stop invalidation; delayed replan after
    edit cannot overwrite; mid-session plan cannot be approved by that
    session; speech silenced before listening; contextual edit phrases;
    model clarification → review; protected/long value display;
    model-derived correction → new preview with zero model calls and no
    mutation before approval (real executor); several alternatives →
    choices → review, with obsolete round buttons inert and values never
    combined across rounds; cache invalidation by navigation, Pause,
    superseding request, and an unapproved choice preview; a manual edit
    before a request no longer makes its preview stale.
  - Mutation checks: removing the stale-handle identity check, the
    voice-authority binding, the revision/hash recheck, the undo conflict
    check, undo consumption, or the preview itself each fails tests.
- `packages/shared` 11/11, `apps/planner-proxy` 15/15, `apps/mcp-server`
  11/11 (unchanged code; schema mirror byte-identical).

Headless Chrome (real Chrome, unpacked extension, content script, executor,
planner proxy, demo survey; **scripted upstream instead of Muse Spark;
commands typed through the panel input, no microphone**): 31/31 — the
follow-up adds: disabled previous dropdown option refused with no write,
unchanged dropdown restored, radio restoration whose Weekly target is
removed by a page handler reported unverified with a barrier, and model
clarification → approve → “no, the other one” → new preview with no extra
model call and no mutation until approved. Earlier checks: first
preview with nothing changed, plain steps, focus on the review heading,
model prose absent, typed “Edit plan: …” replacement, approve → both
verified with no model call, undo restores the full prior Short bio while
Full name stays, duplicate undo refused, manual-edit refusal, cancel,
stale-preview rejection, Submit held after plan approval and not
submitted, proxy stderr value-free. Harness and screenshots were produced
in the session scratchpad (not committed).

**The automated/headless results above are not evidence of** genuine
microphone recognition, genuine Muse Spark planning, or a mouse-free run.
The later Product Owner report below supplies separate headed core evidence.

## Headed acceptance (Product Owner) — core workflow PASSED

Setup: reload the local demo survey (fictional data only); open Seeyable;
confirm planner pairing and key; gate open. Optionally type a prior Short
bio (e.g. “Prior bio”) so the restoration is visible. Use the keyboard only
(Tab/Enter or Space on Start listening; no wake word).

Product Owner headed run (2026-10-31) before the alias change: preview,
edit, execution, and undo behaved as expected, but “Approve plan” was
transcribed as “approved plan”, which superseded the preview. Final voice
acceptance was pending a rerun on the alias change. The Product Owner then
confirmed every check in the requested five-check mouse-free rerun passed:
preview, voice edit, “approve later” preserving the preview, accepted plan
approval, and last-change undo. Recognition repeatedly heard “Grasshopper”
for “Grace Hopper”. This establishes the core workflow, not exact-name
transcription accuracy. Results are human-reported; raw transcripts and
measured model latency were not captured for this final run.

1. Start listening; say “Put Grace Hopper in Full name and Pilot in Short
   bio.” Expect a review card with two steps; neither field changes.
2. Start listening; say “Edit plan: put Grace Hopper in Full name and
   Scientist in Short bio.” Expect “Replacement plan ready for review”;
   Pilot is gone; nothing on the page changed.
3. Start listening; say “Approve plan.” (“Approved plan”, “Approve”, or
   “Go ahead” are also accepted.) Also try “approve later” once first and
   confirm the plan stays. Expect “Completed 2 steps, all
   verified”; Full name = Grace Hopper, Short bio = Scientist.
4. Start listening; say “Undo last change.” Expect Short bio back to its
   prior value (empty or what you typed); Full name still Grace Hopper.

The following supplementary headed probes remain unconfirmed by the final
core report (their automated evidence is listed above). Record actual
transcripts when running them. Separately verify: Cancel plan
(click and voice); approve after changing the page (e.g. type in Nickname
after the preview appears) is refused; “Put Pioneer in Nickname then submit”
→ Approve plan holds Submit; “Approve this action” said in a session started
while the challenge shows runs it once (do not approve submission on a real
form; on the demo survey it only reports dispatch); let a held challenge
expire (60 s) and confirm approval reports expiry; type into Short bio after
a Seeyable fill and confirm undo refuses. Review-finding checks: “Choose
Designer for Your role”, approve, then disable nothing and undo (Engineer
returns); repeat, and in DevTools disable the Engineer option before undo
(refused, Designer stays). A model clarification (e.g. an ambiguous “put
Pilot in the name field”, if the model asks) → choose → Approve plan → say
“No, the other one” → a NEW preview appears with nothing changed → Approve
plan. Whether the genuine model asks a clarification is not guaranteed.

## Limitations and decisions

- **Act 1 interaction change:** every AI plan now waits for review, so
  each canonical Act 1 sentence needs an “Approve plan” before it runs.
  The script text was not changed; the Product Owner should decide whether
  to amend `docs/act-1-demo-script.md`.
- Recognition quality is unchanged (Web Speech; fill/feel/Phil remains).
  “Edit plan” needs the full replacement request in one utterance.
- Approval re-reads the page; any semantic change since review — including
  typing in another field — requires a fresh review. This is deliberate.
- Undo is one level, last change only, per document; clicks and page side
  effects are never reversed; no redo.
- A model clarification choice needs an approval step; its cached
  correction is available only after that preview is approved, and the
  corrected alternative needs its own approval.
- The “Review — nothing changed” chip reuses the held (brick) chip style;
  no new visual treatment was invented. #29 visual acceptance is still
  deferred.


## Note (2026-11-01, Plain Words panel)

The review card, gate, and Completed view now offer a speak prompt (the same Start control, so voice approval stays bound to what is on screen) and a panel-only Alt+S shortcut (not while typing). Undo is also a button in the always-visible safety bar, using the same path as the voice command. Planned runs show step progress and, when every step is verified, a Completed list. See `docs/features/feature-plain-words-panel.md`.
