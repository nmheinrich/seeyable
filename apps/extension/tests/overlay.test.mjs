// Feature 7: visual overlay — identity, labels, lifecycle (DOM-level tests).
// These prove identity/label/lifecycle behavior, not visual layout.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { JSDOM } from "jsdom";

const require = createRequire(import.meta.url);
const { createSnapshotEngine } = require("../lib/snapshot-dom.js");
const { createOverlayController, buildTagLabel, displayName, chooseSpot, numberFromId } = require("../lib/overlay.js");

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

test("placement: crowded targets are omitted to the panel list, never piled; offscreen-x excluded", () => {
  const { doc, engine, overlay } = load(`<button type="button" id="b1">First action label here</button>
    <button type="button" id="b2">Second action label here</button>
    <button type="button" id="b3">Third action label here</button>
    <button type="button" id="b4">Fourth action label here</button>
    <label for="far">Far field</label><input id="far">`);
  // All four buttons share one target box: whitespace fits at most three.
  for (const id of ["b1", "b2", "b3", "b4"]) stubRect(doc.getElementById(id), 10, 30);
  const far = doc.getElementById("far");
  far.getBoundingClientRect = () => ({ x: 5000, y: 10, width: 120, height: 24, top: 10, bottom: 34, left: 5000, right: 5120 });
  far.scrollIntoView = () => {};
  const snap = engine.snapshot();
  assert.equal(snap.elements.length, 5);
  const shown = overlay.show(snap.elements);
  const state = overlay.getState();
  assert.ok(!state.badges.some((b) => b.text.includes("Far field")), "fully offscreen-x control must not create an edge badge");
  assert.ok(state.unplaced.length >= 1, "crowded-out targets are reported unplaced, not piled");
  assert.equal(state.badgeCount + state.unplaced.length, 4, "every in-view target is either floating or listed");
  assert.deepEqual(shown.unplaced.sort(), state.unplaced.sort(), "show() reports the same omitted ids");
  // Placed boxes must neither overlap each other nor cover their target.
  const boxes = state.badges.map((b) => ({ ...b, left: parseFloat(b.left), top: parseFloat(b.top) }));
  for (const b of boxes) assert.ok(b.width > 0 && b.height > 0);
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], c = boxes[j];
      const overlap = a.left < c.left + c.width && a.left + a.width > c.left && a.top < c.top + c.height && a.top + a.height > c.top;
      assert.ok(!overlap, `floating badges must not pile up (${a.id} vs ${c.id})`);
    }
    const coversTarget = boxes[i].left < 130 && boxes[i].left + boxes[i].width > 10 && boxes[i].top < 54 && boxes[i].top + boxes[i].height > 30;
    assert.ok(!coversTarget, `floating badge must not cover its own target (${boxes[i].id})`);
  }
  // Every floating tag keeps its word label plus the diagnostic number dot.
  for (const b of state.badges) assert.match(b.text, /[A-Za-z]/, "floating tags lead with words");
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

test("scroll region: targets fully outside their scroll container get no floating tag", () => {
  const { doc, engine, overlay } = load(`<div id="scroller" style="overflow-y: auto; height: 100px;">
    <div style="height: 300px;"></div>
    <label for="deep">Deep field</label><input id="deep">
    </div><label for="top">Top field</label><input id="top">`);
  const scroller = doc.getElementById("scroller");
  const deep = doc.getElementById("deep");
  const top = doc.getElementById("top");
  scroller.getBoundingClientRect = () => ({ x: 10, y: 10, width: 300, height: 100, top: 10, bottom: 110, left: 10, right: 310 });
  deep.getBoundingClientRect = () => ({ x: 10, y: 400, width: 120, height: 24, top: 400, bottom: 424, left: 10, right: 130 });
  deep.scrollIntoView = () => {};
  stubRect(top, 10, 500);
  const snap = engine.snapshot();
  overlay.show(snap.elements);
  const state = overlay.getState();
  assert.ok(state.badges.some((b) => b.text.includes("Top field")), "in-view target keeps its tag");
  assert.ok(!state.badges.some((b) => b.text.includes("Deep field")), "target scrolled out of its container must not float a tag");
  overlay.destroy();
});

test("badges keep stable identity with the number-dot structure", () => {
  const { doc, engine, overlay } = load(FORM);
  doc.querySelectorAll("input, button").forEach((el, i) => stubRect(el, 10, 10 + i * 40));
  const snap = engine.snapshot();
  overlay.show(snap.elements);
  const badges = overlay.getState().badges;
  assert.ok(badges.length >= 3);
  for (const b of badges) assert.match(b.id, /^el-\d+$/, "badge identity comes only from schema-v2 IDs");
  overlay.destroy();
});

