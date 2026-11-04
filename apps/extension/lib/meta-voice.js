"use strict";
/* Meta voice transcription provider for the side panel (Issue #30).
 *
 * Transport choice: bounded push-to-talk recording/upload through the
 * existing planner proxy, using a genuinely encoded mono 16-bit WAV.
 * This deliberately does NOT use the Meta realtime WebSocket from the
 * extension: a browser WebSocket cannot attach the proxy's Bearer [REDACTED]
 * header, and a second relay would add socket/session ownership without
 * improving the one-sentence command lifecycle. The tradeoff is that
 * Meta finals arrive after Stop and upload; there are no Meta interim
 * transcripts. Browser recognition remains the fallback provider.
 *
 * The provider exposes the same session contract as the browser
 * controller: start begins one user-requested session, Stop finishes it
 * and may emit exactly one final, Cancel discards it, and terminal paths
 * release microphone tracks, AudioContext nodes, timers, buffers, and
 * any in-flight request. No audio or transcript is stored or logged.
 */

const META_TRANSCRIBE_MODEL = "muse-voice-transcribe-1.0";
const META_MAX_DURATION_MS = 30000;
const META_TARGET_SAMPLE_RATE = 16000;
const META_MAX_WAV_BYTES = 1000000;
const META_TRANSCRIBE_TIMEOUT_MS = 25000;

function speechError(code, message, phase, status) {
  const err = new Error(message);
  err.code = code;
  err.phase = phase || "after-capture";
  if (Number.isInteger(status)) err.status = status;
  return err;
}

function mergeChunks(chunks) {
  const length = (chunks || []).reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Float32Array(length);
  let offset = 0;
  for (const chunk of chunks || []) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function downsample(samples, sourceRate, targetRate = META_TARGET_SAMPLE_RATE) {
  if (!samples || !samples.length) return new Float32Array(0);
  if (!sourceRate || sourceRate === targetRate) return Float32Array.from(samples);
  if (sourceRate < targetRate) return Float32Array.from(samples);
  const ratio = sourceRate / targetRate;
  const outLength = Math.floor(samples.length / ratio);
  const out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i += 1) {
    const start = Math.floor(i * ratio);
    const end = Math.min(samples.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j += 1) sum += samples[j];
    out[i] = end > start ? sum / (end - start) : 0;
  }
  return out;
}

function encodeWav(samples, sampleRate = META_TARGET_SAMPLE_RATE) {
  const bytes = 44 + samples.length * 2;
  const buffer = new ArrayBuffer(bytes);
  const view = new DataView(buffer);
  const writeAscii = (offset, text) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };
  writeAscii(0, "RIFF");
  view.setUint32(4, bytes - 8, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
  }
  return buffer;
}

function makeWavBlob(chunks, sourceRate) {
  const samples = downsample(mergeChunks(chunks), sourceRate, META_TARGET_SAMPLE_RATE);
  const buffer = encodeWav(samples, META_TARGET_SAMPLE_RATE);
  const BlobCtor = globalThis.Blob;
  return { samples, buffer, blob: BlobCtor ? new BlobCtor([buffer], { type: "audio/wav" }) : null, bytes: buffer.byteLength };
}

