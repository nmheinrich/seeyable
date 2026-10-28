"use strict";
/* Voice/typed command support for the side panel (Feature #10).
 *
 * This module owns three small, separately testable pieces:
 *  - command text normalization and exact resolution ("show tags" /
 *    "hide tags" only — no substring matching, no guessing);
 *  - a speech-output boundary: say(text) accepts an application-owned
 *    string (today: command feedback; later: the planner's `say`
 *    field). It never speaks page content on its own;
 *  - a recognition session controller wrapping the Web Speech API
 *    with single-session, dispatch-once, stop-vs-cancel semantics.
 *
 * No audio or transcript is stored, logged, or returned from here.
 */

const SUPPORTED_COMMANDS = [
  { phrase: "show tags", kind: "show-tags", spoken: "Tags shown" },
  { phrase: "hide tags", kind: "hide-tags", spoken: "Tags hidden" },
];

function normalizeCommandText(text) {
  return String(text == null ? "" : text)
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[.!?,;:]+$/, "")
    .trim();
}

function resolveCommand(text) {
  const normalized = normalizeCommandText(text);
  if (!normalized) return { kind: "empty", normalized };
  const match = SUPPORTED_COMMANDS.find((c) => c.phrase === normalized);
  if (match) return { kind: match.kind, normalized, spoken: match.spoken };
  return { kind: "unknown", normalized };
}

function supportedPhrases() {
  return SUPPORTED_COMMANDS.map((c) => c.phrase);
}

/* --- Speech output ------------------------------------------------------- */
function createSpeechOutput(env = {}) {
  const synth = env.speechSynthesis !== undefined ? env.speechSynthesis : globalThis.speechSynthesis;
  const Utterance = env.SpeechSynthesisUtterance !== undefined
    ? env.SpeechSynthesisUtterance : globalThis.SpeechSynthesisUtterance;
  let enabled = env.enabled !== false;
  let speaking = false;

  function supported() {
    return Boolean(synth && typeof synth.speak === "function" && typeof synth.cancel === "function" && Utterance);
  }
  function stop() {
    if (synth && typeof synth.cancel === "function") {
      try { synth.cancel(); } catch { /* unsupported synthesis must not block */ }
    }
    speaking = false;
  }
  // Speaks one short application-owned string. A new utterance replaces
  // any queued feedback so stale confirmations are never read out late.
  function say(text) {
    if (!enabled || !supported() || !text) return false;
    stop();
    try {
      const utterance = new Utterance(String(text));
      utterance.onend = () => { speaking = false; };
      utterance.onerror = () => { speaking = false; };
      speaking = true;
      synth.speak(utterance);
      return true;
    } catch {
      speaking = false;
      return false;
    }
  }
  return {
    say,
    stop,
    supported,
    isSpeaking: () => speaking,
    setEnabled(value) { enabled = Boolean(value); if (!enabled) stop(); },
    get enabled() { return enabled; },
  };
}

/* --- Recognition sessions --------------------------------------------------
 * One short, user-initiated session at a time (continuous: false).
 *  - stop():   finish the current utterance; a final result may still
 *              be delivered once before `onend`.
 *  - cancel(): discard the utterance; no final result is delivered,
 *              and late callbacks from the aborted session are ignored.
 * "listening" is reported only from the recognition `onstart` event —
 * never optimistically from start(). Sessions are identified by an
 * incrementing id; every callback checks it, so obsolete sessions
 * cannot dispatch, render, or change state. */
const RECOGNITION_ERRORS = {
  "not-allowed": "Microphone access was denied. Typed commands remain available; allow microphone access for this extension or use the Microphone setup button, then try again.",
  "service-not-allowed": "Microphone access was denied. Typed commands remain available; allow microphone access for this extension or use the Microphone setup button, then try again.",
  "audio-capture": "No microphone was found. Typed commands remain available.",
  "no-speech": "No speech was heard. Nothing was executed.",
  "network": "Speech recognition hit a network error. Nothing was executed; typed commands remain available.",
  "aborted": null, // intentional cancel/end: not an error
};

