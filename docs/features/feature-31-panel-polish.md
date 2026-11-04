# Plain Words panel polish (#31)

Status: **Slices 0 to 3 implemented. Product Owner passed the headed checks of Slices 1 and 2; the headed check of Slice 3 (including an agent action while on Settings) is pending.** Slices 4 and 5 not started.

Goal: make the panel feel finished without changing what Seeyable can do or who can approve an action.

## Guardrails
- `lib/executor.js`, `packages/shared/plan-schema.js`, `lib/plan-schema.js`, `lib/bridge-client.js`, `apps/mcp-server`, and the safety-gate tests do not change.
- All four test suites and the end-to-end script pass before each commit. No safety assertion is weakened.

## Slice 0: end-to-end regression script
`npm --prefix apps/extension run test:e2e` drives the real extension in a genuine Chrome side panel with the real executor, planner proxy, MCP stdio server, and demo survey. Only the model is stubbed. It uses free ports and a temp copy of the extension that differs by one host permission, and never touches 6123 or 6124. Assertions read page values, submit counts, visibility, and MCP statuses rather than wording.

## Slice 1: trust fixes
- **State flags:** panel logic no longer reads display text. A guard test keeps those comparisons out.
- **Developer view overflow:** a long page URL no longer scrolls the screen sideways. The snapshot line wraps and shows host and path only; the full URL stays in the snapshot JSON.
- **Stale status:** "Held: waiting…" is removed when the hold ends, and the outcome is reported once in `confirmStatus`. The next command or Stop clears that outcome. An error from another tab gives way to a good snapshot, but work discarded by a tab switch stays reported.
- **Activity:** local time, plain words, and target names. Unknown error codes read "did not complete", never as success.
- **Held actions:** a held target not fully in view scrolls to the centre of the page. The gate shows a visible countdown; screen readers get one description, not one announcement per second. The executor still enforces expiry.

## Slice 2: words, recovery and undo
- **Plain status:** executor codes, diffs, revisions and internal ids left the status line and live in the Developer view (`execResult`, `execStatus`), now including typed and voice commands. "Not verified" keeps its meaning: "Clicked Save draft. I can't confirm the page responded, so please check it." Planner context keeps the raw outcome strings, so plans are unaffected.
- **Recovery card:** an unpaired or unreachable planner shows the mockup's "I can't plan that yet" card with Open Developer view, replacing the command-line text. A new command, Stop, or the button clears it.
- **Examples:** the input hint and Try chips come from a real empty text field, offered only if the on-device resolver would pick that exact field. Never sensitive, disabled, read-only or filled fields, never Submit. Chips only fill the input. Page names reach the DOM as text only.
- **Unavailable page:** a new `unavailable` view, after held actions and Stopped in priority. Chrome, extension, file and Web Store pages explain themselves with no Reload; an ordinary finished page without the content script offers Reload with the unsaved-data warning. A page still loading is never called unavailable. Presentation only: the executor's checks are unchanged.
- **Navigation:** a finished load in the shown tab now binds it through the existing read-only automatic path, so the panel leaves the unavailable view without being reopened. Other tabs are ignored and nothing is approved or replayed.
- **Undo:** the Done view names the target ("Undo Short bio") and says what stays. The name appears only if the plan's last step really changed that target, since a verified no-op leaves the executor's earlier record in place. It is dropped on a new command, Stop, tab change or New request, and whenever the agent bridge is wanted or its state is unknown.
- **Undo phrases:** "undo that" and "undo it" are accepted as exact matches. Bare "undo" stays rejected: the accepted #15 test `review phrases (#15)` pins it, and that assertion was kept.

### Slice 2 test changes
Twelve assertions moved from old wording to the new wording, each keeping its meaning; eight also gained a check that the raw code or reason remains in the Developer view.
- `panel.test.mjs`: fallback snapshot message, Tags shown, typed click success, unsupported parse list, disabled target, sensitive fill, paused executor, empty command, unavailable tab.
- `planner.test.mjs`: unpaired request (now also asserts the card), step failure, rejected sensitive fill.
- `tests/e2e/plain-words-regression.mjs`: fixed a harness race. The panel-reload wait could read the old page, which auto-binding now made likely; it waits for the reloaded document. 20 checks added.
- `plain-words.test.mjs`: harness options only, plus 21 new tests.

## Evidence for Slice 2 (stub model, headless Chrome, 2026-11-04)
- Extension 393/393, planner proxy 22/22, MCP 41/41, shared 11/11. End-to-end 57/57, twice in a row, including a real `chrome://` page, a real tab with no content script recovered by the Reload button, and agent gate checks.
- Thirteen deliberate breaks in a scratch copy each failed the expected test: no-op naming, bridge naming, held priority, loading verdict, chip sending, chip markup, secret field example, Alt+S on unavailable, raw code in status, missing Developer detail, missing phrase, missing rebind, background-tab rebind.
- The off-limits files have no diff against `9e50c8e`.

## Slice 3: Stop and Undo placement
The full table is in `feature-plain-words-panel.md`. Edit and which-one were not in the approved table, so they keep Stop pinned. Stopped hides Undo because the executor refuses it there. The panel follows `bridgeWanted` live through `storage.onChanged`; `lib/bridge-client.js` already clears it on Disconnect, so no status check was needed. Keyboard: the DOM moves with the buttons, so Tab order matches what is seen, and focus follows a moved button or falls to the current nav item if the button left the screen.

Test changes: three assertions that pinned the old bar to "outside the screens" (`plain-words.test.mjs` screens and gate tests, `panel.test.mjs` composition test) now assert `#gateStatus` and the pinned slot stay outside, Stop stays on Assist when idle, and Stop sits below the gate decision and outside the alertdialog. Eleven tests added, one per table row plus unknown bridge state, unavailable page, and focus. End-to-end gained 15 checks, using real layout positions.

Evidence (stub model, headless Chrome, 2026-11-04): extension 404/404, planner proxy 22/22, MCP 41/41, shared 11/11, end-to-end 72/72 including an agent's hold arriving on Settings, a reopened panel, and live Disconnect. Eight deliberate breaks each failed the expected test: agent not pinned, Undo with an agent, in-progress not pinned, Undo while stopped, unknown bridge treated as none, no live bridge updates, Tab order, focus. Off-limits files have no diff against `9e50c8e`.

## Evidence for Slices 0 and 1 (stub model, headless Chrome, 2026-11-04)
- Extension 372/372, planner proxy 22/22, MCP 41/41, shared 11/11. Extension baseline before this work: 362.
- End-to-end 37/37, including real approval after the held target scrolled.
- Removing the Submit hold, Stop blocking, undo's edit check, the held-target scroll, or the overflow CSS each fails the end-to-end script. Removing the hold-notice clear, the Stop clear, the tab-switch rule, or local Activity time each fails its unit test.
- No test assertion was changed or removed; all test changes in this slice are additions.

**Not evidence of:** a real microphone, genuine Muse Spark, a screen reader, browser zoom, forced colors, live Codex or ChatGPT sessions, or Product Owner acceptance.
