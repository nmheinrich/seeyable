"use strict";
/* Seeyable shared plan contract (Issue #14) — single source of truth.
 *
 * The planner proxy sends PLAN_SCHEMA to the model as the Chat Completions
 * `response_format.json_schema` (constrained decoding), then validates the
 * output against it. The extension re-validates defensively before dispatch.
 * Model output is never execution authority: every step still runs through
 * the shared executor, live target validation, and the human-confirmation
 * gate for consequential actions.
 *
 * Loadable in both runtimes (no dependencies, no syntax beyond ES2019):
 *  - Node (planner proxy): require("../../packages/shared/plan-schema.js")
 *  - Browser (side panel): apps/extension/lib/plan-schema.js is a
 *    byte-identical mirror (MV3 cannot load scripts outside the extension
 *    root); packages/shared/tests/sync.test.mjs enforces equality.
 *
 * Bounds: at most MAX_STEPS steps; values capped; unknown fields rejected
 * everywhere (additionalProperties: false). Actions cover the mutating
 * executor verbs needed by demonstrated workflows; scroll_to/read are
 * intentionally excluded (the executor scrolls targets into view itself,
 * and plans are for acting, not reading).
 */

const PLAN_VERSION = "seeyable-plan-1";
const PLAN_ACTIONS = ["click", "fill", "select", "check", "uncheck"];
const VALUE_ACTIONS = ["fill", "select"];
const MAX_STEPS = 20;
const MAX_CHOICES = 12;
const MAX_VALUE_LENGTH = 2000;
const MAX_SAY_LENGTH = 280;

