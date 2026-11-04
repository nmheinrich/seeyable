// Behaviour safety net for panel polish work (#31). Drives the REAL extension
// in a genuine Chrome side panel with the real executor, planner proxy, MCP
// stdio server, and demo survey. Only the model is a local stub.
//
// Assertions read page values, submit counts, element visibility, and MCP
// statuses, never panel wording, so copy can change without touching this.
//
// Isolation: ephemeral Chrome profile, free ports, a temp copy of the extension
// whose only difference is one extra host permission (for the free proxy port),
// and child processes it spawned itself. It never uses 6123/6124.
//
// Run: npm --prefix apps/extension run test:e2e
// Needs Google Chrome (or CHROME_BIN) and `npm --prefix apps/mcp-server ci`.
// Set SEEYABLE_E2E_SHOTS=<dir> to save screenshots of key states.
import { spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "../../../..");
const CHROME = process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const SHOTS = process.env.SEEYABLE_E2E_SHOTS || "";
const TMP = mkdtempSync(join(tmpdir(), "seeyable-e2e-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail && !ok ? ` — ${detail}` : ""}`);
}
async function waitFor(fn, label, timeout = 15000) {
  const start = Date.now();
  let lastError = null;
  while (Date.now() - start < timeout) {
    try { const value = await fn(); if (value) return value; } catch (err) { lastError = err; }
    await sleep(100);
  }
  throw new Error(`timeout: ${label}${lastError ? ` (${lastError.message})` : ""}`);
}
async function freePort() {
  const server = createNetServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/* --- Local services ------------------------------------------------------ */
const servers = [];
const children = [];
function listen(server) {
  servers.push(server);
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}
const demoPort = await listen(createHttpServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (path !== "/demo-survey/index.html") { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "content-type": "text/html" });
  res.end(readFileSync(join(ROOT, "apps/demo-survey/index.html")));
}));

// Stub model: returns plans over the ids in the snapshot the proxy sends it.
const stubPort = await listen(createHttpServer((req, res) => {
  let body = "";
  req.on("data", (d) => { body += d; });
  req.on("end", () => {
    const user = JSON.parse(body).messages.filter((m) => m.role === "user").pop().content;
    const lines = user.split("\n");
    const request = lines[1].toLowerCase();
    const snapshot = JSON.parse(lines.find((line) => line.startsWith("{")));
    const id = (name) => snapshot.elements.find((e) => (e.name || "").toLowerCase().includes(name)).id;
    const steps = [
      { action: "fill", elementId: id("full name"), value: "Ada Example" },
      { action: "select", elementId: id("your role"), value: "designer" },
      { action: "fill", elementId: id("short bio"), value: "Fictional visitor." },
    ];
    if (request.includes("submit")) steps.push({ action: "click", elementId: id("submit survey") });
    const plan = { version: "seeyable-plan-1", outcome: "steps", say: "Plan ready.", steps };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(plan) } }] }));
  });
}));

const proxyPort = await freePort();
const bridgePort = await freePort();
const cdpPort = await freePort();
const PLANNER_TOKEN = `e2e-${Math.random().toString(36).slice(2)}${"x".repeat(32)}`;
const BRIDGE_TOKEN = Array.from({ length: 64 }, () => Math.floor(Math.random() * 16).toString(16)).join("");

const EXT = join(TMP, "extension");
const SOURCE = process.env.SEEYABLE_E2E_EXTENSION || join(ROOT, "apps/extension"); // override only to run deliberately broken copies
cpSync(SOURCE, EXT, {
  recursive: true,
  filter: (src) => !["node_modules", "tests", ".DS_Store"].includes(basename(src)),
});
const manifest = JSON.parse(readFileSync(join(EXT, "manifest.json"), "utf8"));
manifest.host_permissions.push(`http://127.0.0.1:${proxyPort}/*`);
writeFileSync(join(EXT, "manifest.json"), JSON.stringify(manifest, null, 2));

