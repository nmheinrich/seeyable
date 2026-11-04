# Connect a local AI agent to Seeyable

Use Seeyable from ChatGPT desktop/Codex, Claude Desktop/Code, or Muse Code
through a **local stdio MCP server**. The agent runs on your computer and
launches a process inside the running Seeyable Docker container. Chrome
and the extension stay on your computer. No public MCP URL is needed.

These instructions describe client-supported configuration, not a claim
that every client has passed a Seeyable end-to-end test. The accepted
agent demonstration used Codex Work chat. Docker stdio initialization and
tool discovery passed with two clients. On 2026-11-04 the owner also passed
a guided Muse Code test: find the Docker sample, snapshot, fill Full name
with Ada Lovelace, and verify the field. It used a per-session configuration
override; persistent settings and Muse Submit hold/Cancel remain unverified.
Claude browser acceptance is still pending. Muse Code is the local coding agent;
this guide does not establish support for a cloud Muse chat or other Muse apps.

## Quick setup — recommended (macOS/Linux)

Start the Seeyable Docker service first, then run this in the extracted
judging folder:

```sh
sh setup-mcp.sh
```

In a repository checkout, run `sh scripts/setup-mcp.sh` instead.

1. Choose ChatGPT desktop/Codex, Claude Desktop, Claude Code, or Muse Code.
2. The helper displays and saves the right configuration with your actual
   Docker/folder paths. Add it to the client as directed; preserve existing
   settings. No environment variables or Meta API key are needed here.
3. Press Enter after adding the server. The helper copies the generated MCP
   token to your clipboard on macOS, or on Linux with `wl-copy`/`xclip`.
   Paste it into Seeyable's **Settings → Advanced → Developer view → MCP
   bridge**, keep port **6123**, and choose **Connect bridge**.

The helper does not install software, edit agent settings, start Docker,
rotate tokens, or approve page actions. It reuses the existing private token.
Keep the token out of agent chats. If clipboard access is unavailable, it
shows a command to read the token locally instead. Configuration files are
saved without tokens under `.seeyable-setup` in the extracted folder.
Already using an explicit `SEEYABLE_BRIDGE_TOKEN` override? Keep that setup
consistent across clients or remove the override before switching to this
file-based setup; see Advanced below. Windows users can follow the manual
configuration below; this shell helper is for macOS/Linux.

Then use the safe task in **Pair Chrome, then try a safe task** below to
confirm a real page action. Configuration generation alone is not a pass.
The remaining sections are manual alternatives and troubleshooting.

## 1. Start Docker and the sample

Follow **DOCKER-SETUP.md** in the judging ZIP (repository:
`docs/docker-quickstart.md`). Keep `docker compose up --build` running.
For MCP-only use, create `docker/.env` from its example but leave
`MODEL_API_KEY` blank. Your agent uses its own account/model configuration;
Seeyable's MCP server does not call the planner proxy.

Open http://127.0.0.1:8765/index.html in Chrome and open Seeyable's panel.
Use fictional data on this pre-existing survey fixture.

From the folder containing `compose.yaml`, find the paths for your setup:

```sh
command -v docker
pwd
```

The examples below use `/absolute/path/to/docker` for the executable and
`/absolute/path/to/seeyable` for that extracted folder. Replace both in
every example. On macOS, if Docker is missing from PATH, its executable is
usually `/Applications/Docker.app/Contents/Resources/bin/docker`.
On Windows use your Docker executable's absolute path and your extracted
folder path, escaping backslashes as `\\` in JSON strings. The terminal
examples use macOS/Linux shell syntax.

Keep the extracted folder in place after configuring a client. Preserve
existing servers/settings when adding Seeyable; do not replace entire files.

## 2. Generate and read the MCP pairing token

| Credential | Created by | Used for |
|---|---|---|
| MCP bridge token | Seeyable, automatically on the first MCP client startup | Pair the extension to the local MCP bridge on port 6123 |
| Planner pairing token | Planner at startup; changes after restart | Pair the panel to its planner on port 6124 |
| Meta API key | Your Meta account | Optional panel planning/transcription; supplied only to the proxy |

You do not obtain an MCP key from Meta, OpenAI, or Anthropic. Seeyable
generates a random 32-byte token, stored as 64 hexadecimal characters.
The file is private to the container's `node` user (0600), in the persistent
`bridge-state` volume. All local clients share that bridge and token.

The simplest path is to configure one client in section 3 and let it connect.
That creates the token automatically. If you want to generate it beforehand,
run this once from the Compose folder while the container is running:

```sh
docker compose exec -T --user node seeyable node --input-type=module -e 'import { resolveToken } from "./apps/mcp-server/lib/hub-launch.mjs"; resolveToken({ port: 6123 }); console.log("MCP token ready.");'
```

