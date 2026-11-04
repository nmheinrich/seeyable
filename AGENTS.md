# Seeyable — project brief for coding agents

Seeyable is a Chrome extension (Meta Global AI Developer Hackathon, Indie /
Push the Frontier) that turns any webpage into labeled, safe, callable tools:
a person operates the page by voice; external agents operate it via a local
MCP server. Same executor, same safety gate for both.
Design: Plain Words (D) is the selected design reference. The approved
panel mockup is frozen at DESIGN/plain-words-panel-mockup-2026-11-01.html
and implemented by the Plain Words panel issue (supersedes #29; headed
visual acceptance pending — docs/features/feature-plain-words-panel.md).
The side panel is a Plain Words surface — identity, status, the main card,
and Stop/Resume + Undo placed by state over the screens (Assist / Targets /
Activity / Settings): with the task on Assist while idle, pinned on every
screen while anything is in progress or an agent bridge is connected or
wanted, and both hidden while talking if neither applies (Product Owner
decision, 2026-11-04, #31; this supersedes the frozen
mockup's always-visible bar); diagnostics in a
collapsible Developer view under Settings › Advanced —
and overlays use word-first token pills with a quiet number dot,
placement verified clear of controls and rendered text, and omission
to the panel Targets list when nothing is clear (never number piles,
never a forced badge for the active target). Keep later work inside that
visual system; do not invent a competing one, and do not build agent
states until their features exist.

## Architecture (build in this order)
- apps/extension — MV3: content script (snapshot/labels/overlay/executor),
  side panel (voice + UI), service worker
- apps/planner-proxy — holds the Meta Model API key. NEVER put API keys in
  the extension or commit them anywhere.
- apps/mcp-server — Node, stdio, local-only; reuses the SAME executor
- apps/demo-survey — mock survey used as a test target. It is a pre-existing
  fixture, NOT the product; never present it as hackathon-built work.
- packages/shared — snapshot + plan JSON schemas, single source of truth

## Hard rules
- The planner may only reference element ids present in the current snapshot.
- Safety gate lives in the executor: password/payment values are redacted in
  snapshots; Submit/Pay/Delete require explicit human confirmation — for the
  voice UI and for MCP agents equally.
- No: wake word, auto-submit, cloud MCP, other browsers, government forms or
  real personal data in demos.

## Current work
Issues #6 (production snapshot engine), #7 (visual overlays), #8 (executor
actions), and #9 (manual execution test panel) are complete and accepted.
Issue #10 (voice front end and typed fallback — show/hide tag commands
only) is complete and accepted. Issue #11 (shared executor safety
gate: human confirmation, action log, Stop/Pause) is complete and accepted.
Issue #29 (Plain Words product interface and overlay refinement) was
parked on 2026-10-30 and is superseded by the Plain Words panel issue
(implemented 2026-11-01 from the approved mockup: merged Stop/Resume, Undo
button, Tags toggle, speak prompts, panel-only Alt+S, step progress, and
acting/done/held page tag states; automated and headless evidence only,
headed visual and voice acceptance PENDING). Issue #28 (early local MCP bridge smoke test: stdio server,
loopback bridge, tab-explicit snapshot/highlight tools) is complete and
accepted. Product Owner confirmed explicit disconnect/re-pair and stale-target
rejection after the headed snapshot/highlight and idle checks passed.
Issue #12's timeboxed transcription spike is complete with an INCONCLUSIVE /
KEEP Web Speech decision. No provider comparison was run; the isolated file
client has offline tests only, and the live comparison harness is incomplete.
Issue #13 (planner fast path: deterministic local click/fill resolver on the
shared executor) is checkpoint ready: headed typed-command checks and a live
voice click producing exactly one counter increment passed. Voice fill remains
limited by fill/feel/Phil recognition; full voice acceptance is not claimed.
Issue #14 (Muse Spark planner via planner-proxy: loopback proxy holding the
Model API key, shared plan contract, pruned snapshots, guarded sequential
execution, cached corrections) is complete and accepted: the Product Owner
confirmed the full canonical Act 1 script typed then spoken on 2026-10-31,
including the dropdown fix. Recognition remains imperfect; clear speech
is needed. Issue #15 (plan preview/editing, voice approval, last-change undo)
is complete and accepted for its core mouse-free workflow: the Product Owner
confirmed preview, voice edit, unsupported-approval retention, contextual
approval, and undo on 2026-10-31. Speech recognition still repeatedly heard
“Grasshopper” for “Grace Hopper”; exact-name transcription is not established.
Supplementary headed safety probes remain separately listed in the feature doc.
See docs/status.md for verification evidence.
Definition of done for any task: works on the demo survey, sample output or
test evidence included, scope not expanded beyond the issue.
