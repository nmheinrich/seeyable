# Architecture Decision: Snapshot Mechanism (Issue #4)

- **Status:** Approved for documentation. DOM/ARIA is Seeyable's primary
  snapshot mechanism; CDP remains debug-only.
- **Date:** 2026-10-27
- **Evidence:** `docs/spike/README.md`, `docs/spike/dom-snapshot.json`,
  `docs/spike/cdp-snapshot.json`, `docs/spike/sidepanel.png`
- **Scope note:** This decision covers snapshot capture only. The
  planner, executor, MCP server, and voice UI are separate components.

> Reading guide: statements marked **[measured]** were observed in the
> test environment described in §3. Statements marked **[anticipated]**
> are expectations for production that have **not** been measured yet.

## 1. Problem being evaluated

Seeyable must turn an arbitrary webpage into a labelled list of callable
controls that (a) a planner may reference only by ids present in the
current snapshot, and (b) an executor can later resolve back to real DOM
elements safely. This evaluation compared the two
candidate ways to build that list:

1. **DOM/ARIA snapshot** — a content script walks the page DOM, selects
   visible interactive elements, computes role/accessible-name/state,
   synthesizes context, and records a DOM locator per element.
2. **CDP AXTree snapshot** — the extension attaches `chrome.debugger`,
   enables the Accessibility domain, and reads Chrome's own accessibility
   tree via `Accessibility.getFullAXTree`.

Evaluation questions: coverage, accessible-name (label) quality, context
quality, difficulty of mapping results back to real DOM elements,
permission/UX cost, and performance.

## 2. DOM/ARIA versus CDP comparison

| Dimension | DOM/ARIA **[measured]** | CDP AXTree **[measured]** |
|---|---|---|
| Coverage | 20 visible interactive elements; hidden controls excluded | 120 AX nodes; 35 pass the interactive-role filter, incl. 11 nameless `generic` + 4 `option` nodes |
| Accessible names | 20/20 controls named; source recorded per element (`nameSource`) | 20/20 identical names; no name-source provenance |
| Name quality signal | Weak names flagged (`placeholder` ×1, `title` ×1 on the fixture) | A `<label>` name and a `title` name are indistinguishable without extra work |
| Context | Planner-ready string per element, e.g. `h2: "Extras" · group: "Contact preferences" · form: "Demo survey form" · landmark: main` | Only `parentId`/`childIds`; heading/group context must be reconstructed by tree-walking |
| State | Relevant state only (`checked`, `disabled`, `expanded`, `required`, …); password/PIN value redacted to `"[REDACTED]"` | Richer in places (`editable`, `focusable`, `labelledby`); raw tree did not contain the PIN value, but carries no explicit redaction marker |
| Map back to DOM | `cssPath` (+ `domId`/`testId`/`rect`) resolved with one `querySelector`; highlight path exercised | `backendDOMNodeId` on 93/120 nodes; resolving requires a second CDP round-trip (`DOM.pushNodesByBackendIdsToFrontend` / `DOM.resolveNode`) while the debugger is attached |
| Permission / UX | `activeTab` + `scripting`; no banner; works from the content script | `debugger` permission; attach/detach lifecycle; Chrome debugging banner while attached; conflicts with open DevTools |
| Performance | ~5 ms in-page snapshot time on the fixture **[measured, §3]** | ~11–19 ms for `getFullAXTree` in the same environment **[measured, §3]** |

Full per-control data: `docs/spike/dom-snapshot.json`,
`docs/spike/cdp-snapshot.json`; narrative: `docs/spike/README.md`.

## 3. Measured results and environment

**[measured]** — headless E2E, 2026-10-27:

- Browser: Google Chrome 156.0.8078.48, headless (`--headless=new`),
  macOS (Apple Silicon), extension loaded via CDP
  `Extensions.loadUnpacked` (branded Chrome ≥132 ignores
  `--load-extension`).
