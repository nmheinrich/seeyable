// Feature 11: trusted approval routing in the content script.
// Verifies that approval/gate/log messages are honored only from the
// browser-identified side-panel page, and that a held consequential
// action runs exactly once through the real message path.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(here, rel), "utf8");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadContent() {
  const dom = new JSDOM(read("fixtures/executor-form.html"), {
    url: "https://example.test/executor",
    runScripts: "dangerously",
    pretendToBeVisual: true,
  });
  const win = dom.window;
  let listener = null;
  win.chrome = {
    runtime: {
      id: "test-extension",
      getURL: (path) => `chrome-extension://test-extension/${path}`,
      onMessage: { addListener: (fn) => { listener = fn; } },
    },
  };
  win.console = { info: () => {}, warn: () => {}, error: () => {} };
  if (!win.crypto || !win.crypto.subtle) {
    Object.defineProperty(win, "crypto", { value: globalThis.crypto, configurable: true });
  }
  win.eval(read("../lib/snapshot-dom.js"));
  win.eval(read("../lib/executor.js"));
  win.eval(read("../lib/overlay.js"));
  win.eval(read("../content.js"));
  assert.ok(listener, "content script registered a message listener");
  const send = (message, sender) => new Promise((resolve) => {
    listener(message, sender, resolve);
  });
  return { dom, win, doc: win.document, send };
}

const PANEL = { id: "test-extension", url: "chrome-extension://test-extension/sidepanel.html" };
const PAGE = { id: "test-extension", url: "https://example.test/executor", tab: { id: 42 } };
const OTHER_PAGE = { id: "test-extension", url: "chrome-extension://test-extension/mic-setup.html" };

test("approval routing: only the side-panel sender can approve; held submit runs once", async () => {
  const { win, send } = loadContent();
  const snapRes = await send({ type: "SEEYABLE_SNAPSHOT_DOM" }, PANEL);
  const submit = snapRes.snapshot.elements.find((e) => e.name === "Submit feedback");
  assert.ok(submit);

  const held = await send({
    type: "SEEYABLE_EXECUTE_ACTION",
    request: { action: "click", elementId: submit.id, documentSessionId: snapRes.snapshot.documentSessionId, revision: snapRes.snapshot.revision, source: "manual" },
  }, PANEL);
  assert.equal(held.error.code, "CONFIRMATION_REQUIRED");
  assert.equal(win.__flags.submitRan, false);
  const challengeId = held.confirmation.challengeId;

  const forged = await send({ type: "SEEYABLE_APPROVE_CHALLENGE", challengeId }, PAGE);
  assert.equal(forged.error.code, "UNTRUSTED_APPROVAL", "a page-context sender cannot approve");
  const wrongPage = await send({ type: "SEEYABLE_APPROVE_CHALLENGE", challengeId }, OTHER_PAGE);
  assert.equal(wrongPage.error.code, "UNTRUSTED_APPROVAL", "other extension pages cannot approve");
  const forgedGate = await send({ type: "SEEYABLE_GATE_CONTROL", command: "resume" }, PAGE);
  assert.equal(forgedGate.error.code, "UNTRUSTED_APPROVAL");
  assert.equal(win.__flags.submitRan, false, "forged attempts activate nothing");

  const approved = await send({ type: "SEEYABLE_APPROVE_CHALLENGE", challengeId }, PANEL);
  assert.equal(approved.ok, true, JSON.stringify(approved.error));
  assert.equal(win.__flags.submitRan, true);

  const logRes = await send({ type: "SEEYABLE_GET_ACTION_LOG" }, PANEL);
  assert.equal(logRes.ok, true);
  assert.ok(logRes.entries.some((e) => e.decision === "approved"));
  const logFromPage = await send({ type: "SEEYABLE_GET_ACTION_LOG" }, PAGE);
  assert.equal(logFromPage.error.code, "UNTRUSTED_APPROVAL", "the log is not exposed to page senders");

  await sleep(0);
  win.close();
});

