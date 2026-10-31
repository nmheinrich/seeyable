# Seeyable planner proxy (Issue #14)

Loopback-only HTTP service. The **only** component that holds
`MODEL_API_KEY` and contacts the Meta Model API. The extension POSTs
`{ transcript, snapshot (pruned), context }` with a runtime pairing
token and gets back a validated plan — or a safe, stable-coded error.

Upstream: Chat Completions (`POST {base}/chat/completions`, model
`muse-spark-1.3` by default) with constrained JSON-schema decoding.
Verified against https://dev.meta.ai/docs/protocols/chat-completions and
https://dev.meta.ai/docs/structured-output (2026-10-30).

## Run it

```sh
# From the repository root. The key lives ONLY in this process.
MODEL_API_KEY=$MODEL_API_KEY node apps/planner-proxy/server.mjs [--port 6124]
```

On startup it prints the pairing token **once** to stderr — paste it into
the extension's Developer view, planner section. It is never logged again.

Optional environment (defaults shown):

```sh
SEEYABLE_MODEL=muse-spark-1.3        # explicit, configurable model setting
SEEYABLE_MODEL_BASE_URL=https://api.meta.ai/v1   # fixed server-side; tests point it at a stub
SEEYABLE_PLANNER_TOKEN=              # generated when unset; override for local dev only
```

Copy `.env.example` to `.env` (git-ignored) for local convenience. Never
commit real values. If `MODEL_API_KEY` is unset, the proxy still runs but
`/v1/plan` refuses with `NO_API_KEY` — it never fakes a plan.

## Endpoints (all require the pairing token; foreign origins refused)

- `POST /v1/plan` — body `{ transcript (≤2000 chars), snapshot:
  { documentSessionId, revision, elements[1..60] }, context (≤4 entries
  of `{ summary ≤300, outcome ≤200 }`; raw prior transcripts are
  rejected) }`.
  Returns `{ ok: true, plan, repaired, documentSessionId, revision }` or
  `{ ok: false, error: { code, message } }`.
- `GET /v1/status` — `{ ok: true, model, keyConfigured, version }`.
  `keyConfigured` is a boolean; the key itself never leaves the process.

Error codes: `UNAUTHORIZED`, `FORBIDDEN`, `BAD_REQUEST`,
`BODY_TOO_LARGE` (256 KiB), `NO_API_KEY`, `MODEL_TIMEOUT` (20 s per
upstream call), `PLAN_INVALID` (after one repair attempt), and upstream
HTTP failures: `MODEL_AUTH` (401), `MODEL_FORBIDDEN` (403),
`MODEL_NOT_FOUND` (404), `MODEL_RATE_LIMITED` (429),
`MODEL_UNAVAILABLE` (5xx), `MODEL_ERROR` (anything else). Upstream
failures carry a numeric `status` and a message naming it; bodies are
never echoed. No retries on auth or HTTP rejection.

## Trust boundaries

- Binds `127.0.0.1` only. The upstream destination is fixed server-side;
  callers cannot steer requests elsewhere.
- Authentication is the pairing token (`Authorization: Bearer`,
  timing-safe compare). The `chrome-extension://` origin check is
  defense-in-depth, not authentication: an absent origin (Chrome
  omits it on extension GETs) still faces the token check, while an
  explicitly foreign origin is rejected outright.
- Plans are validated twice: here (against the exact pruned snapshot the
  model saw) and in the extension (against the live snapshot). Invalid
  output gets **one** repair call with bounded, value-free feedback;
  then the proxy returns `PLAN_INVALID` and the panel asks the user.
- Logs (stderr) carry request ids, codes, element/step counts, and
  durations only — never keys, tokens, transcripts, values, snapshots,
  upstream bodies, or reasoning.

## Tests

```sh
npm --prefix apps/planner-proxy test   # 10 tests; stub upstream, no credentials
```
