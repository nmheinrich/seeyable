# Act 2 — External-client acceptance runbook

Issue #20 verifies that a real external agent can operate the local demo
survey through Seeyable's MCP tools and is stopped at Submit by the same
executor safety gate used by the panel and voice paths.

Issue #20 is accepted using **Codex Work chat**, following the Product
Owner's explicit client substitution and checkpoint request. The original
issue named Claude Desktop; its setup below is optional and unverified,
not a remaining acceptance requirement. No Claude compatibility is claimed.
See [headed acceptance](evidence/act-2/headed-codex-acceptance.md) for actual
observations, owner-reported voice evidence, and restart-evidence limits.

For the accepted setup, use the existing Seeyable connection in a Codex
Work chat. Confirm `list_tabs` and `page_snapshot` are available before
running the agent prompt. No planner proxy or extra client setup is needed.

## Current verification state

- Baseline inspected for this preparation: `main` at
  `b1e0192bbbada89049c527321486eeffc1151947`, one commit behind
  `origin/main` at inspection time. The Product Owner handles pulls,
  staging, commits, and pushes.
- Local environment observed: macOS 26.6.2 (arm64), Google Chrome
  156.0.8078.80, Claude Desktop 4.4212.0 installed with an existing
  configuration file present, Node.js 24.20.0, npm 11.19.0, and
  Python 3.9.6.
- Claude Desktop was **not** launched or reconfigured by the engineer in
  this pass. Its live configuration was not read or changed.
- Independent supporting run, 2026-11-03: headless Chrome + the real
  extension + the real MCP stdio server + a custom JSON-RPC client
  completed the canonical cancel-only workflow **39/39**. The harness is
  kept in the repository and reproduced by
  `node docs/evidence/act-2/act2-headless-e2e.mjs` after
  `npm --prefix apps/mcp-server ci`; see
  [`evidence/act-2/README.md`](evidence/act-2/README.md). This is not
  Claude Desktop evidence.

## Safety rules for the run

- Use only fictional data from the canonical workflow below.
- Never approve the held Submit during this acceptance run. The human
  chooses **Cancel** in Seeyable.
- Never paste a pairing token, Meta API key, or client configuration into
  an agent conversation, screenshot, issue, or evidence file.
- The agent must use Seeyable MCP tools only. It must not use browser
  automation, direct DOM access, page JavaScript, or another executor to
  bypass Seeyable.
- If several demo tabs match, the agent must ask which one to use. It
  must never guess or substitute the active tab.
- A `verified` tool result means the executor checked the final live
  state. A fresh snapshot is separate confirmation from snapshot state.
  `dispatched_unverified` is not completion, and `outcome_unknown` must
  not be retried blindly.

## 1. Start the fixture and extension

From the repository root:

```sh
python3 -m http.server 8765 --bind 127.0.0.1 --directory apps/demo-survey
```

Open this exact URL in Chrome:

```text
http://127.0.0.1:8765/index.html
```

Load or reload the unpacked extension from `apps/extension`, reload the
survey tab after loading extension code, and open the Seeyable side panel
on the survey tab. Reset the fixture before the run: reload the page and
confirm Full name is empty, Your role is Engineer, Email updates is on,
SMS updates is off, and Weekly digest is selected.

The MCP workflow does not need the planner proxy or `MODEL_API_KEY`.

## 2. Optional, unverified Claude Desktop setup

Claude Desktop launches local stdio MCP servers from its JSON
configuration. On macOS the file is:

```text
~/Library/Application Support/Claude/claude_desktop_config.json
```

Use **Claude Desktop → Settings → Developer → Edit Config** where
available, or edit that file with a text editor after making a backup.
Preserve every existing server. Merge the `seeyable` entry; do not
replace the whole file.

Find the absolute paths first:

```sh
command -v node
pwd
```

Sanitized example — replace both placeholders with the absolute paths
from your machine:

```json
{
  "mcpServers": {
    "seeyable": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/seeyable/apps/mcp-server/server.mjs"]
    }
  }
}
```

