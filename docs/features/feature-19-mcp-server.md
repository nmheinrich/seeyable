# Feature #19 — Full local MCP server and bridge

Status: **complete and accepted for Issue #19 on 2026-11-02.** Product
Owner Inspector GUI checks and the final automatic snapshot/confirmation
headed re-check passed (see Verification). Issue #20's full external-client
workflow remains separate; initial direct chat discovery/snapshot is verified.

**Cross-chat startup (2026-11-02): fixed; headed cross-chat tab listing
confirmed by the Product Owner.** After migration to the shared bridge,
the extension was paired using the existing configured token. This chat
retrieved the real tab list, and the Product Owner confirmed the other
chat worked without another pairing. Three-chat snapshots, close-one
isolation, and forced-restart recovery remain separately evidenced by
automated/headless tests, not individually confirmed headed steps.
Root cause: every stdio process (ChatGPT
starts one per chat plus short-lived discovery processes) bound the
bridge listener itself, *before* answering MCP `initialize`. The first
process owned 127.0.0.1:6123; later ones hit `EADDRINUSE`, which `ws`
re-emitted as an unhandled `'error'` on the WebSocketServer, so the
process exited 1 and the desktop app logged "connection closed:
initialize response". Tokens and chat modes were never the cause. Fix:
one shared, authenticated bridge process per port (see "Shared bridge"
below). Evidence so far is unit, mocked-extension multi-process, and a
real headless Chrome run with the real extension (see Verification),
plus the bounded ChatGPT desktop check recorded above.

**Reviewer follow-up (2026-11-02): both reproduced findings corrected;
headed cross-chat tab listing subsequently passed.** (1) Delayed peer→hub delivery could
forward `execute` after the peer's `TIMEOUT` because the hub started a
fresh deadline. The peer now stamps `expiresAt` at issue; the hub
refuses missing/expired deadlines without forwarding and the bridge
only ever shortens them. Reviewer repro: before
`extensionExecuteFramesAfterTimeout: 1`, after `0`. (2) A concurrent
first-token reader could see the creator's empty file. The token is now
written+fsynced to a private temp file and published with an atomic,
non-overwriting `link()`. Reviewer repro: before the reader failed
("does not contain a valid pairing token"), after it reads a complete
token and both converge. These corrections are not the cause of the
earlier unexplained flaky run; see Verification for what stress
testing found.

## What this is

Issue #28's transport, extended — not rebuilt:

```
MCP client(s) → Node stdio server, one process per chat (apps/mcp-server)
  → authenticated peer link → ONE shared bridge process per port
    (bridge-daemon.mjs; owns 127.0.0.1:6123 and the single extension pairing)
  → extension service worker (lib/bridge-client.js)
  → chrome.tabs.sendMessage to the explicitly chosen tab
  → the existing content-script routes: snapshot engine, overlay
    highlight, the ONE shared executor, bounded section reading.
```

No planner proxy and no `MODEL_API_KEY` are involved. The MCP client
supplies the intelligence; Seeyable supplies page information and
guarded actions.

## Pairing (wording discrepancy)

An older issue description says the token is generated in the
extension. The accepted #28 implementation generates the runtime token
in the **server** and the operator pastes it into the extension's
Developer view. That working direction is retained; there is no second
pairing system. With the shared bridge, every chat's process must use
the same token: either `SEEYABLE_BRIDGE_TOKEN` (never written to disk by
Seeyable) or, when that is unset, a token generated once into
`~/.seeyable/bridge-<port>.token` (mode 0600 in a 0700 directory;
refused if group/other-readable or owned by another user; delete it to
rotate). First creation is atomic: written and fsynced to a private
temp file, then hard-linked to the final name (never overwriting), so
simultaneous first starts converge on one complete token and no
process can observe an empty or partial file. A permanently invalid
file is rejected with a clear message and left untouched. A newly generated token is printed once on stderr; later
processes only name the file. The token reaches the bridge process on
its stdin (not argv or environment) and never appears in logs. See
`docs/features/feature-28-mcp-bridge-spike.md` for the lifecycle,
heartbeat, worker-restoration, and connection-ownership design, all
unchanged.

