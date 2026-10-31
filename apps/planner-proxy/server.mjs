#!/usr/bin/env node
"use strict";
/*
 * Issue #14: local planner proxy for Seeyable.
 *
 * The ONLY component that holds MODEL_API_KEY and contacts the Meta Model
 * API (Chat Completions, muse-spark-1.3 by default). The extension POSTs
 * { transcript, pruned snapshot, context } with a runtime pairing token
 * and gets back a validated plan — never keys, transcripts, or upstream
 * diagnostics.
 *
 * Usage: node server.mjs [--port 6124]
 *   MODEL_API_KEY=...        Meta Model API key (required for /v1/plan;
 *                            WITHOUT it the proxy runs but planning is
 *                            refused with NO_API_KEY — never a fake plan)
 *   SEEYABLE_MODEL=...       model override (default muse-spark-1.3)
 *   SEEYABLE_MODEL_BASE_URL  upstream override (default
 *                            https://api.meta.ai/v1; tests point this at
 *                            a local stub — callers can never steer it)
 *   SEEYABLE_PLANNER_TOKEN=  pairing-token override (local dev only)
 *
 * Diagnostics go to stderr and carry ids/codes/counts only. The pairing
 * token is printed once at startup so the operator can paste it into the
 * extension's Developer view; it is never logged again.
 */
import { createProxy, DEFAULT_PORT, LOOPBACK_HOST } from "./lib/proxy.mjs";

const errlog = (...args) => console.error(...args);

function parsePort(argv) {
  const i = argv.indexOf("--port");
  if (i === -1) return DEFAULT_PORT;
  const p = Number(argv[i + 1]);
  if (!Number.isInteger(p) || p < 1 || p > 65535) throw new Error(`Invalid --port: ${argv[i + 1]}`);
  return p;
}

async function main() {
  const port = parsePort(process.argv.slice(2));
  const proxy = createProxy({
    port,
    token: process.env.SEEYABLE_PLANNER_TOKEN || undefined, // undefined => generated
    apiKey: process.env.MODEL_API_KEY || "",
    model: process.env.SEEYABLE_MODEL || undefined,
    baseUrl: process.env.SEEYABLE_MODEL_BASE_URL || undefined,
    log: errlog,
  });
  await proxy.start();
  errlog(`[seeyable-planner] listening on ${LOOPBACK_HOST}:${port} (loopback only)`);
  errlog(`[seeyable-planner] model: ${proxy.model}`);
  if (!process.env.MODEL_API_KEY) {
    errlog("[seeyable-planner] MODEL_API_KEY is NOT set: /v1/plan will refuse with NO_API_KEY until it is provided.");
  }
  errlog("[seeyable-planner] pairing token (paste into the extension Developer view, planner section):");
  errlog(proxy.token);

  const shutdown = async () => {
    errlog("[seeyable-planner] shutting down");
    try { await proxy.close(); } catch {}
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => { errlog(`[seeyable-planner] fatal: ${err && err.message ? err.message : err}`); process.exit(1); });
