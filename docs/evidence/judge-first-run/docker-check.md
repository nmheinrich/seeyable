# Docker verification — 2026-11-04

Backend checks passed using Docker Desktop 4.98.0, Docker Engine 29.9.2,
native Linux aarch64 on the owner's Apple Silicon Mac. The owner confirmed
planner pairing and the reviewed two-field plan changed both sample fields
in Chrome. Computer control remained with the owner.

## Package and isolation

The original published ZIP omitted `apps/demo-survey/index.html`, a required
Dockerfile COPY source. The packager now includes this path alongside the
existing `demo-survey/index.html` quickstart path, and checks that each COPY
source exists in its payload. A negative probe confirmed that the guard
rejects the original layout. No extension runtime files changed.

Checked corrected local ZIP: 325,436 bytes, 54 files, SHA-256
`9df2dadc76a8ba6d5a194d957580a96df89339570dce4a48c00e8b28a5c9c817`.
Source is merged main `b3188fb` plus the uncommitted packager fix. All 53
original archive files were byte-identical; only the Docker fixture path
was added. After owner acceptance, setup notes were refreshed and the release
attachments replaced with the corrected distribution ZIP: 325,500 bytes,
54 files, SHA-256
`ffed57c22b83775c7223f6ba31ab35ef282f2702bf40f25c6f2cb5fbf9ab8c37`.
Only DOCKER-SETUP.md differs from the Docker-tested extraction. Anonymous
download, checksum, ZIP integrity and the required Docker fixture path were
verified after upload to the existing v0.1.0-judging release. The release
notes disclose that packaging/documentation changes await a repository commit.

Built from a fresh ZIP extraction, not the repository build context:
`/var/folders/sy/5090ydp5055dj29gg4n10cwc0000gn/T/seeyable-docker-check-mbhgig9o/seeyable-judging-0.1.0`.
Compose project `seeyable-judge-check` uses a test-only copy of compose.yaml
with host ports 16124 (planner), 16123 (bridge), and 18765 (fixture).
All mappings retain host 127.0.0.1. Existing services on 6124/6123/8765
were left running. The image and application configuration otherwise match
the package. Default-port availability was not tested.

## Observed results

- Docker image build and detached Compose startup passed from the extraction.
- Packaged fixture returned HTTP 200 at `/index.html`.
- Planner `/v1/status`: missing credentials returned 401, paired extension
  origin returned 200, foreign origin returned 403.
- Blank runtime key configuration reported `keyConfigured: false` and
  planning returned `NO_API_KEY`.
- A private runtime-only configuration using the existing local Meta key
  was mounted after the image build; no key was printed or packaged.
- Force-recreation passed and rotated the planner pairing token.
- Live Meta planning with synthetic snapshot targets Full name and Nickname
  returned exactly two valid fill steps: Ada Lovelace and Pioneer, against
  the supplied target IDs. HTTP 200, 7.64 seconds, no page actions executed.
- Two concurrent Docker stdio MCP clients initialized and each listed eight
  tools. Published bridge rejected an incorrect token (4401) and accepted
  its private token. No browser was simulated and no page action was sent.
- Container execution as `node` returned UID 1000; Docker inspection confirmed
  all three host port bindings use 127.0.0.1.
- Existing native relay authentication tests passed 2/2.

The image build's npm audit reported one high-severity advisory for the
existing zod 3.25.76 dependency (GHSA-mrhx-c7xc-m3w5, oversized constrained
collections). No dependency upgrade or exploitability assessment was made
as part of this Docker packaging check; it remains a separate follow-up.

## Owner browser result and remaining limits

The owner reported “That worked!” after following the supplied check:
pair to planner port 16124, request Ada Lovelace in Full name and Pioneer
in Nickname on the fixture at port 18765, review/approve, and confirm both
fields changed. This is owner-reported acceptance of the Docker planner
path. Docker-specific Submit hold/Cancel, real Chrome/MCP end-to-end
operation, voice/transcription, and headed re-pair after restart remain
outside this acceptance.

After acceptance, the isolated test container/network were stopped and
removed. The temporary Meta key copy was replaced with blank configuration,
and the temporary planner-token file removed. Existing host services were
left alone. Git staging/commits remain with the owner.

## Local MCP instructions added

The release was subsequently refreshed with MCP-SETUP.md and links from
START-HERE.md/DOCKER-SETUP.md. Current ZIP: 330,111 bytes, 55 files, SHA-256
`cf12d3cf9052475b0a172316b0175a962fe9438ce0702eb8b08d88ff1479b602`.
Only those three guides differ from the Docker-tested extraction; application
files are unchanged. Anonymous ZIP and standalone guide downloads matched
the local artifacts. Guide client settings were checked against official
OpenAI, Anthropic/MCP and Meta documentation on 2026-11-04. JSON examples
parsed; the TOML entry's table/string/array values were checked. The documented
token-generator API ran in the Docker container, preserved an existing
64-character token, and verified file mode 0600 without printing credentials.
The isolated container/network were stopped and removed afterward.
No client configuration was installed or changed, no computer control was
used, and no new Claude/Muse end-to-end acceptance is claimed.

The ChatGPT explicit-token option was then added: MCP configuration env
`SEEYABLE_BRIDGE_TOKEN` plus Docker exec `-e SEEYABLE_BRIDGE_TOKEN`. A
random test token was forwarded through the real Compose exec process;
resolveToken selected the environment override without writing it to disk.
No real credential was printed, and the test container/network were removed.
Latest distribution: 330,817 bytes, 55 files, SHA-256
`b2c49e5324da6bdc612fe6b2ff6734877b28759996b8ebdcc67067fbaee12c1e`.
Anonymous release ZIP and standalone updated guide downloads were verified.
