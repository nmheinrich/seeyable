// Feature 7: visual overlay — identity, labels, lifecycle (DOM-level tests).
// These prove identity/label/lifecycle behavior, not visual layout.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { JSDOM } from "jsdom";

const require = createRequire(import.meta.url);
const { createSnapshotEngine } = require("../lib/snapshot-dom.js");
const { createOverlayController, buildTagLabel, numberFromId } = require("../lib/overlay.js");

function load(html) {
  const dom = new JSDOM(html, { url: "https://example.test/form", pretendToBeVisual: true });
  const doc = dom.window.document;
  const engine = createSnapshotEngine(doc, dom.window, { debounceMs: 0 });
  const overlay = createOverlayController({
    document: doc, window: dom.window, mutationDebounceMs: 10,
    resolveNode: (id, revision) => engine.resolveNode(id, revision),
  });
  return { dom, doc, engine, overlay };
}
function stubRect(el, x = 10, y = 10) {
  el.getBoundingClientRect = () => ({ x, y, width: 120, height: 24, top: y, bottom: y + 24, left: x, right: x + 120 });
  el.scrollIntoView = function (opts) { this.__scrollOpts = opts; };
}
const FORM = `<form aria-label="Feedback">
  <fieldset><legend>How was support?</legend>
  <label><input type="radio" name="s" value="1"> 1</label>
  <label><input type="radio" name="s" value="2"> 2</label></fieldset>
  <label for="n">Full name</label><input id="n">
  <button type="submit">Submit</button></form>`;

test("labels: metadata-only, question for repeated/numeric, uncertain marked, no values", () => {
  const all = [
    { id: "el-1", role: "radio", name: "1", question: "How was support?", questionCertain: true, state: { value: "secret-1" } },
    { id: "el-2", role: "radio", name: "1", question: "How was docs?", questionCertain: false, state: {} },
    { id: "el-3", role: "textbox", name: "Full name", question: null, questionCertain: false, state: { value: "Ada" } },
  ];
  const certain = buildTagLabel(all[0], all);
  assert.equal(certain.text, "How was support? · 1");
  assert.equal(certain.number, "1");
  const uncertain = buildTagLabel(all[1], all);
  assert.match(uncertain.text, /\?/, "uncertain question must be marked");
  assert.equal(uncertain.uncertain, true);
  const plain = buildTagLabel(all[2], all);
  assert.equal(plain.text, "Full name");
  assert.ok(!JSON.stringify([certain, uncertain, plain]).includes("secret-1"));
  assert.ok(!JSON.stringify([certain, uncertain, plain]).includes("Ada"), "field values must never appear in labels");
  assert.equal(buildTagLabel({ id: "el-7", role: "button", name: "" }, []).text, "button 7");
  assert.equal(numberFromId("el-22"), "22");
  assert.equal(numberFromId("xyz"), null);
});

test("numbers: stable across refresh and unrelated additions; badges follow IDs", () => {
  const { doc, engine, overlay } = load(FORM);
  doc.querySelectorAll("input, button").forEach((el, i) => stubRect(el, 10, 10 + i * 30));
  const first = engine.snapshot();
  overlay.show(first.elements);
  const before = overlay.getState().badgeTexts;
  assert.ok(before.length >= 3);

  const extra = doc.createElement("input");
  extra.setAttribute("aria-label", "Late field");
  stubRect(extra, 10, 300);
  doc.querySelector("form").append(extra);
  const second = engine.snapshot();
  // Existing IDs (and therefore displayed numbers) are unchanged.
  for (const el of first.elements) {
    const again = second.elements.find((e) => e.name === el.name && e.role === el.role);
    assert.equal(again.id, el.id);
    assert.equal(numberFromId(again.id), numberFromId(el.id));
  }
  overlay.show(second.elements);
  const after = overlay.getState().badgeTexts;
  for (const text of before) assert.ok(after.includes(text), `badge lost across refresh: ${text}`);
  overlay.destroy();
});

test("rejection: replaced, removed, unknown, and wrong-session targets", () => {
  const { doc, engine, overlay } = load(FORM);
  const snap = engine.snapshot();
  const radio = snap.elements.find((e) => e.role === "radio");
  stubRect(doc.querySelector("input[type=radio]"));

  assert.equal(overlay.highlightById("el-999", snap.documentSessionId, snap.revision, snap.documentSessionId).status, "unknown");
  assert.equal(overlay.highlightById(radio.id, "doc-other", snap.revision, snap.documentSessionId).status, "wrong-session");

  const node = doc.querySelector("input[type=radio]");
  const replacement = doc.createElement("input");
  replacement.type = "radio"; replacement.name = "s"; replacement.value = "1";
  node.replaceWith(replacement);
  const stale = overlay.highlightById(radio.id, snap.documentSessionId, snap.revision, snap.documentSessionId);
  assert.equal(stale.status, "stale", "replaced node must not inherit the old number");

  const nameEl = snap.elements.find((e) => e.name === "Full name");
  doc.getElementById("n").remove();
  assert.equal(overlay.highlightById(nameEl.id, snap.documentSessionId, snap.revision, snap.documentSessionId).status, "stale");
  overlay.destroy();
});

