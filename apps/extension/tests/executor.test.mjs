// Feature 8: executor actions through the single entry point.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const require = createRequire(import.meta.url);
const snap = require("../lib/snapshot-dom.js");
const { createExecutor } = require("../lib/executor.js");
const here = dirname(fileURLToPath(import.meta.url));

function loadFixture() {
  const html = readFileSync(join(here, "fixtures/executor-form.html"), "utf8");
  const dom = new JSDOM(html, { url: "https://example.test/executor", runScripts: "dangerously", pretendToBeVisual: true });
  const engine = snap.createSnapshotEngine(dom.window.document, dom.window, { debounceMs: 0 });
  const executor = createExecutor({
    engine,
    internals: { normalizeElements: snap.normalizeElements, diffNormalized: snap.diffNormalized, sensitiveInfo: snap.sensitiveInfo, isVisible: snap.isVisible, computeAccessibleName: snap.computeAccessibleName },
    settleMs: 0,
  });
  return { dom, doc: dom.window.document, win: dom.window, engine, executor };
}
function load(html) {
  const dom = new JSDOM(html, { url: "https://example.test/", runScripts: "dangerously", pretendToBeVisual: true });
  const engine = snap.createSnapshotEngine(dom.window.document, dom.window, { debounceMs: 0 });
  const executor = createExecutor({
    engine,
    internals: { normalizeElements: snap.normalizeElements, diffNormalized: snap.diffNormalized, sensitiveInfo: snap.sensitiveInfo, isVisible: snap.isVisible, computeAccessibleName: snap.computeAccessibleName },
    settleMs: 0,
  });
  return { dom, doc: dom.window.document, win: dom.window, engine, executor };
}
async function act(ctx, name, action, value) {
  const s = ctx.engine.snapshot();
  const el = s.elements.find((e) => e.name === name);
  assert.ok(el, `control named ${name} must exist`);
  return ctx.executor.execute({ action, elementId: el.id, documentSessionId: s.documentSessionId, revision: s.revision, value });
}
const code = (res) => res.error && res.error.code;

test("fill: native setter + events update controlled input; clearing works", async () => {
  const ctx = loadFixture();
  const res = await act(ctx, "Controlled name", "fill", "Synthetic Person");
  assert.equal(res.ok, true, JSON.stringify(res.error));
  assert.equal(res.result.verified, true);
  assert.equal(ctx.doc.getElementById("controlled").value, "Synthetic Person");
  assert.equal(ctx.doc.getElementById("controlled-output").textContent, "Synthetic Person", "page listener must observe the fill");
  assert.ok(ctx.win.__flags.controlledInputs >= 1);
  const cleared = await act(ctx, "Controlled name", "fill", "");
  assert.equal(cleared.ok, true);
  assert.equal(ctx.doc.getElementById("controlled").value, "");
});

test("fill/select: textarea and exact-value select; missing/disabled options rejected", async () => {
  const ctx = loadFixture();
  assert.equal((await act(ctx, "Essay", "fill", "Long synthetic text")).ok, true);
  assert.equal(ctx.doc.getElementById("essay").value, "Long synthetic text");
  const sel = await act(ctx, "Role", "select", "engineer");
  assert.equal(sel.ok, true, JSON.stringify(sel.error));
  assert.equal(ctx.doc.getElementById("role-select").value, "engineer");
  assert.equal(code(await act(ctx, "Role", "select", "Engin")), "OPTION_NOT_FOUND", "partial label/value must not be guessed");
  assert.equal(code(await act(ctx, "Role", "select", "legacy")), "OPTION_DISABLED");
  assert.equal(code(await act(ctx, "Plain text", "select", "x")), "INCOMPATIBLE_TARGET");
  assert.equal(code(await act(ctx, "Add follow-up details", "fill", "x")), "INCOMPATIBLE_TARGET");
});

