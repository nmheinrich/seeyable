# Feature 30 — Meta voice transcription with browser fallback

Status: checkpoint-ready for demo use following Product Owner acceptance
on 2026-11-04, with the evidence limits below. This issue
does not rewrite Issue #12's historical **INCONCLUSIVE / KEEP Web Speech**
spike, and Issue #20's owner-authorized Codex external-client acceptance
is separate evidence.

## What changed

Seeyable now prefers Meta Muse Voice Transcribe for panel push-to-talk
when the existing planner proxy is paired and speech is configured.
Otherwise, and for the next fresh attempt after a known Meta failure, it
uses the existing browser `SpeechRecognition` provider.

Meta speech output is **not implemented**. The verified Meta API is
speech-to-text only and provides no synthesis endpoint/model. Spoken
feedback continues to use browser `speechSynthesis`, governed by the
existing speech toggle, Stop speech, held-feedback, and
microphone-suppression rules. No TTS provider was invented.

## Official API basis

Rechecked 2026-11-03:

- Meta Speech to Text guide: <https://dev.meta.ai/docs/speech-to-text>
- Voice Transcribe API reference:
  <https://dev.meta.ai/docs/api-reference/voice/transcribe>
- Meta model documentation: <https://dev.meta.ai/docs/models>

Verified starting points used here:

- Model: `muse-voice-transcribe-1.0`.
- Recorded transcription: `POST https://api.meta.ai/v1/asr/transcribe`
  with Bearer [REDACTED] and multipart form data.
- Live transcription exists at `wss://api.meta.ai/v1/asr/realtime`, with
  authentication in the handshake frame.
- `PUSH_TO_TALK`, partial/final events, language bias, and keyword hints
  are documented. English and Spanish are supported.
- The API returns transcripts/turns, not confidence scores.
- Muse Voice Transcribe is speech-to-text only; it does not synthesize
  speech.

No live Meta request was made in this implementation pass. The process
environment available to the engineer had no `MODEL_API_KEY` variable;
a local proxy `.env` file exists but its contents were not read or used
to claim upstream access. Account/API speech access therefore remains
**not verified**.

## Transport decision: bounded recording/upload

The implementation uses the recorded-audio endpoint through the existing
HTTP planner proxy. It does **not** open the Meta realtime WebSocket
from the extension or add a second WebSocket relay.

Reasons:

- The panel already has a paired, authenticated HTTP path to the proxy;
  browser WebSockets cannot set the proxy pairing `Authorization`
  header, so a speech WebSocket would need a weaker or more complex
  authentication design.
- Push-to-talk commands are short and explicitly bounded. The user
  presses Stop, one WAV is uploaded, and one final enters the existing
  command/review/plan pipeline.
- Cancellation, deadlines through full body consumption, disconnect
  abort, safe errors, and single-session ownership reuse established
  HTTP lifecycle machinery.
- No provider session survives panel cancellation or tab invalidation.

Tradeoff: Meta gives no interim transcript in this mode. The transcript
line remains pending until the final arrives. Speech-end-to-final
latency includes upload and upstream processing; it must be measured on
real takes and kept separate from planner latency.

The extension genuinely encodes mono 16-bit PCM WAV at 16 kHz. It does
not send WebM/Opus while calling it WAV.

## Architecture

```text
Panel Start listening
  -> provider preflight (before microphone audio)
       -> proxy paired + speech configured/unknown-or-verified: Meta
       -> missing/unpaired/unconfigured/rejected/failed/preflight error:
          browser recognition for that attempt
  -> one provider only for the session
       Meta: getUserMedia -> Web Audio PCM capture -> Stop
             -> downsample/encode WAV -> POST proxy /v1/transcribe
             -> proxy -> POST Meta /asr/transcribe
             -> one final transcript
       Browser: existing SpeechRecognition session -> one final
  -> existing panel onFinal pipeline
       local commands / plan review / consequential-action gate
```

Transcription remains separate from planning. A Meta transcript is only
text entering the same final-transcript pipeline. It receives no
executor authority, approval authority, fuzzy repair, or special trust.

### Proxy

`POST /v1/transcribe` on `127.0.0.1:6124` requires the existing pairing
token and refuses foreign origins. The browser sends only:

- multipart `request`: `{ language: "en" | "es" }`
- multipart `audio`: one WAV clip

The proxy, not the caller, supplies the fixed upstream model,
`audioEncoding: "WAV"`, `mode: "PUSH_TO_TALK"`, the language name, and
fixed nonsensitive keywords (`Seeyable`, `show tags`, `hide tags`). No
page labels, field values, or approval phrases are used as hints.
Callers cannot choose an upstream URL, model, mode, or vocabulary.

