"use strict";
/* Shared plan contract tests: shape + semantics. No DOM, no network. */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const P = require("../plan-schema.js");

const ELEMENTS = [
  { id: "el-1", name: "Full name" },
  { id: "el-2", name: "Nickname" },
  { id: "el-20", name: "Submit survey" },
];

test("valid steps plan passes shape and semantics", () => {
  const plan = {
    version: "seeyable-plan-1",
    outcome: "steps",
    say: "Filling two fields.",
    steps: [
      { action: "fill", elementId: "el-1", value: "Ada Lovelace" },
      { action: "click", elementId: "el-2", note: "focus next" },
    ],
  };
  assert.deepEqual(P.validatePlanShape(plan), { ok: true, errors: [] });
  assert.deepEqual(P.validatePlan(plan, ELEMENTS), { ok: true, errors: [] });
});

test("valid clarify and unsupported plans pass", () => {
  const clarify = {
    version: "seeyable-plan-1",
    outcome: "clarify",
    question: "Which name field?",
    action: "fill",
    value: "Ada",
    choices: [
      { elementId: "el-1", label: "Full name" },
      { elementId: "el-2", label: "Nickname" },
    ],
  };
  assert.equal(P.validatePlan(clarify, ELEMENTS).ok, true);
  const bare = { version: "seeyable-plan-1", outcome: "clarify", question: "Say more." };
  assert.equal(P.validatePlan(bare, ELEMENTS).ok, true);
  const none = { version: "seeyable-plan-1", outcome: "unsupported", reason: "No safe plan." };
  assert.equal(P.validatePlan(none, ELEMENTS).ok, true);
});

test("unknown fields, actions, and malformed output rejected", () => {
  assert.equal(P.validatePlan(null, ELEMENTS).ok, false);
  assert.equal(P.validatePlan("steps", ELEMENTS).ok, false);
  assert.equal(P.validatePlan({ version: "seeyable-plan-1", outcome: "steps" }, ELEMENTS).ok, false);
  const evil = {
    version: "seeyable-plan-1", outcome: "steps", approved: true,
    steps: [{ action: "click", elementId: "el-1", token: "x" }],
  };
  const r = P.validatePlan(evil, ELEMENTS);
  assert.equal(r.ok, false);
  assert.ok(r.errors.every((e) => e.code === "SCHEMA"));
  const badAction = {
    version: "seeyable-plan-1", outcome: "steps",
    steps: [{ action: "scroll_to", elementId: "el-1" }],
  };
  const r2 = P.validatePlan(badAction, ELEMENTS);
  assert.equal(r2.ok, false);
  assert.equal(r2.errors[0].code, "BAD_ACTION");
  const badId = {
    version: "seeyable-plan-1", outcome: "steps",
    steps: [{ action: "click", elementId: "el-1;drop" }],
  };
  assert.equal(P.validatePlan(badId, ELEMENTS).ok, false);
});

test("invented ids rejected against the supplied snapshot only", () => {
  const plan = {
    version: "seeyable-plan-1", outcome: "steps",
    steps: [
      { action: "click", elementId: "el-1" },
      { action: "click", elementId: "el-99" },
    ],
  };
  assert.equal(P.validatePlanShape(plan).ok, true, "shape cannot see invention");
  const r = P.validatePlan(plan, ELEMENTS);
  assert.equal(r.ok, false);
  assert.equal(r.errors.length, 1);
  assert.equal(r.errors[0].code, "UNKNOWN_ID");
  assert.match(r.errors[0].detail, /steps\[1\]/);
  const clarify = {
    version: "seeyable-plan-1", outcome: "clarify", question: "Which?",
    action: "click", choices: [{ elementId: "el-77", label: "Ghost" }],
  };
  assert.equal(P.validatePlan(clarify, ELEMENTS).errors[0].code, "UNKNOWN_ID");
});

test("value rules match the executor contract", () => {
  const fillNoValue = { version: "seeyable-plan-1", outcome: "steps", steps: [{ action: "fill", elementId: "el-1" }] };
  assert.equal(P.validatePlan(fillNoValue, ELEMENTS).errors[0].code, "BAD_VALUE");
  const clickValue = { version: "seeyable-plan-1", outcome: "steps", steps: [{ action: "click", elementId: "el-1", value: "x" }] };
  assert.equal(P.validatePlan(clickValue, ELEMENTS).errors[0].code, "BAD_VALUE");
  const long = { version: "seeyable-plan-1", outcome: "steps", steps: [{ action: "fill", elementId: "el-1", value: "x".repeat(2001) }] };
  assert.equal(P.validatePlan(long, ELEMENTS).ok, false);
  const emptySelect = { version: "seeyable-plan-1", outcome: "steps", steps: [{ action: "select", elementId: "el-1", value: "" }] };
  assert.equal(P.validatePlan(emptySelect, ELEMENTS).errors[0].code, "BAD_VALUE");
});

