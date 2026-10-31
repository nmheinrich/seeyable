# Issue #28 — Early bridge spike: extension ↔ localhost MCP transport

Status: **complete and accepted.** Automated evidence plus headed Inspector
snapshot, highlight, and idle/tab-switch checks verified. The Product Owner
subsequently confirmed both final checks passed: explicit Disconnect stays
disconnected until re-pairing, and old-document targets are rejected after
reload while a fresh snapshot restores valid highlighting. Thin slice only,
not the full MCP toolset.

## Project-manager headed evidence — 2026-10-30

Using native Chrome UI automation against the actual Inspector GUI, the
project manager restored pairing and verified `highlight_target` returned
`{"highlighted":"el-1"}` and visibly outlined Full name on the demo page.
After the heartbeat correction, reloaded the actual unpacked extension and
restarted the server. The old Inspector proxy was no longer listening;
recovered Inspector on local UI/proxy ports 6275/6278 (the Seeyable bridge
remains 127.0.0.1:6123), then paired once to the fresh server.

With Seeyable's side panel closed and no service-worker DevTools attached,
`page_snapshot` succeeded before and after an untouched interval of at least
95 seconds. Three subsequent demo/Inspector tab round trips were followed
by another successful snapshot. No manual re-pairing occurred during those
idle/tab-switch checks. This demonstrates usability across the interval;
it does not by itself prove that no transparent reconnect occurred.

The final live Inspector session remains open on port 6275. No executor
actions or consequential page operations were performed in these checks.

## What this is

One real end-to-end path: MCP client → local Node stdio MCP server →
loopback WebSocket bridge → extension service worker → existing
content-script interfaces → structured response. It exposes exactly
three tools: `list_tabs`, `page_snapshot`, and `highlight_target`.
No executor actions, no planner, no approval authority cross the bridge.

## Setup

Prerequisites: Node 20+, Chrome/Chromium, the extension loaded
unpacked from `apps/extension/`, and (for the GUI) MCP Inspector.

```sh
# 1. Install the server dependencies (one time).
npm --prefix apps/mcp-server install

# 2. Start the server. It prints a pairing token once, on stderr.
node apps/mcp-server/server.mjs [--port 6123]
# [seeyable-mcp] bridge on 127.0.0.1:6123 (loopback only)
# [seeyable-mcp] pairing token (...):
# <64 hex characters>

# 3. Serve a demo target and open it in Chrome.
python3 -m http.server 8765 --bind 127.0.0.1 --directory apps
# open http://127.0.0.1:8765/demo-survey/

# 4. Pair: open the Seeyable side panel → Developer view →
# "MCP bridge (local spike)". Paste the token, confirm the port,
# Connect bridge, then Bridge status ("connected on 127.0.0.1:6123").
```

For repeatable local runs the token can be fixed with
`SEEYABLE_BRIDGE_TOKEN=<hex>`; otherwise it is generated per start.
Tokens are never committed and never sent to webpages. The one
startup display is the deliberate pairing step, not logging: after
that, the token never appears in diagnostics on either side (the
panel clears its input after pairing; per-connection code logs only
op names and request ids).

## MCP Inspector

GUI (manual): launch Inspector, add a stdio server with command
`node`, arguments `<repo>/apps/mcp-server/server.mjs`, connect, and
call `list_tabs` → `page_snapshot` → `highlight_target` with the tab
id from step 1. The extension must stay paired (step 4 above) for the
whole session.

CLI (automated): `npx @modelcontextprotocol/inspector --cli node
apps/mcp-server/server.mjs --method tools/list` lists the three
tools. Note: the CLI spawns a fresh server per invocation, so a live
extension round trip through the CLI is racy by construction (the
call fires before any extension could pair to that instance); the
automated end-to-end below speaks the identical stdio JSON-RPC the
Inspector sends. See the headed evidence above for the GUI checks now performed.

## Protocol and trust boundaries

- The bridge binds **127.0.0.1 only** (asserted in tests). Nothing
  listens in the browser; the service worker is a WS client, so no
  webpage can reach the socket.
- Authentication is the runtime pairing token sent as the first WS
  frame and compared with `timingSafeEqual`. Wrong/missing tokens
  close the socket (4401). The `Origin: chrome-extension://` check is
  defense-in-depth, not auth. One extension connection at a time,
  enforced atomically at authentication (a second contender that
  connected earlier but authenticates later is rejected without
  disturbing the owner), and only the current owner's frames are
  accepted.
- Tab targeting is explicit: `page_snapshot` and `highlight_target`
  require the `tabId` from `list_tabs`. There is no active-tab
  fallback; missing/closed tabs return `TAB_UNAVAILABLE` and tabs are
  never substituted. Tab ids stay distinct from the snapshot's
  `documentSessionId`/`revision`/element ids, which the content
  script keeps validating (stale and unknown targets are rejected,
  never retargeted).
- `highlight_target` reuses the existing guarded `SEEYABLE_HIGHLIGHT_ID`
  route. No executor operation is exposed; consequential actions,
  script execution, and caller-minted approval are out of scope.
- Responses correlate to requests by id with a 15 s timeout; late
  responses are dropped. Disconnects fail pending requests and
  nothing is ever replayed — callers must retry explicitly.
