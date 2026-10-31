# Issue #29 — Plain Words Product Interface and Overlay Refinement

The engineering panel is now the **D · Plain Words** product surface.
Behavior, contracts, permissions, messages, and safety logic are
unchanged; this issue restyles presentation and compacts dense
overlays. Design sources (packed exports, not modified):

- `DESIGN/Seeyable — D · Plain Words.html` — 8 product states.
- `DESIGN/Seeyable — D · Plain Words 2.html` — identity/word tags,
  side panel + gate, worst-case pages.
- `DESIGN/Seeyable — D · Plain Words 3.html` — tokens, type, spacing,
  motion, icons. Rendered and read directly in headless Chrome.

## Applied tokens and guidance

- Ink `#141414`, panel `#F2F2EE`, canvas `#E3E5E0`; amber `#F2B33D`
  for acting; brick `#B3401F` for held safety confirmation (white
  text in light theme, ink text on the pale brick in dark).
- Listening blue, sage done, warning text-only, pink/red error,
  legible disabled grays. Light is default; dark follows
  `prefers-color-scheme`. States always pair color with words/glyphs
  (`●` acting, `▲` held, `■` done, `×` failed, `?` unsure,
  `⊘` unavailable). No pulse anywhere; 120/200/320 ms motion with a
  `prefers-reduced-motion` kill-switch.
- Pill buttons/chips (52 px primary, 64 px gate actions, 44 px
  minimums), 22 px cards with 16 px row radius, 16/12/6 spacing.
- Jost (readable text) + DM Mono (numbers, short labels), bundled
  locally as latin woff2 under `apps/extension/fonts/` with their OFL
  licenses; system fallbacks (`Century Gothic`/system-ui,
  ui-monospace) if a face fails. No remote scripts, styles, or fonts;
  the exports' bundled runtime was not copied.

## Visual-fidelity pass — comparison table (extracted, not estimated)

Values below were read from the unpacked reference templates
(`DESIGN/Seeyable — D · Plain Words.html`, states 1/2/5) and from
the rendered export. The reference bundles exactly one Jost file
(26,588 B) for weights 300–600 and one DM Mono file; the bundled
`apps/extension/fonts/Jost-400.woff2` is byte-identical to it, so
declaring weight 300 with that file reproduces the reference’s own
rendering without synthesis.

| Reference property | Difference found | Exact correction |
|---|---|---|
| Hero heading: Jost 300, 34 px, lh 1.05 | 500 at 32 px — visibly too bold | Add Jost-300 face (same licensed file); heading 300/34/1.05 |
| Wordmark: DM Mono 17 px, regular | Jost 600, letter-spaced | DM Mono 400 at 17 px |
| Mic pill: 104 px min-height, 64 px icon circle, label 23/500 | 76 px pill, 52 px circle, 20/600 | Match 104/64; label 23 px weight 500 |
| Surfaces: canvas `#E3E5E0`, cards `#F2F2EE`, no card borders, radii 22/28 | White bordered cards, radii 16/22 | Tonal surfaces, borderless cards, radii 22 (page/safety) and 28 (hero) |
| Page card: `#F2F2EE`, padding 12/16, title 16/500, sub 13 px | White card, 600 title | Match; teal 22 px identity square retained |
| Ready layout order: brand → page → hero → mic → input → TRY | Status strip + snapshot-technical text in consumer view | Status strip slimmed to chip + short line; snapshot message rewritten in consumer words; revision stays in Developer meta |
| Ready shows no transcript / disabled Stop-Cancel | Empty transcript and disabled buttons sat between mic and input | Hide both while idle (CSS on `data-voice`); transcript hidden while it holds only the placeholder |
| Page title: compact real title | Raw `Tab <id>` fallback prominent | Fallback becomes “Current page”; full identity stays in Developer details |
| Input row: white pill, inset 1 px ring, Send 76×48 | Same shape, card-white context | Keep shape on tonal hero; proportions set to reference |
| Held: full-brick card, 34/400 title, 64 px actions | Brick card exists below hero | Keep contract; card already ahead of Targets (previous pass) |

## Product surface

- **Identity**: SEEYABLE wordmark, `~you` mode, Tags on/off chip
  (visibility only — placement changes as the page moves and the
  panel gets no live recount, so it carries no number), then a page
  identity card: tab title, and `domain · N controls` from snapshot
  metadata once bound (“No snapshot yet” before). Standard manifest
  renamed to “Seeyable” (debug variant keeps its DEBUG markers).
- **Current status (integrated strip)**: one derived state chip
  inline with the status text plus a latest-result line, directly
  under the identity header — no separate status card. States shown
  are only real ones: Ready, Starting/Listening/Finishing (voice
  phase), Acting/Working (an operation owns the panel), Held —
  nothing sent, Done (verified completion), Paused/Stopped, and
  errors (unresolved voice errors show “Needs attention” while the
  microphone phase stays idle).
