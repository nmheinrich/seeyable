# Plain Words panel polish (#31)

Status: **Slices 0 and 1 implemented; Product Owner headed check of Slice 1 pending.** Slices 2 to 5 not started.

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

## Evidence (stub model, headless Chrome, 2026-11-04)
- Extension 372/372, planner proxy 22/22, MCP 41/41, shared 11/11. Extension baseline before this work: 362.
- End-to-end 37/37, including real approval after the held target scrolled.
- Removing the Submit hold, Stop blocking, undo's edit check, the held-target scroll, or the overflow CSS each fails the end-to-end script. Removing the hold-notice clear, the Stop clear, the tab-switch rule, or local Activity time each fails its unit test.
- No test assertion was changed or removed; all test changes in this slice are additions.

**Not evidence of:** a real microphone, genuine Muse Spark, a screen reader, browser zoom, forced colors, live Codex or ChatGPT sessions, or Product Owner acceptance.
