# Feature #13 — Local command fast path (deterministic click/fill)

Status: **checkpoint ready; headed typed-command checks and real-microphone
click passed, with voice fill limited by recognition.** The Product Owner
reported Web Speech repeatedly recognizing “fill” as “feel” or “Phil”.
No action-verb aliases were added, and full voice acceptance is not claimed.

## Product Owner headed evidence

Confirmed passed: exact typed fill (`Full name`), fuzzy target fill
(`ful name`), Submit held without execution and cancelled, compound-command
rejection, ambiguous rating clarification and tab-switch invalidation, all
five rating choices reachable with option 5 selecting the intended radio,
and one visible unsupported-command error without the Needs attention pill.
The Product Owner also confirmed a single spoken `click Increment counter`
command increased the fixture counter by exactly one. These observations
validate the typed path, reported UI corrections, and the live voice-to-click
path; they do not establish reliable voice fill or full Act 1 coverage.

Baseline: `15f637b`. Not a planner: a small on-device resolver for
anchored single-action commands, connected to the existing guarded
executor. There is intentionally no Act 1 Action 2+ planning here,
and the canonical four-sentence Act 1 script remains unavailable, so
no complete Act 1 coverage is claimed.

## Supported grammar

Through both typed input and final voice transcripts:

- `show tags`, `hide tags` (unchanged, exact match only)
- `click <target>` — e.g. `click Full name`, `click Submit survey`
- `fill <target> with <value>` — e.g. `fill Short bio with Ada Lovelace`
- `click 22` addresses stable id `el-22`, unless `22` is also an
  accessible name in the snapshot — then both clarify (never a
  silent pick).

Anything else is rejected with zero dispatches and a reason:
compounds (`click A and submit`), negation (`don't click …`),
missing target/value, other verbs (`tap`, `press`, `type`), and
leading politeness (`please click …`). Structure markers inside a
fill VALUE are literal text (`fill bio with fish and chips` fills
exactly that); only the command structure is screened.

Fill values are preserved verbatim — capitalization, punctuation,
internal spacing — apart from surrounding whitespace. Values never
appear in status text, voice state, spoken feedback, or logs.

## Matching algorithm (`lib/command-resolver.js`)

Parsing (`parseLocalCommand`) and ranking (`matchTarget`) are pure
functions over the command string and the current snapshot's
elements, tested without a DOM. Candidate ids come exclusively
from the snapshot; nothing is invented.

1. Normalize target and candidate fields: lowercase, trim,
   collapse whitespace, strip terminal punctuation and a leading
   article — applied symmetrically to both sides.
2. Fields per element: accessible name, plus (when the question is
   certain) `question + name` and the bare question, so repeated
   names such as rating `1`s resolve by their real context.
3. Exact normalized equality scores 1.0. Otherwise
   `0.7 * meanTokenSim + 0.3 * levSim`: per-target-token best
   similarity against any field token, blended with whole-string
   similarity. This scores a single-typo label high and unrelated
   words near zero. A similarity score is NOT model confidence.
4. `ACCEPT_THRESHOLD = 0.75`, `MIN_SEPARATION = 0.10` from the
   next-best element. Below threshold: execute nothing. Multiple
   exacts or a rival inside the band: clarify with the COMPLETE
   labeled candidate set — every exact match and every in-band
   rival, never truncated (labels lead with name and question
   context, disabled/readonly marks, and the snapshot number as
   a secondary `(#N)` reference).
5. Ranking is label-only. Disabled and readonly controls are never
   filtered or redirected: an exact disabled match resolves to
   itself and the executor rejects it honestly with zero
   dispatches. Verbs are never fuzzy-matched; negation is never
   rewritten away. No language-model dependency exists anywhere
   in this path.

## Request binding and ownership

Every page action captures the tab before asynchronous work, then
reuses a snapshot only when it is bound to that exact tab with the
executor ready; otherwise it acquires a fresh production snapshot
through a guarded fetch+bind (superseding sequence numbers, same
as manual acquisition). Matches bind to tab, documentSessionId,
revision, element id, operation generation, and interaction
sequence.

Clarification choices carry that binding in memory (transient;
dropped on use, expiry, or any newer command). Each choice
button closes over its own immutable round object — request,
value, and allowed candidate ids — so a callback from a
superseded round executes nothing and leaves any newer
clarification visible and valid; targets and values from
different commands can never be combined. Tab switches,
navigation, cancellations, Pause/Stop, and newer commands
invalidate pending rounds: a stale choice reports expiry and
executes nothing, and a choice never refreshes or substitutes a
different target after a stale rejection. Same `el-N` ids in
another document cannot collide because session+revision are
part of the binding.