// POST one bounded WAV to the local proxy. The pairing token travels as
// a Bearer [REDACTED]; the Meta key never reaches this code. One deadline
// governs headers and full response-body consumption.
async function requestTranscription({ baseUrl, token, audioBlob, language, signal, fetchImpl, timeoutMs }) {
  const fetchFn = fetchImpl || (typeof fetch === "function" ? fetch : null);
  if (typeof fetchFn !== "function") throw speechError("NO_FETCH", "No fetch implementation is available.", "before-capture");
  if (!token || !baseUrl) throw speechError("META_UNAVAILABLE", "Meta transcription is not paired.", "before-capture");
  const controller = new AbortController();
  let timer = null;
  let timedOut = false;
  let fireTimeout = null;
  const timeoutPromise = new Promise((_, reject) => { fireTimeout = reject; });
  timeoutPromise.catch(() => {});
  let onCallerAbort = null;
  const cancelPromise = new Promise((_, reject) => {
    if (!signal) return;
    if (signal.aborted) { reject(speechError("CANCELLED", "The transcription request was cancelled.", "after-capture")); return; }
    onCallerAbort = () => reject(speechError("CANCELLED", "The transcription request was cancelled.", "after-capture"));
    signal.addEventListener("abort", onCallerAbort, { once: true });
  });
  cancelPromise.catch(() => {});
  timer = setTimeout(() => {
    timedOut = true;
    try { controller.abort(); } catch { /* settled */ }
    fireTimeout(speechError("SPEECH_TIMEOUT", "Meta transcription did not answer in time. No command was sent.", "after-capture"));
  }, timeoutMs || META_TRANSCRIBE_TIMEOUT_MS);
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
    const form = new FormData();
    form.append("request", new Blob([JSON.stringify({ language: language || "en" })], { type: "application/json" }));
    form.append("audio", audioBlob, "speech.wav");
    let res;
    try {
      res = await fetchFn(`${String(baseUrl).replace(/\/+$/, "")}/v1/transcribe`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: form,
        signal: combined,
      });
    } catch (err) {
      if (signal && signal.aborted) throw speechError("CANCELLED", "The transcription request was cancelled.", "after-capture");
      if (timedOut) throw speechError("SPEECH_TIMEOUT", "Meta transcription did not answer in time. No command was sent.", "after-capture");
      if (err && err.name === "AbortError") throw speechError("SPEECH_TIMEOUT", "Meta transcription did not answer in time. No command was sent.", "after-capture");
      throw speechError("SPEECH_UNREACHABLE", "Meta transcription could not be reached. No command was sent.", "after-capture");
    }
    let payload = null;
    try {
      payload = await Promise.race([res.json(), timeoutPromise, cancelPromise]);
    } catch (err) {
      if (signal && signal.aborted) throw speechError("CANCELLED", "The transcription request was cancelled.", "after-capture");
      if (timedOut) throw speechError("SPEECH_TIMEOUT", "Meta transcription did not finish responding in time. No command was sent.", "after-capture");
      if (err && err.code) throw err;
      throw speechError("SPEECH_BAD_RESPONSE", "Meta transcription returned an unreadable response. No command was sent.", "after-capture");
    }
    if (!payload || typeof payload !== "object" || typeof payload.ok !== "boolean") {
      throw speechError("SPEECH_BAD_RESPONSE", "Meta transcription returned a malformed response. No command was sent.", "after-capture");
    }
    if (!payload.ok) {
      const code = payload.error && typeof payload.error.code === "string" ? payload.error.code : "SPEECH_ERROR";
      const message = payload.error && typeof payload.error.message === "string" ? payload.error.message : "Meta transcription failed. No command was sent.";
      const status = payload.error && Number.isInteger(payload.error.status) ? payload.error.status : undefined;
      throw speechError(code, message, "after-capture", status);
    }
    if (typeof payload.transcript !== "string" || !payload.transcript.trim()) {
      throw speechError("SPEECH_NO_SPEECH", "No speech was recognized. Nothing was executed.", "after-capture");
    }
    return payload;
  } finally {
    cleanup();
  }
}

