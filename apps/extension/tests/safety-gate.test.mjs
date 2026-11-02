// Feature 11: shared executor safety gate — confirmation, approval
// binding, Stop/Pause, and the redacted action log. All consequential
// handlers are synthetic and record activation instead of acting.
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
const internals = {
  normalizeElements: snap.normalizeElements, diffNormalized: snap.diffNormalized,
  sensitiveInfo: snap.sensitiveInfo, isVisible: snap.isVisible,
  computeAccessibleName: snap.computeAccessibleName,
};

function load(html, opts = {}) {
  const dom = new JSDOM(html, { url: "https://example.test/form", runScripts: "dangerously", pretendToBeVisual: true });
  const engine = snap.createSnapshotEngine(dom.window.document, dom.window, { debounceMs: 0 });
  const executor = createExecutor({ engine, internals, settleMs: 0, ...opts });
  return { dom, doc: dom.window.document, win: dom.window, engine, executor };
}
function loadFixture(opts = {}) {
  return load(readFileSync(join(here, "fixtures/executor-form.html"), "utf8"), opts);
}
async function requestFor(ctx, name, action = "click", value) {
  const s = ctx.engine.snapshot();
  const el = s.elements.find((e) => e.name === name);
  assert.ok(el, `control "${name}" exists`);
  return { action, elementId: el.id, documentSessionId: s.documentSessionId, revision: s.revision, value };
}
const code = (res) => res.error && res.error.code;

test("same gate holds manual, voice-equivalent, and MCP-equivalent calls; all are logged", async () => {
  for (const source of ["manual", "voice", "mcp"]) {
    const ctx = loadFixture();
    const req = await requestFor(ctx, "Submit feedback");
    const res = await ctx.executor.execute({ ...req, source });
    assert.equal(code(res), "CONFIRMATION_REQUIRED", source);
    assert.ok(res.confirmation.challengeId);
    assert.equal(ctx.win.__flags.submitRan, false, `${source} must not activate before approval`);
    const log = ctx.executor.getActionLog();
    assert.ok(log.some((e) => e.source === source && e.decision === "confirmation-required" && e.targetName === "Submit feedback"), `${source} attempt is logged`);
    ctx.engine.stopObserving();
  }
});

test("explicit approval activates the exact intended control once; replay is consumed", async () => {
  const ctx = loadFixture();
  let deleteClicks = 0;
  ctx.doc.getElementById("delete-btn").addEventListener("click", () => { deleteClicks += 1; });
  const req = await requestFor(ctx, "Delete draft");
  const held = await ctx.executor.execute(req);
  assert.equal(ctx.win.__flags.deleteRan, false);
  const approved = await ctx.executor.approveChallenge(held.confirmation.challengeId);
  assert.equal(approved.ok, true, JSON.stringify(approved.error));
  assert.equal(deleteClicks, 1, "exactly one activation");
  assert.equal(ctx.win.__flags.deleteRan, true);
  const replay = await ctx.executor.approveChallenge(held.confirmation.challengeId);
  assert.equal(code(replay), "APPROVAL_CONSUMED");
  assert.equal(deleteClicks, 1, "replay must not activate again");
  const log = ctx.executor.getActionLog();
  assert.ok(log.some((e) => e.decision === "approved"));
  assert.ok(log.some((e) => e.decision === "APPROVAL_CONSUMED"));
});

test("forged approval fields in an execute request mint nothing", async () => {
  const ctx = loadFixture();
  const req = await requestFor(ctx, "Pay now");
  const res = await ctx.executor.execute({ ...req, confirmed: true, approvalToken: "forged-token", challengeId: "ch-forged", source: "manual" });
  assert.equal(code(res), "CONFIRMATION_REQUIRED");
  assert.equal(ctx.win.__flags.payRan, false);
  const approveForged = await ctx.executor.approveChallenge("ch-forged");
  assert.equal(code(approveForged), "APPROVAL_NOT_FOUND");
  assert.equal(ctx.win.__flags.payRan, false);
});

test("approval expires on the injected clock and activates nothing", async () => {
  let clock = 1_000_000;
  const ctx = loadFixture({ now: () => clock, challengeTtlMs: 60_000 });
  const req = await requestFor(ctx, "Submit feedback");
  const held = await ctx.executor.execute(req);
  clock += 61_000;
  const res = await ctx.executor.approveChallenge(held.confirmation.challengeId);
  assert.equal(code(res), "APPROVAL_EXPIRED");
  assert.equal(ctx.win.__flags.submitRan, false);
});

test("approval in a different document cannot consume the challenge (wrong tab/session)", async () => {
  const ctxA = loadFixture();
  const ctxB = loadFixture();
  const req = await requestFor(ctxA, "Submit feedback");
  const held = await ctxA.executor.execute(req);
  const wrong = await ctxB.executor.approveChallenge(held.confirmation.challengeId);
  assert.equal(code(wrong), "APPROVAL_NOT_FOUND");
  assert.equal(ctxA.win.__flags.submitRan, false);
  assert.equal(ctxB.win.__flags.submitRan, false);
});