test("lifecycle: show/hide, highlight while hidden, destroy cleans up", () => {
  const { doc, engine, overlay } = load(FORM);
  doc.querySelectorAll("input, button").forEach((el, i) => stubRect(el, 10, 10 + i * 30));
  const snap = engine.snapshot();
  overlay.show(snap.elements);
  assert.ok(overlay.getState().badgeCount >= 3);
  assert.equal(overlay.getState().tagsVisible, true);

  overlay.hide();
  assert.equal(overlay.getState().badgeCount, 0);
  const target = snap.elements.find((e) => e.name === "Full name");
  const node = doc.getElementById("n");
  const result = overlay.highlightById(target.id, snap.documentSessionId, snap.revision, snap.documentSessionId);
  assert.equal(result.status, "ok", "highlight must work while tags are hidden");
  assert.equal(overlay.getState().ringVisible, true);
  assert.equal(node.__scrollOpts.block, "center");

  overlay.destroy();
  assert.equal(overlay.getState().hostPresent, false);
  assert.equal(doc.querySelector("[data-seeyable-overlay]"), null);
});

test("reduced motion: highlight scrolls instantly, not smoothly", () => {
  const { dom, doc, engine, overlay } = load(FORM);
  dom.window.matchMedia = () => ({ matches: true });
  const snap = engine.snapshot();
  const target = snap.elements.find((e) => e.name === "Full name");
  const node = doc.getElementById("n");
  stubRect(node);
  const result = overlay.highlightById(target.id, snap.documentSessionId, snap.revision, snap.documentSessionId);
  assert.equal(result.status, "ok");
  assert.equal(node.__scrollOpts.behavior, "auto");
  overlay.destroy();
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("labels update: re-show after rename refreshes badge text, number preserved", () => {
  const { doc, engine, overlay } = load(`<button type="button" id="b">Before</button>`);
  const btn = doc.getElementById("b");
  stubRect(btn);
  const first = engine.snapshot();
  overlay.show(first.elements);
  assert.match(overlay.getState().badgeTexts.join(" "), /Before/);
  const idBefore = first.elements[0].id;

  btn.textContent = "After";
  const second = engine.snapshot();
  assert.equal(second.elements[0].id, idBefore, "same DOM node keeps its ID");
  overlay.show(second.elements);
  const texts = overlay.getState().badgeTexts.join(" ");
  assert.match(texts, /After/);
  assert.ok(!texts.includes("Before"), "stale badge text must be replaced");
  overlay.destroy();
});

test("mutation refresh: removing highlighted target clears tag and ring without scrolling", async () => {
  const { doc, engine, overlay } = load(FORM);
  doc.querySelectorAll("input, button").forEach((el, i) => stubRect(el, 10, 10 + i * 30));
  engine.startObserving();
  const snap = engine.snapshot();
  overlay.show(snap.elements);
  const radio = snap.elements.find((e) => e.role === "radio");
  assert.equal(overlay.highlightById(radio.id, snap.documentSessionId, snap.revision, snap.documentSessionId).status, "ok");
  assert.equal(overlay.getState().ringVisible, true);

  doc.querySelector("input[type=radio]").remove();
  await sleep(90); // overlay mutation debounce + engine invalidation, no scroll event
  const state = overlay.getState();
  assert.equal(state.ringVisible, false, "ring must disappear when its target is removed");
  assert.ok(!state.badges.some((b) => b.id === radio.id), "removed target must lose its tag");
  overlay.destroy();
  engine.stopObserving();
});

test("placement: tightly spaced badges fall back to compact number-only; offscreen-x excluded", () => {
  const { doc, engine, overlay } = load(`<button type="button" id="b1">First long action label</button>
    <button type="button" id="b2">Second long action label</button>
    <label for="far">Far field</label><input id="far">`);
  stubRect(doc.getElementById("b1"), 10, 30);
  stubRect(doc.getElementById("b2"), 10, 44);
  const far = doc.getElementById("far");
  far.getBoundingClientRect = () => ({ x: 5000, y: 10, width: 120, height: 24, top: 10, bottom: 34, left: 5000, right: 5120 });
  far.scrollIntoView = () => {};
  const snap = engine.snapshot();
  overlay.show(snap.elements);
  const state = overlay.getState();
  assert.ok(!state.badges.some((b) => b.text.includes("Far field")), "fully offscreen-x control must not create an edge badge");
  const compact = state.badges.filter((b) => b.compact);
  assert.ok(compact.length >= 1, "overlapping badge must fall back to compact number-only");
  assert.match(compact[0].text, /^\d+$/, "compact badge shows only the number");
  overlay.destroy();
});

test("exclusion: overlay never enters snapshots or semantic invalidation", () => {
  const { doc, engine, overlay } = load(FORM);
  doc.querySelectorAll("input, button").forEach((el, i) => stubRect(el, 10, 10 + i * 30));
  engine.startObserving();
  const first = engine.snapshot();
  overlay.show(first.elements);
  const second = engine.snapshot();
  assert.equal(second.elementCount, first.elementCount);
  assert.equal(second.semanticHash, first.semanticHash, "badges must not alter semantic content");
  assert.equal(engine.checkForChanges().changed, false);
  overlay.destroy();
  engine.stopObserving();
});