The shared pipeline carries the owning command's interaction
sequence and rechecks it before creating confirmation,
refreshing, or returning anything presentable. A late
`CONFIRMATION_REQUIRED` for a cancelled command is revoked
through `SEEYABLE_CANCEL_CHALLENGE` and never becomes
approvable; anything already dispatched is reported honestly
("may already have reached the page"). Pause and Stop bump
panel-side ownership so a command still acquiring its snapshot
can never dispatch after Resume; Resume restores availability
only. Held outcomes use non-past-tense wording ("Click on …
is waiting for your approval") since nothing has run yet.

## Execution and safety (shared, not duplicated)

Click/fill dispatch through `runExecutionPipeline`, extracted
narrowly from the manual Execute handler: the same
`SEEYABLE_EXECUTE_ACTION` contract (`{action, elementId,
documentSessionId, revision, value, source}`), the same
confirmation controller, the same post-action refresh and action
log fetch. The manual handler presents in its dev surface;
commands present in status/voice/spoken surfaces.

Preserved: live target validation, redaction, sensitive-write
blocking (`SENSITIVE_FIELD`), final-state verification with honest
verified/unverified/dispatched distinctions, explicit human
approval for consequential actions (`click Submit survey` holds in
the Safety gate; speech is never approval), approval identity,
submission binding, expiry, revocation, single consumption,
Stop/Pause, operation locks, dispatch-once, interim nonexecution,
cancellation, stale-callback rejection, and speech held until
recognition ends. Source is audit-only: `voice` for transcripts,
`manual` for typed panel input and clarification choices.

MCP's accepted snapshot/highlight tools are unchanged; no
executor action is exposed over MCP in this issue.

## Network posture

The resolver and the fast path make no planner/model API calls
and need no key, proxy, or model availability. Typed commands
were demonstrated in headless Chrome with no external network.
Web Speech recognition itself may use the browser's remote
speech service; voice input is not claimed offline.

## UI changes (minimal)

- One clarification block (`clarifyBox`) in the command card:
  a prompt plus native stacked buttons. Keyboard-accessible by
  construction; hidden unless choices are pending.
- Command copy updated from "only show/hide tags" to the real
  grammar, in the panel and the extension README.
- No redesign, no new states, no example commands beyond what works.

## Verification

- `npm --prefix apps/extension test` — 190/190 (159 prior;
  10 resolver unit tests; 21 page-action/surface tests covering
  exact/fuzzy/weak matches, duplicate-context clarification,
  verbatim values, compound/negation rejection with zero sends,
  disabled/sensitive/pause honesty, held confirmation with focus
  on its heading, clarification expiry, voice dispatch-once with
  held speech, cancellation/tab-change discard without replay,
  the ownership correction (late-challenge revocation on cancel,
  Pause/Stop invalidation during acquisition, obsolete-callback
  inertness, lock-through-refresh), plus the headed-feedback
  correction: single-error presentation with no pill and complete
  clarification sets).
- `npm --prefix apps/mcp-server test` — 11/11 (untouched).
- Headless browser (`/tmp/spike-run/fastpath-e2e.mjs`, 18/18):
  typed fill verified on the demo survey with the value on the
  page and out of panel text; consequential click held with the
  card visible and focus on its heading and the form unsubmitted;
  held wording verified non-past-tense; obsolete clarification
  callback verified inert in the live panel with real DOM clicks;
  unsupported input verified as one status error with voice idle,
  Ready chip, and no pill; the reported five-option fixture case
  verified with all five choices reachable and option 5 checking
  only itself; compound rejected; fixture fill verified; harmless click
  reported with honest dispatched-but-unverified wording and
  exactly one increment. Screenshot:
  `/tmp/spike-run/plain-evidence/fastpath-panel.png` (post-run
  Safety showing the cancelled hold).
- Demo survey 20-control contract unchanged; no fixture edits.

## Limitations

- Grammar is deliberately tiny: no select/check/uncheck, no
  scroll_to/read, no synonyms, no multi-step or conditional forms.
- Speech recognition accuracy (including the known tags/tax
  confusions) is unchanged; the resolver only sees final
  transcripts.
- Clarification is panel-only; a voice-only user hears the prompt
  but chooses via the panel buttons.
- Headed typed checks and live-mic click passed as recorded above. Natural
  speech exposed the unresolved fill/feel/Phil recognition limitation;
  reliable voice fill is not established.

## Manual checks (Product Owner)

1. Headed: type `fill Full name with Test User` on the demo
   survey — verified completion, value on page, value absent
   from panel text and speech.
2. Type `click Submit survey` — held card, focus on its heading,
   Approve once runs it, Cancel revokes; nothing without approval.
3. Type `click Continue and submit` — rejected with a compound
   reason, zero dispatches.
4. With duplicate names (executor fixture Likert radios),
   type an ambiguous target — labeled choices appear; switch
   tabs, then activate a stale choice — expiry, no execution.
5. Voice (real mic): say one `click Increment counter` command on
   the local executor fixture. Confirm one increment per command,
   with spoken feedback only after the microphone closes. Duplicate-final
   callback protection is covered separately by automated tests; do not
   repeat the command within one utterance as a substitute for that test.
