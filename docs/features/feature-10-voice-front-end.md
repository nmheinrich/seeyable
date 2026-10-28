# Feature 10 — Voice Front End and Typed Fallback

A minimal voice/typed command section in the side panel. One shared
dispatcher serves push-to-talk voice input and a typed command box.
The only supported commands are **"show tags"** and **"hide tags"**,
executed through the same panel flows as the manual Show/Hide tags
buttons. No page actions, executor calls, planner, or AI are involved.

## Commands and dispatch

- Normalization: lowercase, trim, collapse internal whitespace, strip
  harmless terminal punctuation (`Show Tags!` → `show tags`).
- Resolution is exact after normalization. Anything else — including
  negations such as "don't show tags", extra words ("show tags
  please"), or partial phrases — is unsupported. There is no substring
  matching and no guessing: unknown or empty input produces a visible
  message listing the supported commands and executes nothing.
- Voice and typed input share normalization, resolution, dispatch,
  busy handling, and outcome presentation. A command reports success
  only after the content script acknowledges it; missing receivers and
  restricted pages produce actionable errors, never spoken success.
- Show tags may acquire and bind a snapshot through the established
  Feature #9 acquisition flow (same ownership, locking, and execution
  readiness rules). Hide tags captures and retains its target tab at
  dispatch start — even without a bound snapshot — so that tab's
  navigation/reload invalidates a pending result. Operation locking
  is symmetric: a pending voice/typed command disables and guards
  manual Execute, snapshot acquisition, Show/Hide/Highlight, and the
  CDP snapshot, and manual operations likewise block commands (the
  manual Hide button holds the same shared lock while in flight).
  All three entry paths (manual buttons, typed, voice) call the same
  guarded Show/Hide functions. Nothing is queued or retried.

## Recognition lifecycle

Recognition uses `window.SpeechRecognition || window.webkitSpeechRecognition`
when present, in short user-initiated sessions (`continuous: false`,
interim results on). There is no wake word, background listening, or
automatic restart.

- **Start listening** (click/keyboard; no hold required) begins one
  session. Repeated Start clicks are ignored. "Listening" is shown
  only when the browser actually fires `onstart`. Starting first
  stops any speech output so Seeyable never transcribes its own
  feedback.
- **Interim** transcripts render in the visible transcript line and
  never dispatch.
- The **first final** result dispatches exactly once per session;
  duplicate result events are ignored.
- **Stop listening** finishes the current utterance: a final result
  may still arrive once and dispatch, then the session ends.
- **Cancel listening** discards the utterance: the session is aborted
  and invalidated, and late callbacks are ignored. Nothing is
  dispatched. Cancel also invalidates a pending command interaction
  (e.g. an acknowledgment still in flight): its late result is neither
  presented nor spoken. A command already sent to the page may still
  have taken effect there — the panel says exactly that instead of
  claiming it never executed; there is no retry or reversal.
- Termination is definitive: an error, a normal end, a cancellation,
  or a failed start closes the session, and saved/late callbacks from
  it can neither dispatch nor alter the UI. A trailing `onend` after
  an error does not erase the actionable error message, and controls
  immediately reflect the terminated session. Stop semantics are the
  one exception by design: a final result delivered before the normal
  end may still dispatch once.
- Empty/no-speech, microphone-denied, no-device, and network errors
  produce clear visible messages. Denial never triggers a re-prompt
  or restart. Typed commands remain fully usable in every failure
  mode, including browsers with no recognition API (Start is then
  disabled with an explanatory note).
- Typed submission while a recognition session is live cancels that
  session first, so speech and typed input can never race into two
  commands.

## Ownership and invalidation

Each interaction captures the active tab and the panel generation when
it starts. Tab switches, navigation/reload of the captured tab, panel
teardown (`beforeunload`), and cancellation invalidate pending
recognition and dispatch: late transcripts and late command results
are discarded, never presented or spoken as acting on the new page,
and cannot restore panel state. Feature #9's acquisition/execution
locks are preserved; the voice path creates no bypass around them.