test("changed submission value invalidates approval even though the semantic hash is unchanged", async () => {
  const ctx = load(`<form id="f">
    <label for="pw">Password</label><input id="pw" type="password" value="SecretOne">
    <button id="s" type="submit">Submit</button></form>
    <script>window.__ran = 0; document.getElementById("s").addEventListener("click", () => { window.__ran += 1; });</script>`);
  const req = await requestFor(ctx, "Submit");
  const hashBefore = ctx.engine.getStatus().semanticHash;
  const held = await ctx.executor.execute(req);
  assert.equal(code(held), "CONFIRMATION_REQUIRED");
  ctx.doc.getElementById("pw").value = "SecretTwo";
  // Redacted state keeps the semantic hash identical: only the private
  // payload binding can catch this change.
  assert.equal(ctx.engine.checkForChanges().changed, false, "semantic hash must not change for a redacted value swap");
  assert.equal(ctx.engine.getStatus().semanticHash, hashBefore);
  const res = await ctx.executor.approveChallenge(held.confirmation.challengeId);
  assert.equal(code(res), "APPROVAL_INVALIDATED");
  assert.equal(ctx.win.__ran, 0);
});

test("approval does not override replaced/disabled targets or sensitive-write blocking", async () => {
  const ctx = loadFixture();
  const req = await requestFor(ctx, "Submit feedback");
  const held = await ctx.executor.execute(req);
  const btn = ctx.doc.getElementById("submit-btn");
  const replacement = btn.cloneNode(true);
  let replacementClicks = 0;
  replacement.addEventListener("click", () => { replacementClicks += 1; });
  btn.replaceWith(replacement);
  const replaced = await ctx.executor.approveChallenge(held.confirmation.challengeId);
  assert.equal(replaced.ok, false);
  assert.equal(replacementClicks, 0, "a replacement must never be activated by an old approval");

  const ctx2 = loadFixture();
  const req2 = await requestFor(ctx2, "Delete draft");
  const held2 = await ctx2.executor.execute(req2);
  ctx2.doc.getElementById("delete-btn").setAttribute("disabled", "");
  const disabled = await ctx2.executor.approveChallenge(held2.confirmation.challengeId);
  assert.equal(disabled.ok, false);
  assert.equal(ctx2.win.__flags.deleteRan, false);

  const fillPw = await requestFor(ctx2, "Password", "fill", "NewSecret1");
  const sensitive = await ctx2.executor.execute(fillPw);
  assert.equal(code(sensitive), "SENSITIVE_FIELD", "sensitive writes stay blocked; approval is not involved");
});

test("cancel revokes; pause/stop revoke; resume replays nothing", async () => {
  const ctx = loadFixture();
  const req = await requestFor(ctx, "Submit feedback");
  const held = await ctx.executor.execute(req);
  assert.deepEqual(ctx.executor.cancelChallenge(held.confirmation.challengeId), { cancelled: true });
  assert.equal(code(await ctx.executor.approveChallenge(held.confirmation.challengeId)), "APPROVAL_NOT_FOUND");
  assert.equal(ctx.win.__flags.submitRan, false);

  const held2 = await ctx.executor.execute(await requestFor(ctx, "Submit feedback"));
  ctx.executor.pauseExecution();
  assert.equal(code(await ctx.executor.approveChallenge(held2.confirmation.challengeId)), "APPROVAL_NOT_FOUND", "pause revokes pending approvals");
  const pausedAttempt = await ctx.executor.execute(await requestFor(ctx, "Increment counter"));
  assert.equal(code(pausedAttempt), "EXECUTION_PAUSED");
  ctx.executor.resumeExecution();
  assert.equal(ctx.win.__flags.submitRan, false, "resume must not replay the revoked action");
  assert.equal(ctx.win.__flags.harmlessClicks, 0, "resume must not replay the paused attempt");

  ctx.executor.stopExecution();
  const stoppedAttempt = await ctx.executor.execute(await requestFor(ctx, "Increment counter"));
  assert.equal(code(stoppedAttempt), "EXECUTION_STOPPED");
  ctx.executor.resumeExecution();
  const after = await ctx.executor.execute(await requestFor(ctx, "Increment counter"));
  assert.equal(after.ok, true, "fresh intentional execution works after resume");
  assert.equal(ctx.win.__flags.harmlessClicks, 1);
});

test("concurrent approvals cannot consume the same approval twice", async () => {
  const ctx = loadFixture();
  const req = await requestFor(ctx, "Delete draft");
  const held = await ctx.executor.execute(req);
  const [a, b] = await Promise.all([
    ctx.executor.approveChallenge(held.confirmation.challengeId),
    ctx.executor.approveChallenge(held.confirmation.challengeId),
  ]);
  const codes = [code(a), code(b)];
  assert.ok(a.ok !== b.ok, "exactly one approval may run");
  assert.ok(codes.includes("APPROVAL_CONSUMED"), `loser must be consumed-rejected, got ${codes}`);
  assert.equal(ctx.win.__flags.deleteRan, true);
});