test("mcp hold: pending confirmation is panel-retrievable, approval runs once, cancel clears", async () => {
  const { win, send } = loadContent();
  const { snapshot } = await send({ type: "SEEYABLE_SNAPSHOT_DOM" }, PANEL);
  const submit = snapshot.elements.find((e) => e.name === "Submit feedback");
  const held = await send({
    type: "SEEYABLE_EXECUTE_ACTION",
    request: { action: "click", elementId: submit.id, documentSessionId: snapshot.documentSessionId, revision: snapshot.revision, source: "mcp" },
  }, PANEL);
  assert.equal(held.error.code, "CONFIRMATION_REQUIRED");
  assert.equal(win.__flags.submitRan, false, "held with zero dispatch");

  const forged = await send({ type: "SEEYABLE_GET_PENDING_CONFIRMATION" }, PAGE);
  assert.equal(forged.error.code, "UNTRUSTED_APPROVAL", "pending challenges are not exposed to page senders");
  const pending = await send({ type: "SEEYABLE_GET_PENDING_CONFIRMATION" }, PANEL);
  assert.equal(pending.ok, true);
  assert.equal(pending.confirmation.challengeId, held.confirmation.challengeId, "the authoritative challenge is retrievable");
  assert.equal(pending.confirmation.targetName, "Submit feedback");
  assert.ok(!("binding" in pending.confirmation) && !("request" in pending.confirmation), "no approval material leaks");

  const approved = await send({ type: "SEEYABLE_APPROVE_CHALLENGE", challengeId: held.confirmation.challengeId }, PANEL);
  assert.equal(approved.ok, true, JSON.stringify(approved.error));
  assert.equal(win.__flags.submitRan, true, "the stored action ran exactly once after human approval");
  const after = await send({ type: "SEEYABLE_GET_PENDING_CONFIRMATION" }, PANEL);
  assert.equal(after.confirmation, null, "a consumed challenge is no longer pending");

  // Cancellation path: hold Delete, cancel it, nothing pending, nothing ran.
  const snap2 = (await send({ type: "SEEYABLE_SNAPSHOT_DOM" }, PANEL)).snapshot;
  const del = snap2.elements.find((e) => e.name === "Delete draft");
  const held2 = await send({
    type: "SEEYABLE_EXECUTE_ACTION",
    request: { action: "click", elementId: del.id, documentSessionId: snap2.documentSessionId, revision: snap2.revision, source: "mcp" },
  }, PANEL);
  assert.equal(held2.error.code, "CONFIRMATION_REQUIRED");
  const cancelled = await send({ type: "SEEYABLE_CANCEL_CHALLENGE", challengeId: held2.confirmation.challengeId }, PANEL);
  assert.equal(cancelled.cancelled, true);
  assert.equal(win.__flags.deleteRan, false);
  const afterCancel = await send({ type: "SEEYABLE_GET_PENDING_CONFIRMATION" }, PANEL);
  assert.equal(afterCancel.confirmation, null);
  win.close();
});

test("read_section: protected editable content and hidden headings never leak, prose survives", async () => {
  const { win, doc, send } = loadContent();
  doc.querySelector("form").insertAdjacentHTML("afterbegin",
    `<section id="s19"><h2 hidden>HiddenHeadingSecret</h2><h2>Visible section</h2>`
    + `<div role="textbox" contenteditable="true" aria-label="Card number">SyntheticEditableSecret</div>`
    + `<div contenteditable="true" aria-label="Notes">EditableNoteSecret</div>`
    + `<p>Ordinary prose stays readable.</p>`
    + `<label for="s19-anchor">Section anchor</label><input id="s19-anchor" type="text"></section>`);
  const { snapshot } = await send({ type: "SEEYABLE_SNAPSHOT_DOM" }, PANEL);
  const anchor = snapshot.elements.find((e) => e.name === "Section anchor");
  assert.ok(anchor, "the section anchor is a snapshot target");
  const res = await send({
    type: "SEEYABLE_READ_SECTION", elementId: anchor.id,
    documentSessionId: snapshot.documentSessionId, revision: snapshot.revision,
  }, PANEL);
  assert.equal(res.ok, true, JSON.stringify(res.error));
  assert.equal(res.section.sectionTag, "section");
  assert.equal(res.section.heading, "Visible section", "hidden headings are not section metadata");
  assert.match(res.section.text, /Ordinary prose stays readable/, "ordinary prose remains readable");
  const whole = JSON.stringify(res);
  assert.ok(!whole.includes("SyntheticEditableSecret"), "sensitive editable (role=textbox) content is excluded");
  assert.ok(!whole.includes("EditableNoteSecret"), "any contenteditable content is a control value, not prose");
  assert.ok(!whole.includes("HiddenHeadingSecret"), "hidden heading text never leaks through metadata");
  win.close();
});

