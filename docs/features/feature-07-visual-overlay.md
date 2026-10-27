# Feature 7 — Visual Overlay (numbered word tags + target ring)

Readable page tags showing a word label and the stable snapshot number,
plus ID-based highlighting of a chosen target. Developer controls only;
no executor actions are performed.

## Behavior

- **Tags**: one dark badge (`#141414` background, `#F2F2EE` text) per
  snapshot control that currently has a usable visible rectangle in the
  viewport. The word label comes only from snapshot metadata; the number
  is parsed from the stable schema-v2 ID (`el-22` → `22`). IDs — never
  array positions — are the only identity. Controls scrolled out of view
  keep their identity and are tagged again when they return.
- **Labels**: accessible name first. Repeated or purely numeric names
  gain their question context (`How was support? · 1`). Uncertain
  (proximity-inferred) questions are suffixed with `?` and never
  presented as verified. Nameless controls fall back to `role + number`.
  Field values are never read for labels. Labels truncate at 72 chars.
- **Ring**: a separate overlay ring (light `#F2F2EE` border with a dark
  outer edge) drawn around the target's *current* measured bounds. It is
  not an inline outline on the target. Highlighting works while tags are
  hidden, scrolls the validated node into view (including nested scroll
  containers, via `scrollIntoView`), and follows document/container
  scrolling and resizing until replaced or cleared.
- **Invalid targets**: replaced, removed, detached, or identity-changed
  nodes lose their badge on refresh and reject highlight requests as
  stale. Unknown IDs and wrong document sessions are rejected with
  distinct errors. Nothing is silently retargeted. A debounced (300 ms)
  MutationObserver in the overlay refreshes on relevant page changes,
  and the highlighted target is revalidated by identity on every
  refresh — removing it clears its tag and ring without any scrolling.
  Badge text is rebuilt from current descriptors on every refresh, so
  renamed controls show their new label with the same number.
- **Safety**: the overlay never intercepts pointer events, never focuses
  anything, never modifies values, and never triggers page actions. The
  host is `aria-hidden` with shadow-DOM content, so it stays out of the
  page's accessibility reading order. Snapshot collection excludes the
  overlay subtree, and the engine's observed attributes exclude `style`,
  so overlay rendering cannot feed back into semantic invalidation.
- **Motion/contrast**: brief opacity transitions only, no pulsing.
  `prefers-reduced-motion` disables transitions and makes highlight
  scrolling instant. `forced-colors` switches badges/ring to system
  colors. Placement uses live CSS-pixel geometry, so browser zoom is
  respected.

## Interfaces (content-script messages)

DOM nodes stay inside the content-script context; messages carry only
IDs and plain data.

| Request | Response |
|---|---|
| `{type:"SEEYABLE_SHOW_TAGS"}` | `{ok:true, shown, total, revision, documentSessionId}` — snapshots now, then shows tags |
| `{type:"SEEYABLE_HIDE_TAGS"}` | `{ok:true, shown:0, total}` — ring unaffected |
| `{type:"SEEYABLE_HIGHLIGHT_ID", elementId, documentSessionId, revision}` | `{ok:true, highlighted}` or `{ok:false, error}`: wrong session (expected vs got, re-snapshot), unknown ID, or stale reference (gone/changed, re-snapshot) |

The legacy CSS-path highlight message was removed; `cssPath` is a
locator, not an identity. The engine gained one internal method,
`resolveNode(id, revision)`, which applies the same validation as
`resolve()` and returns the validated live node for measurement only.

Refresh behavior: badge/ring positions update in one
`requestAnimationFrame` batch per scroll (capture-phase, so nested
containers count), resize, show, or highlight, plus one settle refresh
after smooth scrolling and one debounced refresh after relevant DOM
mutations. No polling and no full re-snapshot on scroll.

Placement: badges sit above their control, clamped with their actual
measured size. The number is a non-shrinking flex item, so label
truncation can never consume it. If a badge would cover an
already-placed badge (tightly spaced controls), it falls back to a
compact number-only badge. Controls fully offscreen on either axis get
no badge — no edge badges.

## Files

- `apps/extension/lib/overlay.js` — label builder, overlay controller
- `apps/extension/lib/snapshot-dom.js` — `resolveNode`, overlay exclusion
- `apps/extension/content.js` — message handling and session ownership
- `apps/extension/sidepanel.html` / `sidepanel.js` — Show/Hide buttons,
  number-based highlight input (uses the latest snapshot's session and
  revision)

## Limitations

- Simple placement (above the control, clamped to the viewport); no
  collision engine, so tightly stacked controls can have overlapping
  tags.
- Badge visibility is viewport-based at refresh time; controls in
  closed shadow roots or cross-origin frames are not tagged.
- A highlight ring persists until another highlight, hide is *not* a
  ring clear — hiding tags leaves the ring; page navigation destroys
  both with the document context.

## Verification

Automated (DOM-level; they prove identity/label/lifecycle, not visual
layout): `npm --prefix apps/extension test` — overlay suite covers
stable numbers across refresh/additions, replaced/removed/unknown/
wrong-session rejection, metadata-only labels without values,
show/hide/highlight-while-hidden lifecycle, reduced-motion scrolling,
and overlay exclusion from snapshots/invalidation.

Browser checks: load the extension, open the demo survey
(`apps/demo-survey/index.html`) or the rating fixture
(`apps/extension/tests/fixtures/rating-form.html`), run a DOM snapshot,
Show tags, Hide tags, then highlight an offscreen target number and
confirm the ring appears around the intended control after scrolling.
On pages with nested scrollers, scroll the container after
highlighting and confirm the ring stays aligned. Marketplace-style
pages: scrolling alone is not a pass — the ring must be seen around
the intended control.