test("protection: the highlighted target floats with full words when a safe spot exists", () => {
  const { doc, engine, overlay } = load(`<button type="button" id="b1">First action label here</button>
    <button type="button" id="b2">Second action label here and it keeps going past thirty two characters</button>
    <button type="button" id="b3">Third action label here</button>
    <button type="button" id="b4">Fourth action label here</button>`);
  for (const id of ["b1", "b2", "b3", "b4"]) stubRect(doc.getElementById(id), 10, 30);
  const snap = engine.snapshot();
  const second = snap.elements.find((e) => e.name.startsWith("Second action label"));
  assert.equal(overlay.highlightById(second.id, snap.documentSessionId, snap.revision, snap.documentSessionId).status, "ok");
  overlay.show(snap.elements);
  const state = overlay.getState();
  const kept = state.badges.find((b) => b.id === second.id);
  assert.ok(kept, "highlighted target always floats, even in a crowd");
  assert.ok(!state.unplaced.includes(second.id), "highlighted target is never omitted to the list");
  assert.match(kept.text, /past thirty two characters/, "highlighted target keeps its full readable label");
  assert.match(kept.text, new RegExp(second.id.replace("el-", "")), "number dot stays as a diagnostic");
  overlay.destroy();
});

test("integrated: refresh never places a badge over a neighbor's control box", () => {
  const { doc, engine, overlay } = load(`<button type="button" id="a">Neighbor above</button>
    <button type="button" id="b">Target below it</button>`);
  const a = doc.getElementById("a");
  const b = doc.getElementById("b");
  stubRect(a, 50, 100);
  stubRect(b, 50, 148);
  const snap = engine.snapshot();
  assert.equal(snap.elements.length, 2);
  const shown = overlay.show(snap.elements);
  const state = overlay.getState();
  // Both tags float (whitespace exists), but B's badge must not sit at
  // top=122 where it would cover A's box (the production x/y path).
  const placed = state.badges.map((bb) => ({ ...bb, left: parseFloat(bb.left), top: parseFloat(bb.top) }));
  assert.equal(placed.length, 2, `both targets find whitespace: ${JSON.stringify(placed)}`);
  for (const bb of placed) {
    const hitsNeighbor = bb.left < 170 && bb.left + bb.width > 50 && bb.top < 124 && bb.top + bb.height > 100;
    assert.ok(!hitsNeighbor, `badge for ${bb.id} must not cover the neighbor input box`);
  }
  assert.ok(!state.unplaced.includes("el-2"), "B is placed, just not over A");
  overlay.destroy();
});

test("integrated: rendered page text blocks placement; clear space still floats", () => {
  const { doc, engine, overlay } = load(`<label id="lab">Contact preferences</label>
    <button type="button" id="b">Target button</button>`);
  const lab = doc.getElementById("lab");
  const b = doc.getElementById("b");
  stubRect(b, 50, 100);
  const snap = engine.snapshot();
  // Sampled points over rendered text/a label -> occupied everywhere.
  doc.elementFromPoint = () => lab;
  overlay.show(snap.elements);
  let state = overlay.getState();
  assert.equal(state.badgeCount, 0, "text-occupied spots force omission to the panel list");
  assert.deepEqual(state.unplaced, [snap.elements[0].id]);
  // Nothing rendered at the sampled points -> the tag floats.
  doc.elementFromPoint = () => null;
  overlay.show(snap.elements);
  state = overlay.getState();
  assert.equal(state.badgeCount, 1, "clear space keeps the floating tag");
  assert.match(state.badgeTexts[0], /Target button/);
  overlay.destroy();
});

test("integrated: boxed-in highlighted target keeps its ring, not a forced badge", () => {
  const { doc, engine, overlay } = load(`<button type="button" id="t">Cornered target</button>
    <button type="button" id="below">Below blocker</button>
    <button type="button" id="right">Right blocker</button>`);
  const t = doc.getElementById("t");
  const below = doc.getElementById("below");
  const right = doc.getElementById("right");
  stubRect(t, 2, 2);
  stubRect(below, 2, 40);
  stubRect(right, 140, 2);
  const snap = engine.snapshot();
  const target = snap.elements.find((e) => e.name === "Cornered target");
  assert.equal(overlay.highlightById(target.id, snap.documentSessionId, snap.revision, snap.documentSessionId).status, "ok");
  overlay.show(snap.elements);
  const state = overlay.getState();
  assert.equal(state.ringVisible, true, "the outline still identifies the target");
  assert.ok(!state.badges.some((b) => b.id === target.id), "no full badge is forced into occupied space");
  assert.ok(state.unplaced.includes(target.id), "it falls back to the panel entry instead");
  overlay.destroy();
});

