# Project Status and Pending Verification

Last updated: 2026-10-31. This file records what is built, what has
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
| Plain Words product interface (#29) | Deferred by Product Owner on 2026-10-30; visually NOT accepted — `docs/features/feature-29-plain-words-interface.md` |
| Planner, proxy | Complete and accepted — Product Owner confirmed full canonical Act 1 typed then spoken on the corrected implementation, 2026-10-31; recognition remains imperfect — `docs/features/feature-14-muse-spark-planner.md`; loopback proxy, shared plan schema, guarded sequential execution, cached corrections; stub-model plumbing verified |
| Voice transcription spike (#12) | Timeboxed spike complete: INCONCLUSIVE / KEEP Web Speech — `docs/decision-voice-transcription.md`; zero provider takes; file-client mechanics verified offline (3/3); live comparison harness incomplete |
| MCP bridge spike (#28) | Complete and accepted — `docs/features/feature-28-mcp-bridge-spike.md`; headed snapshot/highlight, 95-second idle/tab-switch checks, and Product Owner disconnect/re-pair/stale-target checks passed |
| Plan preview, confirmation, undo (#15) | Complete and accepted for the core mouse-free workflow — Product Owner confirmed genuine-microphone/model preview, voice edit, unsupported-approval retention, approval and last-change undo on 2026-10-31. Repeated Grace Hopper → Grasshopper recognition remains a limitation; supplementary headed safety probes are not claimed — `docs/features/feature-15-plan-review-undo.md` |
| Planner fast path (#13) | Checkpoint ready: headed typed exact/fuzzy fill, held Submit/cancel, compound rejection, clarification/expiry, five-choice access, single-error display, and live-mic click (one counter increment) passed. Voice fill remains limited by fill/feel/Phil recognition; full voice acceptance is not claimed — `docs/features/feature-13-local-command-fast-path.md` |

Issue #29 is parked to prioritize remaining functionality. Keep its current
uncommitted implementation; do not resume visual refinements without a new
Product Owner request. Remaining work includes reference-composition fidelity,
headed visual/accessibility acceptance, and a known Listening-state input-label
contrast issue (dark text on blue, approximately 2.74:1 at review). The last
independently rerun suite passed 146/146; this does not constitute visual acceptance.
Issue #28's local MCP bridge smoke test is now complete and accepted.
Git staging, commits, and pushes remain with the Product Owner; the current
working tree also contains #29's deferred, visually unaccepted work.

Repository: `main` tracks `origin/main`. The standard extension build
requires no `debugger` permission; CDP remains debug-only via
`apps/extension/manifest.debug.json`.

## Verification evidence

- Issue #15 final headed acceptance (2026-10-31): after the approval-alias
  correction, the Product Owner reported all five checks passed: initial
  preview without mutation, voice edit to replacement preview, “approve later”
  retaining the plan, an accepted plan-approval phrase executing the two
  fills, and “Undo last change” restoring Short bio while Full name stayed.
  This is human-reported genuine-model/microphone, mouse-free evidence.
  Recognition repeatedly heard “Grasshopper” instead of “Grace Hopper”;
  the workflow passed, but exact-name dictation accuracy is not claimed.
  Supplementary headed probes (stale preview, held-action voice approval and
  expiry, undo after manual edits, and adversarial option/radio changes) were
  not included in this report; automated evidence for them stays separate.

- Issue #15 headed finding (2026-10-31): the Product Owner's headed run
  showed preview, edit, execution, and undo working, but Web Speech heard
  “Approve plan” as “approved plan”, which superseded the preview. Plan
  approval now also accepts the exact phrases “approved plan”, “approved
  the plan”, “approve”, “approved”, and “go ahead” (plan only, same
  session/preview binding, never a challenge), and unsupported
  approval-like wording keeps the preview. Extension 279/279; shared 11/11,
  proxy 15/15, MCP 11/11; headless stub-model typed E2E 32/32. Final voice
  acceptance subsequently passed as recorded above.
- Issue #15 review-finding corrections (2026-10-31): dropdown undo now
  binds immutable option meaning, list structure, mode, and availability
  (disabled option/optgroup refused, re-valued/relabelled options refused,
  renamed current option detected); undo's final verification re-resolves
  the live target and radio group (removed/replaced/regrouped restoration
  targets report unverified with a barrier); model-derived “the other one”
  corrections survive review and produce a new preview with no model call;
  planning now reads the live page so a manual edit cannot leave a preview
  bound to a stale revision (found in the headless run). Extension 274/274,
  shared 11/11, proxy 15/15, MCP 11/11; headless stub-model typed E2E 31/31.
  At that stage there was no genuine-model, genuine-microphone, or headed evidence;
  the later core acceptance is recorded above.
- Initial Issue #15 evidence (2026-10-31), automated and headless only;
  headed acceptance was pending at this stage. `npm --prefix apps/extension test` 261/261 (231 prior — 12
  planner tests updated to approve the preview first — plus 16 executor
  undo, 13 panel review, 1 phrase test); shared 11/11, proxy 15/15, MCP
  11/11. The acceptance flow (mis-speak → preview → “Edit plan: …” →
  approve → undo Short bio only) passes with STUBBED recognition and a
  STUBBED planner against the real content script and executor on the demo
  survey. Headless Chrome with the real extension, real proxy, and a
  SCRIPTED upstream (typed commands, no microphone): 21/21, including
  stale-preview rejection, manual-edit undo refusal, Submit still held
  after plan approval, and value-free proxy logs. Not genuine-model, not
  genuine-microphone, not mouse-free headed evidence. Behavior change: every
  AI plan now waits for review, so canonical Act 1 sentences each need
  “Approve plan”; the script text is unchanged pending a Product Owner
  decision.

- Issue #14 genuine Muse Spark headed smoke checks — Product Owner confirmed
  on 2026-10-31, using the local demo survey and the keyed planner proxy:
  typed request filled Full name = Ada Lovelace and Short bio = Engineer,
  both verified; typed Nickname = Pioneer followed by Submit held for human
  approval and Cancel prevented submission; spoken request heard as
  "put Grace Hopper in full name and scientist in bio" filled both fields.
  Pause during planning discarded the request, replaced stale Planning text
  with a single main-status discard outcome, and Resume restored availability
  without field changes or replay (final headed retest passed).
  Local fast-path "Click updates" offered Email/SMS choices; choosing SMS and
  then "No, the other one" selected the remaining target. This last check is
  local resolver/correction evidence, not an additional model-planning run.
  An earlier voice attempt was misrecognized ("grasshopper" and mangled field
  wording); clearer speech succeeded. Speech recognition remains a limitation.
  These are human-reported headed results, distinct from automated/stub tests.
  First exact-script Act 1 run: sentences 1, 3, 4 passed; sentence 2
  failed at step 1 (OPTION_NOT_FOUND — the planner saw no dropdown
  choices). After the option-metadata fix, the Product Owner reran sentence 2:
  "Completed 4 steps, all verified: Your role; Email updates; SMS updates;
  Monthly digest." All four sentences have individually passed, across the
  initial run and rerun. The Product Owner subsequently confirmed a complete
  ordered typed run followed by a spoken run on the final implementation:
  both passed on 2026-10-31. Issue #14 is accepted. Recognition remains
  imperfect and requires clear speech for the demo. Live repair, broader plan
  quality, and measured model latency have not been established.

- Extension test suite: `npm --prefix apps/extension test` — 231/231
  (190 prior plus 33 #14 planner tests plus 8 select-options tests:
  prune/redaction/cap, proxy client auth/timeout/codes,
  correction-phrase exactness, context bounds, fast-path zero proxy
  calls, unpaired help, sequential fresh-revision execution,
  failure/unverified/vanished/renamed stops, held step with single
  approval and no continuation, invented-id rejection, planner
  clarify/unsupported, slow-model invalidation, cached corrections,
  pairing UI, context travel and reset, mangled-verb ask-not-guess,
  value-free history, body-deadline and cancel classification,
  cancel-during-body lock release, status auth-vs-connection errors,
  upstream status diagnostics, pause-discard status/chip,
  resume-no-replay, obsolete-after-resume ownership, engine option
  capture + redaction + hash invalidation, prune option bounds and
  omission, exact-value panel dispatch, changed/vanished/disabled/
  ambiguous option stops). Shared contract suite:
  `npm --prefix packages/shared test` — 11/11. Proxy suite:
  `npm --prefix apps/planner-proxy test` — 15/15.
  Planner-proxy suite: `npm --prefix apps/planner-proxy test` — 14/14
  (stub upstream, no credentials). Stub-model headless E2E 13/13 (real proxy +
  extension, scripted upstream — plumbing evidence, NOT live-AI
  evidence). Genuine-model headed smoke evidence is recorded below.
  MCP server suite:
  `npm --prefix apps/mcp-server test` — 11/11 (bridge auth,
  correlation, failure handling, atomic single-auth,
  shutdown-with-live-clients, and ping/pong regressions).
  Headless #28 end-to-end: 15/15 through a custom stdio JSON-RPC
  client (the same frames the Inspector sends) over the real
  loopback bridge and extension, plus a 10/10 lifecycle run (tab
  switches, idle 95 s with the panel closed and no worker DevTools,
  worker Stop/restart recovery without re-pairing, server restart,
  and post-Disconnect silence). The pre-fix reproduction showed the
  worker suspending ~30 s after the panel closed (socket detach at
  +36 s); the 20 s heartbeat plus init restore corrects this.
  stdio JSON-RPC, the loopback bridge, and the real extension
  (list_tabs, real 20-control snapshot, highlight round trip,
  wrong-token rejection, disconnect/reconnect without replay). Real
  Inspector CLI runs confirmed tools/list and the honest
  NO_EXTENSION error path. Project-manager headed Inspector checks on
  2026-10-30 verified a real highlight result plus visible Full name outline;
  after reloading the heartbeat changes, snapshots succeeded before/after at
  least 95 seconds idle with the panel closed and after three tab round trips,
  without manual re-pairing or attached service-worker DevTools. Headed
  explicit-disconnect/re-pair and stale-target rejection/fresh-snapshot
  recovery were subsequently reported passed by the Product Owner. This
  accepts the thin bridge spike, not the future executor/MCP action toolset.
- Previous extension baseline for reference: 146/146
  passing at last run (snapshot engine, overlays, CDP helpers,
  executor incl. baseline/effective-disabled/final-verification
  corrections, panel ownership regressions, question-context scoping,
  voice command normalization/lifecycle and panel voice/typed
  integration, the Feature #11 safety gate: confirmation holds,
  approval binding/expiry/consumption incl. dispatch-time expiry,
  SHA-256 submission-destination binding (fail-closed without Web
  Crypto), dispatch-boundary cancellation honesty, operation-scoped cancellation
  (Stop/Pause permanently invalidating in-flight work), sender-
  verified approval routing, sequential-harness stopping, log
  redaction, and synchronous final validation after the last async
  binding hash (mutations to disabled/detached/hidden targets during
  hashing are rejected with zero activations), and issue #29
  presentation coverage (Developer-view placement, held-focus
  behavior, outcome labels, scroll-region exclusion, highlighted-
  target word protection, plus the word-first pass: placement clear
  of controls and rendered text (normalized geometry + 3×3 hit-test
  sampling) with omission-to-list, short display labels with
  annotation stripping, Targets-list binding/owned-highlight/held
  marks, no active-target obstruction exception, list clearing on
  invalidation, and the snapshot-metadata page line). Re-run after any change; do not trust this number
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
  actions on live websites were not tested. MCP callers remain synthetic
  test callers. Issue #14 planner callers now have Product Owner-confirmed
  genuine-model evidence on the local demo survey, recorded below.
- Headless Chrome 156 evidence for issue #29 (`/tmp/spike-run/plain-evidence/`):
  word-first pass — product surface with Developer view closed,
  word tags placed clear of controls and rendered text (labels and
  the Contact preferences legend readable), dense Likert cluster
  omitted to the panel Targets list (marked “Shown in
  panel”; placement counts are no longer displayed, since they go
  stale as the page moves), panel fallback for a listed target (ring + full
  words in the panel, no forced badge), active target with ring +
  full-word tag where a clear spot exists, held
  confirmation in full brick (5.72:1 light, 10.37:1 dark, computed)
  with focus on the heading and “▲ held” in the list, dark theme,
  forced-colors treatment, real-Tab focus ring, 320 px and 200% zoom
  with no overflow. Earlier correction-pass evidence retained:
  Ready/Tags states, open Developer view with execution result and
  log, dark theme, forced-colors mode, Starting/Listening/Finishing
  states, cancelled-then-idle with a Ready chip, narrow-320/stacked
  command row, long-URL wrapping at 320 px, execution-failure state.
  Dense rating grids now omit to the list instead of converging to
  number dots.
  Later composition passes: matched-width (400 px) reference-versus-
  implementation Ready/Listening/Held comparisons, compact header
  and status, “View page targets” discovery button, and removal of
  stale placement counts (Tags chip is visibility-only). The latest
  pass restructures the panel to the reference hero (“Ready when
  you are.”, microphone pill, integrated Send row), integrates the
  status strip, moves Safety (Stop/Pause, confirmation) ahead of
  the Targets list, and puts microphone/speech settings in a
  collapsed secondary area; same-width/same-viewport (400×720)
  comparisons are `impl2-{ready,listening,held}-400x720` in the
  same evidence folder. A further visual-fidelity pass extracted
  the reference templates’ exact values (Jost 300 heading at
  34 px — the export bundles one Jost file for all weights, and
  the bundled copy is byte-identical — tonal borderless surfaces,
  104 px microphone pill, radii 22/28) and applied them; Ready now
  hides the empty transcript and disabled listening controls, the
  page-title fallback is “Current page”, and comparisons are
  `impl3-*`/`compare3-*` in the same folder with computed-style
  probes matching the reference. Visual acceptance is still
  pending the Product Owner’s headed review. Headless
  keyboard run reached targets and safety controls with visible
  3 px focus rings, and Enter activation of the native button was
  verified via CDP (one activation; focus moves to the Targets
  heading). Emulated forced-colors and reduced-motion render
  correctly. All of this is headless/emulated evidence.
  Pending before the design is accepted: Product Owner headed visual
  approval (real 320–420 px widths, actual 200% zoom, system dark
  theme, OS forced-colors, reduced motion, keyboard-only flows,
  long-name/error readability).
- Planner and the full MCP action toolset remain separate future work; #28's snapshot/highlight bridge is accepted.

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
- Dense grids no longer converge to number dots: the word-first pass
  omits crowded-out floating tags to the panel Targets list instead
  (sweep-based compaction removed); the highlighted target keeps its
  full words. The overlay still carries no collision engine and
  row/column labelling stays future planner work.
- Browser recognition initially heard "tags" as "tax" and "targets";
  successful recognition took about three attempts. Exact command matching
  remains intentional; no fuzzy aliases were added. Cancellation status
  wording was tightened in issue #29 (explicit too-late claims).
- The action log's trailing "approved" means human approval was supplied,
  even when a stale-state error prevented dispatch; since issue #29 the
  panel states that distinction explicitly in the confirmation area.
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
