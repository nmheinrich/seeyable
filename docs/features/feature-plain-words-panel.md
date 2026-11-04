# Plain Words side panel (supersedes #29)

Status: **implemented; automated and headless-Chrome evidence only.
Headed Product Owner visual acceptance and the mouse-free voice run on the
new layout are PENDING.** Baseline: `8b83ab2` (#15 committed and accepted).
Issue #29 (parked 2026-10-30, never visually accepted) is superseded by
this work.

Visual source of truth:
- Frozen reference: `DESIGN/plain-words-panel-mockup-2026-11-01.html`
  (copy of the approved mockup, version 2).
- Approved mockup: https://claude.ai/artifact/G54qAExrMmhZS2xskib1hG
- D · Plain Words canvas (tokens, word tags):
  https://claude.ai/artifact/RgzBFUr5bvdWymn4czrDwH

## Product Owner decisions applied
1. A new issue replaces #29.
2. **Undo button is always enabled**; with nothing to undo the executor's
   honest refusal is shown. No executor contract change.
3. **Stop and Pause are one Stop/Resume control** worded "Stopped". It
   sends the executor's `stop` and performs every panel-side cleanup that
   Stop and Pause each did. The executor keeps `pause`; the panel no longer
   uses it.
4. **Alt+S** starts talking while the panel has focus, never while a text
   input, textarea, select, or editable element has focus (so macOS
   Option+S still types "ß"). Panel page only; no `chrome.commands`.
5. **Page tag states** (acting / done / held) are included.
6. **Light and dark** themes, following the system setting.
7. Reference frozen in `DESIGN/`.

## What changed

| File | Change |
|---|---|
| `apps/extension/sidepanel.html` | New structure: header (wordmark, mode, state chip, Tags toggle, page card, status), scrolling screens (Assist / Targets / Activity / Settings), safety bar (Stop/Resume, Undo, gate status) and screen nav outside the scroll. Main card holds every state. Developer view moved, unchanged, under Settings › Advanced. |
| `apps/extension/sidepanel.css` | Rewritten on the canvas tokens (light + dark), exclusive colour roles (amber acting, brick gate, sage done, blue listening), state-driven visibility via `body[data-view]`, forced-colors and reduced-motion rules. |
| `apps/extension/sidepanel.js` | View derivation (`currentView`), screens (`showScreen`), step progress (`runPlanSteps` wrapper → `runPlanStepsInner` unchanged), merged Stop/Resume, Tags toggle, Undo button, speak prompts, Alt+S, listening phrase hints, Activity list, tag-state messages. Copy that pointed at a "Safety section" now refers to the main card. |
| `apps/extension/lib/overlay.js` | `setTargetStates()`: acting / done / held on word tags (glyph + colour + word), a state ring when tags are off, done states clear after 4 s. Placement rules unchanged. |
| `apps/extension/content.js` | `SEEYABLE_TAG_STATE`, trusted side panel only, current document only. |
| Tests | New `tests/plain-words.test.mjs` (15); overlay (+4) and content-gate (+1) tag-state tests; deliberate migrations listed below. |
| `DESIGN/plain-words-panel-mockup-2026-11-01.html` | Frozen reference copy. |

## Control inventory (every former control is reachable)

| Former control / output | Now |
|---|---|
| `tagsChip` (span), `btnTryShow`, `btnTryHide` | `tagsChip` is a header toggle button with `aria-pressed`; same typed `show tags` / `hide tags` flow. Developer view keeps `btnShowTags` / `btnHideTags`. |
| `stateChip`, `status`, `latestResult`, page card | Header (unchanged IDs). |
| `btnListen` (Start listening) | Main card "Start talking" (same ID, same handler). |
| `btnStopListen` (Stop listening) | Same ID, shown as the blue "Done talking" button in place of Start while the microphone is live. |
| `btnCancelListen` | "Cancel — discard what I said", shown while live. |
| `voiceState`, `voiceTranscript`, `voiceMeter` | Main card, unchanged behaviour. |
| `commandInput`, `btnSendCommand` | Main card, every state. |
| `clarifyBox`, `planBox`, `planEditBox` and their buttons | Main card (unchanged IDs/handlers); plan review gains the speak prompt. |
| `confirmBox` (gate) + `btnApproveOnce`, `btnCancelChallenge`, `confirmStatus` | Main card as an `alertdialog`; title names the held action; voice approval prompt below it. |
| `btnStopExec` + `btnPauseExec` | One `btnStopExec` (Stop ⇄ Resume) in the always-visible safety bar. |
| (voice/typed "undo last change") | Also `btnUndo` in the safety bar. |
| `gateStatus` | Safety bar; announced always, shown on error only (the Stopped card carries the message). |
| `btnViewTargets`, `targetsHeading`, `targetList` | Ready view button opens the Targets screen. |
| `voiceSettings` (`chkSpeak`, `btnStopSpeech`, `btnMicSetup`, `voiceNote`) | Settings screen (open by default). |
| `developerView` and all its controls (snapshots, JSON tools, tags, MCP bridge, planner pairing, highlight, manual execution, action log) | Settings › Advanced, unchanged IDs and handlers. |
| Action log | Developer view (raw) and the new Activity screen (plain words, values never shown). |

## State model (presentation only)

`currentView()` derives one name from state the panel already owns, in
priority order: `gate` (held challenge) → `listening` (voice phase) →
`plan` (pending preview) → `edit` → `repair` (clarification) → `acting` /
`working` (command or execution in flight, with or without step progress)
→ `stopped` (gate closed) → `done` (last plan fully verified) → `ready`.
CSS reads `body[data-view]`; the function never touches ownership, locks,
plan binding, voice-approval binding, or approval authority.

- **Screens** are sections toggled by `showScreen()`. Anything needing a
  decision (plan preview, clarification, held action) brings Assist back,
  so a decision is never hidden behind Settings. The safety bar and nav are
  outside the scrolling screens: Stop/Resume and Undo are visible on every
  screen, in every state (Stop also stays available when idle — it closes
  the gate for MCP agents too).
- **Step progress**: `runPlanSteps` wraps the unchanged sequential runner
  (`runPlanStepsInner`). It renders done/now/next from the same validated
  steps and words the review showed; a run that completed with every step
  verified becomes the Completed list. Stopped, failed, unverified, held,
  or discarded runs never show the Completed card.
- **Live regions**: `#status` announces command outcomes; `#voiceState`
  the microphone only (#14 rule); `#latestResult` the execution outcome —
  so `#execStatus` (Developer view) is no longer a live region. Progress,
  result, and phrase lists are not live regions.

## Stop and Undo placement (Product Owner decision, 2026-11-04, #31)

This replaces the always-visible safety bar in the frozen mockup; the mockup
itself stays frozen. Same buttons, IDs, and handlers, moved between slots by
`placeSafety`. `#gateStatus` stays outside the screens and is announced from
any of them. Older statements in this document describe the original layout.

| State | Stop and Undo |
|---|---|
| Idle, no agent | Quieter, below the listen button on Assist; not on other screens |
| Talking, nothing running | Stop hidden, so it cannot be mistaken for finishing: "Done talking" and Cancel cover the microphone. Undo hidden too, since pressing it would discard the speech; saying "undo that" still works |
| Planning, acting, edit, which-one, or a command still running as the microphone closes | Stop pinned on every screen; Undo disabled while acting |
| Plan review | Below the plan controls |
| Held action | Below the gate card |
| Done | Undo by the result, Stop below; not on other screens |
| Stopped | Resume is the card's main action, no Undo (the executor refuses it); header chip says Stopped on other screens |
| Agent bridge connected, wanted, or not yet known | Stop pinned on every screen in every state, no Undo button |

## Stop/Resume

Stop: discards a plan under review (with its own status line), cancels
live recognition, bumps the interaction (so pending planning or snapshot
acquisition can never dispatch), aborts the planner request, clears
choices, cached corrections, the Completed view, and page tag states,
then sends `stop`; the executor revokes pending approvals and
permanently invalidates undispatched work. The discard outcome is shown
once, in `#status` ("execution was stopped; …"); `#voiceState` keeps
reporting only the microphone. Resume sends `resume` and replays nothing.

## Tag states on the page (Phase 4)

- The panel sends the complete picture for the current step over
  `SEEYABLE_TAG_STATE` (trusted side panel only; wrong document refused):
  step *i* acting, earlier steps done; a fully verified run → all done; a
  held step → held (with earlier verified steps done); a failed, stopped,
  unverified, or discarded run → cleared. Stop and tab/document changes
  clear them. Plan review paints nothing.
- Overlay: `● acting` (amber, ink border), `■ done` (sage, verified only,
  clears after 4 s), `▲ … · held` (brick, with the word "held") — colour,
  glyph, and word, theme-independent. With tags off, a single state ring
  outlines the held (priority) or acting target.
- Placement is unchanged: stated targets are placed earlier in order but
  get no exemption from clearance against controls, placed tags, and
  rendered text; when nothing is clear the tag is omitted and the target
  stays in the Targets list. Stale or replaced targets show no state.

## Deliberate test migrations
- Pause clicks → the merged `btnStopExec`; "paused" wording → "stopped";
  gate stubs answer `stop` with `stopped: true` (planner ×4, plan-review ×2,
  panel ×3). The former Pause acquisition test now asserts the merged
  control sends `stop`, never `pause`.
- `btnTryShow` → `tagsChip`; View page targets now opens the Targets
  screen (focus still lands on its heading).
- The composition test now asserts the screen structure (safety outside
  the scroll, gate in the main card, settings/Developer view on Settings).
- No safety, ownership, or approval assertion was removed or weakened.

## Evidence

Automated (deterministic; stubbed tab messaging, recognition, planner):
- `npm --prefix apps/extension test` — **299/299** (279 prior, incl. the
  migrations above; +15 Plain Words panel, +4 overlay tag states, +1
  tag-state routing). Mutation checks: removing the Alt+S text-field
  exclusion or showing Completed for any outcome each fails a test.
- `packages/shared` 11/11, `apps/planner-proxy` 15/15, `apps/mcp-server`
  11/11.
- Token contrast (computed from `sidepanel.css`, both themes): all text
  pairs ≥ 4.5:1 and control edges ≥ 3:1; Listening label now 6.9:1 light /
  10.3:1 dark (the old 2.74:1 issue is gone because the whole card is no
  longer filled blue). Fixed overlay/gate colours ≥ 5.7:1.

Headless Chrome (real Chrome, unpacked extension, content script,
executor, overlay, planner proxy, demo survey; **scripted upstream instead
of Muse Spark; typed commands; no microphone**):
- #15 review/undo regression run on the new UI: 32/32.
- Plain Words run: 127/127 — Ready, Plan, Done, Gate, Stopped, Which one?,
  Targets, Activity, Settings at 320 / 400 / 480 px in light and dark with
  no horizontal scroll and correct action colours; neutral review chip;
  speak prompt; real done tags on the page that clear after 4 s; Undo
  button restoring the full prior Short bio; held ring on Submit; gate
  title "Click “Submit survey”?"; forced colors without overflow; a real
  Alt+S key event reaching the start path (headless reports no microphone).
  Screenshots were produced in the session scratchpad (not committed).
- Note: the first captures looked dimmed because headless Chrome does not
  advance CSS transitions in a background tab; captures now emulate reduced
  motion and colours are also asserted numerically.

**Not evidence of:** genuine microphone, genuine Muse Spark, real browser
zoom, a screen reader, or the Product Owner's visual acceptance.

## Headed acceptance — PENDING
1. Visual: compare each state with the frozen reference (Ready, Listening,
   Plan, Edit, Acting, Gate, Completed, Which one?, Stopped, errors,
   Targets, Activity, Settings) in light and dark, at a narrow and a wide
   panel; browser zoom 200%; forced colors.
2. Keyboard only: Tab order, visible focus, focus lands on the plan title /
   gate title / screen headings; Alt+S outside text fields.
3. Voice, mouse-free, on the demo survey (#15 script): start with Alt+S
   or the speak prompts only — wrong value → "Edit plan: …" → "Approve
   plan" → "Undo last change".
4. Stop during planning and during a held action, then Resume: nothing
   replays; tag states clear.
5. Tags on during a plan: acting then done tags; done fades after 4 s;
   held tag on Submit; nothing forced over page text.

## Limitations
- The bundled Jost files are one variable font, so the light display weight (300) renders for real; no separate file is needed.
- The progress list and Completed list cover planned runs; local
  fast-path commands report through the status line only.
- Speech recognition quality is unchanged.