## Tools

All schemas are strict (zod `.strict()`): unknown fields — including
approval-shaped ones (`approved`, `confirmed`, `source`,
`challengeId`, `token`) — fail validation before any bridge traffic.
Every page tool requires an explicit `tabId`; a missing, closed,
restricted, or unavailable tab is rejected, never substituted.

Common target input (from one `page_snapshot`):

```json
{ "tabId": 7, "elementId": "el-12",
  "documentSessionId": "…", "revision": 3 }
```

| Tool | Input | Result |
|---|---|---|
| `list_tabs` | `{}` | `{ tabs: [{ tabId, title, url }] }` |
| `page_snapshot` | `{ tabId }` | the production schema-v2 snapshot unchanged (redacted, dropdown metadata included) |
| `highlight` | target | `{ status: "highlighted", … }`; read-only, never activates |
| `highlight_target` | target | compatibility alias of `highlight` (same schema and handler) |
| `click` | target | executor outcome (below) |
| `fill` | target + `value` (≤ 10000 chars, exact text; empty clears) | executor outcome |
| `select` | target + `value` | the EXACT underlying option value from `state.options`; the bridge never converts labels |
| `read_section` | target + optional `maxChars` (100–8000, default 4000) | `{ status: "ok", heading, text, truncated, charCount, sectionTag, … }` |

Every tool returns text (a JSON rendering) AND `structuredContent`
with the same payload.

### Executor outcome statuses

- `verified` — the executor checked the final live state.
- `dispatched_unverified` — activation was dispatched (or verified
  completion could not be established). Never reported as completion.
- `held_for_approval` (`isError: true`) — consequential action held;
  nothing dispatched. Carries the safe confirmation description
  (action, target, consequence, expiry) — never the challenge id.
- `rejected` (`isError: true`) — stale/replaced/invented target,
  wrong session, disabled/readonly, sensitive write, paused/stopped
  gate, busy executor, or pre-dispatch absence. Nothing ran.
- `outcome_unknown` (`isError: true`) — bridge timeout/disconnect or a
  malformed executor response on a mutation: it may already have been
  dispatched. Verify with a fresh snapshot before deciding; the server
  never retries a mutation automatically.

Bridge-level failures on read-only tools keep the #28 codes
(`NO_EXTENSION`, `TAB_UNAVAILABLE`, `TAB_RESTRICTED`, `TAB_NOT_READY`,
`WRONG_SESSION`, `UNKNOWN_TARGET`, `STALE_TARGET`, …).

## One executor, one safety gate

Mutations exist only as the bridge `execute` op, which the service
worker forwards as `SEEYABLE_EXECUTE_ACTION` with audit `source:
"mcp"` set **in trusted extension code** — the MCP caller cannot
choose or upgrade its source, and approval-shaped fields are dropped
by construction (schema + explicit forwarding). All existing executor
checks apply unchanged: session/revision/identity, live state,
effective disabled/readonly, sensitive writes, consequential
classification (including the accepted rule that a survey answer
mentioning "Checkout experience" is not itself a consequential
control), final verification, redacted logging, Stop/Pause. No
generic message forwarding, script execution, approval capability,
or undo internal is exposed.

### Remote confirmation

An MCP-triggered hold is stored by the executor in that tab's document
as usual. Three cooperating pieces surface it in the panel's existing
confirmation card:

1. The service worker sends an unauthoritative runtime hint
   (`SEEYABLE_MCP_CONFIRMATION_HINT`, tab id only) when an execute
   response comes back held. It also writes a session-storage hint
   (`mcpConfirmationHint`: tab id and a per-notification nonce only).
   The open panel observes that change through `storage.onChanged`, so
   a dropped/rejected runtime send is not its only discovery signal.
   Both deliveries are settled before returning the executor response;
   notification failures never replay, approve, or change the held action.
   If both fail, the worker logs notification unavailability. The last
   session hint contains no challenge/request/value and is never approval
   authority; panel startup still discovers holds by binding its snapshot.
