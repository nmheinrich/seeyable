# Headed Act 2 acceptance — Codex Work chat

Issue #20 is accepted for the external-client workflow using Codex Work chat.
The Product Owner explicitly replaced the issue's original Claude Desktop
requirement with the already connected OpenAI client. Claude Desktop was
not tested; compatibility with it is not claimed.

## Direct PM-observed run

Through Seeyable MCP only, the PM selected the newly opened exact demo URL,
took a fresh schema-v2 snapshot of 20 controls, and highlighted Full name.
Four fills returned verified: Ada Lovelace, ada@example.com, Pioneer,
and Fictional visitor testing Seeyable. Designer was selected with the
snapshot's exact value `designer`; SMS updates and Monthly digest were
selected after checking current state. A fresh snapshot confirmed all
seven results and redacted Account PIN state.

Submit was attempted once and returned `held_for_approval` with
`CONFIRMATION_REQUIRED`, revision 8, and nothing performed. The Product
Owner confirmed the card cleared after human Cancel and the survey stayed
on screen. No agent approval was attempted.

## Product Owner-reported supplementary voice run

The owner reported successful English and Spanish Codex voice sessions:
text edits, role selection, email/SMS toggles, weekly/monthly selection,
and held Submit followed by intentional human cancellation. These are
owner-reported observations, not a recorded transcript or measured speech
accuracy benchmark. Numeric rating writes were rejected by fill; the owner
manually set rating 3, which the client then verified. This limitation is
not presented as successful agent editing.

The owner requested that the final form remain unchanged and unsubmitted.
No further writes were performed by the PM after that request. Supplementary
values and the dictated email are not reproduced here to avoid publishing
potential personal/contact information from a spoken test.

## Connection follow-up and acceptance limits

During the restart-check sequence, another chat reported tools unavailable
and supplied an unsupported claim that ChatGPT must be open in Chrome.
The PM subsequently called the real tools successfully in this Work chat:
17 tabs listed; the exact demo tab returned a 20-control snapshot at
revision 22, with the PIN redacted and no page mutation.

The owner identified Work chat as the required mode in this setup and
then requested the checkpoint. Record this as owner acceptance plus direct
read-only reconnection evidence. The PM did not observe the app quit/reopen
itself or collect process timestamps; do not describe it as an independently
instrumented cold-start or bridge-kill test. Work-chat tool availability
is an observed setup condition, not a claim about every OpenAI chat mode.

Automated no-replay, stale-target, redaction, and lifecycle evidence remains
separate in the supporting harness and prior MCP tests. The PM independently
reran the repository harness: 39/39 passed using temporary evidence output,
without changing the live pairing or the saved form.