function createRecognitionController(env = {}) {
  const win = env.window || globalThis;
  const handlers = env.handlers || {};
  // `current` is the one live session object. Every callback captures
  // its session and compares identity: once a session terminates —
  // error, end, cancel, or failed start — it is no longer current, so
  // saved/late callbacks from it can neither dispatch nor touch UI.
  let current = null;
  let lastSessionId = 0;

  function ctor() {
    return win.SpeechRecognition || win.webkitSpeechRecognition || null;
  }
  function supported() { return Boolean(ctor()); }
  function emit(name, payload) {
    if (typeof handlers[name] === "function") handlers[name](payload);
  }
  function terminate(session) {
    if (current === session) current = null;
    session.terminated = true;
  }

  function start() {
    if (current) return false; // repeated Start clicks are ignored
    const Ctor = ctor();
    if (!Ctor) {
      emit("onError", { code: "unsupported", message: "Speech recognition is not supported in this browser. Typed commands remain available." });
      return false;
    }
    let rec;
    try {
      rec = new Ctor();
    } catch {
      emit("onError", { code: "unsupported", message: "Speech recognition could not be created. Typed commands remain available." });
      return false;
    }
    const session = { id: ++lastSessionId, rec, dispatched: false, terminated: false };
    current = session;
    rec.continuous = false;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    if (!rec.lang) { try { rec.lang = "en-US"; } catch { /* default locale */ } }

    rec.onstart = () => {
      if (current !== session) return;
      emit("onState", { state: "listening", sessionId: session.id });
    };
    rec.onresult = (event) => {
      if (current !== session || session.dispatched) return;
      const results = event.results || [];
      let interim = "";
      for (let i = event.resultIndex || 0; i < results.length; i += 1) {
        const result = results[i];
        const alt = result && result[0];
        if (!alt) continue;
        if (result.isFinal) {
          session.dispatched = true; // exactly one dispatch per session
          emit("onFinal", { text: alt.transcript || "", sessionId: session.id });
          return;
        }
        interim += alt.transcript || "";
      }
      if (interim) emit("onInterim", { text: interim, sessionId: session.id });
    };
    rec.onerror = (event) => {
      if (current !== session) return;
      // Error closes the session definitively. No idle state is
      // emitted here or by a trailing onend, so the actionable error
      // (denial, network, …) is not immediately erased.
      terminate(session);
      const code = (event && event.error) || "unknown";
      const message = RECOGNITION_ERRORS[code] !== undefined
        ? RECOGNITION_ERRORS[code]
        : `Speech recognition failed (${code}). Nothing was executed; typed commands remain available.`;
      if (message) emit("onError", { code, message, sessionId: session.id });
    };
    rec.onend = () => {
      if (current !== session) return; // trailing end after error/cancel: no-op
      terminate(session);
      emit("onState", { state: "idle", sessionId: session.id });
    };
    try {
      rec.start();
    } catch {
      terminate(session);
      emit("onError", { code: "start-failed", message: "Speech recognition could not start. Typed commands remain available.", sessionId: session.id });
      return false;
    }
    return true;
  }

  function stop() {
    if (!current) return false;
    // Keep the session current: a final result delivered before the
    // normal end may still dispatch once; onend then closes it.
    try { current.rec.stop(); } catch { /* already ending */ }
    return true;
  }

  function cancel() {
    if (!current) return false;
    const session = current;
    terminate(session); // invalidate every pending callback immediately
    const rec = session.rec;
    rec.onstart = rec.onresult = rec.onerror = rec.onend = null;
    try { if (typeof rec.abort === "function") rec.abort(); else rec.stop(); } catch { /* discarded either way */ }
    emit("onState", { state: "idle", sessionId: session.id });
    return true;
  }

  return {
    start,
    stop,
    cancel,
    supported,
    isActive: () => current !== null,
    isListening: () => current !== null,
    get sessionId() { return lastSessionId; },
  };
}

const SeeyableVoice = {
  SUPPORTED_COMMANDS,
  normalizeCommandText,
  resolveCommand,
  supportedPhrases,
  createSpeechOutput,
  createRecognitionController,
};

if (typeof globalThis !== "undefined") globalThis.SeeyableVoice = SeeyableVoice;
if (typeof module !== "undefined" && module.exports) module.exports = SeeyableVoice;