- Page: `apps/demo-survey/index.html` (20-control technical test
  fixture, see §8) served over `http://127.0.0.1:8765`.
- DOM/ARIA: side-panel button → **20 interactive elements**; all 20
  accessible names identical to CDP's; both hidden controls excluded;
  PIN state value `"[REDACTED]"`; in-page snapshot time ~5 ms;
  real layout `rect`s present.
- CDP AXTree: side-panel button → **120 nodes, 35 interactive**;
  pairwise name diff against DOM/ARIA: **empty (20/20)**; the PIN value
  `1234` does not appear anywhere in the raw tree.
- Responsiveness: demo-page `requestAnimationFrame` meter during both
  runs — 65 fps after DOM, 63 fps after CDP; max frame gap 16.8 ms;
  zero gaps over 100 ms.
- Defect found and fixed by this E2E (invisible to the jsdom run):
  `buildDomSnapshot()` in `lib/snapshot-dom.js` shadowed the global
  `document` (`const document = … typeof document …`), a TDZ
  `ReferenceError` on the no-argument content-script path. The side
  panel fallback in `sidepanel.js` was also hardened to fail with an
  explicit error instead of dereferencing a null result.

**Harness limitations (do not over-read the numbers):** the panel
document was opened as a browser tab because headless Chrome has no
side-panel chrome, and the test copy pre-granted the loopback origin
plus the debug manifest's `debugger`, because headless automation
cannot perform the toolbar action click that grants `activeTab` in
normal use. Shipped manifests and all extension JavaScript were
byte-identical to the repo copies. The ~5 ms / ~11–19 ms figures are
single-page, warm-cache, 20-control numbers. **[anticipated]** Real
pages with thousands of DOM nodes will be slower for both paths; no
production performance claim is made yet, and large-page profiling is
future validation work, not an Issue #4 result.

## 4. Decision and technical rationale

**Decision: DOM/ARIA is the primary snapshot mechanism for Seeyable.
CDP AXTree remains available only as a debug cross-check (via
`manifest.debug.json`; the standard build declares no `debugger` permission) and must
not become a product dependency without a new decision.**

Rationale, in order of weight:

1. **Executor mapping is direct.** Snapshot entries carry `cssPath`,
   `domId`, and `rect`; resolution is one `querySelector` in the page.
   CDP's `backendDOMNodeId` needs a second protocol round-trip with the
   debugger held open — the exact session the product should not hold.
2. **Label quality is auditable.** `nameSource` distinguishes a real
   `<label>` from a `placeholder`/`title` fallback, which is the
   signal a planner/safety layer needs to distrust weak controls.
   CDP returns equally authoritative names but no provenance.
3. **Context is planner-ready for free.** Heading/fieldset-legend/
   form/landmark context falls out of `closest()` walks in the DOM.
   The AX tree encodes the same facts only as parent/child relations.
4. **Permission and UX cost is minimal** (see §5).
5. **No measured quality deficit.** On the fixture, the simplified
   6-step accessible-name chain (aria-label → aria-labelledby →
   associated `<label>` → inner text/value → placeholder → title)
   matched Chrome's AccName output on all 20 controls. **[anticipated]**
   Messier real-world pages may expose divergence; the debug CDP path
   exists precisely to re-diff when that is suspected.

The decision should be reopened only if new evidence shows a
substantial blocker — e.g. the simplified name chain systematically
missing names Chrome computes correctly on real target pages, or
DOM-walk cost becoming prohibitive on representative pages.

## 5. Debugger-permission and browser UX considerations

**[measured + documented platform behavior]**

- The default `manifest.json` declares `debugger` in **no form**.
  (Headed testing proved why: Chrome rejects `debugger` in
  `optional_permissions` with "Permission 'debugger' cannot be listed
  as optional", and an earlier optional-permission draft also crashed
  service-worker registration via unguarded `chrome.debugger` access.
  Both are fixed; the service worker now guards every `chrome.debugger`
  use.) The normal DOM/ARIA workflow therefore never prompts for it and
  never shows Chrome's "started debugging this browser" banner; the
  panel's CDP button explains the debug-variant requirement instead.