Bounds are separate from the planner's 256 KiB JSON limit:

- recording: 30 seconds, auto-finish at the bound;
- WAV: mono 16-bit PCM, 16/24 kHz accepted by the proxy, at most
  1,000,000 audio bytes and 1,100,000 multipart body bytes;
- one transcription at a time in the proxy;
- upstream deadline: 20 seconds in the proxy, 25 seconds in the
  extension request client, both held through response-body reading.

`GET /v1/status` now reports speech configuration separately from
upstream access:

- `configured`: a `MODEL_API_KEY` is present in the proxy process.
- `state: "unknown"`: configured but no real speech access has been
  proven.
- `state: "verified"`: a real transcription has succeeded.
- `state: "rejected"`: Meta returned 401/403/404 for speech.
- `state: "failed"`: the last speech attempt failed another way.
- `state: "unconfigured"`: no key is configured.

A reachable proxy or present key is never described as verified access.

### Provider selection and failure behavior

| Situation | This attempt | Next attempt |
|---|---|---|
| Proxy unpaired/missing | Browser | Browser until paired |
| Speech unconfigured or known rejected/failed | Browser | Browser until pairing/status state changes |
| Proxy status check fails before capture | Browser | Browser/Meta by a fresh preflight |
| Meta succeeds | Meta final once | Meta remains eligible |
| Meta fails after capture or upload begins | No transfer/replay; error says no command was sent when true | Browser |
| Meta permission denied | Error; no second prompt from fallback | User may fix permission and start again |
| Intentional Cancel at any phase | Discard; no fallback, restart, or replay | Fresh user Start only |
| Proxy recovers later | Nothing auto-starts | Fresh user Start only |

Once Meta capture begins, the utterance is never silently handed to the
browser recognizer. The session is invalidated, tracks and upstream work
stop, and the panel offers the ordinary Start control for a fresh
browser attempt.

## Lifecycle and safety guarantees

- Provider is selected and bound before microphone acquisition; no
  session changes provider mid-flight and recognizers never run
  concurrently.
- Every user attempt owns an immutable composite attempt object and a
  fresh child recognizer. Callbacks and asynchronous continuations are
  bound to that attempt and its original session ID. Cancel invalidates
  the attempt and cancels its child even during provider selection or
  microphone permission; a late grant stops only its own tracks. An old
  session's failure, final, idle event, or held cleanup cannot clear,
  impersonate, or stop a newer session, and cleanup touches only the
  owning session's resources.
- Review authority (plan approval or consequential-action approval) is
  captured from what was shown at the intentional Start press, before
  provider selection or permission resolves. A plan/challenge appearing
  during that delay is not retroactively approvable by the session.
- Proxy transcription admission is reserved synchronously before the
  upload body is read, and released on success, invalid/oversized body,
  upload timeout, disconnect/abort, and upstream error. Partial uploads
  are bounded by a 10-second upload deadline. There is no queue/retry.
- Stop finishes the current Meta recording and may produce one final.
  Cancel discards during selection, permission, capture, upload,
  upstream processing, or body reading; late finals are inert.
- Duplicate finals cannot dispatch twice. Composite session IDs keep a
  browser or Meta final bound to the panel's user-started session.
- Stop/Pause, tab/document changes, panel teardown, and Cancel use the
  existing invalidation routes. Already-dispatched commands are not
  falsely described as unexecuted.
- Plan approval still requires the existing exact contextual phrase and
  session binding. Consequential approval still requires the separate
  exact challenge phrase and trusted route. Recognition is never biased
  toward approval phrases.
- Interim Meta output does not exist in file mode; browser interim text
  still never dispatches.
- Browser speech synthesis remains suppressed while a recognizer is
  active and held feedback is discarded by Stop speech/cancellation as
  before.

## Privacy and cleanup

- The Meta key stays only in the proxy. The extension holds only the
  existing local pairing token.
- No pairing token or key appears in logs, error bodies, audio metadata,
  screenshots, or evidence.
- Audio exists only as in-memory chunks and one WAV `Blob` for the
  current attempt. No recording, transcript, or sensitive value is
  persisted by Seeyable.
- Meta/provider retention is upstream behavior; Seeyable does not claim
  the provider stores nothing. The panel discloses that the selected
  provider may process audio outside the device.
- Every terminal Meta path stops microphone tracks, disconnects audio
  nodes, closes the `AudioContext`, clears the duration timer and
  buffers, aborts in-flight fetch work, and releases listeners. This
  implementation creates no object URLs or speech WebSocket.

## UI changes

No redesign or setup wizard was added. Settings keeps the existing
microphone controls and gains one provider note. Planner status text now
also reports speech configuration/state. Existing Start/Stop/Cancel,
speech toggle, Stop speech, confirmation, and Stop/Pause controls are
unchanged in placement and meaning.

