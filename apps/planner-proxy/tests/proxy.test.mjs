"use strict";
/* Planner-proxy tests: auth, limits, validation + one repair, timeouts, and
 * safe errors. A local stub stands in for the Meta endpoint (the proxy
 * always speaks the real Chat Completions protocol; only the far end is
 * faked). No real credentials, no paid requests. */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createProxy, LOOPBACK_HOST, DEFAULT_MODEL } from "../lib/proxy.mjs";
import { DEVELOPER_PROMPT } from "../lib/prompt.mjs";

const ORIGIN = "chrome-extension://test";
const ELEMENTS = [
  { id: "el-1", role: "textbox", name: "Full name" },
  { id: "el-2", role: "textbox", name: "Nickname" },
];
const SNAPSHOT = { documentSessionId: "doc-A", revision: 3, elements: ELEMENTS, truncated: { omitted: 0 } };
const GOOD_PLAN = {
  version: "seeyable-plan-1",
  outcome: "steps",
  say: "Filling two fields.",
  steps: [
    { action: "fill", elementId: "el-1", value: "Ada Lovelace" },
    { action: "fill", elementId: "el-2", value: "Ada" },
  ],
};
const INVENTED_PLAN = {
  version: "seeyable-plan-1",
  outcome: "steps",
  steps: [{ action: "fill", elementId: "el-99", value: "sekret-should-never-travel" }],
};

function chatCompletion(content) {
  return {
    id: "chatcmpl-stub", object: "chat.completion", created: 1, model: DEFAULT_MODEL,
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
  };
}

