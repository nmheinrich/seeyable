// Issue #15: executor-owned undo of the last reversible change.
// Real snapshot engine + real executor on jsdom; no mocks of the executor.
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

const FORM = `<!doctype html><html><body><form id="f" onsubmit="event.preventDefault(); window.__submitted = true;">
  <label for="name">Full name</label><input id="name" name="name" type="text">
  <label for="bio">Short bio</label><textarea id="bio" name="bio"></textarea>
  <label for="role">Your role</label>
  <select id="role" name="role">
    <option value="">Choose…</option>
    <option value="designer">Designer</option>
    <option value="engineer" selected>Engineer</option>
  </select>
  <label><input id="sms" type="checkbox" name="sms"> SMS updates</label>
  <label><input id="weekly" type="radio" name="freq" value="weekly" checked> Weekly digest</label>
  <label><input id="monthly" type="radio" name="freq" value="monthly"> Monthly digest</label>
  <label><input id="a" type="radio" name="none" value="a"> Option A</label>
  <label><input id="b" type="radio" name="none" value="b"> Option B</label>
  <label for="pin">Account PIN</label><input id="pin" name="pin" type="password" value="1234">
  <button type="button" id="save">Save draft</button>
  <button type="submit">Submit survey</button>
</form></body></html>`;

function load(html = FORM) {
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
  return ctx.executor.execute({ action, elementId: el.id, documentSessionId: s.documentSessionId, revision: s.revision, value, source: "voice" });
}
const undo = (ctx, extra = {}) => ctx.executor.undoLastChange({ documentSessionId: ctx.engine.sessionId, source: "voice", ...extra });
const code = (res) => res.error && res.error.code;

test("undo: restores the complete prior value of the last fill only, once", async () => {
  const ctx = load();
  // A prior value far beyond any snapshot/display truncation.
  const prior = "Prior bio ".repeat(400);
  ctx.doc.getElementById("bio").value = prior;
  let inputs = 0;
  ctx.doc.getElementById("bio").addEventListener("input", () => { inputs += 1; });
  assert.equal((await act(ctx, "Full name", "fill", "Grace Hopper")).ok, true);
  assert.equal((await act(ctx, "Short bio", "fill", "Scientist")).ok, true);
  const res = await undo(ctx);
  assert.equal(res.ok, true, JSON.stringify(res.error));
  assert.equal(res.result.verified, true);
  assert.equal(res.result.targetName, "Short bio");
  assert.equal(res.result.scope, "last-change-only");
  assert.equal(ctx.doc.getElementById("bio").value, prior, "full live prior value restored exactly");
  assert.equal(ctx.doc.getElementById("name").value, "Grace Hopper", "earlier step stays as it is");
  assert.ok(inputs >= 2, "restoration dispatches input events like a forward fill");
  const json = JSON.stringify(res);
  assert.ok(!json.includes("Prior bio") && !json.includes("Scientist"), "no undo values in the response payload");
  const log = JSON.stringify(ctx.executor.getActionLog());
  assert.ok(!log.includes("Prior bio") && !log.includes("Scientist") && !log.includes("Grace"), "no values in the log");
  assert.ok(ctx.executor.getActionLog().some((e) => e.action === "undo" && e.decision === "verified"));
  const again = await undo(ctx);
  assert.equal(code(again), "NOTHING_TO_UNDO", "a successful undo is consumed exactly once");
  assert.equal(ctx.doc.getElementById("name").value, "Grace Hopper", "a duplicate undo never walks back further");
  ctx.dom.window.close();
});

test("undo: concurrent duplicate requests restore once", async () => {
  const ctx = load();
  assert.equal((await act(ctx, "Short bio", "fill", "Pilot")).ok, true);
  const [a, b] = await Promise.all([undo(ctx), undo(ctx)]);
  assert.equal([a, b].filter((r) => r.ok).length, 1, "exactly one restoration");
  const loser = a.ok ? b : a;
  assert.ok(["EXECUTION_BUSY", "NOTHING_TO_UNDO"].includes(code(loser)), code(loser));
  assert.equal(ctx.doc.getElementById("bio").value, "");
  ctx.dom.window.close();
});

