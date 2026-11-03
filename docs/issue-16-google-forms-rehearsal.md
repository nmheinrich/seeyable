# Issue #16 — Google Forms rehearsal and scope freeze

Prepared 2026-11-01. Updated 2026-11-02: accepted on the Product Owner's
report that three runs worked. Detailed timings, transcripts, and retry
records were not supplied; the table records reported passes only.
This is the final-target rehearsal, not the older
local-fixture acceptance script in docs/act-1-demo-script.md. Do not rewrite
that earlier pass as evidence for this Google Form.

## Setup

1. Use the published respondent link for Pioneer Outdoors — Visit Feedback,
   not its /edit or /preview URL. Google disables Submit in preview mode;
   that does not demonstrate Seeyable's safety gate. Record the responder
   URL in the results once supplied by the Product Owner. Do not guess it.
2. Confirm the actual questions match docs/demo-google-form.md. The saved
   creation note says unpublished; the owner must confirm current publish
   status. Do not treat the old draft note as current publication evidence.
3. Keep the same extension build, form configuration, and commands for all
   three runs. Finish any concurrent Muse edits before starting the streak.
4. Planner Status must report the configured model/key, the microphone must
   work, and the executor gate must be open. Keep Stop/Pause accessible.
5. Clear form and confirm to reset the fictional answers. Confirm Visitor
   name is empty and every radio/checkbox is unselected on the first page.
6. Use only invented answers. No response should be submitted. Start timing
   with the first utterance and stop when the final executor hold appears.

## Execution rules

- Start listening explicitly before each utterance; wait for recognition to
  finish and for the resulting UI state before issuing the next command.
- Every AI action plan must show a preview. Check target names and values,
  then start a NEW listening session and say “Approve plan” or “Go ahead”.
- Approval never needs another planner call. A plan approval does NOT
  approve the final Submit action.
- Exact local commands such as “Click Next” and “Undo last change” do not
  need an AI plan preview. Keep the distinction in the notes.
- After Next, verify the destination and issue a separate request. Never
  combine actions for unseen pages into a plan using invented future IDs.
- If an unexpected write, unsafe approval, or stale-target substitution
  occurs, stop. Preserve the message/transcript and do not keep retrying.
- Do not demand a false verified-completion claim for navigation: record a
  dispatched/unverified navigation status honestly and visually confirm
  the correct destination before proceeding. Data changes must verify.

## Fixed primary script — repeat unchanged three times

### 1. Visitor details and interests

Say:
“Put Alex Demo in Visitor name, choose Get advice for Visit purpose, and
check Hiking boots and Rain jackets.”

Expect a four-action preview. Approve it deliberately.

Verify: Visitor name = Alex Demo; Visit purpose = Get advice; Hiking boots
and Rain jackets checked; Day packs unchecked. Intended mutations verify.

### 2. Initial grid answers

Say:
“For Rate your visit, select Satisfied for Product selection, Neutral for
Staff helpfulness, and Satisfied for Checkout experience.”

Review and approve. Verify exactly those three rows. Repeated column labels
must not cause the planner to change the wrong row.

### 3. Deliberate staff-row repair

Say:
“Change only Staff helpfulness to Very satisfied.”

Review and approve. Verify Staff helpfulness = Very satisfied, while Product
selection and Checkout experience remain Satisfied. This correction is
intentional script behavior, not an unplanned failure.

### 4. Choose the short route and navigate

Say:
“Set Overall experience to Good.”

Review, approve, and verify Good is selected. Then say separately:
“Click Next.”

Visually verify Final comments appears and Tell us more was skipped. If
navigation produces a dispatched/unverified message, record it as such;
page arrival is the independent observation. Continue only on the correct
page and allow the next command to acquire its fresh snapshot.

### 5. Dictate, undo, and restore the comment

Say:
“For Your comment write: The staff explained the options clearly, and
checkout was quick.”

Review and approve. Verify the intended comment is present; record the
actual voice transcript and punctuation separately. Do not count a changed
name, target, meaning, or invented value as an exact dictation success.

Say:
“Undo last change.”

Verify Your comment returns to empty (its starting state) and earlier
answers remain. Undo must report verified restoration of that field only.

Repeat the same comment request, review, approve, and verify it is restored.
This undo/reapply is an intentional part of the rehearsal.

### 6. Review and reach the executor-held Submit

