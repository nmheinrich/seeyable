"use strict";
/*
 * Service worker for Seeyable snapshots.
 *
 * Responsibilities:
 *  - Open the side panel when the action is clicked.
 *  - Own the chrome.debugger lifecycle for the CDP snapshot path
 *    (attach -> Accessibility.enable -> getFullAXTree -> detach).
 *    The side panel never touches chrome.debugger directly.
 *
 * The debugger session is always detached in `finally`: a leaked attach
 * leaves Chrome's "started debugging this browser" banner stuck on.
 */

// `chrome.debugger` is undefined unless the `debugger` permission is granted
// (debug variant only). Every use below is guarded: dereferencing it in the
// standard build throws at service-worker startup and fails SW registration.
// Issue #28 spike: localhost MCP bridge client (WebSocket, outbound only).
try { importScripts("lib/bridge-client.js"); } catch (err) {
  console.warn("[seeyable] bridge client failed to load:", err);
}
console.info(`[seeyable] service worker evaluated at ${new Date().toISOString()}`);
// Restore a previously requested bridge pairing on ordinary worker
// initialization (every wake re-evaluates this file), not only on
// browser startup. Listeners below still register synchronously.
if (typeof globalThis.__seeyableBridgeMaybeReconnect === "function") {
  globalThis.__seeyableBridgeMaybeReconnect();
}

const hasDebuggerApi = typeof chrome.debugger !== "undefined";

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((err) => {
  console.warn("[seeyable] setPanelBehavior failed:", err);
});

chrome.runtime.onInstalled.addListener(() => {
  console.info("[seeyable] extension installed");
});

chrome.runtime.onStartup.addListener(() => {
  if (typeof globalThis.__seeyableBridgeMaybeReconnect === "function") {
    globalThis.__seeyableBridgeMaybeReconnect();
  }
});

// Wrap chrome.debugger callback APIs in promises (MV3 service workers have
// no guarantee of chrome.debugger.* returning promises in every version).
function debuggerSendCommand(target, method, params) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand(target, method, params || {}, (result) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(`${method}: ${err.message}`));
      else resolve(result);
    });
  });
}
function debuggerAttach(target, protocolVersion) {
  return new Promise((resolve, reject) => {
    chrome.debugger.attach(target, protocolVersion, () => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(`attach: ${err.message}`));
      else resolve();
    });
  });
}
function debuggerDetach(target) {
  return new Promise((resolve) => {
    chrome.debugger.detach(target, () => {
      void chrome.runtime.lastError; // detaching an unattached target is fine
      resolve();
    });
  });
}

async function snapshotViaCdp(tabId) {
  if (!hasDebuggerApi) {
    throw new Error(
      "chrome.debugger is unavailable in the standard build (no debugger permission by design). " +
      "Load the debug variant (manifest.debug.json) to test the CDP path."
    );
  }
  const target = { tabId };
  const started = Date.now();
  await debuggerAttach(target, "1.3");
  console.info(`[seeyable] debugger attached to tab ${tabId}`);
  try {
    await debuggerSendCommand(target, "Accessibility.enable");
    const raw = await debuggerSendCommand(target, "Accessibility.getFullAXTree");
    return { raw, durationMs: Date.now() - started };
  } finally {
    await debuggerDetach(target);
    console.info(`[seeyable] debugger detached from tab ${tabId}`);
  }
}

if (hasDebuggerApi && chrome.debugger.onDetach) {
  chrome.debugger.onDetach.addListener((source, reason) => {
    console.info("[seeyable] debugger detached:", source, reason);
  });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message.type !== "string") return false;

  if (message.type === "SEEYABLE_SNAPSHOT_CDP") {
    (async () => {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab || tab.id === undefined) throw new Error("No active tab found.");
        const { raw, durationMs } = await snapshotViaCdp(tab.id);
        sendResponse({
          ok: true,
          tab: { id: tab.id, url: tab.url || null, title: tab.title || null },
          durationMs,
          raw,
        });
      } catch (err) {
        console.error("[seeyable] CDP snapshot failed:", err);
        sendResponse({ ok: false, error: String(err && err.message ? err.message : err) });
      }
    })();
    return true; // async sendResponse
  }

  if (message.type === "SEEYABLE_BRIDGE_CONNECT") {
    (async () => {
      try {
        if (typeof globalThis.__seeyableBridgeConnect !== "function") throw new Error("Bridge client unavailable.");
        sendResponse(await globalThis.__seeyableBridgeConnect({ token: message.token, port: message.port }));
      } catch (err) {
        sendResponse({ ok: false, error: String(err && err.message ? err.message : err) });
      }
    })();
    return true;
  }
  if (message.type === "SEEYABLE_BRIDGE_DISCONNECT") {
    (async () => {
      try { sendResponse(await globalThis.__seeyableBridgeDisconnect()); }
      catch (err) { sendResponse({ ok: false, error: String(err && err.message ? err.message : err) }); }
    })();
    return true;
  }
  if (message.type === "SEEYABLE_BRIDGE_STATUS") {
    try { sendResponse(globalThis.__seeyableBridgeStatus()); }
    catch (err) { sendResponse({ ok: false, error: String(err && err.message ? err.message : err) }); }
    return false;
  }
  return false;
});
