# Muse Code local MCP acceptance — 2026-11-04

The owner tested the judging download with native Muse Code and Docker on
their Mac, retaining control of Chrome and client setup. After pairing,
the supplied prompt asked Muse to use Seeyable's MCP tools to find the local
Demo Survey at 127.0.0.1:8765, acquire a fresh snapshot, fill Full name with
Ada Lovelace, verify the field change, and not submit anything. The owner
reported: “Alright! That passes”.

Result: **owner-reported PASS for Muse Code discovery/snapshot/fill and
page verification**. No detailed tool transcript or screenshot was supplied;
this is not independent observation of the final page action. Installed
Muse Code version observed earlier: 1.4.13 (1.4.13-R6996.1).

Setup used the helper-generated Muse server entry with a temporary per-run
`mcp_servers.seeyable` override, rather than merging saved settings.json.
No saved Muse settings were edited by the assistant. Seeyable's MCP-only
Docker configuration had MODEL_API_KEY blank; Muse's own provider setup
is separate. The downloaded Dockerfile needed the application-permission
repair documented in docker-permissions.md before startup worked.

This was a guided owner test, not an unassisted judge usability pass.
Observed setup friction included an existing ChatGPT native bridge
reclaiming port 6123, missing private configuration creation, application
file permissions after extraction, and manual JSON merging. The image/ZIP
permission fix is published in r2. A direct helper launch option for Muse
would remove the remaining manual merge/long session-launch command; it
has not been implemented as part of this acceptance note.

Not tested/accepted here: Muse Submit hold/Cancel, voice, every action type,
cross-session reconnect, persistent Muse settings installation, or Claude.
The owner's Docker judging container is left under their control.
