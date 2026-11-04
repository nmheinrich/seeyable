# Seeyable judging ZIP

## Install and try without an API key

1. Unzip the download and keep the extracted folder in place.
2. In desktop Chrome, open `chrome://extensions`, enable **Developer mode**,
   choose **Load unpacked**, and select the extracted **extension** folder
   (the folder containing `manifest.json`). Chrome 116 or newer is required.
3. Serve the included sample from a terminal in the extracted folder
   (or use the optional **DOCKER-SETUP.md** instructions to avoid installing Python):

   ```sh
   python3 -m http.server 8765 --bind 127.0.0.1 --directory demo-survey
   ```

4. Open http://127.0.0.1:8765/index.html and click Seeyable's toolbar icon.
5. Turn on **Tags**, then in **Assist** type
   `fill Full name with Ada Lovelace` and choose **Send**.
   The Full name field should change. Use fictional data only.
6. Choose **Undo** to restore the field. Open **Targets** to inspect controls.

No Node installation, build, model account, or API key is needed for this
basic typed-command check. Python 3 is needed for the sample server above.
The survey is a pre-existing test fixture, not the Seeyable product.
Chrome internal pages cannot be operated. Keep the sample server running
while testing; stop it with Ctrl+C afterward.

## Voice, Meta planning, and external agents

For voice, open **Settings → Voice and microphone → Microphone setup** and
grant microphone permission. Return to Assist and try saying `show tags`.
Without a configured Meta proxy, voice uses Chrome's Web Speech recognition;
network access may be needed and recognition is imperfect. Typed commands
remain available.

This ZIP also contains an optional Docker setup for the planner, MCP server,
and sample page; see **DOCKER-SETUP.md**. It is not a desktop installer.
Compound Meta planning and
Meta transcription require the local planner proxy and your own Meta API key.
External-agent use requires a compatible local MCP client and the MCP server;
that path does not require a Meta key in Seeyable. These are separate optional
setups, documented in the repository:

https://github.com/nmheinrich/seeyable#readme

Never paste a Meta API key into the extension. Planning and MCP share the
browser executor's safety gate; consequential actions require explicit human
confirmation. The key-free check above demonstrates local execution, not a
live Meta model call.
