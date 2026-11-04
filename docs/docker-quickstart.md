# Optional Docker setup

Docker runs Seeyable's local planner and sample page without installing Node
or Python on your computer. Chrome and the extension stay on your computer.
A compatible MCP client can also use the server inside the running container.
This is local Docker, not cloud MCP. The existing manual setup remains supported.

## Start

1. Install and open [Docker Desktop](https://docs.docker.com/desktop/).
   It includes Docker Compose. Internet access is needed for the first build
   and for live model calls.
2. Download/extract the Seeyable repository, or use the judging ZIP. Open a
   terminal in the folder containing `compose.yaml`.
3. Create your local configuration once:

   ```sh
   cp -n docker/.env.example docker/.env
   chmod 600 docker/.env
   ```

   For Meta planning/transcription, open `docker/.env` in an editor and set
   `MODEL_API_KEY` to your own Meta Model API key. Leave it blank for sample-page
   and MCP-only use. Never enter this key into the extension or share the file.
4. Start the services:

   ```sh
   docker compose up --build
   ```

   Keep this running. The first build downloads Node and MCP dependencies.
   A successful startup prints the planner pairing token. Starting without a
   key is allowed, but live planning will return `NO_API_KEY`.
5. Load the extension unpacked in Chrome: select `apps/extension` from the
   repository, or `extension` from the judging ZIP. Open
   http://127.0.0.1:8765/index.html and click Seeyable's toolbar icon.
   The sample is a pre-existing fixture; use fictional data only.
6. Try `fill Full name with Ada Lovelace` in Assist. No API key is needed.
   For compound planning, open **Settings → Advanced → Developer view →
   Planner proxy (local)**, paste the **planner pairing token**, keep port
   **6124**, and choose **Pair planner**. Try
   `Put Ada Lovelace in Full name and Pioneer in Nickname.`, review the plan,
   approve it, and verify both fields changed.

Microphone setup and voice limitations are the same as the manual installation.
Live speech/model access is not established just by starting the container.

## Optional: connect an MCP client

On macOS/Linux, run `sh setup-mcp.sh` from the judging folder (or
`sh scripts/setup-mcp.sh` in the repository). Choose your agent, add the
generated configuration, then paste the copied token into Seeyable.
No environment-variable entry is needed for the recommended setup.

For manual token generation, pairing, and configurations for ChatGPT desktop/Codex,
Claude Desktop/Code, and Muse Code, see **MCP-SETUP.md** in the judging ZIP
(repository: `docs/local-mcp-setup.md`). No Meta key is needed in Seeyable
for MCP-only use; the external agent has its own account/model setup.

Keep the Compose service running. Find Docker's executable with `command -v docker`
(on Windows use the executable path for your installation). For a client using
`mcpServers` JSON, adapt this configuration:

```json
{
  "mcpServers": {
    "seeyable": {
      "command": "/absolute/path/to/docker",
      "args": [
        "compose", "--project-directory", "/absolute/path/to/seeyable",
        "exec", "-T", "--user", "node", "seeyable", "node", "apps/mcp-server/server.mjs"
      ]
    }
  }
}
```

Use the folder containing `compose.yaml` as the project directory. Preserve
existing client servers. `-T` avoids terminal formatting on the MCP protocol;
stdin remains connected. `--user node` makes clients share the same home
directory and private token volume. Do not use `docker compose run`: every client must
join the same running service to share its bridge. The MCP client launches
its stdio process, which starts the shared bridge automatically inside that
container. No MCP protocol endpoint is published over HTTP.

The first client generates a bridge token. Read it locally if needed:

```sh
docker compose exec -T --user node seeyable cat /home/node/.seeyable/bridge-6123.token
```

If the file is missing, connect the MCP client first and inspect its server
log. Paste this **MCP bridge token** into the extension's MCP bridge settings,
keep port **6123**, and connect. It is different from the planner token and
from the Meta key. Never paste tokens into an agent conversation or screenshot.
Follow the README's MCP workflow for tab selection, pairing, and human confirmation.

## Stop, restart, and troubleshoot

- Stop with Ctrl+C, then `docker compose down` to remove the container/network.
- Start again with `docker compose up`. Re-pair the planner after a restart;
  its generated token changes. Reconnect MCP clients and the extension bridge.
- The named `bridge-state` volume retains the MCP token across container
  recreation. `docker compose down --volumes` deletes that state; reconnect a
  client and pair with the new token afterward.
- After editing `docker/.env`, use `docker compose up --force-recreate` so the
  planner reads the new key.
- If a port is occupied, stop the manually running planner, sample server, or
  MCP clients/bridge using it first. Do not run both setups on the same ports.
- Logs: `docker compose logs seeyable`. Planner startup logs contain a pairing
  token; redact it before sharing.
- `EACCES` for an `/app/...` file after startup: older downloads could preserve
  root-only source permissions from ZIP extraction. Current images normalize
  public application files during build; private runtime configuration is
  separate. Use the corrected download and rebuild with `docker compose up --build`.

## Implementation and verification limits

Compose publishes ports 6123, 6124, and 8765 only on host `127.0.0.1`.
Container-only TCP adapters forward to the unchanged loopback-bound planner and
MCP bridge. Pairing, origin checks, snapshot validation, Stop, and action
confirmation remain in their existing components. The Docker network itself
is not an authentication boundary; do not attach untrusted containers to it.
No Docker socket or host source folders are mounted. The build context uses
an allowlist and excludes environment files. Compose mounts `docker/.env` as
a read-only configuration secret; the launcher passes its key only to the
planner process, rather than adding it to every MCP process's environment.
This is a local file mount, not an encrypted credential vault.
The launcher reads that private file before dropping root privileges to the
image's `node` user; the planner, adapters, and MCP processes run as that user.

Docker backend verification passed on 2026-11-04 after correcting the judging
ZIP's missing Docker fixture path: build/start from a fresh extraction,
loopback port mapping, authentication, missing-key refusal, a live Meta
two-field plan, and two stdio MCP clients. The owner also confirmed Chrome
planner pairing and execution of the reviewed two-field fill plan. The
corrected judging package includes the required Docker fixture path.
Verification details are recorded in the repository under
`docs/evidence/judge-first-run/docker-check.md`.

Validation on 2026-11-04 (Node 24.20.0, without Docker):

- `node --test --test-timeout=20000 docker/relay.test.mjs`: 2 passed,
  exercising the real planner HTTP and bridge WebSocket authentication through
  the new TCP adapter, including rejected credentials and origins.
- `npm --prefix apps/planner-proxy test`: 22 passed, stub upstream only.
- `npm --prefix apps/mcp-server test`: 41 passed.
- Judging archive: integrity, byte-for-byte contents, and extension asset
  references verified by `python3 scripts/package-judging.py`.

Docker-specific browser checks still outstanding: Submit hold/Cancel,
additional MCP-controlled page actions, voice/transcription, and re-pairing after restart.
The owner subsequently passed a guided Muse Code MCP snapshot/fill/verification
check; see `docs/evidence/judge-first-run/muse-code-acceptance.md`.
These are separate from the accepted Chrome planner pairing/two-field plan.