test("undo: intervening manual edit is refused and never overwritten", async () => {
  const ctx = load();
  assert.equal((await act(ctx, "Short bio", "fill", "Scientist")).ok, true);
  ctx.doc.getElementById("bio").value = "Typed by the person";
  const res = await undo(ctx);
  assert.equal(code(res), "UNDO_CONFLICT");
  assert.match(res.error.message, /edited/);
  assert.equal(ctx.doc.getElementById("bio").value, "Typed by the person", "the manual edit survives");
  assert.ok(!JSON.stringify(res).includes("Typed by"), "refusal carries no values");
  assert.equal(code(await undo(ctx)), "NOTHING_TO_UNDO", "the superseded record is retired");
  ctx.dom.window.close();
});

test("undo: select restores the previously selected option; changed choice is refused", async () => {
  const ctx = load();
  assert.equal((await act(ctx, "Your role", "select", "designer")).ok, true);
  const res = await undo(ctx);
  assert.equal(res.ok, true, JSON.stringify(res.error));
  assert.equal(ctx.doc.getElementById("role").value, "engineer");

  assert.equal((await act(ctx, "Your role", "select", "designer")).ok, true);
  ctx.doc.getElementById("role").value = ""; // manual change to another choice
  const refused = await undo(ctx);
  assert.equal(code(refused), "UNDO_CONFLICT");
  assert.match(refused.error.message, /dropdown choice changed/);
  assert.equal(ctx.doc.getElementById("role").value, "");
  ctx.dom.window.close();
});

test("undo: checkbox check and uncheck restore their prior state", async () => {
  const ctx = load();
  const sms = ctx.doc.getElementById("sms");
  assert.equal((await act(ctx, "SMS updates", "check")).ok, true);
  assert.equal(sms.checked, true);
  assert.equal((await undo(ctx)).ok, true);
  assert.equal(sms.checked, false);
  sms.checked = true;
  assert.equal((await act(ctx, "SMS updates", "uncheck")).ok, true);
  assert.equal((await undo(ctx)).ok, true);
  assert.equal(sms.checked, true);
  ctx.dom.window.close();
});

test("undo: radio restores the previously selected group member", async () => {
  const ctx = load();
  const weekly = ctx.doc.getElementById("weekly");
  const monthly = ctx.doc.getElementById("monthly");
  assert.equal((await act(ctx, "Monthly digest", "check")).ok, true);
  assert.equal(monthly.checked, true);
  assert.equal(weekly.checked, false);
  const res = await undo(ctx);
  assert.equal(res.ok, true, JSON.stringify(res.error));
  assert.equal(weekly.checked, true, "previous member reselected");
  assert.equal(monthly.checked, false);
  assert.equal(res.result.targetName, "Monthly digest");
  assert.equal(res.result.restoredTargetName, "Weekly digest");
  ctx.dom.window.close();
});

test("undo: a radio group with no prior selection refuses honestly", async () => {
  const ctx = load();
  assert.equal((await act(ctx, "Option A", "check")).ok, true);
  const res = await undo(ctx);
  assert.equal(code(res), "UNDO_UNSUPPORTED");
  assert.equal(ctx.doc.getElementById("a").checked, true, "nothing changed");
  ctx.dom.window.close();
});

test("undo: radio changed by the person after Seeyable is refused", async () => {
  const ctx = load();
  assert.equal((await act(ctx, "Monthly digest", "check")).ok, true);
  ctx.doc.getElementById("weekly").checked = true; // manual change back
  const res = await undo(ctx);
  assert.equal(code(res), "UNDO_CONFLICT");
  ctx.dom.window.close();
});

test("undo: replaced node and stale document are refused", async () => {
  const ctx = load();
  assert.equal((await act(ctx, "Short bio", "fill", "Scientist")).ok, true);
  const old = ctx.doc.getElementById("bio");
  const fresh = ctx.doc.createElement("textarea");
  fresh.id = "bio"; fresh.name = "bio"; fresh.value = "Scientist";
  old.replaceWith(fresh);
  const res = await undo(ctx);
  assert.equal(code(res), "UNDO_STALE");
  assert.equal(fresh.value, "Scientist", "the replacement node is never written");

  const ctx2 = load();
  assert.equal((await act(ctx2, "Short bio", "fill", "Scientist")).ok, true);
  const wrong = await ctx2.executor.undoLastChange({ documentSessionId: "doc-other" });
  assert.equal(code(wrong), "WRONG_SESSION");
  assert.equal(ctx2.doc.getElementById("bio").value, "Scientist");
  ctx.dom.window.close();
  ctx2.dom.window.close();
});