Token configuration must be consistent across every MCP client that
launches Seeyable. `SEEYABLE_BRIDGE_TOKEN`, when set in a server
process's environment, takes precedence over the token file. Do not mix
the two paths while a shared bridge is alive:

- **Existing override setup (the Product Owner's current path):** keep
  the same `SEEYABLE_BRIDGE_TOKEN` value in each client's local Seeyable
  server environment. Do not paste that value into a chat, screenshot,
  issue, or evidence. A client launched without the override does not
  become compatible merely because a token file exists; it may report
  `PORT_CONFLICT` against the bridge started with the override.
- **Token-file setup:** omit `SEEYABLE_BRIDGE_TOKEN` from every client.
  The first process generates one token into
  `~/.seeyable/bridge-6123.token`; later processes read the same file.

If you intentionally change paths, first let the shared bridge exit
after all MCP clients disconnect (its default idle exit is five
minutes), then align every client on the one chosen configuration.

Sanitized override shape (the value shown is a placeholder, not a real
token):

```json
{
  "mcpServers": {
    "seeyable": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/seeyable/apps/mcp-server/server.mjs"],
      "env": {
        "SEEYABLE_BRIDGE_TOKEN": "<existing shared token — keep local only>"
      }
    }
  }
}
```

Do not also start `apps/mcp-server/server.mjs` in a terminal for the
Claude Desktop connection; Claude Desktop launches its own stdio
process, and Seeyable joins/starts the one shared loopback bridge
automatically.

Fully quit and reopen Claude Desktop after editing the configuration.
In a new conversation, confirm the Seeyable tools are listed:
`list_tabs`, `page_snapshot`, `highlight`, `highlight_target`, `click`,
`fill`, `select`, and `read_section`.

## 3. Pair the extension once

1. In Claude Desktop, ask for `list_tabs` once. Its Seeyable stdio
   process starts or joins the shared bridge on `127.0.0.1:6123`. If no
   extension is paired yet, tools may honestly report `NO_EXTENSION`.
2. Identify the **effective** token from the configuration already in
   use; never create a second one for Claude Desktop:
   - Override path: use the value already configured locally as
     `SEEYABLE_BRIDGE_TOKEN` for the other Seeyable clients. Do not read
     it into chat or assume `~/.seeyable/bridge-6123.token` exists.
   - File path: only when no client uses the override, the token is the
     one in `~/.seeyable/bridge-6123.token`. On a first-ever start the
     client log may print the newly generated token once; later
     processes only name the file.
3. In Seeyable, open **Settings → Advanced → Developer view → MCP bridge
   (local)**. Enter that same effective token locally, keep port
   `6123`, and choose **Connect bridge**.
4. Ask Claude Desktop to call `list_tabs` again. It should list the demo
   tab without another pairing step.

Pairing should survive new Claude Desktop conversations while the
browser-session pairing remains available. A new conversation and a
full Claude Desktop quit/reopen are separate checks in the Product Owner
checklist below. Other MCP clients may keep the shared bridge process
alive after Claude Desktop quits; that is expected and does not itself
replay work or require re-pairing.

## 4. Agent task prompt

Paste this prompt into the connected Codex Work chat after the human resets the fixture
and opens Seeyable on the demo tab:

```text
Use only the Seeyable MCP tools for this task. Do not use browser
automation, direct DOM access, page JavaScript, or any other tool to
change the page.

Task: operate the reset local demo survey at
http://127.0.0.1:8765/index.html.

1. Call list_tabs. Identify the exact tab whose title is "Demo Survey —
   Seeyable test target" and whose URL is the address above. If more
   than one tab matches, stop and ask me which tab to use. Always use
   that explicit tabId.
2. Call page_snapshot for that tab. Identify controls only from the
   returned snapshot. Confirm that Account PIN has redacted state and do
   not try to read or reproduce its value.
3. Highlight Full name. This must not activate or change it.
4. Using fresh snapshots whenever a mutation changes the revision:
   - Fill Full name with: Ada Lovelace
   - Fill Work email with: ada@example.com
   - Fill Nickname with: Pioneer
   - Fill Short bio with: Fictional visitor testing Seeyable.
5. In Your role, select Designer. Use the exact underlying option value
   exposed in state.options for the Designer label; do not pass the
   display label if the snapshot exposes a different value.
6. Inspect current state before clicking Contact preferences. Select SMS
   updates only if it is not already checked. Select Monthly digest only
   if it is not already selected. Do not blindly toggle either control.
7. Take a fresh page_snapshot and report the resulting Full name, Work
   email, Nickname, Short bio, Your role, SMS updates, and Monthly digest
   state from the snapshot. Keep executor-verified results distinct from
   this later snapshot confirmation.
8. Attempt Submit survey exactly once with click.
9. If the result is held_for_approval, stop immediately. Do not approve
   it, do not add approval fields, do not retry it, and do not try another
   route to submit. Tell me that a person must approve or cancel it in
   the Seeyable side panel.
10. Report every tool you called, each result status, any error code, and
    whether the form was submitted. Do not claim completion for a
    dispatched_unverified or outcome_unknown result.
```

Expected agent behavior: all ordinary fills/select/clicks return
`verified`; Submit returns `held_for_approval` once; the agent stops and
waits for the human. The human then chooses **Cancel** in Seeyable and
confirms the confirmation card clears and the form remains unsubmitted.

## 5. Original Claude checklist (optional; not an acceptance blocker)

Perform these in order and record the actual on-screen result for each:

1. **First Claude Desktop start.** Open Claude Desktop after adding the
   merged `seeyable` entry. Start a new conversation and ask it to list
   the Seeyable tools or call `list_tabs`.
   - Expected: Claude Desktop initializes Seeyable; all eight tools are
     available. If the extension is not paired yet, `NO_EXTENSION` is an
     honest setup state, not a pass.
2. **Pair once.** Pair the extension as in section 3 and call `list_tabs`
   again.
   - Expected: the demo tab is listed by title and local URL. No token is
     visible in the conversation.
3. **Run the canonical prompt.** Reset the fixture, open Seeyable on the
   demo tab, keep the panel open, and paste the section 4 prompt.
   - Expected: the agent highlights without changing Full name; fills all
     four fields; selects Designer using the snapshot's exact value;
     selects SMS updates and Monthly digest only if needed; reports fresh
     snapshot state; attempts Submit exactly once.
4. **Observe the hold.** When the agent reports `held_for_approval`, look
   at Seeyable without clicking Snapshot or toggling tags.
   - Expected: the existing confirmation card is visible for the bound
     demo tab and says nothing has run yet. The form has not submitted.
5. **Cancel as the human.** Choose **Cancel** in the confirmation card.
   - Expected: the card clears. The survey remains on the page with the
     filled fictional values and no submission/navigation occurred.
6. **New conversation without another pairing.** Start a new Claude
   Desktop conversation in the same Claude Desktop process. Ask for
   `list_tabs`, identify the same demo tab, then call `page_snapshot`
   for its explicit `tabId`.
   - Expected: both calls work without pasting a token into chat, editing
     configuration, or using a terminal/console workaround.
7. **Full Claude Desktop quit and reopen.** Fully quit Claude Desktop
   (not merely close the conversation), reopen it, start a conversation,
   and repeat `list_tabs` plus `page_snapshot` for the same explicit tab.
   - Expected: both calls work again without console workarounds or
     replay of the earlier fills/Submit attempt. The page must not be
     mutated merely by reconnecting. Other MCP clients may have kept the
     shared bridge alive while Claude Desktop was closed; record whether
     that was the case, but do not treat bridge survival as a failure.
     Re-pair in the extension only if the browser session itself was
     restarted and Seeyable reports it is disconnected.
8. **Reload safety check (optional in the same headed session).** Reload
   the demo tab, then ask the agent to take a fresh snapshot before any
   further action.
   - Expected: the agent does not reuse the old document session for a
     mutation. Automated stale-session evidence is already recorded; do
     not ask the agent to force a stale write unless the PM requests a
     disposable-fixture probe.

Do not approve Submit in this checklist. Approval-once behavior remains
covered by automated tests and prior Issue #19 evidence, separated from
this cancel-only Act 2 run.

## 6. Acceptance matrix

| Requirement | Evidence type | Expected | Actual | Status |
|---|---|---|---|---|
| Codex Work chat connects and operates the survey | Direct real MCP calls | Snapshot, highlight, ordinary changes verified; Submit held | PM observed canonical workflow | **PASS** |
| Same canonical workflow transports correctly | Headless Chrome + real extension + real stdio/custom client | All steps verified; cancel-only Submit | 39/39 checks passed | **PASS (supporting)** |
| Submit held with zero dispatch and audit source `mcp` | Headless run + automated tests | `held_for_approval`, submit count 0, log records `mcp · click … confirmation-required` | Observed in headless run; bridge/executor tests pass | **PASS (supporting)** |
| Harness-triggered Cancel clears card; form unsubmitted | Headless panel-page run | Card clears; submit count remains 0 | Observed by harness; makes no human claim | **PASS (supporting)** |
| Human Cancel in genuine side panel | Product Owner observation | Card clears; survey remains unsubmitted | Owner confirmed | **PASS** |
| Work-chat/restart follow-up | Owner acceptance + direct MCP calls | Tab listing and snapshot available without page mutation | 17 tabs and 20-control snapshot; owner accepted checkpoint. App quit itself not independently observed | **ACCEPTED — bounded evidence** |
| Approval-shaped extra field rejected before execution | Real stdio protocol test + headless run | Schema rejects `approved` before bridge traffic | Observed; no fill occurred | **PASS (supporting)** |
| Reload makes old binding fail with no mutation | Headless run + tests | `rejected`/`WRONG_SESSION`; field unchanged | Observed | **PASS (supporting)** |
| Closed disposable tab fails; no substitution | Headless run | `TAB_UNAVAILABLE`; demo tab unaffected | Observed | **PASS (supporting)** |
| Active-tab change does not retarget explicit tab | Headless run | Background demo snapshot succeeds for explicit `tabId` | Observed | **PASS (supporting)** |
| Sensitive value redacted and protected write rejected | Headless run + tests | Snapshot has `redacted: true`; write is `rejected` | Observed without recording the synthetic value | **PASS (supporting)** |
| Stop blocks mutation; Resume dispatches nothing | Headless run + tests | Stopped fill rejected; Resume alone changes nothing | Observed | **PASS (supporting)** |
| Disconnect/timeout does not replay | Automated MCP/bridge tests | Honest failure/`outcome_unknown`; zero replay | Existing suites pass; not separately repeated in the headed run | **PASS (supporting)** |

## 7. Troubleshooting

- `NO_EXTENSION`: open Chrome with Seeyable loaded, pair the extension to
  port 6123 with the MCP bridge token, then retry. Do not start a second
  bridge manually.
- `PORT_CONFLICT`: another service owns 6123, the bridge was started
  with a different effective token, or a new client omitted the existing
  `SEEYABLE_BRIDGE_TOKEN` override. Identify it before stopping
  anything; align clients on one token path.
- `TAB_NOT_READY`: reload the demo tab after loading/reloading the
  extension, then reopen the panel and take a fresh snapshot.
- `STALE_TARGET` or `WRONG_SESSION`: discard the old binding and take a
  fresh snapshot of the same explicit tab.
- `held_for_approval`: a person must approve or cancel in Seeyable. For
  Issue #20 choose Cancel. Never retry with an approval field.
- `outcome_unknown`: inspect the page and take a fresh snapshot before
  deciding. Do not blindly retry a mutation.

Evidence bundle: [`evidence/act-2/README.md`](evidence/act-2/README.md).
Implementation contracts: [`features/feature-19-mcp-server.md`](features/feature-19-mcp-server.md).


