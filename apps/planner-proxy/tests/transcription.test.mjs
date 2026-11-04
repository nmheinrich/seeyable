"use strict";
/* Issue #30 transcription route: pairing auth, fixed upstream contract,
 * WAV bounds, readiness state, safe errors, concurrency, and disconnect
 * abort. The Meta endpoint is a local stub; no real credentials or paid
 * requests are used. */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createProxy, LOOPBACK_HOST } from "../lib/proxy.mjs";
import { MAX_AUDIO_BYTES } from "../lib/transcription.mjs";

const ORIGIN = "chrome-extension://test";
const TOKEN = "pairing-token-for-tests";

function makeWav({ seconds = 0.5, sampleRate = 16000, channels = 1, bits = 16 } = {}) {
  const frames = Math.floor(seconds * sampleRate);
  const dataBytes = frames * channels * (bits / 8);
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * channels * (bits / 8), 28);
  buffer.writeUInt16LE(channels * (bits / 8), 32);
  buffer.writeUInt16LE(bits, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < frames; i += 1) buffer.writeInt16LE(8000, 44 + i * 2);
  return buffer;
}

async function startSpeechStub(steps) {
  const seen = [];
  let closedEarly = false;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("close", () => { if (!res.writableEnded) closedEarly = true; });
    req.on("end", () => {
      const step = steps[Math.min(seen.length, steps.length - 1)] || {};
      seen.push({ url: req.url, auth: req.headers.authorization || "", contentType: req.headers["content-type"] || "", body: Buffer.concat(chunks) });
      const answer = () => {
        if (res.destroyed) return;
        if (step.status) {
          res.writeHead(step.status, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: { message: "stub speech failure with private details" } }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(step.payload || { turns: [{ transcript: "fill Full name with Grace Hopper", startMs: 0, endMs: 400 }] }));
      };
      if (step.delayMs) setTimeout(answer, step.delayMs);
      else answer();
    });
  });
  await new Promise((resolve) => server.listen(0, LOOPBACK_HOST, resolve));
  return {
    server,
    port: server.address().port,
    seen,
    wasClosedEarly: () => closedEarly,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

async function startProxy({ stubPort, apiKey = "test-key-not-real", logs = [], speechUploadTimeoutMs } = {}) {
  const proxy = createProxy({
    port: 0,
    token: TOKEN,
    apiKey,
    baseUrl: `http://${LOOPBACK_HOST}:${stubPort}`,
    speechUploadTimeoutMs,
    log: (...args) => logs.push(args.join(" ")),
  });
  const { port } = await proxy.start();
  return { proxy, port, logs };
}

async function getStatus(port) {
  const res = await fetch(`http://${LOOPBACK_HOST}:${port}/v1/status`, {
    headers: { Authorization: `Bearer ${TOKEN}`, Origin: ORIGIN },
  });
  return { status: res.status, json: await res.json() };
}

async function postSpeech(port, { audio = makeWav(), language = "en", token = TOKEN, origin = ORIGIN, extraField = false } = {}) {
  const form = new FormData();
  form.append("request", new Blob([JSON.stringify(extraField ? { language, model: "caller-chosen" } : { language })], { type: "application/json" }));
  form.append("audio", new Blob([audio], { type: "audio/wav" }), "speech.wav");
  const headers = { Authorization: `Bearer ${token}` };
  if (origin) headers.Origin = origin;
  const res = await fetch(`http://${LOOPBACK_HOST}:${port}/v1/transcribe`, { method: "POST", headers, body: form });
  return { status: res.status, json: await res.json() };
}

test("speech: status distinguishes configuration from verified upstream access; valid WAV round trip is fixed-contract", async () => {
  const stub = await startSpeechStub([{}]);
  const logs = [];
  const { proxy, port } = await startProxy({ stubPort: stub.port, logs });
  try {
    const before = await getStatus(port);
    assert.equal(before.json.speech.configured, true);
    assert.equal(before.json.speech.state, "unknown");
    assert.equal(before.json.speech.upstreamVerified, false, "a present key is not verified speech access");

    const out = await postSpeech(port, { language: "en-US" });
    assert.equal(out.status, 200);
    assert.equal(out.json.ok, true);
    assert.equal(out.json.transcript, "fill Full name with Grace Hopper");
    assert.equal(out.json.provider, "meta");
    assert.equal(stub.seen.length, 1);
    assert.equal(stub.seen[0].url, "/asr/transcribe");
    assert.equal(stub.seen[0].auth, "Bearer " + "test-key-not-real");
    const upstreamText = stub.seen[0].body.toString("utf8");
    assert.match(upstreamText, /muse-voice-transcribe-1\.0/);
    assert.match(upstreamText, /PUSH_TO_TALK/);
    assert.match(upstreamText, /English/);
    assert.match(upstreamText, /show tags/);
    assert.doesNotMatch(upstreamText, /approve plan|Approve this action/i, "no approval phrase is used as a vocabulary hint");

    const after = await getStatus(port);
    assert.equal(after.json.speech.state, "verified");
    assert.equal(after.json.speech.upstreamVerified, true);
    assert.ok(!logs.join("\n").includes("Grace Hopper"), "transcripts are never logged");
    assert.ok(!logs.join("\n").includes("test-key-not-real"), "keys are never logged");
    assert.ok(!JSON.stringify(out.json).includes("test-key-not-real"));
  } finally {
    await proxy.close();
    await stub.close();
  }
});

test("speech: pairing/origin/missing-key boundaries fail before upstream", async () => {
  const stub = await startSpeechStub([{}]);
  const { proxy, port } = await startProxy({ stubPort: stub.port });
  try {
    assert.equal((await postSpeech(port, { token: "wrong" })).status, 401);
    assert.equal((await postSpeech(port, { origin: "https://evil.test" })).json.error.code, "FORBIDDEN");
    assert.equal(stub.seen.length, 0);
  } finally {
    await proxy.close();
  }

  const noKey = await startProxy({ stubPort: stub.port, apiKey: "" });
  try {
    const status = await getStatus(noKey.port);
    assert.equal(status.json.speech.configured, false);
    assert.equal(status.json.speech.state, "unconfigured");
    const out = await postSpeech(noKey.port);
    assert.equal(out.status, 503);
    assert.equal(out.json.error.code, "SPEECH_NOT_CONFIGURED");
    assert.equal(stub.seen.length, 0);
  } finally {
    await noKey.proxy.close();
    await stub.close();
  }
});

test("speech: rejected upstream access is safe, numeric, and remembered as rejected", async () => {
  const stub = await startSpeechStub([{ status: 403 }]);
  const { proxy, port, logs } = await startProxy({ stubPort: stub.port });
  try {
    const out = await postSpeech(port);
    assert.equal(out.json.ok, false);
    assert.equal(out.json.error.code, "SPEECH_FORBIDDEN");
    assert.equal(out.json.error.status, 403);
    assert.ok(!JSON.stringify(out.json).includes("private details"));
    assert.ok(!logs.join("\n").includes("private details"));
    const status = await getStatus(port);
    assert.equal(status.json.speech.state, "rejected");
    assert.equal(status.json.speech.upstreamVerified, false);
  } finally {
    await proxy.close();
    await stub.close();
  }
});

test("speech: malformed, caller-steered, and oversized audio never reach upstream", async () => {
  const stub = await startSpeechStub([{}]);
  const { proxy, port } = await startProxy({ stubPort: stub.port });
  try {
    const malformed = await postSpeech(port, { audio: Buffer.from("not a wav") });
    assert.equal(malformed.status, 422);
    assert.equal(malformed.json.error.code, "AUDIO_INVALID");

    const steered = await postSpeech(port, { extraField: true });
    assert.equal(steered.status, 400);
    assert.equal(steered.json.error.code, "BAD_REQUEST");

    const oversized = await postSpeech(port, { audio: Buffer.alloc(MAX_AUDIO_BYTES + 1) });
    assert.equal(oversized.status, 413);
    assert.equal(oversized.json.error.code, "AUDIO_TOO_LARGE");
    assert.equal(stub.seen.length, 0);
  } finally {
    await proxy.close();
    await stub.close();
  }
});

function multipartBody(boundary = "admission-boundary") {
  return Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="request"\r\n\r\n{"language":"en"}\r\n--${boundary}\r\nContent-Disposition: form-data; name="audio"; filename="speech.wav"\r\nContent-Type: audio/wav\r\n\r\n`),
    makeWav(),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
}

function rawSpeech(port, body, boundary = "admission-boundary") {
  let done;
  const result = new Promise((resolve) => { done = resolve; });
  const req = http.request({
    host: LOOPBACK_HOST, port, path: "/v1/transcribe", method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`, Origin: ORIGIN,
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
      "Content-Length": body.length,
    },
  }, (res) => { res.resume(); res.on("end", () => done(res.statusCode)); });
  req.on("error", () => done(0));
  return { req, result };
}

