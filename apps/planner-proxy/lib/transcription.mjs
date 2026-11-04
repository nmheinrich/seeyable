"use strict";
/* Meta Muse Voice Transcribe client for the planner proxy (Issue #30).
 *
 * This module is the only speech-specific upstream caller. It uses the
 * documented recorded-audio endpoint, not an invented browser WebSocket
 * relay:
 *
 *   POST {base}/asr/transcribe
 *   multipart/form-data: request={model,audioEncoding:"WAV",
 *   mode:"PUSH_TO_TALK", languageBias, keywords} + audio=<mono WAV>
 *
 * Bounded recording/upload was chosen over realtime streaming for this
 * push-to-talk surface because it reuses the proxy's existing HTTP
 * pairing, deadline, disconnect-abort, and safe-error machinery; the
 * browser never needs a secret-bearing WebSocket handshake to the proxy,
 * and no partial provider state survives cancellation. The tradeoff is
 * explicit: Meta provides the final only after the bounded clip uploads,
 * so the panel gets no Meta interim transcript.
 *
 * It never logs audio, transcripts, keys, headers, or upstream bodies.
 */

export const TRANSCRIBE_MODEL = "muse-voice-transcribe-1.0";
export const TRANSCRIBE_TIMEOUT_MS = 20000;
export const MAX_AUDIO_BYTES = 1000000; // 30 s of 16 kHz mono s16 WAV is 960,000 bytes
export const MAX_TRANSCRIBE_BODY_BYTES = 1100000;
export const MAX_SPEECH_DURATION_SECONDS = 30;
export const MAX_TRANSCRIPT_CHARS = 10000;

// Fixed, nonsensitive product vocabulary only. No page labels, field
// values, user data, or approval phrases are ever supplied by callers.
export const SPEECH_KEYWORDS = ["Seeyable", "show tags", "hide tags"];

const LANGUAGE_NAMES = {
  en: "English",
  es: "Spanish",
};

export class SpeechError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    if (Number.isInteger(status)) this.status = status;
  }
}

function normalizeBaseUrl(raw) {
  const fallback = "https://api.meta.ai/v1";
  const text = typeof raw === "string" && raw.trim() ? raw.trim() : fallback;
  return text.replace(/\/+$/, "");
}

function httpFailure(status) {
  const tag = `(HTTP ${status})`;
  if (status === 401) return new SpeechError("SPEECH_AUTH", `Meta transcription rejected the proxy's API key ${tag}. Check MODEL_API_KEY in the proxy environment, then restart the proxy.`, status);
  if (status === 403) return new SpeechError("SPEECH_FORBIDDEN", `Meta transcription refused the request ${tag}. The key may lack speech access.`, status);
  if (status === 404) return new SpeechError("SPEECH_NOT_FOUND", `Meta transcription has no such endpoint or model ${tag}. Check the proxy's speech model and base-URL configuration.`, status);
  if (status === 429) return new SpeechError("SPEECH_RATE_LIMITED", `Meta transcription is rate-limiting requests ${tag}. Wait a little and start a fresh attempt.`, status);
  if (status >= 500 && status <= 599) return new SpeechError("SPEECH_UNAVAILABLE", `Meta transcription failed ${tag}. No command was sent.`, status);
  return new SpeechError("SPEECH_ERROR", `Meta transcription rejected the request ${tag}. No command was sent.`, status);
}

export function languageName(language) {
  const primary = String(language || "en").toLowerCase().split(/[-_]/)[0];
  return LANGUAGE_NAMES[primary] || null;
}

export function parseWavInfo(audio) {
  if (!Buffer.isBuffer(audio) || audio.length < 44) return null;
  if (audio.toString("ascii", 0, 4) !== "RIFF" || audio.toString("ascii", 8, 12) !== "WAVE") return null;
  let offset = 12;
  let fmt = null;
  let dataBytes = null;
  while (offset + 8 <= audio.length) {
    const id = audio.toString("ascii", offset, offset + 4);
    const size = audio.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (start + size > audio.length) return null;
    if (id === "fmt ") {
      if (size < 16) return null;
      fmt = {
        audioFormat: audio.readUInt16LE(start),
        channels: audio.readUInt16LE(start + 2),
        sampleRate: audio.readUInt32LE(start + 4),
        byteRate: audio.readUInt32LE(start + 8),
        bitsPerSample: audio.readUInt16LE(start + 14),
      };
    } else if (id === "data") {
      dataBytes = size;
    }
    offset = start + size + (size % 2);
  }
  if (!fmt || dataBytes === null) return null;
  const byteRate = fmt.byteRate || (fmt.sampleRate * fmt.channels * fmt.bitsPerSample / 8);
  return { ...fmt, dataBytes, durationSeconds: byteRate ? dataBytes / byteRate : 0 };
}

export function validateSpeechAudio(audio) {
  if (!Buffer.isBuffer(audio) || audio.length === 0) {
    return { ok: false, code: "AUDIO_INVALID", message: "Audio must be a non-empty WAV recording." };
  }
  if (audio.length > MAX_AUDIO_BYTES) {
    return { ok: false, code: "AUDIO_TOO_LARGE", message: `Audio exceeds the ${MAX_AUDIO_BYTES}-byte limit.` };
  }
  const info = parseWavInfo(audio);
  if (!info || info.audioFormat !== 1 || info.channels !== 1 || info.bitsPerSample !== 16
    || ![16000, 24000].includes(info.sampleRate)) {
    return { ok: false, code: "AUDIO_INVALID", message: "Audio must be mono 16-bit PCM WAV at 16 kHz or 24 kHz." };
  }
  if (info.durationSeconds > MAX_SPEECH_DURATION_SECONDS + 0.5) {
    return { ok: false, code: "AUDIO_TOO_LONG", message: `Audio exceeds the ${MAX_SPEECH_DURATION_SECONDS}-second limit.` };
  }
  if (info.dataBytes === 0) {
    return { ok: false, code: "AUDIO_INVALID", message: "Audio contains no samples." };
  }
  return { ok: true, info };
}

