# Seeyable

**Operate the web by voice. Give AI agents the same tools.**

Seeyable is a Chrome extension that turns webpage controls into labeled,
callable tools. People use voice or typed requests in the side panel;
external agents use a local MCP server. Meta Muse Spark turns compound
requests into reviewable plans. Both paths use the same executor: snapshot-bound
target validation, live-state checks, and a human confirmation gate for
consequential actions. This grounds model-generated plans in actual page controls.

## Hackathon submission overview

- **Track / theme:** Indie Developer / Push the Frontier.
- **Runtime Meta model:** `muse-spark-1.3` through Meta Model API. The local
  proxy provides a pruned page snapshot and request; Muse returns a structured
  plan, validated before preview and guarded execution.
- **Bonus category to highlight:** Best Agentic Use-Case. Full external-agent
  workflow evidence is still pending; do not claim it is complete.
- **Open-weight bonus:** not currently claimed; the implemented planner uses
  hosted Muse Spark, not a demonstrated open-weight model stage.
- **Provenance:** the survey is a pre-existing test fixture and is excluded
  from claims of hackathon-built product work. A complete build-window
  statement still needs reconciliation before the final video/submission.
- **Demo video:** pending.
- **License:** [MIT](LICENSE). Bundled fonts retain their included OFL notices.

This is a developer setup: load the extension unpacked and run the local
services you need. There is no bundled installer, automatic planner startup,
or Meta sign-in flow in the extension yet.

## Choose what to run

| Workflow | What to start | Meta API key in Seeyable? |
| --- | --- | --- |
| Tags and simple local click/fill commands | Chrome extension + local test page | No |
| Compound voice/typed requests in the panel | Above + planner proxy on `127.0.0.1:6124` | Yes, in the proxy only |
| External agent operating the page | Extension + MCP client launching the stdio server; bridge on `127.0.0.1:6123` | No; the external agent supplies its model connection |
| Both panel planning and external agents | Both services above | Only the planner proxy needs it |

The planner and MCP bridge have **different pairing tokens**. Neither token
is your Meta API key. Never paste a Meta API key into the extension.

## 1. Get the repository and prerequisites

Use desktop Google Chrome, Node.js with npm, and Python 3 (for the local test
page server). Node `24.20.0` is the environment used to check this guide;
the extension manifest requires Chrome 116 or newer. Voice uses Chrome's
Web Speech recognition, which may require network access and microphone
permission. Typed requests remain available.

```sh
git clone https://github.com/nmheinrich/seeyable.git
cd seeyable
node --version
npm --version
python3 --version
```

If you already have the repository, open a terminal in its root instead of
cloning again. All commands below start from that root unless stated otherwise.
There is no root `npm install` or build step. Install the MCP dependencies
and extension test dependencies in their own folders:

```sh
npm --prefix apps/mcp-server ci
npm --prefix apps/extension ci
```

The planner proxy and shared package have no third-party dependencies to
install. Extension dependencies are for tests; Chrome loads its source directly.

## 2. Start the local test page

In terminal A:

```sh
python3 -m http.server 8765 --bind 127.0.0.1 --directory apps/demo-survey
```

Keep this terminal open. Visit <http://127.0.0.1:8765/index.html> in Chrome.
You should see the survey with controls including **Full name** and **Your role**.
The survey is a pre-existing test fixture, not the Seeyable product or a
claim of hackathon-built work. Use fictional data only.

## 3. Load the Chrome extension

1. Open `chrome://extensions` and enable **Developer mode**.
2. Choose **Load unpacked** and select this repository's `apps/extension` folder.
   Use the default `manifest.json`; no build or debug manifest is needed.
3. Reload the survey tab if it was already open when the extension loaded.
4. Click Seeyable's extension icon to open the side panel on that tab.
5. Open **Targets** to inspect page controls, or turn on **Tags** to label them
   on the page. Controls without clear overlay space remain in Targets.
6. In **Assist**, type `fill Full name with Ada Lovelace` and choose **Send**.
   The Full name field should change without a planner or API key.

The panel acquires a snapshot automatically on opening or tab switching.
For diagnostics, use **Settings → Advanced → Developer view → Refresh snapshot**.
Chrome internal pages such as `chrome://extensions` cannot be operated.

For voice, open **Settings → Voice and microphone → Microphone setup**, choose
**Enable microphone**, and grant Chrome permission. Return to the survey and
use the speak button in Assist. `Alt+S` works while the panel has focus.
Try `show tags` first. Recognition is imperfect; check the displayed transcript,
particularly for names and dictated values. The microphone setup page stops
its permission-test stream immediately; browser speech recognition may process
audio outside the device.

## 4. Optional: connect the Muse Spark planner

This enables compound requests in the panel. Skip it for MCP-only use.
The proxy sends the request and a pruned, redacted page snapshot to Meta.
Keep `MODEL_API_KEY` exclusively in the proxy environment.

