// Feature: production snapshot engine (schema v2).
// Run from apps/extension: npm test   (jsdom is a devDependency)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const require = createRequire(import.meta.url);
const engineModule = require("../lib/snapshot-dom.js");
const { createSnapshotEngine, normalizeElements, semanticHash, diffNormalized } = engineModule;
const here = dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function load(html, url = "https://example.test/form") {
  const dom = new JSDOM(html, { url });
  const engine = createSnapshotEngine(dom.window.document, dom.window, { debounceMs: 0 });
  return { dom, engine, doc: dom.window.document };
}
function loadFile(path) {
  return load(readFileSync(path, "utf8"));
}
const byName = (snap, name) => snap.elements.find((e) => e.name === name);

/* Test A — original 20-control fixture, no regression */
test("A: original fixture yields 20 controls with roles, names, context", () => {
  const { engine } = loadFile(join(here, "../../demo-survey/index.html"));
  const snap = engine.snapshot();
  assert.equal(snap.schemaVersion, 2);
  assert.equal(snap.elementCount, 20);
  assert.equal(byName(snap, "Full name").role, "textbox");
  assert.equal(byName(snap, "Submit survey").role, "button");
  assert.equal(byName(snap, "Submit survey").actionable, true);
  assert.match(byName(snap, "Full name").context, /About you/);
  assert.ok(snap.structure.headings.some((h) => h.text === "Extras"));
  assert.equal(byName(snap, "Unavailable action").actionable, false);
  assert.equal(byName(snap, "Unavailable action").actionableReason, "disabled");
  const pin = byName(snap, "Account PIN");
  assert.equal(pin.state.redacted, true);
  assert.equal(pin.state.filled, true);
  assert.ok(!JSON.stringify(snap).includes("1234"), "fixture PIN value must not appear");
});

/* Test B/H — duplicate labels disambiguated by question (synthetic forms fixture) */
test("B: repeated rating labels are distinguished by question context", () => {
  const { engine } = loadFile(join(here, "fixtures/rating-form.html"));
  const snap = engine.snapshot();
  const ones = snap.elements.filter((e) => e.name === "1");
  assert.ok(ones.length >= 3, `expected repeated "1" options, got ${ones.length}`);
  const questions = new Set(ones.map((e) => e.question));
  assert.ok(questions.has("How was support?"));
  assert.ok(questions.has("How was documentation?"));
  // Raw names are preserved, not fabricated.
  assert.ok(ones.every((e) => e.name === "1"));
  const support = ones.find((e) => e.question === "How was support?");
  assert.equal(support.questionSource, "fieldset-legend");
  assert.equal(support.questionCertain, true);
  const docs = ones.find((e) => e.question === "How was documentation?");
  assert.equal(docs.questionCertain, true);
});

test("H(synthetic): forms-style heading container associates rating options with their question", () => {
  const { engine } = loadFile(join(here, "fixtures/rating-form.html"));
  const snap = engine.snapshot();
  const nps = snap.elements.filter((e) => e.question === "How likely are you to recommend us?");
  assert.equal(nps.length, 2);
  // Proximity inference must be flagged as uncertain, never presented as certain.
  assert.ok(nps.every((e) => e.questionCertain === false));
});

/* Test C — stable IDs, replacement safety */
test("C: IDs stay stable when unrelated controls are added; replaced controls get new IDs", () => {
  const { engine, doc } = load(`<form><label for="a">Alpha</label><input id="a">
    <label for="b">Beta</label><input id="b"></form>`);
  const first = engine.snapshot();
  const alphaId = byName(first, "Alpha").id;
  const betaId = byName(first, "Beta").id;

  const extra = doc.createElement("div");
  extra.innerHTML = `<label for="c">Gamma</label><input id="c">`;
  doc.querySelector("form").append(extra);
  const second = engine.snapshot();
  assert.equal(byName(second, "Alpha").id, alphaId, "unrelated addition must not renumber Alpha");
  assert.equal(byName(second, "Beta").id, betaId);
  const gammaId = byName(second, "Gamma").id;
  assert.ok(![alphaId, betaId].includes(gammaId));

  // Replace Beta with an identical-looking new node: old ID must go stale.
  const old = doc.getElementById("b");
  const replacement = doc.createElement("input");
  replacement.id = "b";
  old.replaceWith(replacement);
  assert.equal(engine.resolve(betaId).status, "stale");
  assert.equal(engine.resolve(betaId).reason, "detached-or-replaced");
  const third = engine.snapshot();
  assert.notEqual(byName(third, "Beta").id, betaId, "replacement must receive a new ID");
  assert.equal(engine.resolve(byName(third, "Beta").id).status, "ok");
  assert.equal(engine.resolve(alphaId).status, "ok");
});

