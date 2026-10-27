# Seeyable — Snapshot Spike (extension)

MV3 extension that captures a labelled snapshot of a page's interactive
controls using DOM/ARIA, with an optional debug-only CDP comparison.
It exists to evaluate snapshot approaches; it contains no planner,
executor, voice UI, or MCP server.

## Load it

1. Open `chrome://extensions`, enable Developer mode.
2. **Load unpacked** → select this folder (`apps/extension`).
3. Default path uses `manifest.json`: permissions are
   `activeTab`, `scripting`, `sidePanel`, `storage`. No `debugger`
   permission is declared in any form (Chrome forbids it as an optional
   permission); the CDP button explains this in-panel. This is the
   product-shaped path. Permission rationale: `CHROMEWEBSTORE.md`.
4. **Debug variant** (`manifest.debug.json`): identical except `debugger`
   is a required permission, so CDP testing needs no prompt. Chrome shows a
   “Seeyable started debugging this browser” banner while attached.
   To use it, copy it over `manifest.json` in a throwaway checkout
   (`cp manifest.debug.json manifest.json`) and reload. **Never ship it.**

## Use it

1. Serve/open the demo survey (`apps/demo-survey/index.html`, any static
   server or `file://`).
2. Click the extension action to open the side panel.
3. **Snapshot via DOM/ARIA** — content-script snapshot
   (`lib/snapshot-dom.js`, injected via `scripting` as a fallback).
4. **Snapshot via CDP AXTree** — service worker attaches `chrome.debugger`,
   runs `Accessibility.enable` + `Accessibility.getFullAXTree`, detaches,
   and the panel shows the simplified interactive nodes plus the raw tree.
5. Copy/Download the JSON. Paste a DOM entry's `cssPath` into the highlight
   box to flash the real element on the page (mapping-back probe).

## Files

| File | Role |
|---|---|
| `manifest.json` | Default MV3 manifest (no debugger permission) |
| `manifest.debug.json` | Clearly-marked debug variant (debugger required) |
| `background.js` | Service worker: side-panel behaviour + debugger lifecycle |
| `content.js` | Content script: DOM snapshot + highlight message handlers |
| `lib/snapshot-dom.js` | DOM/ARIA walker: role, accessible name (aria-label → aria-labelledby → label → text → placeholder → title), state, context, `cssPath` mapping |
| `lib/snapshot-cdp.js` | AXTree simplifier (`simplifyAxTree`, `interactiveOnly`) |
| `sidepanel.html/.js/.css` | Debug UI: the two snapshot buttons + JSON viewer |

## Snapshot shapes

DOM/ARIA snapshots use schema v2 — full contract, identity rules, and
change-detection semantics: `docs/snapshot-schema.md`. Element entry:

```json
{ "id": "el-1", "role": "textbox", "name": "Full name", "nameSource": "label",
  "question": "About you", "questionSource": "section-heading", "questionCertain": false,
  "context": "question: \"About you\" · form: \"Demo survey form\" · landmark: main",
  "state": { "required": true }, "actionable": true, "actionableReason": null, "inViewport": true,
  "tag": "input", "domId": "full-name", "testId": null, "cssPath": "input#full-name",
  "rect": { "x": 0, "y": 0, "width": 0, "height": 0 } }
```

IDs are stable within a document session; removed/replaced controls
resolve as stale via the content-script `SEEYABLE_RESOLVE_ID` message.
The snapshot header carries `documentSessionId`, `revision`,
`semanticHash`, and `fresh` so consumers can detect stale data.

CDP simplified node:

```json
{ "nodeId": "42", "parentId": "7", "ignored": false, "role": "textbox",
  "name": "Full name", "backendDOMNodeId": 123, "childIds": [], "state": { "required": true } }
```

Protected values (password, payment, government-ID fields) are never
emitted; DOM snapshots carry `state.redacted: true` with a `filled`
indicator instead. Run tests with `npm test` in this folder.
Sample outputs + comparison notes: `docs/spike/`.