- **Command hero (reference composition)**: “Ready when you are.”
  heading, brief truthful copy (only “show tags”/“hide tags” work),
  a substantial black microphone pill (local inline SVG mic symbol,
  “Start listening”), compact voice-state/transcript lines, small
  Stop/Cancel listening buttons (enabled only while recognition is
  active; distinct semantics unchanged), an integrated typed-request
  row with Send inside the same pill, TRY chips for the two
  supported commands only, and “View page targets” inside the hero.
  Microphone setup, Stop speech, Speak feedback, and the speech-
  service privacy disclosure live in a collapsed, keyboard-
  accessible “Voice and microphone settings” area inside the hero;
  the disclosure text is set on load whether or not it is opened.
  While listening, the card takes the listening-blue border and the
  meter bars animate (frozen under reduced motion). Deviations from
  the reference, each deliberate: no “Start talking / Alt+S”
  shortcut (none exists), no planner example prompts or placeholder
  (unsupported), the mode reads `~you` with state carried by the
  chip rather than `~ready`, and the Listening state keeps the hero
  layout with a blue border instead of the reference’s filled blue
  card (same controls, no layout shift).
- **Safety before Targets**: the Safety card now precedes the
  Targets card, so Stop/Pause and a pending confirmation never sit
  below the long target list. Confirmation focus still moves to its
  heading; binding, expiry, and redaction are unchanged.
- **Targets discovery**: the “View page targets” button inside the
  hero moves focus (and scroll) to the Targets heading.
  The Targets card explains that word tags float where there is
  room and the rest stay listed, marked “Shown in panel.” Every
  snapshot target is a button with its short word label, question
  context, and state marks; activation runs the existing ID-bound
  highlight and the active item shows the full label with
  `aria-current`.
- **Safety card** (always in the main flow): full-brick held
  confirmation with Approve once / Cancel, Stop/Pause/Resume, gate
  status. Approval focus moves to the confirmation heading — never
  straight to Approve — Cancel stays reachable, and focus returns to
  the invoking control afterward (not across tab changes).
- **Developer view** (`<details>`): snapshot/CDP controls, JSON
  tools, overlay visibility, highlight-by-number, manual execution,
  and the detailed log. Same controllers, moved not duplicated; the
  confirmation, gate state, Stop/Pause, and failures stay visible
  with it closed. Opening/closing or theme changes never touch
  requests, approvals, locks, or listeners.
- **Approval vs outcome**: a consumed approval whose action was
  rejected (e.g. stale) now says the human approval was supplied and
  consumed but the action itself did not complete — the log's
  `approved:true` + rejection code means exactly that.

Deliberate deviations: the page-level "held" pill on the target
itself (mockup "Submit · held") is not implemented — there is no
planner/action-state plumbing, and a second page-side registry for
gate states was judged out of scope and a safety smell. Held state
lives in the panel's brick card, which is always visible.

## Word-first pass: rules (proposed, then implemented as below)

Words lead; numbers stay as a quiet diagnostic dot on floating tags
and as the stable reference in the panel. No plan-only filtering, no
step lists, no disambiguation UI, no Activity/Settings tabs, no
keyboard shortcut, no "fill in this survey"-style example prompts —
none of those exist yet and the panel must not imply they do.

### Overlay placement/fallback

1. **Short labels** from existing metadata only: strip the known
   display annotation “(placeholder only)” (the snapshot keeps the
   accessible name, source, and identity); keep question context for
   duplicates/numeric names with the existing `?` uncertainty mark;
   cap length at a word boundary (~32 chars) for floating tags. Full
   names stay in the panel list and on the highlighted target. Never
   values, never invented meaning.
2. **Clear of the page**: each badge tries above, below, right, then
   left of its target (small gap). A spot must fit the viewport, avoid
   the target's own box, every other target's box, and every placed
   badge, and pass a conservative rendered-content check: a 3×3 grid
   over the candidate is hit-tested with `elementFromPoint`; a point
   is occupied when it lands on an interactive element (or inside
   one, or inside a label), on direct rendered text, or on shadow
   text. First clear spot wins. Limits: text strictly between sample
   points can be missed, and non-layout environments fall back to
   geometry only — this is sampled clearance, not proof that no pixel
   of page content is ever touched.
3. **Omit, don't pile**: a valid target with no clear spot gets no
   floating badge. Its id is reported as unplaced (overlay state,
   `SEEYABLE_SHOW_TAGS` response) and its label stays discoverable
   in the panel Targets list. The old compact-number fallback and
   convergence sweeps are removed — they produced the overlapping
   number piles this pass replaces.
