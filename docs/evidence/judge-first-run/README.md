# Judge first-run check — 2026-11-04

Result: **PASS for the key-free typed quickstart**, observed by the agent
in native desktop Chrome in a newly created, signed-out local profile,
`Seeyable Judge Check`. This is not a new Product Owner acceptance.

## Exact artifact

- Source commit: `b3188fb64bf1f1bb335212934564babc94e63ed6` (merged main).
- Built with `python3 scripts/package-judging.py`.
- Artifact: `dist/seeyable-judging-0.1.0.zip`, 323,512 bytes, 53 files.
- SHA-256: `1aab57eec7536313dcbc539b6c325c53f0bccdde482fd04a0d1da8fa286edf7f`.
- Loaded the `extension` directory from a fresh extraction of that ZIP,
  not from the repository checkout. Chrome displayed Seeyable 0.1.0 enabled.
- The bundled pre-existing survey fixture was served from that extraction.
  Port 8766 replaced 8765 because the latter already had a local service;
  the existing service was left alone. The test's own server was stopped
  afterward. The extracted folder and local test profile remain available.

## Observed checks

| Check | Result | Evidence |
|---|---|---|
| Load unpacked, open sample, click toolbar icon | Panel opened, Ready, 20 controls; no account, build, Node, or API key setup | Subsequent screenshots show profile and panel |
| Turn Tags on; type `fill Full name with Ada Lovelace`, Send | Full name became Ada Lovelace; panel reported the page check passed | [fill.jpg](fill.jpg) |
| Undo last change | Full name returned to empty; panel reported verified restoration | [undo.jpg](undo.jpg) |
| Open Targets | Listed 20 controls, including panel-only tags and disabled control | [targets.jpg](targets.jpg) |
| Additional safety probe: type `click Submit survey` | Held; explicit approval card; nothing executed | [held.jpg](held.jpg) |
| Cancel held action | Approval revoked; nothing executed | [cancelled.jpg](cancelled.jpg) |

No survey submission was approved. Only fictional input was used.

## Limits and remaining delivery work

This verifies the key-free typed installation/first-use path. Voice,
microphone permission, Meta proxy/model calls, Docker, and external MCP
client setup were not tested in this fresh profile. Earlier evidence for
those paths remains separate. This was an agent following the quickstart,
not a timed study with an unfamiliar human judge.

The exact tested ZIP was published on 2026-11-04 as the public
[v0.1.0-judging release](https://github.com/nmheinrich/seeyable/releases/tag/v0.1.0-judging),
with a checksum and START-HERE guide. An anonymous download returned HTTP
200, matched the SHA-256 above, and passed ZIP integrity checking.
[Direct ZIP download](https://github.com/nmheinrich/seeyable/releases/download/v0.1.0-judging/seeyable-judging-0.1.0.zip).
This release URL still needs to be included in the submission.
The release attachments were subsequently corrected for Docker and their
setup notes refreshed. The current distribution hash and separate Docker
verification are recorded in [docker-check.md](docker-check.md); the initial
typed first-run artifact above remains the historical tested hash.
The demo video remains https://youtu.be/5b1S07UP6X4.
