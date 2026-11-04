# Project Status and Pending Verification

Last updated: 2026-11-04. This file records what is built, what has
actually been verified, and what still needs a human with a headed
browser. It is a status note, not a roadmap; scope decisions live in
the feature documents.

## Current state

| Area | State |
|---|---|
| Google Forms rehearsal and scope freeze (#16) | Accepted on Product Owner report, 2026-11-02: three runs worked. Detailed timings/transcripts were not supplied. Google Forms remains the primary demo; Shopify is excluded. Speech tuning and recovery/setup simplification are follow-up work — `docs/issue-16-google-forms-rehearsal.md` |
| Snapshot spike (DOM/ARIA vs CDP decision) | Complete — `docs/decision-snapshot.md` |
| Production snapshot engine (schema v2) | Complete — `docs/snapshot-schema.md` |
| Visual overlays (numbered word tags, ID-based highlight) | Complete — `docs/features/feature-07-visual-overlay.md` |
| Executor (single validated actions) | Complete — `docs/features/feature-08-executor.md` |
| Manual execution test panel | Complete — `docs/features/feature-09-manual-test-panel.md` |
| Voice front end and typed fallback | Complete and accepted — `docs/features/feature-10-voice-front-end.md` |
| Shared executor safety gate | Complete and accepted — `docs/features/feature-11-shared-safety-gate.md` |
| Plain Words product interface (#29) | Superseded on 2026-11-01 by the Plain Words panel issue — `docs/features/feature-29-plain-words-interface.md` |
| Plain Words panel polish (#31) | Slices 0 to 4 implemented and passed by the Product Owner in headed checks; Slice 5 implemented with stub-model evidence (extension 425/425, end-to-end 92/92), headed check pending; final check remains — `docs/features/feature-31-panel-polish.md` |
| Plain Words panel (supersedes #29) | Implemented 2026-11-01 from the approved mockup (frozen at `DESIGN/plain-words-panel-mockup-2026-11-01.html`); headed visual and voice acceptance PENDING. Extension 299/299; headless-Chrome stub-model typed runs 127/127 (states × 320/400/480 px × light/dark, forced colors, page tag states) and #15 regression 32/32 — `docs/features/feature-plain-words-panel.md` |
| Planner, proxy | Complete and accepted — Product Owner confirmed full canonical Act 1 typed then spoken on the corrected implementation, 2026-10-31; recognition remains imperfect — `docs/features/feature-14-muse-spark-planner.md`; loopback proxy, shared plan schema, guarded sequential execution, cached corrections; stub-model plumbing verified |
| Voice transcription spike (#12) | Timeboxed spike complete: INCONCLUSIVE / KEEP Web Speech — `docs/decision-voice-transcription.md`; zero provider takes; file-client mechanics verified offline (3/3); live comparison harness incomplete |
| Meta voice transcription (#30) | Checkpoint-ready for demo use, owner accepted 2026-11-04: live Meta speech verified, simple spoken fill passed, human Cancel left the field unchanged, fresh browser fallback passed without replay. Browser TTS retained; recognition still imperfect. Formal provider comparison and supplementary Spanish/approval corpus remain unmeasured. See `docs/features/feature-30-meta-voice-transcription.md`. |
| MCP bridge spike (#28) | Complete and accepted — `docs/features/feature-28-mcp-bridge-spike.md`; headed snapshot/highlight, 95-second idle/tab-switch checks, and Product Owner disconnect/re-pair/stale-target checks passed |
| Full local MCP server (#19) | Complete and accepted, 2026-11-02: Product Owner Inspector GUI snapshot/highlight/read/fill/click/select and held Submit/cancel checks passed; final automatic binding/tab-following/confirmation discovery passed without a tag toggle. Initial direct chat MCP calls verified. Cross-chat startup conflict fixed in code via one shared authenticated bridge (automated + real headless evidence; ChatGPT desktop headed check pending); full external-agent workflow remains #20 — `docs/features/feature-19-mcp-server.md` |
| External-client test — Act 2 (#20) | Complete and accepted using Codex Work chat, per owner-authorized substitution for Claude Desktop. Direct MCP workflow verified; Submit held once and human Cancel confirmed. English/Spanish voice checks owner-reported; numeric rating writes unsupported. Work-chat reconnection succeeded (17 tabs, 20-control snapshot); app quit itself not independently observed. Owner requested checkpoint. Evidence: `docs/evidence/act-2/headed-codex-acceptance.md`; headless supporting harness independently rerun 39/39. Claude compatibility not claimed. |
| Plan preview, confirmation, undo (#15) | Complete and accepted for the core mouse-free workflow — Product Owner confirmed genuine-microphone/model preview, voice edit, unsupported-approval retention, approval and last-change undo on 2026-10-31. Repeated Grace Hopper → Grasshopper recognition remains a limitation; supplementary headed safety probes are not claimed — `docs/features/feature-15-plan-review-undo.md` |
| Planner fast path (#13) | Checkpoint ready: headed typed exact/fuzzy fill, held Submit/cancel, compound rejection, clarification/expiry, five-choice access, single-error display, and live-mic click (one counter increment) passed. Voice fill remains limited by fill/feel/Phil recognition; full voice acceptance is not claimed — `docs/features/feature-13-local-command-fast-path.md` |
| Planner capacity experiment | Capacity raised to 20; owner reported the larger request worked after extension reload and requested checkpoint on 2026-11-04. Exact live action count/coverage not supplied; do not claim a 20-step live pass. Automated 20/21 boundary and 12-distinct-target runner checks pass. Timeouts unchanged; variable upstream planning latency remains a limitation. |

Issue #29 is superseded by the Plain Words panel issue (2026-11-01), which
implements the approved mockup; its notes below are historical. At #29's
parking, remaining work included reference-composition fidelity, headed
visual/accessibility acceptance, and a Listening-state input-label contrast
issue (dark text on blue, approximately 2.74:1); the new panel no longer
fills the card blue and computes ≥ 6.9:1 for Listening, while headed
visual/accessibility acceptance is still pending. The last
independently rerun suite passed 146/146; this does not constitute visual acceptance.
Issue #28's local MCP bridge smoke test is now complete and accepted.
Git staging, commits, and pushes remain with the Product Owner; the current
working tree also contains #29's deferred, visually unaccepted work.

Repository: `main` tracks `origin/main`. The standard extension build
requires no `debugger` permission; CDP remains debug-only via
`apps/extension/manifest.debug.json`.

## Verification evidence

- Demo checkpoint, 2026-11-04: owner accepted the current build after the
  larger request succeeded following extension reload. Live Meta
  transcription, cancellation, and fresh browser fallback were previously
  confirmed by the owner. Exact larger-plan action count was not reported.
  Speech processing logs: 3,943/1,583 ms; plan logs: 5,122/7,243 ms without
  repair, plus a separate 20,005 ms model timeout before headers. No latency
  fix, perfect recognition, formal comparison, or full 20-action live run
  is claimed. This supersedes pending-live wording in the historical notes
  below; supplementary probes remain separately bounded in the feature doc.

- Planning-latency diagnostics (follow-up): content-free correlated
  timing lines now cover Stop→final, fresh snapshot, panel→proxy
  receipt, each upstream call (headers vs full body), validation/repair,
  and response→preview, on failures as well as successes
  (`[seeyable-timing]` in the panel console, `timing=cmd-N` in proxy
  logs). Stub reproduction confirms upstream calls dominate and one
  repair adds another upstream call. Subsequent live timings are recorded
  above; no timeout/model/freshness behavior was changed. Live
  typed+spoken rerun steps are in
  `docs/features/feature-14-muse-spark-planner.md`.

- Issue #30 Meta transcription, 2026-11-03: production integration uses
  bounded mono WAV recording/upload through the existing planner proxy;
  provider is selected before capture and browser recognition remains
  the fallback. Mocked extension/provider tests cover fallback,
  after-capture no-replay, cancellation at selection/capture/upload/
  body phases, duplicate-final once, silence/oversize, cleanup, and
  stalled-body deadlines. Proxy tests cover pairing/origin, fixed
  upstream contract, WAV bounds, one-at-a-time transcription,
  readiness states, safe upstream errors, and disconnect abort. A
  headless Chrome transcript-only proof (fake microphone device, real
  extension scripts, real local proxy, stub Meta upstream) returned one
  final in 36 ms from Stop to stub final and logged no transcript; it
  was not connected to the command dispatcher. Review corrections then
  made recognition ownership attempt-bound (cancel during permission/
  selection, stale cleanup/final isolation), reserved proxy
  transcription admission before upload with a bounded upload deadline,
  loaded `meta-voice.js` in the panel/planner/plain-words/plan-review
  harnesses, and bound voice review authority to the plan/challenge
  shown at the intentional Start press. No live Meta request, natural
  microphone take, accuracy claim, or latency comparison was made.
  Product Owner headed English/Spanish, fallback, and Google Forms
  checks remain pending.

- Issue #20 accepted using Codex Work chat after explicit owner substitution
  for Claude Desktop. Direct MCP fills/select/clicks and snapshot verification
  passed; Submit held once, owner cancelled and confirmed no submission.
  Owner reported supplementary English/Spanish voice success and a numeric
  fill limitation. Work-chat reconnect calls succeeded; the app quit itself
  was not independently observed. Owner requested checkpoint. See
  `docs/evidence/act-2/headed-codex-acceptance.md` for evidence boundaries.
  This supersedes the preparation-stage pending-client notes below.

- Issue #20 Act 2 preparation, 2026-11-03: no production code changed.
  Suites rerun at baseline `b1e0192`: extension 334/334, MCP 41/41,
  shared 11/11, planner-proxy 15/15 (the proxy suite needed loopback
  listening permitted; its sandboxed `EPERM` setup failures were
  environmental). A custom stdio client drove the real MCP server,
  shared bridge, real extension, and demo survey in headless Chrome
  through the canonical Act 2 sequence: exact tab selection, redacted
  PIN snapshot, highlight, four verified fills, exact-value Designer
  select, state-aware SMS/Monthly clicks, protected-write rejection,
  approval-field rejection, one Submit held with zero dispatch,
  automatic panel-page confirmation adoption, harness-triggered Cancel
  only, audit source `mcp`, background explicit-tab snapshot, Stop/Resume
  no-replay, reload stale-session rejection, and closed-tab failure —
  39/39. The earlier panel screenshot error was a harness artifact
  (the harness had activated its own extension-page tab); the repo
  harness now loads the panel page in the background and the replacement
  capture shows a successfully bound demo tab. This is supporting
  evidence only: Claude Desktop was installed
  (4.4212.0) with an existing config file, but was not launched,
  read, or modified by the engineer. At that preparation stage, genuine Claude Desktop and
  headed side-panel acceptance were pending (superseded by Codex acceptance above) — see
  `docs/act-2-external-client.md` and `docs/evidence/act-2/`.

- Shared-bridge headed follow-up, 2026-11-02: fixed bridge running;
  extension paired using the existing configured token. This chat's
  real `list_tabs` succeeded (16 tabs), and the Product Owner confirmed
  the other chat worked without another pairing. The cross-chat startup
  blocker is resolved in this headed check. Three-chat snapshots,
  close-one isolation, and forced bridge restart were not individually
  itemized by the owner; their automated/headless evidence remains
  separate. Full external-agent workflow remains #20. Latest independently
  rerun MCP suite: 41/41; extension last verified 334/334, unchanged.

- Shared-bridge review follow-up, 2026-11-02: both reviewer-reproduced
  findings are corrected (uncommitted). Peer requests now carry their
  issue-time `expiresAt` through the hub, which refuses missing/expired
  deadlines and never extends them (reviewer repro: execute frames after
  timeout 1 → 0). First-token creation now publishes atomically via
  temp file + non-overwriting `link()` (reviewer repro: concurrent reader
  failure → complete token, converged). New regressions: delayed-delivery
  zero-dispatch, live slow-hop success keeping the original expiry,
  clamp/missing/past expiry, deterministic paused-creator/reader and
  8-way concurrent token tests. Stress testing found and fixed two
  timing-fragile TESTS (fixed-delay frame reads; an unhandled-rejection
  ordering) and that a failed test could hang its file; `npm test` now
  has a per-test timeout. No live credentials or the running ChatGPT
  server were changed during that review. The later headed follow-up
  above supersedes its pending-restart status.

- External-client follow-up, 2026-11-02: new chats failed MCP
  initialization because every stdio process bound loopback 6123 before
  answering `initialize`; later processes hit `EADDRINUSE`, re-emitted
  unhandled by the WebSocketServer (exit 1). Not a token or OAuth issue.
  **Fixed in code (not committed):** stdio processes answer `initialize`
  first and join ONE shared, detached bridge process per port
  (`apps/mcp-server/bridge-daemon.mjs`, `lib/shared-bridge.mjs`,
  `lib/hub-launch.mjs`) over an HMAC-authenticated loopback peer link;
  one extension pairing serves all chats; extension unchanged. Evidence:
  MCP 35/35 (21 prior + 10 in-process shared-bridge + 4 real multi-process
  with a scripted extension), extension 334/334, and a real headless
  Chrome + real extension + real stdio processes run 19/19 (concurrent
  start, one listener, shared pairing, close-one-keeps-other, held Submit
  cancelled, bridge SIGKILL → automatic recovery, no replay). Against the
  live pre-fix ChatGPT process on 6123 a fixed process initialized and
  reported `PORT_CONFLICT` without touching it. ChatGPT desktop multi-chat
  use is still **unverified** until the Product Owner quits ChatGPT and
  runs the headed steps in `docs/features/feature-19-mcp-server.md`.

- Issue #19 (full local MCP server): extension 334/334, MCP 21/21,
  shared 11/11, proxy 15/15. Headless real-browser run (custom stdio
  client, not an Inspector GUI run): 27/27 on the demo survey — all
  six tools, sensitive-fill rejection, Submit held with zero dispatch,
  panel card adoption, approve-once, cancel. Reviewer corrections
  landed for editable-content section leaks, post-timeout delayed
  dispatch (bridge-carried deadlines), and cross-tab confirmation
  discovery. Product Owner Inspector GUI checks passed: Google Forms
  snapshot/highlight/bounded section read/fill, Get advice and Checkout
  rating clicks; demo exact-value select and held Submit/cancel.
  The final headed re-check confirmed automatic panel-open binding,
  tab-following, and Submit confirmation discovery/cancellation without
  the earlier tag-toggle workaround. Issue #19 accepted 2026-11-02.
  This chat also directly exercised MCP discovery, snapshot, and a held
  Submit; no human approval was supplied. No planner-model call was
  needed. The full multi-step external-agent workflow remains #20;
  headed approve-once/sensitive-write probes are not claimed.
  See `docs/features/feature-19-mcp-server.md`.

- Issue #16 final follow-up (2026-11-02): the Product Owner reported
  “Three runs works fine” and requested #19 next. This supersedes the
  earlier pending-three-runs notes below. Record three successful headed
  runs as human-reported acceptance, without inventing timing, transcript,
  retry, or per-step measurements. Speech recognition remains imperfect.
  Scope is frozen to the Google Forms workflow in the rehearsal note;
  diction tuning, automatic snapshot/page recovery, and proxy/setup
  simplification are parked follow-ups, outside #19.

- Issue #16 genuine-form follow-up (2026-11-02): after the final
  classification correction, the Product Owner reported “Works very well”
  in response to the genuine Google Form rating/held-Submit/card spot-check
  instructions, and requested a checkpoint and continuation. Record this
  as human-reported spot-check acceptance, not three complete rehearsals.
  Individual zoom measurements and raw transcripts were not supplied.
  The three-consecutive-clean-run record and written scope freeze remain
  pending; this checkpoint does not declare #16 complete. #19/#20 are the
  next implementation work; Shopify remains outside the demo scope.

- Issue #16 blockers fixed 2026-11-02 (rehearsal streak restarts at 0/3 on
  this build): survey rating radios whose names quote a "Checkout
  experience" row no longer trigger the gate — each label source of a
  selection control may shed only a trailing reference to its structural
  row ("…, response for Checkout experience"); group text anywhere else is
  kept, buttons/links keep full-label checks under any role, and native
  submit evidence wins (two earlier, broader fixes were rejected in review
  and removed) — and the confirmation card is concise with Approve/Cancel
  ahead of an expandable Details area. Extension 315/315; shared 11/11, proxy 15/15, MCP 11/11. Real headless
  Chrome (local Google-Forms look-alike, scripted model, typed): 40/40
  incl. a held Delete checkbox with zero dispatches, 320/400 px, emulated
  200% zoom, light/dark; Plain
  Words run 127/127 and #15 run 32/32 re-passed. These counts are
  automated/stub evidence. The later genuine-form spot-check is recorded
  above; the full three-run acceptance is still pending —
  `docs/issue-16-google-forms-rehearsal.md`.

- Plain Words panel (supersedes #29), 2026-11-01 — automated and headless
  only; headed acceptance PENDING. `npm --prefix apps/extension test`
  299/299 (279 prior with deliberate migrations for the merged Stop/Resume,
  Tags toggle, and screen structure; +15 panel, +4 overlay tag states, +1
  tag-state routing); shared 11/11, proxy 15/15, MCP 11/11. Token contrast
  computed from the stylesheet passes in both themes (Listening now ≥ 6.9:1).
  Headless Chrome with the real extension, overlay, proxy and a SCRIPTED
  upstream (typed, no microphone): 127/127 across states, widths, themes,
  and forced colors, plus the #15 run 32/32 on the new UI. Not
  genuine-model, genuine-microphone, browser-zoom, screen-reader, or
  Product Owner visual evidence.

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
