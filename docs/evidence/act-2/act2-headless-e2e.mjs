// Issue #20 Act 2 independent verification (headless Chrome, real
// extension, real MCP server over stdio, custom JSON-RPC client — NOT
// Claude Desktop and NOT an Inspector GUI run). Cancel-only: this
// harness never approves the held Submit.
//
// Isolation contract: it uses an ephemeral Chrome profile, an isolated
// MCP bridge port/token/state directory, and child processes it spawned
// itself. It never reads the user's Claude/client configuration, never
// uses the live 6123 pairing, and never kills processes it did not spawn.
// Run `npm --prefix apps/mcp-server ci` first (the harness imports the
// already-installed `ws` package from that app). Exact invocation and
// setup are documented in README.md in this directory.
import { spawn } from "child_process";
import { randomBytes } from "crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { createServer } from "net";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import WebSocket from "../../../apps/mcp-server/node_modules/ws/wrapper.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "../../..");
const EVIDENCE_DIR = process.env.ACT2_EVIDENCE_DIR || HERE;
const CHROME = process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const TOKEN = randomBytes(32).toString("hex"); // ephemeral; never printed or written to evidence
mkdirSync(EVIDENCE_DIR, { recursive: true });

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}
const PORT = await freePort();
const HTTP = await freePort();
const BRIDGE_PORT = await freePort();
const TMP = mkdtempSync(join(tmpdir(), "seeyable-act2-"));
const PROFILE = join(TMP, "chrome-profile");
const STATE_DIR = join(TMP, "mcp-state");

const results = [];
const toolEvents = [];
const check = (name, ok, detail) => { results.push({ name, ok, detail: detail || "" }); console.log((ok ? "PASS " : "FAIL ") + name + (detail ? " — " + detail : "")); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const saveShot = async (client, name) => {
  await client.send("Page.enable");
  const shot = await client.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  writeFileSync(`${EVIDENCE_DIR}/${name}`, Buffer.from(shot.data, "base64"));
};

const server = spawn("python3", ["-m", "http.server", String(HTTP), "--bind", "127.0.0.1", "--directory", join(ROOT, "apps")], { stdio: "ignore" });
const mcp = spawn("node", [join(ROOT, "apps/mcp-server/server.mjs"), "--port", String(BRIDGE_PORT)], {
  env: { ...process.env, SEEYABLE_BRIDGE_TOKEN: TOKEN, SEEYABLE_STATE_DIR: STATE_DIR, SEEYABLE_BRIDGE_IDLE_MS: "1000" },
  stdio: ["pipe", "pipe", "pipe"],
});
let stderrBuf = "";
mcp.stderr.on("data", (d) => { stderrBuf += String(d); });
let rpcId = 0;
const rpcPending = new Map();
let stdoutBuf = "";
mcp.stdout.on("data", (d) => {
  stdoutBuf += String(d);
  let i;
  while ((i = stdoutBuf.indexOf("\n")) >= 0) {
    const line = stdoutBuf.slice(0, i).trim();
    stdoutBuf = stdoutBuf.slice(i + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.id !== undefined && rpcPending.has(msg.id)) {
      const { resolve, reject } = rpcPending.get(msg.id);
      rpcPending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    }
  }
});
const rpc = (method, params) => new Promise((resolve, reject) => {
  const id = ++rpcId;
  rpcPending.set(id, { resolve, reject });
  mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  setTimeout(() => { if (rpcPending.delete(id)) reject(new Error("rpc timeout " + method)); }, 25000);
});
const notify = (method) => mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", method }) + "\n");

function connect(wsUrl) { const ws = new WebSocket(wsUrl); let id = 0; const pending = new Map(); const ready = new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; }); ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { const { resolve, reject } = pending.get(m.id); pending.delete(m.id); m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result); } }; const send = (method, params = {}) => new Promise((resolve, reject) => { const mid = ++id; pending.set(mid, { resolve, reject }); ws.send(JSON.stringify({ id: mid, method, params })); }); const evaluate = async (expr) => { const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error("eval " + JSON.stringify(r.exceptionDetails).slice(0, 300)); return r.result.value; }; return { ws, ready, send, evaluate }; }
async function listTargets() { return fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json()); }
async function waitFor(fn, label, timeout = 30000) { const t0 = Date.now(); while (Date.now() - t0 < timeout) { const v = await fn().catch(() => null); if (v) return v; await sleep(300); } throw new Error("timeout " + label); }