test("check/uncheck: idempotent checkbox, radio group, radio uncheck rejected, ARIA toggle verified", async () => {
  const ctx = loadFixture();
  const radios = () => [...ctx.doc.querySelectorAll("input[name=sat]")].map((r) => r.checked);
  let res = await act(ctx, "3", "check");
  // Name "3" is shared; act() picks the first match — find the Likert one by state change instead:
  void res;
  const s = ctx.engine.snapshot();
  const likert3 = s.elements.find((e) => e.role === "radio" && e.name === "3" && e.question === "How satisfied are you?");
  assert.ok(likert3);
  res = await ctx.executor.execute({ action: "check", elementId: likert3.id, documentSessionId: s.documentSessionId, revision: s.revision });
  assert.equal(res.ok, true, JSON.stringify(res.error));
  assert.deepEqual(radios(), [false, false, true, false, false]);
  const again = await ctx.executor.execute({ action: "check", elementId: likert3.id, documentSessionId: res.documentSessionId, revision: res.revision });
  assert.equal(again.ok, true);
  // Radio uncheck is explicitly unsupported (checked via a fresh request).
  const s2 = ctx.engine.snapshot();
  const l3 = s2.elements.find((e) => e.id === likert3.id);
  const un = await ctx.executor.execute({ action: "uncheck", elementId: l3.id, documentSessionId: s2.documentSessionId, revision: s2.revision });
  assert.equal(code(un), "UNSUPPORTED_RADIO_UNCHECK");
  assert.deepEqual(radios(), [false, false, true, false, false], "group state must be preserved");

  const aria = await act(ctx, "ARIA updates", "check");
  assert.equal(aria.ok, true, JSON.stringify(aria.error));
  assert.equal(ctx.doc.getElementById("aria-check").getAttribute("aria-checked"), "true");
  const ariaOff = await act(ctx, "ARIA updates", "uncheck");
  assert.equal(ariaOff.ok, true);
  assert.equal(ctx.doc.getElementById("aria-check").getAttribute("aria-checked"), "false");
});

test("click: harmless button activates exactly once; conditional follow-up appears as added diff", async () => {
  const ctx = loadFixture();
  const res = await act(ctx, "Increment counter", "click");
  assert.equal(res.ok, true, JSON.stringify(res.error));
  assert.equal(res.result.dispatched, true);
  assert.equal(ctx.win.__flags.harmlessClicks, 1, "one request must activate exactly once");

  const cond = await act(ctx, "Add follow-up details", "check");
  assert.equal(cond.ok, true, JSON.stringify(cond.error));
  assert.equal(ctx.doc.getElementById("followup-wrap").hidden, false);
  const post = ctx.engine.snapshot();
  const follow = post.elements.find((e) => e.name === "Follow-up details");
  assert.ok(follow, "revealed control must be snapshot-visible");
  assert.ok(cond.newSnapshotDiff.added.includes(follow.id), `diff must add the new control: ${JSON.stringify(cond.newSnapshotDiff)}`);
});

test("validation: wrong/missing session+revision, unknown ID, changed page, replacement", async () => {
  const ctx = loadFixture();
  const s = ctx.engine.snapshot();
  const plain = s.elements.find((e) => e.name === "Plain text");
  const base = { action: "fill", elementId: plain.id, documentSessionId: s.documentSessionId, revision: s.revision, value: "x" };
  assert.equal(code(await ctx.executor.execute({ ...base, documentSessionId: "doc-nope" })), "WRONG_SESSION");
  assert.equal(code(await ctx.executor.execute({ ...base, documentSessionId: undefined })), "INVALID_REQUEST");
  assert.equal(code(await ctx.executor.execute({ ...base, revision: undefined })), "INVALID_REQUEST");
  assert.equal(code(await ctx.executor.execute({ ...base, revision: s.revision + 9 })), "STALE_REVISION");
  assert.equal(code(await ctx.executor.execute({ ...base, elementId: "el-999" })), "UNKNOWN_ID");
  assert.equal(code(await ctx.executor.execute({ ...base, action: "explode" })), "UNKNOWN_ACTION");

  // Page change after the snapshot, before any observer debounce: rejected synchronously.
  const extra = ctx.doc.createElement("input");
  extra.setAttribute("aria-label", "Sneaky field");
  ctx.doc.querySelector("form").append(extra);
  const stale = await ctx.executor.execute(base);
  assert.ok(["STALE_SNAPSHOT", "STALE_REVISION", "STALE_TARGET"].includes(code(stale)), `expected stale rejection, got ${code(stale)}`);
  assert.equal(ctx.doc.getElementById("plain").value, "", "stale request must not write");

  // Replacement with an identical-looking node: old ID must not resolve.
  const ctx2 = loadFixture();
  const s2 = ctx2.engine.snapshot();
  const p2 = s2.elements.find((e) => e.name === "Plain text");
  const old = ctx2.doc.getElementById("plain");
  const repl = ctx2.doc.createElement("input");
  repl.id = "plain"; repl.type = "text";
  old.replaceWith(repl);
  const rep = await ctx2.executor.execute({ action: "fill", elementId: p2.id, documentSessionId: s2.documentSessionId, revision: s2.revision, value: "x" });
  assert.equal(rep.ok, false);
  assert.equal(repl.value, "", "replacement must not be written through the old ID");
});