test("undo: never skips backward past a click, and clicks are not reversible", async () => {
  const ctx = load();
  assert.equal((await act(ctx, "Short bio", "fill", "Scientist")).ok, true);
  await act(ctx, "Save draft", "click");
  const res = await undo(ctx);
  assert.equal(code(res), "UNDO_NOT_REVERSIBLE");
  assert.match(res.error.message, /click on “Save draft”/);
  assert.match(res.error.message, /earlier changes are not undone past it/);
  assert.equal(ctx.doc.getElementById("bio").value, "Scientist", "the earlier fill is not silently undone");
  ctx.dom.window.close();
});

test("undo: protected fields are never captured or restored", async () => {
  const ctx = load();
  const s = ctx.engine.snapshot();
  const pin = s.elements.find((e) => e.name === "Account PIN");
  const blocked = await ctx.executor.execute({ action: "fill", elementId: pin.id, documentSessionId: s.documentSessionId, revision: s.revision, value: "9999" });
  assert.equal(code(blocked), "SENSITIVE_FIELD");
  assert.equal(code(await undo(ctx)), "NOTHING_TO_UNDO", "a blocked sensitive write leaves no record");
  ctx.dom.window.close();
});

test("undo: approved consequential action is a barrier, not reversible", async () => {
  const ctx = load();
  ctx.doc.getElementById("f").addEventListener("submit", (e) => e.preventDefault());
  assert.equal((await act(ctx, "Short bio", "fill", "Scientist")).ok, true);
  const held = await act(ctx, "Submit survey", "click");
  assert.equal(code(held), "CONFIRMATION_REQUIRED");
  assert.equal((await undo(ctx)).ok, true, "a held (unrun) action does not block undo of the earlier fill");
  assert.equal((await act(ctx, "Short bio", "fill", "Scientist")).ok, true);
  const held2 = await act(ctx, "Submit survey", "click");
  await ctx.executor.approveChallenge(held2.confirmation.challengeId);
  assert.equal(code(await undo(ctx)), "UNDO_NOT_REVERSIBLE", "approved consequential actions are never undone or skipped");
  ctx.dom.window.close();
});

test("undo: verified no-op keeps the earlier record; pause blocks; resume allows", async () => {
  const ctx = load();
  assert.equal((await act(ctx, "Short bio", "fill", "Scientist")).ok, true);
  const noop = await act(ctx, "SMS updates", "uncheck"); // already unchecked
  assert.equal(noop.result.alreadyInDesiredState, true);
  ctx.executor.pauseExecution();
  assert.equal(code(await undo(ctx)), "EXECUTION_PAUSED");
  assert.equal(ctx.doc.getElementById("bio").value, "Scientist");
  ctx.executor.resumeExecution();
  const res = await undo(ctx);
  assert.equal(res.ok, true, "the record survives a paused refusal and the no-op");
  assert.equal(ctx.doc.getElementById("bio").value, "");
  ctx.dom.window.close();
});

test("undo: page that overrides the restoration reports unverified and blocks further undo", async () => {
  const ctx = load();
  assert.equal((await act(ctx, "Short bio", "fill", "Scientist")).ok, true);
  const bio = ctx.doc.getElementById("bio");
  bio.addEventListener("input", () => { if (bio.value === "") bio.value = "Page default"; });
  const res = await undo(ctx);
  assert.equal(code(res), "UNDO_NOT_VERIFIED");
  assert.equal(code(await undo(ctx)), "UNDO_NOT_REVERSIBLE");
  ctx.dom.window.close();
});