4. **Highlight has no exemption**: the explicitly highlighted target
   is placed first but under the same clearance rules. When nothing
   is clear it keeps its ring on the page and its full word label in
   the panel (active row + status line) instead of text forced over
   the page. A held/confirmed target is marked in the panel list
   through the existing authoritative confirmation state.
5. Unchanged: pointer-event pass-through, aria-hidden host,
   snapshot/semantic exclusion, no pulse, reduced motion, scroll and
   scroll-container clipping, stale-target rejection, stable `el-N`
   identity, theme-independent ink tag with light ring.

### Panel composition (follows the Ready/Listening/Held references)

- Compact identity header: wordmark, mode, Tags chip; page line from
  snapshot metadata (`domain · N controls`) when bound, tab title
  otherwise. Standard manifest renamed to “Seeyable” (debug variant
  keeps its DEBUG markers).
- One prominent command area: primary Start listening, typed input +
  Send, compact transcript; Stop/Cancel listening, Stop speech,
  Speak toggle, and Microphone setup stay as smaller secondary
  controls with unchanged behavior. Suggestion chips offer only the
  two supported commands (“Show tags”, “Hide tags”) and dispatch
  them through the shared typed flow.
- Compact Targets list in the main flow: every snapshot target as a
  button (number · short words + question context + state marks;
  “Shown in panel” where no floating tag fit). Activating an item runs the
  existing ID-bound highlight; the active item shows the full label
  with `aria-current`. The list is presentation over the already-bound
  snapshot — no second registry, same session/revision/tab binding.
- Safety card behavior unchanged; the held card gains the reference's
  full-brick treatment (white-on-brick light, ink-on-pale-brick dark,
  both ≥ 4.5:1) with Approve/Cancel restyled to stay legible on it.
  Developer view, manual execution, log, and JSON tools unchanged.

## Deferred mockup states (not built)

Plan preview, Understanding/Thinking rows, Undo, agent-driving
banners, completed-workflow screens, plan-only/all-tags levels,
per-step rows, Map/error page pills. The interface never implies
form completion, planning, or undo exist.

## Overlay refinement (word-first pass)

- Tags are word-first ink pills with a light ring and a quiet number
  dot (secondary diagnostic). Floating labels are short (~32 chars,
  word-boundary) with question context for duplicates; display
  annotations such as “(placeholder only)” are stripped from display
  text only — the snapshot keeps the accessible name and source.
- Placement clear of the page: above, below, right, then left of the
  target with a small gap. A spot must fit the viewport, avoid the
  target's own box, every other target's box, and placed badges, and
  pass a 3×3 `elementFromPoint` content sample (interactive elements,
  labels, direct rendered text, and shadow text count as occupied).
  First clear spot wins. All placement math uses one normalized
  {left, top, width, height} shape — mixing {x, y} rects with
  {left, top} boxes once silently disabled neighbor exclusion.
- Omit, don't pile: a valid target with no clear spot gets no
  floating badge. It is reported as unplaced (overlay state and the
  `SEEYABLE_SHOW_TAGS` response) and stays discoverable in the panel
  Targets list marked “Shown in panel.” The old compact-number fallback and
  convergence sweeps are removed.
- The explicitly highlighted target is placed first but has no
  exemption: when nothing is clear it keeps its ring and its full
  word label in the panel instead of a forced badge. A held target
  is marked “▲ held” in the panel list from authoritative
  confirmation state (no page-side held pill — still a deliberate
  omission). Highlight responses are owned (tab, session, revision,
  generation, sequence): obsolete successes and failures are
  discarded, and an empty snapshot clears the visible list.
- Tags are skipped for controls fully outside their visible
  scroll-container region (nearest clipping ancestor per clipped
  axis), in addition to the existing viewport exclusion — no floating
  tags over unrelated content.
- Unchanged: stable `el-N` identity (never screen position), tag
  content from snapshot metadata only, pointer-event pass-through,
  accessibility-tree exclusion, snapshot exclusion, no pulse,
  reduced-motion handling, resize/zoom behavior.

## Verification

