# Issue #12 — Voice transcription spike harness

Compares Muse Voice Transcribe against the production Web Speech
recognizer on a fixed corpus. Transcription only: test audio must
never enter the production command dispatcher or trigger anything.

## Corpus

`corpus.json` — PROVISIONAL (no canonical Act 1 script exists in the
repo; validation pending). Four sentences plus the `show tags` /
`hide tags` controls. Record each as `<id>-take<N>.wav`
(16 kHz mono preferred), same speaker/room/mic, three takes each.

## Muse side (needs `MODEL_API_KEY` in the environment)

```sh
MODEL_API_KEY=$KEY node transcribe-file.mjs s1-multi-take1.wav --out muse.jsonl
node score.mjs corpus.json muse.jsonl
```

Key handling: read from the environment, sent only to api.meta.ai
over HTTPS, never printed or stored. Paid usage: bounded by design
(≤ 18 short clips for the full corpus × 3 takes); record byte
totals from the JSONL.

Latency reported is FILE-PROCESSING latency
(request_start → full_response). Do not compare it directly with
live speech-end-to-final latency.

## Web Speech side — FUTURE WORK, not ready to run

Do NOT evaluate by speaking into the production side panel: the
control phrases ("show tags" / "hide tags") would dispatch real
page actions through the production command path.

The correct path is a standalone transcript-only page that reuses
the `SpeechRecognition` wrapper from `lib/voice-commands.js` with
NO dispatcher, planner, or executor attached: it logs interim and
final transcripts plus speech-end → `onFinal` latency and nothing
else. That page is not implemented; building it is future work for
a reopened comparison.

Notes for that future work: `SpeechRecognition.start()` accepts
an audio track per MDN
(https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition/start),
so same-clip replay through Web Speech may be feasible — but
audio-track recognition compatibility and suitability were NOT
verified in this environment. If replay proves unsuitable, fall
back to matched live takes (same speaker/room/mic, three takes),
recorded as
`{"file":"<id>-take<N>.wav","provider":"web-speech","transcript":"..."}`,
then `node score.mjs corpus.json webspeech.jsonl`. Label live
latency separately from file-processing latency.

## Realtime (future, not in this spike)

A fair live-vs-live comparison needs the realtime endpoint
(`wss://api.meta.ai/v1/asr/realtime`, auth in the handshake frame)
plus a server-side audio relay. That is integration work, not a
spike harness, and gets its own review if the decision note
recommends it.
