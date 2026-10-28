// Feature 10: voice/typed command module — controllable speech mocks.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const voice = require("../lib/voice-commands.js");

test("normalize/resolve: exact phrases only, case and punctuation tolerated", () => {
  assert.equal(voice.resolveCommand("show tags").kind, "show-tags");
  assert.equal(voice.resolveCommand("  SHOW   TAGS! ").kind, "show-tags");
  assert.equal(voice.resolveCommand("Hide tags.").kind, "hide-tags");
  assert.equal(voice.resolveCommand("hide tags?").kind, "hide-tags");
  assert.equal(voice.resolveCommand("don't show tags").kind, "unknown", "negation must never resolve to execution");
  assert.equal(voice.resolveCommand("show tags please").kind, "unknown");
  assert.equal(voice.resolveCommand("please show the tags").kind, "unknown");
  assert.equal(voice.resolveCommand("show tag").kind, "unknown");
  assert.equal(voice.resolveCommand("show").kind, "unknown");
  assert.equal(voice.resolveCommand("").kind, "empty");
  assert.equal(voice.resolveCommand("   ").kind, "empty");
  assert.equal(voice.resolveCommand(null).kind, "empty");
  assert.deepEqual(voice.supportedPhrases(), ["show tags", "hide tags"]);
});

function makeSpeech() {
  const spoken = [];
  let cancels = 0;
  class Utterance { constructor(text) { this.text = text; } }
  const synth = {
    speak(u) { spoken.push(u.text); },
    cancel() { cancels += 1; },
  };
  return { spoken, synth, Utterance, cancels: () => cancels };
}

test("speech output: say speaks application strings, replaces queue, honors mute", () => {
  const s = makeSpeech();
  const out = voice.createSpeechOutput({ speechSynthesis: s.synth, SpeechSynthesisUtterance: s.Utterance });
  assert.equal(out.supported(), true);
  assert.equal(out.say("Tags shown"), true);
  assert.equal(out.say("Tags hidden"), true);
  assert.deepEqual(s.spoken, ["Tags shown", "Tags hidden"]);
  assert.ok(s.cancels() >= 2, "new feedback cancels obsolete queued feedback");
  out.setEnabled(false);
  assert.equal(out.say("Tags shown"), false, "muted output never speaks");
  assert.equal(s.spoken.length, 2);
});

test("speech output: unsupported synthesis never blocks (say returns false)", () => {
  const out = voice.createSpeechOutput({ speechSynthesis: undefined, SpeechSynthesisUtterance: undefined });
  assert.equal(out.supported(), false);
  assert.equal(out.say("Tags shown"), false);
  out.stop();
});

class FakeRecognition {
  static instances = [];
  constructor() { FakeRecognition.instances.push(this); this.handlers = {}; }
  start() { this.started = true; }
  stop() { this.stopped = true; }
  abort() { this.aborted = true; }
  fireStart() { if (this.onstart) this.onstart(); }
  fireResult(text, isFinal) {
    if (!this.onresult) return;
    const result = [{ transcript: text }];
    result.isFinal = isFinal;
    this.onresult({ resultIndex: 0, results: [result] });
  }
  fireError(code) { if (this.onerror) this.onerror({ error: code }); }
  fireEnd() { if (this.onend) this.onend(); }
}

function makeController() {
  FakeRecognition.instances = [];
  const events = [];
  const controller = voice.createRecognitionController({
    window: { SpeechRecognition: FakeRecognition },
    handlers: {
      onState: (e) => events.push(["state", e.state]),
      onInterim: (e) => events.push(["interim", e.text]),
      onFinal: (e) => events.push(["final", e.text]),
      onError: (e) => events.push(["error", e.code, e.message]),
    },
  });
  return { controller, events, rec: () => FakeRecognition.instances[FakeRecognition.instances.length - 1] };
}

test("recognition: listening only after onstart; interim never dispatches; final dispatches once", () => {
  const { controller, events, rec } = makeController();
  assert.equal(controller.start(), true);
  assert.equal(controller.start(), false, "repeated Start is ignored");
  assert.equal(FakeRecognition.instances.length, 1);
  assert.ok(!events.some(([k, v]) => k === "state" && v === "listening"), "no listening state before onstart");
  rec().fireStart();
  rec().fireResult("show ta", false);
  assert.ok(!events.some(([k]) => k === "final"), "interim must not dispatch");
  rec().fireResult("show tags", true);
  rec().fireResult("show tags", true); // duplicate callback
  assert.deepEqual(events.filter(([k]) => k === "final"), [["final", "show tags"]], "exactly one dispatch per session");
  rec().fireEnd();
  assert.deepEqual(events.filter(([k]) => k === "state").pop(), ["state", "idle"]);
});