/* --- Trusted routing through the real content script ------------------- */
const read = (rel) => readFileSync(join(here, rel), "utf8");
test("undo routing: only the side panel can undo; page senders are rejected", async () => {
  const dom = new JSDOM(FORM, { url: "https://example.test/", runScripts: "dangerously", pretendToBeVisual: true });
  const win = dom.window;
  let listener = null;
  win.chrome = { runtime: { id: "x", getURL: (p) => `chrome-extension://x/${p}`, onMessage: { addListener: (fn) => { listener = fn; } } } };
  win.console = { info: () => {}, warn: () => {}, error: () => {} };
  if (!win.crypto || !win.crypto.subtle) Object.defineProperty(win, "crypto", { value: globalThis.crypto, configurable: true });
  win.eval(read("../lib/snapshot-dom.js"));
  win.eval(read("../lib/executor.js"));
  win.eval(read("../lib/overlay.js"));
  win.eval(read("../content.js"));
  const send = (message, sender) => new Promise((resolve) => listener(message, sender, resolve));
  const PANEL = { id: "x", url: "chrome-extension://x/sidepanel.html" };
  const PAGE = { id: "x", url: "https://example.test/", tab: { id: 1 } };
  const { snapshot } = await send({ type: "SEEYABLE_SNAPSHOT_DOM" }, PANEL);
  const bio = snapshot.elements.find((e) => e.name === "Short bio");
  const res = await send({ type: "SEEYABLE_EXECUTE_ACTION", request: { action: "fill", elementId: bio.id, documentSessionId: snapshot.documentSessionId, revision: snapshot.revision, value: "Scientist" } }, PANEL);
  assert.equal(res.ok, true);
  const forged = await send({ type: "SEEYABLE_UNDO_LAST", documentSessionId: snapshot.documentSessionId }, PAGE);
  assert.equal(forged.error.code, "UNTRUSTED_APPROVAL");
  assert.equal(win.document.getElementById("bio").value, "Scientist", "a page sender restores nothing");
  const ok = await send({ type: "SEEYABLE_UNDO_LAST", documentSessionId: snapshot.documentSessionId, source: "voice" }, PANEL);
  assert.equal(ok.ok, true, JSON.stringify(ok.error));
  assert.equal(win.document.getElementById("bio").value, "");
  win.close();
});

test("undo: ARIA switch restores by one activation; ARIA radio is not reversible", async () => {
  const ctx = load(`<!doctype html><body>
    <button type="button" role="switch" aria-checked="false" id="sw" onclick="this.setAttribute('aria-checked', this.getAttribute('aria-checked') === 'true' ? 'false' : 'true')">Notifications</button>
    <div role="radiogroup" aria-label="Size">
      <div role="radio" tabindex="0" aria-checked="true" id="s" onclick="document.getElementById('l').setAttribute('aria-checked','false'); this.setAttribute('aria-checked','true')">Small</div>
      <div role="radio" tabindex="0" aria-checked="false" id="l" onclick="document.getElementById('s').setAttribute('aria-checked','false'); this.setAttribute('aria-checked','true')">Large</div>
    </div></body>`);
  assert.equal((await act(ctx, "Notifications", "check")).ok, true);
  assert.equal((await undo(ctx)).ok, true);
  assert.equal(ctx.doc.getElementById("sw").getAttribute("aria-checked"), "false");
  assert.equal((await act(ctx, "Large", "check")).ok, true);
  const res = await undo(ctx);
  assert.equal(code(res), "UNDO_NOT_REVERSIBLE");
  assert.equal(ctx.doc.getElementById("l").getAttribute("aria-checked"), "true", "nothing was changed");
  ctx.dom.window.close();
});

/* --- Review findings: dropdown meaning/availability (#15 follow-up) ----- */

test("undo select: disabled previous option is refused without writes", async () => {
  const ctx = load();
  assert.equal((await act(ctx, "Your role", "select", "designer")).ok, true);
  ctx.doc.querySelector("#role option[value=engineer]").disabled = true;
  const res = await undo(ctx);
  assert.equal(res.ok, false, "must not report success");
  assert.equal(ctx.doc.getElementById("role").value, "designer", "the disabled option was not selected");
  assert.ok(!JSON.stringify(res).includes("engineer"), "no option values in the response");
  ctx.dom.window.close();
});

test("undo select: changed value of the previous option is refused without writes", async () => {
  const ctx = load();
  assert.equal((await act(ctx, "Your role", "select", "designer")).ok, true);
  ctx.doc.querySelector("#role option[value=engineer]").value = "different-prior";
  const res = await undo(ctx);
  assert.equal(res.ok, false);
  assert.equal(ctx.doc.getElementById("role").value, "designer");
  ctx.dom.window.close();
});

test("undo select: changed value of the currently selected option is detected as a changed post-state", async () => {
  const ctx = load();
  assert.equal((await act(ctx, "Your role", "select", "designer")).ok, true);
  ctx.doc.querySelector("#role option[value=designer]").value = "designer-renamed";
  const res = await undo(ctx);
  assert.equal(res.ok, false);
  assert.equal(code(res), "UNDO_CONFLICT");
  assert.equal(ctx.doc.getElementById("role").value, "designer-renamed", "nothing was written");
  ctx.dom.window.close();
});