const PLAN_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "SeeyablePlan",
  type: "object",
  additionalProperties: false,
  required: ["version", "outcome"],
  properties: {
    version: { const: PLAN_VERSION },
    outcome: { enum: ["steps", "clarify", "unsupported"] },
    say: { type: "string", maxLength: MAX_SAY_LENGTH },
    steps: {
      type: "array",
      minItems: 1,
      maxItems: MAX_STEPS,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["action", "elementId"],
        properties: {
          action: { enum: PLAN_ACTIONS },
          elementId: { type: "string", pattern: "^el-[0-9]+$" },
          value: { type: "string", maxLength: MAX_VALUE_LENGTH },
          note: { type: "string", maxLength: 140 },
        },
      },
    },
    question: { type: "string", minLength: 1, maxLength: MAX_SAY_LENGTH },
    action: { enum: PLAN_ACTIONS },
    value: { type: "string", maxLength: MAX_VALUE_LENGTH },
    choices: {
      type: "array",
      minItems: 1,
      maxItems: MAX_CHOICES,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["elementId", "label"],
        properties: {
          elementId: { type: "string", pattern: "^el-[0-9]+$" },
          label: { type: "string", minLength: 1, maxLength: 160 },
        },
      },
    },
    reason: { type: "string", minLength: 1, maxLength: MAX_SAY_LENGTH },
  },
};

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// Shape validation: mirrors PLAN_SCHEMA without a JSON Schema dependency.
// Returns { ok, errors } where errors are bounded { code, detail } items
// safe to return to callers and to reuse as repair feedback. Never echoes
// fill values: details name the offending location, not its content.
function validatePlanShape(plan) {
  const errors = [];
  const fail = (code, detail) => { errors.push({ code, detail }); };
  if (!isPlainObject(plan)) {
    fail("SCHEMA", "plan must be an object");
    return { ok: false, errors };
  }
  for (const key of Object.keys(plan)) {
    if (!Object.prototype.hasOwnProperty.call(PLAN_SCHEMA.properties, key)) {
      fail("SCHEMA", `unknown top-level field: ${key}`);
    }
  }
  if (plan.version !== PLAN_VERSION) fail("SCHEMA", "version must be seeyable-plan-1");
  if (plan.outcome !== "steps" && plan.outcome !== "clarify" && plan.outcome !== "unsupported") {
    fail("SCHEMA", "outcome must be steps, clarify, or unsupported");
  }
  if (plan.say !== undefined && (typeof plan.say !== "string" || plan.say.length > MAX_SAY_LENGTH)) {
    fail("SCHEMA", "say must be a string of at most 280 characters");
  }
  const checkStep = (step, i) => {
    const where = `steps[${i}]`;
    if (!isPlainObject(step)) { fail("SCHEMA", `${where} must be an object`); return; }
    for (const key of Object.keys(step)) {
      if (key !== "action" && key !== "elementId" && key !== "value" && key !== "note") {
        fail("SCHEMA", `${where} has unknown field: ${key}`);
      }
    }
    if (!PLAN_ACTIONS.includes(step.action)) fail("BAD_ACTION", `${where} has an unsupported action`);
    if (typeof step.elementId !== "string" || !/^el-[0-9]+$/.test(step.elementId)) {
      fail("SCHEMA", `${where} has a malformed elementId`);
    }
    if (step.value !== undefined) {
      if (typeof step.value !== "string" || step.value.length > MAX_VALUE_LENGTH) {
        fail("SCHEMA", `${where} value exceeds the length limit`);
      } else if (!VALUE_ACTIONS.includes(step.action)) {
        fail("BAD_VALUE", `${where} carries a value for a valueless action`);
      } else if (step.value.length === 0 && step.action === "select") {
        fail("BAD_VALUE", `${where} select needs a non-empty option value`);
      }
    } else if (step.action === "fill" || step.action === "select") {
      fail("BAD_VALUE", `${where} ${step.action} needs a value`);
    }
    if (step.note !== undefined && (typeof step.note !== "string" || step.note.length > 140)) {
      fail("SCHEMA", `${where} note exceeds 140 characters`);
    }
  };
  if (plan.outcome === "steps") {
    if (!Array.isArray(plan.steps) || plan.steps.length < 1 || plan.steps.length > MAX_STEPS) {
      fail("SCHEMA", `steps must list 1 to ${MAX_STEPS} steps`);
    } else {
      plan.steps.forEach(checkStep);
    }
    if (plan.question !== undefined || plan.choices !== undefined || plan.reason !== undefined) {
      fail("SCHEMA", "a steps plan must not carry clarify/unsupported fields");
    }
    if (plan.action !== undefined || plan.value !== undefined) {
      fail("SCHEMA", "a steps plan must not carry top-level action/value");
    }
  } else if (plan.outcome === "clarify") {
    if (typeof plan.question !== "string" || plan.question.length < 1 || plan.question.length > MAX_SAY_LENGTH) {
      fail("SCHEMA", "clarify needs a question of 1 to 280 characters");
    }
    if (plan.action !== undefined && !PLAN_ACTIONS.includes(plan.action)) {
      fail("BAD_ACTION", "clarify action is not supported");
    }
    if (plan.value !== undefined) {
      if (typeof plan.value !== "string" || plan.value.length > MAX_VALUE_LENGTH) {
        fail("SCHEMA", "clarify value exceeds the length limit");
      } else if (plan.action !== "fill" && plan.action !== "select") {
        fail("BAD_VALUE", "clarify value needs a fill/select action");
      }
    } else if (plan.action === "select"
      || (plan.action === "fill" && plan.choices !== undefined)) {
      fail("BAD_VALUE", "clarify select — and fill with choices — needs a value");
    }
    if (plan.choices !== undefined) {
      if (!Array.isArray(plan.choices) || plan.choices.length < 1 || plan.choices.length > MAX_CHOICES) {
        fail("SCHEMA", `choices must list 1 to ${MAX_CHOICES} candidates`);
      } else {
        plan.choices.forEach((choice, i) => {
          const where = `choices[${i}]`;
          if (!isPlainObject(choice)) { fail("SCHEMA", `${where} must be an object`); return; }
          for (const key of Object.keys(choice)) {
            if (key !== "elementId" && key !== "label") fail("SCHEMA", `${where} has unknown field: ${key}`);
          }
          if (typeof choice.elementId !== "string" || !/^el-[0-9]+$/.test(choice.elementId)) {
            fail("SCHEMA", `${where} has a malformed elementId`);
          }
          if (typeof choice.label !== "string" || choice.label.length < 1 || choice.label.length > 160) {
            fail("SCHEMA", `${where} label must be 1 to 160 characters`);
          }
        });
      }
      if (plan.action === undefined) {
        fail("SCHEMA", "clarify with choices needs the shared action those choices resolve");
      }
    }
    if (plan.steps !== undefined || plan.reason !== undefined) {
      fail("SCHEMA", "a clarify plan must not carry steps/reason");
    }
  } else if (plan.outcome === "unsupported") {
    if (typeof plan.reason !== "string" || plan.reason.length < 1 || plan.reason.length > MAX_SAY_LENGTH) {
      fail("SCHEMA", "unsupported needs a reason of 1 to 280 characters");
    }
    if (plan.steps !== undefined || plan.question !== undefined || plan.action !== undefined
      || plan.value !== undefined || plan.choices !== undefined) {
      fail("SCHEMA", "an unsupported plan must not carry steps or clarify fields");
    }
  }
  return { ok: errors.length === 0, errors };
}

