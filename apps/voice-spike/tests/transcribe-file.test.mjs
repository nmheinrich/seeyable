"use strict";
/* Issue #12: OFFLINE, FULLY MOCKED tests for the file client.
 * No network, no credentials, no provider contact. Synthetic only:
 * these prove harness mechanics (latency definition, timeout, key
 * hygiene), not transcription quality. */
import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { transcribeFile } from "../transcribe-file.mjs";

const fixture = () => {
  const f = join(mkdtempSync(join(tmpdir(), "voice-spike-")), "clip.wav");
  writeFileSync(f, Buffer.alloc(64, 0));
  return f;
};

test("latency includes full body consumption (mocked delayed body)", async () => {
  const delayed = new Response(JSON.stringify({ turns: [{ transcript: "hello world" }], sessionId: "s1" }));
  const origText = delayed.text.bind(delayed);
  delayed.text = async () => { await new Promise((r) => setTimeout(r, 300)); return origText(); };
  const result = await transcribeFile({ file: fixture(), key: "test-key", fetchImpl: async () => delayed });
  assert.ok(result.latencyMs_fileProcessing >= 300, `body delay must be included, got ${result.latencyMs_fileProcessing} ms`);
  assert.equal(result.transcript, "hello world");
  assert.ok(!JSON.stringify(result).includes("test-key"), "key must never appear in output");
});

test("request aborts on timeout instead of hanging", async () => {
  const hanging = { ok: true, status: 200, text: async () => { await new Promise(() => {}); } };
  await assert.rejects(
    transcribeFile({ file: fixture(), key: "k", timeoutMs: 50, fetchImpl: async (url, opts) => {
      // Honor the abort signal like a real fetch would.
      await new Promise((_, rej) => opts.signal.addEventListener("abort", () => rej(new Error("aborted"))));
      return hanging;
    } }),
    /abort/i,
  );
});

test("missing key and bad mode fail before any fetch", async () => {
  let calls = 0;
  await assert.rejects(transcribeFile({ file: fixture(), key: "", fetchImpl: async () => { calls++; } }), /MODEL_API_KEY/);
  await assert.rejects(transcribeFile({ file: fixture(), key: "k", mode: "NOPE", fetchImpl: async () => { calls++; } }), /unknown mode/);
  assert.equal(calls, 0);
});