test("sequential harness: confirmation stops later steps; Stop between steps prevents the rest", async () => {
  // A minimal handwritten runner: steps execute in order and the run
  // halts on the first non-ok outcome — no plan engine involved.
  async function runSteps(ctx, steps, betweenSteps) {
    const results = [];
    for (const step of steps) {
      const res = await ctx.executor.execute(typeof step === "function" ? await step() : step);
      results.push(res);
      if (betweenSteps) betweenSteps(results.length);
      if (!res.ok) break;
    }
    return results;
  }
  const ctx = loadFixture();
  const results = await runSteps(ctx, [
    () => requestFor(ctx, "Plain text", "fill", "step one"),
    () => requestFor(ctx, "Submit feedback"),
    () => requestFor(ctx, "Essay", "fill", "must never be written"),
  ]);
  assert.equal(results.length, 2, "the run stops at the held consequential step");
  assert.equal(code(results[1]), "CONFIRMATION_REQUIRED");
  assert.equal(ctx.doc.getElementById("plain").value, "step one");
  assert.equal(ctx.doc.getElementById("essay").value, "", "later steps do not run");
  assert.equal(ctx.win.__flags.submitRan, false);

  const ctx2 = loadFixture();
  const results2 = await runSteps(ctx2, [
    () => requestFor(ctx2, "Plain text", "fill", "first"),
    () => requestFor(ctx2, "Essay", "fill", "must never be written"),
  ], (n) => { if (n === 1) ctx2.executor.stopExecution(); });
  assert.equal(results2.length, 2);
  assert.equal(code(results2[1]), "EXECUTION_STOPPED");
  assert.equal(ctx2.doc.getElementById("essay").value, "", "stopped steps do not run");
});

test("stop during the pre-dispatch wait prevents activation", async () => {
  const ctx = loadFixture({ settleMs: 40 });
  const req = await requestFor(ctx, "Increment counter");
  const pending = ctx.executor.execute(req);
  ctx.executor.stopExecution(); // lands during the scroll/settle wait
  const res = await pending;
  // Admitted-then-stopped is EXECUTION_CANCELLED (operation-scoped);
  // EXECUTION_STOPPED remains for requests admitted while stopped.
  assert.equal(code(res), "EXECUTION_CANCELLED");
  assert.equal(ctx.win.__flags.harmlessClicks, 0, "an undispatched action must not activate after Stop");
});

test("log and serialized transport payloads contain no protected values or token material", async () => {
  const ctx = loadFixture();
  const held = await ctx.executor.execute({ ...(await requestFor(ctx, "Submit feedback")), source: "mcp" });
  const approved = await ctx.executor.approveChallenge(held.confirmation.challengeId);
  assert.equal(approved.ok, true);
  const snapshot = ctx.engine.snapshot();
  const payloads = JSON.stringify({ held, approved, log: ctx.executor.getActionLog(), snapshot });
  assert.ok(!payloads.includes("SyntheticPass!1"), "password value must never appear");
  assert.ok(!payloads.includes("4242424242424242"), "card value must never appear");
  for (const entry of ctx.executor.getActionLog()) {
    assert.deepEqual(Object.keys(entry).sort(), ["action", "approved", "decision", "elementId", "source", "targetName", "timestamp"], "log entries carry only safe fields");
  }
});

/* --- Review regressions: dispatch-time validity (initially failing) --- */

test("review: Stop then Resume during an approval wait does not revive the action", async () => {
  const ctx = loadFixture({ settleMs: 40 });
  const req = await requestFor(ctx, "Delete draft");
  const held = await ctx.executor.execute(req);
  const pending = ctx.executor.approveChallenge(held.confirmation.challengeId);
  ctx.executor.stopExecution();
  ctx.executor.resumeExecution();
  const res = await pending;
  assert.equal(ctx.win.__flags.deleteRan, false, "a stopped-then-resumed approval must never activate");
  assert.equal(res.ok, false);
  assert.equal(code(res), "EXECUTION_CANCELLED");
});

test("review: Pause then Resume during an ordinary execution wait does not revive it", async () => {
  const ctx = loadFixture({ settleMs: 40 });
  const req = await requestFor(ctx, "Increment counter");
  const pending = ctx.executor.execute(req);
  ctx.executor.pauseExecution();
  ctx.executor.resumeExecution();
  const res = await pending;
  assert.equal(ctx.win.__flags.harmlessClicks, 0);
  assert.equal(code(res), "EXECUTION_CANCELLED");
});

test("review: cancelling a consumed-but-undispatched approval invalidates its grant", async () => {
  const ctx = loadFixture({ settleMs: 40 });
  const req = await requestFor(ctx, "Delete draft");
  const held = await ctx.executor.execute(req);
  const pending = ctx.executor.approveChallenge(held.confirmation.challengeId);
  const cancelResult = ctx.executor.cancelChallenge(held.confirmation.challengeId);
  assert.equal(cancelResult.cancelled, true, "consumed but undispatched approvals can still be cancelled");
  const res = await pending;
  assert.equal(ctx.win.__flags.deleteRan, false);
  assert.equal(code(res), "APPROVAL_CANCELLED");
});