test("labels: display annotations stripped, short tags truncated at words, full kept", () => {
  assert.equal(displayName({ name: "Nickname (placeholder only)" }), "Nickname");
  assert.equal(displayName({ name: "Nickname (PLACEHOLDER ONLY)" }), "Nickname");
  assert.equal(displayName({ name: "Work email" }), "Work email");
  const long = { id: "el-5", role: "textbox", name: "A very long descriptive field name for notes", question: null, questionCertain: false };
  const short = buildTagLabel(long, [long], { short: true });
  assert.ok(short.text.length <= 32, `floating tag is short: ${short.text}`);
  assert.ok(short.text.endsWith("…"), "truncation marks the cut");
  assert.ok(!/\s…$/.test(short.text), "cut happens at a word boundary");
  const full = buildTagLabel(long, [long], { full: true });
  assert.equal(full.text, "A very long descriptive field name for notes");
  const annotated = { id: "el-6", role: "textbox", name: "Nickname (placeholder only)", question: null, questionCertain: false };
  assert.equal(buildTagLabel(annotated, [annotated], { short: true }).text, "Nickname");
  // Values never leak; duplicates keep question context with uncertainty.
  const dupes = [
    { id: "el-1", role: "radio", name: "1", question: "How was support?", questionCertain: true, state: { value: "secret-1" } },
    { id: "el-2", role: "radio", name: "1", question: "How was docs?", questionCertain: false, state: {} },
  ];
  const certain = buildTagLabel(dupes[0], dupes, { short: true });
  assert.equal(certain.text, "How was support? · 1");
  const uncertain = buildTagLabel(dupes[1], dupes, { short: true });
  assert.match(uncertain.text, / \? · /);
  assert.ok(!JSON.stringify([certain, uncertain]).includes("secret-1"));
});

test("chooseSpot: whitespace first, never covering, null when boxed in", () => {
  const size = { width: 100, height: 22 };
  const vp = { width: 1024, height: 768 };
  // Open space: above wins.
  assert.deepEqual(chooseSpot({ x: 50, y: 100, width: 120, height: 24 }, size, vp, []), { left: 50, top: 74, width: 100, height: 22 });
  // No room above: below.
  const below = chooseSpot({ x: 50, y: 10, width: 120, height: 24 }, size, vp, []);
  assert.equal(below.top, 38);
  // Above spot taken by a placed badge: below.
  const taken = chooseSpot({ x: 50, y: 100, width: 120, height: 24 }, size, vp, [{ left: 50, top: 74, width: 100, height: 22 }]);
  assert.equal(taken.top, 128);
  // Boxed in on every side: null (caller omits to the panel list).
  const wall = [
    { left: 50, top: 74, width: 100, height: 22 },   // above
    { left: 50, top: 128, width: 100, height: 22 },  // below
    { left: 174, top: 100, width: 100, height: 22 }, // right
  ];
  assert.equal(chooseSpot({ x: 50, y: 100, width: 120, height: 24 }, size, vp, wall), null);
  // A spot covering the target itself is rejected even with room around.
  const cover = chooseSpot({ x: 50, y: 100, width: 120, height: 24 }, { width: 200, height: 60 }, vp, []);
  assert.ok(cover === null || cover.top + cover.height <= 100 || cover.top >= 124, "badge must not cover its target");
  // A fitting spot that covers another control's box is rejected.
  const avoid = chooseSpot({ x: 50, y: 100, width: 120, height: 24 }, size, vp, [], [{ left: 50, top: 74, width: 100, height: 22 }]);
  assert.equal(avoid.top, 128, "above is blocked by the neighbor box; below fits");
  // Production passes getBoundingClientRect-style {x, y} rects; mixing the
  // shapes used to silently disable neighbor exclusion (regression).
  const avoidXy = chooseSpot({ x: 50, y: 100, width: 120, height: 24 }, { width: 100, height: 22 }, { width: 500, height: 500 }, [], [{ x: 50, y: 74, width: 100, height: 22 }]);
  assert.equal(avoidXy && avoidXy.top, 128, "{x, y} neighbor rects must block placement exactly like {left, top}");
  const covered = chooseSpot({ x: 50, y: 100, width: 120, height: 24 }, { width: 100, height: 22 }, { width: 500, height: 500 }, [], []);
  assert.deepEqual(covered, { left: 50, top: 74, width: 100, height: 22 }, "without neighbors the same spot is chosen");
});