function createMetaRecognitionController(env = {}) {
  const win = env.window || globalThis;
  const nav = env.navigator || win.navigator || {};
  const handlers = env.handlers || {};
  const fetchImpl = env.fetchImpl;
  const maxDurationMs = env.maxDurationMs || META_MAX_DURATION_MS;
  let current = null;
  let lastSessionId = 0;

  function emit(name, payload) {
    if (typeof handlers[name] === "function") handlers[name](payload);
  }
  function mediaDevices() {
    return env.mediaDevices || nav.mediaDevices || null;
  }
  function audioContextCtor() {
    return env.AudioContext || win.AudioContext || win.webkitAudioContext || null;
  }
  function supported() {
    return Boolean(mediaDevices() && typeof mediaDevices().getUserMedia === "function"
      && audioContextCtor() && typeof FormData !== "undefined" && typeof Blob !== "undefined");
  }

  async function cleanupCapture(session) {
    if (session.timer) { clearTimeout(session.timer); session.timer = null; }
    if (session.processor) {
      try { session.processor.onaudioprocess = null; } catch { /* gone */ }
      try { session.processor.disconnect(); } catch { /* gone */ }
      session.processor = null;
    }
    if (session.source) {
      try { session.source.disconnect(); } catch { /* gone */ }
      session.source = null;
    }
    if (session.sink) {
      try { session.sink.disconnect(); } catch { /* gone */ }
      session.sink = null;
    }
    if (session.stream && typeof session.stream.getTracks === "function") {
      for (const track of session.stream.getTracks()) {
        try { track.stop(); } catch { /* gone */ }
      }
    }
    session.stream = null;
    if (session.audioContext) {
      const ctx = session.audioContext;
      session.audioContext = null;
      try { if (typeof ctx.close === "function") await ctx.close(); } catch { /* gone */ }
    }
    session.chunks = [];
  }

  function terminate(session) {
    if (current === session) current = null;
    session.terminated = true;
  }

  async function fail(session, err) {
    // Ownership is decided at emission time, not when cleanup began:
    // while cleanup is held, Cancel may terminate this session and a
    // newer session may become current. This old failure must then stay
    // silent and must not clear or impersonate the newer session.
    if (session.terminated || session.failureStarted) return;
    session.failureStarted = true;
    await cleanupCapture(session);
    if (session.abortController) {
      try { session.abortController.abort(); } catch { /* settled */ }
      session.abortController = null;
    }
    if (session.cancelled || session.terminated || current !== session) return;
    terminate(session);
    emit("onError", {
      code: err.code || "SPEECH_ERROR",
      message: err.message || "Meta transcription failed. No command was sent.",
      sessionId: session.id,
      phase: err.phase || "after-capture",
      provider: "meta",
    });
  }

  async function finish(session) {
    if (!session || session.terminated || session.phase !== "capturing") return;
    session.phase = "transcribing";
    session.stopRequestedAt = typeof performance !== "undefined" ? performance.now() : Date.now();
    const chunks = session.chunks.slice();
    const sourceRate = session.sampleRate;
    await cleanupCapture(session);
    if (session.terminated || session.cancelled) return;

    const { samples, blob, bytes } = makeWavBlob(chunks, sourceRate);
    let sum = 0;
    for (const value of samples) sum += value * value;
    const rms = samples.length ? Math.sqrt(sum / samples.length) : 0;
    if (!blob || samples.length < META_TARGET_SAMPLE_RATE * 0.2 || rms < 0.0008) {
      await fail(session, speechError("no-speech", "No speech was heard. Nothing was executed.", "after-capture"));
      return;
    }
    if (bytes > META_MAX_WAV_BYTES) {
      await fail(session, speechError("AUDIO_TOO_LARGE", "The recording was too long. Nothing was sent.", "after-capture"));
      return;
    }

    session.abortController = new AbortController();
    try {
      const payload = await requestTranscription({
        baseUrl: session.config.baseUrl,
        token: session.config.token,
        audioBlob: blob,
        language: session.config.language || "en",
        signal: session.abortController.signal,
        fetchImpl,
        timeoutMs: env.transcriptionTimeoutMs,
      });
      if (session.terminated || session.cancelled || current !== session) return;
      session.phase = "final";
      session.dispatched = true;
      const ended = typeof performance !== "undefined" ? performance.now() : Date.now();
      emit("onFinal", {
        text: payload.transcript || "",
        sessionId: session.id,
        provider: "meta",
        model: payload.model || META_TRANSCRIBE_MODEL,
        latencyMs: Math.round(ended - session.stopRequestedAt),
      });
    } catch (err) {
      if (session.terminated || session.cancelled) return;
      await fail(session, err);
    } finally {
      session.abortController = null;
      session.chunks = [];
    }
  }

  async function start(config) {
    if (current) return false;
    const session = {
      id: ++lastSessionId,
      config: config || {},
      phase: "starting",
      chunks: [],
      sampleRate: 0,
      stream: null,
      audioContext: null,
      source: null,
      processor: null,
      sink: null,
      timer: null,
      abortController: null,
      dispatched: false,
      terminated: false,
      cancelled: false,
      stopRequestedAt: 0,
    };
    current = session;
    try {
      if (!supported()) throw speechError("unsupported", "Meta transcription capture is not supported in this browser. Browser recognition remains available.", "before-capture");
      if (!session.config.baseUrl || !session.config.token) {
        throw speechError("META_UNAVAILABLE", "Meta transcription is not paired.", "before-capture");
      }
      let stream;
      try {
        stream = await mediaDevices().getUserMedia({ audio: true });
      } catch (err) {
        if (session.terminated || session.cancelled) return false;
        const code = err && (err.name === "NotAllowedError" || err.name === "SecurityError") ? "not-allowed" : "audio-capture";
        throw speechError(code, code === "not-allowed"
          ? "Microphone access was denied. Typed commands remain available; allow microphone access for this extension or use the Microphone setup button, then try again."
          : "No microphone was found. Typed commands remain available.", "permission");
      }
      if (session.terminated || session.cancelled) {
        session.stream = stream;
        await cleanupCapture(session);
        return false;
      }
      session.stream = stream;
      const AudioCtor = audioContextCtor();
      session.audioContext = new AudioCtor();
      if (session.audioContext.state === "suspended" && typeof session.audioContext.resume === "function") {
        await session.audioContext.resume();
      }
      if (session.terminated || session.cancelled) { await cleanupCapture(session); return false; }
      session.sampleRate = session.audioContext.sampleRate || META_TARGET_SAMPLE_RATE;
      session.source = session.audioContext.createMediaStreamSource(stream);
      if (typeof session.audioContext.createScriptProcessor !== "function") {
        // The microphone stream has already been acquired at this point,
        // so this is not a pre-capture fallback case.
        throw speechError("unsupported", "Meta transcription capture is not supported in this browser. Browser recognition remains available.", "after-capture");
      }
      session.processor = session.audioContext.createScriptProcessor(4096, 1, 1);
      session.sink = session.audioContext.createGain();
      session.sink.gain.value = 0;
      session.processor.onaudioprocess = (event) => {
        if (current !== session || session.phase !== "capturing") return;
        const input = event.inputBuffer && event.inputBuffer.getChannelData(0);
        if (input) session.chunks.push(Float32Array.from(input));
      };
      session.source.connect(session.processor);
      session.processor.connect(session.sink);
      session.sink.connect(session.audioContext.destination);
      session.phase = "capturing";
      session.timer = setTimeout(() => { void finish(session); }, maxDurationMs);
      emit("onState", { state: "listening", sessionId: session.id, provider: "meta" });
      if (session.stopRequested) void finish(session);
      return true;
    } catch (err) {
      if (session.terminated || session.cancelled) { await cleanupCapture(session); return false; }
      await fail(session, err);
      return false;
    }
  }

  function stop() {
    if (!current) return false;
    if (current.phase === "capturing") { void finish(current); return true; }
    if (current.phase === "starting") { current.stopRequested = true; return true; }
    if (current.phase === "transcribing") return true;
    if (current.phase === "final") {
      const session = current;
      terminate(session);
      emit("onState", { state: "idle", sessionId: session.id, provider: "meta" });
      return true;
    }
    return true;
  }

  function cancel() {
    if (!current) return false;
    const session = current;
    session.cancelled = true;
    terminate(session);
    if (session.abortController) {
      try { session.abortController.abort(); } catch { /* settled */ }
      session.abortController = null;
    }
    void cleanupCapture(session);
    emit("onState", { state: "idle", sessionId: session.id, provider: "meta" });
    return true;
  }

  return {
    start,
    stop,
    cancel,
    supported,
    isActive: () => current !== null,
    isListening: () => Boolean(current && current.phase === "capturing"),
    provider: "meta",
    get sessionId() { return lastSessionId; },
  };
}

