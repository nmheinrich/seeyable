# Project Status and Pending Verification

Last updated: 2026-10-28. This file records what is built, what has
actually been verified, and what still needs a human with a headed
browser. It is a status note, not a roadmap; scope decisions live in
the feature documents.

## Current state

| Area | State |
|---|---|
| Snapshot spike (DOM/ARIA vs CDP decision) | Complete — `docs/decision-snapshot.md` |
| Production snapshot engine (schema v2) | Complete — `docs/snapshot-schema.md` |
| Visual overlays (numbered word tags, ID-based highlight) | Complete — `docs/features/feature-07-visual-overlay.md` |
| Executor (single validated actions) | Complete — `docs/features/feature-08-executor.md` |
| Manual execution test panel | Complete — `docs/features/feature-09-manual-test-panel.md` |
| Voice, planner, proxy, MCP server | Not started |

Repository: `main` tracks `origin/main`. The standard extension build
requires no `debugger` permission; CDP remains debug-only via
`apps/extension/manifest.debug.json`.

## Verification evidence

- Extension test suite: `npm --prefix apps/extension test` — 57/57
  passing at last run (snapshot engine, overlays, CDP helpers,
  executor incl. baseline/effective-disabled/final-verification
  corrections, panel ownership regressions, and question-context scoping).
  Independently re-run during review on 2026-10-28. Re-run after any change; do not trust this number
  without re-running.
- Headless Chrome 156 runs through the real message paths:
  DOM/ARIA and CDP snapshots (20 controls, identical names), overlay
  tags/ring with measured alignment, nested-container scrolling,
  executor actions on the demo survey and executor fixture (fills,
  select, check, conditional-appear diff, consequential blocking with
  page handler flags asserted false, sensitive writes blocked).
- Headed Chrome smoke test of the standard build (load, side panel,
  DOM snapshot, highlighting, no debugger prompt): passed in manual
  testing on 2026-10-27.
- Live Google Forms question association (repeated ratings and radios
  map to their actual questions): confirmed in manual acceptance
  review. Note the executor safety rules before any form interaction:
  consequential controls are blocked by design; do not submit forms.
- Headed executor run through the message interface (2026-10-27):
  passed — fill, select, check/uncheck, conditional field reveal,
  blocked Submit, single click, redacted read, and nested scroll all
  behaved as specified. The baseline-required spot-check was covered
  by automated tests, not manually performed.
- Google Forms overlay/highlight checks: passed (snapshot, tags,
  highlighting, toggling, resize, unchanged form interaction).
- Facebook Marketplace ring visibility: passed, including nested
  scrolling and highlighting with tags hidden.
- Actual browser zoom: passed, per Product Owner confirmation
  (not device-scale-factor emulation).
- Forced colors: passed, per Product Owner confirmation.

- Headed manual panel checks (2026-10-28), confirmed by the Product
  Owner on the executor fixture: controlled-input fill, conditional
  reveal and fill, keyboard-only single counter activation, tab-switch
  invalidation, blocked Submit, redacted Password read, nested scroll,
  and reload recovery. The corrected Password question metadata was
  also checked: `question: null`, with redaction intact.
- Live Google Forms snapshot reviewed after the scoping correction:
  star ratings and name options retain their correct ARIA-group
  questions; Submit and Clear form have no inherited question.
  The Product Owner confirmed panel checks for Tone/Neutral checkbox,
  five-star radio, and a synthetic age text fill. No form was submitted.

## Verification limits and next work

- Original demo-survey and additional executor-fixture flows have
  headless panel evidence; the headed panel checks listed above do not
  establish universal website or custom-widget compatibility. Google
  Forms native-select operation was not tested in this acceptance pass.
- Next: Feature #11, shared human-confirmation safety gate. Issue #29,
  Plain Words product design, starts after #11. Voice/planner/MCP remain
  separate future work; this acceptance adds no AI implementation.

## Known limitations to keep in mind

- Accessible-name computation is simplified (no shadow-DOM or
  cross-origin-frame traversal); parity with Chrome was measured on
  the project fixtures, not arbitrary pages.
- Sensitive-field and consequential-control classification is
  heuristic by design; it is not a comprehensive intent detector.
  The human-approval safety gate is a future feature at the
  executor's `execute()` boundary.
- `cssPath` is a diagnostic locator, never an identity authority;
  stale references are rejected rather than retargeted.
- Dense-grid tags can overlap and obscure word labels. Readability
  refinement belongs to issue #29 and must precede demo recording.
- Browser screenshots and E2E harnesses used during development live
  outside the repository (local `/tmp` scratch) except for the
  samples under `docs/spike/`.

## Test fixtures

- `apps/demo-survey/index.html` — 20-control regression fixture.
  Keep its control set stable; snapshot tests depend on it.
- `apps/extension/tests/fixtures/rating-form.html` — duplicate-label
  and forms-style question-association fixture (synthetic).
- `apps/extension/tests/fixtures/executor-form.html` — executor
  actions, conditional reveal, consequential handler flags
  (synthetic values only).