export function createTranscriptionClient({ apiKey, baseUrl, timeoutMs = TRANSCRIBE_TIMEOUT_MS, fetchImpl } = {}) {
  const base = normalizeBaseUrl(baseUrl);
  const fetchFn = fetchImpl || globalThis.fetch;
  if (typeof fetchFn !== "function") throw new Error("transcription client requires a fetch implementation");

  async function transcribe({ audio, language = "en", signal } = {}) {
    if (!apiKey) throw new SpeechError("SPEECH_NOT_CONFIGURED", "The proxy has no MODEL_API_KEY for transcription.");
    const checked = validateSpeechAudio(audio);
    if (!checked.ok) throw new SpeechError(checked.code, checked.message);
    const name = languageName(language);
    if (!name) throw new SpeechError("SPEECH_LANGUAGE_UNSUPPORTED", "Meta transcription in this panel supports English or Spanish attempts.");

    const form = new FormData();
    const request = {
      model: TRANSCRIBE_MODEL,
      audioEncoding: "WAV",
      mode: "PUSH_TO_TALK",
      languageBias: [name],
      keywords: SPEECH_KEYWORDS,
    };
    form.append("request", new Blob([JSON.stringify(request)], { type: "application/json" }));
    form.append("audio", new Blob([audio], { type: "audio/wav" }), "speech.wav");

    const controller = new AbortController();
    let timer = null;
    let timedOut = false;
    let fireTimeout = null;
    const timeoutPromise = new Promise((_, reject) => { fireTimeout = reject; });
    timeoutPromise.catch(() => {});
    let onCallerAbort = null;
    const cancelPromise = new Promise((_, reject) => {
      if (!signal) return;
      if (signal.aborted) { reject(new SpeechError("CANCELLED", "The transcription request was cancelled.")); return; }
      onCallerAbort = () => reject(new SpeechError("CANCELLED", "The transcription request was cancelled."));
      signal.addEventListener("abort", onCallerAbort, { once: true });
    });
    cancelPromise.catch(() => {});
    timer = setTimeout(() => {
      timedOut = true;
      try { controller.abort(); } catch { /* settled */ }
      fireTimeout(new SpeechError("SPEECH_TIMEOUT", "Meta transcription did not answer in time. No command was sent."));
    }, timeoutMs);
    const combined = signal && typeof AbortSignal !== "undefined" && typeof AbortSignal.any === "function"
      ? AbortSignal.any([signal, controller.signal])
      : controller.signal;
    const cleanup = () => {
      if (timer) { clearTimeout(timer); timer = null; }
      if (signal && onCallerAbort) {
        try { signal.removeEventListener("abort", onCallerAbort); } catch { /* gone */ }
        onCallerAbort = null;
      }
    };

    try {
      let res;
      try {
        res = await fetchFn(`${base}/asr/transcribe`, {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
          body: form,
          signal: combined,
        });
      } catch (err) {
        if (signal && signal.aborted) throw new SpeechError("CANCELLED", "The transcription request was cancelled.");
        if (timedOut) throw new SpeechError("SPEECH_TIMEOUT", "Meta transcription did not answer in time. No command was sent.");
        if (err && err.name === "AbortError") throw new SpeechError("SPEECH_TIMEOUT", "Meta transcription did not answer in time. No command was sent.");
        throw new SpeechError("SPEECH_UNREACHABLE", "Meta transcription could not be reached. No command was sent.");
      }
      if (!res.ok) throw httpFailure(res.status);
      let payload = null;
      try {
        payload = await Promise.race([res.json(), timeoutPromise, cancelPromise]);
      } catch (err) {
        if (signal && signal.aborted) throw new SpeechError("CANCELLED", "The transcription request was cancelled.");
        if (timedOut) throw new SpeechError("SPEECH_TIMEOUT", "Meta transcription did not finish responding in time. No command was sent.");
        if (err instanceof SpeechError) throw err;
        throw new SpeechError("SPEECH_BAD_RESPONSE", "Meta transcription returned an unreadable response. No command was sent.");
      }
      let transcript = "";
      if (payload && typeof payload.transcript === "string") transcript = payload.transcript;
      else if (payload && Array.isArray(payload.turns)) {
        transcript = payload.turns.map((turn) => (turn && typeof turn.transcript === "string" ? turn.transcript : "")).join(" ");
      }
      transcript = transcript.trim();
      if (!transcript) throw new SpeechError("SPEECH_NO_SPEECH", "No speech was recognized. Nothing was executed.");
      if (transcript.length > MAX_TRANSCRIPT_CHARS) {
        throw new SpeechError("SPEECH_BAD_RESPONSE", "Meta transcription returned an oversized transcript. No command was sent.");
      }
      return { transcript, model: TRANSCRIBE_MODEL };
    } finally {
      cleanup();
    }
  }

  return { transcribe, model: TRANSCRIBE_MODEL, baseUrl: base, timeoutMs };
}