/* Test D — mutations, stale rejection, semantic delta */
test("D: label/state changes are detected; removed controls resolve stale", async () => {
  const { engine, doc } = load(`<form><fieldset><legend>Pick one</legend>
    <label><input type="checkbox" id="x"> First option</label></fieldset>
    <label for="y">Why</label><input id="y"></form>`);
  engine.startObserving();
  const snap = engine.snapshot();
  const box = snap.elements.find((e) => e.role === "checkbox");
  assert.equal(box.state.checked, false);

  doc.getElementById("x").checked = true; // live property change, no attribute mutation
  doc.querySelector("label").lastChild.textContent = " First choice";
  const check = engine.checkForChanges();
  assert.equal(check.changed, true);
  assert.ok(check.delta.updated.some((u) => u.id === box.id && u.changedFields.includes("state")));
  assert.equal(engine.resolve(box.id, snap.revision).status, "stale", "old revision must be rejected");

  const resnap = engine.snapshot();
  const updated = resnap.elements.find((e) => e.id === box.id);
  assert.equal(updated.state.checked, true);
  assert.equal(updated.name, "First choice");
  assert.ok(resnap.revision > snap.revision, "revision must increase monotonically");

  doc.getElementById("y").remove();
  assert.equal(engine.checkForChanges().changed, true);
  assert.equal(engine.resolve(byName(snap, "Why").id).status, "stale");
  engine.stopObserving();
});

test("D2: MutationObserver invalidates asynchronously without a manual check", async () => {
  const { engine, doc } = load(`<label for="a">Alpha</label><input id="a">`);
  engine.startObserving();
  const snap = engine.snapshot();
  const extra = doc.createElement("input");
  extra.setAttribute("aria-label", "Late field");
  doc.body.append(extra);
  await sleep(40); // MutationObserver batch + debounced semantic check
  const status = engine.getStatus();
  assert.equal(status.fresh, false, "meaningful addition must invalidate the snapshot");
  assert.ok(status.revision > snap.revision);
  assert.ok(status.lastDelta.added.length >= 1);
  // Change detected but no full snapshot taken: status reports the delta,
  // and old references are rejected as stale rather than silently reused.
  assert.equal(engine.resolve(snap.elements[0].id, snap.revision).status, "stale");
  engine.stopObserving();
});

test("semantic: cosmetic mutations do not change hash, revision, or delta", async () => {
  const { engine, doc } = load(`<div id="wrap"><label for="a">Alpha</label><input id="a"><p>Decorative</p></div>`);
  const snap = engine.snapshot();
  doc.getElementById("wrap").style.color = "red";
  const note = doc.createElement("span");
  note.textContent = "unrelated decoration";
  doc.getElementById("wrap").append(note);
  const check = engine.checkForChanges();
  assert.equal(check.changed, false);
  assert.equal(engine.getStatus().revision, snap.revision);
  assert.equal(engine.getStatus().fresh, true);
  await sleep(10);
});

test("semantic: normalize/hash/diff are deterministic and exclude geometry", () => {
  const base = [{ id: "el-1", role: "textbox", name: "Alpha", question: "Q?", state: { required: true }, rect: { x: 0, y: 0, width: 10, height: 10 }, cssPath: "input#a", capturedAt: "t0" }];
  const moved = [{ ...base[0], rect: { x: 99, y: 99, width: 1, height: 1 }, cssPath: "div > input" }];
  assert.equal(semanticHash(normalizeElements(base)), semanticHash(normalizeElements(moved)), "rect/cssPath must not affect the hash");
  const changed = [{ ...base[0], name: "Beta" }];
  assert.notEqual(semanticHash(normalizeElements(base)), semanticHash(normalizeElements(changed)));
  const delta = diffNormalized(normalizeElements(base), normalizeElements(changed));
  assert.deepEqual(delta, { added: [], removed: [], updated: [{ id: "el-1", changedFields: ["name"] }] });
});

