# Seeyable — Extension Security & Permission Notes (internal)

> Last updated: 2026-10-27 · Version: 0.1.0
>
> **Not a Chrome Web Store submission document.** Seeyable is not being
> prepared for store publication during the hackathon. This file follows
> the `chrome-extensions` skill's `CHROMEWEBSTORE.md` practice at
> proportional scope: one place that records what the extension does,
> why each permission exists, and what data it touches, so security
> decisions are reviewable. Store-listing copy, screenshots, and a
> hosted privacy policy are deliberately deferred.

## Single purpose

Current build: capture a labelled snapshot of the current page's
interactive controls (DOM/ARIA, with a debug-only CDP cross-check),
show numbered word tags, execute single validated actions from a
manual test panel, and accept push-to-talk voice or typed commands
that only show/hide those tags. No planner, AI, or MCP server exists
in this build, and voice/typed commands never execute page actions.

## Permissions justification (standard `manifest.json`)

| Permission | Type | Justification |
|---|---|---|
| `activeTab` | permissions | Lets the extension interact with the tab the user is viewing when they open the panel from the toolbar, without standing access to all sites. |
| `scripting` | permissions | Fallback injection of the snapshot script into a tab that was open before the extension was installed/reloaded. Primary path is the declared content script. |
| `sidePanel` | permissions | Shows the snapshot tool beside the page so users can capture and inspect results without leaving the page. |
| `storage` | permissions | Reserved for local extension state. No user page data is persisted by the spike. |
| content-script matches `<all_urls>` | content_scripts | The declared snapshot/highlight scripts must be able to run on the page being examined; this is the spike's subject matter. Scoping is revisited before any non-spike release. |
| `debugger` | **not declared** | Deliberately absent in every form. Chrome forbids `debugger` in `optional_permissions` (load error), and the product path must not require it. Present **only** in `manifest.debug.json`, a clearly-marked local debug variant that must never ship. |

### Pending approval — do not apply silently

Per `chrome-extensions` guidance, `activeTab` is **not** re-granted by
clicks inside a side panel, and reading `tab.url`/`tab.title` is most
reliable with the `tabs` permission. If the team wants the scripting
fallback (and tab metadata) to work unconditionally from panel buttons,
the skill-recommended change is: add `tabs` to `permissions` and scoped
`host_permissions`. That broadens capability, so it requires
explicit maintainer approval with a scoped-origin decision (specific
origins vs `<all_urls>`) before it lands. Current least-privilege
behavior: declared content script (works after tab load/reload) plus an
actionable error if the fallback is refused.

## Safety gate (Feature #11)

Consequential activation (submit/pay/delete/send/publish patterns and
native submit semantics) is held by the executor for single-use human
approval. Approval authority lives only in the content-script
executor; the panel sends a challenge ID over a route the content
script accepts solely from the browser-identified side-panel sender
(extension ID, no sender tab, exact panel URL). No token crosses a
messaging boundary, no caller field can mint approval, and approvals
expire after 60 seconds bound to the target, action, value, document
session, revision, and a SHA-256 digest of the effective submission. Panel Stop/Pause
revoke pending approvals; Resume replays nothing. The bounded,
in-memory action log records only timestamp, caller-reported source
(audit only, never authorization), action, target ID/name, decision,
and an approved flag — never values, transcripts, or challenge IDs.

## Privacy & data use (spike behavior, from the code)

- **Website content:** snapshots read interactive-element roles, names,
  state, and geometry on the current page, only when the user clicks a
  snapshot button. Results are displayed in the panel and copied/
  downloaded only at the user's request.
- **Sensitive values:** password and payment-like field values are
  replaced with `"[REDACTED]"` in DOM snapshots before display.
- **Transmission:** the extension itself makes no network requests
  and has no analytics. One exception is browser-provided: Web Speech
  recognition in Chrome may send audio to a remote recognition
  service, so voice input is not guaranteed offline. Seeyable stores
  no audio, persists no transcripts, and logs no raw utterances;
  transcripts appear only in the panel's visible transcript line and
  never in snapshot copy/download output. A user-initiated microphone
  setup page (`mic-setup.html`) requests mic permission for the
  extension origin and stops the stream immediately. CDP raw trees
  (debug variant only) stay in the panel.
- **Retention:** snapshots live in panel memory until cleared or the
  panel closes; downloads are user-initiated files.

## Version history

| Version | Date | Changes | Status |
|---|---|---|---|
| 0.1.0 | 2026-10-27 | Initial snapshot build; removed invalid optional `debugger`, guarded `chrome.debugger` in the service worker, actionable DOM-access errors | Internal only |

## Known review risks (for later, non-spike releases)

- `<all_urls>` content-script scope and any future `host_permissions`
  will draw store scrutiny; narrow or justify before submission.
- The debug variant must never be packaged; packaging scripts (future)
  should fail if `debugger` appears in the shipped manifest.