test("safety: consequential controls blocked for every caller; handlers never run", async () => {
  const ctx = loadFixture();
  for (const name of ["Submit feedback", "Delete draft", "Pay now"]) {
    const res = await act(ctx, name, "click");
    assert.equal(code(res), "CONSEQUENTIAL_BLOCKED", `${name} must be blocked`);
  }
  assert.deepEqual(
    { submit: ctx.win.__flags.submitRan, del: ctx.win.__flags.deleteRan, pay: ctx.win.__flags.payRan },
    { submit: false, del: false, pay: false }
  );
  // fill must not become an alternate activation path, and read/scroll stay available.
  assert.equal(code(await act(ctx, "Submit feedback", "fill", "x")), "INCOMPATIBLE_TARGET");
});

test("sensitive: writes blocked and protected values absent from all returned data", async () => {
  const ctx = loadFixture();
  assert.equal(code(await act(ctx, "Password", "fill", "NewSecret!9")), "SENSITIVE_FIELD");
  assert.equal(code(await act(ctx, "Card number", "fill", "5555555555554444")), "SENSITIVE_FIELD");
  const read = await act(ctx, "Password", "read");
  assert.equal(read.ok, true, JSON.stringify(read.error));
  assert.equal(read.result.element.state.redacted, true);
  const scroll = await act(ctx, "Deep field", "scroll_to");
  assert.equal(scroll.ok, true, JSON.stringify(scroll.error));
  const everything = JSON.stringify([read, scroll, await act(ctx, "Plain text", "fill", "hello")]);
  assert.ok(!everything.includes("SyntheticPass!1"), "password value leaked");
  assert.ok(!everything.includes("4242424242424242"), "card value leaked");
  assert.ok(!everything.includes("NewSecret!9"), "rejected fill value echoed");
});

function makeCtx(html, { settleMs = 40, engineDebounceMs = 250 } = {}) {
  const dom = new JSDOM(html, { url: "https://example.test/wait", runScripts: "dangerously", pretendToBeVisual: true });
  const engine = snap.createSnapshotEngine(dom.window.document, dom.window, { debounceMs: engineDebounceMs });
  engine.startObserving();
  const executor = createExecutor({
    engine,
    internals: { normalizeElements: snap.normalizeElements, diffNormalized: snap.diffNormalized, sensitiveInfo: snap.sensitiveInfo, isVisible: snap.isVisible, computeAccessibleName: snap.computeAccessibleName },
    settleMs,
  });
  return { dom, doc: dom.window.document, win: dom.window, engine, executor };
}
async function actCtx(ctx, name, action, value) {
  const s = ctx.engine.snapshot();
  const el = s.elements.find((e) => e.name === name);
  assert.ok(el, `control ${name}`);
  const promise = ctx.executor.execute({ action, elementId: el.id, documentSessionId: s.documentSessionId, revision: s.revision, value });
  return { promise, el, snap: s };
}