test("review: expiry is rechecked at dispatch (valid while now < expiresAt)", async () => {
  let clock = 1_000_000;
  const ctx = loadFixture({ settleMs: 40, now: () => clock, challengeTtlMs: 60_000 });
  const req = await requestFor(ctx, "Delete draft");
  const held = await ctx.executor.execute(req);
  const pending = ctx.executor.approveChallenge(held.confirmation.challengeId); // approved before expiry
  clock += 61_000; // expires during the pre-dispatch wait
  const res = await pending;
  assert.equal(ctx.win.__flags.deleteRan, false);
  assert.equal(code(res), "APPROVAL_EXPIRED");

  // Exact boundary: at expiresAt the challenge is already expired.
  const ctx2 = loadFixture({ now: () => clock, challengeTtlMs: 60_000 });
  const held2 = await ctx2.executor.execute(await requestFor(ctx2, "Delete draft"));
  clock += 60_000;
  const atBoundary = await ctx2.executor.approveChallenge(held2.confirmation.challengeId);
  assert.equal(code(atBoundary), "APPROVAL_EXPIRED");
  assert.equal(ctx2.win.__flags.deleteRan, false);
});

function loadSubmitForm(extra = "") {
  return load(`<form id="f" action="/original" method="post">
    <label for="n">Name</label><input id="n" name="n" value="Ada">
    <button id="s" type="submit">Send form</button></form>${extra}
    <script>window.__ran = 0; document.getElementById("s").addEventListener("click", () => { window.__ran += 1; });</script>`);
}

test("review: changing the form destination after confirmation invalidates approval", async () => {
  const ctx = loadSubmitForm();
  const held = await ctx.executor.execute(await requestFor(ctx, "Send form"));
  assert.equal(code(held), "CONFIRMATION_REQUIRED");
  ctx.doc.getElementById("f").setAttribute("action", "/elsewhere");
  const res = await ctx.executor.approveChallenge(held.confirmation.challengeId);
  assert.equal(code(res), "APPROVAL_INVALIDATED");
  assert.equal(ctx.win.__ran, 0);
});

test("review: changing an externally associated control after confirmation invalidates approval", async () => {
  const ctx = loadSubmitForm(`<input form="f" type="hidden" name="ref" value="A">`);
  const held = await ctx.executor.execute(await requestFor(ctx, "Send form"));
  assert.equal(code(held), "CONFIRMATION_REQUIRED");
  ctx.doc.querySelector("input[name=ref]").value = "B";
  const res = await ctx.executor.approveChallenge(held.confirmation.challengeId);
  assert.equal(code(res), "APPROVAL_INVALIDATED");
  assert.equal(ctx.win.__ran, 0);
});

test("review: changing a submitter override (formaction) after confirmation invalidates approval", async () => {
  const ctx = loadSubmitForm();
  const held = await ctx.executor.execute(await requestFor(ctx, "Send form"));
  ctx.doc.getElementById("s").setAttribute("formaction", "/override");
  const res = await ctx.executor.approveChallenge(held.confirmation.challengeId);
  assert.equal(code(res), "APPROVAL_INVALIDATED");
  assert.equal(ctx.win.__ran, 0);
});

test("review: an unchanged submission still approves exactly once", async () => {
  const ctx = loadSubmitForm(`<input form="f" type="hidden" name="ref" value="A">`);
  const held = await ctx.executor.execute(await requestFor(ctx, "Send form"));
  const res = await ctx.executor.approveChallenge(held.confirmation.challengeId);
  assert.equal(res.ok, true, JSON.stringify(res.error));
  assert.equal(ctx.win.__ran, 1);
  const replay = await ctx.executor.approveChallenge(held.confirmation.challengeId);
  assert.equal(code(replay), "APPROVAL_CONSUMED");
  assert.equal(ctx.win.__ran, 1);
});

/* --- Review regressions: binding strength and dispatch boundary --- */

function loadCollisionForm() {
  return load(`<form id="f">
    <input id="payload" type="hidden" name="answer">
    <button id="b" type="submit">Submit</button></form>
    <script>window.__ran = 0; document.getElementById("b").addEventListener("click", () => { window.__ran += 1; });</script>`, { url: "https://example.test/start" });
}

test("review: FNV-colliding submission values must not retain the approval binding", async () => {
  const ctx = loadCollisionForm();
  ctx.doc.getElementById("payload").value = "13rxy84-5476";
  const held = await ctx.executor.execute(await requestFor(ctx, "Submit"));
  assert.equal(code(held), "CONFIRMATION_REQUIRED");
  // These two values collide under the old 32-bit FNV digest (539cca75).
  ctx.doc.getElementById("payload").value = "lf6d92-108454";
  const res = await ctx.executor.approveChallenge(held.confirmation.challengeId);
  assert.equal(ctx.win.__ran, 0, "a colliding submission must never activate");
  assert.equal(code(res), "APPROVAL_INVALIDATED");
});