test("undo select: previous option inside a disabled optgroup is refused", async () => {
  const ctx = load(`<!doctype html><body>
    <label for="r">Team</label>
    <select id="r"><optgroup label="Core" id="core"><option value="a" selected>Alpha</option></optgroup>
    <optgroup label="Other"><option value="b">Beta</option></optgroup></select></body>`);
  assert.equal((await act(ctx, "Team", "select", "b")).ok, true);
  ctx.doc.getElementById("core").disabled = true;
  const res = await undo(ctx);
  assert.equal(res.ok, false);
  assert.equal(ctx.doc.getElementById("r").value, "b");
  ctx.dom.window.close();
});

test("undo select: changed option labels or structure, or multiple mode, are refused", async () => {
  for (const mutate of [
    (d) => { d.querySelector("#role option[value=engineer]").textContent = "Senior engineer"; },
    (d) => { d.querySelector("#role option[value=designer]").textContent = "Art director"; },
    (d) => { const o = d.createElement("option"); o.value = "pm"; o.textContent = "PM"; d.getElementById("role").prepend(o); d.getElementById("role").value = "designer"; },
    (d) => { d.querySelector("#role option[value='']").remove(); },
    (d) => { d.getElementById("role").multiple = true; d.getElementById("role").value = "designer"; },
  ]) {
    const ctx = load();
    assert.equal((await act(ctx, "Your role", "select", "designer")).ok, true);
    mutate(ctx.doc);
    const before = ctx.doc.getElementById("role").value;
    const res = await undo(ctx);
    assert.equal(res.ok, false, String(mutate));
    assert.equal(ctx.doc.getElementById("role").value, before, "no write");
    ctx.dom.window.close();
  }
});

test("undo select: unchanged dropdown restores the previous choice", async () => {
  const ctx = load();
  let changes = 0;
  ctx.doc.getElementById("role").addEventListener("change", () => { changes += 1; });
  assert.equal((await act(ctx, "Your role", "select", "designer")).ok, true);
  const res = await undo(ctx);
  assert.equal(res.ok, true, JSON.stringify(res.error));
  assert.equal(ctx.doc.getElementById("role").value, "engineer");
  assert.equal(changes, 2, "forward and restore each dispatch change");
  ctx.dom.window.close();
});

/* --- Review findings: radio/live final verification (#15 follow-up) ----- */

test("undo radio: previous member removed by its click handler is not verified; barrier kept", async () => {
  const ctx = load();
  assert.equal((await act(ctx, "Monthly digest", "check")).ok, true);
  const weekly = ctx.doc.getElementById("weekly");
  weekly.addEventListener("click", () => { weekly.closest("label").remove(); });
  const res = await undo(ctx);
  assert.equal(res.ok, false, "a disconnected restoration target is never verified success");
  assert.equal(code(res), "UNDO_NOT_VERIFIED");
  const live = [...ctx.doc.querySelectorAll("input[name=freq]")].filter((r) => r.checked).length;
  assert.equal(live, 0, "reproduction state: no live radio is selected");
  assert.equal(code(await undo(ctx)), "UNDO_NOT_REVERSIBLE", "uncertain restoration blocks older undo");
  ctx.dom.window.close();
});

test("undo radio: previous member replaced or regrouped during restoration is not verified", async () => {
  for (const handler of [
    (w) => () => { const n = w.cloneNode(); n.checked = true; w.replaceWith(n); },
    (w) => () => { w.name = "freq-other"; },
  ]) {
    const ctx = load();
    assert.equal((await act(ctx, "Monthly digest", "check")).ok, true);
    const weekly = ctx.doc.getElementById("weekly");
    weekly.addEventListener("click", handler(weekly));
    const res = await undo(ctx);
    assert.equal(code(res), "UNDO_NOT_VERIFIED", String(handler));
    assert.equal(code(await undo(ctx)), "UNDO_NOT_REVERSIBLE");
    ctx.dom.window.close();
  }
});

test("undo fill: target relabelled by the page during restoration is not verified", async () => {
  const ctx = load();
  assert.equal((await act(ctx, "Short bio", "fill", "Scientist")).ok, true);
  const bio = ctx.doc.getElementById("bio");
  bio.addEventListener("input", () => { bio.setAttribute("aria-label", "Something else"); });
  const res = await undo(ctx);
  assert.equal(code(res), "UNDO_NOT_VERIFIED");
  ctx.dom.window.close();
});
