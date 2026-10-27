# Spike #4 — DOM/ARIA vs CDP AXTree snapshots

Target page: `apps/demo-survey/index.html` (mixes `label[for]`, wrapping
`<label>`, `aria-label`, `aria-labelledby`, placeholder-only, title-only,
fieldset/legend groups, switch, disabled/expanded states, and two hidden
controls that must not appear).

Sample outputs (same page, both captured by clicking the buttons in the
extension's side panel loaded in headless Chrome 156; `sidepanel.png` is
that run):

- `dom-snapshot.json` — DOM/ARIA payload exactly as the panel produced it
  (schema v2, 20 elements, real layout `rect`s, PIN state
  `{"redacted": true, "filled": true}` — raw value never emitted).
- `cdp-snapshot.json` — CDP payload exactly as the panel produced it:
  simplified interactive nodes under `nodes` (35), full raw
  `Accessibility.getFullAXTree` tree under `raw` (120 nodes).

## Verification (headless E2E, 2026-10-27)

The MV3 extension was loaded via CDP `Extensions.loadUnpacked`
(branded Chrome ≥132 ignores `--load-extension`) into headless Chrome
against `apps/demo-survey/index.html` served on `127.0.0.1`. Harness
notes: the panel document was opened as a tab (headless has no
side-panel chrome), and the test copy granted the loopback origin
directly because headless cannot perform the toolbar click that grants
`activeTab` in real use — shipped manifests and all JS are untouched.

- **Snapshot via DOM/ARIA** → `DOM/ARIA snapshot done: 20 interactive
  elements.` (~5 ms snapshot time in-page).
- **Snapshot via CDP AXTree** → `CDP snapshot done: 35 interactive
  nodes (120 total).` Raw tree included.
- Frame responsiveness across both runs (demo page `requestAnimationFrame`
  meter): 65 fps after the DOM run, 63 fps after the CDP run, max frame
  gap 16.8 ms, zero gaps over 100 ms. No jank from either snapshot.
- This E2E caught a real bug the jsdom run had masked:
  `buildDomSnapshot()` shadowed the global with
  `const document = … typeof document …`, a TDZ ReferenceError on the
  no-arg content-script path. Fixed in `lib/snapshot-dom.js`.

## How to regenerate

- DOM: load the extension, open the demo survey, click
  **Snapshot via DOM/ARIA** → Download JSON.
- CDP: load `manifest.debug.json` (the standard build declares no
  `debugger` permission), then click **Snapshot via CDP AXTree**. The panel payload matches
  `cdp-snapshot.json`'s shape.

## Comparison (measured on the sample files above)

### Coverage

- DOM/ARIA found **20** visible interactive elements; both hidden controls
  (`hidden` button, `display:none` subtree) were correctly excluded.
- CDP returned **120** AX nodes, of which **35** pass the extension's
  interactive-role filter — including **11 nameless `generic` nodes** and
  **4 combobox `option`s** the DOM walker folds into the `<select>` entry.
  All **20/20** DOM-named controls appear in the CDP output with identical
  names, and the hidden controls are absent there too.
  The AX tree additionally contains non-interactive structure
  (RootWebArea, headings, StaticText, containers) that the DOM walker
  deliberately skips — useful context, more noise to filter.
- Placeholder-only (`Nickname…`) and title-only (`How did you hear…`)
  inputs: **both** paths name them (Chrome's AccName also falls back to
  placeholder/title). Only the DOM snapshot flags them as weak via
  `nameSource` — a CDP consumer cannot tell a `<label>` name from a
  `title` name without extra provenance work.

### Label quality

- DOM snapshot records `nameSource` per element, so weak names are
  auditable: `label` ×10, `text` ×6, `aria-label` ×1,
  `aria-labelledby` ×1, `placeholder` ×1 ⚠, `title` ×1 ⚠ on this fixture.
- CDP names come from Chrome's real AccName computation — authoritative
  where our simplified 6-step chain diverges (e.g. name-from-content
  subtleties; `aria-describedby` is not a name source in either). On this
  fixture the pairwise name diff is empty (20/20 identical), so the
  simplified chain is sufficient for well-labelled pages; re-diff on a
  messy real page before trusting it further.
- CDP `state` is richer in places (e.g. `editable`, `focusable`,
  `labelledby` relations) and the raw tree does **not** leak the PIN
  value (`1234` absent from `raw`) — but the DOM walker's explicit
  `[REDACTED]` marker makes the safety posture auditable per element.

### Context quality

- DOM entries carry a synthesized `context` string
  (`h2: "Extras" · group: "Contact preferences" · form: … · landmark: main`)
  built from heading/legend/form/landmark ancestors — planner-ready prose.
- CDP nodes carry only `parentId`/`childIds`: equivalent context must be
  reconstructed by walking the tree to heading/group ancestors. Doable,
  but it is extra code the DOM path gets almost for free from `closest()`.

### Mapping back to real DOM elements (executor prerequisite)

- DOM: each entry has `cssPath` (+ `domId`/`testId`/`rect`). The side
  panel's highlight box resolves a `cssPath` with one `querySelector` —
  verified pattern, zero extra round-trips. Weakness: `cssPath` can go
  stale after DOM mutation; re-snapshot before acting.
- CDP: 93/120 nodes carry `backendDOMNodeId`, not a selector. Resolving
  one needs a second CDP round-trip (`DOM.pushNodesByBackendIdsToFrontend`
  or `DOM.resolveNode`) while the debugger is attached — and holding the
  debugger open shows Chrome's debugging banner and blocks DevTools.
  That friction is the main cost of a CDP-primary design.

### Cost / product constraints

- DOM path: `activeTab` + `scripting` only, no banner, works from the
  content script. CDP path: `debugger` permission (debug variant
  only — Chrome forbids it as an optional permission), attach/detach
  lifecycle, DevTools conflict.
- Redaction: the DOM walker redacts password/payment-like values
  (`state.value: "[REDACTED]"`). The raw AX tree does not redact for us;
  a CDP pipeline needs its own redaction pass before anything leaves the
  page context.

## Recommendation for the snapshot format

Keep the **DOM/ARIA snapshot as the primary contract** (planner-facing ids
`el-N`, role/name/state/context, `cssPath` for the executor), and keep CDP
as a **debug/cross-check tool** behind `manifest.debug.json`. Revisit only
if real-page testing shows the simplified AccName chain missing names that
Chrome's AX tree gets right on well-labelled pages.