test("review: unchanged submission (collision-form control) still approves exactly once", async () => {
  const ctx = loadCollisionForm();
  ctx.doc.getElementById("payload").value = "13rxy84-5476";
  const held = await ctx.executor.execute(await requestFor(ctx, "Submit"));
  const res = await ctx.executor.approveChallenge(held.confirmation.challengeId);
  assert.equal(res.ok, true, JSON.stringify(res.error));
  assert.equal(ctx.win.__ran, 1);
});

test("review: cancel after dispatch reports too-late and claims no revocation", async () => {
  const ctx = loadFixture({ settleMs: 40 });
  let clicks = 0;
  ctx.doc.getElementById("delete-btn").addEventListener("click", () => { clicks += 1; });
  const held = await ctx.executor.execute(await requestFor(ctx, "Delete draft"));
  const pending = ctx.executor.approveChallenge(held.confirmation.challengeId);
  // Wait until the click has actually been dispatched, then cancel
  // during the post-action settle.
  for (let i = 0; i < 100 && !ctx.win.__flags.deleteRan; i += 1) await new Promise((r) => setTimeout(r, 5));
  assert.equal(ctx.win.__flags.deleteRan, true, "dispatch must have happened before this cancel");
  const cancelResult = ctx.executor.cancelChallenge(held.confirmation.challengeId);
  assert.equal(cancelResult.cancelled, false, "a dispatched action cannot be claimed cancelled");
  assert.equal(cancelResult.dispatched, true, "the response must state it was already dispatched");
  const res = await pending;
  assert.equal(res.ok, true);
  assert.equal(res.result.dispatched, true);
  assert.equal(clicks, 1, "exactly one activation");
  const log = ctx.executor.getActionLog();
  assert.ok(log.some((e) => e.decision === "approval-cancel-too-late"), "log must record too-late, not revocation");
  assert.ok(!log.some((e) => e.decision === "approval-cancelled"), "log must not claim the dispatched action was cancelled");
});

test("review: without Web Crypto, consequential confirmation fails closed", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  Object.defineProperty(globalThis, "crypto", { value: undefined, configurable: true });
  try {
    const ctx = loadFixture();
    const res = await ctx.executor.execute(await requestFor(ctx, "Submit feedback"));
    assert.equal(code(res), "SECURE_BINDING_UNAVAILABLE");
    assert.equal(res.confirmation, undefined, "no challenge may be minted without a secure binding");
    assert.equal(ctx.win.__flags.submitRan, false);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "crypto", descriptor);
  }
});

/* --- Review regressions: mutation while the final binding hash is held --- */

function loadAriaDelete() {
  return load(`<div id="b" role="button" tabindex="0">Delete draft</div>
    <script>window.__ran = 0; document.getElementById("b").addEventListener("click", () => { window.__ran += 1; });</script>`);
}

// Holds only the digests of the FINAL binding verification (the first
// approval verification passes), mutates the target mid-hash, then
// releases. Deterministic: digest calls are counted.
async function approveMutatingDuringFinalHash(ctx, held, mutate) {
  const realCrypto = globalThis.crypto;
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  let release;
  const gate = new Promise((r) => { release = r; });
  let digestCalls = 0;
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: {
      getRandomValues: (a) => realCrypto.getRandomValues(a),
      subtle: {
        digest: async (alg, data) => {
          digestCalls += 1;
          if (digestCalls > 2) await gate; // final verification digests are held
          return realCrypto.subtle.digest(alg, data);
        },
      },
    },
  });
  try {
    const pending = ctx.executor.approveChallenge(held.confirmation.challengeId);
    await new Promise((r) => setTimeout(r, 20)); // approval reaches the held final hash
    mutate();
    release();
    return await pending;
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "crypto", descriptor);
  }
}

test("review: target disabled during the final binding hash must not activate", async () => {
  const ctx = loadAriaDelete();
  const held = await ctx.executor.execute(await requestFor(ctx, "Delete draft"));
  assert.equal(code(held), "CONFIRMATION_REQUIRED");
  const res = await approveMutatingDuringFinalHash(ctx, held, () => {
    ctx.doc.getElementById("b").setAttribute("aria-disabled", "true");
  });
  assert.equal(ctx.win.__ran, 0, "a target disabled during hashing must not activate");
  assert.equal(res.ok, false);
});

test("review: target removed during the final binding hash must not activate", async () => {
  const ctx = loadAriaDelete();
  const held = await ctx.executor.execute(await requestFor(ctx, "Delete draft"));
  assert.equal(code(held), "CONFIRMATION_REQUIRED");
  const res = await approveMutatingDuringFinalHash(ctx, held, () => {
    ctx.doc.getElementById("b").remove();
  });
  assert.equal(ctx.win.__ran, 0, "a detached target must not activate");
  assert.equal(res.ok, false);
});

test("review: target hidden during the final binding hash must not activate", async () => {
  const ctx = loadAriaDelete();
  const held = await ctx.executor.execute(await requestFor(ctx, "Delete draft"));
  assert.equal(code(held), "CONFIRMATION_REQUIRED");
  const res = await approveMutatingDuringFinalHash(ctx, held, () => {
    ctx.doc.getElementById("b").style.display = "none";
  });
  assert.equal(ctx.win.__ran, 0, "a hidden target must not activate");
  assert.equal(res.ok, false);
});

