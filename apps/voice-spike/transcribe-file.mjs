#!/usr/bin/env node
"use strict";
/*
 * Issue #12 spike: transcribe one WAV file with Muse Voice Transcribe
 * (recorded-audio endpoint). Server-side only: the key travels only from
 * the local environment to api.meta.ai over HTTPS. It is never printed,
 * never written to output, and never embedded in the extension.
 *
 * Usage: MODEL_API_KEY=$KEY node transcribe-file.mjs <clip.wav> [--mode PUSH_TO_TALK|ENDPOINTING] [--out results.jsonl]
 *
 * stdout: one JSON result object per run (appended to --out when given).
 * stderr: diagnostics and usage totals only.
 *
 * Latency measured here is FILE-PROCESSING latency
 * (request_start -> full_response_received) and must NOT be compared
 * directly with live speech-end-to-final latency. Label accordingly.
 */
import { readFileSync, appendFileSync, statSync } from "node:fs";

const MODEL = "muse-voice-transcribe-1.0";
const ENDPOINT = "https://api.meta.ai/v1/asr/transcribe";
const DEFAULT_TIMEOUT_MS = 300000; // bounded: the harness never hangs indefinitely

function fail(msg) { console.error(`[voice-spike] ${msg}`); process.exit(1); }

/**
 * Transcribe one clip. Exported for offline testing with a mocked fetch.
 * latencyMs_fileProcessing spans request start through FULL body receipt.
 */
export async function transcribeFile({ file, mode = "PUSH_TO_TALK", key, fetchImpl = fetch, endpoint = ENDPOINT, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  if (!["PUSH_TO_TALK", "ENDPOINTING", "DIARIZATION"].includes(mode)) throw new Error(`unknown mode ${mode}`);
  if (!key) throw new Error("MODEL_API_KEY is not set; refusing to run without credentials.");
  const bytes = statSync(file).size;
  if (bytes > 32 * 1024 * 1024) throw new Error("clip exceeds the 32 MB request limit.");
  const audio = readFileSync(file);

  const form = new FormData();
  form.append("request", new Blob([JSON.stringify({ model: MODEL, audioEncoding: "WAV", mode })], { type: "application/json" }));
  form.append("audio", new Blob([audio], { type: "audio/wav" }), "clip.wav");

  const tStart = performance.now();
  const res = await fetchImpl(endpoint, {
    method: "POST",
    headers: { Authorization: "Bearer " + key, Accept: "application/json" },
    body: form,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const bodyText = await res.text();
  const tDone = performance.now(); // after full body consumption, per the documented definition
  let body = null;
  try { body = JSON.parse(bodyText); } catch { /* keep raw on error paths */ }
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${bodyText.slice(0, 400)}`);

  const turns = Array.isArray(body.turns) ? body.turns : [];
  return {
    provider: "muse-voice-transcribe-1.0",
    endpoint: "POST /v1/asr/transcribe",
    mode,
    file,
    audioBytes: bytes,
    latencyMs_fileProcessing: Math.round(tDone - tStart),
    sessionId: body.sessionId || null,
    turns: turns.map((t) => ({ transcript: t.transcript, startMs: t.startMs ?? null, endMs: t.endMs ?? null })),
    transcript: turns.map((t) => t.transcript).join(" ").trim() || body.transcript || "",
  };
}

const invokedDirectly = process.argv[1] && import.meta.url === (await import("node:url")).pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith("--"));
  const modeFlag = args.indexOf("--mode");
  const mode = modeFlag === -1 ? "PUSH_TO_TALK" : args[modeFlag + 1];
  const outFlag = args.indexOf("--out");
  const outFile = outFlag === -1 ? null : args[outFlag + 1];
  if (!file) fail("usage: transcribe-file.mjs <clip.wav> [--mode MODE] [--out results.jsonl]");
  try {
    const result = await transcribeFile({ file, mode, key: process.env.MODEL_API_KEY });
    console.log(JSON.stringify(result));
    if (outFile) appendFileSync(outFile, JSON.stringify(result) + "\n");
    console.error(`[voice-spike] done in ${result.latencyMs_fileProcessing} ms (${result.audioBytes} audio bytes, file-processing latency)`);
  } catch (err) {
    fail(err.message || err);
  }
}