// Scripted stub upstream: each entry is { content } | { status } | { delayMs, content }.
async function startStub(script) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let text = "";
    req.on("data", (c) => { text += c; });
    req.on("end", () => {
      const step = script[Math.min(seen.length, script.length - 1)];
      let parsed = null;
      try { parsed = JSON.parse(text); } catch {}
      seen.push({ url: req.url, auth: req.headers.authorization || "", body: parsed });
      const answer = () => {
        if (step && step.status) {
          res.writeHead(step.status, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: { message: "stub upstream failure with account-ish details" } }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(chatCompletion(step.content)));
      };
      if (step && step.delayMs) setTimeout(answer, step.delayMs);
      else answer();
    });
  });
  await new Promise((resolve) => server.listen(0, LOOPBACK_HOST, resolve));
  const port = server.address().port;
  return { server, port, seen, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

async function startProxy({ stubPort, apiKey = "test-key-not-real", upstreamTimeoutMs, logs = [] } = {}) {
  const proxy = createProxy({
    port: 0,
    token: "pairing-token-for-tests",
    apiKey,
    baseUrl: `http://${LOOPBACK_HOST}:${stubPort}`,
    upstreamTimeoutMs,
    log: (...args) => logs.push(args.join(" ")),
  });
  const { port } = await proxy.start();
  return { proxy, port, logs };
}

async function postPlan(port, body, { token = "pairing-token-for-tests", origin = ORIGIN } = {}) {
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
  if (origin !== null && origin !== undefined) headers.Origin = origin; // null omits Origin, like Chrome GETs
  const res = await fetch(`http://${LOOPBACK_HOST}:${port}/v1/plan`, {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

async function getStatus(port, { token = "pairing-token-for-tests", origin = ORIGIN } = {}) {
  const headers = { Authorization: `Bearer ${token}` };
  if (origin !== null && origin !== undefined) headers.Origin = origin;
  const res = await fetch(`http://${LOOPBACK_HOST}:${port}/v1/status`, { headers });
  return { status: res.status, json: await res.json() };
}

test("auth: wrong/missing token rejected; non-extension origin refused", async () => {
  const stub = await startStub([{ content: JSON.stringify(GOOD_PLAN) }]);
  const { proxy, port } = await startProxy({ stubPort: stub.port });
  try {
    const body = { transcript: "hi", snapshot: SNAPSHOT, context: [] };
    const wrong = await postPlan(port, body, { token: "nope" });
    assert.equal(wrong.status, 401);
    assert.equal(wrong.json.error.code, "UNAUTHORIZED");
    const page = await postPlan(port, body, { origin: "https://evil.test" });
    assert.equal(page.status, 403);
    assert.equal(page.json.error.code, "FORBIDDEN");
    const good = await postPlan(port, body);
    assert.equal(good.status, 200);
    assert.equal(good.json.ok, true);
    assert.equal(stub.seen.length, 1, "only the authenticated call reached upstream");
    assert.equal(stub.seen[0].auth, "Bearer test-key-not-real");
    assert.equal(stub.seen[0].body.model, DEFAULT_MODEL);
    assert.equal(stub.seen[0].body.response_format.type, "json_schema");
    assert.equal(stub.seen[0].body.response_format.json_schema.name, "SeeyablePlan");
  } finally {
    await proxy.close();
    await stub.close();
  }
});

test("timing: stage logs correlate by timing id, time every upstream call and validation, and stay content-free", async () => {
  const logs = [];
  const stub = await startStub([
    { content: JSON.stringify(INVENTED_PLAN) },
    { content: JSON.stringify(GOOD_PLAN) },
  ]);
  const { proxy, port } = await startProxy({ stubPort: stub.port, logs });
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/plan`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + "pairing-token-for-tests",
        Origin: ORIGIN,
        "X-Seeyable-Timing-Id": "cmd-42",
      },
      body: JSON.stringify({ transcript: "fill Full name with Grace Hopper", snapshot: SNAPSHOT, context: [] }),
    });
    const out = await res.json();
    assert.equal(out.ok, true);
    assert.equal(out.repaired, true, "the scripted first plan is invalid so the repair call is exercised");
    const text = logs.join("\n");
    assert.match(text, /timing=cmd-42 plan receipt ms=\d+ bodyBytes=\d+ elements=2/);
    assert.match(text, /timing=cmd-42 upstream call=1 headersMs=\d+ bodyMs=\d+ totalMs=\d+ ok=true/);
    assert.match(text, /timing=cmd-42 validate call=1 ms=\d+ ok=false/);
    assert.match(text, /timing=cmd-42 repair call=2/);
    assert.match(text, /timing=cmd-42 upstream call=2 headersMs=\d+ bodyMs=\d+ totalMs=\d+ ok=true/);
    assert.match(text, /timing=cmd-42 validate call=2 ms=\d+ ok=true/);
    assert.ok(!text.includes("Grace Hopper"), "timing logs never contain transcript content");
    assert.ok(!text.includes("pairing-token-for-tests"), "timing logs never contain the pairing token");
  } finally {
    await proxy.close();
    await stub.close();
  }
});

test("auth: absent Origin proceeds to the mandatory token check", async () => {
  const stub = await startStub([{ content: JSON.stringify(GOOD_PLAN) }]);
  const { proxy, port } = await startProxy({ stubPort: stub.port });
  try {
    // Chrome omits Origin on extension GETs: status must work with the token alone.
    const good = await getStatus(port, { origin: null });
    assert.equal(good.status, 200);
    assert.equal(good.json.ok, true);
    const missing = await getStatus(port, { token: "", origin: null });
    assert.equal(missing.status, 401);
    assert.equal(missing.json.error.code, "UNAUTHORIZED");
    const wrong = await getStatus(port, { token: "wrong-token", origin: null });
    assert.equal(wrong.status, 401);
    assert.equal(wrong.json.error.code, "UNAUTHORIZED");
    // Explicitly foreign origins stay rejected even with a valid token.
    const foreign = await getStatus(port, { origin: "https://evil.test" });
    assert.equal(foreign.status, 403);
    assert.equal(foreign.json.error.code, "FORBIDDEN");
    // POST applies the same uniform rule: absent Origin + valid token works.
    const planned = await postPlan(port, { transcript: "hi", snapshot: SNAPSHOT, context: [] }, { origin: null });
    assert.equal(planned.status, 200);
    assert.equal(planned.json.ok, true);
  } finally {
    await proxy.close();
    await stub.close();
  }
});

test("status reports model and key presence without values", async () => {
  const stub = await startStub([]);
  const { proxy, port } = await startProxy({ stubPort: stub.port });
  try {
    const res = await fetch(`http://${LOOPBACK_HOST}:${port}/v1/status`, {
      headers: { Authorization: "Bearer pairing-token-for-tests", Origin: ORIGIN },
    });
    const json = await res.json();
    assert.equal(json.ok, true);
    assert.equal(json.model, DEFAULT_MODEL);
    assert.equal(json.keyConfigured, true);
    assert.ok(!JSON.stringify(json).includes("test-key"), "status must not carry the key");
  } finally {
    await proxy.close();
    await stub.close();
  }
});

test("valid plan round trip echoes binding and repair flag", async () => {
  const stub = await startStub([{ content: JSON.stringify(GOOD_PLAN) }]);
  const { proxy, port } = await startProxy({ stubPort: stub.port });
  try {
    const { status, json } = await postPlan(port, { transcript: "Fill both names", snapshot: SNAPSHOT, context: [] });
    assert.equal(status, 200);
    assert.deepEqual(json.plan, GOOD_PLAN);
    assert.equal(json.repaired, false);
    assert.equal(json.documentSessionId, "doc-A");
    assert.equal(json.revision, 3);
  } finally {
    await proxy.close();
    await stub.close();
  }
});

test("invalid plan gets exactly one repair, then the repaired plan", async () => {
  const stub = await startStub([{ content: JSON.stringify(INVENTED_PLAN) }, { content: JSON.stringify(GOOD_PLAN) }]);
  const { proxy, port } = await startProxy({ stubPort: stub.port });
  try {
    const { status, json } = await postPlan(port, { transcript: "Do the thing", snapshot: SNAPSHOT, context: [] });
    assert.equal(status, 200);
    assert.equal(json.repaired, true);
    assert.deepEqual(json.plan, GOOD_PLAN);
    assert.equal(stub.seen.length, 2, "initial call plus exactly one repair");
    const repairBody = stub.seen[1].body;
    assert.ok(JSON.stringify(repairBody.messages).includes("UNKNOWN_ID"), "repair carries bounded validation feedback");
    assert.ok(!JSON.stringify(repairBody.messages).includes("sekret-should-never-travel"), "repair feedback never carries step values");
  } finally {
    await proxy.close();
    await stub.close();
  }
});

test("select against listed choices: UNKNOWN_OPTION repair, then the fixed plan", async () => {
  const snapshot = {
    documentSessionId: "doc-A", revision: 3, truncated: { omitted: 0 },
    elements: [{
      id: "el-3", role: "combobox", name: "Your role",
      state: { options: [{ label: "Designer", value: "designer" }, { label: "Product manager", value: "pm" }] },
    }],
  };
  const guessed = {
    version: "seeyable-plan-1", outcome: "steps",
    steps: [{ action: "select", elementId: "el-3", value: "Designer" }],
  };
  const fixed = {
    version: "seeyable-plan-1", outcome: "steps",
    steps: [{ action: "select", elementId: "el-3", value: "designer" }],
  };
  const stub = await startStub([{ content: JSON.stringify(guessed) }, { content: JSON.stringify(fixed) }]);
  const { proxy, port } = await startProxy({ stubPort: stub.port });
  try {
    const { status, json } = await postPlan(port, { transcript: "Choose Designer for Your role", snapshot, context: [] });
    assert.equal(status, 200);
    assert.equal(json.repaired, true);
    assert.deepEqual(json.plan, fixed);
    assert.equal(stub.seen.length, 2, "initial call plus exactly one repair");
    assert.ok(JSON.stringify(stub.seen[1].body.messages).includes("UNKNOWN_OPTION"), "repair names the option error");
  } finally {
    await proxy.close();
    await stub.close();
  }
});

test("two invalid plans stop with PLAN_INVALID and execute nothing", async () => {
  const stub = await startStub([{ content: JSON.stringify(INVENTED_PLAN) }, { content: "{not json" }]);
  const { proxy, port, logs } = await startProxy({ stubPort: stub.port });
  try {
    const { status, json } = await postPlan(port, { transcript: "Do the thing", snapshot: SNAPSHOT, context: [] });
    assert.equal(status, 422);
    assert.equal(json.ok, false);
    assert.equal(json.error.code, "PLAN_INVALID");
    assert.equal(stub.seen.length, 2, "no third attempt, no substitution");
    assert.ok(!JSON.stringify(json).includes("el-99"), "error stays generic; no invented id leaks back");
    assert.ok(!logs.join("\n").includes("Do the thing"), "transcripts stay out of logs");
  } finally {
    await proxy.close();
    await stub.close();
  }
});

test("upstream HTTP statuses map to safe categories with numeric diagnostics", async () => {
  const stub = await startStub([{ status: 401 }, { status: 403 }, { status: 404 }, { status: 429 }, { status: 503 }, { status: 400 }]);
  const logs = [];
  const { proxy, port } = await startProxy({ stubPort: stub.port, logs });
  try {
    const cases = [
      [401, "MODEL_AUTH", /API key/],
      [403, "MODEL_FORBIDDEN", /refused/],
      [404, "MODEL_NOT_FOUND", /no such endpoint or model/],
      [429, "MODEL_RATE_LIMITED", /rate-limiting/],
      [503, "MODEL_UNAVAILABLE", /failed/],
      [400, "MODEL_ERROR", /rejected/],
    ];
    for (const [httpStatus, code, messageRe] of cases) {
      const { status, json } = await postPlan(port, { transcript: "hi", snapshot: SNAPSHOT, context: [] });
      assert.equal(status, 502);
      assert.equal(json.error.code, code);
      assert.equal(json.error.status, httpStatus, "numeric status preserved for the panel");
      assert.match(json.error.message, new RegExp(`HTTP ${httpStatus}`));
      assert.match(json.error.message, messageRe);
      assert.ok(!JSON.stringify(json).includes("account-ish"), "upstream bodies never echo");
    }
    assert.equal(stub.seen.length, 6, "HTTP rejections are never repaired or retried");
    const logText = logs.join("\n");
    for (const [httpStatus, code] of cases) {
      assert.match(logText, new RegExp(`upstream failure code=${code} status=${httpStatus}`));
    }
    assert.match(logText, /#\d+ (timing=\S+ )?upstream failure/, "status logged with the request id");
    assert.ok(!logText.includes("test-key-not-real"), "key never logged");
    assert.ok(!logText.includes("account-ish"), "upstream bodies never logged");
  } finally {
    await proxy.close();
    await stub.close();
  }
});

test("upstream failure and timeout map to safe coded errors", async () => {
  const failing = await startStub([{ status: 500 }]);
  const slow = await startStub([{ delayMs: 300, content: JSON.stringify(GOOD_PLAN) }]);
  const p1 = await startProxy({ stubPort: failing.port });
  const p2 = await startProxy({ stubPort: slow.port, upstreamTimeoutMs: 50 });
  try {
    const body = { transcript: "hi", snapshot: SNAPSHOT, context: [] };
    const failed = await postPlan(p1.port, body);
    assert.equal(failed.status, 502);
    assert.equal(failed.json.error.code, "MODEL_UNAVAILABLE");
    assert.equal(failed.json.error.status, 500);
    assert.ok(!JSON.stringify(failed.json).includes("account-ish"), "upstream diagnostics stay server-side");
    const timed = await postPlan(p2.port, body);
    assert.equal(timed.status, 504);
    assert.equal(timed.json.error.code, "MODEL_TIMEOUT");
  } finally {
    await p1.proxy.close();
    await p2.proxy.close();
    await failing.close();
    await slow.close();
  }
});

test("request limits enforced before any model call", async () => {
  const stub = await startStub([{ content: JSON.stringify(GOOD_PLAN) }]);
  const { proxy, port } = await startProxy({ stubPort: stub.port });
  try {
    const big = { transcript: "x", snapshot: SNAPSHOT, context: [] };
    const empty = await postPlan(port, { ...big, transcript: "  " });
    assert.equal(empty.json.error.code, "BAD_REQUEST");
    const many = {
      ...big,
      transcript: "x",
      snapshot: { ...SNAPSHOT, elements: Array.from({ length: 61 }, (_, i) => ({ id: `el-${i + 1}` })) },
    };
    assert.equal((await postPlan(port, many)).json.error.code, "BAD_REQUEST");
    const unknown = await postPlan(port, { ...big, transcript: "x", approve: true });
    assert.equal(unknown.json.error.code, "BAD_REQUEST");
    const notJson = await postPlan(port, "{oops");
    assert.equal(notJson.json.error.code, "BAD_REQUEST");
    const huge = await postPlan(port, "x".repeat(300 * 1024));
    assert.equal(huge.json.error.code, "BODY_TOO_LARGE");
    const badContext = await postPlan(port, {
      ...big, transcript: "x",
      context: Array.from({ length: 5 }, () => ({ summary: "s", outcome: "o" })),
    });
    assert.equal(badContext.json.error.code, "BAD_REQUEST");
    const rawHistory = await postPlan(port, {
      ...big, transcript: "x",
      context: [{ transcript: "fill Password with hunter2", outcome: "failed" }],
    });
    assert.equal(rawHistory.json.error.code, "BAD_REQUEST", "raw prior transcripts are not valid history");
    assert.equal(stub.seen.length, 0, "no rejected request reaches the model");
  } finally {
    await proxy.close();
    await stub.close();
  }
});

test("missing api key refuses planning with setup guidance", async () => {
  const stub = await startStub([{ content: JSON.stringify(GOOD_PLAN) }]);
  const { proxy, port } = await startProxy({ stubPort: stub.port, apiKey: "" });
  try {
    const { status, json } = await postPlan(port, { transcript: "hi", snapshot: SNAPSHOT, context: [] });
    assert.equal(status, 503);
    assert.equal(json.error.code, "NO_API_KEY");
    assert.match(json.error.message, /MODEL_API_KEY/);
    assert.equal(stub.seen.length, 0, "nothing is faked without credentials");
  } finally {
    await proxy.close();
    await stub.close();
  }
});

test("developer prompt treats page content as untrusted data", () => {
  assert.match(DEVELOPER_PROMPT, /UNTRUSTED\s*\n?\s*DATA/);
  assert.match(DEVELOPER_PROMPT, /Never invent/);
  assert.match(DEVELOPER_PROMPT, /only from the user's own words/i);
  assert.match(DEVELOPER_PROMPT, /Nothing you write approves anything/);
  assert.match(DEVELOPER_PROMPT, /EXACT `value` string/, "select maps the named label to an exact listed value");
  assert.match(DEVELOPER_PROMPT, /optionsOmitted/, "truncated-away choices are declared unavailable");
});

test("upstream: stalled body after immediate headers hits the deadline", async () => {
  let hits = 0;
  const server = http.createServer((req, res) => {
    let text = "";
    req.on("data", (c) => { text += c; });
    req.on("end", () => {
      hits += 1;
      res.writeHead(200, { "Content-Type": "application/json" });
      setTimeout(() => {
        try { res.end(JSON.stringify(chatCompletion(JSON.stringify(GOOD_PLAN)))); } catch { /* client gone */ }
      }, 100);
    });
  });
  await new Promise((resolve) => server.listen(0, LOOPBACK_HOST, resolve));
  const stubPort = server.address().port;
  const { proxy, port } = await startProxy({ stubPort, upstreamTimeoutMs: 20 });
  try {
    const { status, json } = await postPlan(port, { transcript: "hi", snapshot: SNAPSHOT, context: [] });
    assert.equal(status, 504);
    assert.equal(json.error.code, "MODEL_TIMEOUT");
    assert.equal(hits, 1, "a timed-out call is never repaired or retried");
  } finally {
    await proxy.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(() => resolve()));
  }
});

test("proxy: abandoned request aborts upstream promptly; normal requests succeed", async () => {
  let upstreamStartedAt = 0;
  let upstreamAbortedAt = 0;
  let upstreamCalls = 0;
  const server = http.createServer((req, res) => {
    let text = "";
    req.on("data", (c) => { text += c; });
    req.on("end", () => {
      upstreamCalls += 1;
      const held = upstreamCalls === 1; // only the abandoned call is held
      upstreamStartedAt = Date.now();
      let answered = false;
      const timer = setTimeout(() => {
        answered = true;
        try { res.end(JSON.stringify(chatCompletion(JSON.stringify(GOOD_PLAN)))); } catch { /* gone */ }
      }, held ? 5000 : 0);
      res.on("close", () => {
        if (!answered) upstreamAbortedAt = Date.now();
        clearTimeout(timer);
      });
    });
  });
  await new Promise((resolve) => server.listen(0, LOOPBACK_HOST, resolve));
  const stubPort = server.address().port;
  const logs = [];
  const { proxy, port } = await startProxy({ stubPort, logs });
  const waitFor = async (fn, label) => {
    const t0 = Date.now();
    while (Date.now() - t0 < 5000) {
      if (fn()) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`timeout waiting for ${label}`);
  };
  try {
    // Abandon the client request after upstream work begins.
    const payload = JSON.stringify({ transcript: "fill both names", snapshot: SNAPSHOT, context: [] });
    const client = http.request({
      host: LOOPBACK_HOST, port, path: "/v1/plan", method: "POST",
      headers: {
        "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload),
        Authorization: "Bearer pairing-token-for-tests", Origin: ORIGIN,
      },
    });
    client.on("error", () => {}); // destroying is the point
    client.end(payload);
    await waitFor(() => upstreamStartedAt > 0, "upstream start");
    client.destroy();
    const destroyAt = Date.now();
    await waitFor(() => upstreamAbortedAt > 0, "upstream abort");
    assert.ok(upstreamAbortedAt - destroyAt < 3000, `upstream aborted promptly (${upstreamAbortedAt - destroyAt}ms), not at its own timeout`);
    assert.equal(upstreamCalls, 1, "no repair attempt, no replay after abandonment");
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(!logs.join("\n").includes("internal error"), "abandonment leaves no uncaught error");
    // The proxy is healthy afterwards: a normal request succeeds.
    upstreamStartedAt = 0;
    const good = await postPlan(port, { transcript: "hi", snapshot: SNAPSHOT, context: [] });
    assert.equal(good.status, 200);
    assert.equal(good.json.ok, true);
  } finally {
    await proxy.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(() => resolve()));
  }
});

test("unknown routes 404 without auth probing side effects", async () => {
  const stub = await startStub([]);
  const { proxy, port } = await startProxy({ stubPort: stub.port });
  try {
    const res = await fetch(`http://${LOOPBACK_HOST}:${port}/v1/bogus`, {
      headers: { Authorization: "Bearer pairing-token-for-tests", Origin: ORIGIN },
    });
    assert.equal(res.status, 404);
    assert.equal(stub.seen.length, 0);
  } finally {
    await proxy.close();
    await stub.close();
  }
});