test("revalidation: rename to a consequential label during the scroll wait blocks the click", async () => {
  const ctx = makeCtx(`<button type="button" id="b">Continue</button>`);
  let clicks = 0;
  ctx.doc.getElementById("b").addEventListener("click", () => { clicks += 1; });
  const { promise } = await actCtx(ctx, "Continue", "click");
  ctx.doc.getElementById("b").textContent = "Delete draft"; // during the wait, before observer debounce (250ms) elapses
  const res = await promise;
  assert.equal(res.ok, false);
  assert.ok(["STALE_SNAPSHOT", "CONSEQUENTIAL_BLOCKED"].includes(code(res)), `got ${code(res)}`);
  assert.equal(clicks, 0, "renamed consequential control must never be clicked");
  ctx.engine.stopObserving();
});

test("revalidation: input made readonly during the scroll wait is not written", async () => {
  const ctx = makeCtx(`<label for="i">Field</label><input id="i" type="text">`);
  const { promise } = await actCtx(ctx, "Field", "fill", "nope");
  ctx.doc.getElementById("i").setAttribute("readonly", "");
  const res = await promise;
  assert.equal(res.ok, false);
  assert.equal(ctx.doc.getElementById("i").value, "");
  ctx.engine.stopObserving();
});

test("form association: default/explicit submit buttons block regardless of label or placement", async () => {
  const cases = [
    `<form id="f"></form><button form="f" id="b">Continue</button>`,
    `<form id="f"></form><button form="f" id="b" type="submit">Continue</button>`,
    `<form id="f"><button id="b">Continue</button></form>`,
  ];
  for (const html of cases) {
    const ctx = makeCtx(html);
    let clicks = 0;
    ctx.doc.getElementById("b").addEventListener("click", () => { clicks += 1; });
    const { promise } = await actCtx(ctx, "Continue", "click");
    const res = await promise;
    assert.equal(code(res), "CONSEQUENTIAL_BLOCKED", html);
    assert.equal(clicks, 0, html);
    ctx.engine.stopObserving();
  }
  // A non-submit button outside any form with a neutral label still works.
  const okCtx = makeCtx(`<button type="button" id="b">Continue</button>`);
  let okClicks = 0;
  okCtx.doc.getElementById("b").addEventListener("click", () => { okClicks += 1; });
  const { promise } = await actCtx(okCtx, "Continue", "click");
  assert.equal((await promise).ok, true);
  assert.equal(okClicks, 1);
  okCtx.engine.stopObserving();
});

test("final verification: page reset after fill fails honestly and preserves the diff", async () => {
  const ctx = makeCtx(`<label for="i">Resettable</label><input id="i" type="text">
    <script>document.getElementById('i').addEventListener('input', () => setTimeout(() => { document.getElementById('i').value = 'Page reset'; }, 5));</script>`, { settleMs: 60 });
  const { promise } = await actCtx(ctx, "Resettable", "fill", "Requested");
  const res = await promise;
  assert.equal(res.ok, false);
  assert.equal(code(res), "ACTION_NOT_VERIFIED");
  assert.ok(res.newSnapshotDiff, "a failed outcome after dispatch must preserve the diff");
  assert.ok(res.newSnapshotDiff.updated.length >= 1, "the page reset is a real change, not 'nothing changed'");
  assert.equal(ctx.doc.getElementById("i").value, "Page reset");
  ctx.engine.stopObserving();
});

test("final verification: delayed ARIA state settles to verified; disappearing click target is not verified", async () => {
  const ctx = makeCtx(`<div id="a" role="checkbox" aria-checked="false" tabindex="0">Delayed toggle</div>
    <button type="button" id="gone">Vanish</button>
    <script>
      document.getElementById('a').addEventListener('click', () => setTimeout(() => document.getElementById('a').setAttribute('aria-checked', 'true'), 10));
      document.getElementById('gone').addEventListener('click', (e) => e.target.remove());
    </script>`, { settleMs: 60 });
  const aria = await (await actCtx(ctx, "Delayed toggle", "check")).promise;
  assert.equal(aria.ok, true, JSON.stringify(aria.error));
  assert.equal(aria.result.verified, true);

  const gone = await (await actCtx(ctx, "Vanish", "click")).promise;
  assert.equal(gone.ok, true);
  assert.equal(gone.result.dispatched, true);
  assert.equal(gone.result.verified, false, "a disappeared target must not be reported as verified completion");
  ctx.engine.stopObserving();
});