2. The panel re-fetches the authoritative pending challenge via the
   new trusted-panel content route `SEEYABLE_GET_PENDING_CONFIRMATION`
   (`executor.getPendingConfirmation()` — public descriptor only, no
   request, value, or binding) and shows the existing card. Snapshot
   binding, command completion, and approval/cancellation completion
   also re-check, so a hold is adopted even if the panel was closed
   when it was placed. Lookup ownership is per tab and
   generation/sequence-scoped (never a global busy flag): an obsolete
   lookup for a previous tab can neither populate the card nor
   suppress discovery for the newly bound tab, and discovery deferred
   behind an operation or a plan review runs when that blocker clears
   — every lock-release path drains it (snapshot/tag acquisition,
   manual execution, clarification choice, command completion,
   plan-preview clearing, approval/cancellation completion) — no
   polling and no focus movement during active work.
3. Approve/Cancel in the card travel the unchanged trusted routes,
   bound to the stored challenge, its SHA-256 submission fingerprint,
   expiry, single consumption, and final-dispatch validation.

The MCP client cannot approve, forge, reuse, or mint anything. After
human approval the single stored action runs (or fails closed);
nothing else continues automatically — further MCP actions need fresh
client calls against a fresh snapshot.

### Missing-card report and notification hardening (2026-11-04)

The Product Owner reported an MCP Submit hold with no visible panel card.
The original transient cause is **not established**: a subsequent read-only
inspection plus a fresh held MCP click displayed the live card correctly,
and Cancel was verified. No survey was submitted. The unmodified isolated
extension also passed normal delivery. A controlled dropped-runtime-hint
regression exposed the single-notification gap: the original code kept the
action held but the already-open panel remained on Settings until a fresh
bind. Session-storage notification now covers that failure independently.

429/429 extension tests pass. The focused real-Chrome/stdio/demo-survey
regression passes 15/15 both normally and with the runtime hint deliberately
rejected; it fills the four fictional fields, holds/cancels twice, recovers
a hold on panel reload, preserves field values and observes zero submissions.
An original-code negative control fails at missing-card discovery. The
patched extension's headed hold/cancel check passed on 2026-11-04 after
reloading the unpacked extension from `apps/extension`: two MCP Submit holds
each surfaced from Settings, both were cancelled, all four fictional field
values remained unchanged, and Stop/Resume replayed nothing. This is
agent-observed headed verification, not a new Product Owner acceptance or
proof of the original incident's cause. Evidence
and safe reproduction commands: [delivery investigation](../evidence/mcp-confirmation-delivery/README.md).

### Automatic snapshot acquisition and discovery

Opening the panel or switching the active tab automatically acquires
and binds a fresh production snapshot for that tab, and the normal
bind path then discovers any pending confirmation — the person no
longer needs to toggle tags (or click Snapshot) to surface an MCP
hold. Acquisition is read-only: no page reload, overlay change, model
request, replay, or approval; tag visibility is preserved. Only the
latest tab intent survives rapid switching (A→B→C binds only C;
late responses bind nothing), acquisition waits behind operation
locks and drains at their release, failures are reported once with
nothing left executable, and automatic acquisition never overwrites
another operation's status outcome. The panel-open active-tab lookup
captures generation/operation ownership before awaiting: if a newer
activation or acquisition supersedes it, the late result is
discarded without submitting an intent, and every automatic
acquisition intent carries its submitting generation so a stale
intent can never acquire at drain time. During initial headed testing,
the Product Owner needed a tag-toggle workaround to reveal the MCP hold.
After the automatic acquisition correction, the Product Owner confirmed
panel-open binding (20 demo controls), tab switching, and automatic
Submit confirmation appearance followed by cancellation, with no tag toggle.
This headed re-check was accepted on 2026-11-02.

## `read_section` contract and limits

