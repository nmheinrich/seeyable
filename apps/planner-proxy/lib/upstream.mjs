"use strict";
/* Meta Model API client (Chat Completions, OpenAI-compatible).
 *
 * Verified against the official docs (fetched 2026-10-30):
 *  - POST {base}/chat/completions, Bearer MODEL_API_KEY auth
 *  - developer role carries planner instructions (highest precedence)
 *  - structured output via response_format { type: "json_schema",
 *    json_schema: { name, schema } } with constrained decoding
 *  - generated text at choices[0].message.content (non-streaming)
 * Docs: https://dev.meta.ai/docs/protocols/chat-completions
 *       https://dev.meta.ai/docs/structured-output
 *
 * Chat Completions was chosen over Responses because planner calls are
 * single-shot turns (transcript + snapshot -> plan) with no reasoning
 * continuity or tool loops; the docs recommend Chat Completions there.
 *
 * This module never logs prompts, completions, keys, or upstream bodies.
 * Upstream failures map to stable codes; raw diagnostics stay server-side.
 */

export class UpstreamError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    // Numeric upstream HTTP status when the failure IS one; undefined for
    // timeouts, cancellations, and unreadable responses. Safe to log and
    // to return: a number proves nothing beyond the status itself.
    if (Number.isInteger(status)) this.status = status;
  }
}

// Status-derived categories. Each message states only what its status
// proves — never key validity beyond a 401, never quota details, never
// upstream body content.
function httpFailure(status) {
  const tag = `(HTTP ${status})`;
  if (status === 401) {
    return new UpstreamError("MODEL_AUTH",
      `The model service rejected the proxy's API key ${tag}. Check MODEL_API_KEY in the proxy environment, then restart the proxy.`,
      status);
  }
  if (status === 403) {
    return new UpstreamError("MODEL_FORBIDDEN",
      `The model service refused the request ${tag}. The key may lack access to this model or endpoint.`,
      status);
  }
  if (status === 404) {
    return new UpstreamError("MODEL_NOT_FOUND",
      `The model service has no such endpoint or model ${tag}. Check the proxy's model and base-URL configuration.`,
      status);
  }
  if (status === 429) {
    return new UpstreamError("MODEL_RATE_LIMITED",
      `The model service is rate-limiting requests ${tag}. Wait a little and send the command again.`,
      status);
  }
  if (status >= 500 && status <= 599) {
    return new UpstreamError("MODEL_UNAVAILABLE",
      `The model service failed ${tag}. Nothing was planned; try again later.`,
      status);
  }
  return new UpstreamError("MODEL_ERROR",
    `The model service rejected the request ${tag}. Nothing was planned.`,
    status);
}

function normalizeBaseUrl(raw) {
  const fallback = "https://api.meta.ai/v1";
  const text = typeof raw === "string" && raw.trim() ? raw.trim() : fallback;
  return text.replace(/\/+$/, "");
}

export function createUpstreamClient({ apiKey, baseUrl, model, timeoutMs = 20000, fetchImpl } = {}) {
  const base = normalizeBaseUrl(baseUrl);
  const fetchFn = fetchImpl || globalThis.fetch;
  if (typeof fetchFn !== "function") throw new Error("upstream client requires a fetch implementation");

  async function complete({ messages, responseFormat, signal, onTiming }) {
    // Content-free timing: stage durations only (headers, full-body
    // consumption, total). No messages, content, or headers are reported.
    const timingStarted = Date.now();
    let timingHeadersMs = null;
    let timingOk = false;
    const controller = new AbortController();
    // One deadline governs headers AND body: it stays armed until the full
    // response is consumed, and the timer plus every listener is released
    // on all exits. A caller-aborted signal is CANCELLED; an expired
    // deadline with a live caller signal is MODEL_TIMEOUT — in both phases.
    let timer = null;
    let timedOut = false;
    let fireTimeout = null;
    const timeoutPromise = new Promise((_, reject) => { fireTimeout = reject; });
    timeoutPromise.catch(() => {}); // race losers must never warn as unhandled
    let onCallerAbort = null;
    const cancelPromise = new Promise((_, reject) => {
      if (!signal) return; // no caller signal: only the deadline governs
      if (signal.aborted) {
        reject(new UpstreamError("CANCELLED", "The model request was cancelled."));
        return;
      }
      onCallerAbort = () => reject(new UpstreamError("CANCELLED", "The model request was cancelled."));
      signal.addEventListener("abort", onCallerAbort, { once: true });
    });
    cancelPromise.catch(() => {});
    timer = setTimeout(() => {
      timedOut = true;
      try { controller.abort(); } catch { /* already settled */ }
      fireTimeout(new UpstreamError("MODEL_TIMEOUT", "The model request timed out."));
    }, timeoutMs);
    const combined = signal
      ? AbortSignal.any([signal, controller.signal])
      : controller.signal;
    const cleanup = () => {
      if (timer) { clearTimeout(timer); timer = null; }
      if (signal && onCallerAbort) {
        try { signal.removeEventListener("abort", onCallerAbort); } catch { /* gone */ }
        onCallerAbort = null;
      }
    };
    try {
      let res;
      try {
        res = await fetchFn(`${base}/chat/completions`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ model, messages, response_format: responseFormat }),
          signal: combined,
        });
      } catch (err) {
        if (err && err.name === "AbortError") {
          throw new UpstreamError(signal && signal.aborted ? "CANCELLED" : "MODEL_TIMEOUT", "The model request timed out.");
        }
        throw new UpstreamError("MODEL_ERROR", "The model request failed before completing.");
      }
      timingHeadersMs = Date.now() - timingStarted;
      if (!res.ok) {
        // The numeric status is preserved as the safe diagnostic; bodies
        // may carry quota or account details the browser must never see.
        // No retries: auth and HTTP rejections are returned as-is.
        throw httpFailure(res.status);
      }
      let payload = null;
      try {
        // Headers alone do not stop the clock: the body read races the
        // same deadline and caller cancellation.
        payload = await Promise.race([res.json(), timeoutPromise, cancelPromise]);
      } catch (err) {
        if (signal && signal.aborted) throw new UpstreamError("CANCELLED", "The model request was cancelled.");
        if (timedOut) throw new UpstreamError("MODEL_TIMEOUT", "The model request timed out.");
        if (err instanceof UpstreamError) throw err;
        throw new UpstreamError("MODEL_ERROR", "The model service returned an unreadable response.");
      }
      const content = payload
        && Array.isArray(payload.choices)
        && payload.choices[0]
        && payload.choices[0].message
        && typeof payload.choices[0].message.content === "string"
        ? payload.choices[0].message.content
        : null;
      if (content === null) {
        throw new UpstreamError("MODEL_ERROR", "The model service returned no usable content.");
      }
      timingOk = true;
      return content;
    } finally {
      cleanup();
      if (typeof onTiming === "function") {
        const totalMs = Date.now() - timingStarted;
        try {
          onTiming({
            headersMs: timingHeadersMs,
            bodyMs: timingHeadersMs === null ? null : totalMs - timingHeadersMs,
            totalMs,
            ok: timingOk,
          });
        } catch { /* diagnostics never affect the request */ }
      }
    }
  }

  return { complete, model, baseUrl: base, timeoutMs };
}
