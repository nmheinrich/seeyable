# Snapshot Schema (v2)

Production DOM/ARIA snapshot contract produced by
`apps/extension/lib/snapshot-dom.js`. The engine is UI-independent: it
uses no `chrome.*` APIs and can be consumed by the side panel, a future
executor, a planner, or tests without layout changes.

## Snapshot object

| Field | Type | Meaning |
|---|---|---|
| `schemaVersion` | number | `2` for this contract (`1` was the Issue #4 spike shape) |
| `kind` | string | `"dom-aria"` |
| `documentSessionId` | string | Random per-document session. Navigation/reload creates a new session and invalidates all prior references |
| `revision` | number | Monotonic per session. Increases when the semantic hash changes or the snapshot is explicitly invalidated |
| `semanticHash` | string | 16-hex-char hash of the normalized semantic content (see below) |
| `fresh` | boolean | `false` after a meaningful change is detected but before a re-snapshot |
| `url`, `title` | string | Document identity at capture time |
| `capturedAt`, `durationMs` | string, number | Capture timestamp and in-page build time (excluded from the hash) |
| `elementCount` | number | Number of interactive elements in `elements` |
| `structure` | object | Non-actionable `{ headings, landmarks }` context metadata |
| `diagnostics` | object | `{ candidateCount, excludedHidden, includedCount }` — why controls were excluded |
| `elements` | array | Interactive controls (below) |

## Element object

| Field | Meaning |
|---|---|
| `id` | Stable per-session ID (`el-N`). Assigned from the live DOM node identity, never reused for a different control in the same session |
| `role`, `name`, `nameSource` | Semantic role, accessible name, and which priority step produced the name (`aria-label`, `aria-labelledby`, `label`, `text`/`value`, `placeholder`, `title`, `none`) |
| `question` | The prompt the control answers, or `null`. Kept separate from `name`; never fabricated |
| `questionSource` | `fieldset-legend`, `group-aria`, `group-heading`, `container-heading`, `section-heading`, or `null` |
| `questionCertain` | `true` only for standards-based group relationships (legend, named ARIA group). Proximity inferences are `false` |
| `context` | Human-readable combination of question, heading, group, form, and landmark |
| `state` | Applicable `checked`, `selected`, `disabled`, `expanded`, `pressed`, `required`, `readonly`, `invalid`; plus `value` for non-sensitive fields, or `redacted` + `filled` for protected fields (raw sensitive values are never emitted) |
| `actionable` | Eligible for future execution: visible and neither disabled nor read-only |
| `actionableReason` | `null`, `"disabled"`, or `"readonly"` |
| `inViewport` | Whether the control intersects the viewport. Offscreen controls remain in the snapshot |
| `tag`, `domId`, `testId` | Underlying element descriptors |
| `cssPath` | Best-effort locator. A locator, **not** proof of identity |
| `rect` | Bounding rectangle when available (excluded from the hash) |

## Identity and reference safety

- IDs are bound to live DOM node objects (plus a structural fingerprint:
  tag, type, `id`, `name`, role). An unchanged control keeps its ID
  across snapshots, including when unrelated controls are added.
- A removed or replaced control's old ID resolves as `stale`
  (`detached-or-replaced` / `identity-changed`), never to the
  replacement, even if labels and CSS paths are identical.
- `engine.resolve(id, revision)` returns `ok`, `stale`, or `unknown`.
  A revision mismatch or an invalidated (`fresh: false`) snapshot also
  resolves as `stale`. Resolution is validation only; it performs no
  actions. The hash is a change indicator, not proof of executability —
  callers must still resolve identity at use time.

## Semantic change detection

- Normalized comparison fields per element: `id`, `role`, `name`,
  `question`, and relevant `state` (keys sorted). Timestamps,
  rectangles, locators, and incidental visual properties are excluded.
- `semanticHash` is a cyrb53-style double hash of the normalized JSON.
- Deltas are `{ added: [id], removed: [id], updated: [{ id, changedFields }] }`
  with `changedFields` drawn from `role`, `name`, `question`, `state`.
- A `MutationObserver` (child-list, character-data, and an allowlist of
  label/state attributes — `style` excluded, so the debug highlight
  cannot self-trigger) plus `input`/`change`/`click` listeners schedule
  a debounced (250 ms default) semantic check. Cosmetic mutations that
  do not change normalized content do not change the hash, revision, or
  freshness.
- If a change is detected but no full snapshot is available yet,
  `getStatus()` reports `fresh: false` with the pending delta in
  `lastDelta`, and reference resolution rejects prior revisions as
  stale. Callers should re-snapshot before use.
- Limits: native value/checked property changes do not always mutate
  attributes; the event listeners cover user-driven changes, but
  programmatic silent changes are only caught on the next check or
  re-snapshot. Re-snapshotting always reads live state.

## Example (sanitized, synthetic values)

```json
{
  "schemaVersion": 2,
  "kind": "dom-aria",
  "documentSessionId": "doc-example",
  "revision": 3,
  "semanticHash": "95fcc824020403f7",
  "fresh": true,
  "elementCount": 2,
  "elements": [
    {
      "id": "el-4",
      "role": "radio",
      "name": "1",
      "nameSource": "label",
      "question": "How was support?",
      "questionSource": "fieldset-legend",
      "questionCertain": true,
      "context": "question: \"How was support?\" · form: \"Feedback\" · landmark: main",
      "state": { "checked": false },
      "actionable": true,
      "actionableReason": null,
      "inViewport": true,
      "tag": "input",
      "domId": null,
      "testId": null,
      "cssPath": "form > fieldset > label:nth-of-type(1) > input",
      "rect": { "x": 8, "y": 120, "width": 16, "height": 16 }
    },
    {
      "id": "el-9",
      "role": "textbox",
      "name": "Account PIN",
      "nameSource": "label",
      "question": null,
      "questionSource": null,
      "questionCertain": false,
      "context": "form: \"Feedback\" · landmark: main",
      "state": { "redacted": true, "filled": true },
      "actionable": true,
      "actionableReason": null,
      "inViewport": true,
      "tag": "input",
      "domId": "account-pin",
      "testId": null,
      "cssPath": "input#account-pin",
      "rect": { "x": 8, "y": 240, "width": 200, "height": 24 }
    }
  ]
}
```

Example semantic delta (synthetic): after checking a radio option and
adding a field, `checkForChanges()` reports
`{ "added": ["el-12"], "removed": [], "updated": [{ "id": "el-4", "changedFields": ["state"] }] }`
and increments `revision` while marking the prior snapshot not fresh.
