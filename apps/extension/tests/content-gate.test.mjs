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