test("speech admission: two deferred partial uploads reach at most one upstream; failed and stalled uploads release", async () => {
  const stub = await startSpeechStub([{ delayMs: 200 }, {}]);
  const { proxy, port } = await startProxy({ stubPort: stub.port, speechUploadTimeoutMs: 80 });
  try {
    const body = multipartBody();
    const a = rawSpeech(port, body);
    a.req.write(body.subarray(0, 40)); // headers + partial body: admission must already be reserved
    const b = rawSpeech(port, body);
    b.req.write(body.subarray(0, 40));
    await new Promise((r) => setTimeout(r, 30));
    a.req.end(body.subarray(40));
    await new Promise((r) => setTimeout(r, 30));
    b.req.end(body.subarray(40));
    const statuses = (await Promise.all([a.result, b.result])).sort((x, y) => x - y);
    assert.deepEqual(statuses, [200, 409], "one success and one immediate busy rejection, no queue");
    assert.equal(stub.seen.length, 1, "at most one upstream transcription call");

    // A failed (malformed) upload releases admission for the next request.
    const malformed = await postSpeech(port, { audio: Buffer.from("not a wav") });
    assert.equal(malformed.status, 422);
    const afterFailure = await postSpeech(port);
    assert.equal(afterFailure.status, 200, "failed uploads do not hold admission");
    assert.equal(stub.seen.length, 2);

    // A stalled partial upload is bounded and releases admission.
    const stalled = rawSpeech(port, body);
    stalled.req.write(body.subarray(0, 40));
    await new Promise((r) => setTimeout(r, 140)); // > 80 ms upload bound
    const afterStall = await postSpeech(port);
    assert.equal(afterStall.status, 200, "stalled uploads cannot hold the service indefinitely");
    stalled.req.destroy();
    await stalled.result;
  } finally {
    await proxy.close();
    await stub.close();
  }
});

