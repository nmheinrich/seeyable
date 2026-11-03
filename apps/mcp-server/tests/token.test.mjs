"use strict";
/* Pairing-token publication under concurrent startup. Real processes,
 * real filesystem; a writer is paused deterministically right after it
 * creates its private temp file (before writing), the moment at which
 * a non-atomic design exposed an empty final token file. Tokens are
 * compared by SHA-256 so no secret is printed. */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveToken } from "../lib/hub-launch.mjs";

const LAUNCH = join(dirname(fileURLToPath(import.meta.url)), "../lib/hub-launch.mjs");
const sha = (t) => createHash("sha256").update(t).digest("hex");

// Child: resolve the token; with PAUSE=1, block synchronously for 400 ms
// right after the first exclusive ('wx') create.
const CHILD = `
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { createHash } from "node:crypto";
if (process.env.PAUSE === "1") {
  const open = fs.openSync;
  let paused = false;
  fs.openSync = function (...a) {
    const fd = open(...a);
    if (a[1] === "wx" && !paused) { paused = true; process.stdout.write("CREATED\\n"); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400); }
    return fd;
  };
  syncBuiltinESMExports();
}
const { resolveToken } = await import(${JSON.stringify(LAUNCH)});
const r = resolveToken({ port: 6123, env: { SEEYABLE_STATE_DIR: process.argv[1] } });
process.stdout.write(JSON.stringify({ source: r.source, sha: createHash("sha256").update(r.token).digest("hex") }) + "\\n");
`;

function runChild(dir, pause) {
  const child = spawn(process.execPath, ["--input-type=module", "-e", CHILD, dir], { env: { ...process.env, PAUSE: pause ? "1" : "0" }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let err = "";
  const created = new Promise((res) => child.stdout.on("data", (d) => { out += d; if (out.includes("CREATED")) res(); }));
  child.stderr.on("data", (d) => { err += d; });
  const done = new Promise((res) => child.once("close", (code) => {
    const line = out.split("\n").find((l) => l.startsWith("{"));
    res({ code, err, result: line ? JSON.parse(line) : null });
  }));
  return { created, done };
}

test("concurrent first start: a reader during the writer's unpublished window converges on one complete token", async () => {
  const dir = mkdtempSync(join(tmpdir(), "seeyable-token-"));
  const writer = runChild(dir, true);
  await writer.created; // writer has its temp file open, nothing written yet
  const reader = resolveToken({ port: 6123, env: { SEEYABLE_STATE_DIR: dir } }); // must not see a partial file
  assert.match(reader.token, /^[0-9a-f]{64}$/);
  const w = await writer.done;
  assert.equal(w.code, 0, w.err);
  assert.equal(w.result.sha, sha(reader.token), "both starters hold the same token");
  assert.notEqual(w.result.source === "generated", reader.source === "generated", "exactly one starter published");
  const later = await runChild(dir, false).done;
  assert.equal(later.result.source, "file");
  assert.equal(later.result.sha, sha(reader.token), "subsequent processes reuse it");
  const tokenPath = join(dir, "bridge-6123.token");
  assert.equal(statSync(tokenPath).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith(".tmp")), [], "no temp files left behind");
});

test("many simultaneous starters all converge on one token", async () => {
  const dir = mkdtempSync(join(tmpdir(), "seeyable-token-"));
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) => runChild(dir, i % 2 === 0).done));
  for (const r of results) assert.equal(r.code, 0, r.err);
  assert.equal(new Set(results.map((r) => r.result.sha)).size, 1);
  assert.equal(results.filter((r) => r.result.source === "generated").length, 1);
});

test("permanently invalid or unsafe token files are rejected clearly, never rewritten", () => {
  const dir = mkdtempSync(join(tmpdir(), "seeyable-token-"));
  const path = join(dir, "bridge-6123.token");
  writeFileSync(path, "", { mode: 0o600 });
  assert.throws(() => resolveToken({ port: 6123, env: { SEEYABLE_STATE_DIR: dir } }), /does not contain a valid pairing token; delete it to re-pair/);
  assert.equal(statSync(path).size, 0, "the invalid file is left for the operator, not replaced");
  writeFileSync(path, `${"a".repeat(64)}\n`);
  chmodSync(path, 0o644);
  assert.throws(() => resolveToken({ port: 6123, env: { SEEYABLE_STATE_DIR: dir } }), /readable by other users/);
  chmodSync(path, 0o600);
  assert.equal(resolveToken({ port: 6123, env: { SEEYABLE_STATE_DIR: dir } }).source, "file");
});
