"use strict";
/* Planner proxy HTTP service (Issue #14).
 *
 * The ONLY component that holds MODEL_API_KEY and contacts Meta. The
 * extension POSTs { transcript, snapshot (pruned), context } and gets
 * back a validated plan — or a safe, stable-coded error.
 *
 * Trust boundaries (mirroring the Issue #28 bridge):
 *  - Loopback bind only (127.0.0.1); never 0.0.0.0.
 *  - Runtime pairing token via Authorization: Bearer, compared with
 *    timingSafeEqual. Printed once at startup for the operator; the
 *    SEEYABLE_PLANNER_TOKEN env override exists for local dev.
 *  - Origin must look like chrome-extension:// — defense in depth,
 *    NOT authentication. The token is the auth.
 *  - The upstream destination is fixed server-side
 *    (SEEYABLE_MODEL_BASE_URL, default https://api.meta.ai/v1);
 *    callers cannot steer requests anywhere else.
 *  - Keys, auth headers, raw upstream diagnostics, hidden reasoning,
 *    transcripts, values, and snapshots never leave in responses and
 *    never enter logs. Logs carry ids, codes, counts, durations only.
 */

import http from "node:http";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { DEVELOPER_PROMPT, buildUserContent, buildRepairContent } from "./prompt.mjs";
import { createUpstreamClient, UpstreamError } from "./upstream.mjs";

const require = createRequire(import.meta.url);
const SharedPlan = require("../../../packages/shared/plan-schema.js");

export const LOOPBACK_HOST = "127.0.0.1";
export const DEFAULT_PORT = 6124;
export const DEFAULT_MODEL = "muse-spark-1.3";
export const MAX_BODY_BYTES = 256 * 1024;
export const MAX_TRANSCRIPT_CHARS = 2000;
export const MAX_SNAPSHOT_ELEMENTS = 60;
export const MAX_CONTEXT_ENTRIES = 4;
export const MAX_CONTEXT_SUMMARY = 300;
export const MAX_CONTEXT_OUTCOME = 200;
export const UPSTREAM_TIMEOUT_MS = 20000;

export function generatePairingToken() {
  return crypto.randomBytes(24).toString("base64url");
}

function safeEqualText(a, b) {
  const ab = Buffer.from(String(a || ""), "utf8");
  const bb = Buffer.from(String(b || ""), "utf8");
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// Incoming request validation. Rejects oversized/malformed input BEFORE
// any model call. Error messages are stable and content-free.
function validatePlanRequest(body) {
  if (!isPlainObject(body)) return { ok: false, code: "BAD_REQUEST", message: "Request must be a JSON object." };
  for (const key of Object.keys(body)) {
    if (key !== "transcript" && key !== "snapshot" && key !== "context") {
      return { ok: false, code: "BAD_REQUEST", message: `Unknown request field: ${key}.` };
    }
  }
  if (typeof body.transcript !== "string" || !body.transcript.trim()) {
    return { ok: false, code: "BAD_REQUEST", message: "transcript must be a non-empty string." };
  }
  if (body.transcript.length > MAX_TRANSCRIPT_CHARS) {
    return { ok: false, code: "BAD_REQUEST", message: "transcript exceeds the length limit." };
  }
  const snap = body.snapshot;
  if (!isPlainObject(snap) || typeof snap.documentSessionId !== "string" || !snap.documentSessionId
    || !Number.isInteger(snap.revision) || !Array.isArray(snap.elements)) {
    return { ok: false, code: "BAD_REQUEST", message: "snapshot must carry documentSessionId, revision, and elements." };
  }
  if (snap.elements.length === 0 || snap.elements.length > MAX_SNAPSHOT_ELEMENTS) {
    return { ok: false, code: "BAD_REQUEST", message: `snapshot must list 1 to ${MAX_SNAPSHOT_ELEMENTS} elements.` };
  }
  for (let i = 0; i < snap.elements.length; i++) {
    const el = snap.elements[i];
    if (!isPlainObject(el) || typeof el.id !== "string" || !/^el-[0-9]+$/.test(el.id)) {
      return { ok: false, code: "BAD_REQUEST", message: `snapshot element ${i} has a malformed id.` };
    }
  }
  if (body.context !== undefined) {
    if (!Array.isArray(body.context) || body.context.length > MAX_CONTEXT_ENTRIES) {
      return { ok: false, code: "BAD_REQUEST", message: "context must list at most 4 entries." };
    }
    for (let i = 0; i < body.context.length; i++) {
      const entry = body.context[i];
      // History entries are structured { summary, outcome } parts — raw
      // prior transcripts are never accepted, so retained values cannot
      // ride along with history. (The CURRENT request transcript above
      // is the user's explicit planning input.)
      if (!isPlainObject(entry)
        || typeof entry.summary !== "string" || entry.summary.length > MAX_CONTEXT_SUMMARY
        || typeof entry.outcome !== "string" || entry.outcome.length > MAX_CONTEXT_OUTCOME) {
        return { ok: false, code: "BAD_REQUEST", message: `context entry ${i} is malformed or oversized.` };
      }
      for (const key of Object.keys(entry)) {
        if (key !== "summary" && key !== "outcome") {
          return { ok: false, code: "BAD_REQUEST", message: `context entry ${i} has an unknown field.` };
        }
      }
    }
  }
  return { ok: true };
}

function sendJson(res, status, payload) {
  const text = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(text),
    "Cache-Control": "no-store",
  });
  res.end(text);
}