// Semantic validation: every referenced id must exist in the EXACT element
// list the model was shown (pruned snapshot for the proxy; current snapshot
// for the extension). Unknown ids, invented ids, and ids from another
// document are rejected — never retargeted. Select steps are additionally
// checked against the model-visible dropdown choices: the value must match
// exactly one listed option value, that option must be enabled, and its
// visible label must be unambiguous. Details name the location, never the
// value, so repair feedback stays value-free. Elements without option
// metadata (non-selects, legacy snapshots) skip the option checks — the
// executor remains the final authority on live option state.
function validatePlanSemantics(plan, elements) {
  const errors = [];
  const known = new Set();
  const byId = new Map();
  if (Array.isArray(elements)) {
    for (const element of elements) {
      if (element && typeof element.id === "string") {
        known.add(element.id);
        byId.set(element.id, element);
      }
    }
  }
  const checkId = (id, where) => {
    if (!known.has(id)) errors.push({ code: "UNKNOWN_ID", detail: `${where} references ${id}, which is not in the supplied snapshot` });
  };
  const checkSelectOptions = (step, i) => {
    if (!step || step.action !== "select" || typeof step.value !== "string") return;
    const element = byId.get(step.elementId);
    const shown = element && element.state && Array.isArray(element.state.options) ? element.state.options : null;
    if (!shown) return;
    if (!shown.every((o) => o && typeof o.label === "string" && typeof o.value === "string")) return;
    const where = `steps[${i}]`;
    const matches = shown.filter((o) => o.value === step.value);
    if (matches.length === 0) {
      errors.push({ code: "UNKNOWN_OPTION", detail: `${where} select value is not one of the listed option values for ${step.elementId}` });
      return;
    }
    if (matches.length > 1) {
      errors.push({ code: "AMBIGUOUS_OPTION", detail: `${where} select value matches more than one listed option for ${step.elementId}` });
      return;
    }
    if (matches[0].disabled === true) {
      errors.push({ code: "OPTION_DISABLED", detail: `${where} select value is a disabled option for ${step.elementId}` });
      return;
    }
    if (shown.some((o) => o !== matches[0] && o.label === matches[0].label)) {
      errors.push({ code: "AMBIGUOUS_OPTION", detail: `${where} select label matches more than one listed option for ${step.elementId}; ask which one` });
    }
  };
  if (plan && plan.outcome === "steps" && Array.isArray(plan.steps)) {
    plan.steps.forEach((step, i) => {
      if (step && typeof step.elementId === "string") checkId(step.elementId, `steps[${i}]`);
      checkSelectOptions(step, i);
    });
  }
  if (plan && plan.outcome === "clarify" && Array.isArray(plan.choices)) {
    plan.choices.forEach((choice, i) => {
      if (choice && typeof choice.elementId === "string") checkId(choice.elementId, `choices[${i}]`);
    });
  }
  return { ok: errors.length === 0, errors };
}

// Full validation: shape first, then semantics. One entry point shared by
// the proxy (against the pruned snapshot it sent) and the extension
// (against the live snapshot before dispatch).
function validatePlan(plan, elements) {
  const shape = validatePlanShape(plan);
  if (!shape.ok) return shape;
  return validatePlanSemantics(plan, elements);
}

const SeeyablePlan = {
  PLAN_VERSION,
  PLAN_ACTIONS,
  MAX_STEPS,
  MAX_CHOICES,
  MAX_VALUE_LENGTH,
  MAX_SAY_LENGTH,
  PLAN_SCHEMA,
  validatePlanShape,
  validatePlanSemantics,
  validatePlan,
};

if (typeof globalThis !== "undefined") globalThis.SeeyablePlan = SeeyablePlan;
if (typeof module !== "undefined" && module.exports) module.exports = SeeyablePlan;