test("review: unchanged ARIA target during hashing still approves exactly once (control)", async () => {
  const ctx = loadAriaDelete();
  const held = await ctx.executor.execute(await requestFor(ctx, "Delete draft"));
  const res = await approveMutatingDuringFinalHash(ctx, held, () => {});
  assert.equal(res.ok, true, JSON.stringify(res.error));
  assert.equal(ctx.win.__ran, 1);
});

/* --- Issue #16 blocker: incidental words in survey answers ------------------
 * A Google-Forms-style rating grid: answer labels quote their row, and one
 * row is "Checkout experience". The row text is the answer's structural
 * group context (radiogroup name / fieldset legend), so it is removed before
 * the keyword check; the answer's own words still count. Committing
 * controls are judged by their whole label whatever role the page assigns.
 * No domain or label whitelist; page handlers are never inspected. */
const SURVEY = `<!doctype html><body><form id="f" onsubmit="event.preventDefault(); window.__submitted = true;">
  <div role="radiogroup" aria-label="Checkout experience">
    <div role="radio" tabindex="0" aria-checked="false" id="aria-vs" aria-label="Very satisfied, response for Checkout experience"
      onclick="document.querySelectorAll('[role=radio]').forEach((r) => r.setAttribute('aria-checked', String(r === this)))">Very satisfied</div>
    <div role="radio" tabindex="0" aria-checked="false" id="aria-s" aria-label="Satisfied, response for Checkout experience"
      onclick="document.querySelectorAll('[role=radio]').forEach((r) => r.setAttribute('aria-checked', String(r === this)))">Satisfied</div>
  </div>
  <fieldset><legend>Checkout experience</legend>
    <label><input type="radio" name="co" id="native-vs"> Very satisfied, response for Checkout experience</label>
    <label><input type="radio" name="co" id="native-s"> Satisfied, response for Checkout experience</label>
  </fieldset>
  <label><input type="checkbox" id="cb"> Email me product updates</label>
  <button type="button" id="checkout" onclick="window.__checkout = true">Checkout</button>
  <button id="continue" onclick="window.__continue = true">Continue</button>
  <button role="radio" aria-checked="false" id="fake-radio" onclick="window.__fakeRadio = true">Very satisfied</button>
  <div role="switch" aria-checked="false" tabindex="0" id="pub" onclick="this.setAttribute('aria-checked','true'); window.__published = true">Publish post</div>
</form></body>`;
async function surveyRequest(ctx, id, action) {
  const s = ctx.engine.snapshot();
  const node = ctx.doc.getElementById(id);
  const el = s.elements.find((e) => ctx.engine.resolveNode(e.id, s.revision).node === node);
  assert.ok(el, `snapshot has #${id}`);
  return { action, elementId: el.id, documentSessionId: s.documentSessionId, revision: s.revision };
}

test("#16: survey answers with incidental 'Checkout' context select by check AND click, without a challenge", async () => {
  for (const [id, action] of [["aria-vs", "check"], ["aria-s", "click"], ["native-vs", "check"], ["native-s", "click"]]) {
    const ctx = load(SURVEY);
    const res = await ctx.executor.execute(await surveyRequest(ctx, id, action));
    assert.equal(res.ok, true, `${id} ${action}: ${JSON.stringify(res.error)}`);
    assert.equal(res.confirmation, undefined, "no consequential-action challenge");
    const node = ctx.doc.getElementById(id);
    const selected = node.tagName === "INPUT" ? node.checked : node.getAttribute("aria-checked") === "true";
    assert.equal(selected, true, `${id} is selected after ${action}`);
    assert.equal(ctx.win.__submitted, undefined);
    ctx.dom.window.close();
  }
});

test("#16: an ordinary checkbox selects without a challenge", async () => {
  const ctx = load(SURVEY);
  const res = await ctx.executor.execute(await surveyRequest(ctx, "cb", "check"));
  assert.equal(res.ok, true, JSON.stringify(res.error));
  assert.equal(ctx.doc.getElementById("cb").checked, true);
  ctx.dom.window.close();
});

test("#16: genuine consequential controls stay held — Checkout button, native submit labelled Continue, submit with a radio role, Publish switch", async () => {
  const cases = [
    ["checkout", "click", "__checkout"],
    ["continue", "click", "__continue"],       // no type in a form = native submit
    ["fake-radio", "click", "__fakeRadio"],    // role=radio, but a form-associated default-submit button
    ["fake-radio", "check", "__fakeRadio"],
    ["pub", "click", "__published"],           // switches act immediately: label check kept
    ["pub", "check", "__published"],
  ];
  for (const [id, action, flag] of cases) {
    const ctx = load(SURVEY);
    const res = await ctx.executor.execute(await surveyRequest(ctx, id, action));
    assert.equal(code(res), "CONFIRMATION_REQUIRED", `${id} ${action} must be held`);
    assert.ok(res.confirmation && res.confirmation.challengeId);
    assert.equal(ctx.win[flag], undefined, `${id} handler did not run`);
    assert.equal(ctx.win.__submitted, undefined, "nothing was submitted");
    ctx.dom.window.close();
  }
});