`npm --prefix apps/extension test` — 146/146 (reference-composition
pass adds a DOM-order regression: discovery and Stop/Pause and the
confirmation box precede the target list, and voice/microphone
settings start collapsed in the secondary area; word-first pass:
placement clear of controls and rendered text with omission-to-list,
short display labels, Targets list bound to the snapshot session,
held-card and composition rework; all 134 prior assertions intact).
Comparison evidence at the same content width (400 px) and the
same visible viewport height (720 px, initial viewport only), in
`/tmp/spike-run/plain-evidence/`: cropped references
`ref3-{ready,listening,held}-400x720`, implementations
`impl3-{ready,listening,held}-400x720`,
`compare3-side-by-side.png` (all three pairs plus a 50%-opacity
Ready overlay in the second row), and
`compare3-ready-pair.png`. Computed values probed in the live
panel match the extracted reference: heading Jost 300 at
34 px/35.7 px, wordmark DM Mono 17/400, microphone pill 104 px
with a 64 px icon circle and 23/500 label, Send 78×48, hero
`#F2F2EE` radius 28 padding 26/20/20, canvas `#E3E5E0`; all Jost
and DM Mono faces report `loaded`. Ready hides the voice-state
line, the empty transcript, and the disabled listening controls
(computed `display:none`); Listening fills the hero with the
reference blue and swaps the heading to “Listening”. Remaining
overlay-observed offsets are the slim status strip (state/outcome
line) pushing the hero down slightly and the taller microphone
pill at the reference’s own 104 px. Earlier full-page `impl-*-400`
shots are superseded for composition claims. Remaining
differences from the mockups are deliberate: no planner greeting or
“fill in this survey” examples (unsupported), no spoken-shortcut
hints on Stop/Cancel (saying those words is not a command), no
full-panel takeover or entered values in the held card (context
stays visible; redaction), and the page title falls back to a tab
id where no title is exposed. Narrow/zoom: `impl-narrow320` and
`impl-zoom200` (0 px overflow), `impl-dark` for dark theme.
Accessibility run (headless Chrome, CDP): `impl-keyboard-list`
(first Targets row focused, 3 px solid ring visible),
`impl-keyboard-targets` (“View page targets” focused), and
`impl-keyboard-safety` (Stop button focused after tabbing through
the list) — keyboard focus is visible and reaches targets and
safety controls. Button activation by Enter was verified through
CDP `Input.dispatchKeyEvent` including the `text` field: one
activation, focus moves to the Targets heading (without `text`,
CDP delivers the key but does not trigger native button
activation in headless Chrome — a harness artifact, confirmed on
a plain-page control button). `impl-forced-colors` (emulated
forced colors: system-button rendering, muted disabled controls,
blue focus ring retained) and `impl-reduced-motion` (emulated:
layout unchanged; animations/transitions computed as disabled).
These are headless/emulated checks, not OS-level verification.
Headless Chrome 156 evidence in `/tmp/spike-run/plain-evidence/`
(word-first):
`word-panel-overview` (identity line, primary Start listening, TRY
chips, Targets list, Developer closed),
`word-page-overview` (10 word tags placed on the demo survey, labels
and the Contact preferences legend fully readable, crowded-out
targets listed instead),
`word2-page` (dense Likert cluster: 1 floating word tag, the rest
omitted rather than piled),
`word2-panel` (Targets list with “Shown in panel” marks and
duplicate question context; placement counts are no longer
presented, since they go stale as the page moves),
`word5-panel-fallback` (a “Shown in panel” item activated: status names it
in words, active row shows the full label, ring only on the page),
`word3-page-active` (highlight ring + full-word tag on the active
target where a clear spot exists),
`word-panel-held` (full-brick held card, contrast 5.72:1 light /
10.37:1 dark by computation, Approve/Cancel restyled, focus on the
heading, “▲ held” in the Targets list),
`word-panel-held-dark` / `word-panel-held-forced` (dark treatment;
forced-colors Canvas/ButtonFace treatment with 2px borders),
`word-panel-focus` + `word-panel-tabfocus` (real Tab order reaches
controls; 3px focus ring computed and visible),
`word-panel-narrow` (320 px, 0 px overflow) and `word-panel-zoom`
(200% zoom, 0 px overflow).
Earlier correction-pass shots retained:
`panel-ready`, `panel-tags`, `panel-developer`, `panel-dark`,
`panel-forced-colors`, `panel-starting`, `panel-voice-denied`,
`panel-listening`, `panel-finishing`, `panel-cancelled`,
`panel-narrow320-longurl`, `panel-failed-exec`, `overlay-dense`
(now historical: dense grids omit to the list instead of number
dots). `panel-held`, `panel-narrow320`, `panel-zoom200` are
superseded by the word-first shots above. Before shots from earlier
passes: `/tmp/spike-run/panel-evidence/panel.png`,
`/tmp/spike-run/overlay-evidence/rating-tags.png`.

Pending Product Owner headed visual approval before calling the
design accepted: real 320–420 px widths, actual 200% browser zoom,
system dark theme, OS forced-colors/high-contrast, reduced-motion
setting, keyboard-only flows (voice controls, Developer execution,
approval/cancel, Stop/Pause), and body/status readability with long
names, errors, and multiline results. Headed microphone/audible
checks remain as previously reported.