test("baseline: no snapshot or invalidated snapshot cannot authorize an action", async () => {
  const fresh = makeCtx(`<label for="i">Field</label><input id="i" type="text">`);
  const noBase = await fresh.executor.execute({ action: "fill", elementId: "el-1", documentSessionId: fresh.engine.sessionId, revision: 0, value: "x" });
  assert.equal(code(noBase), "SNAPSHOT_BASELINE_REQUIRED");
  assert.equal(fresh.doc.getElementById("i").value, "", "baseline-less request must not write");
  fresh.engine.stopObserving();

  const ctx = makeCtx(`<label for="i">Field</label><input id="i" type="text">`);
  const s = ctx.engine.snapshot();
  const el = s.elements.find((e) => e.name === "Field");
  ctx.engine.invalidate("test invalidation");
  const status = ctx.engine.getStatus();
  assert.equal(status.fresh, false);
  const inv = await ctx.executor.execute({ action: "fill", elementId: el.id, documentSessionId: s.documentSessionId, revision: status.revision, value: "x" });
  assert.equal(code(inv), "STALE_SNAPSHOT", "invalidated snapshot must not be silently refreshed into validity");
  assert.equal(ctx.doc.getElementById("i").value, "");
  ctx.engine.stopObserving();
});

test("effective disabled: fieldset-disabled controls and optgroup options are protected; legend exception works", async () => {
  const ctx = makeCtx(`<form>
    <fieldset disabled>
      <legend><label>Legend field <input id="leg" type="text"></label></legend>
      <label for="inner">Inner field</label><input id="inner" type="text">
    </fieldset>
    <label for="s">Choice</label>
    <select id="s"><optgroup label="Old" disabled><option value="x">X</option></optgroup><option value="y">Y</option></select>
  </form>`);
  const inner = await (await actCtx(ctx, "Inner field", "fill", "nope")).promise;
  assert.equal(code(inner), "TARGET_DISABLED");
  assert.equal(ctx.doc.getElementById("inner").value, "");

  const legend = await (await actCtx(ctx, "Legend field", "fill", "works")).promise;
  assert.equal(legend.ok, true, JSON.stringify(legend.error));
  assert.equal(ctx.doc.getElementById("leg").value, "works", "first-legend exception must remain usable");

  const blocked = await (await actCtx(ctx, "Choice", "select", "x")).promise;
  assert.equal(code(blocked), "OPTION_DISABLED");
  assert.notEqual(ctx.doc.getElementById("s").value, "x", "optgroup-disabled option must not be selected");
  const allowed = await (await actCtx(ctx, "Choice", "select", "y")).promise;
  assert.equal(allowed.ok, true, JSON.stringify(allowed.error));
  assert.equal(ctx.doc.getElementById("s").value, "y");
  ctx.engine.stopObserving();
});

test("final verification: already-checked state lost during settling fails without retry", async () => {
  const ctx = makeCtx(`<label><input id="c" type="checkbox" checked> Keep me</label>`, { settleMs: 50 });
  const { promise } = await actCtx(ctx, "Keep me", "check");
  setTimeout(() => { ctx.doc.getElementById("c").checked = false; }, 65); // page changes it during post-action settling (after the 50ms pre-dispatch wait)
  const res = await promise;
  assert.equal(res.ok, false);
  assert.equal(code(res), "ACTION_NOT_VERIFIED");
  assert.ok(res.newSnapshotDiff && res.newSnapshotDiff.updated.length >= 1, "diff must be preserved on final-verification failure");
  assert.equal(ctx.doc.getElementById("c").checked, false, "executor must not retry activation to force the state");
  ctx.engine.stopObserving();
});

test("disabled/readonly: mutations rejected, read allowed", async () => {
  const ctx = loadFixture();
  assert.equal(code(await act(ctx, "Disabled field", "fill", "x")), "TARGET_DISABLED");
  assert.equal(code(await act(ctx, "Readonly field", "fill", "x")), "TARGET_READONLY");
  const read = await act(ctx, "Readonly field", "read");
  assert.equal(read.ok, true);
  assert.equal(read.result.element.state.value, "fixed");
});