Visually check current answers and the deterministic plan previews. This
script does NOT promise spoken read-back of the entire completed form.

Say:
“Please submit this form.”

Review the proposed Submit step. Say “Approve plan”. Expect the separate
executor confirmation card: the form is still unsubmitted. Stop timing here.

Do NOT say “Approve this action” or activate Approve once. Cancel using the
Safety confirmation's Cancel control (Tab/Enter is fine). “Cancel plan”
is not the consequential-challenge cancellation command.

Verify no submission/thank-you page, no extra action, and no replay. Clear
form, confirm the reset, and return to the empty first page before the next
run. Count the run only after this cancellation/reset check is complete.

## Results

Record actual behavior; never fill in results from the intended script.

| Run | Start/end or duration | Complete? | Unexpected speech corrections/retries | Navigation status | Held Submit cancelled/reset? | Clean streak |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Not supplied | Pass (owner report) | Not supplied | Not itemized | Not itemized | Reported pass 1/3 |
| 2 | Not supplied | Pass (owner report) | Not supplied | Not itemized | Not itemized | Reported pass 2/3 |
| 3 | Not supplied | Pass (owner report) | Not supplied | Not itemized | Not itemized | Reported pass 3/3 |

On 2026-11-02 the Product Owner reported “Three runs works fine” and
requested #19 next. Accept the rehearsal on that human report; this is
not an independently measured clean-run log. The earlier blocker and
spot-check records below remain historical evidence.

A clean run has no unintended mutations, all intended field/radio/checkbox
changes verified, correct visible navigation, planned repair and undo
working, no unplanned recovery/retry, and Submit held then cancelled with a
clean reset. Planned approvals, the staff correction, and undo/reapply are
normal script steps. Log unplanned recognition repairs honestly: a run
completed with extra recovery is evidence, but not one of three clean runs.
If a run fails or needs unplanned recovery, the consecutive clean count
restarts. If code, form structure, or script changes to fix a blocker, start
the three-run streak again on the final version.

## Blocker fixes — 2026-11-02 (streak restarts on this build)

Two blockers from the genuine Google Forms rehearsal were fixed. Per the
rule above, the three-run streak restarts at 0/3 on this implementation.

