# Act 2 evidence bundle

This folder contains supporting headless evidence and a separate
[headed Codex acceptance record](headed-codex-acceptance.md) for Issue #20.
The owner authorized Codex Work chat in place of Claude Desktop; Claude
was not tested.

## Evidence sources

| Source | What it proves | What it does not prove |
|---|---|---|
| Automated suites | Executor, bridge, MCP schema, deadline, no-replay, redaction, and safety contracts | A real external client's behavior |
| `headless-custom-stdio-results.json` | The canonical workflow crossed the real MCP stdio server, shared bridge, real extension, executor, and demo page in headless Chrome | Claude Desktop, Inspector GUI, or headed side-panel acceptance |
| `act2-headless-e2e.mjs` | The exact sanitized harness that produced the JSON and screenshots, so the 39-check run can be reproduced | Any genuine-client or human evidence |
| `demo-completed-headless.png` | The page independently showed the fictional fills, Designer selection, SMS updates, and Monthly digest after MCP calls | That Claude Desktop issued those calls |
| `panel-held-confirmation-headless.png` | The replacement panel-page capture from a successfully bound demo tab: “Found 20 controls on this page,” held card visible, no stale snapshot failure | Headed visual acceptance; the capture is a panel page in a tab, not the genuine Chrome side panel |

No pairing token, Meta API key, challenge ID, or synthetic PIN value is
recorded in this bundle. The PIN appears only as browser-masked dots in
the demo screenshot and as `redacted: true, filled: true` in JSON.

## Independent headless run

Date: 2026-11-03. Environment: headless Google Chrome 156.0.8078.80,
real unpacked Seeyable extension, real `apps/mcp-server/server.mjs` over
stdio, custom JSON-RPC client, local demo survey. This is explicitly
**not** Claude Desktop and **not** an Inspector GUI run.

Result: **39/39 checks passed.**

Canonical sequence observed:

1. `list_tabs` found the exact local demo tab.
2. `page_snapshot` returned 20 controls, revisioned session binding, and
   Designer option metadata (`Designer` label with exact value
   `designer`).
3. Account PIN snapshot state was `{ redacted: true, filled: true }`.
4. `highlight` marked Full name without changing it.
5. `fill` returned `verified` for Full name, Work email, Nickname, and
   Short bio; the page independently showed Ada Lovelace,
   ada@example.com, Pioneer, and the fictional bio sentence.
6. `select` used exact value `designer` and returned `verified`; the page
   showed Designer.
7. State-aware `click` calls selected SMS updates and Monthly digest;
   both returned `verified` and the page showed both selected.
8. A protected PIN fill was `rejected` with `SENSITIVE_FIELD`; the field
   remained unchanged.
9. A fill carrying an approval-shaped extra field was rejected at the
   MCP schema before execution.
10. One Submit `click` returned `held_for_approval`; the page submit
    counter stayed at 0. No challenge ID was returned to the client.
11. The confirmation card appeared automatically after activating the
    bound demo tab. A **harness-triggered Cancel** clicked the card's
    Cancel button through CDP; the card cleared and the submit counter
    remained 0. This makes no human-confirmation claim.
12. The panel action log recorded the hold as an `mcp` click with
    decision `confirmation-required`.
13. An explicit snapshot of the demo tab succeeded while another tab was
    active, proving no silent retargeting.
14. Stop rejected a new MCP fill with `EXECUTION_STOPPED`; Resume alone
    dispatched nothing.
15. After reload, the old document binding was rejected with
    `WRONG_SESSION` and wrote nothing.
16. A closed disposable tab returned `TAB_UNAVAILABLE`; the demo tab
    still served explicit snapshots.

Representative snapshot excerpt from the JSON evidence (fictional data):

```json
{
  "documentSessionId": "doc-cv0vqe51mw1gexx3",
  "revision": 8,
  "elementCount": 20,
  "elements": [
    { "id": "el-1", "role": "textbox", "name": "Full name",
      "state": { "required": true, "value": "Ada Lovelace" } },
    { "id": "el-5", "role": "textbox", "name": "Account PIN",
      "state": { "redacted": true, "filled": true } },
    { "id": "el-6", "role": "combobox", "name": "Your role",
      "state": { "value": "Designer", "options": [
        { "label": "Designer", "value": "designer" },
        { "label": "Engineer", "value": "engineer" },
        { "label": "Product manager", "value": "pm" }
      ] } },
    { "id": "el-20", "role": "button", "name": "Submit survey", "state": {} }
  ]
}
```

The machine-readable result is
[`headless-custom-stdio-results.json`](headless-custom-stdio-results.json).
It records tool/status events and check results, not raw credentials or
protected values.