This uses the same generator as the server and preserves an existing token.
It does not start a client or bridge by itself. Read the token locally:

```sh
docker compose exec -T --user node seeyable cat /home/node/.seeyable/bridge-6123.token
```

Paste it into the extension's MCP pairing field in section 4 (and, if you
choose the explicit-token option below, its private client configuration). Never
put it into an agent conversation, screenshot, source file, or issue.
Client configurations below do not need the token: their local processes
read the private file themselves. Leave `SEEYABLE_BRIDGE_TOKEN` unset for
this default shared-token setup.

## 3. Configure your agent

All examples launch the same command: `docker compose ... exec -T --user
node seeyable node apps/mcp-server/server.mjs`. Use **exec**, not **run**,
so clients join the existing container and token volume. `-T` keeps terminal
formatting out of stdio. Do not start another MCP server manually in a terminal.

### ChatGPT desktop and Codex

In a desktop version offering **Settings → MCP servers**, choose **Add
server**, name it `seeyable`, select **STDIO**, and enter the executable
and arguments below. Save and restart the client. Alternatively, merge
this entry into `~/.codex/config.toml`:

```toml
[mcp_servers.seeyable]
command = "/absolute/path/to/docker"
args = ["compose", "--project-directory", "/absolute/path/to/seeyable", "exec", "-T", "--user", "node", "seeyable", "node", "apps/mcp-server/server.mjs"]
```

If you use the Codex CLI instead, register it with:

```sh
codex mcp add seeyable -- /absolute/path/to/docker compose --project-directory /absolute/path/to/seeyable exec -T --user node seeyable node apps/mcp-server/server.mjs
```

