# Seeyable — project brief for coding agents

Seeyable is a Chrome extension (Meta Global AI Developer Hackathon, Indie /
Push the Frontier) that turns any webpage into labeled, safe, callable tools:
a person operates the page by voice; external agents operate it via a local
MCP server. Same executor, same safety gate for both.
Design: Plain Words (D) is the selected design reference; the current
implementation has NOT received visual acceptance. The side
panel is a Plain Words surface — identity, status, commands, and
safety always visible; diagnostics in a collapsible Developer view —
and overlays use word-first token pills with a quiet number dot,
placement verified clear of controls and rendered text, and omission
to the panel Targets list when nothing is clear (never number piles,
never a forced badge for the active target). Keep later work inside that
visual system; do not invent a competing one, and do not build
plan/agent/undo states until their features exist.

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
Issue #29 (Plain Words product interface and overlay refinement) is
implemented but visually NOT accepted, and deferred by the Product Owner
on 2026-10-30. Preserve its work; do not resume visual refinement unless
requested. Issue #28 (early local MCP bridge smoke test: stdio server,
loopback bridge, tab-explicit snapshot/highlight tools) is complete and
accepted. Product Owner confirmed explicit disconnect/re-pair and stale-target
rejection after the headed snapshot/highlight and idle checks passed.
See docs/status.md for verification evidence.
Definition of done for any task: works on the demo survey, sample output or
test evidence included, scope not expanded beyond the issue.
