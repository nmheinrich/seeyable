// Run: node --test apps/extension/lib/snapshot-cdp.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { simplifyAxTree, interactiveOnly } = require("./snapshot-cdp.js");

const RAW = {
  nodes: [
    { nodeId: "1", ignored: false, role: { value: "RootWebArea" }, name: { value: "Demo" }, childIds: ["2"], backendDOMNodeId: 10 },
    { nodeId: "2", parentId: "1", ignored: false, role: { value: "textbox" }, name: { value: "Full name" },
      backendDOMNodeId: 11, properties: [{ name: "required", value: { value: true } }, { name: "focused", value: { value: false } }] },
    { nodeId: "3", parentId: "1", ignored: true, role: { value: "generic" }, name: { value: "" } },
    { nodeId: "4", parentId: "1", ignored: false, role: { value: "button" }, name: { value: "Submit survey" }, backendDOMNodeId: 12 },
    { nodeId: "5", parentId: "1", ignored: false, role: { value: "StaticText" }, name: { value: "Hello" } },
  ],
};

test("simplifyAxTree flattens role/name/state and keeps backendDOMNodeId", () => {
  const out = simplifyAxTree(RAW);
  assert.equal(out.length, 5);
  const textbox = out.find((n) => n.nodeId === "2");
  assert.equal(textbox.role, "textbox");
  assert.equal(textbox.name, "Full name");
  assert.equal(textbox.backendDOMNodeId, 11);
  assert.deepEqual(textbox.state, { required: true, focused: false });
  const text = out.find((n) => n.nodeId === "5");
  assert.equal(text.backendDOMNodeId, null);
});

test("interactiveOnly drops ignored + non-interactive roles by default", () => {
  const out = interactiveOnly(simplifyAxTree(RAW));
  assert.deepEqual(out.map((n) => n.nodeId), ["2", "4"]);
  const withIgnored = interactiveOnly(simplifyAxTree(RAW), { includeIgnored: true });
  assert.ok(withIgnored.some((n) => n.nodeId === "3"));
});

test("simplifyAxTree tolerates empty/missing input", () => {
  assert.deepEqual(simplifyAxTree(null), []);
  assert.deepEqual(simplifyAxTree({}), []);
});