test("read_section: bounded, redacted, section-scoped content with stale rejection", async () => {
  const { win, doc, send } = loadContent();
  const { snapshot } = await send({ type: "SEEYABLE_SNAPSHOT_DOM" }, PANEL);
  const plain = snapshot.elements.find((e) => e.name === "Plain text");
  const read = (over) => send({
    type: "SEEYABLE_READ_SECTION", elementId: plain.id,
    documentSessionId: snapshot.documentSessionId, revision: snapshot.revision, ...over,
  }, PANEL);

  assert.equal((await read({ documentSessionId: "doc-other" })).error.code, "WRONG_SESSION");
  assert.equal((await read({ elementId: "el-999" })).error.code, "UNKNOWN_TARGET");
  assert.equal((await read({ revision: 999 })).error.code, "STALE_TARGET");

  const ok = await read({});
  assert.equal(ok.ok, true, JSON.stringify(ok.error));
  assert.equal(ok.section.sectionTag, "form");
  assert.equal(ok.section.heading, "Executor fixture form");
  assert.equal(ok.section.elementId, plain.id);
  assert.match(ok.section.text, /How satisfied are you\?/);
  assert.match(ok.section.text, /Plain text/);
  assert.ok(!ok.section.text.includes("SyntheticPass!1"), "password values never appear in section text");
  assert.ok(!ok.section.text.includes("4242424242424242"), "card values never appear in section text");

  const small = await read({ maxChars: 120 });
  assert.equal(small.ok, true);
  assert.equal(small.section.truncated, true, "truncation is reported, never silent");
  assert.ok(small.section.text.length <= 120);

  // A live page change since the snapshot rejects instead of reading on.
  doc.getElementById("plain").value = "typed after snapshot";
  doc.getElementById("plain").dispatchEvent(new win.Event("input", { bubbles: true }));
  const stale = await read({});
  assert.equal(stale.ok, false);
  assert.ok(["STALE_SNAPSHOT", "STALE_TARGET"].includes(stale.error.code), `expected stale rejection, got ${stale.error && stale.error.code}`);
  win.close();
});

test("tag states: only the side panel may paint acting/done/held, and only for this document", async () => {
  const { win, send } = loadContent();
  const { snapshot } = await send({ type: "SEEYABLE_SNAPSHOT_DOM" }, PANEL);
  const target = snapshot.elements[0].id;
  const forged = await send({ type: "SEEYABLE_TAG_STATE", documentSessionId: snapshot.documentSessionId, states: { [target]: "done" } }, PAGE);
  assert.equal(forged.error.code, "UNTRUSTED_APPROVAL", "a page sender cannot fake a done/held tag");
  const wrongDoc = await send({ type: "SEEYABLE_TAG_STATE", documentSessionId: "doc-other", states: { [target]: "held" } }, PANEL);
  assert.equal(wrongDoc.ok, false);
  const ok = await send({ type: "SEEYABLE_TAG_STATE", documentSessionId: snapshot.documentSessionId, states: { [target]: "acting" } }, PANEL);
  assert.equal(ok.ok, true);
  assert.equal(ok.states, 1);
  win.close();
});