## Tests and evidence

### Automated (mock/stub)

- Extension: **359/359** (`npm --prefix apps/extension test`), including
  Meta-provider unit tests plus integrated panel/planner tests running
  the production script order (`voice-commands`, resolver, plan schema,
  planner, `meta-voice`, overlay, panel).
- Planner proxy: **21/21** (`npm --prefix apps/planner-proxy test`),
  including speech-route and admission tests.
- Shared: **11/11**. MCP: **41/41**. No live credentials were used.

Extension coverage includes WAV encoding/downsampling; a
transcript-only Meta controller that records a final without any panel
dispatcher attached; one final despite repeated Stop; cancellation
during capture and transcription; silence and oversize rejection before
upload; permission denial; pre-capture proxy-loss fallback;
after-capture no-replay with next-attempt browser fallback; cancel
during provider selection; composite session identity with duplicate
browser finals still dispatching once; stalled-body deadline; and
caller cancellation during body reading.

Proxy coverage includes valid turns-to-transcript output; fixed
`/asr/transcribe` path, model, `PUSH_TO_TALK`, language, and keyword
contract; pairing/foreign-origin rejection; missing key; safe numeric
403 handling remembered as `rejected`; malformed/caller-steered/
oversized audio rejected before upstream; one transcription at a time;
and browser disconnect aborting upstream work. Logs and responses were
checked for keys, transcripts, and upstream error bodies.

Review-correction coverage adds: cancel during microphone permission
with a late grant stopping only its own tracks and a fresh session
starting; an old setup failure held in `AudioContext.close` cleanup
that cannot error or clear a replacement session; a late final from a
cancelled session after replacement; real-HTTP deferred partial uploads
proving at most one upstream call (`200` + `409`, no queue) with failed
and stalled uploads releasing admission; integrated panel Meta final
dispatch exactly once; cancellation/tab-change/Pause during selection,
permission, and transcription; fresh browser fallback after Meta
failure; spoken feedback only after capture closure; Meta plan approval
versus consequential-action approval isolation; a deferred
regression proving a challenge that appears during delayed provider
selection cannot be approved by that session (authority is captured at
Start); and Stop during held provider selection terminating the
attempt immediately — ownership released, idle restored, the late
preflight starting neither provider, and a fresh panel attempt then
working end to end.

### Synthetic browser proof

A transcript-only headless Chrome proof used the real unpacked
extension panel scripts, Chrome's fake microphone device, the real local
planner proxy, and a stub Meta upstream. The controller was instantiated
with recording-only handlers, not the panel command dispatcher.

Observed: capture reached `listening`; one upstream call reached
`/asr/transcribe` with the documented model/WAV contract; one final,
`fill Full name with Grace Hopper`, returned with a 36 ms
Stop-to-stub-final latency; no transcript appeared in proxy logs. This
is synthetic evidence only. It does not measure Meta, human speech,
accuracy, or real speech-end latency.

### Live API and headed human speech

The Product Owner confirmed a successful simple spoken fill, proxy speech
status changing to verified, Cancel leaving the field unchanged, and a
fresh browser fallback attempt working after stopping the proxy with no
replay. Owner-supplied speech logs show successful requests at 3,943 ms
and 1,583 ms (proxy processing time, not complete end-to-end latency).

On 2026-11-04 the owner confirmed the larger request worked after the
extension reload, said the build was suitable for the demo, and requested
a checkpoint. Exact larger-plan action count and per-step results were
not supplied; do not claim a verified 20-action real-form run. A formal
same-corpus provider comparison, Spanish extension recognition, and the
full supplementary approval/negation corpus remain unmeasured/unitemized.
Codex English/Spanish voice evidence from #20 is a separate provider path.

Recognition still sometimes hears feel instead of fill. Planning has
variable upstream latency, including a measured 20,005 ms initial-call
timeout without headers; capacity was increased to 20 without changing
timeouts. Meta TTS is not implemented; browser synthesis remains active.
The checklist below remains useful for supplementary verification and
must not be read as a claim that every probe was completed.

## Product Owner headed checklist

Use the local demo survey first, then the genuine Google Form rehearsal.
Keep typed input available. Do not use real personal data.

1. **Configure and pair.** Start the planner proxy with
   `MODEL_API_KEY` in its environment, pair the extension on port 6124,
   and choose **Planner status**.
   - Expected: planner key configured; speech is `configured (unknown)`
     until a real transcription succeeds. `unknown` must not be read as
     verified speech access.