Anchor: a current snapshot element id. Enclosing-section rule: the
nearest ancestor that is a `SECTION`, `ARTICLE`, `FIELDSET`, `FORM`,
`MAIN`, or `ASIDE`, or has role `group`/`radiogroup`/`region`/`form`/
`search`; otherwise the target's parent element. Heading: the
section's `aria-label`, a fieldset's `legend`, or the first VISIBLE
heading inside it (hidden headings are never metadata). Content:
visible text only — script/style/noscript/template subtrees, Seeyable
overlays, hidden subtrees, and control-value subtrees are excluded.
A control-value subtree is any native `input`/`textarea`/`select`,
anything `contenteditable` (custom editable controls included), or a
custom control (`role` textbox/searchbox/combobox/spinbutton) the
snapshot engine's centralized classifier marks sensitive — so
editable content can never bypass the sensitive-field policy, while
surrounding labels and prose stay readable. The same exclusion
applies to heading/legend extraction. Changed pages since the
snapshot (`STALE_SNAPSHOT`/`STALE_TARGET`/`WRONG_SESSION`/
`UNKNOWN_TARGET`) reject rather than read a moved target.

Honest limits: this is a bounded prose extract, not an HTML/form dump
and not secret detection — values a page prints as ordinary text
cannot all be recognized, and deeply nested pages resolve to the
nearest sectioning ancestor, which may be broad (e.g. the whole form).

## Lifecycle, duplicates, retries

#28's invariants are unchanged (authenticated single owner, generation
ownership, heartbeat, worker restoration, explicit Disconnect wins,
pending fails on disconnect, port released on shutdown). Issue #19
adds:

- **Duplicate frames**: the extension owns each bridge request id once
  (bounded seen-set); a repeated frame is dropped, so a mutation
  cannot dispatch twice from duplicate delivery.
- **Ownership recheck**: after the tab lookup and immediately before
  forwarding, the handler revalidates socket+generation; a superseded
  connection performs no page work.
- **Bounded request validity**: every bridge frame carries
  `expiresAt` (issue time + the server's request timeout). The
  extension refuses to forward an expired frame (`REQUEST_EXPIRED`),
  and the executor re-checks the same deadline at admission, after
  its pre-dispatch waits, and in its synchronous final validation
  (`DEADLINE_EXPIRED`) — so a request the server already timed out
  can never mutate the page, even while the connection stays healthy.
  Expiry after dispatch may have happened keeps the honest
  `outcome_unknown` mapping; nothing retries automatically.
  Panel-originated requests carry no deadline and are unchanged.
- **No replay**: reconnects restore transport only. The server never
  re-issues a mutation; a timeout/disconnect on one is reported as
  `outcome_unknown`.

## Shared bridge (cross-chat lifecycle)

Files: `server.mjs` (stdio, one per chat), `bridge-daemon.mjs` (the one
listener), `lib/shared-bridge.mjs` (hub + peer protocol),
`lib/hub-launch.mjs` (token source, detached start), small hooks in
`lib/bridge.mjs`. The extension is unchanged.

- **Startup order.** A stdio process answers MCP `initialize` first,
  then joins the bridge. A busy or broken port can no longer prevent a
  chat's session from starting; tools report the reason instead.
- **One listener.** If nothing listens on the port, the joining
  process starts `bridge-daemon.mjs` detached (stdout never shared with
  MCP traffic; log at `~/.seeyable/bridge-<port>.log`) and retries for
  up to 6 s. Concurrent starters race on the bind; the losers exit 0
  without touching the winner. The bridge exits by itself after 5 min
  with no MCP peers (`SEEYABLE_BRIDGE_IDLE_MS`); the next chat starts a
  new one and the extension re-pairs automatically with the same token
  on its existing backoff.
- **Authentication of every shared-bridge connection.** Peers use a
  separate path (`/seeyable-mcp-peer`) that refuses any request with an
  `Origin` header (every browser WebSocket has one, so no webpage can
  be a peer). Peer and bridge prove the token to each other with
  HMAC-SHA256 over fresh nonces from both sides; the token itself never
  crosses that socket, the bridge proves only after the peer has, and
  the peer sends no request until the bridge's proof checks out.
  Anything else on the port (plain HTTP, an impostor WebSocket, an
  older Seeyable server, a bridge with a different token) is reported
  as `PORT_CONFLICT` and is never sent a request, never replaced, and
  never terminated.
- **Isolation.** Peer request ids are scoped to that peer's socket;
  the bridge issues a fresh globally unique id per forwarded request
  and routes the answer back through that peer's own promise, so two
  chats can both use local id `q1` without colliding or seeing each
  other's results. A duplicate id from one peer is dropped (never
  forwarded twice). Only the five existing ops (`tabs`, `snapshot`,
  `highlight`, `execute`, `read_section`) are accepted; there is no
  approval frame or op.