test("speech: one transcription at a time; client disconnect aborts upstream work", async () => {
  const stub = await startSpeechStub([{ delayMs: 250 }, { delayMs: 250 }]);
  const { proxy, port } = await startProxy({ stubPort: stub.port });
  try {
    const first = postSpeech(port);
    const second = await postSpeech(port);
    assert.equal(second.status, 409);
    assert.equal(second.json.error.code, "SPEECH_BUSY");
    assert.equal((await first).status, 200);
    assert.equal(stub.seen.length, 1, "the busy request never reached upstream");
  } finally {
    await proxy.close();
    await stub.close();
  }

  const slowStub = await startSpeechStub([{ delayMs: 1000 }]);
  const slow = await startProxy({ stubPort: slowStub.port });
  try {
    const form = new FormData();
    form.append("request", new Blob([JSON.stringify({ language: "en" })], { type: "application/json" }));
    form.append("audio", new Blob([makeWav()], { type: "audio/wav" }), "speech.wav");
    const controller = new AbortController();
    const pending = fetch(`http://${LOOPBACK_HOST}:${slow.port}/v1/transcribe`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, Origin: ORIGIN },
      body: form,
      signal: controller.signal,
    }).catch((err) => err);
    while (!slowStub.seen.length) await new Promise((r) => setTimeout(r, 10));
    controller.abort();
    const settled = await pending;
    assert.equal(settled.name, "AbortError");
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(slowStub.wasClosedEarly(), true, "proxy aborted its upstream request when the browser left");
  } finally {
    await slow.proxy.close();
    await slowStub.close();
  }
});
