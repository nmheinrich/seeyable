# Hackathon submission readiness — Seeyable

Audited 2026-11-02 against the local working tree and public repository metadata.
This is an evidence audit, not a declaration of eligibility or submission.
Changes in the working tree are not automatically present on public GitHub.

Sources:

- [Community 20-point checklist](https://artifacts.watt-mind.com/meta-hackathon-2026/checklist)
  — explicitly unofficial; useful preparation guidance, not the governing rules.
- [Official event details and rules](https://cerebralvalley.ai/e/meta-ai-developer-hackathon/details)
  — retrieved including the page's embedded rule text. Confirmed rubric:
  Impact 30%, Meta AI Tooling 25%, Technical Depth & Execution 20%, Demo 25%.
  Published submission deadline: November 4, 2026, 9 PM Eastern
  (November 5, 02:00 UTC). Check the portal for any organizer updates.

Do not treat checklist recommendations (e.g. 80% product footage or keyless
replay) as independently verified mandatory rules. Bonus mechanics, video
cutoff enforcement, portal fields, and post-deadline code policy below are
community-reported and need final portal/participant-guide verification.

## All 20 checklist items

“Unverified” means no evidence was found here; it does not mean the artifact
or account state cannot exist elsewhere.

| # | Checklist item | Current evidence / remaining action |
| --- | --- | --- |
| 1 | Video ≤ 3 minutes | Unverified: no submitted video URL found. Target 2:55. |
| 2 | Opening provenance statement | Open: project instructions treat the survey as pre-existing; its own README says created during the event. Reconcile before claiming the entire project was built from scratch. |
| 3 | Predominantly real execution footage | Unverified: record the running extension, not a conceptual pitch. |
| 4 | Live Meta calls and model roles visible | Partial: genuine-model planner acceptance exists. Capture a fresh successful call with model name and redacted request status; never show keys, pairing tokens, or secret-bearing terminal history. |
| 5 | Public/unlisted video, English audio/captions | Unverified: publish and test the final URL in a signed-out browser. |
| 6 | One public GitHub repository | Verified: unauthenticated GitHub API returned 200, `private: false`, for `nmheinrich/seeyable`. Final working-tree changes still need publication. |
| 7 | Quickstart and `.env.example` | Present: root README now covers local, planner, and MCP setup; proxy example exists. Fresh-clone Chrome onboarding remains unverified in this audit. |
| 8 | Keyless replay/traces/evaluation | Partial: local click/fill and offline automated suites work without a Meta key. There is no packaged end-to-end planner replay or judge-facing trace bundle. Tests are not a live Meta demonstration. |
| 9 | No personal third-party login barrier | Local fixture needs no personal login. Google Forms is the primary rehearsed demo; confirm its shared URL works signed out, or offer the local fixture as the account-free fallback. A judge still needs model credentials for live planner calls. |
| 10 | Quantitative benchmarks/custom weights | Partial: test counts, 20-control snapshot coverage, and three human-reported form runs exist. No measured latency, recognition accuracy, or full workflow success benchmark. No custom weights are claimed. |
| 11 | Bonus category named in README/form | README now identifies Best Agentic Use-Case as the target. Portal text and end-to-end external-agent proof remain open. This is a target, not a verified award qualification. |
| 12 | Load-bearing Meta open-weight stage | Not implemented/claimed. Hosted Muse Spark 1.3 alone does not establish the community-described open-weight bonus qualification. Do not add another model solely for a checkbox. |
| 13 | Correct track | Intended: Indie Developer / Push the Frontier, per project instructions. Actual portal selection unverified. |
| 14 | X video post linked | Unverified; relevant if pursuing the viral prize. Confirm current organizer terms before relying on reported scoring/deadlines. |
| 15 | Approved participants, ≤4, one team | Unverified account/team facts; owner must confirm. AI development assistance is distinct from human participant membership. |
| 16 | Eligible use case with technical differentiation | Technical evidence supports a browser interaction layer: snapshot identity, target binding, stale rejection, review, and shared executor safety. No prohibited use case is in the agreed demo scope. Final eligibility remains with organizers. |
| 17 | Project LICENSE | Added MIT with owner approval in this chat. Existing font OFL notices retained. Publish with final code. |
| 18 | Submission fields complete | Unverified: check GitHub URL, video URL, track, theme, Meta-use description, and X URL where applicable against the actual portal. |
| 19 | Draft submitted before deadline | Unverified: prepare a draft and test all links before November 4, 9 PM Eastern. Do not wait for optional bonus work. |
| 20 | Deadline code freeze | Pending: select final commit, publish all required tracked assets before cutoff, record hash, and follow the official post-deadline policy. Avoid changing the judged branch afterward. |

## Priority order

### First: make the existing build judge-ready

1. Reconcile provenance. `AGENTS.md` and the accepted demo script say the survey
   is pre-existing; `apps/demo-survey/README.md` says it was created October 26.
   Git history alone does not establish off-repository provenance. Until
   resolved, exclude the survey from claims of new product work. List precisely
   which Seeyable components were built during the event.
2. Run the README from a clean clone/profile: local field change, live Muse
   two-field plan with preview/approval, then held Submit/cancel. Record build
   hash, environment, expected vs actual outcomes, and any retries.
3. Complete the pending headed Plain Words acceptance and one complete external
   agent run. Prefer a Muse-powered client for the recorded agent path; keep
   the MCP bridge local and human confirmation in Seeyable. Do not remove the
   panel planner to add this path.
4. Commit a small redacted evidence bundle: reproducible commands, sample
   structured plan/outcomes, screenshot(s), and clearly labeled live vs stub
   results. Existing E2E harnesses under `/tmp` are not reproducible from GitHub.
5. Record/publish the video; test every submitted link signed out. Confirm
   membership, track/theme, and actual form fields. Publish README/LICENSE.

### Then: strengthen the scoring evidence

- **Impact (30%):** pick a concrete beneficiary (e.g. someone who needs
  hands-free form interaction). Show the actual task, the barrier, and the
  resulting capability. No user-study, accessibility-conformance, or time-saved
  claim without measurements.
- **Meta AI Tooling (25%):** show a compound request that needs interpretation,
  its Muse-generated structured plan, and successful guarded execution.
  Simple local commands alone do not demonstrate the Meta contribution.
  A live Muse external-agent sequence makes the second path concrete.
- **Technical Depth (20%):** show stale-target rejection, one held consequential
  action, and shared executor behavior. Summarize evidence rather than counting
  every assertion as an independent workflow success.
- **Demo (25%):** finish with the working product and evidence. Setup should
  already be complete when recording; rehearsal needs a recovery path if speech
  transcription fails. Avoid promising zero-setup installation.

For a compact benchmark, fix the build and a synthetic task set first. Measure
per-task successful verified completion, recognition retries, model request
latency, and end-to-end time separately. Include failures and denominators;
report typed and voice runs separately. Do not turn the existing report of
three successful rehearsals into invented timing/accuracy data.

## Proposed video sequence (2:55)

| Time | Footage / purpose |
| --- | --- |
| 0:00–0:10 | Running product; one-sentence problem and accurate build provenance. |
| 0:10–1:20 | Voice compound request → live Muse plan → preview/approval → verified page changes. Show enough model status to establish the call without credentials. |
| 1:20–2:00 | External Muse-backed agent uses local MCP to inspect and change the same page; only include after the full workflow passes. Otherwise use this time for additional proven panel behavior. |
| 2:00–2:30 | Submit held for human confirmation; Cancel leaves it unsubmitted. Show Stop/Resume or a stale-target rejection if time permits. |
| 2:30–2:45 | Real measurements over product footage, with sample size and test conditions. If not measured, show substantiated functionality instead. |
| 2:45–2:55 | Who benefits, model role, public repo, and closing sentence. |

Use captions and readable crops. Speed changes should be labeled. The video
must work on its own without a later Q&A explanation. Timing is a proposal;
no recording is claimed by this document.

## Draft “Use of Meta products” text

Seeyable uses Muse Spark 1.3 through Meta Model API at runtime to translate
natural-language requests and pruned, redacted webpage snapshots into
structured action plans. Plans reference only supplied snapshot targets and
are validated before the person reviews them. A deterministic executor
checks live target identity/state and holds consequential actions for explicit
human confirmation. The same executor serves a local MCP interface for
external agents. We target Best Agentic Use-Case through grounded browser
interaction and human control. The current build does not claim a Meta
open-weight model stage.

Add a sentence naming the external Meta agent and measured results only after
that integration has actually passed. Never imply that using Meta tools to
write code proves runtime model use.

## Outstanding owner facts

- Confirm accepted participant(s), team membership, and portal track/theme.
- Resolve build-window provenance and survey documentation discrepancy.
- Supply final public video, submission confirmation, and optional X post URL.
- Confirm bonus and deadline policies in the actual participant guide/portal.

## Audit verification and limits

Read the checklist HTML, official embedded rule text, repository setup,
feature/status records, and unauthenticated public GitHub metadata. Checked
local documentation links and whitespace after changes. This pass did not
rerun live browser/model workflows, inspect the private submission portal,
measure performance, publish changes, or audit all history for secrets.