In terminal B, create a local configuration file **once**:

```sh
cp -n apps/planner-proxy/.env.example apps/planner-proxy/.env
chmod 600 apps/planner-proxy/.env
```

Open `apps/planner-proxy/.env` in your editor and set `MODEL_API_KEY` to your
Meta Model API key. This file is git-ignored; never commit it or share it.
The default model is `muse-spark-1.3`; your account needs access and available
API usage. Obtain the key through the Meta Model API dashboard.

Start the proxy with the file explicitly loaded:

```sh
node --env-file=apps/planner-proxy/.env apps/planner-proxy/server.mjs
```

Keep terminal B open. Expected output names `127.0.0.1:6124` and prints a
**planner pairing token**. A server can start without a key, but planning
will fail with `NO_API_KEY`; startup alone does not establish model access.

1. In the panel, open **Settings → Advanced → Developer view → Planner proxy (local)**.
2. Paste the printed **planner pairing token**, keep port **6124**, and choose
   **Pair planner**. Use **Planner status** to check the connection/key status.
3. Return to Assist and type: `Put Ada Lovelace in Full name and Pioneer in Nickname.`
4. Review the proposed steps, then choose or say **Approve plan**.
5. Verify both fields changed. Plan approval does not replace the separate
   human confirmation required for a consequential action.

After a proxy restart, its generated token changes: pair again with the new
token. Pairing in the extension lasts for the browser session. Advanced
configuration and error codes: [planner proxy guide](apps/planner-proxy/README.md).

## 5. Optional: connect an external agent through MCP

The external agent supplies the intelligence. Seeyable's MCP path does not
call the planner proxy or need `MODEL_API_KEY`. The agent must support a
**local stdio MCP server**; configure its own model/provider separately.
Muse-backed agent integration is a separate workflow to verify, not assumed
by these generic connection instructions.

Find the absolute executable and repository paths:

```sh
command -v node
pwd
```

In your MCP client's local server settings, use the resulting absolute paths.
For clients accepting an `mcpServers` JSON configuration, the shape is:

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

Replace both paths; this is a template, not a ready-to-paste configuration.
Client configuration locations/formats differ. Keep existing servers when
adding Seeyable. The client launches the stdio process; **do not also start
`npm start` in a separate terminal** for that connection. The shared bridge
starts automatically; do not launch `bridge-daemon.mjs` yourself.

1. Enable/reload Seeyable in the client and inspect its server log. On first
   startup it generates an MCP bridge token, prints it to the client log,
   and stores it in `~/.seeyable/bridge-6123.token`.
2. To read that token locally if needed, run:

   ```sh
   cat ~/.seeyable/bridge-6123.token
   ```

   Treat it as a credential: paste only into Seeyable's pairing field, not
   into an agent conversation, screenshot, or issue.
3. In the extension, open **Settings → Advanced → Developer view → MCP bridge
   (local spike)**. Paste the **MCP bridge token**, keep port **6123**, and
   choose **Connect bridge**. The current heading still says “local spike”;
   the server exposes the full toolset below.
4. Ask the client to call `list_tabs`, identify the local survey tab, then call
   `page_snapshot` with that exact `tabId`.
5. Ask it to highlight Full name using that snapshot's `elementId`,
   `documentSessionId`, and `revision`. It should outline the control.
6. Ask it to fill Full name with `Ada Lovelace`. Verify the actual field and
   returned outcome; a dispatched or unknown outcome is not verified completion.

Tools: `list_tabs`, `page_snapshot`, `highlight` (`highlight_target` alias),
`click`, `fill`, `select`, and `read_section`. Every page tool needs an explicit
tab. Reacquire a snapshot after page changes; never invent or reuse stale targets.

Multiple client sessions share one bridge and token. No additional pairing
is required per chat while the browser-session pairing remains available.
If `SEEYABLE_BRIDGE_TOKEN` is explicitly set in your client configuration,
that value takes precedence over the token file; all clients must use the same
value. Leave it unset for the default shared-token setup.

### Inspect MCP without an agent

As an alternative to configuring a client, run in terminal C:

```sh
npx @modelcontextprotocol/inspector node apps/mcp-server/server.mjs --port 6123
```

Follow the Inspector's printed browser/login instructions and connect its
stdio transport. Pair the extension as above, then use the tools directly.
This downloads/runs the external MCP Inspector; it is not required for normal
client use. The full implementation and recorded evidence are in the
[MCP feature guide](docs/features/feature-19-mcp-server.md).

## 6. Check the safety behavior

On the local survey, request submission through the panel or MCP. The action
must be held for explicit human confirmation in the Seeyable panel; choose
**Cancel** and verify nothing submitted. An external agent cannot approve its
own held action. Keep the panel open during this check.

