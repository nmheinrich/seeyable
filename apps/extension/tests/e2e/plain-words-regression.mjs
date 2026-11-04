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
// With SHOTS, SEEYABLE_E2E_SWEEP=1 also captures each state in light, dark and
// forced colors at 320/360/560px and records layout and contrast findings in
// sweep-issues.json. It reports; it does not fail the run.
const SWEEP = Boolean(process.env.SEEYABLE_E2E_SWEEP);
const sweepIssues = [];
const AUDIT = `(() => {
  const issues = [];
  const shown = (el) => el.offsetParent !== null && getComputedStyle(el).clipPath === "none" && getComputedStyle(el).visibility !== "hidden";
  const who = (el) => el.id || el.className || el.tagName;
  const root = document.documentElement;
  if (root.scrollWidth > root.clientWidth) issues.push("page scrolls sideways");
  const screens = document.getElementById("screens");
  if (screens && screens.scrollWidth > screens.clientWidth) issues.push("screens scroll sideways");
  const rgb = (c) => { const m = c.match(/[\\d.]+/g).map(Number); return { r: m[0], g: m[1], b: m[2], a: m.length > 3 ? m[3] : 1 }; };
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
  const backdrop = (el) => { for (let n = el; n; n = n.parentElement) { const c = rgb(getComputedStyle(n).backgroundColor); if (c.a === 1) return c; } return { r: 255, g: 255, b: 255 }; };
  for (const el of document.querySelectorAll("body *")) {
    if (!shown(el) || ["SCRIPT", "STYLE"].includes(el.tagName)) continue;
    const r = el.getBoundingClientRect();
    if (el.matches("button, input, .chip") && r.right > innerWidth + 1) issues.push("off the right edge: " + who(el));
    if (el.matches("button, .chip, summary") && el.scrollWidth > el.clientWidth + 1) issues.push("text overflows: " + who(el));
    const text = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    if (!text || el.closest("[disabled]")) continue;
    const st = getComputedStyle(el);
    const fg = lum(rgb(st.color)), bg = lum(backdrop(el));
    const ratio = (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
    const large = parseFloat(st.fontSize) >= 24 || (parseFloat(st.fontSize) >= 18.66 && Number(st.fontWeight) >= 700);
    if (ratio < (large ? 3 : 4.5)) issues.push("contrast " + ratio.toFixed(2) + ": " + who(el));
  }
  return [...new Set(issues)];
})()`;
async function sweep(name, send, ev) {
  for (const theme of ["light", "dark", "forced"]) {
    const features = [{ name: "prefers-reduced-motion", value: "reduce" }, { name: "prefers-color-scheme", value: theme === "dark" ? "dark" : "light" }, { name: "forced-colors", value: theme === "forced" ? "active" : "none" }];
    await send("Emulation.setEmulatedMedia", { features });
    for (const width of [320, 360, 560]) {
      await send("Emulation.setDeviceMetricsOverride", { width, height: 765, deviceScaleFactor: 1, mobile: false });
      await sleep(60);
      const r = await send("Page.captureScreenshot", { format: "png" });
      writeFileSync(join(SHOTS, `sweep-${name}-${theme}-${width}.png`), Buffer.from(r.data, "base64"));
      const found = await ev(AUDIT);
      for (const issue of found) {
        if (theme === "forced" && issue.startsWith("contrast")) continue;
        sweepIssues.push({ state: name, theme, width, issue });
      }
    }
  }
  await send("Emulation.clearDeviceMetricsOverride");
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  await sleep(60);
}
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
  if (!path.startsWith("/demo-survey/") || !path.endsWith("/index.html")) { res.writeHead(404); res.end(); return; }
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
    if (SWEEP && !/-\d+$/.test(name)) await sweep(name, send, ev);
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
  // Opened before the extension loads, so it has no content script: the
  // real case the Reload button exists for.
  const olderTab = await browser.send("Target.createTarget", { url: `http://127.0.0.1:${demoPort}/demo-survey/older/index.html` });
  await sleep(500);
  const { id: extId } = await browser.send("Extensions.loadUnpacked", { path: EXT });
  const demoTarget = await browser.send("Target.createTarget", { url: `http://127.0.0.1:${demoPort}/demo-survey/index.html` });
  const demo = await attach((t) => t.id === demoTarget.targetId, "demo");
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
  check("the extension loads with its declared icons", await panel.ev(`(async () => { const { icons } = chrome.runtime.getManifest(); const sizes = await Promise.all(Object.values(icons).map((p) => new Promise((ok) => { const i = new Image(); i.onload = () => ok(i.naturalWidth); i.onerror = () => ok(0); i.src = chrome.runtime.getURL(p); }))); return sizes.join() === "16,32,48,128"; })()`));
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
  // The marker proves the check reads the reloaded panel, not the old page
  // that can still show a control count while the reload is starting.
  async function reloadPanel(label) {
    await panel.ev("window.__beforeReload = true");
    await panel.send("Page.reload");
    await waitFor(() => panel.ev(`!window.__beforeReload && document.readyState === "complete" && /\\d+ controls/.test(document.getElementById("pageMeta").textContent)`), label);
  }
  async function freshPage() {
    await bringDemoForward();
    await demo.send("Page.reload");
    await waitFor(() => demo.ev("document.readyState === 'complete'"), "demo reload");
    await sleep(400);
    await installSubmitCounter();
    await reloadPanel("panel bound");
  }

  await freshPage();

  /* --- Before the planner is paired: recovery and examples ---------------- */
  await command("Update my profile");
  check("an unpaired request shows the recovery card", await visible("recoverBox"));
  check("an unpaired request changes nothing on the page", (await value(NAME)) === "");
  await panel.shot("recovery");
  await click("btnRecoverDeveloper");
  check("the recovery card opens the planner settings", await panel.ev(`document.activeElement.id === "plannerHeading" && document.getElementById("developerView").open`));
  await panel.ev(`(document.getElementById("developerView").open = false, showScreen("Assist"), 1)`);
  const chip = await panel.ev(`(() => { const b = document.querySelector("#tryChips button"); return b && b.textContent; })()`);
  check("the example comes from a field on this page", /^Fill .+ with Ada$/.test(chip || ""));
  check("no example offers Submit", !(await panel.ev(`/submit/i.test(document.getElementById("tryChips").textContent)`)));
  await panel.shot("ready-with-examples");
  await panel.ev(`document.querySelector("#tryChips button").click()`);
  await sleep(200);
  check("a chip does not act on the page", (await value(NAME)) === "" && (await panel.ev(`document.getElementById("commandInput").value`)) === chip);
  await panel.ev(`document.getElementById("btnSendCommand").click()`);
  await sleep(150);
  await idle();
  check("the example works with no planner", (await value(NAME)) === "Ada");
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
  const above = (a, b) => panel.ev(`document.getElementById(${JSON.stringify(a)}).getBoundingClientRect().bottom <= document.getElementById(${JSON.stringify(b)}).getBoundingClientRect().top + 1`);
  const noSideScroll = () => panel.ev(`document.documentElement.scrollWidth <= document.documentElement.clientWidth && document.getElementById("screens").scrollWidth <= document.getElementById("screens").clientWidth`);
  check("idle: Stop and Undo sit below the listen button", (await above("btnListen", "btnStopExec")) && (await visible("btnUndo")));
  await panel.ev(`showScreen("Settings")`);
  check("idle: Stop and Undo are not on Settings", !(await visible("btnStopExec")) && !(await visible("btnUndo")));
  await panel.ev(`showScreen("Assist")`);
  await panel.shot("ready");
  // Headless Chrome has no microphone: this sets the panel's talking state
  // directly, to check layout only. Voice behaviour is covered by the unit tests.
  await panel.ev(`(voicePhase = "listening", renderState(), 1)`);
  check("talking: Stop and Undo are hidden", !(await visible("btnStopExec")) && !(await visible("btnUndo")));
  await panel.shot("talking");
  await panel.ev(`(voicePhase = "idle", renderState(), 1)`);
  for (const width of [320, 360, 560]) {
    await panel.send("Emulation.setDeviceMetricsOverride", { width, height: 765, deviceScaleFactor: 1, mobile: false });
    await sleep(100);
    const fits = await panel.ev(`(() => { const b = document.getElementById("btnStopExec"); const r = document.createRange(); r.selectNodeContents(b); return Math.ceil(r.getBoundingClientRect().height) <= 24 && b.scrollWidth <= b.clientWidth; })()`);
    check(`"Stop actions" fits on one line at ${width}px`, fits);
    await panel.shot(`ready-${width}`);
  }
  await panel.send("Emulation.clearDeviceMetricsOverride");
  check("idle: the panel does not scroll sideways", await noSideScroll());
  check("page mark: a page with no icon shows its first letter", await panel.ev(`(() => { const m = document.getElementById("pageMark"); return !m.classList.contains("has-icon") && document.getElementById("pageInitial").textContent === document.getElementById("tabInfo").textContent.trim()[0].toUpperCase() && document.getElementById("pageInitial").offsetWidth > 0; })()`));
  check("page mark: the hidden icon takes no room in the tile", await panel.ev(`(() => { const r = document.getElementById("pageFavicon").getBoundingClientRect(); const m = document.getElementById("pageMark").getBoundingClientRect(); const l = document.getElementById("pageInitial").getBoundingClientRect(); return r.width === 0 && Math.abs((l.top + l.bottom) / 2 - (m.top + m.bottom) / 2) <= 2; })()`));
  await demo.ev(`(() => { const l = document.createElement("link"); l.rel = "icon"; l.href = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEBgIApD5fRAAAAABJRU5ErkJggg=="; document.head.append(l); return 1; })()`);
  await waitFor(() => panel.ev(`!document.getElementById("pageFavicon").hidden`), "site icon shown", 8000).catch(() => {});
  check("page mark: a site icon appears when the page sets one, with no reload", await panel.ev(`(() => { const i = document.getElementById("pageFavicon"); return document.getElementById("pageMark").classList.contains("has-icon") && i.naturalWidth > 0 && i.offsetWidth === 16; })()`));
  await panel.shot("ready-with-site-icon");
  await panel.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }, { name: "forced-colors", value: "active" }] });
  check("forced colors: the request field keeps a visible edge", await panel.ev(`(() => { const st = getComputedStyle(document.querySelector(".request-row")); return parseFloat(st.borderTopWidth) >= 1 && st.borderTopStyle === "solid"; })()`));
  await panel.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  await panel.ev(`document.fonts.ready`);
  const jostWidth = (weight) => panel.ev(`(() => { const s = document.createElement("span"); s.style = "position:absolute;font:${weight} 40px Jost"; s.textContent = "Handgloves Stopped"; document.body.append(s); const w = s.getBoundingClientRect().width; s.remove(); return w; })()`);
  check("Jost renders a real light weight from the bundled font", (await panel.ev(`document.fonts.load("300 40px Jost").then((f) => f.length > 0)`)) && (await jostWidth(300)) !== (await jostWidth(600)));
  await panel.ev(`document.getElementById("commandInput").focus()`);
  await command("click qqqqqq");
  check("typing again needs no extra click after a command", await panel.ev(`document.activeElement === document.getElementById("commandInput")`));
  await command("Update my profile");
  await waitView("plan");
  await panel.shot("plan");
  const shrunk = (id) => panel.ev(`(() => { const r = document.getElementById(${JSON.stringify(id)}).getBoundingClientRect(); return r.width <= 1 && r.height <= 1; })()`);
  check("plan review: your words are shown", (await visible("planFrom")) && (await panel.ev(`document.getElementById("planFromText").textContent.includes("Update my profile")`)));
  check("plan review: the outcome is not on screen twice", await shrunk("status"));
  check("plan review: each step has its number and a bold target", await panel.ev(`[...document.getElementById("planSteps").children].every((r) => r.querySelector(".no") && r.querySelector("strong"))`));
  check("plan review: Approve is not focused", await panel.ev(`document.activeElement !== document.getElementById("btnApprovePlan")`));
  check("plan review: voice help starts folded", await panel.ev(`!document.querySelector("#planBox .say-more").open`));
  check("plan review: Approve shows without scrolling", await panel.ev(`document.getElementById("btnApprovePlan").getBoundingClientRect().bottom <= innerHeight`));
  await panel.send("Emulation.setDeviceMetricsOverride", { width: 320, height: 765, deviceScaleFactor: 1, mobile: false });
  await sleep(100);
  await panel.shot("plan-320");
  check("plan review: no sideways scroll at 320px", await noSideScroll());
  await panel.send("Emulation.clearDeviceMetricsOverride");
  check("plan review: Stop sits below the plan controls", await above("btnCancelPlan", "btnStopExec"));
  check("plan review shows Approve", await visible("btnApprovePlan"));
  check("plan review changes nothing on the page", (await value(NAME)) === "" && (await value(ROLE)) === "engineer" && (await value(BIO)) === "");
  await click("btnApprovePlan");
  await waitView("done");
  await panel.shot("done");
  check("done: the header says done, in the success style", await panel.ev(`document.getElementById("stateChip").classList.contains("is-success")`));
  check("done: Undo sits by the result with Stop below it", (await above("resultUndoNote", "btnUndo")) && (await above("btnUndo", "btnStopExec")));
  await panel.ev(`showScreen("Settings")`);
  check("done: Stop and Undo are not on Settings", !(await visible("btnStopExec")));
  await panel.ev(`showScreen("Assist")`);
  check("approved plan fills the name", (await value(NAME)) === "Ada Example");
  check("approved plan selects the role", (await value(ROLE)) === "designer");
  check("approved plan fills the bio", (await value(BIO)) === "Fictional visitor.");

  /* --- Undo -------------------------------------------------------------- */
  const undoName = await panel.ev(`document.getElementById("btnUndo").textContent`);
  check("Done names the target Undo will restore", /^Undo .*bio/i.test(undoName));
  check("Done says the earlier changes stay", /only\./.test(await panel.ev(`document.getElementById("resultUndoNote").textContent`)));
  await undo();
  check("Undo goes back to its generic name", (await panel.ev(`document.getElementById("btnUndo").textContent`)) === "Undo last change");
  check("undo restores the last fill", (await value(BIO)) === "");
  check("undo leaves earlier changes alone", (await value(NAME)) === "Ada Example" && (await value(ROLE)) === "designer");
  await undo();
  check("second undo changes nothing", (await value(NAME)) === "Ada Example" && (await value(ROLE)) === "designer" && (await value(BIO)) === "");

  await freshPage();
  await command("fill nickname with Spoken");
  await command("undo that");
  check("\u201Cundo that\u201D reverses the last change", (await value(NICK)) === "");

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
  check("held action: Stop sits below the decision", await above("btnCancelChallenge", "btnStopExec"));
  check("held action: the panel does not scroll sideways", await noSideScroll());
  check("Submit is held for approval", await visible("btnApproveOnce"));
  check("held Submit has not fired", (await submits()) === 0);
  await waitFor(() => demo.ev(`(() => {
    const r = [...document.querySelectorAll("button")].find((b) => b.textContent === "Submit survey").getBoundingClientRect();
    return r.top >= 0 && r.bottom <= innerHeight;
  })()`), "held target in view", 3000).then(
    () => check("held target is fully in view on the page", true),
    () => check("held target is fully in view on the page", false),
  );
  check("fills before the hold completed", (await value(BIO)) === "Fictional visitor.");
  await click("btnCancelChallenge");
  await waitFor(async () => (await view()) !== "gate", "gate closed by cancel");
  await sleep(400);
  await panel.shot("after-cancel");
  await panel.ev(`document.querySelector('[data-screen="Activity"]').click()`);
  await sleep(400);
  await panel.shot("activity");
  await panel.ev(`document.querySelector('[data-screen="Assist"]').click()`);
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
  await panel.shot("stopped");
  check("stopped: the card alone carries the message", await panel.ev(`["gateStatus", "confirmStatus"].every((id) => { const el = document.getElementById(id); return !el.offsetParent || getComputedStyle(el).clipPath !== "none"; })`));
  check("stopped: Resume is in the card above the listen button, with no Undo", (await above("heroCopy", "btnStopExec")) && (await above("btnStopExec", "btnListen")) && !(await visible("btnUndo")));
  await panel.ev(`showScreen("Settings")`);
  check("stopped: the header says so on other screens", (await visible("stateChip")) && (await panel.ev(`document.getElementById("stateChip").textContent`)) === "Stopped" && !(await visible("btnStopExec")));
  await panel.ev(`showScreen("Assist")`);
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

  /* --- Long URLs never widen the panel ------------------------------------ */
  await bringDemoForward();
  await demo.send("Page.navigate", { url: `http://127.0.0.1:${demoPort}/demo-survey/${"x".repeat(200)}/index.html?form=${"y".repeat(200)}` });
  await waitFor(() => demo.ev("document.readyState === 'complete' && location.pathname.length > 100"), "long URL load");
  await sleep(400);
  await reloadPanel("panel bound to long URL");
  await panel.ev(`(showScreen("Settings"), document.getElementById("developerView").open = true, document.getElementById("btnDom").click(), 1)`);
  await waitFor(() => panel.ev(`document.getElementById("meta").textContent.length > 0`), "snapshot line");
  await sleep(200);
  await panel.ev(`document.getElementById("meta").scrollIntoView({ block: "center" })`);
  await panel.shot("long-url-developer-view");
  check("Developer view: control rows start at the left edge", await panel.ev(`[...document.querySelectorAll("details.developer section.controls, details.developer .toolbar")].filter((c) => c.offsetParent && c.firstElementChild).every((c) => c.firstElementChild.getBoundingClientRect().left - c.getBoundingClientRect().left < 24)`));
  check("a long URL does not scroll the panel sideways", await panel.ev(`(() => { const s = document.getElementById("screens"); return s.scrollWidth <= s.clientWidth; })()`));
  await panel.ev(`(document.getElementById("developerView").open = false, showScreen("Assist"), 1)`);
  await demo.send("Page.navigate", { url: `http://127.0.0.1:${demoPort}/demo-survey/index.html` });
  await waitFor(() => demo.ev("document.readyState === 'complete' && location.search === '' && location.pathname.length < 50"), "demo back");

  /* --- Pages Seeyable cannot operate -------------------------------------- */
  await freshPage();
  await demo.send("Page.navigate", { url: "chrome://version/" });
  await waitFor(async () => (await view()) === "unavailable", "closed page view");
  check("a chrome page shows the unavailable view", true);
  check("a chrome page offers no Reload", !(await visible("btnReloadPage")));
  check("a chrome page hides the mic and input", !(await visible("btnListen")) && !(await visible("commandInput")));
  check("Stop and the screens stay available there", (await visible("btnStopExec")) && (await panel.ev(`document.querySelector(".screen-nav button").offsetParent !== null`)));
  check("Tags is off and disabled there", await panel.ev(`document.getElementById("tagsChip").disabled && document.getElementById("tagsChip").getAttribute("aria-pressed") === "false"`));
  await panel.shot("unavailable-closed");
  await demo.send("Page.navigate", { url: `http://127.0.0.1:${demoPort}/demo-survey/index.html` });
  await waitFor(async () => (await view()) === "ready" && (await panel.ev(`/\\d+ controls/.test(document.getElementById("pageMeta").textContent)`)), "back from closed page");
  check("returning to a normal page recovers with no panel reload", true);
  await command("fill nickname with Back");
  await waitFor(async () => (await value(NICK)) === "Back", "fill after closed page");
  check("actions work after returning", true);

  await browser.send("Target.activateTarget", { targetId: olderTab.targetId });
  await waitFor(async () => (await view()) === "unavailable", "older tab view");
  check("a tab with no content script asks for a reload", await visible("btnReloadPage"));
  await panel.shot("unavailable-reload");
  await click("btnReloadPage");
  await waitFor(async () => (await view()) === "ready" && (await panel.ev(`/\\d+ controls/.test(document.getElementById("pageMeta").textContent)`)), "older tab recovered");
  check("Reload connects the page", true);
  await browser.send("Target.closeTarget", { targetId: olderTab.targetId });
  await bringDemoForward();
  await sleep(300);

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

  await panel.ev(`showScreen("Settings")`);
  const held = await tool("click", bound(element("Submit survey")));
  check("agent Submit is held, not run", held.status === "held_for_approval" && (await submits()) === 0);
  await bringDemoForward();
  await waitFor(() => visible("btnApproveOnce"), "agent hold in panel");
  await panel.shot("agent-gate");
  check("an agent's hold brings the decision back from Settings", await visible("btnCancelChallenge"));
  check("agent connected: Stop is pinned below the screens with no Undo", (await panel.ev(`document.getElementById("safetySlotPinned").contains(document.getElementById("btnStopExec"))`)) && !(await visible("btnUndo")));
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
  await reloadPanel("panel reopened with an agent");
  await sleep(200);
  await panel.ev(`showScreen("Settings")`);
  check("a reopened panel still pins Stop for the agent", await visible("btnStopExec"));
  await click("btnBridgeDisconnect");
  await waitFor(async () => !(await visible("btnStopExec")), "Disconnect unpins Stop");
  check("Disconnect unpins Stop while the panel is open", true);
  await panel.ev(`showScreen("Assist")`);
  check("after Disconnect, Stop and Undo are back below the listen button", (await above("btnListen", "btnStopExec")) && (await visible("btnUndo")));

  if (SWEEP) {
    writeFileSync(join(SHOTS, "sweep-issues.json"), JSON.stringify(sweepIssues, null, 1));
    console.log(`\nsweep: ${sweepIssues.length} findings in ${SHOTS}/sweep-issues.json`);
  }
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