const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`, "--no-first-run", "--disable-gpu", "--enable-unsafe-extension-debugging", "--window-size=1280,900", "about:blank"], { stdio: "ignore" });
try {
  await waitFor(async () => stderrBuf.includes("stdio transport connected"), "mcp-ready");
  const ver = await waitFor(async () => fetch(`http://127.0.0.1:${PORT}/json/version`).then((r) => r.json()), "version");
  const browser = connect(ver.webSocketDebuggerUrl); await browser.ready;
  const loaded = await browser.send("Extensions.loadUnpacked", { path: join(ROOT, "apps/extension") });
  check("extension loads unpacked", Boolean(loaded.id));
  const demoCreated = await fetch(`http://127.0.0.1:${PORT}/json/new?` + encodeURIComponent(`http://127.0.0.1:${HTTP}/demo-survey/index.html`), { method: "PUT" }).then((r) => r.json());
  const demoT = await waitFor(async () => (await listTargets()).find((x) => x.id === demoCreated.id), "demo");
  const demo = connect(demoT.webSocketDebuggerUrl); await demo.ready;
  await waitFor(async () => demo.evaluate("document.readyState").then((s) => (s === "complete" ? s : null)).catch(() => null), "demo-load");
  // Harness-only submission instrumentation on the synthetic fixture:
  // CDP installs a submit listener that prevents navigation and counts
  // submit events in `window.__submitCount`. The MCP client never sees
  // or uses this; it is how the harness independently proves that a held
  // or cancelled Submit dispatched zero times.
  await demo.evaluate("window.__submitCount = 0; document.getElementById('survey').addEventListener('submit', (e) => { e.preventDefault(); window.__submitCount += 1; }); 'x'");
  await sleep(1500);

  // Keep the demo as the active tab while the panel page loads in the
  // background. A genuine Chrome side panel is not a tab; activating the
  // panel page itself would make the harness, not the product, ask the
  // panel to snapshot an extension page with no content script.
  const created = await browser.send("Target.createTarget", { url: `chrome-extension://${loaded.id}/sidepanel.html`, background: true });
  const pt = await waitFor(async () => (await listTargets()).find((x) => x.id === created.targetId), "panel");
  const panel = connect(pt.webSocketDebuggerUrl); await panel.ready;
  await sleep(800);
  await panel.evaluate(`(document.getElementById('developerView').open = true,
    document.getElementById('bridgeToken').value = ${JSON.stringify(TOKEN)},
    document.getElementById('bridgePort').value = ${JSON.stringify(String(BRIDGE_PORT))},
    document.getElementById('btnBridgeConnect').click(), 'x')`);
  await sleep(500);
  check("extension pairing submitted via panel UI on the chosen port", true);

  const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e19", version: "0" } });
  check("MCP initialize", init.serverInfo.name === "seeyable");
  notify("notifications/initialized");
  const tools = await rpc("tools/list", {});
  const names = tools.tools.map((t) => t.name).sort();
  check("eight tools exposed", JSON.stringify(names) === JSON.stringify(["click", "fill", "highlight", "highlight_target", "list_tabs", "page_snapshot", "read_section", "select"]), names.join(","));
  const structured = (r) => r.structuredContent || {};
  const call = async (name, args) => {
    const r = await rpc("tools/call", { name, arguments: args });
    const s = structured(r);
    toolEvents.push({ tool: name, status: s.status || (r.isError ? "error" : "ok"), revision: s.revision ?? null });
    return r;
  };

  const tabList = await waitFor(async () => {
    const tabs = structured(await call("list_tabs", {})).tabs;
    return tabs && tabs.length ? tabs : null;
  }, "extension-pairing", 20000);
  const demoTab = tabList.find((t) => t.url && t.url.includes("demo-survey"));
  check("list_tabs finds demo tab", Boolean(demoTab), JSON.stringify(demoTab));

  let snapshot = structured(await call("page_snapshot", { tabId: demoTab.tabId }));
  check("page_snapshot real snapshot (20 controls)", snapshot.elementCount === 20 && !!snapshot.documentSessionId, `rev ${snapshot.revision}`);
  const byName = (n) => snapshot.elements.find((e) => e.name === n);
  const byPrefix = (n) => snapshot.elements.find((e) => e.name && e.name.startsWith(n));
  const bind = (el) => ({ tabId: demoTab.tabId, elementId: el.id, documentSessionId: snapshot.documentSessionId, revision: snapshot.revision });
  const refresh = async () => { snapshot = structured(await call("page_snapshot", { tabId: demoTab.tabId })); return snapshot; };
  const act = async (name, el, value) => {
    const args = { ...bind(el) };
    if (value !== undefined) args.value = value;
    const out = structured(await call(name, args));
    await refresh();
    return out;
  };

  let fullName = byName("Full name");
  const role = byName("Your role");
  const pin = byName("Account PIN");
  const fixturePin = await demo.evaluate("document.getElementById('account-pin').value");
  check("snapshot carries dropdown metadata", Array.isArray(role.state.options) && role.state.options.some((o) => o.label === "Designer" && o.value === "designer"));
  check("Account PIN is redacted in snapshot", pin.state.redacted === true && pin.state.filled === true && fixturePin.length > 0 && !JSON.stringify(pin).includes(fixturePin));

  const hl = structured(await call("highlight", bind(fullName)));
  check("highlight Full name without activation", hl.status === "highlighted" && hl.highlighted === fullName.id && (await demo.evaluate("document.getElementById('full-name').value")) === "");

  const fills = [
    ["Full name", "Ada Lovelace", "full-name"],
    ["Work email", "ada@example.com", null],
    ["Nickname", "Pioneer", null],
    ["Short bio", "Fictional visitor testing Seeyable.", "bio"],
  ];
  for (const [label, value] of fills) {
    const el = label === "Nickname" || label === "Short bio" ? byPrefix(label) : byName(label);
    const out = await act("fill", el, value);
    check(`fill ${label} verified`, out.status === "verified", JSON.stringify(out.result || out.error));
  }
  check("page observes all canonical fills", (await demo.evaluate(`JSON.stringify({
    full: document.getElementById('full-name').value,
    email: document.querySelector('input[name="work-email"]').value,
    nickname: document.querySelector('input[name="nickname"]').value,
    bio: document.getElementById('bio').value,
  })`)) === JSON.stringify({ full: "Ada Lovelace", email: "ada@example.com", nickname: "Pioneer", bio: "Fictional visitor testing Seeyable." }));

  const role2 = byName("Your role");
  const designer = role2.state.options.find((o) => o.label === "Designer");
  const sel = await act("select", role2, designer.value);
  check("select Designer by exact snapshot value verified", sel.status === "verified" && designer.value === "designer", JSON.stringify(sel.result || sel.error));
  check("page observes Designer selection", (await demo.evaluate("document.getElementById('role-select').value")) === "designer");

  for (const label of ["SMS updates", "Monthly digest"]) {
    const el = byName(label);
    if (el.state.checked) { check(`${label} already selected; no blind toggle`, true); continue; }
    const out = await act("click", el);
    check(`click ${label} verified`, out.status === "verified", JSON.stringify(out.result || out.error));
  }
  check("page observes SMS and Monthly selections", (await demo.evaluate(`document.querySelector('input[name="pref-sms"]').checked && document.querySelector('input[name="freq"][value="monthly"]').checked`)) === true);
  await saveShot(demo, "demo-completed-headless.png");

  const role3 = byName("Your role");
  const section = structured(await call("read_section", { tabId: demoTab.tabId, elementId: role3.id, documentSessionId: snapshot.documentSessionId, revision: snapshot.revision, maxChars: 2000 }));
  check("read_section bounded section text", section.status === "ok" && section.text.includes("About you") && typeof section.truncated === "boolean", `chars=${section.charCount} truncated=${section.truncated}`);
  check("read_section excludes PIN value", !section.text.includes(fixturePin), "raw PIN default value absent from prose");

  const pw = byName("Account PIN");
  const pwFill = structured(await call("fill", { tabId: demoTab.tabId, elementId: pw.id, documentSessionId: snapshot.documentSessionId, revision: snapshot.revision, value: "9999" }));
  check("sensitive fill rejected", pwFill.status === "rejected", JSON.stringify(pwFill.error));
  check("PIN unchanged after rejected write", (await demo.evaluate("document.getElementById('account-pin').value")) === fixturePin);
  await refresh();

  fullName = byName("Full name");
  const forged = await call("fill", { tabId: demoTab.tabId, elementId: fullName.id, documentSessionId: snapshot.documentSessionId, revision: snapshot.revision, value: "x", approved: true });
  check("approval-shaped extra field rejected", forged.isError === true);

  // Held Submit: exactly one attempt, zero dispatch, panel card, and a
  // harness-triggered Cancel only. This harness never clicks Approve
  // and makes no human-confirmation claim.
  await refresh();
  const submitEl = byName("Submit survey");
  const held = await call("click", bind(submitEl));
  const heldS = structured(held);
  check("Submit attempted once is held_for_approval", held.isError === true && heldS.status === "held_for_approval", JSON.stringify(heldS.error || {}));
  check("no challenge id leaks to client", !JSON.stringify(held).includes("challengeId") && !JSON.stringify(heldS).includes("ch-secret"));
  check("held Submit dispatched nothing", (await demo.evaluate("window.__submitCount")) === 0);

  // Activating the demo tab lets the already-open panel page bind it and
  // discover the authoritative hold automatically (no Snapshot click).
  await browser.send("Target.activateTarget", { targetId: demoCreated.id });
  await waitFor(async () => (await panel.evaluate("document.getElementById('confirmBox').hidden")) === false, "confirm-adopt", 15000).catch(() => null);
  const confirmVisible = (await panel.evaluate("document.getElementById('confirmBox').hidden")) === false;
  const confirmText = await panel.evaluate("document.getElementById('confirmText').textContent").catch(() => "");
  check("MCP hold appears automatically in panel confirmation card", confirmVisible, confirmText.slice(0, 240));
  const panelStatus = await panel.evaluate("document.getElementById('status').textContent").catch(() => "");
  check("replacement panel capture is from a successfully bound demo tab", confirmVisible && !/DOM snapshot failed/.test(panelStatus), panelStatus.slice(0, 240));
  if (confirmVisible && !/DOM snapshot failed/.test(panelStatus)) await saveShot(panel, "panel-held-confirmation-headless.png");
  await panel.evaluate("document.getElementById('btnCancelChallenge').click(); 'x'");
  await sleep(800);
  check("harness-triggered Cancel clears card and form stays unsubmitted", (await panel.evaluate("document.getElementById('confirmBox').hidden")) === true && (await demo.evaluate("window.__submitCount")) === 0);
  await panel.evaluate("document.getElementById('developerView').open = true; document.getElementById('btnRefreshLog').click(); 'x'");
  await sleep(300);
  const actionLog = await panel.evaluate("document.getElementById('actionLog').textContent").catch(() => "");
  check("audit log records the MCP hold", /mcp · click .*confirmation-required/.test(actionLog), actionLog.split("\n").filter((l) => l.includes("mcp")).slice(-2).join(" | ").slice(0, 240));

  // Explicit-tab operation remains valid while another tab is active:
  // activate the panel page, then snapshot the background demo tab.
  await browser.send("Target.activateTarget", { targetId: created.targetId });
  const bgSnap = structured(await call("page_snapshot", { tabId: demoTab.tabId }));
  check("explicit background-tab snapshot does not retarget", bgSnap.documentSessionId === snapshot.documentSessionId && bgSnap.elementCount === 20);
  await browser.send("Target.activateTarget", { targetId: demoCreated.id });
  await sleep(500);

  // Stop blocks a new mutation; Resume alone dispatches nothing.
  await refresh();
  const bioBeforeStop = await demo.evaluate("document.getElementById('bio').value");
  await panel.evaluate("document.getElementById('btnStopExec').click(); 'x'");
  await sleep(300);
  const stoppedFill = structured(await call("fill", { ...bind(byName("Short bio")), value: "must not be written" }));
  check("Stop blocks new MCP mutation", stoppedFill.status === "rejected", JSON.stringify(stoppedFill.error || {}));
  await panel.evaluate("document.getElementById('btnStopExec').click(); 'x'"); // Resume
  await sleep(300);
  check("Resume alone dispatches nothing", (await demo.evaluate("document.getElementById('bio').value")) === bioBeforeStop && (await demo.evaluate("window.__submitCount")) === 0);

  // Reload invalidates the old document binding with no mutation.
  const oldBinding = { ...bind(byName("Full name")) };
  await demo.evaluate("location.reload(); 'x'");
  await waitFor(async () => demo.evaluate("document.readyState").then((s) => (s === "complete" ? s : null)).catch(() => null), "demo-reload");
  await sleep(1000);
  const stale = structured(await call("fill", { ...oldBinding, value: "stale write" }));
  check("old session after reload is rejected", stale.status === "rejected", JSON.stringify(stale.error || {}));
  check("stale reload attempt mutated nothing", (await demo.evaluate("document.getElementById('full-name').value")) === "");

  // A closed disposable tab fails explicitly; the demo tab is unaffected.
  const closedCreated = await fetch(`http://127.0.0.1:${PORT}/json/new?` + encodeURIComponent(`http://127.0.0.1:${HTTP}/demo-survey/index.html?disposable=closed`), { method: "PUT" }).then((r) => r.json());
  const closedTab = await waitFor(async () => {
    const tabs = structured(await call("list_tabs", {})).tabs;
    const found = tabs && tabs.find((t) => t.url && t.url.includes("disposable=closed"));
    return found || null;
  }, "disposable-tab-listed", 10000).catch(() => null);
  check("disposable tab is explicitly identified", Boolean(closedTab));
  if (closedTab) {
    await fetch(`http://127.0.0.1:${PORT}/json/close/${closedCreated.id}`);
    await sleep(500);
    const closedSnap = await call("page_snapshot", { tabId: closedTab.tabId });
    check("closed tab fails without substitution", closedSnap.isError === true, JSON.stringify(structured(closedSnap).error || {}));
    const demoAfterClosed = structured(await call("page_snapshot", { tabId: demoTab.tabId }));
    check("demo tab still serves explicit snapshots", demoAfterClosed.elementCount === 20);
  }

  const excerptNames = ["Full name", "Work email", "Your role", "Account PIN", "Submit survey"];
  const evidence = {
    evidenceType: "headless Chrome + real extension + real MCP stdio server + custom JSON-RPC client (not Claude Desktop, not Inspector GUI)",
    workflow: "Issue #20 Act 2 canonical sequence, cancel-only at Submit",
    tab: { tabId: demoTab.tabId, title: demoTab.title, url: demoTab.url },
    snapshot: {
      documentSessionId: snapshot.documentSessionId,
      revision: snapshot.revision,
      elementCount: snapshot.elementCount,
      elements: snapshot.elements.filter((e) => excerptNames.includes(e.name) || (e.name && (e.name.startsWith("Nickname") || e.name.startsWith("Short bio")))).map((e) => ({ id: e.id, role: e.role, name: e.name, state: e.state })),
    },
    toolEvents,
    checks: results,
  };
  writeFileSync(`${EVIDENCE_DIR}/headless-custom-stdio-results.json`, JSON.stringify(evidence, null, 2) + "\n");
} catch (e) {
  check("harness completed", false, String(e).slice(0, 400));
} finally {
  // Cleanup is limited to child processes this harness spawned. The
  // isolated shared bridge exits after its 1 s idle window; no other
  // process, port owner, browser profile, or client config is touched.
  try { mcp.kill("SIGKILL"); } catch {}
  try { chrome.kill("SIGKILL"); } catch {}
  try { server.kill("SIGKILL"); } catch {}
  await sleep(1500);
  try { rmSync(TMP, { recursive: true, force: true }); } catch {}
  const failed = results.filter((r) => !r.ok);
  console.log(`\nACT2-HEADLESS: ${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}