export function createProxy({
  port = DEFAULT_PORT,
  token,
  apiKey,
  model = DEFAULT_MODEL,
  baseUrl,
  upstreamTimeoutMs = UPSTREAM_TIMEOUT_MS,
  log = () => {},
  fetchImpl,
} = {}) {
  const pairingToken = token || generatePairingToken();
  const upstream = createUpstreamClient({ apiKey, baseUrl, model, timeoutMs: upstreamTimeoutMs, fetchImpl });
  let server = null;
  let requestSeq = 0;
  let shuttingDown = false;

  const responseFormat = {
    type: "json_schema",
    json_schema: { name: "SeeyablePlan", schema: SharedPlan.PLAN_SCHEMA },
  };

  function checkAuth(req) {
    // Origin is defense-in-depth, never authentication: Chrome omits it on
    // some legitimate extension requests (notably GETs like /v1/status),
    // so an ABSENT origin proceeds to the mandatory token check. An
    // explicitly foreign origin is still rejected outright.
    const origin = req.headers.origin === undefined ? null : String(req.headers.origin);
    if (origin !== null && !origin.startsWith("chrome-extension://")) {
      return { ok: false, status: 403, code: "FORBIDDEN", message: "Extension origin required." };
    }
    const header = String(req.headers.authorization || "");
    const presented = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
    if (!safeEqualText(presented, pairingToken)) {
      return { ok: false, status: 401, code: "UNAUTHORIZED", message: "Bad or missing pairing token." };
    }
    return { ok: true };
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      let tooLarge = false;
      req.on("data", (chunk) => {
        if (tooLarge) return; // drain the rest so the 413 below is deliverable
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          tooLarge = true;
          chunks.length = 0;
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => {
        if (tooLarge) reject(Object.assign(new Error("body too large"), { code: "BODY_TOO_LARGE" }));
        else resolve(Buffer.concat(chunks).toString("utf8"));
      });
      req.on("error", reject);
    });
  }

  // One repair attempt, bounded: same snapshot, error codes/locations only.
  // Returns { plan, repaired } or throws a coded error for the caller.
  async function planWithRepair({ transcript, snapshot, context, elements, signal, reqId }) {
    const messages = [
      { role: "developer", content: DEVELOPER_PROMPT },
      { role: "user", content: buildUserContent({ transcript, snapshot, context }) },
    ];
    const raw = await upstream.complete({ messages, responseFormat, signal });
    let plan = null;
    try {
      plan = JSON.parse(raw);
    } catch {
      plan = null;
    }
    let validation = plan === null
      ? { ok: false, errors: [{ code: "SCHEMA", detail: "model output was not valid JSON" }] }
      : SharedPlan.validatePlan(plan, elements);
    if (validation.ok) {
      log(`[planner-proxy] #${reqId} plan ok without repair`);
      return { plan, repaired: false };
    }
    log(`[planner-proxy] #${reqId} initial plan invalid (${validation.errors.map((e) => e.code).join(",")}); one repair attempt`);
    const repairMessages = [
      { role: "developer", content: DEVELOPER_PROMPT },
      { role: "user", content: buildUserContent({ transcript, snapshot, context }) },
      { role: "assistant", content: "[withheld invalid plan]" },
      { role: "user", content: buildRepairContent({ transcript, snapshot, errors: validation.errors.slice(0, 8) }) },
    ];
    const retryRaw = await upstream.complete({ messages: repairMessages, responseFormat, signal });
    let retryPlan = null;
    try {
      retryPlan = JSON.parse(retryRaw);
    } catch {
      retryPlan = null;
    }
    validation = retryPlan === null
      ? { ok: false, errors: [{ code: "SCHEMA", detail: "model output was not valid JSON" }] }
      : SharedPlan.validatePlan(retryPlan, elements);
    if (validation.ok) {
      log(`[planner-proxy] #${reqId} plan ok after repair`);
      return { plan: retryPlan, repaired: true };
    }
    log(`[planner-proxy] #${reqId} repair failed (${validation.errors.map((e) => e.code).join(",")}); asking user`);
    throw new UpstreamError("PLAN_INVALID", "The planner could not produce a safe plan. Please rephrase or pick a target manually.");
  }

  async function handlePlan(req, res, reqId) {
    let text;
    try {
      text = await readBody(req);
    } catch (err) {
      if (err && err.code === "BODY_TOO_LARGE") {
        sendJson(res, 413, { ok: false, error: { code: "BODY_TOO_LARGE", message: "Request body exceeds the size limit." } });
        return;
      }
      throw err;
    }
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      sendJson(res, 400, { ok: false, error: { code: "BAD_REQUEST", message: "Request must be valid JSON." } });
      return;
    }
    const checked = validatePlanRequest(body);
    if (!checked.ok) {
      sendJson(res, 400, { ok: false, error: { code: checked.code, message: checked.message } });
      return;
    }
    if (!apiKey) {
      sendJson(res, 503, {
        ok: false,
        error: {
          code: "NO_API_KEY",
          message: "The planner proxy has no MODEL_API_KEY. Set it in the proxy environment and restart; see apps/planner-proxy/README.md.",
        },
      });
      return;
    }
    // Abort upstream work if the browser abandons the response. This MUST
    // watch the RESPONSE lifecycle: the request stream already closed when
    // its body was consumed, so req 'close' cannot detect abandonment.
    // res 'close' fires both on abandonment and after a normal send — the
    // completed flag distinguishes the two.
    const abort = new AbortController();
    let completed = false;
    const onResClose = () => { if (!completed) abort.abort(); };
    res.on("close", onResClose);
    const started = Date.now();
    try {
      const { plan, repaired } = await planWithRepair({
        transcript: body.transcript,
        snapshot: body.snapshot,
        context: body.context || [],
        elements: body.snapshot.elements,
        signal: abort.signal,
        reqId,
      });
      const steps = plan.outcome === "steps" ? plan.steps.length : 0;
      log(`[planner-proxy] #${reqId} ${plan.outcome} steps=${steps} repaired=${repaired} elements=${body.snapshot.elements.length} ms=${Date.now() - started}`);
      sendJson(res, 200, {
        ok: true,
        plan,
        repaired,
        documentSessionId: body.snapshot.documentSessionId,
        revision: body.snapshot.revision,
      });
    } catch (err) {
      // Abandonment surfaces as CANCELLED from the in-flight upstream
      // call: never a repair attempt (the throw skips it), never a replay,
      // and nothing is written to the dead socket.
      if (err && err.code === "CANCELLED") return;
      if (err instanceof UpstreamError) {
        const status = err.code === "MODEL_TIMEOUT" ? 504 : err.code === "PLAN_INVALID" ? 422 : 502;
        // The numeric upstream status is the safe diagnostic: logged with
        // the request id, returned to the panel for display. Bodies, keys,
        // and headers are never logged or returned.
        log(`[planner-proxy] #${reqId} upstream failure code=${err.code} status=${Number.isInteger(err.status) ? err.status : "-"}`);
        const error = { code: err.code, message: err.message };
        if (Number.isInteger(err.status)) error.status = err.status;
        sendJson(res, status, { ok: false, error });
        return;
      }
      throw err;
    } finally {
      completed = true;
      res.removeListener("close", onResClose);
    }
  }

  function requestListener(req, res) {
    const reqId = ++requestSeq;
    (async () => {
      try {
        const url = new URL(req.url || "/", `http://${LOOPBACK_HOST}`);
        if (req.method === "GET" && url.pathname === "/v1/status") {
          const auth = checkAuth(req);
          if (!auth.ok) {
            log(`[planner-proxy] #${reqId} status denied (${auth.code})`);
            sendJson(res, auth.status, { ok: false, error: { code: auth.code, message: auth.message } });
            return;
          }
          sendJson(res, 200, { ok: true, model, keyConfigured: Boolean(apiKey), version: "0.1.0" });
          return;
        }
        if (req.method === "POST" && url.pathname === "/v1/plan") {
          const auth = checkAuth(req);
          if (!auth.ok) {
            log(`[planner-proxy] #${reqId} plan denied (${auth.code})`);
            sendJson(res, auth.status, { ok: false, error: { code: auth.code, message: auth.message } });
            return;
          }
          await handlePlan(req, res, reqId);
          return;
        }
        sendJson(res, 404, { ok: false, error: { code: "NOT_FOUND", message: "Unknown planner-proxy endpoint." } });
      } catch (err) {
        log(`[planner-proxy] #${reqId} internal error: ${err && err.code ? err.code : "unknown"}`);
        try {
          sendJson(res, 500, { ok: false, error: { code: "INTERNAL_ERROR", message: "The planner proxy failed unexpectedly." } });
        } catch { /* socket already gone */ }
      }
    })();
  }

  async function start() {
    await new Promise((resolve, reject) => {
      server = http.createServer(requestListener);
      server.on("error", reject);
      server.listen(port, LOOPBACK_HOST, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    const bound = server.address() && server.address().port ? server.address().port : port;
    return { host: LOOPBACK_HOST, port: bound };
  }

  async function close() {
    if (shuttingDown) return;
    shuttingDown = true;
    if (!server) return;
    await new Promise((resolve) => server.close(() => resolve()));
    server = null;
  }

  return { start, close, token: pairingToken, port, model };
}