/* Provider selection is bound before any microphone audio is acquired.
 * Meta is attempted only when the panel's proxy-status check says speech
 * is configured and not known rejected/failed. A configuration/status
 * failure before capture may start browser recognition in the same
 * intentional attempt. Once Meta capture has begun, a failure never
 * replays/transfers that utterance: the session is invalidated, Meta is
 * marked unavailable for later attempts in this panel, and the user can
 * press Start again for a fresh browser attempt. Intentional cancel is
 * not an outage and never triggers fallback. */
function createProviderRecognitionController(env = {}) {
  const handlers = env.handlers || {};
  const voice = env.voiceApi || (typeof globalThis !== "undefined" ? globalThis.SeeyableVoice : null);
  // Every user attempt owns an immutable attempt object and a FRESH
  // child controller. Callbacks close over that attempt, never over a
  // mutable "current provider/currentSessionId", so an old child's late
  // error/final/idle/cleanup cannot clear, impersonate, or stop a newer
  // attempt. Cancellation invalidates the attempt and cancels its child
  // even while provider selection or microphone permission is pending.
  let activeAttempt = null;
  let lastSessionId = 0;
  let metaUnavailable = false;

  function emit(name, payload) {
    if (typeof handlers[name] === "function") handlers[name](payload);
  }
  function createBrowserFor(attempt) {
    const factory = env.createBrowserController
      || (voice && voice.createRecognitionController);
    if (!factory) return null;
    return factory({
      window: env.window || globalThis,
      handlers: {
        onState: (payload) => {
          if (activeAttempt !== attempt || attempt.provider !== "browser") return;
          if (payload && payload.state === "idle") activeAttempt = null;
          emit("onState", { ...(payload || {}), sessionId: attempt.id, provider: "browser" });
        },
        onInterim: (payload) => {
          if (activeAttempt === attempt && attempt.provider === "browser") {
            emit("onInterim", { ...(payload || {}), sessionId: attempt.id, provider: "browser" });
          }
        },
        onFinal: (payload) => {
          if (activeAttempt === attempt && attempt.provider === "browser") {
            emit("onFinal", { ...(payload || {}), sessionId: attempt.id, provider: "browser" });
          }
        },
        onError: (payload) => {
          if (activeAttempt !== attempt || attempt.provider !== "browser") return;
          activeAttempt = null;
          emit("onError", { ...(payload || {}), sessionId: attempt.id, provider: "browser" });
        },
      },
    });
  }
  function createMetaFor(attempt) {
    return createMetaRecognitionController({
      ...env,
      handlers: {
        onState: (payload) => {
          if (activeAttempt !== attempt || attempt.provider !== "meta") return;
          if (payload && payload.state === "idle") activeAttempt = null;
          emit("onState", { ...(payload || {}), sessionId: attempt.id, provider: "meta" });
        },
        onInterim: (payload) => {
          if (activeAttempt === attempt && attempt.provider === "meta") {
            emit("onInterim", { ...(payload || {}), sessionId: attempt.id, provider: "meta" });
          }
        },
        onFinal: (payload) => {
          if (activeAttempt === attempt && attempt.provider === "meta") {
            emit("onFinal", { ...(payload || {}), sessionId: attempt.id, provider: "meta" });
          }
        },
        onError: (payload) => {
          if (activeAttempt !== attempt || attempt.provider !== "meta") return;
          activeAttempt = null;
          attempt.metaFailurePhase = payload && payload.phase ? payload.phase : "after-capture";
          if (attempt.metaFailurePhase === "after-capture") metaUnavailable = true;
          emit("onError", { ...(payload || {}), sessionId: attempt.id, provider: "meta" });
        },
      },
    });
  }
  function metaSupported() {
    try { return createMetaRecognitionController(env).supported(); } catch { return false; }
  }
  function browserSupported() {
    // Never instantiate a recognizer just to probe: construction can
    // have observable side effects in real and mocked browsers alike.
    try {
      if (typeof env.createBrowserController === "function") return true;
      if (voice && typeof voice.isRecognitionSupported === "function") {
        return voice.isRecognitionSupported(env.window || globalThis);
      }
      const w = env.window || globalThis;
      return Boolean(w && (w.SpeechRecognition || w.webkitSpeechRecognition));
    } catch { return false; }
  }
  function supported() {
    return browserSupported() || metaSupported();
  }

  async function start() {
    if (activeAttempt) return false;
    const attempt = {
      id: ++lastSessionId,
      provider: null,
      child: null,
      cancelled: false,
      metaFailurePhase: null,
    };
    activeAttempt = attempt;
    let config = null;
    let eligible = false;
    if (!metaUnavailable && metaSupported() && typeof env.getSpeechConfig === "function") {
      try { config = await env.getSpeechConfig(); } catch { config = null; }
      if (attempt.cancelled || activeAttempt !== attempt) return false;
      eligible = Boolean(config && config.eligible && config.baseUrl && config.token);
    }
    if (attempt.cancelled || activeAttempt !== attempt) return false;

    if (eligible) {
      attempt.provider = "meta";
      attempt.child = createMetaFor(attempt);
      const started = await attempt.child.start(config);
      if (attempt.cancelled || activeAttempt !== attempt) {
        if (started) attempt.child.cancel();
        if (activeAttempt === attempt) activeAttempt = null;
        return false;
      }
      if (started) return true;
      if (activeAttempt === attempt) activeAttempt = null;
      // Only a failure proven to precede capture may fall back within
      // this same user attempt. Permission denial does not get a second
      // prompt, and after-capture failures are never replayed.
      if (attempt.metaFailurePhase !== "before-capture") return false;
      if (attempt.cancelled) return false;
      // Fallback is a new child under the SAME user attempt/session id:
      // no second dispatch identity is created.
      attempt.provider = null;
      attempt.child = null;
    }

    const browserController = createBrowserFor(attempt);
    if (!browserController) {
      if (activeAttempt === attempt) activeAttempt = null;
      emit("onError", { code: "unsupported", message: "Speech recognition is not supported in this browser. Typed commands remain available.", sessionId: attempt.id, provider: "browser" });
      return false;
    }
    attempt.provider = "browser";
    attempt.child = browserController;
    const started = browserController.start();
    if (!started && !browserController.isActive() && activeAttempt === attempt) {
      activeAttempt = null;
    }
    return Boolean(started);
  }

  function stop() {
    if (!activeAttempt) return false;
    if (!activeAttempt.child) {
      // Still selecting a provider: there is no utterance to finish, so
      // Stop terminates the pending attempt now. Ownership is released
      // immediately (not left for the late preflight continuation) and
      // idle is emitted under the attempt's own session ID. The late
      // start continuation sees its cancelled attempt is no longer the
      // owner and starts neither provider; it cannot clear a newer
      // attempt that may already have taken ownership.
      const attempt = activeAttempt;
      attempt.cancelled = true;
      activeAttempt = null;
      emit("onState", { state: "idle", sessionId: attempt.id, provider: null });
      return true;
    }
    return activeAttempt.child.stop();
  }

  function cancel() {
    if (!activeAttempt) return false;
    const attempt = activeAttempt;
    attempt.cancelled = true;
    if (attempt.child) {
      // Let the child emit its idle through the still-bound attempt
      // handler, then ensure ownership is cleared even if it did not.
      const result = attempt.child.cancel();
      if (activeAttempt === attempt) activeAttempt = null;
      return result;
    }
    activeAttempt = null;
    emit("onState", { state: "idle", sessionId: attempt.id, provider: null });
    return true;
  }

  function isActive() {
    if (!activeAttempt) return false;
    if (!activeAttempt.child) return true; // provider selection in flight
    return activeAttempt.child.isActive();
  }

  return {
    start,
    stop,
    cancel,
    supported,
    isActive,
    isListening: () => {
      if (!activeAttempt || !activeAttempt.child) return false;
      return activeAttempt.child.isListening();
    },
    activeProvider: () => (activeAttempt ? activeAttempt.provider : null),
    isMetaUnavailable: () => metaUnavailable,
    resetMetaUnavailable: () => { metaUnavailable = false; },
    get sessionId() { return activeAttempt ? activeAttempt.id : lastSessionId; },
  };
}

const SeeyableMetaVoice = {
  META_TRANSCRIBE_MODEL,
  META_MAX_DURATION_MS,
  META_TARGET_SAMPLE_RATE,
  META_MAX_WAV_BYTES,
  encodeWav,
  downsample,
  makeWavBlob,
  requestTranscription,
  createMetaRecognitionController,
  createProviderRecognitionController,
};

if (typeof globalThis !== "undefined") globalThis.SeeyableMetaVoice = SeeyableMetaVoice;
if (typeof module !== "undefined" && module.exports) module.exports = SeeyableMetaVoice;