test("#16: native submit evidence wins over a misleading role, and its approval binding is unchanged", async () => {
  const ctx = load(SURVEY);
  const held = await ctx.executor.execute(await surveyRequest(ctx, "fake-radio", "click"));
  assert.equal(held.confirmation.evidence, "native-submit");
  const approved = await ctx.executor.approveChallenge(held.confirmation.challengeId);
  assert.equal(approved.ok, true, JSON.stringify(approved.error));
  assert.equal(ctx.win.__fakeRadio, true, "approval runs exactly the reviewed control once");
  assert.equal(code(await ctx.executor.approveChallenge(held.confirmation.challengeId)), "APPROVAL_CONSUMED");
  ctx.dom.window.close();
});

/* --- #16 narrowing: selection roles never exempt a committing label ------ */
const COMMITTING = `<!doctype html><body><form id="f" onsubmit="event.preventDefault(); window.__submitted = true;">
  <button type="button" role="checkbox" aria-checked="false" id="b-del" onclick="window.__n = (window.__n || 0) + 1">Delete draft</button>
  <label><input type="checkbox" id="c-del" onclick="window.__n = (window.__n || 0) + 1">Delete all saved responses</label>
  <div role="radiogroup" aria-label="Payment">
    <div role="radio" tabindex="0" aria-checked="false" id="r-pay" onclick="window.__n = (window.__n || 0) + 1; this.setAttribute('aria-checked', 'true')">Pay now</div>
  </div>
  <div role="checkbox" tabindex="0" aria-checked="false" id="a-pub" onclick="window.__n = (window.__n || 0) + 1; this.setAttribute('aria-checked', 'true')">Publish immediately</div>
  <fieldset><legend>Delete options</legend>
    <label><input type="checkbox" id="c-del2" onclick="window.__n = (window.__n || 0) + 1">Delete all saved responses</label>
  </fieldset>
  <div role="radiogroup" aria-label="Pay now">
    <div role="radio" tabindex="0" aria-checked="false" id="r-same" onclick="window.__n = (window.__n || 0) + 1; this.setAttribute('aria-checked', 'true')">Pay now</div>
  </div>
  <a href="#checkout" role="radio" aria-checked="false" id="l-checkout" onclick="window.__n = (window.__n || 0) + 1; return false">Checkout</a>
  <input type="checkbox" role="switch" id="s-pub" aria-label="Publish post" onclick="window.__n = (window.__n || 0) + 1">
  <div role="radiogroup" aria-label="Checkout experience">
    <button type="button" role="radio" aria-checked="false" id="b-row" onclick="window.__n = (window.__n || 0) + 1">Continue to Checkout experience</button>
    <a href="#go" role="radio" aria-checked="false" id="l-row" onclick="window.__n = (window.__n || 0) + 1; return false">Go to Checkout experience</a>
  </div>
</form></body>`;

test("#16 narrowing: committing selection-role controls are held with ZERO dispatches before approval", async () => {
  const cases = [
    ["b-del", "button with role=checkbox, “Delete draft” (reviewer repro 1)"],
    ["c-del", "native checkbox “Delete all saved responses” (reviewer repro 2)"],
    ["r-pay", "ARIA radio “Pay now”"],
    ["a-pub", "ARIA checkbox “Publish immediately”"],
    ["c-del2", "“Delete all saved responses” inside a group named “Delete options” (single shared word is not context)"],
    ["r-same", "“Pay now” inside a group also named “Pay now” (context cannot erase the whole label)"],
    ["l-checkout", "link with role=radio “Checkout”"],
    ["s-pub", "checkbox with role=switch “Publish post”"],
    ["b-row", "<button role=radio> inside a Checkout-named group keeps button semantics (no context stripping)"],
    ["l-row", "<a href role=radio> inside a Checkout-named group keeps link semantics"],
  ];
  for (const [id, label] of cases) for (const action of ["click", "check"]) {
    const ctx = load(COMMITTING);
    const res = await ctx.executor.execute(await surveyRequest(ctx, id, action));
    assert.equal(code(res), "CONFIRMATION_REQUIRED", `${label} via ${action} must be held`);
    assert.equal(ctx.win.__n, undefined, `${label} via ${action}: zero dispatches before approval`);
    ctx.dom.window.close();
  }
});

test("#16 narrowing: an approved committing checkbox runs exactly once; the challenge stays single-use", async () => {
  const ctx = load(COMMITTING);
  const held = await ctx.executor.execute(await surveyRequest(ctx, "c-del", "click"));
  assert.equal(held.confirmation.evidence, "consequential-label");
  assert.equal(ctx.win.__n, undefined);
  const approved = await ctx.executor.approveChallenge(held.confirmation.challengeId);
  assert.equal(approved.ok, true, JSON.stringify(approved.error));
  assert.equal(ctx.win.__n, 1, "approval dispatches exactly once");
  assert.equal(code(await ctx.executor.approveChallenge(held.confirmation.challengeId)), "APPROVAL_CONSUMED");
  assert.equal(ctx.win.__n, 1);
  ctx.dom.window.close();
});