Visible states are only the real ones: **idle**, **listening**,
**acting** (a supported command is pending), and **error/unsupported**.
There is no simulated "thinking" (awaits the planner) or "confirming"
(awaits Feature #11's safety gate).

## Speech output

`speechSynthesis` feedback is short and application-owned: "Tags
shown" / "Tags hidden", spoken only after page acknowledgment **and**
only once any active microphone has terminated (recognition end or
error); feedback for an interaction that was invalidated meanwhile is
dropped, and starting recognition cancels existing speech. **Stop
speech** drops held feedback as well as current synthesis, without
cancelling or reversing the completed page command. While the
microphone is still closing after an accepted utterance, the panel
shows a finishing state (and keeps Stop listening enabled) rather
than claiming to be idle. The
`say(text)` boundary in `lib/voice-commands.js` is the same boundary a
future planner's `say` string will use; no plan schema or fake plan
exists. A **Speak feedback** toggle mutes output, **Stop speech**
cancels it, and new feedback replaces obsolete queued utterances.
Unsupported synthesis never blocks commands; visible text always
mirrors the outcome. Page content, field values, raw errors, and raw
transcripts are never spoken automatically.

## Microphone and privacy

Chrome grants microphone access per extension origin, and a side
panel cannot always show that prompt. The panel therefore includes a
**Microphone setup** button opening `mic-setup.html`, a narrowly
scoped extension page whose only job is a user-initiated
`getUserMedia({audio:true})` request; tracks are stopped immediately
after the permission answer. No manifest permission was added.

Browser Web Speech recognition may process audio outside the device
(Chrome's implementation uses a remote service); it is **not**
guaranteed offline. Seeyable records and stores no audio, persists no
transcripts, logs no raw utterances, and never includes transcripts in
snapshot copy/download output. Transcripts exist only in the visible
transcript line until replaced or invalidated. No API keys, analytics,
or new speech services were added.

## Verification

Automated: `npm --prefix apps/extension test` (84 tests) includes
`tests/voice.test.mjs` (normalization/exact matching incl. negation,
speech-output boundary, recognition lifecycle with controllable
mocks: dispatch-once, stop-vs-cancel, stale sessions, error mapping,
unsupported API) and Feature #10 cases in `tests/panel.test.mjs`
(voice/typed parity, interim non-dispatch, unknown/empty handling,
busy refusal without queueing, tab-change discard before result and
during dispatch, mute/failure speech behavior, mic-setup opening, and
no transcript persistence/logging). Deferred-response regressions
cover the review corrections: saved-callback event ordering after
error/end/failed start, cancel during a held acknowledgment, no
synthesized feedback while recognition remains active, starting
recognition cancelling prior speech, symmetric locking of manual
execution/snapshot/overlay during a pending command, reload
invalidation of an unbound hide command, and Stop speech pressed
while feedback is held for recognition end (alongside the normal
release path when it is not cancelled).

Headless browser evidence (Chrome 156, panel page driven through the
real message paths on the demo survey): typed `don't show tags`
executed nothing (0 badges, supported-commands message); typed
`Show Tags!` showed 11 in-viewport badges with the snapshot bound;
typed `hide tags.` removed all badges; the Microphone setup button
opened the setup tab. Recognition and synthesis APIs are present in
that environment, but headless presence is not microphone evidence.

Headed acceptance (2026-10-28): the Product Owner confirmed real microphone
show/hide commands, visible badge changes, audible feedback without
self-transcription, typed show tags, rejected negation, cancellation,
keyboard activation of Start listening with successful show tags, and
tab-switch cancellation without commands on either page. An initial
permission-denial message was observed, followed by working recognition;
the exact permission-grant/setup-page sequence was not recorded. Initial
recognition confused "tags" with "tax" and "targets" and took about three
attempts. This is a known recognition-quality limitation; no fuzzy aliases
were added. Stop-listening finalization and mute/Stop-speech timing remain
automated evidence rather than separately confirmed audible headed checks.

Repeatable manual procedure: load the standard extension headed; open the demo survey; open
the panel; click **Microphone setup** and grant access if prompted;
return and click **Start listening**, say "show tags", confirm the
transcript line, tags appearing, and "Tags shown" feedback; repeat
with "hide tags"; deny the microphone once and confirm the denial
message and that typed commands still work; operate Start/Stop/
Cancel and Send command by keyboard only.
