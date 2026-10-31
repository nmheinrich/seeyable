# Decision — Voice transcription provider (Issue #12 spike)

Date: 2026-10-30. Timebox: one hour. Elapsed time is uncertain
(the earlier "~55 minutes" and "~25 minutes" figures disagree and
neither was timed rigorously); the work completed inside the
one-hour timebox including this correction pass.

## Decision: INCONCLUSIVE — KEEP CURRENT IMPLEMENTATION

No transcription comparison could be run: no Model API credentials
exist in this environment, and headless Chrome cannot feed audio to
Web Speech through any supported API. Per the stopping rule, that
is INCONCLUSIVE / KEEP, not a switch. A documented keep is the
successful outcome of this spike; the production Web Speech
recognizer stays untouched.

## Sources consulted

- https://dev.meta.ai/docs/speech-to-text — Muse Voice Transcribe
  overview: model `muse-voice-transcribe-1.0`, both endpoints,
  modes (PUSH_TO_TALK default, ENDPOINTING, DIARIZATION), features
  and explicit non-features (no word timestamps, no confidence
  scores, no reformatting).
- https://dev.meta.ai/docs/api-reference/voice/transcribe —
  `POST /v1/asr/transcribe` multipart schema (`request` JSON +
  `audio` WAV ≤ 32 MB / 10 min), `Authorization: Bearer` auth,
  `Accept`-selected response shapes, error codes.
- `apps/extension/lib/voice-commands.js` (236 lines) — the
  production session controller: `supported/start/stop/cancel`,
  `onFinal/onInterim/onError`, stop-vs-abort semantics, session
  ids, no optimistic state.

Verified claims: live endpoint `wss://api.meta.ai/v1/asr/realtime`
with auth in the handshake frame (Authorization header ignored);
recorded endpoint `POST https://api.meta.ai/v1/asr/transcribe`
with header auth; example env var `MODEL_API_KEY`. The realtime
handshake/event schema was not exercised (no credentials) and is
not quoted here beyond what the overview page states.

## Dataset

No canonical Act 1 script was found (searched docs, apps, DESIGN,
and the full workspace for "Act 1" and demo-script wording). The
spike therefore uses the clearly labeled PROVISIONAL corpus in
`apps/voice-spike/corpus.json`, authored from the issue's category
list with fictional content; canonical-script validation is
PENDING. Reference text, critical tokens, and recording
conventions are in that file. Controls `show tags` / `hide tags`
are included (Web Speech previously heard "tax"/"targets").

## What was actually run

- Docs fetched and read (both URLs above, 2026-10-30).
- Credential check: `META_API_KEY`, `META_MODEL_API_KEY`,
  `METAMATE_API_KEY`, `MUSE_API_KEY`, `VOICE_API_KEY` all unset;
  no `MODEL_API_KEY` either. (The `MUSE_*` session vars present
  are harness plumbing, not API credentials, and were not used.)
- Harness built and self-tested WITHOUT network: `score.mjs`
  verified on two synthetic rows (perfect transcript → WER 0;
  "show tax" → WER 0.5 with `tags` flagged missing). The file
  client has 3 offline mocked-fetch regressions (`npm --prefix
  apps/voice-spike test`): the latency stamp spans full body
  receipt (a 300 ms mocked body delay is included), requests abort
  on a 300 s timeout instead of hanging, and the key never appears
  in output. All explicitly synthetic: they prove harness
  mechanics, not transcription quality. The harness is NOT fully
  validated and the comparison is NOT complete.
- Zero provider takes, zero paid requests, zero audio bytes sent
  (no credentials). Corpus remains provisional.
- No production code changed; no suites needed rerunning for this
  spike (last verified: extension 159/159, MCP server 11/11).

Sample counts: Muse 0 takes, Web Speech 0 takes. There is no
results table because there are no results; anything else would be
fabrication.

## Why no comparison was possible (both sides blocked)

- Muse side: requires a Model API key; none is available, and the
  spike forbids asking for one in chat. The file client is ready
  to run the moment credentials exist.
- Web Speech side: recognition needs a live microphone in headed
  Chrome. Two same-clip replay routes exist on paper — the
  fake-device flags (`--use-fake-device-for-media-stream`,
  `--use-file-for-fake-audio-capture`) and `SpeechRecognition.start()`
  with an audio track (per MDN,
  https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition/start)
  — but audio-track recognition compatibility and suitability were
  not verified in this environment, and this environment cannot
  synthesize the input clips anyway (`say` produced 0-byte audio —
  no speech daemon in session). One-sided Web Speech data cannot
  answer a two-provider question while the Muse side has no
  credentials. A standalone transcript-only evaluation page (no
  production dispatcher — speaking the controls into the real
  panel would dispatch page actions) is future work, described in
  `apps/voice-spike/README.md`; it is not implemented.
- Synthetic speech was considered and rejected as the comparison
  basis within this timebox: without credentials it could only
  exercise Web Speech, which still needs headed audio.

## Integration effort and implications (from docs + code reading)

- Web Speech today: zero infrastructure, zero marginal cost, no
  key management; audio already leaves the device to the browser
  vendor's service (disclosed in-app). Known weakness: short
  command confusions ("tags" → "tax"/"targets").
- Muse file transcription would add: a server-side relay (the
  extension must never hold the key — planner-proxy boundary),
  multipart upload per utterance, and file-processing latency on
  top of capture. PUSH_TO_TALK fits the push-to-talk UX; turn
  timestamps exist but word timestamps and confidence do not.
- Muse realtime would further add: a persistent audio relay
  (mic → extension → proxy → `wss`), handshake auth, partial/
  turn-event handling mapped onto the existing
  onFinal/onInterim/stop/cancel session semantics, and
  reconnection behavior. Vocabulary biasing could plausibly help
  "tags" and survey terms, but unbiased-vs-biased runs are
  required before claiming anything.
- Privacy/cost: either Muse route sends user audio to a new third
  party (new disclosure + consent surface) and adds metered usage;
  Web Speech's remote processing is already disclosed and accepted.

## Recommendation

KEEP Web Speech. Revisit only if ALL of these hold: (1) the
canonical script is located or ratified, (2) Model API access is
provisioned through proper channels, (3) a blinded comparison on
natural speech (not just synthetic) shows reliability at least as
good on the full corpus including the "tags" controls, with
latency measured under comparable definitions, and (4) the relay
integration passes a separate security review. The files in
`apps/voice-spike/` are a partial starting point: credentials, natural-speech
recordings, a standalone transcript-only Web Speech harness, and comparable
latency instrumentation are still needed. The spike is closed with an
inconclusive decision; the provider comparison was not completed.

## Remaining verification (if reopened)

Canonical script wording; three natural-speech takes per
sentence/provider; unbiased and vocabulary-biased Muse runs
reported separately; live-vs-live latency under one definition;
failure/truncation/retry counts; usage totals; headed permission
and recovery friction for the relay design.