function start(command, args, env = {}) {
  const child = spawn(command, args, { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  children.push(child);
  return child;
}
start("node", [join(ROOT, "apps/planner-proxy/server.mjs"), "--port", String(proxyPort)], {
  MODEL_API_KEY: "stub",
  SEEYABLE_MODEL_BASE_URL: `http://127.0.0.1:${stubPort}`,
  SEEYABLE_PLANNER_TOKEN: PLANNER_TOKEN,
});
const mcp = start("node", [join(ROOT, "apps/mcp-server/server.mjs"), "--port", String(bridgePort)], {
  SEEYABLE_BRIDGE_TOKEN: BRIDGE_TOKEN,
  SEEYABLE_STATE_DIR: join(TMP, "mcp-state"),
  SEEYABLE_BRIDGE_IDLE_MS: "1000",
});
let rpcId = 0;
let mcpBuffer = "";
const rpcPending = new Map();
mcp.stdout.on("data", (chunk) => {
  mcpBuffer += chunk;
  let i;
  while ((i = mcpBuffer.indexOf("\n")) >= 0) {
    const line = mcpBuffer.slice(0, i).trim();
    mcpBuffer = mcpBuffer.slice(i + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    const pending = rpcPending.get(message.id);
    if (pending) {
      rpcPending.delete(message.id);
      if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
      else pending.resolve(message.result);
    }
  }
});
function rpc(method, params) {
  return new Promise((resolve, reject) => {
    const id = ++rpcId;
    rpcPending.set(id, { resolve, reject });
    mcp.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    setTimeout(() => { if (rpcPending.delete(id)) reject(new Error(`rpc timeout: ${method}`)); }, 25000);
  });
}
const tool = async (name, args) => {
  const result = await rpc("tools/call", { name, arguments: args });
  return { isError: result.isError === true, ...(result.structuredContent || {}) };
};

const chrome = start(CHROME, [
  "--headless=new", `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${join(TMP, "profile")}`,
  "--no-first-run", "--disable-gpu", "--enable-unsafe-extension-debugging", "--window-size=1440,900", "about:blank",
]);

/* --- CDP ----------------------------------------------------------------- */
function connect(url) {
  const ws = new WebSocket(url);
  let id = 0;
  const pending = new Map();
  const ready = new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
    else entry.resolve(message.result);
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const mid = ++id;
    pending.set(mid, { resolve, reject });
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  const ev = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(`eval: ${JSON.stringify(r.exceptionDetails).slice(0, 300)}`);
    return r.result.value;
  };
  const shot = async (name) => {
    if (!SHOTS) return;
    mkdirSync(SHOTS, { recursive: true });
    const r = await send("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(SHOTS, extname(name) ? name : `${name}.png`), Buffer.from(r.data, "base64"));
  };
  return { ws, ready, send, ev, shot };
}
const targets = () => fetch(`http://127.0.0.1:${cdpPort}/json/list`).then((r) => r.json());
async function attach(predicate, label) {
  const target = await waitFor(async () => (await targets()).find(predicate), label);
  const client = connect(target.webSocketDebuggerUrl);
  await client.ready;
  await client.send("Page.enable");
  return { ...client, targetId: target.id };
}

let exitCode = 1;
try {
  /* --- Setup: load, open the genuine side panel, bind the demo ----------- */
  const version = await waitFor(() => fetch(`http://127.0.0.1:${cdpPort}/json/version`).then((r) => r.json()), "chrome");
  const browser = connect(version.webSocketDebuggerUrl);
  await browser.ready;
  const { id: extId } = await browser.send("Extensions.loadUnpacked", { path: EXT });
  await browser.send("Target.createTarget", { url: `http://127.0.0.1:${demoPort}/demo-survey/index.html` });
  const demo = await attach((t) => t.url.includes("/demo-survey/"), "demo");
  await sleep(800);

  const opener = await browser.send("Target.createTarget", { url: `chrome-extension://${extId}/mic-setup.html` });
  const helper = await attach((t) => t.id === opener.targetId, "helper");
  await waitFor(() => helper.ev("document.readyState === 'complete'"), "helper-load");
  await helper.ev(`(async () => {
    const win = await chrome.windows.getCurrent();
    const b = document.createElement("button");
    b.style = "position:fixed;left:0;top:0;width:200px;height:200px;z-index:99";
    b.onclick = () => chrome.sidePanel.open({ windowId: win.id });
    document.body.appendChild(b);
  })()`);
  await helper.send("Input.dispatchMouseEvent", { type: "mousePressed", x: 50, y: 50, button: "left", clickCount: 1 });
  await helper.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 50, y: 50, button: "left", clickCount: 1 });
  const panel = await attach((t) => t.url.endsWith("/sidepanel.html"), "side panel");
  check("genuine side panel opens", true);
  await browser.send("Target.closeTarget", { targetId: opener.targetId });
  await panel.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });

  const installSubmitCounter = () => demo.ev(`(window.__submits = 0,
    document.getElementById("survey").addEventListener("submit", (e) => { e.preventDefault(); window.__submits += 1; }), 1)`);
  const submits = () => demo.ev("window.__submits");
  const value = (selector) => demo.ev(`document.querySelector(${JSON.stringify(selector)}).value`);
  const NAME = "#full-name", ROLE = "#role-select", BIO = "#bio", NICK = 'input[name="nickname"]';

  const view = () => panel.ev("document.body.dataset.view");
  const visible = (id) => panel.ev(`(() => { const el = document.getElementById(${JSON.stringify(id)}); return Boolean(el && el.offsetParent !== null); })()`);
  const click = (id) => panel.ev(`document.getElementById(${JSON.stringify(id)}).click()`);
  const waitView = (name) => waitFor(async () => (await view()) === name, `view ${name}`);
  const idle = () => waitFor(async () => {
    const v = await view();
    return v !== "working" && v !== "acting" && !(await panel.ev("document.getElementById('btnSendCommand').disabled"));
  }, "panel idle");
  async function command(text) {
    await idle();
    await panel.ev(`(() => {
      document.getElementById("commandInput").value = ${JSON.stringify(text)};
      document.getElementById("btnSendCommand").click();
    })()`);
    await sleep(150);
    await idle();
  }
  async function undo() {
    await idle();
    await click("btnUndo");
    await sleep(150);
    await idle();
  }
  async function bringDemoForward() {
    await browser.send("Target.activateTarget", { targetId: demo.targetId });
    await sleep(200);
  }
  async function freshPage() {
    await bringDemoForward();
    await demo.send("Page.reload");
    await waitFor(() => demo.ev("document.readyState === 'complete'"), "demo reload");
    await sleep(400);
    await installSubmitCounter();
    await panel.send("Page.reload");
    await waitFor(() => panel.ev(`/\\d+ controls/.test(document.getElementById("pageMeta").textContent)`), "panel bound");
  }

  await freshPage();
  await panel.ev(`(() => {
    showScreen("Settings");
    document.getElementById("developerView").open = true;
    document.getElementById("plannerToken").value = ${JSON.stringify(PLANNER_TOKEN)};
    document.getElementById("plannerPort").value = ${JSON.stringify(String(proxyPort))};
    document.getElementById("btnPlannerPair").click();
  })()`);
  await sleep(500);
  await panel.ev(`(document.getElementById("developerView").open = false, showScreen("Assist"), 1)`);

  /* --- Typed flow -------------------------------------------------------- */
  check("idle panel shows the ready view", (await view()) === "ready");
  await command("Update my profile");
  await waitView("plan");
  await panel.shot("plan");
  check("plan review shows Approve", await visible("btnApprovePlan"));
  check("plan review changes nothing on the page", (await value(NAME)) === "" && (await value(ROLE)) === "engineer" && (await value(BIO)) === "");
  await click("btnApprovePlan");
  await waitView("done");
  await panel.shot("done");
  check("approved plan fills the name", (await value(NAME)) === "Ada Example");
  check("approved plan selects the role", (await value(ROLE)) === "designer");
  check("approved plan fills the bio", (await value(BIO)) === "Fictional visitor.");

  /* --- Undo -------------------------------------------------------------- */
  await undo();
  check("undo restores the last fill", (await value(BIO)) === "");
  check("undo leaves earlier changes alone", (await value(NAME)) === "Ada Example" && (await value(ROLE)) === "designer");
  await undo();
  check("second undo changes nothing", (await value(NAME)) === "Ada Example" && (await value(ROLE)) === "designer" && (await value(BIO)) === "");

  await freshPage();
  await command("fill nickname with Ace");
  await waitFor(async () => (await value(NICK)) === "Ace", "fast-path fill");
  check("typed fast-path fill reaches the page", true);
  await demo.ev(`(() => {
    const el = document.querySelector(${JSON.stringify(NICK)});
    el.value = "Edited by the person";
    el.dispatchEvent(new Event("input", { bubbles: true }));
  })()`);
  await undo();
  check("undo refuses to overwrite a later edit", (await value(NICK)) === "Edited by the person");

  await freshPage();
  await command("fill nickname with Ace");
  await waitFor(async () => (await value(NICK)) === "Ace", "fill before click");
  await command("click save draft");
  await undo();
  check("undo never crosses a click", (await value(NICK)) === "Ace");

  /* --- Held Submit ------------------------------------------------------- */
  await freshPage();
  await command("Submit my profile");
  await waitView("plan");
  await click("btnApprovePlan");
  await waitView("gate");
  await panel.shot("gate");
  check("Submit is held for approval", await visible("btnApproveOnce"));
  check("held Submit has not fired", (await submits()) === 0);
  check("fills before the hold completed", (await value(BIO)) === "Fictional visitor.");
  await click("btnCancelChallenge");
  await waitFor(async () => (await view()) !== "gate", "gate closed by cancel");
  await sleep(400);
  check("cancelled Submit does not fire", (await submits()) === 0);

  await freshPage();
  await command("Submit my profile");
  await waitView("plan");
  await click("btnApprovePlan");
  await waitView("gate");
  await click("btnApproveOnce");
  await waitFor(async () => (await submits()) > 0, "approved submit");
  await sleep(600);
  check("approved Submit fires exactly once", (await submits()) === 1);
  await click("btnStopExec");
  await waitView("stopped");
  await click("btnStopExec");
  await waitFor(async () => (await view()) !== "stopped", "resumed");
  await sleep(500);
  check("Stop and Resume do not replay an approved Submit", (await submits()) === 1);

  await freshPage();
  await command("Submit my profile");
  await waitView("plan");
  await click("btnApprovePlan");
  await waitView("gate");
  await click("btnStopExec");
  await waitView("stopped");
  check("Stop withdraws the held Submit", !(await visible("btnApproveOnce")));
  await click("btnStopExec");
  await waitFor(async () => (await view()) !== "stopped", "resumed after hold");
  await sleep(500);
  check("Resume does not revive a withdrawn Submit", (await submits()) === 0 && !(await visible("btnApproveOnce")));

  /* --- Stop blocks new actions ------------------------------------------- */
  await freshPage();
  await click("btnStopExec");
  await waitView("stopped");
  await command("fill nickname with Blocked");
  check("Stop blocks a typed action", (await value(NICK)) === "");
  await click("btnStopExec");
  await waitFor(async () => (await view()) !== "stopped", "resumed before retry");
  await sleep(300);
  check("Resume does not replay the blocked action", (await value(NICK)) === "");
  await command("fill nickname with Allowed");
  await waitFor(async () => (await value(NICK)) === "Allowed", "fill after resume");
  check("actions work again after Resume", true);

  /* --- MCP: same gate, same Stop ----------------------------------------- */
  await freshPage();
  await panel.ev(`(() => {
    showScreen("Settings");
    document.getElementById("developerView").open = true;
    document.getElementById("bridgeToken").value = ${JSON.stringify(BRIDGE_TOKEN)};
    document.getElementById("bridgePort").value = ${JSON.stringify(String(bridgePort))};
    document.getElementById("btnBridgeConnect").click();
  })()`);
  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "plain-words-e2e", version: "0" } });
  mcp.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  const tabs = await waitFor(async () => {
    const out = await tool("list_tabs", {});
    return out.tabs && out.tabs.length ? out.tabs : null;
  }, "agent bridge", 20000);
  const demoTab = tabs.find((t) => t.url && t.url.includes("/demo-survey/"));
  check("agent sees the demo tab", Boolean(demoTab));
  let snapshot = await tool("page_snapshot", { tabId: demoTab.tabId });
  const refresh = async () => { snapshot = await tool("page_snapshot", { tabId: demoTab.tabId }); };
  const element = (start) => snapshot.elements.find((e) => e.name && e.name.startsWith(start));
  const bound = (el) => ({ tabId: demoTab.tabId, elementId: el.id, documentSessionId: snapshot.documentSessionId, revision: snapshot.revision });

  const pinValue = await value("#account-pin");
  const pin = element("Account PIN");
  check("agent snapshot redacts the password", pin.state.redacted === true && pinValue.length > 0 && !JSON.stringify(snapshot).includes(pinValue));
  const agentFill = await tool("fill", { ...bound(element("Full name")), value: "Agent Example" });
  check("agent fill verifies on the page", agentFill.status === "verified" && (await value(NAME)) === "Agent Example");
  await refresh();
  const sensitive = await tool("fill", { ...bound(element("Account PIN")), value: "9999" });
  check("agent cannot write the password", sensitive.status === "rejected" && (await value("#account-pin")) === pinValue);
  await refresh();
  const forged = await tool("fill", { ...bound(element("Nickname")), value: "x", approved: true });
  check("agent cannot claim approval", forged.isError === true && (await value(NICK)) === "");
  await refresh();

  const held = await tool("click", bound(element("Submit survey")));
  check("agent Submit is held, not run", held.status === "held_for_approval" && (await submits()) === 0);
  await bringDemoForward();
  await waitFor(() => visible("btnApproveOnce"), "agent hold in panel");
  await panel.shot("agent-gate");
  check("agent hold appears in the panel", true);
  await click("btnCancelChallenge");
  await waitFor(async () => (await view()) !== "gate", "agent hold cancelled");
  await sleep(400);
  check("cancelled agent Submit does not fire", (await submits()) === 0);

  await panel.ev(`document.querySelector('[data-screen="Settings"]').click()`);
  await sleep(150);
  await panel.shot("settings-with-agent");
  check("Stop is reachable on Settings with an agent connected", await visible("btnStopExec"));
  await click("btnStopExec");
  await waitFor(async () => (await panel.ev("document.body.dataset.gate")) === "closed", "gate closed");
  await refresh();
  const blocked = await tool("fill", { ...bound(element("Nickname")), value: "Blocked" });
  check("Stop blocks the agent", blocked.status !== "verified" && (await value(NICK)) === "");
  await click("btnStopExec");
  await waitFor(async () => (await panel.ev("document.body.dataset.gate")) === "open", "gate reopened");
  await sleep(400);
  check("Resume does not replay the agent's blocked fill", (await value(NICK)) === "");

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  exitCode = failed.length ? 1 : 0;
  browser.ws.close();
} catch (err) {
  console.error(`\nABORTED after ${results.length} checks: ${err.message}`);
  exitCode = 1;
} finally {
  chrome.kill();
  for (const child of children) { try { child.kill(); } catch { /* already gone */ } }
  for (const server of servers) server.close();
  await sleep(500);
  rmSync(TMP, { recursive: true, force: true, maxRetries: 3 });
  process.exit(exitCode);
}
