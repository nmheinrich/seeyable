# MCP setup helper verification — 2026-11-04

Added `scripts/setup-mcp.sh` (packaged as root `setup-mcp.sh`) and
`docker/setup-mcp.mjs`. The shell helper uses Docker's Node runtime, so
no host Node or Python installation is needed. It asks for an agent,
generates token-free configuration with actual local paths, and uses the
existing private MCP token for clipboard pairing. It does not modify client
settings, start Docker, launch a browser, rotate tokens, or approve actions.
Manual environment-token overrides moved to the guide's Advanced section.

## Verification

Tested the helper from an extracted ZIP in a temporary folder with spaces.
The test-only Compose file used project `seeyable-setup-check`, a previously
verified identical application image, blank Meta key configuration, and
separate loopback ports 16123/16124/18765. This changed no existing host
service, agent settings, or real clipboard.

- Shell syntax and Node syntax checks passed.
- Generated ChatGPT/Codex TOML values, Claude Desktop JSON, Muse Code JSON,
  and the shell-quoted Claude Code registration command were checked.
- Generated files had mode 0600 and correct absolute paths; no token appeared
  in the files or captured helper output.
- Generated Claude-shaped configuration launched a real Docker stdio MCP
  server through the SDK client and listed eight tools, including page_snapshot.
- Interactive agent choice and the Enter prompt passed. An initial stdin
  consumption issue was found and fixed by disconnecting the Docker readiness
  check from interactive stdin; the interactive flow then passed.
- Clipboard branch was tested with a stub `pbcopy`, storing a mode-0600
  temporary file. It received the correct 64-character MCP token, while
  stdout/stderr remained token-free. The temporary test copy was removed.
  Real macOS/Linux clipboard integration was not exercised.
- Re-running preserved the same private token. `--no-clipboard` showed the
  manual fallback; invalid agent input was rejected; stopped-container
  invocation produced the intended startup guidance.
- Container/network stopped and removed after testing. No Meta key was used.

No new Claude, ChatGPT, or Muse end-to-end browser acceptance is claimed by
configuration generation/tool discovery. Existing acceptance remains separate.
Windows uses manual setup; the shell helper is documented for macOS/Linux.

## Published artifact

ZIP: 334,601 bytes, 57 files; SHA-256
`9ded7b2f6e3c3e12f4e43cc609132312497f5f6d5fe24431b68038e4684037f0`.
Application files are unchanged from the preceding release; only three
guides and the two helper files differ. Packaged helper scripts were
byte-identical to the tested copies. The existing v0.1.0-judging release
attachments were refreshed; anonymous download, checksum and ZIP integrity
were verified. Packaging/documentation/helper changes remain uncommitted;
Git staging/commits remain with the owner.

The original attachment URL briefly served a cached older ZIP after replacement.
The current download therefore uses the new asset name
`seeyable-judging-0.1.0-mcp-setup.zip` (same bytes/hash above), with its own
checksum attachment. The release's primary link points to that asset.
Anonymous HTTP 200, full checksum, ZIP integrity, and both helper scripts
were verified from the new public URL.