## Reproduce the 39-check run

Prerequisites: Node.js, Python 3, and Google Chrome. From the repository
root, install the MCP server's already-declared dependencies once, then
run the harness:

```sh
npm --prefix apps/mcp-server ci
node docs/evidence/act-2/act2-headless-e2e.mjs
```

Set `CHROME_BIN` if Chrome is not at the default macOS path. Set
`ACT2_EVIDENCE_DIR` only if you want the JSON/PNG outputs written
somewhere other than this directory.

What the harness sets up itself:

- It starts Python's HTTP server on an ephemeral loopback port with
  `apps` as the directory, so the fixture URL is its own temporary
  `/demo-survey/index.html` address (not the Product Owner's 8765 tab).
- It starts the real `apps/mcp-server/server.mjs` over stdio on another
  ephemeral loopback port. The pairing token is generated in memory for
  that run, kept in the child-process environment and the isolated panel
  page, and never printed or written to evidence.
- It launches headless Chrome with a fresh temporary profile, loads the
  real unpacked extension, opens the demo tab, and opens
  `sidepanel.html` as a **background panel page** so the demo remains
  the active tab.
- It pairs only that isolated Chrome profile to its isolated bridge. It
  does not read Claude Desktop or any other client configuration, does
  not use the live port 6123, and does not read or write the user's real
  token file or `SEEYABLE_BRIDGE_TOKEN` setup.
- Submission counting is harness instrumentation, explicitly installed
  through CDP only on the synthetic demo page: a submit listener calls
  `preventDefault()` and increments `window.__submitCount`. The MCP
  client does not receive or use that counter; the harness reads it to
  prove held/cancelled Submit dispatched zero times.
- Cleanup kills only the Python, MCP stdio, and Chrome child processes
  it spawned; waits for its isolated shared bridge's one-second idle
  exit; then deletes its temporary profile/state directory. It does not
  terminate unrelated processes or remove user files.

A passing run rewrites the JSON and screenshots in this directory and
prints `ACT2-HEADLESS: 39/39 passed`.

## Why the earlier panel screenshot showed “DOM snapshot failed”

The earlier capture was a **harness artifact**, not a reproduced product
defect in the genuine side panel:

1. The first harness created `sidepanel.html` through Chrome's
   `/json/new` endpoint, which made the extension page itself the active
   browser tab.
2. On load, the panel correctly tried to automatically snapshot the
   active tab — in that arrangement, its own extension page. An
   extension page has no Seeyable content script and cannot be accessed
   by the scripting fallback, so the panel honestly set
   `DOM snapshot failed: The page has no Seeyable content-script
   connection…`.
3. Later, the harness activated the real demo tab. The panel bound the
   demo and adopted the MCP hold, but automatic acquisition is
   deliberately status-quiet when an error status already stands (it
   must not overwrite another operation's outcome), so the stale
   extension-page failure remained visible above the new held card.
4. A genuine Chrome side panel is not a browser tab. Opening it does not
   make an extension page the active tab, so this self-targeting
   sequence cannot occur in the headed side-panel flow.

The replacement harness creates the panel page as a background target
while the demo stays active. The panel binds the demo normally, reports
“Found 20 controls on this page,” and the replacement screenshot shows
that normal bound state with the held card and no snapshot failure. No
production code was changed and the error was not hidden or edited out;
the failing target was removed from the harness's setup. The panel page
capture remains headless supporting evidence, not genuine side-panel
acceptance.

## Automated suite results for this pass

Run on 2026-11-03 against baseline `b1e0192`:

- `npm --prefix apps/extension test` — **334/334 passed**.
- `npm --prefix apps/mcp-server test` — **41/41 passed**.
- `npm --prefix packages/shared test` — **11/11 passed**.
- `npm --prefix apps/planner-proxy test` — **15/15 passed** when run with
  loopback listening permitted. An initial sandboxed attempt failed its
  local HTTP setup with `EPERM`; that was an environment restriction,
  not a product assertion failure.

No production code was changed for Issue #20 in this pass. During
harness development, three setup assumptions were corrected in the
harness only: it waited for a bridge log line that the shared bridge
now writes to its own log; it looked for a disposable tab before
`list_tabs` had observed it; and it initially activated the panel page
as a browser tab, causing the screenshot artifact explained above.
Those were test-harness assumptions, not Seeyable defects.

## Accepted genuine-client evidence

See [headed-codex-acceptance.md](headed-codex-acceptance.md). It separates
direct PM tool observations, Product Owner-reported English/Spanish voice
checks, human cancellation, and the limits of the restart evidence.
Issue #20 is accepted for Codex Work chat. Claude Desktop remains untested.
