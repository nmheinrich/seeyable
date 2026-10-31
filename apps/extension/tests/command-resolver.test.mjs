"use strict";
/* Issue #13: local command parser + matcher unit tests. No DOM, no
 * network, no executor: pure resolution behavior only. */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const R = require("../lib/command-resolver.js");

function el(id, name, extra = {}) {
  return { id, name, role: "button", state: {}, question: null, questionCertain: false, ...extra };
}

test("parse: click and fill shapes with verbatim values", () => {
  assert.deepEqual(R.parseLocalCommand("click Full name"), { kind: "click", target: "Full name", normalizedTarget: "full name" });
  assert.deepEqual(R.parseLocalCommand("  CLICK the Submit survey. "), { kind: "click", target: "the Submit survey", normalizedTarget: "submit survey" });
  const fill = R.parseLocalCommand("fill Short bio with Ada Lovelace, Esq.!");
  assert.equal(fill.kind, "fill");
  assert.equal(fill.target, "Short bio");
  assert.equal(fill.value, "Ada Lovelace, Esq.!");
  // First "with" splits; later ones belong to the value.
  assert.equal(R.parseLocalCommand("fill bio with tea with friends").value, "tea with friends");
});

test("parse: rejects compounds, negation, and incomplete shapes", () => {
  for (const text of ["click Continue and submit", "click Save then submit", "click A, click B", "click A & B"]) {
    const p = R.parseLocalCommand(text);
    assert.equal(p.kind, "unknown", text);
    assert.match(p.reason, /compound/);
  }
  for (const text of ["don't click Save", "never fill bio with x", "do not click Save"]) {
    const p = R.parseLocalCommand(text);
    assert.equal(p.kind, "unknown", text);
  }
  assert.equal(R.parseLocalCommand("click").kind, "unknown");
  assert.equal(R.parseLocalCommand("fill bio").reason, 'fill needs "with <value>"');
  assert.equal(R.parseLocalCommand("fill bio with").reason, 'no value after "with"');
  assert.equal(R.parseLocalCommand("fill bio with ").reason, 'no value after "with"');
  assert.equal(R.parseLocalCommand("tap Save").kind, "unknown", "verbs are not fuzzy-matched");
  assert.equal(R.parseLocalCommand("please click Save").kind, "unknown");
  assert.equal(R.parseLocalCommand("").kind, "empty");
  // Structure markers inside the VALUE are literal text, not commands.
  const v = R.parseLocalCommand("fill bio with fish and chips, not salad");
  assert.equal(v.kind, "fill");
  assert.equal(v.value, "fish and chips, not salad");
});

test("match: exact names win; question context disambiguates repeats", () => {
  const elements = [
    el("el-1", "Full name"),
    el("el-2", "1", { question: "Rate this demo", questionCertain: true, role: "radio" }),
    el("el-3", "1", { question: "Rate support", questionCertain: true, role: "radio" }),
  ];
  const exact = R.matchTarget(elements, "Full name");
  assert.equal(exact.status, "match");
  assert.equal(exact.element.id, "el-1");
  const scoped = R.matchTarget(elements, "rate this demo 1");
  assert.equal(scoped.status, "match");
  assert.equal(scoped.element.id, "el-2");
});

test("match: clear fuzzy accepts, weak rejects, close rivals clarify", () => {
  const elements = [el("el-1", "Full name"), el("el-2", "Work email"), el("el-3", "Nickname")];
  const fuzzy = R.matchTarget(elements, "ful name");
  assert.equal(fuzzy.status, "match");
  assert.equal(fuzzy.element.id, "el-1");
  assert.ok(fuzzy.score >= R.ACCEPT_THRESHOLD);
  const weak = R.matchTarget(elements, "banana phone");
  assert.equal(weak.status, "none");
  const rivals = R.matchTarget([el("el-1", "Email updates"), el("el-2", "Email digest")], "email");
  assert.equal(rivals.status, "ambiguous");
  assert.deepEqual(rivals.candidates.map((c) => c.elementId).sort(), ["el-1", "el-2"]);
});

test("match: duplicate Continue controls with distinct context clarify", () => {
  const elements = [
    el("el-10", "Continue", { question: "Shipping address", questionCertain: true }),
    el("el-11", "Continue", { question: "Payment method", questionCertain: true }),
  ];
  const both = R.matchTarget(elements, "Continue");
  assert.equal(both.status, "ambiguous");
  assert.deepEqual(both.candidates.map((c) => c.elementId), ["el-10", "el-11"]);
  assert.match(both.candidates[0].label, /Shipping address/);
  assert.match(both.candidates[1].label, /Payment method/);
  const one = R.matchTarget(elements, "payment method continue");
  assert.equal(one.status, "match");
  assert.equal(one.element.id, "el-11");
});

test("match: five exact matches clarify with all five — never truncated", () => {
  const elements = ["1", "2", "3", "4", "5"].map((n, i) =>
    el(`el-${i + 1}`, n, { question: "How satisfied are you?", questionCertain: true, role: "radio" }));
  const m = R.matchTarget(elements, "How satisfied are you");
  assert.equal(m.status, "ambiguous");
  assert.deepEqual(m.candidates.map((c) => c.elementId), ["el-1", "el-2", "el-3", "el-4", "el-5"]);
  assert.ok(m.candidates.every((c) => c.score === 1), "every exact match scores 1");
  assert.match(m.candidates[4].label, /5 — How satisfied are you\?/, "words and context lead");
  assert.match(m.candidates[4].label, /\(#5\)$/, "the internal number is secondary");
});

test("match: in-band fuzzy rivals are all listed, not capped", () => {
  const elements = ["Status report", "Status reports", "Status report Q1", "Status report Q2"].map((n, i) => el(`el-${i + 1}`, n));
  const m = R.matchTarget(elements, "status report");
  assert.equal(m.status, "ambiguous");
  assert.equal(m.candidates.length, 4, "the whole band stays reachable");
});

test("match: disabled exact matches are returned, never redirected", () => {
  const elements = [
    el("el-1", "Save draft", { state: { disabled: true } }),
    el("el-2", "Save draft copy"),
  ];
  const m = R.matchTarget(elements, "Save draft");
  assert.equal(m.status, "match");
  assert.equal(m.element.id, "el-1", "the disabled exact match stands; the executor rejects it honestly");
});

test("match: numeric targets address el-N unless the number is also a name", () => {
  const elements = [el("el-1", "Full name"), el("el-2", "Work email")];
  assert.equal(R.matchTarget(elements, "2").element.id, "el-2");
  assert.equal(R.matchTarget(elements, "9").status, "none");
  const withName = [...elements, el("el-3", "2", { question: "Stars", questionCertain: true, role: "radio" })];
  const clash = R.matchTarget(withName, "2");
  assert.equal(clash.status, "ambiguous");
  assert.deepEqual(clash.candidates.map((c) => c.elementId).sort(), ["el-2", "el-3"]);
});

test("match: candidates come only from the snapshot; scores are documented numbers", () => {
  const m = R.matchTarget([], "anything");
  assert.equal(m.status, "none");
  assert.equal(R.ACCEPT_THRESHOLD, 0.75);
  assert.equal(R.MIN_SEPARATION, 0.1);
});
