# Submission readiness — Seeyable

Updated 2026-11-04. This replaces the stale November 2 checklist with the
current evidence. It is an audit, not a submission receipt or eligibility
ruling. The owner froze the demo video; no further recording is requested.

## Submission links

- Repository: https://github.com/nmheinrich/seeyable
- Demo (Unlisted, English captions): https://youtu.be/5b1S07UP6X4
- Judging download and setup: https://github.com/nmheinrich/seeyable/releases/tag/v0.1.0-judging-r3
- Official submission portal: https://cerebralvalley.ai/e/meta-ai-developer-hackathon/hackathon/submit

The public event page currently lists submissions due **November 4 at
9 PM ET**. It says dates may change. Recheck organizer updates and the
signed-in portal before relying on a cutoff. The public page does not expose
this participant's signed-in form fields, draft state, or submission receipt.
The unofficial community score is not an official judging result.

## Verified and bounded

| Area | Evidence | Limits |
|---|---|---|
| Demo | Owner-approved video, approximately 2:54; uploaded Unlisted, corrected English captions; signed-out playback checked earlier in this chat | Frozen by owner; no new video iteration |
| Public repository | Public GitHub metadata checked; MIT license and font OFL notices present | Latest checkpoint must be pushed and reflected in release provenance |
| Typed first run | Fresh signed-out Chrome profile: ZIP install, Tags, fill, Undo, 20 Targets, Submit held and Cancel | Agent-observed; separate from voice and model calls |
| Docker planner | Build/start from ZIP; auth/origin rejection; blank-key refusal; live two-field Meta plan; owner passed Chrome pairing and reviewed execution | Private key supplied locally, not packaged; no sponsored hosted proxy |
| Docker extraction permissions | Owner exposed an EACCES failure; reproduced with 0600 files/0700 directories; corrected image passed startup/fixture/auth/MCP checks | Owner used the documented repair; current r2 package includes the fix |
| Muse Code MCP | Owner passed connection, survey discovery/snapshot/fill/page verification with session-only config | Guided test; persistent config merge, Muse Submit/Cancel and every action type not claimed |
| Shared safety | Prior accepted executor and Codex Work workflows; fresh typed Submit hold/Cancel evidence | Do not imply all clients have passed the same probes |
| Client guides | ChatGPT desktop/Codex, Claude Desktop/Code, Muse Code; token-file default; optional env override; setup helper | Claude browser workflow untested; clipboard branch simulated in helper testing; owner paired manually |
| Runtime Meta use | muse-spark-1.3 planner; separate Meta transcription evidence in status.md | No open-weight stage, provider comparison, perfect recognition or measured general adoption claimed |

Evidence: `docs/evidence/judge-first-run/README.md`, `docker-check.md`,
`docker-permissions.md`, `mcp-setup-helper.md`, and `muse-code-acceptance.md`.
Broader prior acceptance and remaining probes are recorded in `docs/status.md`.

## Remaining submission work

1. Review and merge the Docker, packaging, helper and documentation checkpoint
   into the judged branch. Unrelated `.agents/`, `demo-production/` and
   `skills-lock.json` are outside its scope. The r3 release records the
   checkpoint source commit; use its current download link.
2. Owner confirmed on November 4: solo submission; no Seeyable product code
   existed before October 26, only the name and repository. Accepted participant
   status and actual portal selections still require the owner's check.
   The survey remains excluded from new product claims as a pre-existing
   fixture under the project brief. Its README now follows that brief.
3. Read the actual signed-in submission field labels, limits and requirements.
   Intended track/theme are Indie Developer / Push the Frontier; actual
   selections, bonus fields, required attestations and receipt are unverified.
4. Populate the form with the repo, frozen demo and current release links;
   explain that live panel planning/transcription requires the judge's own
   Meta key, while local MCP uses the external agent's account/model setup.
   Neither API keys nor pairing tokens belong in the submission form.
5. Owner reviews the final fields and performs final submission, including any
   organizer attestations. Record the receipt/time and final source commit.

No user study, adoption, accessibility-conformance, time-saved, perfect
transcription, or open-weight model claim should be added without evidence.
No X-post/viral-prize claim is established in this audit.

## Suggested project description

Seeyable turns webpage controls into labeled, callable tools. A person can
operate the page by voice or typed requests, while a local AI agent uses
MCP. Muse Spark 1.3 turns natural-language requests and pruned, redacted
snapshots into structured plans for review. Both paths use the same executor,
which checks current targets and holds consequential actions for human
confirmation. The demonstration uses fictional data; the included survey
is a pre-existing test fixture rather than the product.

## Setup risks and follow-ups

- Existing native MCP clients can restart a bridge on port 6123. Disable that
  native connection before switching to Docker; avoid repeatedly killing
  the bridge while its parent client is still active. Similar port conflicts
  can occur with an existing planner or sample server.
- The helper currently generates configuration and copies a token; it does
  not install client settings. The guide includes the owner-tested one-session
  Muse launch command to avoid editing JSON. A direct launch option remains
  a follow-up, not part of this checkpoint.
- The Docker build's npm audit reported high-severity zod advisory
  GHSA-mrhx-c7xc-m3w5 for the existing dependency. Dependency upgrade and
  exploitability assessment were not part of this setup checkpoint. Do not
  describe the project as having a clean dependency audit.
- Speech recognition and upstream latency remain variable. These limits are
  documented and do not justify reopening the owner-frozen video.
