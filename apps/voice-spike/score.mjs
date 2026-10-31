#!/usr/bin/env node
"use strict";
/*
 * Issue #12 spike: score transcripts against corpus.json.
 *
 * Normalization (documented, applied to reference and hypothesis alike):
 * lowercase, strip punctuation except internal hyphens/apostrophes,
 * collapse whitespace. Word error rate = (S+D+I)/N over the reference.
 * Critical-token recall = fraction of the sentence's critical tokens
 * present in the hypothesis. No fuzzy matching, no rewriting.
 *
 * Usage: node score.mjs corpus.json results.jsonl
 * results.jsonl: one object per line with {file, transcript}; the file
 * basename must start with the sentence id (<id>-take<N>.wav or
 * <id>-<provider>-take<N>.json transcript field).
 */
import { readFileSync } from "node:fs";

const normalize = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9'\- ]/g, " ").replace(/\s+/g, " ").trim();
const words = (s) => { const t = normalize(s); return t ? t.split(" ") : []; };

function wer(ref, hyp) {
  const r = words(ref), h = words(hyp);
  const d = Array.from({ length: r.length + 1 }, (_, i) => [i, ...Array(h.length).fill(0)]);
  for (let j = 1; j <= h.length; j++) d[0][j] = j;
  for (let i = 1; i <= r.length; i++) for (let j = 1; j <= h.length; j++) {
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (r[i - 1] === h[j - 1] ? 0 : 1));
  }
  return { errors: d[r.length][h.length], n: r.length, wer: r.length ? d[r.length][h.length] / r.length : 0 };
}

const [corpusPath, resultsPath] = process.argv.slice(2);
if (!corpusPath || !resultsPath) { console.error("usage: node score.mjs corpus.json results.jsonl"); process.exit(1); }
const corpus = JSON.parse(readFileSync(corpusPath, "utf8"));
const refs = {};
for (const s of [...corpus.sentences, ...corpus.controls]) refs[s.id] = s;

const lines = readFileSync(resultsPath, "utf8").split("\n").filter((l) => l.trim());
const rows = [];
for (const line of lines) {
  const r = JSON.parse(line);
  const base = String(r.file || "").split("/").pop();
  const id = Object.keys(refs).find((k) => base.startsWith(k + "-") || base.startsWith(k + ".")) || r.id;
  const ref = refs[id];
  if (!ref) { console.error(`[score] skipping ${base}: no corpus entry`); continue; }
  const w = wer(ref.reference, r.transcript);
  const hypWords = new Set(words(r.transcript));
  const critHit = ref.critical.filter((t) => hypWords.has(normalize(t)));
  rows.push({ id, file: base, provider: r.provider || "?", ref: ref.reference, hyp: r.transcript || "",
    errors: w.errors, n: w.n, wer: +w.wer.toFixed(3),
    critical: `${critHit.length}/${ref.critical.length}`, missing: ref.critical.filter((t) => !hypWords.has(normalize(t))) });
}
for (const r of rows) console.log(`${r.id} [${r.provider}] WER=${r.wer} (${r.errors}/${r.n}) critical=${r.critical}${r.missing.length ? " MISSING:" + r.missing.join(",") : ""}\n  ref: ${r.ref}\n  hyp: ${r.hyp}`);
const tot = rows.reduce((a, r) => ({ e: a.e + r.errors, n: a.n + r.n }), { e: 0, n: 0 });
console.log(`\nTOTAL n=${rows.length} aggregate WER=${tot.n ? (tot.e / tot.n).toFixed(3) : "-"} (${tot.e}/${tot.n})`);