test("oversized plans rejected; error details never echo values", () => {
  const many = {
    version: "seeyable-plan-1", outcome: "steps",
    steps: Array.from({ length: 21 }, () => ({ action: "click", elementId: "el-1" })),
  };
  const oversized = P.validatePlan(many, ELEMENTS);
  assert.equal(oversized.ok, false);
  assert.match(oversized.errors[0].detail, /1 to 20 steps/);
  const atCapacity = {
    version: "seeyable-plan-1", outcome: "steps",
    steps: Array.from({ length: 20 }, (_v, i) => ({ action: "click", elementId: `el-${(i % 2) + 1}` })),
  };
  assert.equal(P.validatePlan(atCapacity, ELEMENTS).ok, true);
  const secret = `sekret-${"z".repeat(2100)}`;
  const plan = {
    version: "seeyable-plan-1", outcome: "steps",
    steps: [{ action: "fill", elementId: "el-1", value: secret }],
  };
  const r = P.validatePlan(plan, ELEMENTS);
  assert.equal(r.ok, false);
  assert.ok(!JSON.stringify(r.errors).includes("sekret"), "validation feedback must not carry the value");
});

test("outcome field mixing rejected", () => {
  const mixed = {
    version: "seeyable-plan-1", outcome: "steps",
    steps: [{ action: "click", elementId: "el-1" }],
    reason: "also unsupported?",
  };
  assert.equal(P.validatePlan(mixed, ELEMENTS).ok, false);
  const clarifyNoAction = {
    version: "seeyable-plan-1", outcome: "clarify", question: "Which?",
    choices: [{ elementId: "el-1", label: "Full name" }],
  };
  assert.equal(P.validatePlan(clarifyNoAction, ELEMENTS).ok, false, "choices need their shared action");
});

const SELECT_ELEMENTS = [
  {
    id: "el-1", name: "Your role",
    state: {
      options: [
        { label: "Choose…", value: "" },
        { label: "Designer", value: "designer" },
        { label: "Product manager", value: "pm" },
        { label: "Legacy (disabled)", value: "legacy", disabled: true },
      ],
    },
  },
  { id: "el-2", name: "Plain text", state: {} },
];

const selectPlan = (value) => ({
  version: "seeyable-plan-1", outcome: "steps",
  steps: [{ action: "select", elementId: "el-1", value }],
});

test("select maps visible labels to exact option values", () => {
  assert.deepEqual(P.validatePlan(selectPlan("designer"), SELECT_ELEMENTS), { ok: true, errors: [] });
  assert.deepEqual(P.validatePlan(selectPlan("pm"), SELECT_ELEMENTS), { ok: true, errors: [] });
});

test("select rejects unlisted, disabled, and ambiguous choices without echoing values", () => {
  const guessed = P.validatePlan(selectPlan("Designer"), SELECT_ELEMENTS);
  assert.equal(guessed.ok, false);
  assert.equal(guessed.errors[0].code, "UNKNOWN_OPTION", "labels are not values: no lowercasing, no guessing");
  assert.ok(!JSON.stringify(guessed.errors).includes("Designer"), "repair feedback stays value-free");
  assert.equal(P.validatePlan(selectPlan("legacy"), SELECT_ELEMENTS).errors[0].code, "OPTION_DISABLED");
  const dupes = [{
    id: "el-1", name: "Role",
    state: { options: [{ label: "Designer", value: "designer-1" }, { label: "Designer", value: "designer-2" }] },
  }];
  assert.equal(P.validatePlan(selectPlan("designer-1"), dupes).errors[0].code, "AMBIGUOUS_OPTION");
  const dupValues = [{
    id: "el-1", name: "Role",
    state: { options: [{ label: "One", value: "same" }, { label: "Two", value: "same" }] },
  }];
  assert.equal(P.validatePlan(selectPlan("same"), dupValues).errors[0].code, "AMBIGUOUS_OPTION");
});

test("select without option metadata defers to the executor", () => {
  const plan = {
    version: "seeyable-plan-1", outcome: "steps",
    steps: [{ action: "select", elementId: "el-2", value: "anything" }],
  };
  assert.deepEqual(P.validatePlan(plan, SELECT_ELEMENTS), { ok: true, errors: [] });
});
