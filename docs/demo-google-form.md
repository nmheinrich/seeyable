# Google Forms demo target — Pioneer Outdoors

Created 2026-11-01 in the Product Owner's Google account. This is a newly
created demonstration target, not Seeyable's product UI and not a replacement
for the pre-existing 20-control local regression fixture.

Editor: https://docs.google.com/forms/d/10QjhDax7z6cl4igEgh6rceNVYV-CVOu-udCt8d0OnHs/edit

Preview (owner only; Submit disabled):
https://docs.google.com/forms/d/10QjhDax7z6cl4igEgh6rceNVYV-CVOu-udCt8d0OnHs/preview

Status: created and saved, UNPUBLISHED. Direct browser preview checks passed
for Good → Final comments, Needs improvement → Tell us more, and Clear form
→ blank Page 1. Seven question titles and the two named section headers
were verified. No response was submitted. Seeyable end-to-end acceptance
and the three-run scope-freeze check remain pending.

To enable the final safety-gate test: open the editor, click Publish, review
the responder-access setting, and confirm publication. Copy the responder
link from Google Forms (do not use the editor or preview URL). Keep editor
access private. Open the respondent link for Seeyable testing, fill only
fictional answers, and cancel the final executor Submit challenge.

## Content

Title: Pioneer Outdoors — Visit Feedback

Description: A fictional customer-feedback form for demonstrating Seeyable.
Use invented answers only; do not enter real contact, payment, or personal
information. During rehearsals, stop at the final Submit confirmation and
cancel.

| Section | Question | Type | Choices / rule |
| --- | --- | --- | --- |
| 1 | Visitor name | Short answer, required | Fictional name, such as Alex Demo |
| 1 | Visit purpose | Multiple choice, required | Browse products; Get advice; Collect an order |
| 1 | Products explored | Checkboxes, optional | Hiking boots; Rain jackets; Day packs |
| 1 | Rate your visit | Multiple-choice grid, response required in every row | Rows: Product selection; Staff helpfulness; Checkout experience. Columns: Very dissatisfied; Dissatisfied; Neutral; Satisfied; Very satisfied. Do not limit one response per column. |
| 1 | Overall experience | Multiple choice, required | Good and Okay go to Final comments; Needs improvement goes to Tell us more |
| 2: Tell us more | What should we improve? | Paragraph, required | Appears on the Needs improvement route; continue to Final comments |
| 3: Final comments | Your comment | Paragraph, required | Fictional dictation, editing, and undo target |

The conditional follow-up is a Google Forms SECTION branch after Next,
not an inline conditional element. Seeyable must acquire a fresh snapshot
after navigation; one plan must not invent IDs for a later page.

## Settings and appearance

- Not a quiz; email collection off; response copies off.
- Limit to one response off; no sign-in restriction added by this draft.
- Question/option order fixed; no shuffling or one-selection-per-column rule.
- Progress bar on; public results summary off.
- Respondent autosave disabled so a fresh load can start a clean rehearsal.
- No file upload, phone/email/address, payment, or password fields.
- Neutral typography, dark-teal accent (#0f766e), light-gray background.
- Publishing/access must be confirmed from the actual Google Forms UI before
  a responder URL is recorded. The preview has a disabled Submit control
  and is insufficient evidence of Seeyable's consequential-action gate.

## Rehearsal coverage

1. Text entry and multiple independent page controls in one reviewed plan.
2. Repeated Likert labels in three rows; change only Staff helpfulness.
3. Checkbox multi-selection, then uncheck one choice.
4. Long comment dictation, voice edit/review, and last-change undo.
5. Native required-field validation (omit Visitor name or a grid row).
6. Good/Okay short route versus Needs improvement follow-up route.
7. Back/Next navigation with fresh snapshots and stale-target rejection.
8. Submit held by the EXECUTOR after plan approval; cancel, never submit.
9. Clear form/reset and three consecutive clean rehearsals for Issue #16.

Creation and direct browser preview checks do not establish Seeyable
end-to-end compatibility. The three-run acceptance and visual acceptance
remain separate Product Owner checks. Never submit real responses during
rehearsals, and do not claim unsupported read-back or inline branching.