test("recognition: stop finishes the current utterance (final still dispatches once)", () => {
  const { controller, events, rec } = makeController();
  controller.start();
  rec().fireStart();
  assert.equal(controller.stop(), true);
  rec().fireResult("hide tags", true);
  assert.deepEqual(events.filter(([k]) => k === "final"), [["final", "hide tags"]]);
  rec().fireEnd();
  assert.deepEqual(events.filter(([k]) => k === "state").pop(), ["state", "idle"]);
});

test("recognition: cancel discards the utterance and ignores late callbacks", () => {
  const { controller, events, rec } = makeController();
  controller.start();
  rec().fireStart();
  const lateResult = rec().onresult;
  const result = [{ transcript: "show tags" }];
  result.isFinal = true;
  controller.cancel();
  assert.equal(rec().aborted, true);
  lateResult({ resultIndex: 0, results: [result] });
  rec().fireResult("show tags", true); // handlers were detached
  assert.ok(!events.some(([k]) => k === "final"), "cancelled session must never dispatch");
});

test("recognition: stale callbacks from an obsolete session are ignored", () => {
  const { controller, events, rec } = makeController();
  controller.start();
  const old = rec();
  const oldResult = old.onresult;
  controller.cancel();
  controller.start();
  const result = [{ transcript: "show tags" }];
  result.isFinal = true;
  oldResult({ resultIndex: 0, results: [result] });
  assert.ok(!events.some(([k]) => k === "final"), "obsolete session must not dispatch into the new one");
  rec().fireStart();
  rec().fireResult("hide tags", true);
  assert.deepEqual(events.filter(([k]) => k === "final"), [["final", "hide tags"]]);
});

test("recognition: errors map to actionable messages and dispatch nothing", () => {
  const { controller, events, rec } = makeController();
  controller.start();
  rec().fireError("not-allowed");
  const err = events.find(([k]) => k === "error");
  assert.equal(err[1], "not-allowed");
  assert.match(err[2], /denied/i);
  assert.match(err[2], /Typed commands remain available/i);
  assert.ok(!events.some(([k]) => k === "final"));
  const second = makeController();
  second.controller.start();
  second.rec().fireError("audio-capture");
  assert.match(second.events.find(([k]) => k === "error")[2], /No microphone/i);
  const third = makeController();
  third.controller.start();
  third.rec().fireError("no-speech");
  assert.match(third.events.find(([k]) => k === "error")[2], /No speech/i);
});

test("recognition: unsupported API reports once and starts nothing", () => {
  const events = [];
  const controller = voice.createRecognitionController({
    window: {},
    handlers: { onError: (e) => events.push(e) },
  });
  assert.equal(controller.supported(), false);
  assert.equal(controller.start(), false);
  assert.equal(events.length, 1);
  assert.equal(events[0].code, "unsupported");
});

test("recognition: error closes the session — saved final/end callbacks after error emit nothing", () => {
  const { controller, events, rec } = makeController();
  controller.start();
  rec().fireStart();
  const savedResult = rec().onresult;
  const savedEnd = rec().onend;
  rec().fireError("network");
  const result = [{ transcript: "show tags" }];
  result.isFinal = true;
  savedResult({ resultIndex: 0, results: [result] }); // late final after error
  savedEnd(); // trailing end after error
  assert.ok(!events.some(([k]) => k === "final"), "a final delivered after an error must not dispatch");
  assert.ok(!events.some(([k, v]) => k === "state" && v === "idle"), "trailing onend must not erase the actionable error");
  assert.equal(controller.isActive(), false, "controls must see the session as terminated");
  const err = events.find(([k]) => k === "error");
  assert.match(err[2], /network error/i);
});

test("recognition: failed start closes the session — saved callbacks emit nothing", () => {
  class ThrowRecognition extends FakeRecognition {
    start() { throw new Error("denied at start"); }
  }
  FakeRecognition.instances = [];
  const events = [];
  const controller = voice.createRecognitionController({
    window: { SpeechRecognition: ThrowRecognition },
    handlers: {
      onState: (e) => events.push(["state", e.state]),
      onFinal: (e) => events.push(["final", e.text]),
      onError: (e) => events.push(["error", e.code]),
    },
  });
  assert.equal(controller.start(), false);
  const rec = FakeRecognition.instances[0];
  const savedResult = rec.onresult;
  const result = [{ transcript: "show tags" }];
  result.isFinal = true;
  savedResult({ resultIndex: 0, results: [result] });
  assert.ok(!events.some(([k]) => k === "final"));
  assert.deepEqual(events.filter(([k]) => k === "error"), [["error", "start-failed"]]);
  assert.equal(controller.isActive(), false);
});

test("recognition: normal end closes the session — saved callbacks after end emit nothing", () => {
  const { controller, events, rec } = makeController();
  controller.start();
  rec().fireStart();
  const savedResult = rec().onresult;
  rec().fireEnd();
  const result = [{ transcript: "show tags" }];
  result.isFinal = true;
  savedResult({ resultIndex: 0, results: [result] });
  assert.ok(!events.some(([k]) => k === "final"), "no dispatch after normal end without a new session");
});