2. **Meta English command.** With the proxy paired, press **Start
   listening**, say “fill Full name with Grace Hopper,” then **Stop
   listening**.
   - Expected: microphone state is truthful; one final appears; the
     existing pipeline handles it once. Record the reference, actual
     transcript, whether critical tokens (fill, Full name, Grace,
     Hopper) survived, and Stop-to-final seconds.
3. **Meta Spanish command.** In a Spanish-language browser/profile if
   available, say a short supported command such as “show tags,” then
   Stop.
   - Expected: one Spanish-biased final or an honest error. Record the
     actual transcript and latency; do not claim Spanish support from an
     English fallback session.
4. **Dictation and labels.** Say “fill Short bio with Grace Hopper,
   pilot and writer.” Then try a radio-row request from the fixture.
   - Expected: dictated punctuation/proper names are transcribed as
     spoken or fail visibly; no value is invented by Seeyable.
5. **Approval/negation corpus — transcript-only discipline.** Use the
   panel only if you are prepared for an exact valid phrase to act
   under the existing review rules; otherwise evaluate these in a
   transcript-recording setup supplied by the PM. Say: “approve plan,”
   “approved plan,” “go ahead,” “do not approve,” “approve later,” and
   “approve plan and submit.”
   - Expected: transcripts are recorded verbatim. “do not approve,”
     “approve later,” and compound wording must not be treated as an
     approval by the panel.
6. **Browser fallback.** Stop the proxy or discard pairing, press Start,
   and say “show tags.”
   - Expected: browser recognition handles that fresh attempt or gives
     its existing honest error. No Meta audio is uploaded.
7. **Failure without replay.** Start Meta, speak, then disconnect/stop
   the proxy during upload if practical; or use a proxy with speech
   access removed.
   - Expected: the utterance fails without executing; pressing Start
     again offers a fresh browser attempt. The old words are not
     replayed automatically.
8. **Google Forms rehearsal.** Repeat one non-consequential voice fill
   and one held Submit/Cancel on the disposable rehearsal form.
   - Expected: existing snapshot/executor/safety behavior is unchanged;
     Submit still requires the separate human confirmation route.

Record for every natural take: provider shown/used, reference text,
actual final, retries, critical-token misses, failures, and
speech-end-to-final time. Keep planner time separate. Do not select only
the best take as evidence.

## Natural-speech evaluation corpus (pending)

| Language | Reference | Primary check |
|---|---|---|
| English | fill Full name with Grace Hopper | action, target, proper name |
| English | fill Short bio with Grace Hopper, pilot and writer. | punctuation and dictated prose |
| English | choose Monthly digest | radio-row label |
| English | approve plan | exact approval phrase transcription |
| English | approved plan | near-miss must not become approval |
| English | go ahead | informal wording must not become approval |
| English | do not approve | negation preserved |
| English | approve later | deferral wording preserved |
| English | approve plan and submit | compound wording not treated as one approval |
| Spanish | mostrar etiquetas (show tags) | Spanish command transcription |
| Spanish | rellenar Nombre completo con Grace Hopper | Spanish fill wording and proper name |

The approval/negation rows are transcript evaluation first. Do not run
them as live approval attempts until the PM agrees the on-screen review
state makes the consequence explicit and safe.

## Rollback

No data migration or persistent setting was added. To roll back, stop
using/re-pair the speech proxy path by discarding planner pairing or
stopping the proxy: the panel then uses browser recognition. Code
rollback is limited to removing the Meta provider script/selection,
`/v1/transcribe` route, and speech status fields; the browser voice
controller, executor, planner, and MCP paths do not depend on Meta
transcription.

## Limitations and disagreements

- Meta TTS is unavailable under the verified API. Implementing a
  different speech-output provider would be a new scope decision.
- File mode has no Meta interim transcript and adds upload time after
  Stop. A realtime relay could reduce that but would complicate proxy
  authentication and session ownership; it was not justified for short
  push-to-talk commands.
- Speech access, accuracy, and latency are unverified until the Product
  Owner's natural-speech run. Mocks and the fake-device proof cannot
  establish superiority over Web Speech.
- Only English/Spanish attempts are sent to Meta by this panel path,
  based on the browser language. Other languages use browser fallback
  only when Meta is ineligible; an unsupported Meta language selection
  is rejected by the proxy rather than guessed.
- `ScriptProcessorNode` is used as a small PCM capture tap for the
  bounded clip. It is widely available in Chrome but deprecated; a
  future AudioWorklet migration should preserve the same controller and
  WAV contracts.
- The proxy remembers speech rejection/failure only in memory. Restart
  returns it to `unknown`, so the next user-started attempt may try Meta
  again; it still cannot replay an old utterance.

Recommendation: **ready for Product Owner headed verification**, not
final provider acceptance.