test("#16 narrowing: row context named through aria-labelledby or a 'Question: Row' group name is incidental", async () => {
  const html = `<!doctype html><body>
    <span id="row">Checkout experience</span>
    <div role="radiogroup" aria-labelledby="row">
      <div role="radio" tabindex="0" aria-checked="false" id="lb" aria-label="Satisfied, response for Checkout experience" onclick="this.setAttribute('aria-checked','true')"></div>
    </div>
    <div role="radiogroup" aria-label="Rate your visit: Checkout experience">
      <div role="radio" tabindex="0" aria-checked="false" id="qr" aria-label="Neutral, response for Checkout experience" onclick="this.setAttribute('aria-checked','true')"></div>
    </div></body>`;
  for (const id of ["lb", "qr"]) for (const action of ["click", "check"]) {
    const ctx = load(html);
    const res = await ctx.executor.execute(await surveyRequest(ctx, id, action));
    assert.equal(res.ok, true, `${id} ${action}: ${JSON.stringify(res.error)}`);
    assert.equal(ctx.doc.getElementById(id).getAttribute("aria-checked"), "true");
    ctx.dom.window.close();
  }
});

/* --- #16 narrowing 2: group text never erases the control's own action ----
 * Context is removed from a label source only when it is that source's
 * trailing words introduced by a referring word ("response for <row>").
 * Everything else is the control's own evidence and is kept. */
function selectionFixture(kind, group, label, extraAttrs = "") {
  const hook = `onclick="window.__n = (window.__n || 0) + 1; this.setAttribute && this.getAttribute('role') && this.setAttribute('aria-checked', 'true')"`;
  if (kind === "native") return `<!doctype html><body><fieldset><legend>${group}</legend><label><input type="checkbox" id="t" ${extraAttrs} ${hook}>${label}</label></fieldset></body>`;
  return `<!doctype html><body><div role="group" aria-label="${group}"><div role="checkbox" tabindex="0" aria-checked="false" id="t" ${extraAttrs} ${hook}>${label}</div></div></body>`;
}

test("#16 narrowing 2: reviewer bypasses — group-named actions with qualifiers are held with ZERO dispatches", async () => {
  const cases = [
    ["Pay now", "Pay now (required)"],
    ["Delete all saved responses", "Delete all saved responses now"],
    ["Send notification", "Send notification immediately"],
    ["Send notification", "Send notification to all members"],          // a different qualifier, no special words
    ["Delete all saved responses", "Confirm, Delete all saved responses"], // bare comma: not a demonstrable reference
    ["Checkout experience", "Pay for Checkout experience"],              // reference removed, own "Pay" still counts
  ];
  for (const [group, label] of cases) for (const kind of ["native", "aria"]) for (const action of ["click", "check"]) {
    const ctx = load(selectionFixture(kind, group, label));
    const res = await ctx.executor.execute(await surveyRequest(ctx, "t", action));
    assert.equal(code(res), "CONFIRMATION_REQUIRED", `${kind} “${label}” in “${group}” via ${action} must be held`);
    assert.equal(ctx.win.__n, undefined, `${kind} “${label}” via ${action}: zero dispatches before approval`);
    ctx.dom.window.close();
  }
});

test("#16 narrowing 2: independent label sources keep their evidence; ambiguous placement holds", async () => {
  const cases = [
    // Survey-like aria-label is incidental, but the title independently names a deletion.
    `<!doctype html><body><div role="radiogroup" aria-label="Checkout experience"><div role="radio" tabindex="0" aria-checked="false" id="t" aria-label="Very satisfied, response for Checkout experience" title="Delete all saved responses" onclick="window.__n = (window.__n || 0) + 1"></div></div></body>`,
    // Row text at the start of the answer is not demonstrably incidental: held conservatively.
    `<!doctype html><body><div role="radiogroup" aria-label="Checkout experience"><div role="radio" tabindex="0" aria-checked="false" id="t" aria-label="Checkout experience: Very satisfied" onclick="window.__n = (window.__n || 0) + 1"></div></div></body>`,
  ];
  for (const html of cases) for (const action of ["click", "check"]) {
    const ctx = load(html);
    const res = await ctx.executor.execute(await surveyRequest(ctx, "t", action));
    assert.equal(code(res), "CONFIRMATION_REQUIRED", action);
    assert.equal(ctx.win.__n, undefined);
    ctx.dom.window.close();
  }
});

test("#16 narrowing 2: the genuine survey answer still selects under its structurally named row", async () => {
  for (const kind of ["native", "aria"]) for (const action of ["click", "check"]) {
    const ctx = load(selectionFixture(kind, "Checkout experience", "Very satisfied, response for Checkout experience"));
    const res = await ctx.executor.execute(await surveyRequest(ctx, "t", action));
    assert.equal(res.ok, true, `${kind} ${action}: ${JSON.stringify(res.error)}`);
    assert.equal(ctx.win.__n, 1, "dispatched exactly once");
    ctx.dom.window.close();
  }
});