- **Deadlines, heartbeat, failure.** A request's validity starts when
  the peer issues it: the peer's transport code stamps `expiresAt`
  (issue + 15 s; never taken from MCP tool input, whose schemas are
  strict). The hub refuses a missing deadline (`INVALID_REQUEST`) or an
  already-expired one (`REQUEST_EXPIRED`) without forwarding, and
  `bridge.request` takes the earlier of that and its own 15 s window —
  it can shorten, never extend. The extension and executor keep their
  final pre-dispatch checks against the same value, so a request
  delayed in transit cannot dispatch after its caller saw `TIMEOUT`
  (which still maps to `outcome_unknown` on mutations; nothing retries). WebSocket ping/pong runs both ways
  every 15 s between peers and the bridge; the extension heartbeat is
  unchanged. An extension drop fails every peer's pending work
  (`NO_EXTENSION`) and pushes status; a bridge crash fails that peer's
  pending work (`BRIDGE_UNAVAILABLE`; on mutations `outcome_unknown`).
  Peers reconnect in the background (and restart the bridge if it is
  gone); reconnecting restores transport only and nothing is replayed.
- **Closing a chat** closes only that peer link. Its in-flight results
  are dropped at the bridge; other chats and the pairing are unaffected.
- **Safety unchanged.** Every action still goes through the extension
  to the ONE shared executor with `source: "mcp"` set in trusted
  extension code; holds wait for a human in the panel.

Remaining limitations: the extension still sends its token in clear to
whatever listens on its configured port (unchanged #28 behaviour; an
impostor that grabs the port first could capture it); a user-chosen
weak `SEEYABLE_BRIDGE_TOKEN` is open to offline guessing from a
captured peer proof (generated tokens are 256-bit); any same-user
process that can read the token file can act as a peer, as it could
already act as the server.

## UI changes

None visual. The only panel change is behavioral: adoption of a
pending confirmation into the existing card (above), reusing its
focus, expiry text, and Approve/Cancel controls. No new IDs, screens,
or styling.

## Runbook

Any number of stdio servers (chats, Inspector, custom clients) may run
on one port at once; they share one bridge process and one pairing.
Give every client the same `SEEYABLE_BRIDGE_TOKEN`, or leave it unset
everywhere to use the token file.

Inspector GUI (headed, operator-run):

```
cd apps/mcp-server && npm install     # once
npx @modelcontextprotocol/inspector node server.mjs --port 6123
# token: SEEYABLE_BRIDGE_TOKEN, or the one printed when first generated
#        (also in ~/.seeyable/bridge-6123.token)
# extension side panel → Developer view → same token + port → Connect
# Inspector → Tools → list_tabs, then page_snapshot, then act by id
```

Custom stdio clients work the same way (initialize →
notifications/initialized → tools/list → tools/call). Labels matter:
custom-client evidence is not an Inspector GUI run.

Common failures: wrong token (`auth_failed`, close 4401); port held
by something that cannot prove the token — including a still-running
pre-fix Seeyable server — (`PORT_CONFLICT`; quit that client, or use
the same token everywhere); missing content script (`TAB_NOT_READY` —
reload the tab); stale snapshot (take a fresh one; never expect the
bridge to retarget); held action (approve or cancel in the panel; do
not retry as approved); disconnects (reconnect restores transport
only; re-issue reads, verify before re-issuing any mutation).

## Verification

Cross-chat shared bridge (2026-11-02; agent-run, labelled by kind):