**Stop/Resume** is always visible. Stopped work does not replay when resumed.
**Undo** applies to the supported last change; it is not a general rollback
for every webpage action. Password/payment values are redacted in snapshots,
and protected writes are rejected. Never use real personal data, payments,
government forms, or destructive real-world actions for demos.

The ordered, previously accepted planner demonstration is documented in
[Act 1](docs/act-1-demo-script.md). Read its plan-review note before running it.
Verification scope and limitations: [status](docs/status.md).

## Daily startup and shutdown

After first-time installation:

1. Start terminal A's survey server if using the local fixture.
2. Open the survey and Seeyable in Chrome; refresh the survey after reloading
   extension code.
3. For panel planning, start terminal B's proxy with `--env-file` and pair its
   newly printed token.
4. For MCP, enable the configured server in your client; it starts the bridge.
   Re-pair the extension after a new browser session if needed.

Use **Ctrl+C** in the survey/proxy/Inspector terminal to stop that service.
Disable the MCP server in its client to close that stdio session. Other
sessions keep working; the shared bridge exits after its idle timeout when
no MCP clients remain. Extension **Disconnect** disconnects the browser from
the bridge; it does not stop client processes. No global process-kill command
is needed for normal shutdown.

## Command reference

Run from the repository root. Startup commands remain running until stopped.

| Purpose | Command |
| --- | --- |
| Install MCP dependencies | `npm --prefix apps/mcp-server ci` |
| Install extension test dependencies | `npm --prefix apps/extension ci` |
| Serve test survey | `python3 -m http.server 8765 --bind 127.0.0.1 --directory apps/demo-survey` |
| Start configured planner | `node --env-file=apps/planner-proxy/.env apps/planner-proxy/server.mjs` |
| Inspect MCP interactively | `npx @modelcontextprotocol/inspector node apps/mcp-server/server.mjs --port 6123` |
| Extension tests | `npm --prefix apps/extension test` |
| Shared contract tests | `npm --prefix packages/shared test` |
| Planner tests (stub upstream; no API key needed) | `npm --prefix apps/planner-proxy test` |
| MCP tests | `npm --prefix apps/mcp-server test` |
| Inspect working tree before sharing | `git status --short` |

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Survey does not open | Keep terminal A running; check port 8765 and the URL. |
| Targets empty / `TAB_NOT_READY` | Select a normal webpage, reload it after loading the extension, then reopen the panel. |
| Voice unavailable or inaccurate | Grant microphone permission using Microphone setup; check Chrome/OS settings and the transcript; use typed requests. |
| Simple commands work, compound requests fail | Start and pair the planner; confirm the key is configured. MCP pairing does not pair the planner. |
| `NO_API_KEY` | Set the key in the proxy's `.env` and restart using the explicit `--env-file` command. `npm start` alone does not load `.env`. |
| `MODEL_AUTH` / `MODEL_FORBIDDEN` / rate-limit error | Check key validity, model access, and usage allowance in the Meta dashboard. |
| Pairing fails | Use the correct service's token and port; planner 6124, MCP 6123. Check for a changed planner token after restart. |
| `NO_EXTENSION` | Open the extension and connect its MCP bridge using the matching token. |
| `PAIRING_UNAVAILABLE` | Read the MCP client log; check token-file ownership/permissions. Do not share the token or delete it as a routine fix. |
| `PORT_CONFLICT` / address in use | Another service or differently configured bridge owns the port. Identify it before stopping anything; align clients on the same token. |
| `STALE_TARGET` / `WRONG_SESSION` | Get a new snapshot of the explicit tab and use its current identifiers. |
| `held_for_approval` | Open the panel and approve or cancel the actual pending action; never retry it with an approval flag. |
| `outcome_unknown` after a write | Inspect the page and take a fresh snapshot before deciding what to do; do not blindly retry. |
| Nothing runs after Stop | Choose Resume, then issue a new request. |

## Repository map

- `apps/extension` — snapshots, word tags, voice/typed panel, shared executor and safety gate.
- `apps/planner-proxy` — loopback planner and Meta Model API credentials.
- `apps/mcp-server` — local stdio MCP tools and automatically shared loopback bridge.
- `apps/demo-survey` — pre-existing survey test fixture.
- `packages/shared` — snapshot/plan contracts and validation.
- `apps/voice-spike` — isolated transcription research; not required for setup.
- `docs` — feature evidence, acceptance scripts, decisions, and current status.

Setup-guide verification (2026-11-02): local documentation links and whitespace
checks passed; the survey-server command served the expected fixture; explicit
Node `--env-file` startup returned authenticated planner status with the default
model and `keyConfigured: false` using a temporary empty-key configuration.
Both startup checks used temporary ports and stopped their own processes.
This documentation pass did not rerun Chrome onboarding, a live Meta request,
or an external-agent workflow; existing feature evidence is linked above.
