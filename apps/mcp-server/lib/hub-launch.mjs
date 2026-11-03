"use strict";
/*
 * Shared-bridge launch helpers for the stdio server: where the pairing
 * token comes from, and how the single detached bridge process is started.
 *
 * Token sources, in order:
 *  1. SEEYABLE_BRIDGE_TOKEN (operator-configured; never written to disk
 *     by Seeyable).
 *  2. <stateDir>/bridge-<port>.token — created once with mode 0600 inside a
 *     0700 directory when no env token is set, so every chat's process
 *     (and a restarted bridge) uses the same token and the extension keeps
 *     its pairing. It is refused if group/other can read it or another
 *     user owns it. Delete it to rotate the token.
 *  3. Otherwise a new random token is generated into that file.
 *     Publication is atomic: the token is written and fsynced into a
 *     private temp file in the same directory, then hard-linked to the
 *     final name. link() never overwrites, so exactly one concurrent
 *     creator wins; every other starter either sees no file yet (and
 *     races to publish its own complete token, losing cleanly) or a
 *     complete one, and all converge on the winner's token. The final
 *     pathname is never visible empty or partially written.
 *
 * The token reaches the bridge process on its stdin (never argv, never
 * the environment) and is never logged.
 */
import { spawn } from "child_process";
import { randomBytes } from "crypto";
import { closeSync, fstatSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { generatePairingToken } from "./bridge.mjs";

const here = dirname(fileURLToPath(import.meta.url));
export const HUB_SCRIPT = join(here, "..", "bridge-daemon.mjs");
const MAX_LOG_BYTES = 1024 * 1024;

export function stateDir(env = process.env) {
  return env.SEEYABLE_STATE_DIR || join(homedir(), ".seeyable");
}

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = statSync(dir);
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) {
    throw new Error(`State directory ${dir} is owned by another user; refusing to use it.`);
  }
}

function readPrivateToken(path) {
  const fd = openSync(path, "r");
  try {
    const st = fstatSync(fd);
    if ((st.mode & 0o077) !== 0) throw new Error(`${path} is readable by other users; fix with chmod 600 or delete it to re-pair.`);
    if (typeof process.getuid === "function" && st.uid !== process.getuid()) throw new Error(`${path} is owned by another user; refusing it.`);
    const token = readFileSync(fd, "utf8").trim();
    if (!/^[0-9a-f]{64}$/.test(token)) throw new Error(`${path} does not contain a valid pairing token; delete it to re-pair.`);
    return token;
  } finally { closeSync(fd); }
}

/** @returns {{ token: string, source: "env"|"file"|"generated", path: string|null }} */
export function resolveToken({ port, env = process.env } = {}) {
  if (env.SEEYABLE_BRIDGE_TOKEN) return { token: env.SEEYABLE_BRIDGE_TOKEN, source: "env", path: null };
  const dir = stateDir(env);
  ensureDir(dir);
  const path = join(dir, `bridge-${port}.token`);
  try {
    return { token: readPrivateToken(path), source: "file", path };
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  const token = generatePairingToken();
  const tmp = join(dir, `.bridge-${port}.token.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  const fd = openSync(tmp, "wx", 0o600);
  try {
    try {
      writeSync(fd, `${token}\n`);
      fsyncSync(fd);
    } finally { closeSync(fd); }
    try {
      linkSync(tmp, path); // atomic publish; fails if another creator won
    } catch (err) {
      if (err.code === "EEXIST") return { token: readPrivateToken(path), source: "file", path };
      throw err;
    }
    return { token, source: "generated", path };
  } finally {
    try { unlinkSync(tmp); } catch {}
  }
}

/**
 * Start the shared bridge process, detached from this MCP client so
 * closing this chat never closes the bridge other chats use. If another
 * process wins the bind race, the extra one exits quietly by itself.
 */
export function spawnHubProcess({ port, token, env = process.env, log = () => {} }) {
  const dir = stateDir(env);
  ensureDir(dir);
  const logPath = join(dir, `bridge-${port}.log`);
  let flags = "a";
  try { if (statSync(logPath).size > MAX_LOG_BYTES) flags = "w"; } catch {}
  const out = openSync(logPath, flags, 0o600);
  const childEnv = { ...env };
  delete childEnv.SEEYABLE_BRIDGE_TOKEN;
  let child;
  try {
    child = spawn(process.execPath, [HUB_SCRIPT, "--port", String(port)], {
      detached: true,
      stdio: ["pipe", out, out], // never this process's stdout: that is MCP protocol
      env: childEnv,
      cwd: dir,
    });
  } finally { closeSync(out); }
  child.on("error", (err) => log(`[seeyable-mcp] shared bridge process failed to start: ${err.message}`));
  child.stdin.on("error", () => {});
  child.stdin.end(`${token}\n`);
  child.unref();
  log(`[seeyable-mcp] started shared bridge process (pid ${child.pid}); its log: ${logPath}`);
  return child.pid;
}