- The paired extension sends an authenticated `ping` every 20 s and
  the server answers `pong` (owner only; pings never trigger
  operations). This is Chrome's documented service-worker WebSocket
  pattern: message exchange inside the 30 s activity window keeps
  the worker alive (`minimum_chrome_version: 116` is declared for
  this). The extension treats the connection as dead after 45 s
  without a pong, closes it, and recovers; status reports connected
  only for an authenticated socket with a fresh heartbeat. Timers
  are owned by connection generation and stop on disconnect,
  replacement, failure, or shutdown.
- stdout is MCP traffic only; diagnostics go to stderr.

## Extension lifecycle

The pairing token and "wanted" flag live in `chrome.storage.session`
(cleared when the browser closes). Pairing is restored on ordinary
service-worker initialization — every wake re-evaluates the worker
and a once-per-lifetime, generation-checked restore reconnects when
previously paired — not only on browser startup. An explicit
Disconnect always wins over a pending restore and stays
disconnected. While alive, unexpected drops reconnect with bounded
backoff (2/5/15/30 s). Tab switches and panel visibility never
affect the transport: pairing is browser-level, and only the
panel's own execution selection is invalidated by tab changes.
Every connect/disconnect cycle takes a
monotonic generation that async continuations revalidate, so a
Disconnect during a held token read opens no socket and obsolete
socket callbacks or timers can neither authenticate nor disturb a
newer connection. Status reports connected only after `auth_ok`
for the current socket, and requests are ignored before that.
Server shutdown terminates all tracked sockets (authenticated or
not), fails pending requests, releases the port, and is idempotent.
Disconnect discards the token. The connection no longer depends on
the panel being open: the heartbeat sustains it across idle
intervals, and worker-init restore re-pairs after suspension
without asking for the token again.

Permissions added for this spike (both manifests, documented in
`CHROMEWEBSTORE.md`): `tabs` (titles/URLs for tab picking, returned
only over the paired socket) and host `http://127.0.0.1:6123/*`
(outbound WS handshake; verified to cover `ws://` in the headed run
below — the connection succeeded with no permission errors).

## Verified evidence (headless Chrome 156, 2026-10-30)

Automated end-to-end (`/tmp/spike-run/mcp-e2e.mjs`, **15/15**): real
MCP server subprocess over stdio JSON-RPC (initialize, tools/list,
tools/call — the same frames Inspector sends), real extension in
headless Chrome, pairing through the real panel UI, demo survey over
local HTTP. Observed: `list_tabs` returned the demo tab with title
and URL; `page_snapshot` returned the real schema-v2 snapshot
(20 controls, real `documentSessionId`, redaction intact);
`highlight_target` returned `{"highlighted": "el-1"}` on that tab;
unknown element → `UNKNOWN_TARGET`; missing tab →
`TAB_UNAVAILABLE`; wrong pairing token → socket close 4401;
disconnect → `NO_EXTENSION` with no hang; reconnect + explicit retry
succeeded with no replay. Real Inspector CLI runs confirmed
`tools/list` (three tools with schemas) and the honest
`NO_EXTENSION` error path for `tools/call` with no extension paired.

Unit coverage: `npm --prefix apps/mcp-server test` (8 tests:
loopback binding, token secrecy, auth/origin/single-connection
rejection, correlation, coded errors, fail-fast, timeout + late
drop, disconnect/no-replay) and the extension suite
(`npm --prefix apps/extension test`, 147/147, including the new
pairing-UI regression).

## Failure catalog

| Situation | Observed behavior |
|---|---|
| Wrong/missing token | WS close 4401; nothing is served |
| Non-extension Origin | WS close 4403 before auth is considered |
| Second extension | WS close 4409 |
| No connected extension | `NO_EXTENSION`, immediate |
| Closed/missing tab | `TAB_UNAVAILABLE`, no substitution |
| Restricted/unloaded tab | `TAB_NOT_READY` |
| Unknown/stale target | `UNKNOWN_TARGET` / `STALE_TARGET` / `WRONG_SESSION` from the content script's own validation |
| Slow extension | `TIMEOUT` after 15 s; late answers dropped |
| Disconnect mid-request | Pending fails as `NO_EXTENSION`; reconnect replays nothing |

## Cleanup and reconnection

Disconnect in the panel (discards the token), or just stop the
server (`SIGINT` closes the bridge cleanly). To reconnect, restart
the server and pair again with the fresh token. No state survives on
either side: the server keeps no sessions and the extension keeps no
queued work.

## Known limitations and handoff

- Inspector GUI snapshot/highlight and headed idle/tab-switch checks are
  verified above; the Product Owner confirmed the final explicit-disconnect/
  re-pair and stale-target/fresh-snapshot recovery checks passed. The CLI's per-invocation
  server lifecycle makes CLI-driven extension calls racy.
- Single extension connection; fixed loopback port per server run
  (host permission is port-specific).
- No executor tools yet. When they come, they must reuse
  `SEEYABLE_EXECUTE_ACTION` and the Feature #11 confirmation flow;
  approval must never be mintable or passable over the bridge.
- `tabs` permission and the loopback host permission are new attack
  surface: justified above, minimal, and spike-scoped. Revisit
  before any non-spike release.