Use `/mcp` to inspect connections. These are local desktop/Codex instructions.
A ChatGPT web custom-connector URL is not the same setup and cannot be
filled with Seeyable's bridge address. Workspace policies and client versions
may affect availability. [Official OpenAI MCP guidance](https://learn.chatgpt.com/docs/extend/mcp).

### Claude Desktop

Open **Settings → Developer → Edit Config** in Claude Desktop. Merge this
server into the existing `mcpServers` object, then fully quit and reopen Claude:

```json
{
  "mcpServers": {
    "seeyable": {
      "command": "/absolute/path/to/docker",
      "args": ["compose", "--project-directory", "/absolute/path/to/seeyable", "exec", "-T", "--user", "node", "seeyable", "node", "apps/mcp-server/server.mjs"]
    }
  }
}
```

Check the configured server and available Seeyable tools in Claude. This
uses the desktop local-server configuration, not a remote connector URL.
[Official MCP local-server tutorial](https://modelcontextprotocol.io/docs/develop/connect-local-servers).

### Claude Code

From your intended working folder, register a local stdio server:

```sh
claude mcp add --transport stdio seeyable -- /absolute/path/to/docker compose --project-directory /absolute/path/to/seeyable exec -T --user node seeyable node apps/mcp-server/server.mjs
```

Then run `/mcp` in Claude Code to check the connection. The default CLI
registration scope is local to that project; choose a broader scope only
if you want it elsewhere. [Official Claude Code MCP guidance](https://code.claude.com/docs/en/mcp).

### Muse Code

Merge this entry into `~/.config/muse/settings.json`, preserving existing
settings and other servers:

```json
{
  "mcp_servers": {
    "seeyable": {
      "transport": "stdio",
      "command": "/absolute/path/to/docker",
      "args": ["compose", "--project-directory", "/absolute/path/to/seeyable", "exec", "-T", "--user", "node", "seeyable", "node", "apps/mcp-server/server.mjs"],
      "enabled": true,
      "mode": "optional"
    }
  }
}
```

For a one-session test without editing saved settings, open another terminal
in the extracted judging folder and run:

```sh
muse -c "mcp_servers.seeyable=$(docker compose exec -T --user node seeyable node -p 'JSON.stringify(JSON.parse(require("fs").readFileSync(0,"utf8")).mcp_servers.seeyable)' < .seeyable-setup/seeyable-muse.json)"
```

This uses the helper-generated file and leaves saved Muse settings alone.
The owner used this session-only route successfully. Return to the waiting
helper and press Enter to copy the MCP token, then pair Chrome as below.

Start a new Muse Code session and run `/mcp`. Optional mode allows the
session to start if Docker is unavailable; it does not establish a connection.
Muse Code's provider sign-in is separate from Seeyable's pairing token.
[Meta MCP guidance](https://dev.meta.ai/docs/muse-code/extending) and
[settings location](https://dev.meta.ai/docs/muse-code/configuration).

## 4. Pair Chrome, then try a safe task

1. Ensure the client reports Seeyable connected and its tools are available.
2. In Seeyable open **Settings → Advanced → Developer view → MCP bridge
   (local spike)**. The current heading retains “local spike”. Paste the
   **MCP bridge token**, keep port **6123**, and choose **Connect bridge**.
3. Keep the panel open. Ask the agent:

   > Use Seeyable's MCP tools. List the browser tabs and identify the local
   > Demo Survey at 127.0.0.1:8765; ask me if more than one matches. Get a
   > fresh page snapshot for that exact tab. Fill Full name with Ada Lovelace
   > using the snapshot's target and document identifiers. Report whether
   > the page value was verified. Do not submit the form.

4. Verify the field changed in Chrome. Success means a page-verified result,
   not just tool discovery or a dispatched action. After any page change,
   the agent must reacquire current targets rather than reuse stale IDs.
5. To check the approval gate, ask the agent to request **Submit survey**
   once and stop at the hold. Choose **Cancel** yourself in the panel;
   verify nothing submitted. Do not ask the agent to approve its own action.

Tools include `list_tabs`, `page_snapshot`, `highlight`/`highlight_target`,
`click`, `fill`, `select`, and `read_section`. Consequential actions use the
same browser executor safety gate as the panel. Agent-side permissions
and Seeyable's human confirmation are separate checks.

## Recovery and token rotation

- **Token file missing:** start a configured client, or use section 2's
  generator. The container being up alone does not create an MCP token.
- **Connected client but no tabs:** pair the extension and keep Chrome open.
- **Cannot find the Compose file/service:** check absolute paths, Docker
  running, and `docker compose ps` from the correct folder.
- **Wrong token:** ensure you used the MCP token, not the planner token or
  Meta key. Avoid mixing a native host bridge with the Docker bridge on 6123.
- **Container recreation:** the named volume preserves the MCP token.
  Pair again if extension session state was lost. The planner token changes
  independently; it is not the MCP token.
- **Rotate the MCP token deliberately:** disable Seeyable in every MCP
  client, disconnect the extension bridge, and stop the Compose service.
  Restart the service, then remove only the MCP token file:

  ```sh
  docker compose exec -T --user node seeyable rm /home/node/.seeyable/bridge-6123.token
  ```

  Re-enable one client to generate a replacement, read it locally, and
  pair Chrome again. Do this only when you intend to invalidate pairing;
  keep clients disabled until the file is removed. The stop/restart ensures
  the previous in-memory bridge has exited. Do not delete the entire volume
  just to rotate one token.

For native Node setup, use the repository README's MCP section instead.
Its token lives on the host at `~/.seeyable/bridge-6123.token`, not in Docker.
Client-specific end-to-end checks remain separate from these instructions.

## Advanced: explicit environment token

The default above reads the generated token file and needs no environment
entry. If your setup uses an explicit token, add this in the MCP server's
**Environment variables** fields:

| Name | Value |
|---|---|
| `SEEYABLE_BRIDGE_TOKEN` | The MCP token you read locally in section 2 |

Use the same token in the extension. For Docker, also add **two arguments**
`-e` and `SEEYABLE_BRIDGE_TOKEN` after `exec`, before the service name.
The environment field sets the Docker client's environment; this argument
forwards it into the container's MCP process. Adding the field alone does
not configure the process inside Docker.

For the TOML configuration, use this complete entry instead of the default
one above (replace paths and the placeholder locally; do not paste the real
token into a conversation or commit the private configuration):

```toml
[mcp_servers.seeyable]
command = "/absolute/path/to/docker"
args = ["compose", "--project-directory", "/absolute/path/to/seeyable", "exec", "-e", "SEEYABLE_BRIDGE_TOKEN", "-T", "--user", "node", "seeyable", "node", "apps/mcp-server/server.mjs"]

[mcp_servers.seeyable.env]
SEEYABLE_BRIDGE_TOKEN = "PASTE_YOUR_LOCAL_MCP_TOKEN_HERE"
```

Save and restart the MCP connection. An explicit environment token takes
precedence over the token file and is not written to that file. Use the
same token in every client sharing this bridge; mixing values prevents
clients from joining. Reusing the generated file token avoids changing
the already running bridge. If you deliberately choose a different token,
disconnect all clients and the extension, stop/restart the container, and
then reconnect every client with that same override and re-pair Chrome.
The file-reading/rotation instructions elsewhere apply to the default
setup, not to an override stored in client configuration.

For a native Node MCP server, the environment field reaches Node directly;
the Docker `-e` forwarding arguments are unnecessary. Other clients that
offer an `env` object can use the same variable and Docker forwarding rule.