/* Test E — sensitive fields (synthetic values only) */
test("E: protected fields never expose raw values; filled is distinguishable", () => {
  const { engine } = load(`<form>
    <label for="pw">Password</label><input id="pw" type="password" value="Synthetic!234">
    <label for="cc">Card number</label><input id="cc" autocomplete="cc-number" value="4242424242424242">
    <label for="ssn">Social Security number</label><input id="ssn" name="ssn" value="000-00-1234">
    <label for="empty">PIN</label><input id="empty" type="password" value="">
    <label for="plain">Nickname</label><input id="plain" value="buddy"></form>`);
  const snap = engine.snapshot();
  const json = JSON.stringify(snap);
  for (const secret of ["Synthetic!234", "4242424242424242", "000-00-1234"]) {
    assert.ok(!json.includes(secret), `snapshot leaked ${secret}`);
  }
  assert.equal(byName(snap, "Password").state.filled, true);
  assert.equal(byName(snap, "Card number").state.redacted, true);
  assert.equal(byName(snap, "Social Security number").state.redacted, true);
  assert.equal(byName(snap, "PIN").state.filled, false, "empty protected field must read as not filled");
  assert.equal(byName(snap, "Nickname").state.value, "buddy", "non-sensitive values still captured");
});

/* Test F — visibility, offscreen, disabled, readonly, custom ARIA widgets */
test("F: hidden excluded with diagnostics; offscreen kept; custom widgets included", () => {
  const { engine, doc } = load(`<form>
    <label for="vis">Visible field</label><input id="vis">
    <div style="display:none"><label for="hid">Hidden field</label><input id="hid"></div>
    <label for="ro">Readonly field</label><input id="ro" readonly value="fixed">
    <button type="button" disabled>Disabled action</button>
    <div role="checkbox" aria-checked="true" tabindex="0" aria-label="Custom toggle"></div>
    <span role="button" tabindex="0">Custom button</span></form>`);
  // Simulate a below-the-fold control in a laid-out browser.
  const vis = doc.getElementById("vis");
  vis.getBoundingClientRect = () => ({ x: 0, y: 5000, width: 100, height: 20, top: 5000, bottom: 5020, left: 0, right: 100 });
  const snap = engine.snapshot();
  assert.ok(!byName(snap, "Hidden field"), "display:none control must be excluded");
  assert.ok(snap.diagnostics.excludedHidden >= 1);
  const visible = byName(snap, "Visible field");
  assert.ok(visible, "offscreen control must remain discoverable");
  assert.equal(visible.inViewport, false);
  assert.equal(byName(snap, "Readonly field").actionable, false);
  assert.equal(byName(snap, "Readonly field").actionableReason, "readonly");
  assert.equal(byName(snap, "Disabled action").actionable, false);
  const toggle = byName(snap, "Custom toggle");
  assert.equal(toggle.role, "checkbox");
  assert.equal(toggle.state.checked, true);
  assert.ok(byName(snap, "Custom button"));
});

/* Follow-up: viewport geometry regression */
test("viewport: onscreen rectangles are inViewport, below-fold are not", () => {
  const { engine, doc } = load(`<label for="on">Onscreen</label><input id="on">
    <label for="off">Offscreen</label><input id="off">`);
  doc.getElementById("on").getBoundingClientRect = () => ({ x: 10, y: 100, width: 120, height: 24 });
  doc.getElementById("off").getBoundingClientRect = () => ({ x: 10, y: 5000, width: 120, height: 24 });
  const snap = engine.snapshot();
  assert.equal(byName(snap, "Onscreen").inViewport, true, "onscreen rect must be in the viewport");
  assert.equal(byName(snap, "Offscreen").inViewport, false);
  assert.ok(byName(snap, "Offscreen"), "offscreen control remains discoverable");
});