- The CDP path requires attaching `chrome.debugger` to the tab. While
  attached, Chrome displays the debugging banner, and attachment fails
  or is disrupted when DevTools is already open on that tab. The
  service worker always detaches in a `finally` block to avoid a
  stuck banner; a leaked attach is treated as a bug.
- `manifest.debug.json` (debugger as a required permission) exists
  solely to make CDP testing prompt-free during development. It is
  clearly marked and must not be shipped: a required `debugger`
  permission materially increases install friction and user concern
  for zero product benefit under this decision.
- **[anticipated]** `activeTab` in normal use is granted by the user's
  toolbar/side-panel interaction, keeping host access scoped to
  explicit user action. This interaction has **not** yet been verified
  in a headed browser (headed-browser status is tracked with the verification evidence).

## 6. Known limitations

- **Simplified AccName, not the spec.** The 6-step chain omits
  name-from-content subtleties, shadow-DOM and iframe traversal, and
  ARIA details (`aria-describedby` is not a name source). Parity with
  Chrome was measured on one well-labelled 20-control fixture only.
- **`cssPath` stability.** Locators can go stale after DOM mutation;
  the spike re-snapshots rather than tracking references (see §7).
- **Single-page, single-browser evidence.** Chrome 156 headless,
  file/HTTP loopback, no cross-origin frames, no shadow roots, no
  virtualized lists.
- **Snapshot size/perf uncharacterized at scale.** CDP payloads with
  `raw` are ~135 KB for a 20-control page; DOM payload ~10 KB.
  **[anticipated]** Both grow on real pages; budgeting is future work.
- **Redaction is heuristic.** Password type and name/id/autocomplete
  patterns (`cc-`, `card`, `cvv`, …) are redacted; novel sensitive
  field conventions may not match (see §7).
- **Visibility model.** Computed-style/ancestor checks approximate
  "visible"; off-screen-but-rendered and clipped elements are a gray
  zone the fixture does not probe.

## 7. Follow-up requirements (future work, not implemented here)

1. **Stable element identification** — ids that survive re-snapshot
   better than positional `el-N` + `cssPath`.
2. **Stale snapshot and element-reference detection** — fail loudly
   when a referenced element is gone or replaced, never act on a
   stale node.
3. **MutationObserver integration** — detect page changes that
   invalidate a snapshot and trigger/require refresh.
4. **Repeated accessible-name disambiguation** — multiple controls
   sharing one name (e.g. several "Delete" buttons) must be
   distinguishable to planner and user.
5. **Dynamic conditional controls** — controls that appear, enable,
   or change meaning based on prior input must be re-snapshotted and
   re-labelled correctly.
6. **DOM-to-executor element resolution** — the production, resilient
   version of the spike's `cssPath`/`querySelector` resolution
   (fallbacks, uniqueness checks).
7. **Sensitive-value redaction** — harden the heuristic redaction into
   a tested safety-gate guarantee for password/payment data before
   any snapshot leaves the page context.

## 8. Test fixture status

`apps/demo-survey/index.html` is the 20-control **technical test
fixture used for this evaluation** (see `apps/demo-survey/README.md` for
full provenance). It is a test fixture, not a demonstration page;
no demonstration page has been selected yet. An earlier ~42-control
survey design was a proposed specification that was never implemented
and is not part of this codebase.

## 9. References

- Spike narrative and comparison: `docs/spike/README.md`
- Raw evidence: `docs/spike/dom-snapshot.json`,
  `docs/spike/cdp-snapshot.json`, `docs/spike/sidepanel.png`
- Implementation: `apps/extension/` (start at
  `apps/extension/README.md`)
