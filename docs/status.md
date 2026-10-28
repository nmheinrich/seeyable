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
| Voice front end and typed fallback | Complete and accepted — `docs/features/feature-10-voice-front-end.md` |
| Shared executor safety gate | Complete and accepted — `docs/features/feature-11-shared-safety-gate.md` |
| Planner, proxy, MCP server | Not started |

Repository: `main` tracks `origin/main`. The standard extension build
requires no `debugger` permission; CDP remains debug-only via
`apps/extension/manifest.debug.json`.

## Verification evidence

- Extension test suite: `npm --prefix apps/extension test` — 120/120
  passing at last run (snapshot engine, overlays, CDP helpers,
  executor incl. baseline/effective-disabled/final-verification
  corrections, panel ownership regressions, question-context scoping,
  voice command normalization/lifecycle and panel voice/typed
  integration, and the Feature #11 safety gate: confirmation holds,
  approval binding/expiry/consumption incl. dispatch-time expiry,
  SHA-256 submission-destination binding (fail-closed without Web
  Crypto), dispatch-boundary cancellation honesty, operation-scoped cancellation
  (Stop/Pause permanently invalidating in-flight work), sender-
  verified approval routing, sequential-harness stopping, log
  redaction, and synchronous final validation after the last async
  binding hash (mutations to disabled/detached/hidden targets during
  hashing are rejected with zero activations). Re-run after any change; do not trust this number
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

- Headless Chrome evidence for the voice front end (panel page on the
  demo survey): typed `don't show tags` executed nothing; typed
  `Show Tags!` showed 11 in-viewport badges and bound the snapshot;
  typed `hide tags.` removed all badges; the Microphone setup button
  opened the setup tab. Recognition/synthesis APIs were present, but
  headless presence does not verify microphone capture.
- Headed Feature #10 acceptance (2026-10-28), confirmed by the Product
  Owner: real microphone commands show/hide tags, correct hide transcript,
  visible badge changes, audible feedback without self-transcription,
  typed show tags, rejected negated command, Cancel listening, keyboard
  activation of Start listening followed by successful show tags, and
  recognition cancellation on tab switch without commands on either page.
  An initial microphone-denial message was observed before successful
  recognition. The exact permission-grant/setup-page sequence was not
  recorded; no claim is made that the setup page is always required.
- Headed Feature #11 acceptance (2026-10-28), on the local executor
  fixture: confirmation appeared before activation; keyboard Tab/Enter
  approval returned dispatched-unverified; Cancel on Delete draft logged
  approval-cancelled; Pause blocked execution and Resume replayed nothing;
  Stop/Resume also replayed nothing. Changing Plain text after requesting
  confirmation caused the approved attempt to return STALE_SNAPSHOT.
  These results were confirmed by the Product Owner; exact activation
  counts and race/expiry/replay cases also have automated coverage.
  The log's approved flag records human approval, not dispatch success.

## Verification limits and next work

- Original demo-survey and additional executor-fixture flows have
  headless panel evidence; the headed panel checks listed above do not
  establish universal website or custom-widget compatibility. Google
  Forms native-select operation was not tested in this acceptance pass.
- Feature #10's core headed acceptance checks passed. Stop-listening
  finalization, mute/Stop-speech timing, and delayed-callback race handling
  have automated coverage; those specific timing paths were not separately
  confirmed audibly in the headed session. Typed show/hide browser evidence
  is on the demo survey, not a fresh Google Forms run for this feature.
- Feature #11's local headed acceptance checks passed. Real consequential
  actions on live websites were not tested. Planner/MCP callers remain
  synthetic test callers; no live planner, proxy, or MCP transport exists.
- Next: issue #29, Plain Words product design, following completed #11.
  Planner/MCP remain separate future work.

## Known limitations to keep in mind

- Accessible-name computation is simplified (no shadow-DOM or
  cross-origin-frame traversal); parity with Chrome was measured on
  the project fixtures, not arbitrary pages.
- Sensitive-field and consequential-control classification is
  heuristic by design; it is not a comprehensive intent detector.
  The shared human-approval safety gate is implemented at the executor
  boundary. It binds DOM-observable submission state, not invisible
  transformations performed by page scripts.
- `cssPath` is a diagnostic locator, never an identity authority;
  stale references are rejected rather than retargeted.
- Dense-grid tags can overlap and obscure word labels. Readability
  refinement belongs to issue #29 and must precede demo recording.
- Browser recognition initially heard "tags" as "tax" and "targets";
  successful recognition took about three attempts. Exact command matching
  remains intentional; no fuzzy aliases were added. Cancellation status
  wording is verbose and can be refined in issue #29.
- The action log's trailing "approved" means human approval was supplied,
  even when a stale-state error prevented dispatch. Issue #29 should make
  approval and execution outcome visually distinct.
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