/* Follow-up: form-wide actions get no fabricated question */
test("form actions: Submit/Clear keep names and form context but no question", () => {
  const { engine } = load(`<form aria-label="Feedback form">
    <fieldset><legend>How old are you?</legend>
    <label><input type="radio" name="age" value="a"> Under 18</label></fieldset>
    <button type="submit">Submit</button>
    <button type="button">Clear form</button></form>`);
  const snap = engine.snapshot();
  for (const name of ["Submit", "Clear form"]) {
    const el = byName(snap, name);
    assert.ok(el, `${name} must remain in the snapshot`);
    assert.equal(el.question, null, `${name} must not inherit the last question`);
    assert.equal(el.questionCertain, false);
    assert.match(el.context, /Feedback form/, `${name} keeps form-level context`);
    assert.ok(!el.context.includes("How old are you?"), `${name} context must not cite the last question`);
  }
  // The actual question control is unaffected.
  assert.equal(byName(snap, "Under 18").question, "How old are you?");
});

/* Regression: a fieldset legend must not leak onto unrelated following controls */
test("question scope: rating legend stays inside its fieldset; following controls get no question", () => {
  const { engine } = loadFile(join(here, "fixtures/executor-form.html"));
  const snap = engine.snapshot();
  // The five rating radios keep their certain fieldset association.
  const radios = snap.elements.filter((e) => e.role === "radio");
  assert.equal(radios.length, 5);
  for (const r of radios) {
    assert.equal(r.question, "How satisfied are you?");
    assert.equal(r.questionSource, "fieldset-legend");
    assert.equal(r.questionCertain, true);
  }
  // Unrelated controls after the fieldset inherit nothing — in the
  // question fields or in the context text.
  for (const name of ["Password", "Card number", "Deep field", "ARIA updates", "ARIA notifications", "Disabled field", "Readonly field"]) {
    const el = byName(snap, name);
    assert.ok(el, `${name} must remain in the snapshot`);
    assert.equal(el.question, null, `${name} must not inherit the rating question`);
    assert.equal(el.questionSource, null, `${name} must not cite the leaked source`);
    assert.equal(el.questionCertain, false);
    assert.ok(!el.context.includes("How satisfied are you?"), `${name} context must not cite the rating question`);
  }
  // Redaction and names are unaffected by the scoping change.
  assert.equal(byName(snap, "Password").state.redacted, true);
  assert.equal(byName(snap, "Card number").state.redacted, true);
});

test("question scope: heading inside an ARIA group scopes to that group; section inference survives", () => {
  const { engine } = load(`<form aria-label="Scoped form">
    <div role="group"><h3>Grouped prompt</h3>
      <label for="grouped">Grouped field</label><input id="grouped"></div>
    <label for="after">After group</label><input id="after">
    <section><h2>Section prompt</h2>
      <label for="insection">Section field</label><input id="insection"></section>
    </form>`);
  const snap = engine.snapshot();
  assert.equal(byName(snap, "Grouped field").question, "Grouped prompt");
  const after = byName(snap, "After group");
  assert.equal(after.question, null, "a group heading must not leak to controls outside the group");
  assert.ok(!after.context.includes("Grouped prompt"));
  assert.equal(byName(snap, "Section field").question, "Section prompt", "legitimate section-heading inference is preserved");
});

/* Follow-up: non-interactive roles are never targets */
test("roles: role=img and other non-interactive roles are excluded even with name/tabindex", () => {
  const { engine } = load(`<div role="img" aria-label="Company logo" tabindex="0"></div>
    <h2 role="heading" tabindex="0">Section title</h2>
    <label for="real">Real field</label><input id="real">
    <button type="button">Real action</button>`);
  const snap = engine.snapshot();
  assert.ok(!byName(snap, "Company logo"), "role=img must not be an actionable target");
  assert.ok(!snap.elements.some((e) => e.role === "img" && e.actionable));
  assert.ok(byName(snap, "Real field"));
  assert.ok(byName(snap, "Real action"));
});