- `npm --prefix apps/mcp-server test` — 35/35: the 21 existing tests
  unchanged in substance (the stdio test now uses a temp state dir),
  plus 10 in-process shared-bridge tests (real bridge + hub + peer
  clients, scripted extension socket: second-bind rejects with no
  unhandled error; two peers with colliding local ids get only their
  own out-of-order results; closing one peer leaves the other and the
  pairing; extension drop fails both peers' pending work and replays
  nothing on reconnect; per-caller deadline with dropped late answer;
  mid-flight bridge loss → `outcome_unknown`, dispatched once;
  duplicate ids forwarded once and an `approve` op refused; wrong token
  and web-origin peers refused; plain-HTTP and impostor-WebSocket
  owners never trusted, never sent a request or the token, never
  replaced; no-listener start-once) and 4 multi-process tests (REAL
  `server.mjs` processes and REAL bridge process, scripted extension:
  three chats started simultaneously all initialize with exactly one
  listener, which is the bridge process; generated token file is 0600;
  closing chats one by one leaves the rest working on the same bridge;
  concurrent cross-process routing; unrelated port owner →
  initialize OK, `PORT_CONFLICT`, owner untouched; SIGKILL of the
  bridge mid-click → `outcome_unknown`, both chats recover through an
  automatically restarted bridge, click never replayed; idle exit).
  Flakiness note: one early full run reported 34/35 and its output was
  not captured; 17 reruns did not reproduce it. A narrow join-during-
  idle-shutdown race was then hardened (idle exit re-checks peers; a
  pre-hello drop is retried once before `PORT_CONFLICT`), after which
  12 parallel full runs passed 35/35. The original failure's cause is
  not confirmed.
- Reviewer-correction pass (2026-11-02): `npm --prefix apps/mcp-server
  test` — **41/41** (35 above + 3 deadline regressions: delayed-delivery
  zero execute frames, live slow-hop success keeping the issue-time
  expiry, clamp/missing/past expiry at the hub; + 3 token tests in
  `tests/token.test.mjs`: deterministic paused-creator/concurrent-reader
  convergence with reuse by a later process, 8 simultaneous starters
  with exactly one publisher, invalid/unsafe files rejected and left
  untouched). Reviewer repros rerun: deadline `1 → 0` execute frames;
  token reader error → complete token. Stress: 25 full runs (15 in
  parallel + 10 sequential) 25/25 clean after fixing two
  timing-fragile TESTS found while stressing — the duplicate-id test
  read the hub hello after a fixed 50 ms delay (`undefined.type` under
  load), and the new live-deadline test's upper bound was too tight
  (`actual false`) — plus an unhandled-rejection ordering in the
  extension-drop test. A failed test had left sockets open and hung its
  file indefinitely; `npm test` now passes `--test-timeout=120000`.
  Whether either of these was the earlier unexplained flaky run is not
  established. Real headless Chrome + real extension rerun: 19/19.
- `npm --prefix apps/extension test` — 334/334 (extension unchanged).
- Real headless Chrome + REAL unpacked extension + REAL stdio
  processes (SDK clients; NOT ChatGPT desktop, NOT Inspector GUI),
  demo survey, bridge port 6141: **19/19** — two chats start
  concurrently and initialize before pairing; one listener (bridge
  process); the extension pairs once through the panel UI; both chats
  get the real 20-control snapshot of the same document; B highlights,
  A fills (verified, page changed); closing A leaves B, the bridge,
  and the pairing intact; new chat C joins with no re-pair; C's Submit
  is held, appears in the panel card, is cancelled, nothing submitted;
  SIGKILL of the bridge → honest error, then automatic bridge restart
  and extension re-pair with no operator action (~1.9 s), B and C
  recover, no replay (page unchanged, no submission); token absent
  from the bridge log; bridge idle-exits after the last chat.
  Harness: `shared-e2e.mjs` in the session scratchpad (uncommitted).
- Real, against the Product Owner's live pre-fix ChatGPT/Codex server
  on 6123 (not modified or stopped): a new fixed-code stdio process
  initialized, listed 8 tools, and `list_tabs` returned
  `PORT_CONFLICT` (close 4403); no second listener was started.
- ChatGPT desktop, 2026-11-02: fixed shared bridge running on 6123;
  after extension pairing, this chat's real `list_tabs` succeeded and
  the Product Owner confirmed the other chat worked without re-pairing.
  Do not infer that all of the detailed headed steps below were individually
  recorded; the full external-agent workflow remains Issue #20.

Headed steps for the Product Owner (ChatGPT desktop):

