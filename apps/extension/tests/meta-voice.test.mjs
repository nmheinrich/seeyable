"use strict";
/* Issue #30 Meta voice provider: transcript-only controller proof,
 * provider selection/fallback, cancellation at asynchronous phases,
 * dispatch-once mapping, and resource cleanup. Microphone, AudioContext,
 * and fetch are controllable mocks; no panel dispatcher or executor is
 * attached to the transcript-only controller in these tests. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const MetaVoice = require("../lib/meta-voice.js");
const Voice = require("../lib/voice-commands.js");

const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));
const CONFIG = { baseUrl: "http://127.0.0.1:6124", token: "pairing-token", language: "en", eligible: true };

function mockAudio({ sampleRate = 16000, deny = false } = {}) {
  const state = {
    tracks: [{ stopped: false, stop() { this.stopped = true; } }],
    contexts: [],
    processors: [],
    getUserMediaCalls: 0,
  };
  const stream = { getTracks: () => state.tracks };
  class MockAudioContext {
    constructor() {
      this.sampleRate = sampleRate;
      this.state = "running";
      this.destination = {};
      this.closed = false;
      state.contexts.push(this);
    }
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    createScriptProcessor() {
      const processor = { onaudioprocess: null, disconnected: false, connect() {}, disconnect() { this.disconnected = true; } };
      state.processors.push(processor);
      return processor;
    }
    createGain() { return { gain: { value: 1 }, connect() {}, disconnect() {} }; }
    async close() { this.closed = true; }
  }
  const mediaDevices = {
    async getUserMedia() {
      state.getUserMediaCalls += 1;
      if (deny) {
        const err = new Error("denied");
        err.name = "NotAllowedError";
        throw err;
      }
      return stream;
    },
  };
  state.feed = (amplitude = 0.1, chunks = 1) => {
    const processor = state.processors[state.processors.length - 1];
    for (let i = 0; i < chunks; i += 1) {
      processor.onaudioprocess({ inputBuffer: { getChannelData: () => new Float32Array(4096).fill(amplitude) } });
    }
  };
  return { state, mediaDevices, AudioContext: MockAudioContext };
}

function recorder() {
  const events = [];
  return {
    events,
    handlers: {
      onState: (p) => events.push({ type: "state", ...p }),
      onInterim: (p) => events.push({ type: "interim", ...p }),
      onFinal: (p) => events.push({ type: "final", ...p }),
      onError: (p) => events.push({ type: "error", ...p }),
    },
    finals: () => events.filter((e) => e.type === "final"),
    errors: () => events.filter((e) => e.type === "error"),
  };
}

function okFetch(transcript = "fill Full name with Grace Hopper") {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true, status: 200, json: async () => ({ ok: true, transcript, model: MetaVoice.META_TRANSCRIBE_MODEL }) };
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

test("wav: encoder writes a genuine mono 16-bit WAV and downsamples", () => {
  const { samples, buffer, bytes } = MetaVoice.makeWavBlob([new Float32Array([0, 0.5, -0.5, 0.25])], 32000);
  assert.equal(samples.length, 2, "32 kHz input is averaged down to 16 kHz");
  const view = new DataView(buffer);
  assert.equal(String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3)), "RIFF");
  assert.equal(view.getUint16(22, true), 1);
  assert.equal(view.getUint32(24, true), 16000);
  assert.equal(view.getUint16(34, true), 16);
  assert.equal(bytes, 44 + samples.length * 2);
});

test("transcript-only Meta session: one final, no interim dispatch surface, complete cleanup", async () => {
  const audio = mockAudio();
  const rec = recorder();
  const fetchImpl = okFetch("do not approve");
  const controller = MetaVoice.createMetaRecognitionController({
    mediaDevices: audio.mediaDevices,
    AudioContext: audio.AudioContext,
    fetchImpl,
    handlers: rec.handlers, // transcript-only: records finals; no command pipeline exists here
  });
  assert.equal(await controller.start(CONFIG), true);
  assert.equal(rec.events.some((e) => e.type === "state" && e.state === "listening"), true);
  audio.state.feed(0.1, 1);
  assert.equal(controller.stop(), true);
  await tick(40);
  assert.equal(rec.finals().length, 1);
  assert.equal(rec.finals()[0].text, "do not approve", "negated approval wording is only transcribed, never acted on here");
  assert.equal(rec.finals()[0].provider, "meta");
  assert.equal(typeof rec.finals()[0].latencyMs, "number");
  assert.equal(fetchImpl.calls.length, 1);
  assert.match(fetchImpl.calls[0].url, /\/v1\/transcribe$/);
  assert.equal(fetchImpl.calls[0].opts.headers.Authorization, "Bearer pairing-token");
  const audioPart = fetchImpl.calls[0].opts.body.get("audio");
  assert.equal(audioPart.type, "audio/wav");
  assert.ok(audioPart.size > 44);
  // A second Stop after the final cannot dispatch again.
  controller.stop();
  await tick();
  assert.equal(rec.finals().length, 1);
  assert.equal(audio.state.tracks[0].stopped, true);
  assert.equal(audio.state.contexts[0].closed, true);
  assert.equal(audio.state.processors[0].disconnected, true);
  assert.equal(controller.isActive(), false);
});

test("Meta cancel during capture discards audio and releases resources", async () => {
  const audio = mockAudio();
  const rec = recorder();
  const fetchImpl = okFetch();
  const controller = MetaVoice.createMetaRecognitionController({
    mediaDevices: audio.mediaDevices, AudioContext: audio.AudioContext, fetchImpl, handlers: rec.handlers,
  });
  await controller.start(CONFIG);
  audio.state.feed();
  assert.equal(controller.cancel(), true);
  controller.stop();
  await tick(30);
  assert.equal(rec.finals().length, 0);
  assert.equal(fetchImpl.calls.length, 0, "cancelled audio is never uploaded");
  assert.equal(audio.state.tracks[0].stopped, true);
  assert.equal(audio.state.contexts[0].closed, true);
});

test("Meta cancel during transcription makes a late success inert", async () => {
  const audio = mockAudio();
  const rec = recorder();
  let releaseFetch;
  let seenSignal = null;
  const fetchImpl = async (url, opts) => {
    seenSignal = opts.signal;
    await new Promise((resolve) => { releaseFetch = resolve; });
    return { ok: true, status: 200, json: async () => ({ ok: true, transcript: "show tags" }) };
  };
  const controller = MetaVoice.createMetaRecognitionController({
    mediaDevices: audio.mediaDevices, AudioContext: audio.AudioContext, fetchImpl, handlers: rec.handlers,
  });
  await controller.start(CONFIG);
  audio.state.feed();
  controller.stop();
  await tick();
  assert.ok(seenSignal, "upload began");
  assert.equal(controller.cancel(), true);
  assert.equal(seenSignal.aborted, true);
  releaseFetch();
  await tick(30);
  assert.equal(rec.finals().length, 0, "late finals after cancel cannot dispatch");
  assert.equal(controller.isActive(), false);
});

test("Meta silence and oversized recordings fail before upload", async () => {
  const silentAudio = mockAudio();
  const silentRec = recorder();
  const silentFetch = okFetch();
  const silent = MetaVoice.createMetaRecognitionController({
    mediaDevices: silentAudio.mediaDevices, AudioContext: silentAudio.AudioContext, fetchImpl: silentFetch, handlers: silentRec.handlers,
  });
  await silent.start(CONFIG);
  silentAudio.state.feed(0, 1);
  silent.stop();
  await tick(30);
  assert.equal(silentRec.errors()[0].code, "no-speech");
  assert.equal(silentFetch.calls.length, 0);

  const bigAudio = mockAudio();
  const bigRec = recorder();
  const bigFetch = okFetch();
  const big = MetaVoice.createMetaRecognitionController({
    mediaDevices: bigAudio.mediaDevices, AudioContext: bigAudio.AudioContext, fetchImpl: bigFetch, handlers: bigRec.handlers,
  });
  await big.start(CONFIG);
  bigAudio.state.feed(0.1, 260); // >30 s at 16 kHz after capture, so WAV exceeds the bound
  big.stop();
  await tick(40);
  assert.equal(bigRec.errors()[0].code, "AUDIO_TOO_LARGE");
  assert.equal(bigFetch.calls.length, 0, "oversized audio is not uploaded");
});

function fakeBrowserFactory(rec) {
  const state = { starts: 0, active: false };
  const factory = ({ handlers }) => ({
    supported: () => true,
    isActive: () => state.active,
    isListening: () => state.active,
    get sessionId() { return 900 + state.starts; },
    start() {
      state.starts += 1;
      state.active = true;
      handlers.onState({ state: "listening", sessionId: this.sessionId });
      return true;
    },
    stop() { return state.active; },
    cancel() {
      if (!state.active) return false;
      state.active = false;
      handlers.onState({ state: "idle", sessionId: this.sessionId });
      return true;
    },
    emitFinal(text) { handlers.onFinal({ text, sessionId: this.sessionId }); },
  });
  factory.state = state;
  return factory;
}

test("provider: missing/unpaired or known-unavailable speech uses browser for that attempt", async () => {
  const rec = recorder();
  const browserFactory = fakeBrowserFactory(rec);
  const audio = mockAudio();
  const provider = MetaVoice.createProviderRecognitionController({
    handlers: rec.handlers,
    createBrowserController: browserFactory,
    mediaDevices: audio.mediaDevices,
    AudioContext: audio.AudioContext,
    fetchImpl: okFetch(),
    getSpeechConfig: async () => ({ eligible: false }),
  });
  assert.equal(await provider.start(), true);
  assert.equal(provider.activeProvider(), "browser");
  assert.equal(browserFactory.state.starts, 1);
  assert.equal(audio.state.getUserMediaCalls, 0, "browser fallback does not also open Meta capture");
  provider.cancel();
});

test("provider: pre-capture proxy loss falls back in the same attempt; after-capture failure does not replay", async () => {
  // Pre-capture: status/config lookup itself is down.
  const rec1 = recorder();
  const browser1 = fakeBrowserFactory(rec1);
  const audio1 = mockAudio();
  const provider1 = MetaVoice.createProviderRecognitionController({
    handlers: rec1.handlers,
    createBrowserController: browser1,
    mediaDevices: audio1.mediaDevices,
    AudioContext: audio1.AudioContext,
    fetchImpl: okFetch(),
    getSpeechConfig: async () => { throw new Error("proxy down"); },
  });
  assert.equal(await provider1.start(), true);
  assert.equal(provider1.activeProvider(), "browser");
  provider1.cancel();

  // After capture: Meta transcription fails, so this utterance is dead.
  const rec2 = recorder();
  const browser2 = fakeBrowserFactory(rec2);
  const audio2 = mockAudio();
  const failingFetch = async () => ({
    ok: false,
    status: 502,
    json: async () => ({ ok: false, error: { code: "SPEECH_UNREACHABLE", message: "Meta transcription could not be reached. No command was sent." } }),
  });
  const provider2 = MetaVoice.createProviderRecognitionController({
    handlers: rec2.handlers,
    createBrowserController: browser2,
    mediaDevices: audio2.mediaDevices,
    AudioContext: audio2.AudioContext,
    fetchImpl: failingFetch,
    getSpeechConfig: async () => CONFIG,
  });
  assert.equal(await provider2.start(), true);
  assert.equal(provider2.activeProvider(), "meta");
  audio2.state.feed();
  provider2.stop();
  await tick(40);
  assert.equal(rec2.errors().length, 1);
  assert.equal(browser2.state.starts, 0, "the failed utterance is never replayed into browser recognition");
  assert.equal(provider2.isMetaUnavailable(), true);

  // The NEXT user-started attempt is browser, without another Meta try.
  assert.equal(await provider2.start(), true);
  assert.equal(provider2.activeProvider(), "browser");
  assert.equal(browser2.state.starts, 1);
  provider2.cancel();
});

test("provider: stop during provider selection terminates ownership; late preflight starts nothing", async () => {
  const rec = recorder();
  const browser = fakeBrowserFactory(rec);
  const audio = mockAudio();
  let releaseConfig;
  let configCalls = 0;
  const provider = MetaVoice.createProviderRecognitionController({
    handlers: rec.handlers,
    createBrowserController: browser,
    mediaDevices: audio.mediaDevices,
    AudioContext: audio.AudioContext,
    fetchImpl: okFetch(),
    getSpeechConfig: () => {
      configCalls += 1;
      if (configCalls === 1) return new Promise((resolve) => { releaseConfig = () => resolve(null); });
      return Promise.resolve(null);
    },
  });
  const starting = provider.start();
  await tick();
  assert.equal(provider.isActive(), true, "provider selection owns the attempt");
  assert.equal(provider.stop(), true);
  assert.equal(provider.isActive(), false, "Stop releases ownership immediately, before preflight settles");
  assert.equal(
    rec.events.some((e) => e.type === "state" && e.state === "idle" && e.sessionId === 1),
    true,
    "idle is emitted under the stopped attempt's own session ID",
  );
  releaseConfig();
  assert.equal(await starting, false, "the stopped attempt never starts a provider");
  await tick();
  assert.equal(audio.state.getUserMediaCalls, 0, "no Meta capture from the stopped attempt");
  assert.equal(browser.state.starts, 0, "no browser fallback replay from the stopped attempt");
  assert.equal(rec.finals().length, 0);
  assert.equal(rec.errors().length, 0);
  // A fresh user attempt works normally (browser here, because the
  // second preflight returns no eligible Meta configuration).
  assert.equal(await provider.start(), true);
  assert.equal(provider.activeProvider(), "browser");
  assert.equal(provider.sessionId, 2);
  provider.cancel();
});

test("provider: cancel during provider selection starts nothing and triggers no fallback", async () => {
  const rec = recorder();
  const browser = fakeBrowserFactory(rec);
  const audio = mockAudio();
  let releaseConfig;
  const provider = MetaVoice.createProviderRecognitionController({
    handlers: rec.handlers,
    createBrowserController: browser,
    mediaDevices: audio.mediaDevices,
    AudioContext: audio.AudioContext,
    fetchImpl: okFetch(),
    getSpeechConfig: () => new Promise((resolve) => { releaseConfig = () => resolve(CONFIG); }),
  });
  const starting = provider.start();
  assert.equal(provider.isActive(), true, "selection is an active attempt");
  assert.equal(provider.cancel(), true);
  releaseConfig();
  assert.equal(await starting, false);
  await tick();
  assert.equal(browser.state.starts, 0);
  assert.equal(audio.state.getUserMediaCalls, 0);
  assert.equal(rec.finals().length, 0);
});

test("provider: browser finals keep composite session identity and dispatch once", async () => {
  const rec = recorder();
  class MockRecognition {
    constructor() { this.onstart = null; this.onresult = null; this.onerror = null; this.onend = null; MockRecognition.last = this; }
    start() { if (this.onstart) this.onstart(); }
    stop() {}
    abort() {}
  }
  const provider = MetaVoice.createProviderRecognitionController({
    window: { SpeechRecognition: MockRecognition },
    handlers: rec.handlers,
    getSpeechConfig: async () => null,
  });
  assert.equal(await provider.start(), true);
  const sessionId = provider.sessionId;
  const result = [{ transcript: "approve plan" }];
  result.isFinal = true;
  MockRecognition.last.onresult({ resultIndex: 0, results: [result] });
  MockRecognition.last.onresult({ resultIndex: 0, results: [result] });
  assert.equal(rec.finals().length, 1, "duplicate browser finals still dispatch once through the composite");
  assert.equal(rec.finals()[0].sessionId, sessionId);
  provider.cancel();
});

test("Meta request client: stalled body hits the deadline and caller cancellation stays CANCELLED", async () => {
  const blob = new Blob([MetaVoice.encodeWav(new Float32Array(1600).fill(0.1), 16000)], { type: "audio/wav" });
  const stalledFetch = async () => ({
    ok: true,
    status: 200,
    json: () => new Promise(() => {}),
  });
  await assert.rejects(
    MetaVoice.requestTranscription({ baseUrl: "http://127.0.0.1:6124", token: "t", audioBlob: blob, language: "en", fetchImpl: stalledFetch, timeoutMs: 20 }),
    (err) => err.code === "SPEECH_TIMEOUT",
  );

  const caller = new AbortController();
  const heldFetch = async () => ({
    ok: true,
    status: 200,
    json: () => new Promise(() => {}),
  });
  const pending = MetaVoice.requestTranscription({
    baseUrl: "http://127.0.0.1:6124", token: "t", audioBlob: blob, language: "es", fetchImpl: heldFetch, signal: caller.signal, timeoutMs: 5000,
  });
  caller.abort();
  await assert.rejects(pending, (err) => err.code === "CANCELLED");
});

test("provider: cancel during microphone permission invalidates that grant; a fresh session starts", async () => {
  const rec = recorder();
  const grants = [];
  const streams = [];
  const mediaDevices = {
    getUserMedia: () => new Promise((resolve) => {
      const track = { stopped: false, stop() { this.stopped = true; } };
      const stream = { track, getTracks: () => [track] };
      streams.push(stream);
      grants.push(() => resolve(stream));
    }),
  };
  class AC {
    constructor() { this.sampleRate = 16000; this.state = "running"; this.destination = {}; }
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    createScriptProcessor() { return { onaudioprocess: null, connect() {}, disconnect() {} }; }
    createGain() { return { gain: { value: 0 }, connect() {}, disconnect() {} }; }
    async close() {}
  }
  const provider = MetaVoice.createProviderRecognitionController({
    handlers: rec.handlers,
    mediaDevices,
    AudioContext: AC,
    fetchImpl: okFetch(),
    getSpeechConfig: async () => CONFIG,
  });
  const first = provider.start();
  await tick();
  assert.equal(provider.isActive(), true, "permission request is owned by session 1");
  assert.equal(provider.cancel(), true);
  assert.equal(provider.isActive(), false, "Cancel immediately releases ownership");
  const second = provider.start();
  await tick();
  assert.equal(grants.length, 2, "the fresh session made its own permission request");
  grants[0](); // late grant for the cancelled session
  await tick();
  assert.equal(streams[0].track.stopped, true, "a late grant stops its own tracks");
  assert.equal(rec.events.filter((e) => e.type === "state" && e.state === "listening").length, 0, "session 1 never starts capture");
  grants[1]();
  assert.equal(await second, true);
  assert.equal(provider.activeProvider(), "meta");
  assert.equal(provider.sessionId, 2);
  await first;
  provider.cancel();
});

test("provider: old setup failure held in cleanup cannot error or clear a replacement session", async () => {
  const rec = recorder();
  let contextCount = 0;
  let releaseClose;
  class AC {
    constructor() { this.n = ++contextCount; this.sampleRate = 16000; this.state = "running"; this.destination = {}; }
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    createScriptProcessor() {
      if (this.n === 1) throw new Error("old setup failure");
      return { onaudioprocess: null, connect() {}, disconnect() {} };
    }
    createGain() { return { gain: { value: 0 }, connect() {}, disconnect() {} }; }
    close() { return this.n === 1 ? new Promise((r) => { releaseClose = r; }) : Promise.resolve(); }
  }
  const provider = MetaVoice.createProviderRecognitionController({
    handlers: rec.handlers,
    mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) },
    AudioContext: AC,
    fetchImpl: okFetch(),
    getSpeechConfig: async () => CONFIG,
  });
  const oldStart = provider.start();
  await tick(); // session 1 setup failed; its cleanup is held in AudioContext.close
  assert.equal(provider.cancel(), true);
  assert.equal(await provider.start(), true, "session 2 starts while session 1 cleanup is still held");
  const before = { provider: provider.activeProvider(), active: provider.isActive(), sessionId: provider.sessionId };
  releaseClose();
  await oldStart;
  await tick();
  assert.deepEqual(before, { provider: "meta", active: true, sessionId: 2 });
  assert.deepEqual(
    { provider: provider.activeProvider(), active: provider.isActive(), sessionId: provider.sessionId },
    before,
    "the old cleanup/failure cannot clear the replacement session",
  );
  assert.equal(rec.errors().length, 0, "the old failure is never remapped to session 2");
  provider.cancel();
});

test("provider: a late final from a cancelled session cannot dispatch after replacement", async () => {
  const rec = recorder();
  const audio = mockAudio();
  let releaseFirst;
  let fetchCalls = 0;
  const fetchImpl = async () => {
    fetchCalls += 1;
    if (fetchCalls === 1) {
      await new Promise((r) => { releaseFirst = r; });
      return { ok: true, status: 200, json: async () => ({ ok: true, transcript: "show tags" }) };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, transcript: "hide tags" }) };
  };
  const provider = MetaVoice.createProviderRecognitionController({
    handlers: rec.handlers,
    mediaDevices: audio.mediaDevices,
    AudioContext: audio.AudioContext,
    fetchImpl,
    getSpeechConfig: async () => CONFIG,
  });
  assert.equal(await provider.start(), true);
  audio.state.feed();
  provider.stop(); // session 1 transcription in flight
  await tick();
  assert.equal(provider.cancel(), true);
  assert.equal(await provider.start(), true, "session 2 captures independently");
  audio.state.feed();
  provider.stop();
  await tick(30);
  releaseFirst(); // stale session-1 success arrives last
  await tick(30);
  assert.equal(rec.finals().length, 1, "only the replacement final can dispatch");
  assert.equal(rec.finals()[0].text, "hide tags");
  assert.equal(rec.finals()[0].sessionId, 2);
  provider.stop();
});

test("Meta permission denial is reported once and does not pretend capture began", async () => {
  const audio = mockAudio({ deny: true });
  const rec = recorder();
  const controller = MetaVoice.createMetaRecognitionController({
    mediaDevices: audio.mediaDevices, AudioContext: audio.AudioContext, fetchImpl: okFetch(), handlers: rec.handlers,
  });
  assert.equal(await controller.start(CONFIG), false);
  assert.equal(rec.errors().length, 1);
  assert.equal(rec.errors()[0].code, "not-allowed");
  assert.equal(rec.errors()[0].phase, "permission");
  assert.equal(controller.isActive(), false);
});
