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