1. Quit ChatGPT completely (its running Codex process still holds 6123
   with the pre-fix code; only you should stop it). Check
   `lsof -nP -iTCP:6123 -sTCP:LISTEN` shows nothing.
2. Keep the existing Seeyable MCP config. If it sets
   `SEEYABLE_BRIDGE_TOKEN`, keep that value; otherwise the first chat
   creates `~/.seeyable/bridge-6123.token` and prints it once in the
   MCP server log.
3. Reopen ChatGPT and start chat 1; ask it to call `list_tabs`. Then
   `lsof` should show one `node …/bridge-daemon.mjs` listener.
4. Pair once: side panel → Developer view → that token, port 6123 →
   Connect. Chat 1: `page_snapshot` on the demo tab.
5. Open chat 2 (and a third); each should start without "connection
   closed: initialize response" and get `page_snapshot` with no
   re-pairing.
6. Close or delete chat 1; chat 2 still snapshots. Ask chat 2 to click
   Submit: it must return `held_for_approval` and appear in the panel;
   cancel it.
7. Optional failure check: `pkill -f bridge-daemon.mjs`; the next call
   fails honestly, and a retry after a few seconds succeeds without
   re-pairing.

Earlier single-client evidence:

- `npm --prefix apps/mcp-server test` — 21/21 (11 #28 bridge/auth/
  lifecycle + 10 #19: strict-schema and approval-field rejection,
  outcome mapping incl. held/timeout-unknown/no-extension, exact-value
  forwarding, alias identity, real stdio tools/list + NO_EXTENSION;
  request frames now asserted to carry `expiresAt`).
- `npm --prefix apps/extension test` — 334/334 (incl. bridge execute
  forwarding with `mcp` source, duplicate-frame single dispatch,
  ownership-before-dispatch, content pending-confirmation trust
  boundary, bounded/redacted `read_section` with stale rejection,
  panel adoption + approve-once, plus corrections: editable/sensitive
  section exclusion with hidden-heading protection, bridge + executor
  deadline enforcement, cross-tab obsolete-lookup,
  deferred-behind-plan adoption, deferred-behind-manual-operation
  adoption drained at lock release, and automatic snapshot
  acquisition on panel open/tab activation with rapid-switch,
  lock-release, unavailable-tab, and hold-discovery regressions).
- `npm --prefix packages/shared test` — 11/11; planner-proxy 15/15
  (untouched, regression only).
- Headless real-browser run (custom stdio client, NOT Inspector GUI):
  27/27 — real extension + real server + demo survey: pairing via the
  panel UI, snapshot (20 controls, dropdown metadata), highlight,
  verified fill/select/radio-click observed in the page, bounded
  section read without the PIN value, sensitive fill rejected with the
  PIN unchanged, approval-shaped field rejected, Submit held with
  zero dispatches, panel card adoption, approve-once (exactly one
  submit), second hold cancelled with nothing further running.
  Harness: `/tmp/spike-run/mcp19-e2e.mjs` (local, uncommitted).

- Product Owner headed Inspector GUI checks, 2026-11-02: Google Forms
  snapshot (35 controls), highlight, bounded section read (498 characters,
  truncation reported), Visitor name fill with synthetic Alex Demo,
  Get advice click, and Checkout-experience Satisfied click without an
  unnecessary hold passed. Local demo select returned verified with exact
  value `designer`; Submit returned held_for_approval, appeared in the
  panel, and cancelled without submission. Initial card discovery needed
  a tag toggle; the final re-check below supersedes that limitation.
- Final headed re-check, 2026-11-02: Product Owner confirmed automatic
  panel-open snapshot binding, tab-following, and an MCP Submit hold
  appearing without a tag toggle and cancelling without submission.
  The agent directly called list_tabs, page_snapshot (20 demo controls),
  and click on the current snapshot's Submit target in this chat; click
  returned held_for_approval. Human approval was not supplied.
- External-client scope: direct chat discovery/snapshot and the held Submit
  are verified; a complete multi-step external-agent workflow remains #20.
  The full three-run Google Forms script has not been rerun through MCP.
  Headed approve-once and sensitive-write probes are not claimed here;
  their automated/headless evidence remains as listed above.
