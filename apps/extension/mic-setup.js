"use strict";
/* Microphone permission setup (Feature #10).
 *
 * Requests a short-lived audio stream solely so Chrome records the
 * microphone permission decision for this extension origin. Tracks are
 * stopped immediately; nothing is recorded, stored, or transmitted. */

const statusEl = document.getElementById("micStatus");

function setStatus(text, isError) {
  statusEl.textContent = text;
  statusEl.classList.toggle("error", Boolean(isError));
}

document.getElementById("btnEnableMic").addEventListener("click", async () => {
  if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== "function") {
    setStatus("Microphone access is not available in this browser context. Typed commands in the side panel remain available.", true);
    return;
  }
  setStatus("Requesting microphone permission…");
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    for (const track of stream.getTracks()) track.stop();
    setStatus("Microphone access granted for Seeyable. Close this tab, return to your page, open the side panel, and choose “Start listening”.");
  } catch (err) {
    if (err && (err.name === "NotAllowedError" || err.name === "SecurityError")) {
      setStatus("Microphone access was denied. Voice input will stay unavailable until it is allowed in Chrome's site/extension settings; typed commands in the side panel remain available.", true);
    } else if (err && err.name === "NotFoundError") {
      setStatus("No microphone was found. Typed commands in the side panel remain available.", true);
    } else {
      setStatus(`Microphone setup failed: ${(err && err.message) || err}. Typed commands in the side panel remain available.`, true);
    }
  }
});