1. **Rating answers were held as "checkout".** Target: `role="radio"`,
   name "Very satisfied, response for Checkout experience". The executor's
   label check matched "checkout" anywhere in the name, so both `check` and
   `click` returned `CONFIRMATION_REQUIRED` and nothing changed (reproduced
   with the real snapshot engine and executor on jsdom; 4 of 4 held).
   Two earlier fixes were rejected in review as safety regressions and
   replaced: exempting every radio/checkbox/option, then removing group
   text globally from a joined label ("Pay now (required)" under a group
   named "Pay now" dispatched). Decision rule (executor, every caller): (1) native submit evidence —
   `input[type=submit|image]`, a form-associated default/submit `<button>` —
   is consequential first, whatever ARIA role the page assigns; (2) native
   buttons, links (`a[href]`), button-type inputs, and `<summary>` are judged
   by their whole labels even when given a selection role; (3) for a
   selection control — native radio/checkbox, `<option>`, or an explicit ARIA
   radio/checkbox/option role on a non-committing element — each label source
   (accessible name, aria-label, title, value, own text) is judged separately;
   a source may shed ONE trailing reference to the control's structural group
   (fieldset legend; enclosing radiogroup/group/listbox name via aria-label or
   aria-labelledby, or a separator-delimited part of it with two or more
   words) only when that group phrase is the source's final words, sits on a
   word boundary, is introduced by a referring word (for, of, about,
   regarding, concerning, on), and leaves the option's own words; group text
   anywhere else is the control's own evidence and is kept; (4) any source
   that still names a consequential action holds the control; other controls
   are judged on every label source as before. The keyword list is
   unchanged; page event handlers are never inspected; no special words.
   The plan preview's "will ask for its own approval" hint mirrors this
   from snapshot data (certain question context only) and has no
   enforcement role. Held (zero dispatches before approval): "Pay now (required)" in a group
   named "Pay now"; "Delete all saved responses now" / "Send notification
   immediately" / "Send notification to all members" in groups named with
   the same action; "Confirm, Delete all saved responses" (bare comma);
   "Pay for Checkout experience" (own "Pay" remains); a survey label whose
   title independently says "Delete all saved responses";
   `<button role="checkbox">Delete draft</button>`; buttons/links with a
   radio role. Selected: "Very satisfied, response for Checkout experience"
   under its "Checkout experience" (or "Rate your visit: Checkout
   experience") row, native and ARIA, by check and click. Limitations: row
   text placed first ("Checkout experience: Very satisfied") or joined
   without a referring word is not demonstrably incidental and is held
   conservatively; context is recognised only when the page exposes it
   structurally.
2. **Confirmation card was unusable on a real form.** The heading held the
   whole target name, status text repeated, the full Google Forms URL was
   in the main view, and Approve/Cancel were pushed below the visible area.
   Fix (panel only; approval binding unchanged and still sent as the
   challenge id alone): short heading "Approve this action?"; one clamped
   line naming the action and full target; the question if any; "On page
   title · domain"; one line saying nothing has run, approval applies once,
   and when it expires; Approve once and Cancel side by side before an
   expandable Details area holding the full URL, element id, consequence,
   and exact expiry. The status line is shortened, an earlier "Latest
   result" success is cleared while an action is held, the page card steps
   aside, and short or zoomed panels switch to a flowing layout whose
   sticky safety bar reserves scroll space for itself.

Evidence: extension 315/315 (classification and dispatch-count
regressions in tests/safety-gate.test.mjs, card and preview-hint tests in
tests/plain-words.test.mjs); shared/proxy/MCP unchanged. Real headless Chrome with the
extension, a local Google-Forms look-alike page (long title, long URL,
ARIA rating grid, a "Delete all saved responses" checkbox, real Submit),
the planner proxy and a SCRIPTED model: 40/40 — the "Checkout experience"
rating selects and verifies with no challenge; the Delete checkbox is held
with zero dispatches; Submit is held after plan approval and never submitted; the
card at 400×900 and 320×900 shows Approve/Cancel without scrolling and
clear of the safety bar; at emulated 200% zoom (400×900 and 320×700) and
360×640 there is no horizontal scroll and Approve/Cancel scroll into view
uncovered; light and dark. Emulated zoom is not real browser zoom, and
the page is a look-alike, not the genuine form: these numbers alone do
not establish headed acceptance. See the subsequent Product Owner note.

## Product Owner spot-check follow-up — 2026-11-02

After the final correction, the Product Owner reported “Works very well”
following the genuine-form rating/held-Submit/compact-card instructions,
and requested a checkpoint and continuation. This is human-reported
spot-check acceptance; individual zoom results, durations, and raw
transcripts were not provided. It is not a record of three consecutive
full rehearsals: the results table remains pending. The next development
work may proceed to #19/#20 while preserving that distinction. Shopify
remains excluded; transcription-provider changes are a separate proposal.

## Separate conditional-path probe (not part of the primary three-run script)

On a reset form, complete required first-page answers but choose Needs
improvement for Overall experience. Click Next. Verify Tell us more appears
with What should we improve? Fill that field with fictional text, review
and approve; navigate to Final comments and verify the correct destination.
Do not submit. Reset. This is section branching after navigation, not inline
conditional rendering. Record this separately; broader messy-form hardening
belongs to #17.

## Scope-freeze record — accepted 2026-11-02 on owner report

- Keep: Google Forms as the primary target; explicit push-to-talk and typed
  fallback; word-first targeting; reviewed plans; row-specific correction;
  comment dictation and last-change undo; shared human-gated Submit.
- Shopify is excluded from the demo following the Product Owner's decision.
- No new speech provider, full-answer read-back feature, invisible-page
  plans, real submission, payment, or third-party fulfillment integration.
- #29 visual acceptance remains a separate bounded task before recording.
- Full MCP actions/external-client Act 2 remain #19/#20, not a #16 claim.
- Diction improvements, automatic snapshot/page recovery, and proxy/setup
  simplification are parked follow-ups, not additions to #19.
- Latest checkpoint supplied by the owner: 86d4b8a. Exact run timings,
  transcripts, retry counts, and the published responder URL were not
  supplied in the three-run report. GitHub issue updates remain with the owner.

Suggested Product Owner reply after each attempt:
“Run N: pass/fail; clean count N/3; duration …; transcript differences …;
unplanned retries …; Submit held/cancelled and reset …”.
